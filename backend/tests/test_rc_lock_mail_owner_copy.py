"""Release R-c — the lock mail's failure names whose copy failed.

The release gate (9 Oct, R-b final pass): an owner with a revisor saved but
automatic sending to the revisor OFF locked a close; only the owner's own copy
was tried, and it failed (no mail key). The card and History said "Ikke sendt
til revisor — mailafsendelse er ikke sat op på serveren" — but the revisor was
never a recipient. The lock answers accountant_skip_reason (the card reads it);
History reads the close's email_error after a reload, so the left-out reason
is kept there beside the copy's error: "revisor_<reason>;<error>" (the held
reasons' form). A send that included the revisor is unchanged.

Every send is stubbed — nothing leaves the process.
"""
from __future__ import annotations

from app.models.business_profile import BusinessProfile
from app.routers.daily_close import _REVISOR_LEFT_OUT, _mark_revisor_left_out
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_profile,
    _make_user,
    client,
    db_session,
    mailbox,
)

REVISOR = "anna@revisor.dk"


def _owner(db, *, auto_send: bool):
    user = _make_user(db, plan="pro")
    _make_profile(db, user, accountant_auto_send=auto_send)
    return user


def _listed(client, user, cid):
    return next(x for x in client.get("/api/daily-close", headers=_auth(user)).json() if x["id"] == cid)


def _revisor_mails(mailbox):
    return [m for m in mailbox.sent if REVISOR in (m.get("to") or [])]


def test_auto_send_off_and_no_mail_key_keeps_the_left_out_reason(db_session, client, mailbox, monkeypatch):
    monkeypatch.setattr("app.services.email_service.resend.api_key", None)
    user = _owner(db_session, auto_send=False)
    r = _lock(client, user, d="2026-10-07")
    assert r.status_code == 200, r.text
    ritual = r.json()["close_ritual"]
    assert ritual["accountant_skip_reason"] == "auto_send_off"
    assert ritual["accountant_included"] is False
    assert ritual["email_status"] == "failed_skipped"
    assert ritual["email_error"] == "revisor_auto_send_off;email_not_configured"
    assert _revisor_mails(mailbox) == []
    # History after a reload: the same two facts.
    row = _listed(client, user, r.json()["id"])
    assert row["email_status"] == "failed_skipped"
    assert row["email_error"] == "revisor_auto_send_off;email_not_configured"


def test_auto_send_off_and_a_provider_failure_is_kept_within_the_column(db_session, client, mailbox):
    mailbox.fail = True
    user = _owner(db_session, auto_send=False)
    r = _lock(client, user, d="2026-10-07")
    ritual = r.json()["close_ritual"]
    assert ritual["email_status"] == "send_failed"
    err = ritual["email_error"]
    assert err.startswith("revisor_auto_send_off;send_error")
    assert len(err) <= 64
    assert _listed(client, user, r.json()["id"])["email_error"] == err


def test_a_failed_pdf_with_auto_send_off_keeps_the_reason_too(db_session, client, mailbox, monkeypatch):
    def _boom(*a, **kw):
        raise RuntimeError("reportlab exploded")
    monkeypatch.setattr("app.routers.daily_close._close_attachment", _boom)
    user = _owner(db_session, auto_send=False)
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["email_status"] == "failed_skipped"
    assert ritual["email_error"] == "revisor_auto_send_off;pdf_build_failed"
    assert mailbox.sent == []


def test_a_send_that_included_the_revisor_is_unchanged(db_session, client, mailbox, monkeypatch):
    """The revisor WAS a recipient: "Ikke sendt til revisor — …" is true, and
    email_error stays the bare cause (no marker)."""
    monkeypatch.setattr("app.services.email_service.resend.api_key", None)
    user = _owner(db_session, auto_send=True)
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["accountant_skip_reason"] is None
    assert ritual["email_status"] == "failed_skipped"
    assert ritual["email_error"] == "email_not_configured"


def test_auto_send_off_and_the_owner_copy_sent_has_no_marker(db_session, client, mailbox):
    user = _owner(db_session, auto_send=False)
    ritual = _lock(client, user, d="2026-10-07").json()["close_ritual"]
    assert ritual["email_status"] == "sent"
    assert ritual["email_error"] is None
    assert _revisor_mails(mailbox) == []


def test_the_marker_rule_itself():
    for skip in sorted(_REVISOR_LEFT_OUT):
        res = {"email_status": "failed_skipped", "email_error": "email_not_configured", "sent_to": []}
        _mark_revisor_left_out(res, skip)
        assert res["email_error"] == f"revisor_{skip};email_not_configured"
    # Never for a revisor that was a recipient, a reason of its own, or a send
    # that reached someone.
    for skip, res in (
        (None, {"email_status": "failed_skipped", "email_error": "email_not_configured", "sent_to": []}),
        ("same_as_owner", {"email_status": "send_failed", "email_error": "send_error: x", "sent_to": []}),
        ("email_unverified", {"email_status": "send_failed", "email_error": "send_error: x", "sent_to": []}),
        ("auto_send_off", {"email_status": "sent", "email_error": None, "sent_to": ["o@x.dk"]}),
    ):
        before = dict(res)
        _mark_revisor_left_out(res, skip)
        assert res == before
    long = {"email_status": "send_failed", "email_error": "send_error: " + "x" * 200, "sent_to": []}
    _mark_revisor_left_out(long, "auto_send_off")
    assert len(long["email_error"]) == 64


def test_the_profile_row_is_untouched(db_session, client, mailbox, monkeypatch):
    monkeypatch.setattr("app.services.email_service.resend.api_key", None)
    user = _owner(db_session, auto_send=False)
    _lock(client, user, d="2026-10-07")
    prof = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    assert prof.accountant_auto_send is False
