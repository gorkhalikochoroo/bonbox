"""Release gate R-a (9 Oct) — the review of the release-gate fixes.

a. MOMS-angivelse and lønningsliste: a send that ASKED Resend and failed
   answers 502, never 503 — the app's interceptor replays a POST 503 ("not
   processed") up to four times, so one tap could mail the revisor five
   times (also older app builds, which lack the client-side _noRetry). 503
   stays for "nothing attempted" (mail not configured), as daily_close does.
b. "Send spørgsmålet igen" (and every later ask) after a password reset keeps
   the reset question: a reset anywhere in the OPEN question counts, not only
   on the newest ticket — a login-link page ticket made after the reset must
   not drop "også den nye, du valgte med koden fra din e-mail".
c. The revisor invite held for the sender keeps email_not_sent_reason /
   mail_held "email_unverified" (the only "held" value older app builds
   know) and names the true state in held_reason.
d. "Send a test now" (Daily Brief) has no confirmed-address wall — the
   recorded self-test policy is the shared ceiling only, like the three test
   mails — and a send that cannot go at all never uses up that ceiling.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from unittest.mock import patch

import pytest

from app.models.account_claim_ticket import AccountClaimTicket
from app.models.audit_log import AuditLog
from app.services.auth import create_access_token
from app.utils.time import utc_now
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _make_user,
    client,
    db_session,
    mailbox,
)
from tests.test_revisor_mail_confirmed_sender import OWNER, _hours, _owner  # noqa: F401
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    PIA,
    _fresh_route_limiters,
    _row,
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


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


# ═══ a. A send Resend was asked for and failed: 502, never a replayable 503 ══

_SENDS = {
    "period": ("/api/daily-close/send-to-accountant?from=2026-10-01&to=2026-10-07",
               {"fmt": "pdf", "cc_self": True}),
    "moms": ("/api/tax/filing-pdf/send-to-accountant?period_start=2026-10-01&period_end=2026-10-07",
             {"cc_self": True}),
    "payroll": ("/api/staff/payroll/send-to-accountant",
                {"period_start": "2026-10-01", "period_end": "2026-10-07", "cc_self": True}),
}


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_a_failed_provider_send_is_502_not_a_replayable_503(db_session, client, which):
    url, body = _SENDS[which]
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(False, "send_error: resend down")) as sender:
        r = client.post(url, json=body, headers=_auth(user))
    assert r.status_code == 502, (which, r.text)
    assert r.json()["detail"]["code"] == "email_send_failed"
    # Resend WAS asked — which is why a replay is not safe.
    assert sender.call_count >= 1


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_nothing_attempted_stays_503(db_session, client, which):
    url, body = _SENDS[which]
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(False, "email_not_configured")):
        r = client.post(url, json=body, headers=_auth(user))
    assert r.status_code == 503, (which, r.text)
    assert r.json()["detail"]["code"] == "email_send_failed"


# ═══ b. The reset stays part of the question ═════════════════════════════


def _age_mail_tickets(db, user, hours):
    for t in db.query(AccountClaimTicket).filter(AccountClaimTicket.user_id == user.id,
                                                 AccountClaimTicket.kind == "mail"):
        t.created_at = utc_now() - timedelta(hours=hours)
    db.commit()


def _reset_then_login_link(db, user):
    """The question opens by a password reset (one mail ticket, no page
    ticket); the owner later signs in with a login link (a page ticket,
    via=magic_link, NEWER than the reset's ticket)."""
    from app.services.claim_decision import ask_inbox_owner
    ask_inbox_owner(db, user, via="password_reset", page_ticket=False)
    db.commit()
    _age_mail_tickets(db, user, 25)
    ask = ask_inbox_owner(db, user, via="magic_link")
    db.commit()
    db.refresh(user)
    return ask


def test_remail_after_reset_then_login_link_keeps_the_reset_question(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _reset_then_login_link(db_session, user)
    mailbox.sent.clear()                       # the login link's own re-ask mail
    _age_mail_tickets(db_session, user, 25)
    r = client.post("/api/auth/claim-decision/remail", headers=_hdr(user))
    assert r.status_code == 200, r.text
    html = _to(mailbox, OWNER)[0]["html"]
    assert "også den nye, du valgte med koden fra din e-mail" in html
    assert "valgt den første adgangskode" in html
    assert "den gamle adgangskode holder op" not in html
    # …and the page the mailed link opens says the same.
    raw = re.search(r"/login/claim\?token=([A-Za-z0-9_\-]+)&", html).group(1)
    st = client.post("/api/auth/claim-decision/status", json={"ticket": raw})
    assert st.status_code == 200, st.text
    assert st.json()["question"]["after_reset"] is True


def test_the_login_link_page_ticket_after_a_reset_asks_the_reset_question(db_session):
    from app.services.claim_decision import ticket_status
    user = _owner(db_session, verified=False)
    ask = _reset_then_login_link(db_session, user)
    assert ask.page_ticket
    assert ticket_status(db_session, ask.page_ticket)["question"]["after_reset"] is True


def test_the_login_link_re_ask_mail_after_a_reset_names_the_reset(db_session, mailbox):
    """The login link a day after the reset mails the question again: the
    intro says what just happened (a login link), the question and "Nej"
    name the reset."""
    from app.services.claim_decision import send_question_mail
    user = _owner(db_session, verified=False)
    ask = _reset_then_login_link(db_session, user)
    assert ask.mail_ticket and ask.after_reset is True
    mailbox.sent.clear()
    assert send_question_mail(user, ask) is True
    html = _to(mailbox, OWNER)[0]["html"]
    assert "med et login-link fra din e-mail" in html
    assert "også den nye, du valgte med koden fra din e-mail" in html


def test_a_login_link_question_without_a_reset_keeps_its_words(db_session, client, mailbox):
    from app.services.claim_decision import ask_inbox_owner
    user = _owner(db_session, verified=False)
    ask_inbox_owner(db_session, user, via="magic_link")
    db_session.commit()
    _age_mail_tickets(db_session, user, 25)
    mailbox.sent.clear()
    assert client.post("/api/auth/claim-decision/remail", headers=_hdr(user)).status_code == 200
    html = _to(mailbox, OWNER)[0]["html"]
    assert "den gamle adgangskode holder op" in html
    assert "også den nye" not in html


def test_an_answered_reset_question_does_not_colour_a_later_one(db_session):
    """Only the OPEN question counts: a reset whose question was answered is
    not carried into a new question."""
    from app.services.claim_decision import ask_inbox_owner, decide, reset_in_open_question
    user = _owner(db_session, verified=False)
    ask = ask_inbox_owner(db_session, user, via="password_reset", page_ticket=False)
    db_session.commit()
    decide(db_session, ask.mail_ticket, "keep")
    db_session.commit()
    assert reset_in_open_question(db_session, user.id) is False


# ═══ c. The held invite: compatible reason, true held_reason ═════════════


def test_the_unconfirmed_owners_held_invite_says_email_unverified_in_both(db_session, client, mailbox):
    user = _owner(db_session, verified=False, revisor=None)
    r = client.post("/api/accountants/invite", json={"email": "chosen@example.com"}, headers=_hdr(user))
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["email_sent"] is False
    assert body["email_not_sent_reason"] == "email_unverified"
    assert body["held_reason"] == "email_unverified"
    assert body["mail_held"] == "email_unverified"


def test_a_sent_invite_has_no_held_reason(db_session, client, mailbox):
    user = _owner(db_session, verified=True, revisor=None)
    r = client.post("/api/accountants/invite", json={"email": "chosen@example.com"}, headers=_hdr(user))
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["email_sent"] is True
    assert body["email_not_sent_reason"] is None
    assert body["held_reason"] is None


# ═══ d. "Send a test now": the ceiling only, and only for a real send ════


@pytest.fixture
def brief_sends(monkeypatch):
    calls = []

    def _fake(db, user, *, force=False):
        calls.append(user.email)
        return {"ok": True, "sent_at": None, "reason": None, "error": None}

    monkeypatch.setattr("app.routers.dashboard.send_brief_to_user", _fake)
    return calls


def _self_tests(db, user):
    from app.routers.email_settings import SELF_TEST_MAIL_ACTION
    return db.query(AuditLog).filter(AuditLog.user_id == user.id,
                                     AuditLog.action == SELF_TEST_MAIL_ACTION).count()


def _brief_now(client, user):
    return client.post("/api/dashboard/daily-brief/send-now", headers=_hdr(user))


def test_an_unconfirmed_owner_keeps_send_now_on_the_shared_ceiling(db_session, client, brief_sends):
    user = _owner(db_session, verified=False)
    r = _brief_now(client, user)
    assert r.status_code == 200, r.text
    assert brief_sends == [OWNER]
    assert _self_tests(db_session, user) == 1
    again = _brief_now(client, user)
    assert again.status_code == 429, again.text
    assert again.json()["detail"]["code"] == "self_test_mail_cooldown"
    assert brief_sends == [OWNER]


def test_a_send_that_cannot_go_never_uses_up_the_ceiling(db_session, client, brief_sends):
    user = _owner(db_session, verified=True)
    user.daily_brief_email_enabled = False
    db_session.commit()
    for _ in range(3):
        r = _brief_now(client, user)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": False, "sent_at": None, "reason": "user_opted_out", "error": None}
    assert brief_sends == []
    assert _self_tests(db_session, user) == 0
    # Turned back on: the first real send goes at once.
    user.daily_brief_email_enabled = True
    db_session.commit()
    assert _brief_now(client, user).status_code == 200
    assert brief_sends == [OWNER]
    assert _self_tests(db_session, user) == 1


def test_brief_send_blocker_mirrors_send_brief_to_user(db_session):
    from app.services.daily_brief_email import brief_send_blocker, send_brief_to_user
    user = _owner(db_session, verified=True)
    assert brief_send_blocker(user) is None
    user.daily_brief_email_enabled = False
    assert brief_send_blocker(user) == "user_opted_out"
    assert send_brief_to_user(db_session, user, force=True)["reason"] == "user_opted_out"
    user.daily_brief_email_enabled = True
    user.email = "not-an-address"
    assert brief_send_blocker(user) == "invalid_email"
    free = _make_user(db_session, plan="free", email="free@testcafe.dk")
    from app.services.billing import has_feature
    if not has_feature(free, "daily_brief_email"):
        assert brief_send_blocker(free) == "feature_not_entitled"
