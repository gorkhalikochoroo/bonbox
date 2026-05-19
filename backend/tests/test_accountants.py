"""
Accountant read-only login — end-to-end tests (Task #49).

Coverage:
   1. Free user inviting → 402 plan_required
   2. Starter user inviting → 201 + grant created + email queued (mocked)
   3. Duplicate invite to existing active accountant → 409
   4. Accountant signup with valid token → creates User + activates grant
   5. Accountant signup with expired token → 410
   6. Accountant signup with revoked grant → 403
   7. Accountant signup with already-active grant → 409
   8. Accountant can GET /sales, /expenses, /reports (read endpoints)
   9. Accountant POST/PUT/DELETE on any business endpoint → 403 read_only
  10. Accountant switches client → effective queries return new client's data
  11. Cross-grant scoping — accountant with 2 clients can't see client A's
      data when current_client=B
  12. Owner revokes → accountant immediately loses access (next request → 403)
  13. Accountant revokes themselves → grant becomes revoked
  14. List grants returns owner's full list
  15. Accountant clients endpoint returns only active grants

Run: cd backend && pytest tests/test_accountants.py -v
"""
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.accountant_grant import AccountantGrant
from app.models.audit_log import AuditLog
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


# ─── Shared in-memory DB ───────────────────────────────────────────────


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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Patch SessionLocal so the accountant_write_guard middleware uses
    # the same in-memory DB.
    import app.main as _app_main
    monkeypatch.setattr(_app_main, "SessionLocal", SessionLocal, raising=False)
    # Also patch the binding the middleware uses (it imports at call time)
    import app.database as _app_db
    monkeypatch.setattr(_app_db, "SessionLocal", SessionLocal, raising=False)

    # Mock the email sender — no SMTP needed
    def _fake_send_email(*args, **kwargs):
        return True

    monkeypatch.setattr(
        "app.services.email_service.send_email", _fake_send_email
    )

    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _override_user_with_request(user: User):
    """Override that mirrors the real delegation flow — read the
    accountant_client cookie / header from the request and delegate
    accordingly. FastAPI resolves the Request + db via deps.
    """
    from fastapi import Depends, Request
    from app.services.auth import _resolve_accountant_view
    from sqlalchemy.orm import Session

    def _resolve(request: Request, db: Session = Depends(get_db)):
        if (user.role or "").lower() == "accountant":
            return _resolve_accountant_view(user, request, db)
        return user

    app.dependency_overrides[get_current_user] = _resolve


# ─── Helpers ───────────────────────────────────────────────────────────


def _owner(db, plan: str = "starter", email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bakery{email_suffix}",
        business_type="cafe",
        currency="DKK",
        plan=plan,
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _accountant(db, email_suffix: str = "") -> User:
    u = User(
        email=f"revisor{email_suffix}@bonbox.dk",
        password_hash=hash_password("revisorpw123"),
        business_name=f"Revisor{email_suffix}",
        business_type="",
        currency="DKK",
        plan="free",
        role="accountant",
        owner_id=None,
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _make_active_grant(db, accountant: User, owner: User) -> AccountantGrant:
    g = AccountantGrant(
        accountant_user_id=accountant.id,
        accountant_email=accountant.email,
        owner_user_id=owner.id,
        granted_by=owner.id,
        status="active",
        invite_token=None,
        invited_at=utc_now(),
        activated_at=utc_now(),
    )
    db.add(g)
    db.commit()
    db.refresh(g)
    return g


# ─── Test 1 — Free user can't invite (402) ────────────────────────────


def test_free_owner_blocked_from_invite(client, db):
    owner = _owner(db, plan="free")
    _override_user(owner)

    res = client.post(
        "/api/accountants/invite",
        json={"email": "revisor@example.dk", "name": "Anna Hansen"},
    )
    assert res.status_code == 402, res.text
    body = res.json()
    assert body["detail"]["code"] == "plan_required"
    assert body["detail"]["feature"] == "accountant_login"
    assert body["detail"]["upgrade_to"] == "starter"


# ─── Test 2 — Starter user can invite (201 + grant + audit + email) ───


def test_starter_owner_can_invite(client, db, monkeypatch):
    owner = _owner(db, plan="starter")
    _override_user(owner)

    sent: list[dict] = []

    def _capture(to_email, subject, html, **kwargs):
        sent.append({"to": to_email, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(
        "app.services.email_service.send_email", _capture
    )

    res = client.post(
        "/api/accountants/invite",
        json={"email": "revisor@example.dk", "name": "Anna Hansen"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["accountant_email"] == "revisor@example.dk"
    assert body["status"] == "pending"
    assert body["invite_token_expires_at"] is not None

    # Grant persisted
    grants = db.query(AccountantGrant).filter(
        AccountantGrant.owner_user_id == owner.id,
    ).all()
    assert len(grants) == 1
    assert grants[0].invite_token is not None  # token still pending

    # Audit row written
    rows = db.query(AuditLog).filter(
        AuditLog.action == "accountant.invited",
    ).all()
    assert len(rows) == 1

    # Email captured (mocked)
    assert len(sent) == 1
    assert sent[0]["to"] == "revisor@example.dk"


# ─── Test 3 — Duplicate active invite → 409 ───────────────────────────


def test_duplicate_active_invite_returns_409(client, db):
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner)

    _override_user(owner)
    res = client.post(
        "/api/accountants/invite",
        json={"email": accountant.email},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "already_active_grant"


# ─── Test 4 — Signup with valid token activates the grant ─────────────


def test_signup_with_valid_token_activates_grant(client, db):
    owner = _owner(db, plan="starter")
    _override_user(owner)
    # Invite first
    invite = client.post(
        "/api/accountants/invite",
        json={"email": "newcomer@example.dk", "name": "Jens"},
    ).json()
    # Pull the raw token from DB (response masks it)
    grant = db.query(AccountantGrant).filter(
        AccountantGrant.id == invite["id"],
    ).first()
    assert grant is not None
    token = grant.invite_token
    assert token

    # Clear the owner override — signup is a public endpoint
    _override_user(None)
    res = client.post(
        "/api/accountants/signup",
        json={
            "invite_token": token,
            "password": "revisorpw123",
            "full_name": "Jens Jensen",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["access_token"]
    assert body["user"]["email"] == "newcomer@example.dk"
    assert body["user"]["role"] == "accountant"

    db.refresh(grant)
    assert grant.status == "active"
    assert grant.invite_token is None  # single-use, burned
    assert grant.activated_at is not None
    assert grant.accountant_user_id is not None


# ─── Test 5 — Signup with expired token → 410 ─────────────────────────


def test_signup_with_expired_token_410(client, db):
    owner = _owner(db, plan="starter")
    accountant = _accountant(db, email_suffix="exp")
    g = AccountantGrant(
        accountant_user_id=None,
        accountant_email="expired@example.dk",
        owner_user_id=owner.id,
        granted_by=owner.id,
        status="pending",
        invite_token="expired-token-xyz",
        invite_token_expires_at=utc_now() - timedelta(days=1),
        invited_at=utc_now() - timedelta(days=8),
    )
    db.add(g)
    db.commit()

    res = client.post(
        "/api/accountants/signup",
        json={"invite_token": "expired-token-xyz", "password": "newpw1234"},
    )
    assert res.status_code == 410, res.text
    assert res.json()["detail"]["code"] == "invite_expired"


# ─── Test 6 — Signup with revoked grant → 403 ─────────────────────────


def test_signup_with_revoked_grant_403(client, db):
    owner = _owner(db, plan="starter")
    g = AccountantGrant(
        accountant_email="rev@example.dk",
        owner_user_id=owner.id,
        granted_by=owner.id,
        status="revoked",
        invite_token="revoked-tok-xyz",
        revoked_at=utc_now(),
    )
    db.add(g)
    db.commit()

    res = client.post(
        "/api/accountants/signup",
        json={"invite_token": "revoked-tok-xyz", "password": "newpw1234"},
    )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "grant_revoked"


# ─── Test 7 — Signup with already-active grant → 409 ──────────────────


def test_signup_with_already_active_409(client, db):
    owner = _owner(db, plan="starter")
    g = AccountantGrant(
        accountant_email="active@example.dk",
        owner_user_id=owner.id,
        granted_by=owner.id,
        status="active",
        invite_token="alive-tok-xyz",
    )
    db.add(g)
    db.commit()

    res = client.post(
        "/api/accountants/signup",
        json={"invite_token": "alive-tok-xyz", "password": "newpw1234"},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "already_active"


# ─── Test 8 — Accountant can GET read endpoints (with delegated owner) ─


def test_accountant_can_read_sales(client, db):
    """Accountant GET /sales should return the OWNER's sales (via
    get_current_user delegation)."""
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner)

    # Insert a sale on the owner
    db.add(Sale(
        user_id=owner.id,
        amount=Decimal("250.00"),
        payment_method="card",
        date=date.today(),
        notes="test sale",
    ))
    db.commit()

    _override_user_with_request(accountant)
    # Pass X-Client-ID header to skip auto-pick logic
    res = client.get(
        "/api/sales",
        headers={"X-Client-ID": str(owner.id)},
    )
    assert res.status_code == 200, res.text
    sales = res.json()
    assert isinstance(sales, list)
    assert len(sales) >= 1
    assert float(sales[0]["amount"]) == 250.0


# ─── Test 9 — Accountant POST/PUT/DELETE → 403 read_only (middleware) ─


def test_accountant_write_blocked_by_middleware(client, db):
    """Even on a route that the accountant has tenant access to (via
    delegation), the global write-blocking middleware refuses the
    mutation."""
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner)

    # Provide a bearer token so middleware finds an authenticated user
    from app.services.auth import create_access_token
    token = create_access_token(str(accountant.id))

    res = client.post(
        "/api/sales",
        json={"amount": 100, "payment_method": "card", "date": str(date.today())},
        headers={
            "Authorization": f"Bearer {token}",
            "X-Client-ID": str(owner.id),
        },
    )
    assert res.status_code == 403, res.text
    body = res.json()
    # detail may be nested or direct depending on middleware
    detail = body.get("detail", body)
    if isinstance(detail, dict):
        assert detail.get("code") == "read_only"


def test_accountant_delete_blocked_by_middleware(client, db):
    """Same defense applies to DELETE."""
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner)

    from app.services.auth import create_access_token
    token = create_access_token(str(accountant.id))

    # Try to delete an arbitrary expense (irrelevant id — middleware
    # short-circuits before the route handler).
    res = client.delete(
        "/api/expenses/00000000-0000-0000-0000-000000000000",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Client-ID": str(owner.id),
        },
    )
    assert res.status_code == 403
    detail = res.json().get("detail", {})
    if isinstance(detail, dict):
        assert detail.get("code") == "read_only"


# ─── Test 10 — Accountant switches client, queries return new tenant's data ─


def test_accountant_switch_client_changes_effective_tenant(client, db):
    owner_a = _owner(db, plan="starter", email_suffix="A")
    owner_b = _owner(db, plan="starter", email_suffix="B")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner_a)
    _make_active_grant(db, accountant, owner_b)

    db.add(Sale(
        user_id=owner_a.id, amount=Decimal("100.00"),
        payment_method="cash", date=date.today(), notes="owner A sale",
    ))
    db.add(Sale(
        user_id=owner_b.id, amount=Decimal("999.00"),
        payment_method="cash", date=date.today(), notes="owner B sale",
    ))
    db.commit()

    _override_user_with_request(accountant)

    # Query A
    a_res = client.get("/api/sales", headers={"X-Client-ID": str(owner_a.id)})
    assert a_res.status_code == 200
    a_sales = a_res.json()
    assert all(float(s["amount"]) == 100.0 for s in a_sales)

    # Query B
    b_res = client.get("/api/sales", headers={"X-Client-ID": str(owner_b.id)})
    assert b_res.status_code == 200
    b_sales = b_res.json()
    assert all(float(s["amount"]) == 999.0 for s in b_sales)


# ─── Test 11 — Cross-grant scoping (B's data invisible when client=A) ─


def test_cross_grant_isolation(client, db):
    """The CRITICAL check: with two grants, accountant viewing client A
    cannot see client B's data."""
    owner_a = _owner(db, plan="starter", email_suffix="X")
    owner_b = _owner(db, plan="starter", email_suffix="Y")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner_a)
    _make_active_grant(db, accountant, owner_b)

    db.add(Sale(
        user_id=owner_b.id, amount=Decimal("777.00"),
        payment_method="cash", date=date.today(),
    ))
    db.commit()

    _override_user_with_request(accountant)
    res = client.get("/api/sales", headers={"X-Client-ID": str(owner_a.id)})
    assert res.status_code == 200
    sales = res.json()
    # Should NOT include the 777-DKK B sale
    assert all(float(s["amount"]) != 777.0 for s in sales)


# ─── Test 12 — Owner revokes → accountant loses access on next request ─


def test_owner_revoke_blocks_accountant_immediately(client, db):
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    grant = _make_active_grant(db, accountant, owner)

    # First request works
    _override_user_with_request(accountant)
    r1 = client.get("/api/sales", headers={"X-Client-ID": str(owner.id)})
    assert r1.status_code == 200, r1.text

    # Owner revokes
    _override_user(owner)
    rev = client.delete(f"/api/accountants/grants/{grant.id}")
    assert rev.status_code == 204

    # Verify in DB
    db.refresh(grant)
    assert grant.status == "revoked"

    # Next accountant request → 403
    _override_user_with_request(accountant)
    r2 = client.get("/api/sales", headers={"X-Client-ID": str(owner.id)})
    assert r2.status_code == 403
    detail = r2.json().get("detail", {})
    assert isinstance(detail, dict)
    assert detail.get("code") == "grant_revoked_or_missing"


# ─── Test 13 — Accountant revokes themselves ──────────────────────────


def test_accountant_can_revoke_themselves(client, db):
    owner = _owner(db, plan="starter")
    accountant = _accountant(db)
    grant = _make_active_grant(db, accountant, owner)

    # Hit the revoke endpoint as the accountant. We use a bearer token
    # so the middleware identifies them as an accountant on a DELETE,
    # but the allowlist permits /accountants/grants/{id}.
    from app.services.auth import create_access_token
    token = create_access_token(str(accountant.id))
    res = client.delete(
        f"/api/accountants/grants/{grant.id}",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Client-ID": str(owner.id),
        },
    )
    assert res.status_code == 204, res.text

    db.refresh(grant)
    assert grant.status == "revoked"


# ─── Test 14 — list_grants returns owner's full list ──────────────────


def test_owner_list_grants(client, db):
    owner = _owner(db, plan="starter")
    a1 = _accountant(db, email_suffix="1")
    a2 = _accountant(db, email_suffix="2")
    g1 = _make_active_grant(db, a1, owner)
    g2 = AccountantGrant(
        accountant_user_id=a2.id, accountant_email=a2.email,
        owner_user_id=owner.id, granted_by=owner.id,
        status="pending", invite_token="pendtok-1",
        invite_token_expires_at=utc_now() + timedelta(days=7),
    )
    db.add(g2); db.commit()

    _override_user(owner)
    res = client.get("/api/accountants/grants")
    assert res.status_code == 200
    out = res.json()
    assert len(out) == 2
    statuses = {row["status"] for row in out}
    assert statuses == {"active", "pending"}


# ─── Test 15 — /clients endpoint returns only active grants ───────────


def test_accountant_clients_only_active(client, db):
    owner_a = _owner(db, plan="starter", email_suffix="A")
    owner_b = _owner(db, plan="starter", email_suffix="B")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner_a)
    # Add a revoked one — should not appear
    g_rev = AccountantGrant(
        accountant_user_id=accountant.id,
        accountant_email=accountant.email,
        owner_user_id=owner_b.id,
        granted_by=owner_b.id,
        status="revoked",
        invite_token=None,
        revoked_at=utc_now(),
    )
    db.add(g_rev)
    db.commit()

    _override_user(accountant)  # raw accountant — /clients is a pre-client path
    res = client.get("/api/accountants/clients")
    assert res.status_code == 200, res.text
    out = res.json()
    assert len(out) == 1
    assert str(out[0]["owner_user_id"]) == str(owner_a.id)


# ─── Test 16 — Switch client requires active grant ────────────────────


def test_switch_client_requires_active_grant(client, db):
    owner = _owner(db, plan="starter")
    other = _owner(db, plan="starter", email_suffix="other")
    accountant = _accountant(db)
    _make_active_grant(db, accountant, owner)

    _override_user(accountant)
    # Try to switch to `other` — no grant exists → 403
    from app.services.auth import create_access_token
    token = create_access_token(str(accountant.id))
    res = client.post(
        f"/api/accountants/switch-client/{other.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403
    detail = res.json().get("detail", {})
    assert isinstance(detail, dict)
    assert detail.get("code") == "grant_revoked_or_missing"


# ─── Test 17 — Audit row on signup ────────────────────────────────────


def test_audit_log_on_signup(client, db):
    owner = _owner(db, plan="starter")
    _override_user(owner)
    invite = client.post(
        "/api/accountants/invite",
        json={"email": "audit-test@example.dk"},
    ).json()
    token = db.query(AccountantGrant).filter(
        AccountantGrant.id == invite["id"]
    ).first().invite_token

    _override_user(None)
    res = client.post(
        "/api/accountants/signup",
        json={"invite_token": token, "password": "newpw1234"},
    )
    assert res.status_code == 200

    rows = db.query(AuditLog).filter(
        AuditLog.action == "accountant.signup",
    ).all()
    assert len(rows) == 1


# ─── Test 18 — No-active-grants edge case ─────────────────────────────


def test_accountant_no_grants_returns_403(client, db):
    """An accountant with zero active grants hitting a tenant-scoped
    endpoint should get 403 no_active_grants, not a 500."""
    accountant = _accountant(db)
    _override_user_with_request(accountant)
    res = client.get("/api/sales")
    assert res.status_code == 403
    detail = res.json().get("detail", {})
    assert isinstance(detail, dict)
    assert detail.get("code") == "no_active_grants"
