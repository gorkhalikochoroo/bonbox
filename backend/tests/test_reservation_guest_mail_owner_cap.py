"""Guest e-mail from one venue: a rolling-24h ceiling per OWNER, next to the
per-reservation one (sweep 8 Oct, item 3).

The only ceiling on a "your booking was moved / cancelled / confirmed" mail
was GUEST_EMAILS_PER_RESERVATION_PER_DAY — per booking. An owner can create
bookings without limit, give each any guest address and move it, so one
account could make BonBox send ~120 venue mails a minute to strangers from
noreply@bonbox.dk (a Resend suspension would stop mail for every venue).

Now deliver() — the one gate every guest mail passes — also refuses once the
owner's venue has sent GUEST_EMAILS_PER_OWNER_PER_DAY guest mails in 24 h
(lower while the owner's own e-mail is unconfirmed). Over the ceiling the
owner's change still saves, no mail goes out, and the edit / status answer
says so (guest_email_skipped), so the app can tell the owner in da/en.

Real wiring as test_reservation_emails: owner endpoints, background tasks on
this in-memory DB, only email_service.send_email replaced.

  cd backend && pytest tests/test_reservation_guest_mail_owner_cap.py -v
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.models.staff import NotificationLog
from app.services import reservation_emails as mail
from app.utils.time import utc_now
from tests.test_reservation_emails import (  # noqa: F401 — fixtures + builders
    GUEST,
    _booking,
    _edit,
    _logs,
    _status,
    _to,
    _venue,
    client,
    db,
    engine_and_session,
    outbox,
    sleeps,
)


def _sent_rows(db, owner, n, *, event=mail.GUEST_CONFIRMATION, hours_ago=1, status="sent"):
    """n guest mails this venue already sent, each about its own booking."""
    at = utc_now() - timedelta(hours=hours_ago)
    for _ in range(n):
        db.add(NotificationLog(
            id=uuid.uuid4(), user_id=owner.id, staff_id=None, channel="email",
            event_type=event, subject="x", body="reservation:x", status=status,
            dedup_key=f"rsv-mail:{uuid.uuid4()}", created_at=at,
        ))
    db.commit()


def _confirmed(db, owner):
    owner.email_verified = True
    db.commit()
    return owner


# ── deliver(): the gate itself ────────────────────────────────────────


def test_a_venue_at_its_daily_ceiling_sends_no_more_guest_mail(db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY)
    r = _booking(db, owner)
    ok = mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                      to=GUEST, subject="s", html="<p>h</p>")
    assert ok is False
    assert outbox == []
    row = _logs(db, event_type=mail.GUEST_MOVED)
    assert [(x.status, x.error_message) for x in row] == [("failed", "owner_capped")]


def test_one_below_the_ceiling_still_sends(db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY - 1)
    r = _booking(db, owner)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=GUEST, subject="s", html="<p>h</p>") is True
    assert len(outbox) == 1


def test_an_unconfirmed_owner_has_the_lower_ceiling(db, outbox):
    owner, _ = _venue(db)          # email_verified defaults to False
    assert mail.GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED < mail.GUEST_EMAILS_PER_OWNER_PER_DAY
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY_UNCONFIRMED)
    r = _booking(db, owner)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id,
                        event_type=mail.GUEST_CONFIRMATION, to=GUEST,
                        subject="s", html="<p>h</p>") is False
    assert outbox == []


def test_only_this_venues_sent_guest_mail_in_the_last_day_counts(db, outbox):
    owner, _ = _venue(db)
    other, _ = _venue(db)
    _confirmed(db, owner)
    cap = mail.GUEST_EMAILS_PER_OWNER_PER_DAY
    _sent_rows(db, owner, cap, hours_ago=25)                         # yesterday
    _sent_rows(db, owner, cap, status="failed")                      # never left
    _sent_rows(db, owner, cap, event=mail.OWNER_NEW_BOOKING)         # to the owner
    _sent_rows(db, other, cap)                                       # another venue
    assert mail.guest_emails_sent_by_owner_last_24h(db, owner.id) == 0
    r = _booking(db, owner)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=GUEST, subject="s", html="<p>h</p>") is True


def test_mail_to_the_owner_is_never_held_by_the_guest_ceiling(db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY)
    r = _booking(db, owner)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id,
                        event_type=mail.OWNER_NEW_BOOKING, to=owner.email,
                        subject="s", html="<p>h</p>") is True


def test_a_failed_count_sends_nothing(db, outbox, monkeypatch):
    owner, _ = _venue(db)
    r = _booking(db, owner)

    def _boom(*a, **k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(mail, "guest_emails_sent_by_owner_last_24h", _boom)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=GUEST, subject="s", html="<p>h</p>") is False
    assert outbox == []
    assert [x.error_message for x in _logs(db, event_type=mail.GUEST_MOVED)] == ["cap_check_error"]


# ── the owner's change: saved, mail skipped, owner told ─────────────


def test_a_move_over_the_ceiling_saves_and_says_the_guest_was_not_mailed(client, db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY)
    r = _booking(db, owner)
    new = r.starts_at.replace(hour=20, minute=30)
    res = _edit(client, owner, r, starts_at=new.isoformat())
    assert res.status_code == 200, res.text
    db.expire_all()
    assert db.get(type(r), r.id).starts_at == new                      # the change is saved
    assert _to(outbox, GUEST) == []                                    # no mail left
    skipped = res.json()["guest_email_skipped"]
    assert skipped["code"] == "guest_email_owner_cap"
    assert skipped["cap"] == mail.GUEST_EMAILS_PER_OWNER_PER_DAY
    assert skipped["message"] and skipped["message_da"]


def test_a_cancel_over_the_ceiling_saves_and_says_so(client, db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY)
    r = _booking(db, owner, lang="en")
    res = _status(client, owner, r, "cancelled")
    assert res.status_code == 200, res.text
    db.expire_all()
    assert db.get(type(r), r.id).status == "cancelled"
    assert _to(outbox, GUEST) == []
    assert res.json()["guest_email_skipped"]["code"] == "guest_email_owner_cap"


def test_under_the_ceiling_the_guest_is_mailed_and_nothing_is_said(client, db, outbox):
    owner, _ = _venue(db)
    _confirmed(db, owner)
    r = _booking(db, owner, lang="da")
    res = _edit(client, owner, r, starts_at=r.starts_at.replace(hour=20).isoformat())
    assert res.status_code == 200, res.text
    assert "guest_email_skipped" not in res.json()
    assert len(_to(outbox, GUEST)) == 1


def test_a_quiet_correction_over_the_ceiling_says_nothing(client, db, outbox):
    """notify_guest=false never meant to mail — nothing was skipped."""
    owner, _ = _venue(db)
    _confirmed(db, owner)
    _sent_rows(db, owner, mail.GUEST_EMAILS_PER_OWNER_PER_DAY)
    r = _booking(db, owner)
    res = _edit(client, owner, r, starts_at=r.starts_at.replace(hour=20).isoformat(),
                notify_guest=False)
    assert res.status_code == 200, res.text
    assert "guest_email_skipped" not in res.json()
