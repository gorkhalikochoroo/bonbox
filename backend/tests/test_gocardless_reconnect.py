"""
GoCardless / Aiia reconnect endpoint + feature alias tests — task #104.

The bank-connect happy path is already covered exhaustively in
`test_aiia_connect.py` + `test_gocardless_client.py` (22 + 10 tests).
This file focuses on the *new* surface added for PSD2 / 180-day SCA
re-consent: the POST /api/bank-connections/{id}/reconnect endpoint and
the `bank_auto_sync` PLAN_FEATURES alias.

Covers:
  • L1 auth — anon → 401 on /reconnect
  • L7 tier gate — Free user → 402 on /reconnect
  • L5 fail-soft — provider down → 502 + DB rolled back
  • Happy path — active row near expiry → fresh state + 'pending' status
  • Reconnect on revoked row → 400 (force fresh /init instead)
  • Reconnect on expired row → 200 (the primary use case)
  • State token freshness — old state burned on reconnect
  • Audit row written: bank_connect.reconnect_initiated
  • Feature alias: bank_auto_sync resolves to bank_auto_reconcile

Run: cd backend && pytest tests/test_gocardless_reconnect.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.bank_connection import BankConnection
from app.models.user import User
from app.services.aiia_client import AiiaClientError, MockAiiaClient
from app.services.auth import get_current_user
from app.services.billing import has_feature, min_plan_for_feature
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures (mirrored from test_aiia_connect.py) ────────────────────


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
    MockAiiaClient.reset()
    yield
    MockAiiaClient.reset()


def _user(db, plan: str = "starter", suffix: str = "") -> User:
    u = User(
        email=f"owner{suffix}@bonbox.test",
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


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _make_active_connection(db, user, *, days_until_expiry: int = 7) -> BankConnection:
    """Hand-craft an active BankConnection close to expiry — bypasses
    the /init+/callback round-trip so reconnect tests stay focused."""
    conn = BankConnection(
        id=uuid.uuid4(),
        user_id=user.id,
        provider="aiia",
        bank_slug="nordea",
        aiia_account_id="mock_acct_nordea_test",
        account_label="Erhverv driftskonto",
        status="active",
        refresh_token_enc=b"placeholder_encrypted_blob",
        consent_expires_at=utc_now() + timedelta(days=days_until_expiry),
        sandbox_mode=True,
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return conn


# ─── Test 1: L1 — anonymous returns 401 ───────────────────────────────


def test_reconnect_anonymous_returns_401(client, db):
    """Endpoint requires get_current_user.  No override → 401."""
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    # No _override_user — dependency unresolved → 401
    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 401, res.text


# ─── Test 2: L7 tier gate — Free → 402 ────────────────────────────────


def test_reconnect_free_user_blocked(client, db):
    """Free users get 402 with structured upgrade payload."""
    user = _user(db, plan="free")
    conn = _make_active_connection(db, user)
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 402, res.text
    detail = res.json()["detail"]
    assert detail["error"] == "feature_locked"
    assert detail["feature"] == "bank_auto_reconcile"
    assert detail["upgrade_to"] == "starter"


# ─── Test 3: Happy path — active row → fresh state ────────────────────


def test_reconnect_happy_path_mints_fresh_state_and_returns_consent_url(client, db):
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user, days_until_expiry=3)
    _override_user(user)
    old_status = conn.status
    old_state = conn.consent_state  # None initially on an active row

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 200, res.text
    body = res.json()
    # Response shape mirrors /init
    assert body["connection_id"] == str(conn.id)
    assert body["consent_url"]
    assert body["state"]
    assert body["sandbox_mode"] is True
    # State token is fresh (>= 8 chars, no equality with the old None)
    assert len(body["state"]) >= 8
    assert body["state"] != old_state

    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    # Row flipped to pending — callback handler accepts only 'pending'
    assert row.status == "pending"
    assert row.status != old_status
    assert row.consent_state == body["state"]
    assert row.consent_state_expires_at is not None
    # Encrypted refresh token preserved until /callback succeeds
    assert row.refresh_token_enc is not None


# ─── Test 4: Revoked row → 400 (force fresh /init) ───────────────────


def test_reconnect_refuses_revoked_row(client, db):
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    conn.status = "revoked"
    conn.refresh_token_enc = None  # the revoke path burns this
    db.commit()
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 400, res.text
    assert "revoked" in res.json()["detail"].lower()


# ─── Test 5: Expired row → reconnect works (primary use case) ────────


def test_reconnect_succeeds_for_expired_row(client, db):
    """The whole point of the endpoint: lapsed 90-day SCA + click
    Reconnect → fresh consent URL."""
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    conn.status = "expired"
    conn.consent_expires_at = utc_now() - timedelta(days=1)
    db.commit()
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 200, res.text
    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    assert row.status == "pending"
    assert row.consent_state is not None


# ─── Test 6: Cross-tenant → 404 (no enumeration) ─────────────────────


def test_reconnect_cross_tenant_returns_404(client, db):
    """Owner B cannot reconnect owner A's connection — surface 404 so
    a probe can't enumerate other users' connection ids."""
    user_a = _user(db, plan="starter", suffix="-a")
    user_b = _user(db, plan="starter", suffix="-b")
    conn_a = _make_active_connection(db, user_a)

    _override_user(user_b)
    res = client.post(f"/api/bank-connections/{conn_a.id}/reconnect")
    assert res.status_code == 404


# ─── Test 7: L5 fail-soft — provider 502 → 502 + rollback ────────────


def test_reconnect_handles_provider_failure_cleanly(client, db, monkeypatch):
    """Provider raises AiiaClientError → endpoint returns 502 and
    rolls back the row mutation (status stays as it was)."""
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    _override_user(user)
    original_status = conn.status

    def _boom(self, *_, **__):
        raise AiiaClientError("simulated upstream outage", status=503, kind="transport")

    monkeypatch.setattr(MockAiiaClient, "init_consent", _boom)

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 502, res.text

    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    # Row rolled back to its prior state — no orphan 'pending' row
    assert row.status == original_status


# ─── Test 8: Audit trail — bank_connect.reconnect_initiated ──────────


def test_reconnect_writes_audit_row(client, db):
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    _override_user(user)

    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 200

    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.entity_type == "bank_connection")
        .filter(AuditLog.action == "bank_connect.reconnect_initiated")
        .all()
    )
    assert len(audits) == 1
    after = json.loads(audits[0].after_state)
    assert after["status"] == "pending"
    assert after["bank_slug"] == "nordea"
    assert after["sandbox_mode"] is True


# ─── Test 9: Feature alias — bank_auto_sync ↔ bank_auto_reconcile ────


def test_feature_alias_bank_auto_sync_matches_bank_auto_reconcile(db):
    """Task #104 spec asked for `bank_auto_sync`.  We alias it to the
    historical `bank_auto_reconcile` key so both names gate the same
    entitlement table without breaking older callers."""
    free = _user(db, plan="free", suffix="-free-alias")
    starter = _user(db, plan="starter", suffix="-starter-alias")
    pro = _user(db, plan="pro", suffix="-pro-alias")

    # Free: both names return False
    assert has_feature(free, "bank_auto_reconcile") is False
    assert has_feature(free, "bank_auto_sync") is False

    # Starter + Pro: both names return True
    assert has_feature(starter, "bank_auto_reconcile") is True
    assert has_feature(starter, "bank_auto_sync") is True
    assert has_feature(pro, "bank_auto_reconcile") is True
    assert has_feature(pro, "bank_auto_sync") is True

    # min_plan_for_feature resolves the alias too
    assert min_plan_for_feature("bank_auto_sync") == "starter"
    assert min_plan_for_feature("bank_auto_reconcile") == "starter"


# ─── Test 10: State expires after 10 minutes (carries TTL) ───────────


def test_reconnect_state_carries_ten_minute_ttl(client, db):
    """Same 10-min CSRF window as /init (Audit P1 / Task #75)."""
    user = _user(db, plan="starter")
    conn = _make_active_connection(db, user)
    _override_user(user)

    before = utc_now()
    res = client.post(f"/api/bank-connections/{conn.id}/reconnect")
    assert res.status_code == 200

    db.expire_all()
    row = db.query(BankConnection).filter(BankConnection.id == conn.id).first()
    # Window is between 9:55 and 10:05 minutes from now to allow for
    # tiny clock drift inside the test (utc_now() called twice).
    delta = (row.consent_state_expires_at - before).total_seconds()
    assert 9 * 60 + 50 <= delta <= 10 * 60 + 10, (
        f"State TTL drifted from 10 min: {delta}s"
    )
