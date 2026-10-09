"""R-b — a text fix left from R-a (releases.md, 9 Oct): the MOMS-angivelse
send's failures carry a Danish twin (message_da) that is true for the
failure — "not set up here, nothing was sent" when nothing was attempted
(503), "most likely did not reach your revisor — and no copy" when the mail
service answered with an error (502), "nothing was sent" when the PDF could
not be built (500). The English stays as it was.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

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

MOMS = "/api/tax/filing-pdf/send-to-accountant?period_start=2026-10-01&period_end=2026-10-07"


@pytest.fixture(autouse=True)
def _fresh_auth_limiters():
    from app.routers import auth_magic_link as _ml
    _ml.limiter.reset()
    yield
    _ml.limiter.reset()


def _hdr(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"}


# ═══ MOMS send failure: Danish, and true for the failure ═════════════


def test_moms_provider_failure_has_a_true_danish_twin(db_session, client):
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(False, "send_error: resend down")):
        r = client.post(MOMS, json={"cc_self": True}, headers=_auth(user))
    assert r.status_code == 502, r.text
    d = r.json()["detail"]
    assert d["code"] == "email_send_failed"
    # The English is unchanged (older app builds show it as it is).
    assert d["message"].startswith("Couldn't send email right now.")
    da = d["message_da"]
    assert "momsangivelsen" in da and "sandsynligvis" in da
    assert "ingen kopi" in da  # the owner's copy only follows a revisor send that went
    assert "Hent PDF'en" in da
    assert "Couldn't" not in da


def test_moms_nothing_attempted_says_nothing_was_sent_in_danish(db_session, client):
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(False, "email_not_configured")):
        r = client.post(MOMS, json={"cc_self": True}, headers=_auth(user))
    assert r.status_code == 503, r.text
    d = r.json()["detail"]
    assert d["reason"] == "email_not_configured"
    assert "intet blev sendt" in d["message_da"]
    assert "sandsynligvis" not in d["message_da"]  # nothing was attempted


def test_moms_pdf_build_failure_has_a_danish_twin_and_mails_nothing(db_session, client, mailbox):
    user = _owner(db_session, verified=True)
    _row(db_session, user, date(2026, 10, 2), 1000.0)
    with patch("app.routers.tax.build_moms_filing_pdf", side_effect=RuntimeError("boom")):
        r = client.post(MOMS, json={"cc_self": True}, headers=_auth(user))
    assert r.status_code == 500, r.text
    d = r.json()["detail"]
    assert d["code"] == "pdf_generation_failed"
    assert "intet blev sendt" in d["message_da"]
    assert "nothing was sent" in d["message"]
    assert mailbox.sent == []
