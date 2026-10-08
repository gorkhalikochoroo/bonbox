"""While "did you create this account yourself?" waits for an answer, the
account is not a confirmed sender (review, 9 Oct).

A login link (or the legacy Apple sign-in, or a reset code) on a never-
confirmed account confirms the address and ASKS the inbox owner
(services/claim_decision.py). Until they answer, whoever set the password
still holds their sessions — so a confirmed address alone must not let that
session make BonBox mail a third party: no team invitation (a team login
would outlive "secure"), no faktura, no mail to a revisor (lock mail, period
bundle, MOMS, lønningsliste), no supplier order. Answering opens it again.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest

from app.models.audit_log import AuditLog
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import create_access_token
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _lock,
    client,
    db_session,
    mailbox,
)
from tests.test_revisor_mail_confirmed_sender import (  # noqa: F401 — fixtures
    _SENDS,
    OWNER,
    _hours,
    _owner,
)
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    PIA,
    _fresh_route_limiters,
    _row,
    _to,
)


@pytest.fixture(autouse=True)
def _fresh_team_and_invoice_limiters():
    from app.routers import invoices as _inv, team as _team
    lims = [l for l in (getattr(_inv, "limiter", None), _team.limiter) if l is not None]
    for lim in lims:
        lim.reset()
    yield
    for lim in lims:
        lim.reset()


def _open_question(db, user):
    """What a login link does to a never-confirmed account: the address is
    confirmed and the question opens (nothing else changes). Returns the
    page ticket that answers it."""
    from app.services.claim_decision import ask_inbox_owner
    ask = ask_inbox_owner(db, user, via="magic_link")
    db.commit()
    db.refresh(user)
    assert user.email_verified is True
    return ask.page_ticket


def _squatter_session(user):
    """The session of whoever set the password, minted before the link."""
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


def _assert_claim_refusal(r):
    assert r.status_code == 403, r.text
    d = r.json()["detail"]
    # The code every app build already handles (nothing sent, own mail offered) …
    assert d["code"] == "email_unverified"
    # … and words that are true: the address IS confirmed, an answer is missing.
    assert d["reason"] == "claim_question_open"
    assert "Har du selv oprettet denne konto?" in d["message_da"]
    assert "did you create this account yourself?" in d["message"]
    # Never "confirm your e-mail" — the address is confirmed, and the text
    # says so (release gate, 9 Oct: "Din e-mailadresse er bekræftet, men …").
    assert "Din e-mailadresse er bekræftet" in d["message_da"]
    assert "bekræft først" not in d["message_da"].lower()
    assert "bekræft din e-mail" not in d["message_da"].lower()
    assert "Profil → Ikke bekræftet" not in d["message_da"]


def _invoice(db, owner):
    from app.models.customer import Customer
    from app.models.invoice import Invoice
    c = Customer(user_id=owner.id, name="Hansen ApS", email="kunde@example.dk")
    db.add(c); db.flush()
    inv = Invoice(user_id=owner.id, customer_id=c.id, fakturanummer=7,
                  issue_date=date(2026, 10, 1), due_date=date(2026, 10, 15),
                  status="sent", total_gross=Decimal("1250.00"), currency="DKK",
                  customer_lang="da")
    db.add(inv); db.commit(); db.refresh(inv)
    return inv


def test_the_password_setters_session_cannot_invite_a_team_login(db_session, client):
    user = _owner(db_session, verified=False)
    hdr = _squatter_session(user)
    _open_question(db_session, user)
    with patch("app.services.email_service.send_email", return_value=True) as sender:
        r = client.post("/api/team/invite", json={"email": "accomplice@example.com",
                                                  "role": "manager"}, headers=hdr)
    _assert_claim_refusal(r)
    assert sender.call_count == 0
    # No team login was created for an address of their choosing.
    assert db_session.query(User).filter(User.email == "accomplice@example.com").count() == 0


def test_the_password_setters_session_cannot_mail_a_faktura(db_session, client):
    user = _owner(db_session, verified=False)
    hdr = _squatter_session(user)
    _open_question(db_session, user)
    inv = _invoice(db_session, user)
    with patch("app.routers.invoices.send_email_with_attachment",
               return_value=(True, None)) as sender, \
         patch("app.routers.invoices.render_invoice_pdf", lambda db, inv: b"%PDF-1.4 stub"):
        r = client.post(f"/api/invoices/{inv.id}/send-email", json={"cc_self": False}, headers=hdr)
    _assert_claim_refusal(r)
    assert sender.call_count == 0


@pytest.mark.parametrize("which", sorted(_SENDS))
def test_the_password_setters_session_cannot_mail_the_revisor(db_session, client, which):
    url, body, action = _SENDS[which]
    user = _owner(db_session, verified=False)
    hdr = _squatter_session(user)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    _hours(db_session, user)
    _open_question(db_session, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender, \
         patch("app.services.email_service.send_email", return_value=True) as plain:
        r = client.post(url, json=body, headers=hdr)
    _assert_claim_refusal(r)
    assert sender.call_count == 0 and plain.call_count == 0
    assert db_session.query(AuditLog).filter(AuditLog.action == action).count() == 0


def test_the_lock_mail_holds_the_revisor_copy_while_the_question_is_open(
        db_session, client, mailbox):
    user = _owner(db_session, verified=False)
    _open_question(db_session, user)
    r = _lock(client, user, d="2026-10-07")
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    # The true reason, not "email_unverified" (release gate, 9 Oct).
    assert ritual["accountant_skip_reason"] == "claim_question_open"
    assert ritual["accountant_included"] is False
    assert ritual["sent_to"] == [OWNER]          # the lock and the owner's copy still happen
    assert _to(mailbox, PIA) == []
    # The owner's copy says why in true words: the address IS confirmed.
    own = _to(mailbox, OWNER)
    assert len(own) == 1
    assert ("BonBox venter på dit svar på spørgsmålet, vi har mailet dig: "
            "Har du selv oprettet denne konto?") in own[0]["html"]
    assert "bekræft din e-mail først" not in own[0]["html"]


def test_the_revisor_invite_is_held_while_the_question_is_open(db_session, client, mailbox):
    user = _owner(db_session, verified=False, revisor=None)
    hdr = _squatter_session(user)
    _open_question(db_session, user)
    r = client.post("/api/accountants/invite",
                    json={"email": "chosen-revisor@example.com"}, headers=hdr)
    assert r.status_code in (200, 201), r.text
    assert r.json().get("email_sent") is False
    # The true reason, not "email_unverified" (release gate, 9 Oct).
    assert r.json().get("email_not_sent_reason") == "claim_question_open"
    assert _to(mailbox, "chosen-revisor@example.com") == []


def test_the_guest_mail_ceiling_stays_the_unconfirmed_one(db_session):
    from app.services.reservation_emails import (
        GUEST_EMAILS_PER_OWNER_PER_DAY, GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED,
        guest_email_owner_cap,
    )
    user = _owner(db_session, verified=False)
    ticket = _open_question(db_session, user)
    assert guest_email_owner_cap(db_session, user.id) == GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED
    from app.services.claim_decision import decide
    decide(db_session, ticket, "keep")
    db_session.commit()
    assert guest_email_owner_cap(db_session, user.id) == GUEST_EMAILS_PER_OWNER_PER_DAY


@pytest.mark.parametrize("answer", ["keep", "secure"])
def test_answering_opens_sending_again_for_the_inbox_owner(db_session, client, answer):
    """Ja: the same account sends. Nej / Ved ikke: the old sessions are gone,
    and the inbox owner's new one sends."""
    url, body, action = _SENDS["period"]
    user = _owner(db_session, verified=False)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    ticket = _open_question(db_session, user)
    from app.services.claim_decision import decide
    decide(db_session, ticket, answer)
    db_session.commit()
    db_session.refresh(user)
    hdr = {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post(url, json=body, headers=hdr)
    assert r.status_code == 200, r.text
    assert sender.call_args_list[0].args[0] == PIA


def test_a_confirmed_account_without_a_question_is_unchanged(db_session):
    from app.services.revisor_mail import require_verified_sender, sender_is_verified
    user = _owner(db_session, verified=True)
    assert sender_is_verified(user) is True
    require_verified_sender(user)       # no raise


def test_an_unconfirmed_account_keeps_its_own_words(db_session):
    """The plain unconfirmed refusal is untouched (a surface's own message)."""
    from fastapi import HTTPException
    from app.services.revisor_mail import require_verified_sender
    user = _owner(db_session, verified=False)
    with pytest.raises(HTTPException) as e:
        require_verified_sender(user, message="own en", message_da="own da")
    assert e.value.detail == {"code": "email_unverified", "message": "own en", "message_da": "own da"}


def test_a_detached_account_row_is_not_a_confirmed_sender(db_session):
    """When BonBox cannot look, it does not mail a third party."""
    from app.services.revisor_mail import sender_is_verified
    user = _owner(db_session, verified=True)
    db_session.expunge(user)
    assert sender_is_verified(user) is False
