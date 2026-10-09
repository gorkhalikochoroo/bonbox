"""Mail to the revisor needs a confirmed owner e-mail — on every path, not
only the invite (Manoj, 8 Oct: "every mail BonBox sends to a revisor requires
a confirmed owner e-mail").

* The lock mail: the day locks, the owner's own copy goes and says "Ikke sendt
  til revisoren — bekræft din e-mail først", the revisor gets nothing, and
  History still says so after a reload (email_error revisor_email_unverified).
* "Send igen", the period bundle, the MOMS-angivelse and the lønningsliste
  answer 403 email_unverified BEFORE anything is mailed: no revisor mail and
  no "Kopi:" of a mail that never went. Confirming opens them again.
* A confirmed owner: exactly as before.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_user,
    client,
    db_session,
    mailbox,
)
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    PIA,
    _fresh_route_limiters,
    _row,
    _to,
)

OWNER = "owner@testcafe.dk"
HELD_DA = "Ikke sendt til revisoren"
HELD_EN = "Not sent to your revisor"


def _owner(db, *, verified: bool, plan: str = "pro", revisor: str | None = PIA):
    user = _make_user(db, plan=plan, email=OWNER)
    user.email_verified = verified
    db.add(BusinessProfile(
        user_id=user.id, company_name="Testcafé ApS", org_number="12345678",
        country="DK", accountant_email=revisor,
        accountant_name="Pia Jensen" if revisor else None,
        accountant_auto_send=True if revisor else None,
    ))
    db.commit(); db.refresh(user)
    return user


def _hours(db, user) -> None:
    """One staffer with a logged day in the period — the lønningsliste needs
    hours to render (the other sends ignore it)."""
    import uuid
    from app.models.staff import HoursLogged, StaffMember
    m = StaffMember(id=uuid.uuid4(), user_id=user.id, name="Agnes", role="server",
                    active=True, is_deleted=False, base_rate=185.0)
    db.add(m); db.commit()
    db.add(HoursLogged(id=uuid.uuid4(), user_id=user.id, staff_id=m.id,
                       date=date(2026, 10, 2), start_time="09:00", end_time="17:00",
                       break_minutes=0, total_hours=8.0, rate_applied=185.0,
                       earned=1480.0, entry_method="quick"))
    db.commit()


def _actions(db, action: str) -> int:
    return db.query(AuditLog).filter(AuditLog.action == action).count()


# ═══ The lock mail ═══════════════════════════════════════════════════════


def test_unconfirmed_lock_still_locks_and_mails_the_owner_but_not_the_revisor(
        db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    r = _lock(client, user, d="2026-10-07")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed"
    ritual = body["close_ritual"]
    assert ritual["accountant_skip_reason"] == "email_unverified"
    assert ritual["accountant_included"] is False
    assert ritual["email_status"] == "sent"
    assert ritual["sent_to"] == [OWNER]
    assert ritual["email_error"] == "revisor_email_unverified"

    # The revisor got nothing; the owner's own copy went and says why.
    assert _to(mailbox, PIA) == []
    own = _to(mailbox, OWNER)
    assert len(own) == 1
    assert HELD_DA in own[0]["html"] and "bekræft din e-mail først" in own[0]["html"]
    assert _actions(db_session, "daily_close.revisor_lock_mail") == 0

    # History after a reload: the reason survives (not "sent to you only").
    listed = client.get("/api/daily-close", headers=_auth(user)).json()
    row = next(x for x in listed if x["id"] == body["id"])
    assert row["email_status"] == "sent"
    assert row["email_error"] == "revisor_email_unverified"


def test_confirmed_lock_mail_is_unchanged(db_session, client, mailbox):
    user = _owner(db_session, verified=True)
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] is None
    assert ritual["accountant_included"] is True
    assert ritual["email_error"] is None
    assert len(_to(mailbox, PIA)) == 1
    own = _to(mailbox, OWNER)
    assert len(own) == 1 and HELD_DA not in own[0]["html"]
    assert _actions(db_session, "daily_close.revisor_lock_mail") == 1


def test_the_owner_copy_says_it_in_english_for_a_non_dkk_account(db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    user.currency = "EUR"
    db_session.commit()
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "email_unverified"
    own = _to(mailbox, OWNER)
    assert len(own) == 1 and HELD_EN in own[0]["html"]
    assert _to(mailbox, PIA) == []


def test_auto_send_off_keeps_its_own_reason_for_an_unconfirmed_owner(db_session, client, mailbox):
    """The reason that confirming would not change is named first."""
    user = _owner(db_session, verified=False)
    prof = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    prof.accountant_auto_send = False
    db_session.commit()
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "auto_send_off"
    assert _to(mailbox, PIA) == []


# ═══ "Send igen" ═════════════════════════════════════════════════════════


def test_unconfirmed_resend_to_the_revisor_is_refused_before_anything_is_mailed(
        db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    cid = _lock(client, user, d="2026-10-07").json()["id"]
    n = len(mailbox.sent)

    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-unverified-1", "force": True}, headers=_auth(user))
    assert r.status_code == 403, r.text
    d = r.json()["detail"]
    assert d["code"] == "email_unverified"
    assert d["message_da"].startswith(HELD_DA) and "bekræft din e-mail først" in d["message_da"]
    assert d["message"].startswith(HELD_EN)
    assert len(mailbox.sent) == n            # no revisor mail, no second owner copy
    assert _actions(db_session, "daily_close.resend_email") == 0
    db_session.expire_all()
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == user.id).first()
    assert dc.email_status == "sent" and dc.email_error == "revisor_email_unverified"

    # Confirming opens the path: the next "Send igen" reaches the revisor once.
    user.email_verified = True
    db_session.commit()
    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-confirmed-1"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert PIA in r.json()["email_sent_to"]
    assert len(_to(mailbox, PIA)) == 1


def test_owner_only_resend_still_works_for_an_unconfirmed_owner(db_session, client, mailbox):
    """No revisor saved: "Send igen" re-sends the owner's own copy — that is
    not mail to a revisor, and it stays as it was."""
    user = _owner(db_session, verified=False, revisor=None)
    cid = _lock(client, user, d="2026-10-07").json()["id"]
    assert len(_to(mailbox, OWNER)) == 1
    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-owner-1", "force": True}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert len(_to(mailbox, OWNER)) == 2


# ═══ Period bundle, MOMS-angivelse, lønningsliste ════════════════════════

_SENDS = {
    "period": ("/api/daily-close/send-to-accountant?from=2026-10-01&to=2026-10-07",
               {"fmt": "pdf", "cc_self": True}, "daily_close.send_to_accountant"),
    "moms": ("/api/tax/filing-pdf/send-to-accountant?period_start=2026-10-01&period_end=2026-10-07",
             {"cc_self": True}, "tax.filing_sent_to_accountant"),
    "payroll": ("/api/staff/payroll/send-to-accountant",
                {"period_start": "2026-10-01", "period_end": "2026-10-07", "cc_self": True},
                "payroll.send_to_accountant"),
}


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_unconfirmed_explicit_send_answers_403_and_mails_no_one(db_session, client, which):
    url, body, action = _SENDS[which]
    user = _owner(db_session, verified=False)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender, \
         patch("app.services.email_service.send_email", return_value=True) as plain:
        r = client.post(url, json=body, headers=_auth(user))
    assert r.status_code == 403, (which, r.text)
    d = r.json()["detail"]
    assert d["code"] == "email_unverified"
    assert d["message_da"].startswith(HELD_DA)
    assert d["message"].startswith(HELD_EN)
    # Nothing left: not the revisor's mail, not a "Kopi:" to the owner.
    assert sender.call_count == 0 and plain.call_count == 0
    assert _actions(db_session, action) == 0


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_confirmed_explicit_send_is_unchanged(db_session, client, which):
    url, body, action = _SENDS[which]
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post(url, json=body, headers=_auth(user))
    assert r.status_code == 200, (which, r.text)
    assert r.json()["sent_to"] == PIA
    # The revisor's message first, then the owner's separate copy.
    assert sender.call_args_list[0].args[0] == PIA
    assert sender.call_args_list[1].args[0] == OWNER
    assert _actions(db_session, action) == 1


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_a_wall_confirming_would_not_fix_is_named_first(db_session, client, which):
    """No revisor saved: "save one on Profile" (400), not a detour through
    confirming the e-mail first."""
    url, body, _action = _SENDS[which]
    user = _owner(db_session, verified=False, revisor=None)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post(url, json=body, headers=_auth(user))
    assert r.status_code == 400, (which, r.text)
    assert r.json()["detail"]["code"] == "no_accountant_email"
    assert sender.call_count == 0


# ═══ The general refusal names mail to the revisor too ═══════════════════


def test_the_general_refusal_names_what_waits_including_the_revisor():
    """sendNeedsVerifiedEmail's server twin: specific, never a general claim
    (guest, shift and gavekort mail still go out for an unconfirmed account)."""
    from app.services import revisor_mail
    en = revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_EN
    da = revisor_mail.VERIFY_EMAIL_FIRST_MESSAGE_DA
    for w in ("fakturaer", "team invitations", "supplier orders", "mail to your revisor"):
        assert w in en, w
    for w in ("fakturaer", "medarbejderinvitationer", "leverandørordrer", "mail til din revisor"):
        assert w in da, w
    for text in (en, da):
        low = text.lower()
        assert "mail to others" not in low and "mail til andre" not in low
        assert "no one" not in low and "ingen andre" not in low
