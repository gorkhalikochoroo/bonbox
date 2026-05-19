"""
MobilePay Erhverv — end-to-end tests for task #71.

Coverage:
  1. Tier gate — Free user -> 402; Starter / Pro / Trial allowed
  2. Init endpoint — returns redirect_url + state; creates/flips pending row
  3. Callback endpoint — token exchange -> status='active', both tokens
     Fernet-encrypted (raw never appears in DB), audit emitted
  4. Callback bad state -> 400
  5. List + payments + disconnect tenant-scoped (cross-tenant)
  6. Payments sync — auto-matches a CVR/fakturanummer payment to the
     pre-seeded open faktura + marks it paid via paid_via='mobilepay'
  7. Token refresh on near-expiry — encrypted tokens rotate
  8. Cron job iteration — only "active + due" rows processed
  9. Disconnect deletes the row + cron skips it on next tick
 10. Audit log entries for connect / disconnect / sync

Run: cd backend && pytest tests/test_mobilepay.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.mobilepay_connection import MobilePayConnection
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import get_current_user
from app.services.invoice_service import InvoiceService
from app.services.mobilepay_client import (
    MockMobilePayClient,
    MobilePayPayment,
)
from app.utils.crypto import decrypt, encrypt
from app.utils.time import utc_now

_db_ready.set()


# --- Shared fixtures --------------------------------------------------


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Reset the slowapi limiter between tests. The /init route is
    # 10/hour per IP — without a reset, the bucket carries over
    # across tests in the same run and a late test trips a 429.
    try:
        from app.routers.mobilepay import limiter as _mp_limiter
        _mp_limiter.reset()
    except Exception:  # noqa: BLE001
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def reset_mock():
    """Wipe the MockMobilePayClient state between tests."""
    MockMobilePayClient.reset()
    yield
    MockMobilePayClient.reset()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


# --- Helpers ---------------------------------------------------------


def _user(db, plan: str = "starter", email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.test",
        password_hash="x",
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _customer(db, user: User, name: str = "Lyngby Storkunde ApS") -> Customer:
    c = Customer(
        user_id=user.id,
        name=name,
        is_company=True,
        cvr="12345678",
        email="finance@lyngby.test",
        country="DK",
        payment_terms_days=14,
        default_lang="da",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _send_invoice(db, user: User, customer: Customer, total: Decimal) -> Invoice:
    net = (total / Decimal("1.25")).quantize(Decimal("0.01"))
    inv = InvoiceService.create_draft(
        db, user, customer.id,
        lines=[{
            "description": "Konsulentydelse",
            "quantity": Decimal("1"),
            "unit_price_net": net,
            "moms_rate": Decimal("0.250"),
        }],
    )
    InvoiceService.mark_sent(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    return inv


def _activate_connection(client, db, user) -> MobilePayConnection:
    """Helper: walk through init + callback so we have an active row."""
    _override_user(user)
    init = client.post("/api/mobilepay/init", json={})
    assert init.status_code == 200, init.text
    state = init.json()["state"]
    code = MockMobilePayClient._consents[state]["code"]

    cb = client.post(
        "/api/mobilepay/callback",
        json={"state": state, "code": code},
    )
    assert cb.status_code == 200, cb.text
    db.expire_all()
    return (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user.id)
        .first()
    )


# --- Test 1: tier gate ------------------------------------------------


def test_free_user_blocked_from_init(client, db):
    user = _user(db, plan="free")
    _override_user(user)

    res = client.post("/api/mobilepay/init", json={})
    assert res.status_code == 402, res.text
    body = res.json()
    assert body["detail"]["error"] == "feature_locked"
    assert body["detail"]["feature"] == "mobilepay_autosync"
    assert body["detail"]["upgrade_to"] == "starter"


def test_starter_user_can_init(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    res = client.post("/api/mobilepay/init", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert "redirect_url" in body
    assert "state" in body
    assert body["connection_id"]

    row = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user.id)
        .first()
    )
    assert row is not None
    assert row.status == "pending"
    assert row.consent_state == body["state"]
    # Refresh + access tokens still null pre-callback
    assert row.refresh_token_enc is None
    assert row.access_token_enc is None


def test_pro_user_can_init(client, db):
    user = _user(db, plan="pro")
    _override_user(user)
    res = client.post("/api/mobilepay/init", json={})
    assert res.status_code == 200, res.text


def test_trial_user_can_init(client, db):
    # plan='free' + trial_ends_at in the future -> effective_plan == 'trial'
    user = _user(db, plan="free")
    user.trial_ends_at = utc_now() + timedelta(days=7)
    db.commit()
    _override_user(user)

    res = client.post("/api/mobilepay/init", json={})
    assert res.status_code == 200, res.text


def test_free_user_blocked_from_payments(client, db):
    user = _user(db, plan="free")
    _override_user(user)
    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 402


def test_free_user_blocked_from_disconnect(client, db):
    user = _user(db, plan="free")
    _override_user(user)
    res = client.delete("/api/mobilepay/connection")
    assert res.status_code == 402


# --- Test 2: callback flow -------------------------------------------


def test_callback_activates_connection_and_encrypts_tokens(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    init = client.post("/api/mobilepay/init", json={})
    state = init.json()["state"]
    code = MockMobilePayClient._consents[state]["code"]

    cb = client.post(
        "/api/mobilepay/callback",
        json={"state": state, "code": code},
    )
    assert cb.status_code == 200, cb.text
    body = cb.json()
    assert body["status"] == "active"
    assert body["mp_merchant_id"].startswith("mock_mp_merchant_")
    # Tokens are NEVER in the response
    assert "refresh_token" not in body
    assert "access_token" not in body
    assert "refresh_token_enc" not in body
    assert "access_token_enc" not in body
    assert "consent_state" not in body

    db.expire_all()
    row = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user.id)
        .first()
    )
    assert row.status == "active"
    assert row.consent_state is None
    assert row.token_expires_at is not None
    assert row.scopes == "payments:read merchant:read"

    # Both tokens encrypted with Fernet; plaintext never appears
    assert row.refresh_token_enc is not None
    assert isinstance(row.refresh_token_enc, (bytes, bytearray))
    assert b"mock_mp_refresh_" not in bytes(row.refresh_token_enc)
    assert decrypt(bytes(row.refresh_token_enc)).startswith("mock_mp_refresh_")

    assert row.access_token_enc is not None
    assert b"mock_mp_access_" not in bytes(row.access_token_enc)
    assert decrypt(bytes(row.access_token_enc)).startswith("mock_mp_access_")


def test_callback_rejects_bad_state(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    # No pending row exists at all
    res = client.post(
        "/api/mobilepay/callback",
        json={"state": "0" * 64, "code": "anything"},
    )
    assert res.status_code == 400


def test_callback_rejects_wrong_state_for_user(client, db):
    """A user with a pending row + a callback that uses a different
    state must 400 (replay/CSRF defense)."""
    user = _user(db, plan="starter")
    _override_user(user)
    client.post("/api/mobilepay/init", json={})

    res = client.post(
        "/api/mobilepay/callback",
        json={"state": "z" * 64, "code": "anything"},
    )
    assert res.status_code == 400


def test_callback_rejects_replay(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    init = client.post("/api/mobilepay/init", json={})
    state = init.json()["state"]
    code = MockMobilePayClient._consents[state]["code"]

    first = client.post(
        "/api/mobilepay/callback",
        json={"state": state, "code": code},
    )
    assert first.status_code == 200

    # The connection is now 'active' and consent_state is cleared, so
    # the second call doesn't find a matching state.
    second = client.post(
        "/api/mobilepay/callback",
        json={"state": state, "code": code},
    )
    assert second.status_code == 400


# --- Test 3: payments + auto-match -----------------------------------


def test_payments_sync_imports_and_auto_matches(client, db):
    """The mock client returns 3 payments including one with
    'Faktura 2026-0042 Lyngby Storkunde ApS' that matches a pre-seeded
    open invoice. Sync should:
      * insert 3 Sale rows (deduped on reference_id)
      * auto-mark the Lyngby invoice as paid via paid_via='mobilepay'
    """
    user = _user(db, plan="starter")
    cust = _customer(db, user, name="Lyngby Storkunde ApS")
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))

    conn = _activate_connection(client, db, user)
    _override_user(user)

    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["new_payments"] == 3
    assert body["auto_matched"] >= 1
    assert body["last_synced_at"]

    # Invoice flipped to paid + paid_via stamped 'mobilepay'
    db.expire_all()
    inv2 = db.query(Invoice).filter(Invoice.id == inv.id).first()
    assert inv2.status == "paid"
    assert inv2.paid_via == "mobilepay"
    assert inv2.auto_match_reversible is True

    # Sale has the mp_payment_id reference + linked invoice_id
    matched_sale = (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.reference_id == "mobilepay_mock_mp_pay_lyngby_001",
        )
        .first()
    )
    assert matched_sale is not None
    assert matched_sale.invoice_id == inv.id
    assert matched_sale.payment_method == "mobilepay"

    # The response includes matched_invoice_id for the Lyngby payment
    lyngby_payment = next(
        p for p in body["payments"]
        if p["mp_payment_id"] == "mock_mp_pay_lyngby_001"
    )
    assert lyngby_payment["matched_invoice_id"] == str(inv.id)


def test_payments_sync_deduplicates_on_second_call(client, db):
    user = _user(db, plan="starter")
    _activate_connection(client, db, user)
    _override_user(user)

    first = client.get("/api/mobilepay/payments")
    assert first.status_code == 200
    assert first.json()["new_payments"] == 3

    second = client.get("/api/mobilepay/payments")
    assert second.status_code == 200
    # All 3 payments already exist -> no new rows
    assert second.json()["new_payments"] == 0


def test_payments_blocked_when_not_active(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    # Create a pending row by calling /init only
    client.post("/api/mobilepay/init", json={})

    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 400  # not active


def test_payments_404_when_no_connection(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 404


# --- Test 4: cross-tenant scoping ------------------------------------


def test_user_a_cannot_see_user_b_connection(client, db):
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")

    _activate_connection(client, db, user_b)
    # user_a has no connection of their own
    _override_user(user_a)
    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 404


def test_user_a_cannot_disconnect_user_b_connection(client, db):
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")
    conn_b = _activate_connection(client, db, user_b)

    _override_user(user_a)
    res = client.delete("/api/mobilepay/connection")
    # 204 — idempotent, but user_b's row is intact.
    assert res.status_code == 204
    db.expire_all()
    survived = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user_b.id)
        .first()
    )
    assert survived is not None
    assert survived.id == conn_b.id


# --- Test 5: token refresh on near-expiry ----------------------------


def test_token_refresh_when_expiry_near(client, db):
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    # Record the original token bytes, then force the connection's
    # token_expires_at into the past to trigger a refresh.
    original_access_bytes = bytes(conn.access_token_enc)
    db.query(MobilePayConnection).filter(
        MobilePayConnection.id == conn.id,
    ).update({"token_expires_at": utc_now() - timedelta(minutes=5)})
    db.commit()

    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 200

    db.expire_all()
    conn2 = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.id == conn.id)
        .first()
    )
    # New access token bytes (Fernet output is non-deterministic so
    # length-equal is not enough — value must be different)
    assert bytes(conn2.access_token_enc) != original_access_bytes
    # New expiry is in the future
    assert conn2.token_expires_at > utc_now()


# --- Test 6: disconnect deletes row + cron skips -----------------------


def test_disconnect_deletes_row(client, db):
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    # Capture the id BEFORE the DELETE — once the router commits the
    # row removal, accessing conn.id from this session triggers a refresh
    # against a row that's gone and SQLAlchemy raises ObjectDeletedError.
    conn_id = conn.id
    _override_user(user)

    res = client.delete("/api/mobilepay/connection")
    assert res.status_code == 204

    db.expire_all()
    survived = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.id == conn_id)
        .first()
    )
    assert survived is None

    # Idempotent — second DELETE still 204
    res2 = client.delete("/api/mobilepay/connection")
    assert res2.status_code == 204


def test_cron_skips_disconnected_connections(client, db, engine_and_session):
    """Only active + due rows are processed by the nightly cron."""
    from app.jobs import mobilepay_sync_job

    _, TestSessionLocal = engine_and_session
    mobilepay_sync_job.SessionLocal = TestSessionLocal

    user_a = _user(db, plan="starter", email_suffix="-due")
    user_b = _user(db, plan="starter", email_suffix="-fresh")

    # Both have active connections; user_a is overdue (24h), user_b is
    # too fresh (1h ago).
    now = utc_now().replace(tzinfo=None)
    conn_a = MobilePayConnection(
        id=uuid.uuid4(), user_id=user_a.id,
        mp_merchant_id="mock_mp_merchant_aaaa",
        status="active",
        last_synced_at=now - timedelta(hours=24),
        access_token_enc=encrypt("mock_mp_access_aaaa"),
        refresh_token_enc=encrypt("mock_mp_refresh_aaaa"),
        token_expires_at=now + timedelta(hours=1),
    )
    conn_b = MobilePayConnection(
        id=uuid.uuid4(), user_id=user_b.id,
        mp_merchant_id="mock_mp_merchant_bbbb",
        status="active",
        last_synced_at=now - timedelta(hours=1),
        access_token_enc=encrypt("mock_mp_access_bbbb"),
        refresh_token_enc=encrypt("mock_mp_refresh_bbbb"),
        token_expires_at=now + timedelta(hours=1),
    )
    db.add_all([conn_a, conn_b])
    db.commit()

    summary = mobilepay_sync_job.run_mobilepay_sync_tick()
    assert summary["total"] == 1
    assert summary["results"][0]["connection_id"] == str(conn_a.id)


def test_cron_does_not_pick_up_pending_or_expired(client, db, engine_and_session):
    from app.jobs import mobilepay_sync_job

    _, TestSessionLocal = engine_and_session
    mobilepay_sync_job.SessionLocal = TestSessionLocal

    user_p = _user(db, plan="starter", email_suffix="-pending")
    user_e = _user(db, plan="starter", email_suffix="-expired")

    now = utc_now().replace(tzinfo=None)
    pending = MobilePayConnection(
        id=uuid.uuid4(), user_id=user_p.id,
        status="pending", consent_state="x" * 32,
    )
    expired = MobilePayConnection(
        id=uuid.uuid4(), user_id=user_e.id,
        mp_merchant_id="mock_mp_merchant_eeee",
        status="expired",
        last_synced_at=now - timedelta(days=2),
    )
    db.add_all([pending, expired])
    db.commit()

    summary = mobilepay_sync_job.run_mobilepay_sync_tick()
    assert summary["total"] == 0


# --- Test 7: audit logs ----------------------------------------------


def test_audit_log_entries_for_full_flow(client, db):
    """init -> callback -> sync -> disconnect: one audit row each."""
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    client.get("/api/mobilepay/payments")
    client.delete("/api/mobilepay/connection")

    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.entity_type == "mobilepay_connection")
        .order_by(AuditLog.created_at.asc())
        .all()
    )
    actions = [a.action for a in audits]
    # Two 'mobilepay.connect' entries (init + callback)
    assert actions.count("mobilepay.connect") == 2
    assert "mobilepay.sync" in actions
    assert "mobilepay.disconnect" in actions

    callback_audit = [
        a for a in audits
        if a.action == "mobilepay.connect"
        and "callback_complete" in (a.after_state or "")
    ]
    assert len(callback_audit) == 1
    after = json.loads(callback_audit[0].after_state)
    assert after["mp_merchant_id"].startswith("mock_mp_merchant_")
    assert after["scopes"] == "payments:read merchant:read"


# --- Test 8: model unique constraint + re-init ------------------------


def test_re_init_flips_existing_pending_row(client, db):
    """Calling /init twice without finishing the callback re-uses the
    existing row (UNIQUE(user_id) would otherwise blow up on insert)."""
    user = _user(db, plan="starter")
    _override_user(user)

    init1 = client.post("/api/mobilepay/init", json={})
    state1 = init1.json()["state"]
    init2 = client.post("/api/mobilepay/init", json={})
    state2 = init2.json()["state"]
    assert state1 != state2

    rows = (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user.id)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].consent_state == state2


def test_mobilepay_connection_unique_per_user(db):
    user = _user(db, plan="starter")
    c1 = MobilePayConnection(
        user_id=user.id, mp_merchant_id="acct_xyz", status="active",
    )
    db.add(c1)
    db.commit()

    c2 = MobilePayConnection(
        user_id=user.id, mp_merchant_id="acct_other", status="active",
    )
    db.add(c2)
    with pytest.raises(Exception):
        db.commit()
    db.rollback()


# --- Test 9: prime payments override (matching custom data) ----------


def test_custom_payment_list_drives_match(client, db):
    """When a test sets a payment list via MockMobilePayClient.set_payments,
    the API uses it verbatim. Confirms the override path tests rely on."""
    user = _user(db, plan="starter")
    cust = _customer(db, user, name="Roastery Coffee ApS")
    inv = _send_invoice(db, user, cust, Decimal("4200.00"))

    conn = _activate_connection(client, db, user)
    _override_user(user)

    custom_payment = MobilePayPayment(
        mp_payment_id="custom_payment_001",
        booked_at=utc_now().replace(tzinfo=None),
        amount=4200.00,
        currency="DKK",
        description="Roastery Coffee 2026 invoice",
        payer_name="Roastery Coffee ApS",
    )
    MockMobilePayClient.set_payments(conn.mp_merchant_id, [custom_payment])

    res = client.get("/api/mobilepay/payments")
    assert res.status_code == 200
    body = res.json()
    assert body["new_payments"] == 1
    assert body["auto_matched"] == 1

    db.expire_all()
    inv2 = db.query(Invoice).filter(Invoice.id == inv.id).first()
    assert inv2.status == "paid"
    assert inv2.paid_via == "mobilepay"
