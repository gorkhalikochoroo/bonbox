"""Password reset — per-ACCOUNT ceilings (security round, 8 Oct).

Before: the 5-wrong-guesses counter was zeroed whenever a new code was
issued, so the only per-account bound on guesses was the 2-minute resend
cooldown, and nothing capped the reset mails a known owner address got.

Now, over a rolling 24 hours, counted from audit_logs:
  * at most 5 codes (reset mails) per account;
  * at most 5 wrong codes per account — the counter is carried across a
    reissue; at the limit the code is burned, reset pauses (no new codes),
    and the owner gets exactly ONE mail saying so.

send_email is stubbed — nothing is mailed.
"""
from datetime import timedelta

import pytest

from app.models.audit_log import AuditLog
from app.models.user import User
from app.utils.time import utc_now
from tests.test_password_reset_revocation import (  # noqa: F401 — fixtures
    _make_user, client, db_session,
)

GENERIC = "If an account exists with that email, we've sent a reset code."


@pytest.fixture
def mails(monkeypatch):
    sent = []

    def _fake(to, subject, html, *a, **kw):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr("app.routers.auth.send_email", _fake)
    return sent


def _no_ip_limit():
    """The per-IP 5/minute limiter is not under test here — the per-ACCOUNT
    ceilings are (an attacker spreads requests over many IPs)."""
    from app.routers.auth import limiter
    limiter.reset()


def _forgot(client, email="owner@example.com"):
    _no_ip_limit()
    r = client.post("/api/auth/forgot-password", json={"email": email})
    assert r.status_code == 200, r.text
    assert r.json()["message"] == GENERIC
    return r


def _skip_cooldown(db, user):
    """Age the live code past the 2-minute resend cooldown."""
    db.refresh(user)
    if user.reset_token_expires:
        user.reset_token_expires = utc_now() + timedelta(minutes=5)
        db.commit()


def _wrong(client, email="owner@example.com"):
    _no_ip_limit()
    return client.post("/api/auth/reset-password", json={
        "email": email, "reset_token": "000000", "new_password": "NewPass12345",
    })


def test_codes_per_day_ceiling(db_session, client, mails):
    user = _make_user(db_session)
    for _ in range(5):
        _forgot(client)
        _skip_cooldown(db_session, user)
    assert len(mails) == 5
    _forgot(client)  # the sixth: same answer, no CODE mail
    codes = [m for m in mails if "reset code is" in m["subject"]]
    assert len(codes) == 5
    n = db_session.query(AuditLog).filter(AuditLog.action == "auth.reset_code_issued").count()
    assert n == 5


def test_over_the_code_ceiling_the_owner_is_told_once(db_session, client, mails):
    """Review, 8 Oct: anyone who knows the address could use up the day's
    five codes in ~10 minutes; the owner's own reset then silently did
    nothing for 24 hours. The first over-cap request sends the owner ONE
    notice (reset paused, a login link still works); the generic answer and
    the no-code rule stay."""
    user = _make_user(db_session)
    for _ in range(5):
        _forgot(client)
        _skip_cooldown(db_session, user)
    for _ in range(3):
        _forgot(client)
        _skip_cooldown(db_session, user)
    notices = [m for m in mails if "reset code is" not in m["subject"]]
    assert len(notices) == 1, [m["subject"] for m in mails]
    n = notices[0]
    assert n["to"] == "owner@example.com"
    assert "login link" in n["html"] or "login-link" in n["html"]
    assert "24" in n["html"]
    assert len([m for m in mails if "reset code is" in m["subject"]]) == 5


def test_wrong_guess_counter_is_carried_across_a_reissue(db_session, client, mails):
    user = _make_user(db_session)
    _forgot(client)
    for _ in range(3):
        assert _wrong(client).status_code == 400
    _skip_cooldown(db_session, user)
    _forgot(client)  # a fresh code does not hand out 5 fresh guesses
    db_session.refresh(user)
    assert user.reset_attempts == 3
    assert _wrong(client).status_code == 400
    assert _wrong(client).status_code == 400  # the 5th wrong code of the day
    db_session.refresh(user)
    assert user.reset_token is None  # burned at the limit
    # Exactly one lock notice went to the owner.
    notices = [m for m in mails if "pause" in m["subject"].lower()]
    assert len(notices) == 1 and notices[0]["to"] == "owner@example.com"
    # While paused: no new code, no mail, and further guesses change nothing.
    n_mail = len(mails)
    _skip_cooldown(db_session, user)
    _forgot(client)
    db_session.refresh(user)
    assert user.reset_token is None and len(mails) == n_mail
    assert _wrong(client).status_code == 400
    assert len(mails) == n_mail


def test_window_expires(db_session, client, mails):
    user = _make_user(db_session)
    _forgot(client)
    for _ in range(5):
        _wrong(client)
    for row in db_session.query(AuditLog).filter(AuditLog.user_id == user.id).all():
        row.created_at = utc_now() - timedelta(hours=25)
    db_session.commit()
    n_mail = len(mails)
    _forgot(client)
    db_session.refresh(user)
    assert len(mails) == n_mail + 1
    assert user.reset_token and user.reset_attempts == 0


def test_correct_code_still_resets(db_session, client, mails):
    user = _make_user(db_session)
    _forgot(client)
    _wrong(client)
    db_session.refresh(user)
    r = client.post("/api/auth/reset-password", json={
        "email": "owner@example.com", "reset_token": user.reset_token,
        "new_password": "NewPass12345",
    })
    assert r.status_code == 200, r.text
    db_session.refresh(user)
    assert user.reset_attempts == 0 and user.reset_token is None


def test_the_account_row_is_locked_before_the_guess_is_counted(db_session, client, mails, monkeypatch):
    """Review, 8 Oct: parallel wrong guesses (many IPs, one account) must not
    all read the same reset_attempts and each write the same +1. The lookup
    that reads the counter takes a row lock (SELECT … FOR UPDATE on
    Postgres), so the requests for one account are counted one at a time."""
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.orm import Query

    _make_user(db_session)
    _forgot(client)
    locked = []
    real = Query.with_for_update

    def spy(self, *a, **kw):
        q = real(self, *a, **kw)
        locked.append(str(q.statement.compile(dialect=postgresql.dialect())))
        return q

    monkeypatch.setattr(Query, "with_for_update", spy)
    assert _wrong(client).status_code == 400
    assert any("FROM users" in sql and "FOR UPDATE" in sql for sql in locked), locked
