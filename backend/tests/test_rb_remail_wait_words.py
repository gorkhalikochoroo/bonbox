"""R-b — a text fix left from R-a (releases.md, 9 Oct): "Send spørgsmålet
igen" inside the day never says (or implies) that a mail arrived — the
question mail made at a sign-in can have failed to send, and nothing records
that it left. The wait names a TRY and what to do if nothing came (a login
link answers at once).

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

import pytest

from app.models.account_claim_ticket import AccountClaimTicket
from app.services.auth import create_access_token
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _make_user,
    client,
    db_session,
    mailbox,
)
from tests.test_revisor_mail_confirmed_sender import OWNER, _owner  # noqa: F401
from tests.test_revisor_r6_demo_identity import (  # noqa: F401 — fixtures
    PIA,
    _fresh_route_limiters,
    _row,
    _to,
)


@pytest.fixture(autouse=True)
def _fresh_auth_limiters():
    from app.routers import auth_magic_link as _ml
    _ml.limiter.reset()
    yield
    _ml.limiter.reset()


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


# ═══ The remail wait never implies a mail arrived ════════════════════


def test_the_wait_after_a_failed_question_mail_never_says_a_mail_went(db_session, client, mailbox):
    from app.services.claim_decision import ask_inbox_owner, send_question_mail
    user = _owner(db_session, verified=False)
    # A login link lands on the never-confirmed account; its question mail
    # fails to send (the provider is down) — the ticket stays, nothing left.
    ask = ask_inbox_owner(db_session, user, via="magic_link")
    db_session.commit()
    db_session.refresh(user)
    mailbox.fail = True
    assert send_question_mail(user, ask) is False
    mailbox.fail = False
    assert mailbox.sent == []
    assert db_session.query(AccountClaimTicket).filter(
        AccountClaimTicket.user_id == user.id, AccountClaimTicket.kind == "mail").count() == 1

    r = client.post("/api/auth/claim-decision/remail", headers=_hdr(user))
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "claim_remail_cooldown" and d["retry_after_hours"] >= 1
    for text in (d["message"], d["message_da"]):
        low = text.lower()
        for claim in ("we sent", "we e-mailed", "was sent", "check your inbox",
                      "vi har sendt", "vi har mailet", "er sendt", "tjek din indbakke"):
            assert claim not in low, (claim, text)
    # It names a TRY, what to do if nothing came, and when to ask again.
    assert "last try" in d["message"] and "If no e-mail reached you" in d["message"]
    assert "seneste forsøg" in d["message_da"] and "Er der ikke kommet nogen mail" in d["message_da"]
    assert "login-link" in d["message_da"] and "login link" in d["message"]
    assert f"{d['retry_after_hours']} time" in d["message_da"]
    assert mailbox.sent == []
