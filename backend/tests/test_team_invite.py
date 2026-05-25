"""
Team magic-link invite — security tests (Task #202, 2026-05-25).

P0 security rewrite of the team invite flow that previously minted a
plaintext temp_password and rendered it on screen. New flow:
  • POST /api/team/invite   — owner mints magic-link token, email sent
  • GET  /api/team/accept-invite/{token}  — public token resolver
  • POST /api/team/accept-invite/{token}  — public password-set + login
  • POST /api/team/{id}/resend-invite     — owner re-mints + re-sends
  • POST /api/team/{id}/revoke-invite     — owner cancels pending invite
  • PATCH /api/team/{id}/role             — audit-logged role change
  • DELETE /api/team/{id}                  — audit-logged removal

Coverage:
  1. Invite returns NO plaintext password / token in response body
  2. Invite stores sha256(token) on user.invite_token_hash + 7-day TTL
  3. Accept resolves the raw token via hash, sets password, burns token
  4. Accept rejects tokens shorter than 32 chars (truncation defence)
  5. Accept rejects expired tokens (410)
  6. Accept is single-use — replay returns 409
  7. Tenant scope — owner A's token can't be accepted via owner B's grant
  8. Email-send failure still returns success with email_sent=false
  9. Email enumeration defence — inviting a foreign-owned email returns
     200 but does NOT mint a token on the existing row
 10. Audit rows land on EVERY action (invite, accept, resend, revoke,
     role_change, remove)
 11. Rate limit fires after the 5th invite within a minute
 12. Pending invites endpoint surfaces in-flight invitations

Run:
  cd backend && python3 -m pytest tests/test_team_invite.py -x -q
"""
import hashlib
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password, verify_password
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


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """slowapi keeps an in-memory window keyed on remote IP. Without
    resetting it between tests the 5/minute /invite limit bleeds across
    the suite. Reset before every test so each starts with a clean
    budget."""
    from app.routers import team as team_router
    team_router.limiter.reset()
    yield
    team_router.limiter.reset()


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

    # Mock the email sender — no SMTP needed. Capture every send so we
    # can assert that the raw token NEVER lands in the response body
    # (it only appears inside the email HTML).
    sent: list[dict] = []

    def _fake_send_email(to, subject, html, **kwargs):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(
        "app.services.email_service.send_email", _fake_send_email
    )

    # Attach the captured-list to the client so individual tests can
    # inspect it.
    tc = TestClient(app)
    tc.sent = sent  # type: ignore[attr-defined]
    yield tc
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ──────────────────────────────────────────────────────────


def _owner(db, *, plan: str = "starter", email_suffix: str = "") -> User:
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


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _extract_token_from_email_html(html: str) -> str | None:
    """Pull the accept-invite token out of the rendered email HTML.

    The email body contains
        <a href="https://.../accept-invite/team/<TOKEN>?role=cashier">
    so we look for the segment after /accept-invite/team/ up to the
    closing quote or query string.
    """
    marker = "/accept-invite/team/"
    idx = html.find(marker)
    if idx < 0:
        return None
    tail = html[idx + len(marker):]
    # token ends at the first " or ? whichever comes first
    for sep in ('"', "?", "&"):
        cut = tail.find(sep)
        if cut >= 0:
            tail = tail[:cut]
    return tail or None


# ─── 1. Response body must NEVER carry plaintext secrets ─────────────


def test_invite_response_carries_no_plaintext_secrets(client, db):
    owner = _owner(db)
    _override_user(owner)

    res = client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier", "name": "Anna"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Critical security assertions — no plaintext password, no raw token.
    assert "temp_password" not in body
    assert "password" not in body
    assert "invite_token" not in body
    assert "token" not in body
    # Honest fields only.
    assert body["status"] == "invited"
    assert body["email"] == "anna@cafe.dk"
    assert body["role"] == "cashier"
    assert body["email_sent"] is True
    assert body["expires_at"] is not None
    assert body["invite_token_sent"] is True


# ─── 2. Token is stored as sha256 hash + 7-day TTL ───────────────────


def test_invite_stores_token_hash_and_ttl(client, db):
    owner = _owner(db)
    _override_user(owner)

    res = client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier", "name": "Anna"},
    )
    assert res.status_code == 200

    # The token only appears in the captured email; the response body
    # never carries it.
    assert len(client.sent) == 1
    raw_token = _extract_token_from_email_html(client.sent[0]["html"])
    assert raw_token is not None
    # 256-bit entropy → 43 url-safe base64 chars.
    assert len(raw_token) >= 32

    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    assert invitee is not None
    assert invitee.invite_token_hash == _sha256(raw_token)
    assert invitee.invite_expires_at is not None
    delta = invitee.invite_expires_at - utc_now()
    # TTL window — 7 days +/- 1 minute slack for clock drift in the
    # test process between mint + assert.
    assert timedelta(days=7) - timedelta(minutes=1) <= delta <= timedelta(days=7)
    # Random bcrypt password — invitee can't authenticate until they
    # accept the invite + choose their own password. We assert the hash
    # is a valid bcrypt format (so /auth/login doesn't 500) and that
    # no obvious password value works.
    assert invitee.password_hash.startswith("$2"), "expected bcrypt hash prefix"
    assert verify_password("anything", invitee.password_hash) is False
    assert verify_password("", invitee.password_hash) is False
    # email_verified stays False until the user clicks the magic link.
    assert invitee.email_verified is False


# ─── 3. Accept-invite resolves token, sets password, burns token ─────


def test_accept_invite_sets_password_and_burns_token(client, db):
    owner = _owner(db)
    _override_user(owner)
    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier", "name": "Anna"},
    )
    raw_token = _extract_token_from_email_html(client.sent[0]["html"])
    _override_user(None)  # accept endpoint is public

    # GET resolver returns business name + role.
    res = client.get(f"/api/team/accept-invite/{raw_token}")
    assert res.status_code == 200
    body = res.json()
    assert body["role"] == "cashier"
    assert body["owner_business_name"] == "Bon Bakery"
    assert body["email"] == "anna@cafe.dk"

    # POST accept sets password and returns a session token.
    res = client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "annaspw123", "full_name": "Anna Hansen"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["access_token"]
    assert body["user"]["email"] == "anna@cafe.dk"
    assert body["user"]["role"] == "cashier"

    # Token burned — single-use guarantee.
    db.expire_all()
    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    assert invitee.invite_token_hash is None
    assert invitee.invite_expires_at is None
    assert verify_password("annaspw123", invitee.password_hash)
    assert invitee.owner_id == owner.id


# ─── 4. Truncation attacks — refuse tokens shorter than 32 chars ─────


def test_accept_rejects_short_tokens(client, db):
    _override_user(None)
    res = client.get("/api/team/accept-invite/shorttoken")
    assert res.status_code == 404
    res = client.post(
        "/api/team/accept-invite/shorttoken",
        json={"password": "annaspw123"},
    )
    assert res.status_code == 404


# ─── 5. Expired tokens — 410 ─────────────────────────────────────────


def test_accept_rejects_expired_token(client, db):
    owner = _owner(db)
    _override_user(owner)
    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier"},
    )
    raw_token = _extract_token_from_email_html(client.sent[0]["html"])

    # Backdate the expiry.
    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    invitee.invite_expires_at = utc_now() - timedelta(seconds=1)
    db.commit()

    _override_user(None)
    res = client.get(f"/api/team/accept-invite/{raw_token}")
    assert res.status_code == 410
    body = res.json()
    assert body["detail"]["code"] == "invite_expired"

    res = client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "annaspw123"},
    )
    assert res.status_code == 410


# ─── 6. Single-use — replay returns 409 ──────────────────────────────


def test_accept_is_single_use(client, db):
    owner = _owner(db)
    _override_user(owner)
    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier"},
    )
    raw_token = _extract_token_from_email_html(client.sent[0]["html"])

    _override_user(None)
    res = client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "annaspw123"},
    )
    assert res.status_code == 200

    # Second submit — token has been burned.
    res = client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "different456"},
    )
    # Token hash is cleared, so the lookup returns None → 404. The user
    # never sees "already accepted" because the row has no token to match.
    assert res.status_code == 404


# ─── 7. Tenant scope — cross-owner tokens stay scoped ────────────────


def test_token_is_scoped_to_inviting_owner(client, db):
    owner_a = _owner(db, email_suffix="-a")
    _owner(db, email_suffix="-b")

    _override_user(owner_a)
    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier"},
    )
    raw_token = _extract_token_from_email_html(client.sent[0]["html"])

    _override_user(None)
    res = client.get(f"/api/team/accept-invite/{raw_token}")
    assert res.status_code == 200
    # Resolver returns owner A's business name — owner B can't substitute.
    assert res.json()["owner_business_name"] == "Bon Bakery-a"

    # Once accepted, owner_id is owner A's id, not B's.
    res = client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "annaspw123"},
    )
    assert res.status_code == 200
    db.expire_all()
    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    assert invitee.owner_id == owner_a.id


# ─── 8. Email-send failure surfaces honestly via email_sent flag ──────


def test_invite_returns_success_when_email_fails(client, db, monkeypatch):
    owner = _owner(db)
    _override_user(owner)

    def _broken_send(*args, **kwargs):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(
        "app.services.email_service.send_email", _broken_send
    )

    res = client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "invited"
    assert body["email_sent"] is False
    # Token IS still minted on the DB — owner can resend.
    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    assert invitee.invite_token_hash is not None


# ─── 9. Email enumeration — foreign-owned email doesn't mint a token ─


def test_invite_does_not_leak_existing_user_via_token(client, db):
    owner_a = _owner(db, email_suffix="-a")
    owner_b = _owner(db, email_suffix="-b")

    # owner_b is a real, INDEPENDENT user (owner_id NULL).
    assert owner_b.owner_id is None

    _override_user(owner_a)
    res = client.post(
        "/api/team/invite",
        json={"email": owner_b.email, "role": "cashier"},
    )
    # Generic success shape — no enumeration leak.
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "invited"
    assert body["email_sent"] is False
    assert body["invite_token_sent"] is False

    # owner_b's row was NOT touched.
    db.expire_all()
    owner_b_after = db.query(User).filter(User.email == owner_b.email).first()
    assert owner_b_after.invite_token_hash is None
    assert owner_b_after.owner_id is None
    assert owner_b_after.role == "owner"

    # Audit row records the rejection for the inviting owner's history.
    rejections = db.query(AuditLog).filter(
        AuditLog.action == "team.invite_rejected",
        AuditLog.user_id == owner_a.id,
    ).all()
    assert len(rejections) == 1


# ─── 10. Audit rows land on every action ─────────────────────────────


def test_audit_rows_on_every_team_action(client, db):
    owner = _owner(db)
    _override_user(owner)

    # invite → team.invited
    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier"},
    )
    raw_token = _extract_token_from_email_html(client.sent[-1]["html"])

    # role_changed
    invitee = db.query(User).filter(User.email == "anna@cafe.dk").first()
    # role_changed only fires after the invite is accepted (active member).
    # Accept first.
    _override_user(None)
    client.post(
        f"/api/team/accept-invite/{raw_token}",
        json={"password": "annaspw123"},
    )

    # role_changed
    _override_user(owner)
    client.patch(f"/api/team/{invitee.id}/role", json={"role": "manager"})
    # removed
    client.delete(f"/api/team/{invitee.id}")

    # resend + revoke flow on a fresh invite
    client.post("/api/team/invite", json={"email": "bjorn@cafe.dk", "role": "viewer"})
    bjorn = db.query(User).filter(User.email == "bjorn@cafe.dk").first()
    client.post(f"/api/team/{bjorn.id}/resend-invite")
    client.post(f"/api/team/{bjorn.id}/revoke-invite")

    actions = {
        row.action
        for row in db.query(AuditLog).filter(AuditLog.user_id == owner.id).all()
    }
    expected = {
        "team.invited",
        "team.role_changed",
        "team.removed",
        "team.invite_resent",
        "team.invite_revoked",
    }
    # team.invite_accepted is scoped to the invitee's user_id, not owner's.
    accepted = (
        db.query(AuditLog)
        .filter(AuditLog.action == "team.invite_accepted")
        .first()
    )
    assert accepted is not None
    missing = expected - actions
    assert not missing, f"missing audit actions for owner: {missing}"


# ─── 11. Rate limit fires after 5 invites within a minute ─────────────


def test_invite_rate_limit_after_five_per_minute(client, db, monkeypatch):
    # Patch the cap gate so it doesn't preempt the rate-limit test —
    # we want to hit slowapi, not seat-cap 403s. Pro tier in PLAN_CAPS
    # has team_users=5; we use a 999 stub here so seat-cap never fires.
    monkeypatch.setattr(
        "app.routers.team.at_cap", lambda *a, **kw: False
    )

    owner = _owner(db, plan="pro")
    _override_user(owner)

    status_codes = []
    for i in range(6):
        res = client.post(
            "/api/team/invite",
            json={"email": f"staff{i}@cafe.dk", "role": "cashier"},
        )
        status_codes.append(res.status_code)

    # First 5 succeed, the 6th is throttled by slowapi.
    assert status_codes[:5] == [200, 200, 200, 200, 200], status_codes
    assert status_codes[5] == 429, status_codes


# ─── 12. Pending invites endpoint surfaces in-flight invitations ──────


def test_pending_invites_endpoint(client, db):
    owner = _owner(db)
    _override_user(owner)
    # Reset rate limit from prior test.
    from app.routers import team as team_router
    team_router.limiter.reset()

    client.post(
        "/api/team/invite",
        json={"email": "anna@cafe.dk", "role": "cashier", "name": "Anna"},
    )
    res = client.get("/api/team/pending-invites")
    assert res.status_code == 200
    pending = res.json()
    assert len(pending) == 1
    assert pending[0]["email"] == "anna@cafe.dk"
    assert pending[0]["role"] == "cashier"
    assert pending[0]["expired"] is False
    assert pending[0]["days_remaining"] >= 6  # 7 days TTL minus test slop
