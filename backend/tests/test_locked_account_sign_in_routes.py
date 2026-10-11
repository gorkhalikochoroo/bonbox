"""Locked accounts get no session from the inbox-proof sign-in routes (combined fix round, 11 Oct).

An admin lock (users.is_locked, /admin/users/{id}/lock) is refused by
get_current_user and the OAuth routes with 401 "Account is locked. Contact
support.". Two public routes that mint a session did not check it:

  • POST /api/auth/reset-password — a correct code set the new password,
    bumped token_version, opened a claim question, stamped last_seen_at and
    signed the device in;
  • POST /api/team/accept-invite/{token} — a locked invitee got a password,
    a burnt invite, an audit row, a stamp and a session token.

Both now refuse with the same 401 and detail (services/auth.
refuse_locked_account), after the code / invite proved the inbox and before
anything is written: the row is left as it was, no cookie, no token, no
stamp, no mail. A wrong reset code on a locked account still gets the
generic 400, so a guess cannot tell a locked account apart.

The e-mail link (POST /api/auth/magic-link/verify) already refused a locked
account before minting — 401, code account_locked, the same message; pinned
here so it stays that way.

Run: cd backend && python3 -m pytest tests/test_locked_account_sign_in_routes.py -q
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.audit_log import AuditLog
from app.models.magic_link_token import MagicLinkToken
from app.models.user import User
from app.services.auth import LOCKED_ACCOUNT_DETAIL, hash_password
from app.utils.time import utc_now

_db_ready.set()

LOCKED = "Account is locked. Contact support."


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

    for mod in ("app.routers.auth", "app.routers.auth_magic_link", "app.routers.team"):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def mails(monkeypatch):
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


def _row(SessionLocal, uid) -> User:
    s = SessionLocal()
    try:
        u = s.query(User).filter(User.id == uid).one()
        s.expunge(u)
        return u
    finally:
        s.close()


def _audits(SessionLocal, action) -> int:
    s = SessionLocal()
    try:
        return s.query(AuditLog).filter(AuditLog.action == action).count()
    finally:
        s.close()


def _no_session(r):
    assert "bonbox_session" not in r.headers.get("set-cookie", ""), r.headers.get("set-cookie")
    body = r.json()
    assert not body.get("token") and not body.get("access_token"), body


def _locked_401(r):
    assert r.status_code == 401, r.text
    assert r.json()["detail"] == LOCKED
    _no_session(r)


def test_the_shared_detail_is_the_oauth_routes_detail():
    assert LOCKED_ACCOUNT_DETAIL == LOCKED
    routers = Path(__file__).resolve().parent.parent / "app" / "routers"
    assert f'detail="{LOCKED}"' in (routers / "auth_oauth.py").read_text()


# ── reset-password ─────────────────────────────────────────────────────────


def _with_reset_code(db, u, code="123456"):
    u.reset_token = code
    u.reset_token_expires = utc_now() + timedelta(minutes=10)
    u.reset_attempts = 0
    db.commit()


def test_reset_password_refuses_a_locked_account_and_changes_nothing(
        client, db, SessionLocal, mails):
    u = _user(db, email="locked-reset@cafe-example.dk", email_verified=False, is_locked=True)
    _with_reset_code(db, u)
    before = _row(SessionLocal, u.id)
    r = client.post("/api/auth/reset-password", json={
        "email": "locked-reset@cafe-example.dk", "reset_token": "123456",
        "new_password": "freshResetPass1",
    })
    _locked_401(r)
    after = _row(SessionLocal, u.id)
    assert after.password_hash == before.password_hash          # old password still the one
    assert after.token_version == before.token_version          # sessions not touched
    assert after.reset_token == "123456" and after.reset_attempts == 0
    assert after.last_seen_at is None                           # not stamped
    assert after.email_verified is False                        # no claim question opened
    assert _audits(SessionLocal, "auth.password_reset") == 0
    assert mails == []


def test_a_wrong_code_on_a_locked_account_gets_the_generic_answer(client, db):
    u = _user(db, email="locked-guess@cafe-example.dk", is_locked=True)
    _with_reset_code(db, u)
    r = client.post("/api/auth/reset-password", json={
        "email": "locked-guess@cafe-example.dk", "reset_token": "654321",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 400
    assert r.json()["detail"] == "Invalid or expired reset code"


def test_reset_password_still_signs_an_unlocked_account_in(client, db):
    u = _user(db, email="open-reset@cafe-example.dk")
    _with_reset_code(db, u)
    r = client.post("/api/auth/reset-password", json={
        "email": "open-reset@cafe-example.dk", "reset_token": "123456",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 200, r.text
    assert r.json()["token"]


# ── team accept-invite ─────────────────────────────────────────────────────


def _invite(db, *, locked):
    owner = _user(db, business_name="Bon Bakery")
    raw = secrets.token_urlsafe(32)
    invitee = _user(db, email=f"anna-{uuid.uuid4().hex[:6]}@cafe-example.dk", role="cashier",
                    email_verified=False, is_locked=locked,
                    invite_token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                    invite_expires_at=utc_now() + timedelta(days=7),
                    invited_by_user_id=owner.id, owner_id=owner.id)
    return raw, invitee


def test_team_accept_invite_refuses_a_locked_invitee_and_changes_nothing(
        client, db, SessionLocal):
    raw, invitee = _invite(db, locked=True)
    before = _row(SessionLocal, invitee.id)
    r = client.post(f"/api/team/accept-invite/{raw}",
                    json={"password": "annaspw123", "full_name": "Anna Hansen"})
    _locked_401(r)
    after = _row(SessionLocal, invitee.id)
    assert after.password_hash == before.password_hash
    assert after.invite_token_hash == before.invite_token_hash   # invite not burnt
    assert after.invite_expires_at is not None
    assert after.email_verified is False
    assert after.business_name == before.business_name
    assert after.last_seen_at is None
    assert _audits(SessionLocal, "team.invite_accepted") == 0


def test_team_accept_invite_still_signs_an_unlocked_invitee_in(client, db):
    raw, _ = _invite(db, locked=False)
    r = client.post(f"/api/team/accept-invite/{raw}",
                    json={"password": "annaspw123", "full_name": "Anna Hansen"})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]


# ── magic-link verify (already refused; pinned) ────────────────────────────


def test_magic_link_verify_refuses_a_locked_account_before_minting(client, db, SessionLocal):
    from app.services.magic_link_service import create_token

    u = _user(db, email="locked-link@cafe-example.dk", is_locked=True)
    raw, row = create_token(db, "locked-link@cafe-example.dk")
    db.commit()
    r = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r.status_code == 401, r.text
    detail = r.json()["detail"]
    assert detail == {"code": "account_locked", "message": LOCKED}
    assert "bonbox_session" not in r.headers.get("set-cookie", "")
    assert _row(SessionLocal, u.id).last_seen_at is None
    s = SessionLocal()
    try:
        assert s.get(MagicLinkToken, row.id).used_at is None
    finally:
        s.close()
