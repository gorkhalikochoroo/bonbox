"""Pre-shift push reminders.

A staffer opts in from the portal (`staff_members.shift_reminder_minutes`,
NULL = off) and picks their own lead time. This job runs on a short tick and
pushes once per shift, shortly before it starts.

Three things it must never do, in the order they would hurt:

  1. **Send twice.** The tick overlaps its own window on purpose — a job that
     fires every 5 minutes against a 5-minute window drops reminders whenever a
     run is slow or the worker restarts. So the window is deliberately wider
     than the tick, and correctness comes from the DEDUP KEY
     (`shiftrem:<schedule_id>`), not from the window being exact. A unique row
     per shift is the only thing standing between "one reminder" and "a
     reminder every tick until the shift starts".

  2. **Remind about a shift that is not really theirs.** Only published or
     confirmed shifts count — a draft the owner is still moving is not a
     commitment, and waking someone at 06:00 for a shift that gets deleted at
     09:00 is worse than no reminder at all.

  3. **Wake someone who did not ask.** `shift_reminder_minutes IS NULL` means
     off, and that is the default for every existing row. There is no implicit
     opt-in.

Timezone: shift date + start_time are LOCAL to the owner's business, so the
comparison is done in the owner's timezone and only then turned into UTC.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models.staff import Schedule, StaffMember, NotificationLog
from app.models.user import User

logger = logging.getLogger(__name__)

# Wider than the tick so a slow or restarted run cannot drop a reminder. The
# dedup key — not this number — is what keeps it to one send.
WINDOW_MINUTES = 20


def _local_now(user: User) -> datetime:
    """Now, in the owner's business timezone, naive for comparison."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(user.timezone or "Europe/Copenhagen")
    except Exception:  # noqa: BLE001 — a bad tz string must not kill the sweep
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Europe/Copenhagen")
    return datetime.now(tz).replace(tzinfo=None)


def _parse_hhmm(value: str | None) -> tuple[int, int] | None:
    if not value:
        return None
    try:
        h, m = value.split(":")[:2]
        h, m = int(h), int(m)
    except (ValueError, AttributeError):
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h, m


def send_due_shift_reminders(db: Session) -> dict:
    """One sweep. Returns counters so the caller can log them."""
    from app.services.push_sender import send_to_subscription
    from app.models.push_subscription import PushSubscription

    result = {"considered": 0, "due": 0, "sent": 0, "skipped_dup": 0}

    members = (
        db.query(StaffMember)
        .filter(
            StaffMember.shift_reminder_minutes.isnot(None),
            # Deactivated staff must never be pushed to. Every sibling query in
            # the portal gates on this; the sweep did not, so a fired staffer
            # kept getting "your shift starts at 16:00" until someone noticed.
            StaffMember.active.is_(True),
        )
        .all()
    )
    if not members:
        return result

    by_owner: dict = {}
    for m in members:
        by_owner.setdefault(m.user_id, []).append(m)

    for owner_id, owner_members in by_owner.items():
        owner = db.query(User).filter(User.id == owner_id).first()
        if not owner:
            continue
        now_local = _local_now(owner)

        for member in owner_members:
            lead = int(member.shift_reminder_minutes or 0)
            if lead <= 0:
                continue

            # Only look at the days the window can possibly touch.
            target_from = now_local + timedelta(minutes=lead)
            target_to = target_from + timedelta(minutes=WINDOW_MINUTES)

            shifts = (
                db.query(Schedule)
                .filter(
                    Schedule.staff_id == member.id,
                    Schedule.user_id == owner_id,
                    Schedule.date >= target_from.date(),
                    Schedule.date <= target_to.date(),
                    Schedule.status.in_(("published", "confirmed")),
                )
                .all()
            )

            for shift in shifts:
                result["considered"] += 1
                hm = _parse_hhmm(shift.start_time)
                if hm is None:
                    continue
                starts_at = datetime.combine(shift.date, datetime.min.time()).replace(
                    hour=hm[0], minute=hm[1]
                )
                # Due when the shift starts inside [lead, lead + window) from now.
                if not (target_from <= starts_at < target_to):
                    continue
                result["due"] += 1

                dedup_key = f"shiftrem:{shift.id}"
                already = (
                    db.query(NotificationLog)
                    .filter(NotificationLog.dedup_key == dedup_key)
                    .first()
                )
                if already:
                    result["skipped_dup"] += 1
                    continue

                subs = (
                    db.query(PushSubscription)
                    .filter(
                        PushSubscription.user_id == owner_id,
                        PushSubscription.staff_id == member.id,
                    )
                    .all()
                )

                title = "BonBox · Vagt"
                body_text = (
                    f"Din vagt starter {shift.start_time}"
                    + (f"–{shift.end_time}" if shift.end_time else "")
                )
                payload = {
                    "title": title,
                    "body": body_text,
                    "tag": dedup_key,
                    "data": {"kind": "shift_reminder"},
                }

                sent_any = False
                for sub in subs:
                    try:
                        outcome = send_to_subscription(sub, payload)
                        if outcome.get("ok"):
                            sent_any = True
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("shift reminder push threw: %s", exc)

                # Write the dedup row EVEN WHEN NOTHING SENT. Otherwise a
                # staffer with no live subscription gets retried every tick
                # forever, and one whose push fails transiently gets spammed
                # the moment it recovers.
                try:
                    db.add(NotificationLog(
                        id=uuid.uuid4(),
                        user_id=owner_id,
                        staff_id=member.id,
                        channel="push",
                        event_type="shift_reminder",
                        subject=title,
                        body=body_text,
                        status="sent" if sent_any else "failed",
                        error_message=None if sent_any else "no_active_subscription",
                        dedup_key=dedup_key,
                    ))
                    db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
                    continue

                if sent_any:
                    result["sent"] += 1

    return result


def run_shift_reminder_tick() -> dict:
    """Scheduler entry point — opens and closes its own session."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        res = send_due_shift_reminders(db)
        if res["sent"] or res["due"]:
            logger.info(
                "shift reminders: due=%s sent=%s dup=%s",
                res["due"], res["sent"], res["skipped_dup"],
            )
        return res
    except Exception as exc:  # noqa: BLE001 — a sweep must never kill the scheduler
        logger.warning("shift reminder tick failed: %s", exc)
        db.rollback()
        return {"considered": 0, "due": 0, "sent": 0, "skipped_dup": 0}
    finally:
        db.close()
