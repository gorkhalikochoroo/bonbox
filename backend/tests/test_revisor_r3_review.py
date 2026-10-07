"""Revisor artifacts, round 3 — review fixes for the send paths.

  • The owner's copy (lock mail, owner-only "Send igen", the period cc) goes
    to the LOGIN address only — never the free-text Profile e-mail nobody
    verified — every resend counts towards the daily cap, and an address that
    opted out gets no owner copy either.
  • A close locked before the send status was kept is read from the audit
    trail: History says it went, and a send asks first (409 already_sent).
  • A seeded demo close is never mailed to a revisor.
  • The period panel counts the range on the server, not History's 90 rows.

No mail leaves the process (the Resend client is stubbed).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from unittest.mock import patch

from app.models.audit_log import AuditLog
from app.models.daily_close import DailyClose, encode_breakdown
from app.services.revisor_mail import REVISOR_DAILY_CAP, address_fingerprint
from app.utils.time import utc_now
from tests.test_revisor_artifacts import (  # noqa: F401 — fixtures
    _auth,
    _lock,
    _make_profile,
    _make_user,
    _revisor_mails,
    client,
    db_session,
    mailbox,
)

LOGIN = "anders@mirabelle.dk"


def _close(db, user, cid):
    c = db.query(DailyClose).filter(DailyClose.id == uuid.UUID(cid)).first()
    db.refresh(c)
    return c


# ─── The owner's copy: the login, capped, opt-out honoured ───────────


def test_owner_only_resend_never_mails_the_profile_address(db_session, client, mailbox):
    """Profile.email is free text nobody verified: with it set to a stranger,
    a forced owner-only "Send igen" mailed the stranger again and again."""
    user = _make_user(db_session)
    prof = _make_profile(db_session, user, accountant_email=None)
    prof.email = "stranger@victim.example"; db_session.commit()
    mailbox.fail = True
    cid = _lock(client, user).json()["id"]
    mailbox.fail = False
    for i in range(3):
        r = client.post(f"/api/daily-close/{cid}/resend-email",
                        json={"key": f"click-own-{i:02d}", "force": True}, headers=_auth(user))
        assert r.status_code == 200, r.text
    assert mailbox.sent and all(p["to"] == [LOGIN] for p in mailbox.sent)
    assert not any("stranger@victim.example" in str(p) for p in mailbox.sent)


def test_owner_only_resend_is_inside_the_daily_cap(db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user, accountant_email=None)
    cid = _lock(client, user).json()["id"]
    for _ in range(REVISOR_DAILY_CAP):
        db_session.add(AuditLog(user_id=user.id, action="daily_close.resend_email",
                                entity_type="daily_close", created_at=utc_now()))
    db_session.commit()
    n = len(mailbox.sent)
    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-cap-001", "force": True}, headers=_auth(user))
    assert r.status_code == 429, r.text
    assert len(mailbox.sent) == n


def test_an_opted_out_address_gets_no_owner_copy(db_session, client, mailbox):
    """The revisor opted out; the owner then cleared the revisor and made the
    revisor's address the account's own — the owner copy must not reach it."""
    user = _make_user(db_session, email="anna@revisor.dk")
    _make_profile(db_session, user, accountant_email=None,
                  accountant_opted_out_email=address_fingerprint("anna@revisor.dk"))
    mailbox.fail = True
    cid = _lock(client, user).json()["id"]
    mailbox.fail = False
    n = len(mailbox.sent)
    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-opt-001", "force": True}, headers=_auth(user))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "accountant_opted_out"
    assert len(mailbox.sent) == n
    # And the lock mail itself sends no owner copy to it either.
    r2 = _lock(client, user, d="2026-09-26")
    assert r2.status_code == 200
    assert not any(p["to"] == ["anna@revisor.dk"] for p in mailbox.sent[n:])


def test_the_period_copy_goes_to_the_login(db_session, client):
    user = _make_user(db_session)
    prof = _make_profile(db_session, user)
    prof.email = "stranger@victim.example"; db_session.commit()
    _lock(client, user)
    with patch("app.services.email_service.send_email_with_attachment",
               return_value=(True, None)) as sender:
        r = client.post("/api/daily-close/send-to-accountant?from=2026-09-01&to=2026-09-30",
                        json={"fmt": "xlsx"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["cc_to"] == LOGIN
    tos = [c.args[0] for c in sender.call_args_list]
    assert "stranger@victim.example" not in tos and LOGIN in tos


# ─── Closes locked before the status was kept ────────────────────────


def _forget_status(db, c):
    """What a close locked before the status column existed looks like."""
    c.email_status = None
    c.email_sent_to = None
    c.email_sent_at = None
    c.email_error = None
    db.commit()


def test_history_reads_an_old_close_from_the_audit_trail(db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    cid = _lock(client, user).json()["id"]
    _forget_status(db_session, _close(db_session, user, cid))
    rows = client.get("/api/daily-close", headers=_auth(user)).json()
    row = next(r for r in rows if r["id"] == cid)
    assert row["email_status"] == "sent"
    assert "anna@revisor.dk" in row["email_sent_to"] and row["email_sent_at"]
    assert row["email_status_source"] == "audit_trail"


def test_an_old_close_the_revisor_already_got_asks_before_a_second_mail(
        db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    cid = _lock(client, user).json()["id"]
    _forget_status(db_session, _close(db_session, user, cid))
    n = len(_revisor_mails(mailbox))
    r = client.post(f"/api/daily-close/{cid}/resend-email",
                    json={"key": "click-old-001"}, headers=_auth(user))
    assert r.status_code == 409, r.text
    d = r.json()["detail"]
    assert d["code"] == "already_sent" and d["sent_at"] and d["sent_to"] == ["anna@revisor.dk"]
    assert len(_revisor_mails(mailbox)) == n
    # The owner said yes: one more, marked as what it is.
    r2 = client.post(f"/api/daily-close/{cid}/resend-email",
                     json={"key": "click-old-002", "force": True}, headers=_auth(user))
    assert r2.status_code == 200, r2.text
    assert len(_revisor_mails(mailbox)) == n + 1


def test_an_old_close_with_no_record_still_sends(db_session, client, mailbox):
    """Neither the status nor the trail knows: the send goes (the page asks
    first, saying it may already have been sent)."""
    user = _make_user(db_session)
    _make_profile(db_session, user)
    c = DailyClose(
        id=uuid.uuid4(), user_id=user.id, branch_id=None, date=date(2026, 9, 20),
        revenue_categories=encode_breakdown({"food": 1000.0}), revenue_total=1000.0,
        payment_categories=encode_breakdown({"card": 1000.0}), payment_total=1000.0,
        moms_total=200.0, revenue_ex_moms=800.0, moms_mode="auto", status="confirmed",
        closed_by="Lars", closed_at=datetime(2026, 9, 20, 21, 0), is_deleted=False,
    )
    db_session.add(c); db_session.commit()
    rows = client.get("/api/daily-close", headers=_auth(user)).json()
    assert next(r for r in rows if r["id"] == str(c.id))["email_status"] is None
    r = client.post(f"/api/daily-close/{c.id}/resend-email",
                    json={"key": "click-none-01"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert _revisor_mails(mailbox)


def test_a_demo_close_is_never_mailed_to_the_revisor(db_session, client, mailbox):
    user = _make_user(db_session)
    _make_profile(db_session, user)
    c = DailyClose(
        id=uuid.uuid4(), user_id=user.id, branch_id=None, date=date(2026, 9, 21),
        revenue_categories=encode_breakdown({"food": 1000.0}), revenue_total=1000.0,
        payment_categories=encode_breakdown({"card": 1000.0}), payment_total=1000.0,
        moms_total=200.0, revenue_ex_moms=800.0, moms_mode="auto", status="confirmed",
        closed_by="Lars", closed_at=datetime(2026, 9, 21, 21, 0), is_deleted=False,
        notes="Travl aften · sample · demo",
    )
    db_session.add(c); db_session.commit()
    r = client.post(f"/api/daily-close/{c.id}/resend-email",
                    json={"key": "click-demo-01", "force": True}, headers=_auth(user))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "demo_close"
    assert not mailbox.sent


# ─── The period panel counts on the server ───────────────────────────


def test_range_counts_reach_past_historys_90_rows(db_session, client):
    user = _make_user(db_session)
    other = _make_user(db_session, email="other@cafe.dk")
    start = date(2026, 4, 1)
    rows = []
    for i in range(100):
        rows.append(DailyClose(
            id=uuid.uuid4(), user_id=user.id, branch_id=None, date=start + timedelta(days=i),
            revenue_total=1000.0, payment_total=1000.0, moms_total=200.0, revenue_ex_moms=800.0,
            moms_mode="auto", status="draft" if i % 10 == 0 else "confirmed",
            closed_by="Lars", is_deleted=(i == 99),
        ))
    rows.append(DailyClose(id=uuid.uuid4(), user_id=other.id, branch_id=None, date=start,
                           revenue_total=1.0, payment_total=1.0, status="confirmed",
                           is_deleted=False))
    db_session.add_all(rows); db_session.commit()
    assert len(client.get("/api/daily-close", headers=_auth(user)).json()) == 90
    r = client.get("/api/daily-close/range-counts",
                   params={"from": "2026-04-01", "to": "2026-07-31"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    d = r.json()
    # 99 live rows (one deleted), every tenth a draft.
    assert (d["n_locked"], d["n_drafts"]) == (89, 10)
    assert len(d["locked"]) == 89 and d["locked"][0]["date"] == "2026-04-02"
