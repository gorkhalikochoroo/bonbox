"""
Aiia (Mastercard Open Banking) — end-to-end tests for task #67.

Coverage:
  1. Tier gate — Free user → 402; Starter+ allowed
  2. Init endpoint — returns consent_url + state; creates pending row
  3. Callback endpoint — code-exchange → status='active', refresh_token
     AES-encrypted (raw never appears in DB)
  4. Callback bad state → 400
  5. List + delete tenant-scoped (cross-tenant returns 404)
  6. Sync — pulls mock transactions, deduplicates, runs reconciliation,
     auto-confirms HIGH+exact matches
  7. Refresh token encryption — Fernet round-trip
  8. Cron job iteration — only "active + due" rows processed
  9. Audit log entries — init, activated, sync, revoked

Run: cd backend && pytest tests/test_aiia_connect.py -v
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
from app.models.bank_connection import BankConnection
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.user import User
from app.services.aiia_client import MockAiiaClient
from app.services.auth import get_current_user
from app.services.invoice_service import InvoiceService
from app.utils.crypto import decrypt, encrypt

_db_ready.set()


# ─── Shared fixtures ───────────────────────────────────────────────────


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
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def reset_mock():
    """Wipe the MockAiiaClient state between tests."""
    MockAiiaClient.reset()
    yield
    MockAiiaClient.reset()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ──────────────────────────────────────────────────────────


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


# ─── Test 1: tier gate ─────────────────────────────────────────────────


def test_free_user_blocked_from_init(client, db):
    user = _user(db, plan="free")
    _override_user(user)

    res = client.post("/api/bank-connect/init", json={"bank_slug": "danske_bank"})
    assert res.status_code == 402, res.text
    body = res.json()
    assert body["detail"]["error"] == "feature_locked"
    assert body["detail"]["feature"] == "bank_auto_reconcile"
    assert body["detail"]["upgrade_to"] == "starter"


def test_starter_user_can_init(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    res = client.post("/api/bank-connect/init", json={"bank_slug": "danske_bank"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert "consent_url" in body
    assert "state" in body
    assert body["sandbox_mode"] is True

    # Pending row exists with consent_state set
    row = db.query(BankConnection).filter(BankConnection.user_id == user.id).first()
    assert row is not None
    assert row.status == "pending"
    assert row.consent_state == body["state"]
    assert row.bank_slug == "danske_bank"
    # Refresh token still null pre-callback
    assert row.refresh_token_enc is None


def test_init_rejects_unsupported_bank(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    res = client.post("/api/bank-connect/init", json={"bank_slug": "atombank"})
    # 422 — Pydantic validator catches before the route runs
    assert res.status_code == 422, res.text


# ─── Test 2: callback flow ────────────────────────────────────────────


def test_callback_activates_connection_and_encrypts_refresh(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    # Init → get state + the mock client also generates a code
    res = client.post("/api/bank-connect/init", json={"bank_slug": "nordea"})
    assert res.status_code == 200
    state = res.json()["state"]
    # Look up the mock-stashed code for this state
    code = MockAiiaClient._consents[state]["code"]

    # Drop auth — callback is public
    app.dependency_overrides.pop(get_current_user, None)

    cb = client.get(
        f"/api/bank-connect/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    # Redirect to frontend
    assert cb.status_code in (302, 303), cb.text
    assert "bank_connected=1" in cb.headers.get("location", "")

    row = db.query(BankConnection).filter(BankConnection.user_id == user.id).first()
    assert row.status == "active"
    assert row.aiia_account_id and row.aiia_account_id.startswith("mock_acct_nordea_")
    assert row.account_label == "Erhverv driftskonto"
    assert row.consent_state is None  # cleared on activation
    assert row.consent_expires_at is not None

    # Raw refresh token NEVER appears in DB column — only encrypted bytes
    assert row.refresh_token_enc is not None
    assert isinstance(row.refresh_token_enc, (bytes, bytearray))
    decrypted = decrypt(bytes(row.refresh_token_enc))
    assert decrypted.startswith("mock_refresh_")
    # The encrypted bytes must NOT contain the plaintext token
    assert b"mock_refresh_" not in bytes(row.refresh_token_enc)


def test_callback_rejects_bad_state(client, db):
    # No auth needed (callback is public)
    app.dependency_overrides.pop(get_current_user, None)

    cb = client.get(
        "/api/bank-connect/callback?code=anything&state=" + "0" * 64,
        follow_redirects=False,
    )
    assert cb.status_code == 400


def test_callback_rejects_replay(client, db):
    """A second callback with the same state must 400 — state was cleared
    on first activation."""
    user = _user(db, plan="starter")
    _override_user(user)
    init = client.post("/api/bank-connect/init", json={"bank_slug": "lunar"})
    state = init.json()["state"]
    code = MockAiiaClient._consents[state]["code"]
    app.dependency_overrides.pop(get_current_user, None)

    first = client.get(
        f"/api/bank-connect/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert first.status_code in (302, 303)

    second = client.get(
        f"/api/bank-connect/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert second.status_code == 400


# ─── Test 3: list + delete tenant scoping ──────────────────────────────


def _activate_connection(client, db, user) -> BankConnection:
    """Helper: walk through init + callback so we have an active row."""
    _override_user(user)
    init = client.post("/api/bank-connect/init", json={"bank_slug": "jyske_bank"})
    state = init.json()["state"]
    code = MockAiiaClient._consents[state]["code"]
    app.dependency_overrides.pop(get_current_user, None)
    client.get(
        f"/api/bank-connect/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    _override_user(user)
    db.expire_all()
    return db.query(BankConnection).filter(BankConnection.user_id == user.id).first()


def test_list_returns_only_owners_connections(client, db):
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")

    conn_a = _activate_connection(client, db, user_a)
    conn_b = _activate_connection(client, db, user_b)

    _override_user(user_a)
    res = client.get("/api/bank-connections")
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert rows[0]["id"] == str(conn_a.id)
    # Tokens never exposed
    assert "refresh_token" not in rows[0]
    assert "refresh_token_enc" not in rows[0]
    assert "consent_state" not in rows[0]


def test_delete_revokes_connection_and_burns_token(client, db):
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    res = client.delete(f"/api/bank-connections/{conn.id}")
    assert res.status_code == 204

    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    assert row.status == "revoked"
    assert row.refresh_token_enc is None

    # Idempotent — second delete still 204
    res2 = client.delete(f"/api/bank-connections/{conn.id}")
    assert res2.status_code == 204


def test_delete_502s_when_aiia_revoke_fails_and_preserves_token(client, db, monkeypatch):
    """Audit P2 (Task #77): if Aiia rejects the revoke call, surface
    502 to the owner and KEEP the refresh_token_enc + status='active'
    so a retry can be made.  Silently flipping local status='revoked'
    while the consent stays live at Aiia is a PSD2 compliance hazard
    — the owner thinks they've revoked but the consent is still alive
    for up to 90 days.
    """
    from app.services.aiia_client import AiiaClientError
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    # Confirm we have a token to preserve
    assert conn.refresh_token_enc is not None
    original_token = conn.refresh_token_enc

    def _boom(self, account_id):
        raise AiiaClientError("aiia returned 503", status=503)

    monkeypatch.setattr(MockAiiaClient, "revoke", _boom)

    res = client.delete(f"/api/bank-connections/{conn.id}")
    assert res.status_code == 502
    detail = res.json().get("detail") or {}
    assert detail.get("code") == "aiia_revoke_failed"

    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    # Status NOT flipped, token NOT burned — owner can retry
    assert row.status == "active"
    assert row.refresh_token_enc == original_token


def test_delete_cross_tenant_returns_404(client, db):
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")
    conn_b = _activate_connection(client, db, user_b)

    _override_user(user_a)
    res = client.delete(f"/api/bank-connections/{conn_b.id}")
    assert res.status_code == 404


# ─── Test 4: sync materializes transactions + auto-confirms ────────────


def test_sync_imports_mock_transactions_and_auto_confirms(client, db):
    """The MockAiiaClient default returns one inflow that matches a
    pre-seeded invoice (Lyngby Storkunde ApS, 1250 DKK on today's date,
    description has the CVR). Sync should:
      • Insert 1 Sale + 1 Expense (default mock returns 2 inflows + 1 outflow,
        but the outflow goes to Expense)
      • Run reconciliation
      • Auto-confirm the high-confidence match for the invoice
    """
    user = _user(db, plan="starter")
    cust = _customer(db, user, name="Lyngby Storkunde ApS")
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))

    conn = _activate_connection(client, db, user)
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/sync")
    assert res.status_code == 200, res.text
    body = res.json()
    # Mock returns 2 inflows + 1 outflow
    assert body["new_sales"] == 2
    assert body["new_expenses"] == 1
    assert body["skipped_duplicates"] == 0
    assert body["suggestions"] >= 1
    # The Lyngby invoice match should auto-confirm
    assert body["auto_confirmed"] >= 1

    # Invoice flipped to paid
    db.expire_all()
    inv2 = db.query(Invoice).filter(Invoice.id == inv.id).first()
    assert inv2.status == "paid"


def test_sync_deduplicates_on_second_run(client, db):
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    first = client.post(f"/api/bank-connections/{conn.id}/sync")
    assert first.status_code == 200
    first_new = first.json()["new_sales"] + first.json()["new_expenses"]
    assert first_new > 0

    second = client.post(f"/api/bank-connections/{conn.id}/sync")
    assert second.status_code == 200
    # All of the same txns should be deduped on ref_id
    assert second.json()["new_sales"] == 0
    assert second.json()["new_expenses"] == 0
    assert second.json()["skipped_duplicates"] == first_new


def test_sync_rejects_non_active_connection(client, db):
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)
    # Revoke first
    client.delete(f"/api/bank-connections/{conn.id}")
    res = client.post(f"/api/bank-connections/{conn.id}/sync")
    assert res.status_code == 400


def test_free_user_blocked_from_sync(client, db):
    """Sync is Starter+. A Free user who somehow has a leftover row
    (downgraded from Starter) still can't trigger sync."""
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    # Downgrade
    user.plan = "free"
    db.commit()
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/sync")
    assert res.status_code == 402


# ─── Test 5: refresh token encryption (unit) ───────────────────────────


def test_crypto_round_trip():
    plaintext = "mock_refresh_abcdef1234567890"
    ct = encrypt(plaintext)
    assert isinstance(ct, bytes)
    assert plaintext.encode() not in ct  # not stored in plaintext
    assert decrypt(ct) == plaintext


def test_crypto_empty_handles_safely():
    assert encrypt("") == b""
    assert encrypt(None) == b""
    assert decrypt(b"") == ""
    assert decrypt(None) == ""


def test_crypto_tampered_ciphertext_raises():
    from cryptography.fernet import InvalidToken

    plaintext = "secret"
    ct = encrypt(plaintext)
    tampered = ct[:-4] + b"XXXX"
    with pytest.raises(InvalidToken):
        decrypt(tampered)


# ─── Test 6: cron job iteration ────────────────────────────────────────


def test_cron_only_syncs_active_due_connections(client, db, engine_and_session):
    """Set up:
      • user A — active connection, last_synced_at = 24h ago (DUE)
      • user B — active connection, last_synced_at = 1h ago (NOT due)
      • user C — pending connection (NOT due)
    Run the cron tick and assert only user A's connection was processed.
    """
    from app.jobs import aiia_sync_job
    from app.database import SessionLocal as _SessionLocal

    _, TestSessionLocal = engine_and_session
    # Point the job at our test DB
    aiia_sync_job.SessionLocal = TestSessionLocal

    user_a = _user(db, plan="starter", email_suffix="-due")
    user_b = _user(db, plan="starter", email_suffix="-fresh")
    user_c = _user(db, plan="starter", email_suffix="-pending")

    # Manually craft rows so we control last_synced_at exactly.
    # Using naive UTC datetime — matches what the cron's
    # `last_synced_at < cutoff` comparison expects (DateTime column
    # is naive in SQLAlchemy here).
    from app.utils.time import utc_now as _now
    now = _now().replace(tzinfo=None)
    conn_a = BankConnection(
        id=uuid.uuid4(), user_id=user_a.id, provider="aiia",
        bank_slug="danske_bank", aiia_account_id="mock_acct_a",
        status="active", last_synced_at=now - timedelta(hours=24),
        sandbox_mode=True,
    )
    conn_b = BankConnection(
        id=uuid.uuid4(), user_id=user_b.id, provider="aiia",
        bank_slug="nordea", aiia_account_id="mock_acct_b",
        status="active", last_synced_at=now - timedelta(hours=1),
        sandbox_mode=True,
    )
    conn_c = BankConnection(
        id=uuid.uuid4(), user_id=user_c.id, provider="aiia",
        bank_slug="lunar", aiia_account_id=None,
        status="pending", sandbox_mode=True,
    )
    db.add_all([conn_a, conn_b, conn_c])
    db.commit()

    summary = aiia_sync_job.run_aiia_sync_tick()
    assert summary["total"] == 1, f"Cron processed {summary}"
    # The one processed row is conn_a
    assert summary["results"][0]["connection_id"] == str(conn_a.id)


# ─── Test 7: audit logs ────────────────────────────────────────────────


def test_audit_log_entries_for_full_flow(client, db):
    """init → activated → sync → revoked: one audit row each."""
    user = _user(db, plan="starter")
    conn = _activate_connection(client, db, user)
    _override_user(user)

    client.post(f"/api/bank-connections/{conn.id}/sync")
    client.delete(f"/api/bank-connections/{conn.id}")

    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.entity_type == "bank_connection")
        .order_by(AuditLog.created_at.asc())
        .all()
    )
    actions = [a.action for a in audits]
    assert "bank_connect.init" in actions
    assert "bank_connect.activated" in actions
    assert "bank_connect.sync" in actions
    assert "bank_connect.revoked" in actions

    # Activated row must include consent_expires_at
    activated = next(a for a in audits if a.action == "bank_connect.activated")
    after = json.loads(activated.after_state)
    assert after["bank_slug"]
    assert after["sandbox_mode"] is True


# ─── Test 8: model + crypto sanity ─────────────────────────────────────


def test_bank_connection_unique_per_user_account(db):
    """UNIQUE(user_id, aiia_account_id) — re-inserting same pair fails."""
    user = _user(db, plan="starter")
    c1 = BankConnection(
        user_id=user.id, provider="aiia", aiia_account_id="acct_xyz",
        bank_slug="danske_bank", status="active", sandbox_mode=True,
    )
    db.add(c1)
    db.commit()

    c2 = BankConnection(
        user_id=user.id, provider="aiia", aiia_account_id="acct_xyz",
        bank_slug="danske_bank", status="active", sandbox_mode=True,
    )
    db.add(c2)
    with pytest.raises(Exception):
        db.commit()
    db.rollback()


# ─── Audit P3 (Task #83) — _callback_url honors AIIA_REDIRECT_URI ─────


def test_callback_url_prefers_explicit_aiia_redirect_uri(monkeypatch):
    """Audit P3 (Task #83): in prod the API is at api.bonbox.dk while
    the SPA is at app.bonbox.dk (FRONTEND_URL).  _callback_url must
    use AIIA_REDIRECT_URI verbatim when set so Aiia can actually
    reach our callback handler."""
    from app.config import settings
    from app.routers.bank_connect import _callback_url
    monkeypatch.setattr(
        settings, "AIIA_REDIRECT_URI",
        "https://api.bonbox.dk/api/bank-connect/callback",
        raising=False,
    )
    monkeypatch.setattr(
        settings, "FRONTEND_URL", "https://app.bonbox.dk",
        raising=False,
    )
    assert _callback_url() == "https://api.bonbox.dk/api/bank-connect/callback"


def test_callback_url_falls_back_to_frontend_url_in_dev(monkeypatch):
    """Local dev: AIIA_REDIRECT_URI unset, derive from FRONTEND_URL."""
    from app.config import settings
    from app.routers.bank_connect import _callback_url
    monkeypatch.setattr(settings, "AIIA_REDIRECT_URI", "", raising=False)
    monkeypatch.setattr(
        settings, "FRONTEND_URL", "http://localhost:5173",
        raising=False,
    )
    assert _callback_url() == "http://localhost:5173/api/bank-connect/callback"


# ─── #360: foreign-currency quarantine in _ingest_transactions ──────────


def test_ingest_excludes_foreign_currency(db):
    """A non-base-currency (EUR) inflow must NOT be written as a DKK Sale —
    coercing it would inflate revenue + the MOMS/cash-flow forecast
    ('you're covered' when you're not). It is quarantined and counted in
    skipped_foreign; only the DKK row lands in the ledger."""
    from datetime import date

    from app.routers.bank_connect import _ingest_transactions
    from app.services.aiia_client import AiiaTransaction
    from app.models.sale import Sale

    user = _user(db, plan="starter", email_suffix="fx")
    user.currency = "DKK"
    db.flush()

    conn = BankConnection(
        id=uuid.uuid4(), user_id=user.id, provider="saltedge",
        bank_slug="danske_bank_dk", status="active",
        aiia_account_id="acct_fx",
    )
    db.add(conn)
    db.flush()

    txns = [
        AiiaTransaction(
            aiia_txn_id="dkk_1", booked_date=date(2026, 6, 1),
            amount=1000.0, currency="DKK", description="DKK in",
            counterparty="Kunde A",
        ),
        AiiaTransaction(
            aiia_txn_id="eur_1", booked_date=date(2026, 6, 2),
            amount=5000.0, currency="EUR", description="EUR in",
            counterparty="Foreign B",
        ),
    ]
    new_sales, new_expenses, skipped, skipped_foreign = _ingest_transactions(
        db, user, conn, txns,
    )

    assert new_sales == 1
    assert new_expenses == 0
    assert skipped == 0
    assert skipped_foreign == 1
    sales = db.query(Sale).filter(Sale.user_id == user.id).all()
    assert len(sales) == 1
    assert sales[0].amount == Decimal("1000")
