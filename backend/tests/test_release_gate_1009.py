"""Release gate R-a (9 Oct) — the findings fixed before the push.

1. While "did you create this account yourself?" is open, every held
   third-party send names the TRUE reason (the address is confirmed; BonBox
   waits for the answer to the question it e-mailed): the lock mail's skip
   reason and History marker are "claim_question_open", the held revisor
   invite says so, and the refusal text never says "confirm your e-mail".
   The app can ask for the question mail again (POST
   /api/auth/claim-decision/remail): one mail a day, to the account's own
   inbox only, nothing in the response that answers it — only the ticket in
   that mail can. /auth/me says whether the question is open.
3. After a password reset the question mail says "Nej / Ved ikke" ends the
   password just chosen too.
5. "Send a test now" (Daily Brief) is on the self-test ceiling (shared
   counter, one per 10 minutes, five a day) — the ceiling only, like the
   other test mails (review, 9 Oct: no confirmed-address wall); the
   cooldown never says a mail "was just sent".
9. A held revisor copy whose owner copy ALSO failed keeps both facts in
   email_error ("revisor_<reason>;<the copy's error>").
11. The SQLite mirror adds business_profiles.timereg_period_json.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from app.models.account_claim_ticket import AccountClaimTicket
from app.models.audit_log import AuditLog
from app.services.auth import create_access_token
from app.utils.time import utc_now
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_user,
    client,
    db_session,
    mailbox,
)
from tests.test_revisor_mail_confirmed_sender import OWNER, _owner  # noqa: F401
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    PIA,
    _fresh_route_limiters,
    _to,
)


@pytest.fixture(autouse=True)
def _fresh_auth_limiters():
    from app.routers import auth_magic_link as _ml, dashboard as _dash
    lims = [_ml.limiter, getattr(_dash, "_ai_limiter", None)]
    for lim in lims:
        if lim is not None:
            lim.reset()
    yield
    for lim in lims:
        if lim is not None:
            lim.reset()


def _open_question(db, user, via="magic_link"):
    from app.services.claim_decision import ask_inbox_owner
    ask = ask_inbox_owner(db, user, via=via)
    db.commit()
    db.refresh(user)
    assert user.email_verified is True
    return ask


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


# ═══ 1. The true reason while the question is open ═══════════════════════


def test_the_refusal_says_the_address_is_confirmed_and_names_the_mailed_question(db_session):
    from fastapi import HTTPException
    from app.services.revisor_mail import require_verified_sender
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)
    with pytest.raises(HTTPException) as e:
        require_verified_sender(user)
    d = e.value.detail
    assert d["reason"] == "claim_question_open"
    assert "Din e-mailadresse er bekræftet" in d["message_da"]
    assert "spørgsmålet, vi har mailet dig" in d["message_da"]
    assert "Your e-mail address is confirmed" in d["message"]
    assert "the question we e-mailed you" in d["message"]
    for wrong in ("Bekræft først", "bekræft din e-mail", "Profil → Ikke bekræftet"):
        assert wrong not in d["message_da"]
    assert "Confirm your" not in d["message"]


def test_held_sender_reason_names_each_state(db_session):
    from app.services.revisor_mail import held_sender_reason
    user = _owner(db_session, verified=False)
    assert held_sender_reason(user) == "email_unverified"
    ask = _open_question(db_session, user)
    assert held_sender_reason(user) == "claim_question_open"
    from app.services.claim_decision import decide
    decide(db_session, ask.page_ticket, "keep")
    db_session.commit()
    assert held_sender_reason(user) is None


def test_the_lock_mail_skip_and_history_marker_are_claim_question_open(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)
    r = _lock(client, user, d="2026-10-07")
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "claim_question_open"
    assert ritual["email_error"] == "revisor_claim_question_open"
    assert _to(mailbox, PIA) == []
    own = _to(mailbox, OWNER)
    assert len(own) == 1
    html = own[0]["html"]
    assert "din e-mail er bekræftet" in html
    assert "spørgsmålet, vi har mailet dig" in html
    assert "bekræft din e-mail først" not in html
    listed = client.get("/api/daily-close", headers=_auth(user)).json()
    row = next(x for x in listed if x["id"] == r.json()["id"])
    assert row["email_error"] == "revisor_claim_question_open"


def test_the_held_revisor_invite_names_the_open_question(db_session, client, mailbox):
    user = _owner(db_session, verified=False, revisor=None)
    _open_question(db_session, user)
    r = client.post("/api/accountants/invite", json={"email": "chosen@example.com"}, headers=_hdr(user))
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["email_sent"] is False
    # The true state in held_reason; email_not_sent_reason / mail_held stay
    # "email_unverified" so app builds from before 9 Oct still read "held",
    # never "Invitation sendt" (release gate review, 9 Oct).
    assert body["held_reason"] == "claim_question_open"
    assert body["email_not_sent_reason"] == "email_unverified"
    assert body["mail_held"] == "email_unverified"
    assert _to(mailbox, "chosen@example.com") == []


def test_auth_me_says_whether_the_question_is_open(db_session, client):
    user = _owner(db_session, verified=False)
    assert client.get("/api/auth/me", headers=_hdr(user)).json()["claim_question_open"] is False
    ask = _open_question(db_session, user)
    me = client.get("/api/auth/me", headers=_hdr(user)).json()
    assert me["email_verified"] is True
    assert me["claim_question_open"] is True
    from app.services.claim_decision import decide
    decide(db_session, ask.page_ticket, "keep")
    db_session.commit()
    assert client.get("/api/auth/me", headers=_hdr(user)).json()["claim_question_open"] is False


# ── "Send spørgsmålet igen" ──────────────────────────────────────────────


def _age_mail_tickets(db, user, hours):
    for t in db.query(AccountClaimTicket).filter(AccountClaimTicket.user_id == user.id,
                                                 AccountClaimTicket.kind == "mail"):
        t.created_at = utc_now() - timedelta(hours=hours)
    db.commit()


def _remail(client, user):
    return client.post("/api/auth/claim-decision/remail", headers=_hdr(user))


def test_remail_inside_the_day_is_refused_with_when(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)          # the question mail ticket is fresh
    r = _remail(client, user)
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "claim_remail_cooldown"
    assert d["retry_after_hours"] >= 1
    assert "én gang i døgnet" in d["message_da"] and "once a day" in d["message"]
    assert mailbox.sent == []


def test_remail_after_a_day_sends_one_mail_to_the_own_inbox_and_no_ticket_to_the_session(
        db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)
    _age_mail_tickets(db_session, user, 25)
    r = _remail(client, user)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"ok": True, "sent_to": OWNER}
    # Nothing in the answer can answer the question.
    assert "ticket" not in r.text and "token" not in r.text
    sent = _to(mailbox, OWNER)
    assert len(sent) == 1
    assert "Nogen, der er logget ind på din BonBox-konto, har bedt os sende dette spørgsmål igen" in sent[0]["html"]
    assert "/login/claim?token=" in sent[0]["html"]
    assert [p for p in mailbox.sent if p["to"] != [OWNER]] == []
    # The mailed ticket is the one that answers (only the inbox has it).
    import re
    raw = re.search(r"/login/claim\?token=([A-Za-z0-9_\-]+)&", sent[0]["html"]).group(1)
    ok = client.post("/api/auth/claim-decision", json={"ticket": raw, "answer": "keep"})
    assert ok.status_code == 200, ok.text
    # And a second remail the same day is refused.
    assert _remail(client, user).status_code in (409, 429)


def test_a_failed_remail_does_not_use_up_the_day(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)
    _age_mail_tickets(db_session, user, 25)
    n_before = db_session.query(AccountClaimTicket).filter(AccountClaimTicket.user_id == user.id).count()
    mailbox.fail = True
    r = _remail(client, user)
    assert r.status_code == 503, r.text
    assert r.json()["detail"]["code"] == "claim_remail_failed"
    db_session.expire_all()
    assert db_session.query(AccountClaimTicket).filter(
        AccountClaimTicket.user_id == user.id).count() == n_before
    mailbox.fail = False
    assert _remail(client, user).status_code == 200


def test_remail_without_an_open_question_is_refused(db_session, client, mailbox):
    user = _owner(db_session, verified=True)
    r = _remail(client, user)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "claim_no_open_question"
    assert mailbox.sent == []


def test_remail_never_confirms_an_unconfirmed_address(db_session, client, mailbox):
    """A password session is no proof of the inbox: on an account with no
    question (never confirmed) nothing is opened, confirmed or mailed."""
    user = _owner(db_session, verified=False)
    r = _remail(client, user)
    assert r.status_code == 409, r.text
    db_session.refresh(user)
    assert user.email_verified is False
    assert db_session.query(AccountClaimTicket).count() == 0
    assert mailbox.sent == []


def test_the_remail_after_a_reset_keeps_the_reset_question(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    from app.services.claim_decision import ask_inbox_owner
    ask_inbox_owner(db_session, user, via="password_reset", page_ticket=False)
    db_session.commit()
    _age_mail_tickets(db_session, user, 25)
    assert _remail(client, user).status_code == 200
    html = _to(mailbox, OWNER)[0]["html"]
    assert "valgt den første adgangskode" in html
    assert "også den nye, du valgte med koden fra din e-mail" in html


# ═══ 3. After a reset, "Nej" ends the password just chosen too ════════════


def test_the_reset_question_mail_says_the_new_password_stops_working_too():
    from app.services.claim_decision import question_email_html
    _, da = question_email_html("da", date(2026, 10, 1), "k", "s", via="password_reset")
    _, en = question_email_html("en", date(2026, 10, 1), "k", "s", via="password_reset")
    assert "også den nye, du valgte med koden fra din e-mail" in da
    assert "including the new one you chose with the code from your e-mail" in en
    assert "den gamle adgangskode" not in da
    # A login-link question keeps its words (no reset happened there).
    _, ml = question_email_html("da", date(2026, 10, 1), "k", "s", via="magic_link")
    assert "den gamle adgangskode holder op" in ml


# ═══ 5. "Send a test now" joins the self-test ceiling ═════════════════════


def _brief_now(client, user):
    return client.post("/api/dashboard/daily-brief/send-now", headers=_hdr(user))


@pytest.fixture
def brief_sends(monkeypatch):
    calls = []

    def _fake(db, user, *, force=False):
        calls.append(user.email)
        return {"ok": True, "sent_at": None, "reason": None, "error": None}

    monkeypatch.setattr("app.routers.dashboard.send_brief_to_user", _fake)
    return calls


def test_send_now_has_no_confirmed_address_wall_only_the_ceiling(db_session, client, brief_sends):
    """Review (9 Oct): the recorded self-test policy is the shared ceiling
    only — like /email/test-digest, -alerts, -welcome — so an unconfirmed
    (or grandfathered) owner keeps the button, counted on that ceiling."""
    user = _owner(db_session, verified=False)
    r = _brief_now(client, user)
    assert r.status_code == 200, r.text
    assert brief_sends == [OWNER]
    assert _brief_now(client, user).status_code == 429
    assert brief_sends == [OWNER]


def test_send_now_once_then_a_cooldown_that_does_not_say_just_sent(db_session, client, brief_sends):
    user = _owner(db_session, verified=True)
    assert _brief_now(client, user).status_code == 200
    r = _brief_now(client, user)
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "self_test_mail_cooldown"
    assert "just sent" not in d["message"] and "lige sendt" not in d["message_da"]
    assert "Try again in" in d["message"] and "Prøv igen om" in d["message_da"]
    assert brief_sends == [OWNER]


def test_send_now_shares_the_counter_with_the_other_test_mails(db_session, client, brief_sends, monkeypatch):
    monkeypatch.setattr("app.routers.email_settings.send_email", lambda *a, **k: True)
    user = _owner(db_session, verified=True)
    assert client.post("/api/email/test-welcome", headers=_hdr(user)).status_code == 200
    r = _brief_now(client, user)
    assert r.status_code == 429, r.text
    assert brief_sends == []
    # …and the other way round.
    other = _make_user(db_session, plan="pro", email="b@testcafe.dk")
    assert _brief_now(client, other).status_code == 200
    assert client.post("/api/email/test-welcome", headers=_hdr(other)).status_code == 429


def test_send_now_daily_cap(db_session, client, brief_sends):
    from app.routers.email_settings import SELF_TEST_MAIL_ACTION, SELF_TEST_MAIL_DAILY_CAP
    from app.services import audit_service
    user = _owner(db_session, verified=True)
    for _ in range(SELF_TEST_MAIL_DAILY_CAP):
        audit_service.record(db_session, user, SELF_TEST_MAIL_ACTION, "user", entity_id=user.id)
    db_session.commit()
    for row in db_session.query(AuditLog).filter(AuditLog.action == SELF_TEST_MAIL_ACTION):
        row.created_at = utc_now() - timedelta(hours=2)
    db_session.commit()
    r = _brief_now(client, user)
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "self_test_mail_daily_cap"
    assert brief_sends == []


# ═══ 9. Held revisor copy AND a failed owner copy: both kept ══════════════


@pytest.mark.parametrize("question", [False, True])
def test_a_held_revisor_copy_with_a_failed_owner_copy_keeps_both(db_session, client, mailbox, question):
    user = _owner(db_session, verified=False)
    if question:
        _open_question(db_session, user)
    mailbox.fail = True
    r = _lock(client, user, d="2026-10-07")
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    reason = "claim_question_open" if question else "email_unverified"
    assert ritual["email_status"] == "send_failed"
    marker, _, owner_err = ritual["email_error"].partition(";")
    assert marker == f"revisor_{reason}"
    assert owner_err.startswith("send_error")
    listed = client.get("/api/daily-close", headers=_auth(user)).json()
    row = next(x for x in listed if x["id"] == r.json()["id"])
    assert row["email_error"] == ritual["email_error"]
    assert len(row["email_error"]) <= 64


# ═══ 11. The SQLite mirror carries timereg_period_json ════════════════════


def test_the_sqlite_mirror_adds_timereg_period_json(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, text
    from app import main
    from app.database import Base
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE business_profiles DROP COLUMN timereg_period_json"))
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info('business_profiles')"))}
        assert "timereg_period_json" not in cols
    monkeypatch.setattr(main, "engine", engine)
    main._run_migrations()
    with engine.connect() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info('business_profiles')"))}
    assert "timereg_period_json" in cols
    engine.dispose()
