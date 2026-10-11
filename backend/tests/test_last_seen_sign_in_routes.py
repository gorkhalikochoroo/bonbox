"""Every route that signs someone in stamps users.last_seen_at (combined-release fix round).

services/last_seen.py: "sign-in endpoints — force=True, so the moment of
signing in is exact". Login, register, magic link, Google/Apple (both routes)
did; four public routes that mint a session token did not, so their sign-in
was invisible until the next authenticated request:

  • POST /api/auth/reset-password        — the code signs the device straight in
  • POST /api/team/accept-invite/{token} — the invitee lands signed in
  • POST /api/accountants/signup         — the revisor lands signed in
  • POST /api/auth/claim-decision        — "secure" from the page re-signs that browser

Routes that re-mint the CURRENT session (sign-out-all, change-password, the
shared-device PIN) run get_current_user, which stamps already; not here.

And the legacy POST /api/auth/apple (old iOS builds) had no is_locked check:
a locked account got a token, a stamp, an Apple link and a claim question
mail. It now refuses first, with the same 401 as /api/auth/oauth/apple, and
the row is left as it was.

No mail leaves the test.

Run: cd backend && python3 -m pytest tests/test_last_seen_sign_in_routes.py -q
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.accountant_grant import AccountantGrant
from app.models.user import User
from app.services.auth import hash_password
from app.utils.time import utc_now

_db_ready.set()

LONG_AGO = timedelta(days=3)


@pytest.fixture
def SessionLocal():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(SessionLocal):
    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    for mod in ("app.routers.auth", "app.routers.auth_magic_link", "app.routers.team",
                "app.routers.accountants"):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def no_mail(monkeypatch):
    sent = []
    monkeypatch.setattr("app.services.email_service.send_email",
                        lambda *a, **k: sent.append(a) or True)
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: sent.append(a) or True)
    return sent


def _user(db, **kw) -> User:
    u = User(
        id=uuid.uuid4(),
        email=kw.pop("email", f"{uuid.uuid4().hex[:10]}@cafe-example.dk"),
        password_hash=hash_password(kw.pop("password", "pw-123456")),
        business_name=kw.pop("business_name", "Café Test"), business_type="cafe", currency="DKK",
        role=kw.pop("role", "owner"), email_verified=kw.pop("email_verified", True),
        created_at=utc_now() - timedelta(days=10), **kw,
    )
    db.add(u)
    db.commit()
    return u


def _stamp(SessionLocal, uid):
    s = SessionLocal()
    try:
        return s.query(User.last_seen_at).filter(User.id == uid).scalar()
    finally:
        s.close()


def _just_now(ts) -> bool:
    return ts is not None and (utc_now() - ts).total_seconds() < 5


# ── (a) the four sign-in routes stamp ────────────────────────────────────


def test_reset_password_signs_in_and_stamps(client, db, SessionLocal):
    u = _user(db, email="reset@cafe-example.dk", last_seen_at=utc_now() - LONG_AGO)
    u.reset_token = "123456"
    u.reset_token_expires = utc_now() + timedelta(minutes=10)
    u.reset_attempts = 0
    db.commit()
    r = client.post("/api/auth/reset-password", json={
        "email": "reset@cafe-example.dk", "reset_token": "123456",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 200, r.text
    assert r.json().get("token")
    assert _just_now(_stamp(SessionLocal, u.id))


def test_a_wrong_reset_code_does_not_stamp(client, db, SessionLocal):
    u = _user(db, email="reset-bad@cafe-example.dk")
    u.reset_token = "123456"
    u.reset_token_expires = utc_now() + timedelta(minutes=10)
    u.reset_attempts = 0
    db.commit()
    r = client.post("/api/auth/reset-password", json={
        "email": "reset-bad@cafe-example.dk", "reset_token": "654321",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 400
    assert _stamp(SessionLocal, u.id) is None


def test_team_accept_invite_signs_in_and_stamps(client, db, SessionLocal):
    owner = _user(db, business_name="Bon Bakery")
    raw = secrets.token_urlsafe(32)
    invitee = _user(db, email="anna@cafe-example.dk", role="cashier",
                    invite_token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                    invite_expires_at=utc_now() + timedelta(days=7),
                    invited_by_user_id=owner.id, owner_id=owner.id)
    r = client.post(f"/api/team/accept-invite/{raw}",
                    json={"password": "annaspw123", "full_name": "Anna Hansen"})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]
    assert _just_now(_stamp(SessionLocal, invitee.id))
    assert _stamp(SessionLocal, owner.id) is None          # the invitee's row, never the owner's


def test_accountant_signup_signs_in_and_stamps(client, db, SessionLocal):
    owner = _user(db)
    g = AccountantGrant(accountant_user_id=None, accountant_email="jens@revisor-example.dk",
                        owner_user_id=owner.id, granted_by=owner.id, status="pending",
                        invite_token="revisor-invite-tok-123",
                        invite_token_expires_at=utc_now() + timedelta(days=7),
                        invited_at=utc_now())
    db.add(g)
    db.commit()
    r = client.post("/api/accountants/signup", json={
        "invite_token": "revisor-invite-tok-123", "password": "revisorpw123",
        "full_name": "Jens Jensen",
    })
    assert r.status_code == 200, r.text
    revisor_id = r.json()["user"]["id"]
    assert _just_now(_stamp(SessionLocal, uuid.UUID(revisor_id)))
    assert _stamp(SessionLocal, owner.id) is None


def test_claim_decision_secure_from_the_page_re_signs_in_and_stamps(client, db, SessionLocal):
    from app.services.claim_decision import ask_inbox_owner
    u = _user(db, email="claim@cafe-example.dk", email_verified=False,
              last_seen_at=utc_now() - LONG_AGO)
    ask = ask_inbox_owner(db, u, via="magic_link", page_ticket=True)
    db.commit()
    assert ask is not None and ask.page_ticket
    r = client.post("/api/auth/claim-decision", json={"ticket": ask.page_ticket, "answer": "secure"})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]
    assert _just_now(_stamp(SessionLocal, u.id))


def test_claim_decision_keep_signs_nobody_in_and_does_not_stamp(client, db, SessionLocal):
    from app.services.claim_decision import ask_inbox_owner
    old = utc_now() - LONG_AGO
    u = _user(db, email="claim-keep@cafe-example.dk", email_verified=False, last_seen_at=old)
    ask = ask_inbox_owner(db, u, via="magic_link", page_ticket=True)
    db.commit()
    r = client.post("/api/auth/claim-decision", json={"ticket": ask.page_ticket, "answer": "keep"})
    assert r.status_code == 200, r.text
    assert not r.json().get("access_token")
    assert _stamp(SessionLocal, u.id) == old


# ── (b) legacy POST /auth/apple refuses a locked account first ───────────


def _apple(client, claims):
    with patch.object(settings, "APPLE_ALLOWED_AUDIENCES", "dk.bonbox.app"), \
         patch("app.routers.auth._verify_apple_identity_token", return_value=claims):
        return client.post("/api/auth/apple", json={"identity_token": "stub-jwt"})


def _same_401_as_the_oauth_route(r):
    assert r.status_code == 401, r.text
    assert r.json()["detail"] == "Account is locked. Contact support."


def test_legacy_apple_refuses_a_locked_account_found_by_sub(client, db, SessionLocal, no_mail):
    u = _user(db, email="locked-sub@cafe-example.dk", apple_user_id="001234.locked.sub",
              is_locked=True)
    r = _apple(client, {"sub": "001234.locked.sub", "email": "locked-sub@cafe-example.dk",
                        "email_verified": "true"})
    _same_401_as_the_oauth_route(r)
    assert _stamp(SessionLocal, u.id) is None
    assert no_mail == []


def test_legacy_apple_refuses_a_locked_account_found_by_email_and_links_nothing(
        client, db, SessionLocal, no_mail):
    u = _user(db, email="locked-mail@cafe-example.dk", email_verified=False, is_locked=True)
    r = _apple(client, {"sub": "001234.locked.mail", "email": "locked-mail@cafe-example.dk",
                        "email_verified": "true"})
    _same_401_as_the_oauth_route(r)
    s = SessionLocal()
    try:
        row = s.query(User).filter(User.id == u.id).one()
        assert row.apple_user_id is None          # not linked
        assert row.email_verified is False        # no claim question opened
        assert row.last_seen_at is None           # not stamped
    finally:
        s.close()
    assert no_mail == []


def test_legacy_apple_still_signs_an_unlocked_account_in_and_stamps(client, db, SessionLocal):
    u = _user(db, email="open@cafe-example.dk", apple_user_id="001234.open.sub")
    r = _apple(client, {"sub": "001234.open.sub", "email": "open@cafe-example.dk",
                        "email_verified": "true"})
    assert r.status_code == 200, r.text
    assert _just_now(_stamp(SessionLocal, u.id))


def test_the_oauth_apple_route_answers_the_same_locked_detail():
    """The legacy refusal is a copy of this one — if it changes, both change."""
    from pathlib import Path
    here = Path(__file__).resolve().parent.parent / "app" / "routers"
    oauth = (here / "auth_oauth.py").read_text()
    legacy = (here / "auth.py").read_text()
    assert 'detail="Account is locked. Contact support."' in oauth
    assert 'detail="Account is locked. Contact support."' in legacy
