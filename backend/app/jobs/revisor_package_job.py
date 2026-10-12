"""Scheduled revisor packages — Settings → "Send revisorpakke".

Runs every hour. For each owner who chose a schedule:

  weekly   due Monday 07:00 local → the week before (Monday–Sunday)
  monthly  due the 3rd, 07:00 local → the month before

Only the MOST RECENT due period is ever considered, and only when the owner
switched the schedule on before it fell due — so turning it on mid-month never
mails last month's package by surprise, and a long outage never sends a
backlog.

Once per period per recipient, enforced by the database: the ledger row's
`dedup_key` ("sched:<start>:<end>:<address fingerprint>") is UNIQUE per owner.
The row is claimed BEFORE anything is built or mailed; a second worker, the
old instance during a deploy, or a retried run cannot claim it again. A send
that failed is retried on the next runs (3 attempts in all); a claim left
behind by a crash is never re-sent (at most once — a duplicate package to a
third party is worse than a missing one, and ops hears about both).

A period that cannot go out yet (no revisor saved, the owner's e-mail not
confirmed, the revisor opted out, sample data in it, the plan) is recorded as
SKIPPED with its reason — the owner sees it on the schedule card — and is
re-checked every hour until the next period falls due.

Failures reach ops through the job's `send_error` key (job_events →
error_logs → the ops triage digest).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

DUE_HOUR = 7
MAX_ATTEMPTS = 3
STALE_CLAIM = timedelta(minutes=30)


def due_period(schedule: str, now_utc: datetime, tz) -> tuple[str, date, date, datetime] | None:
    """(kind, start, end, due_at as naive UTC) for the most recent due
    moment at or before `now_utc`, or None for an unknown schedule."""
    from app.services.revisor_package import previous_month
    aware = now_utc if now_utc.tzinfo else now_utc.replace(tzinfo=timezone.utc)
    local = aware.astimezone(tz)

    def _utc(d: date) -> datetime:
        return datetime.combine(d, time(DUE_HOUR, 0), tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)

    if schedule == "weekly":
        monday = local.date() - timedelta(days=local.weekday())
        if local < datetime.combine(monday, time(DUE_HOUR, 0), tzinfo=tz):
            monday -= timedelta(days=7)
        return "week", monday - timedelta(days=7), monday - timedelta(days=1), _utc(monday)
    if schedule == "monthly":
        third = local.date().replace(day=3)
        if local < datetime.combine(third, time(DUE_HOUR, 0), tzinfo=tz):
            third = (third.replace(day=1) - timedelta(days=1)).replace(day=3)
        start, end = previous_month(third)
        return "month", start, end, _utc(third)
    return None


def next_due_period(schedule: str, now_utc: datetime, tz) -> tuple[str, date, date, datetime] | None:
    """The first due moment strictly AFTER `now_utc` (what the schedule card
    names as "next")."""
    cur = due_period(schedule, now_utc, tz)
    if cur is None:
        return None
    # Step past the current due moment by the period length, then take the
    # most recent due moment at or before that probe.
    step = timedelta(days=7) if schedule == "weekly" else timedelta(days=31)
    probe = cur[3] + step
    nxt = due_period(schedule, probe, tz)
    while nxt is not None and nxt[3] <= (now_utc.replace(tzinfo=None) if now_utc.tzinfo else now_utc):
        probe += step
        nxt = due_period(schedule, probe, tz)
    return nxt


def _dedup_key(start: date, end: date, fp: str | None) -> str:
    return f"sched:{start.isoformat()}:{end.isoformat()}:{fp or 'none'}"


def run_revisor_package_schedule(
    db_factory: Callable[[], Session] = SessionLocal,
    now: datetime | None = None,
) -> dict:
    """One pass over every owner with a schedule. Never raises."""
    from app.models.business_profile import BusinessProfile
    from app.models.revisor_package import RevisorPackageSend as R
    from app.models.user import User
    from app.services import revisor_mail as rm
    from app.services import revisor_package as rp
    from app.services.audit_service import record as audit_record
    from app.services.tz_utils import _user_zone

    now = now or utc_now()
    summary = {"checked": 0, "due": 0, "sent": 0, "skipped": 0, "failed": 0, "purged": 0}
    failures: list[str] = []
    db = db_factory()
    try:
        profiles = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.revisor_package_schedule.in_(rp.SCHEDULES))
            .all()
        )
        for profile in profiles:
            summary["checked"] += 1
            try:
                user = db.query(User).filter(User.id == profile.user_id).first()
                if user is None or getattr(user, "is_locked", False):
                    continue
                due = due_period(profile.revisor_package_schedule, now, _user_zone(user))
                if due is None:
                    continue
                kind, start, end, due_at = due
                since = profile.revisor_package_schedule_at
                if since is None or since > due_at:
                    continue  # switched on after this period fell due
                summary["due"] += 1
                recipient = rm.saved_revisor_address(profile)
                fp = rm.address_fingerprint(rm.mailbox_address(recipient)) if recipient else None
                key = _dedup_key(start, end, fp)
                row = db.query(R).filter(R.user_id == user.id, R.dedup_key == key).first()
                if row is not None and row.status == "sent":
                    continue
                if row is not None and row.status == "claimed":
                    if (now - (row.updated_at or row.created_at)) > STALE_CLAIM:
                        # Left behind mid-send. It may or may not have gone
                        # out: never send it again — tell ops instead.
                        row.status, row.error, row.updated_at = "failed", "stale_claim", now
                        row.attempts = MAX_ATTEMPTS
                        db.commit()
                        failures.append("stale_claim")
                        summary["failed"] += 1
                    continue
                if row is not None and row.status == "failed" and (row.attempts or 0) >= MAX_ATTEMPTS:
                    continue

                blocker = rp.send_blocker(db, user, profile, start, end)
                if blocker:
                    summary["skipped"] += 1
                    if row is None:
                        row = R(user_id=user.id, period_kind=kind, period_start=start,
                                period_end=end, send_trigger="scheduled", recipient=recipient,
                                recipient_fp=fp, dedup_key=key, status="skipped",
                                skip_reason=blocker, attempts=0, created_at=now, updated_at=now)
                        db.add(row)
                        try:
                            db.flush()
                        except IntegrityError:
                            db.rollback()
                            continue
                        audit_record(db, user, rp.SKIP_ACTION, "revisor_package", entity_id=row.id,
                                     after={"period_start": start.isoformat(),
                                            "period_end": end.isoformat(), "reason": blocker},
                                     actor_type="system.revisor_package")
                        db.commit()
                    elif row.status == "skipped" and row.skip_reason != blocker:
                        row.skip_reason, row.updated_at = blocker, now
                        audit_record(db, user, rp.SKIP_ACTION, "revisor_package", entity_id=row.id,
                                     after={"period_start": start.isoformat(),
                                            "period_end": end.isoformat(), "reason": blocker},
                                     actor_type="system.revisor_package")
                        db.commit()
                    continue

                # Claim the period — exactly one claimer wins.
                if row is None:
                    row = R(user_id=user.id, period_kind=kind, period_start=start,
                            period_end=end, send_trigger="scheduled", recipient=recipient,
                            recipient_fp=fp, dedup_key=key, status="claimed", attempts=1,
                            created_at=now, updated_at=now)
                    db.add(row)
                    try:
                        db.commit()
                    except IntegrityError:
                        db.rollback()
                        continue
                else:
                    seen_status, seen_attempts = row.status, row.attempts or 0
                    won = (
                        db.query(R)
                        .filter(R.id == row.id, R.status == seen_status, R.attempts == seen_attempts)
                        .update({"status": "claimed", "attempts": seen_attempts + 1,
                                 "skip_reason": None, "updated_at": now},
                                synchronize_session=False)
                    )
                    db.commit()
                    if won != 1:
                        continue
                    db.refresh(row)

                try:
                    rp.deliver(db, user, profile, row, now=now,
                               schedule=profile.revisor_package_schedule)
                except Exception as e:  # noqa: BLE001 — deliver raises only BEFORE the mail
                    code = e.code if isinstance(e, rp.PackageDeliveryError) else type(e).__name__
                    detail = getattr(e, "detail", "") or ""
                    if not isinstance(e, rp.PackageDeliveryError):
                        logger.exception("revisor package build failed for user=%s", user.id)
                    db.rollback()
                    row = db.query(R).filter(R.id == row.id).first()
                    if row is not None:
                        row.status, row.error, row.updated_at = "failed", f"{code}:{detail}"[:120], now
                        audit_record(db, user, rp.FAIL_ACTION, "revisor_package", entity_id=row.id,
                                     after={"period_start": start.isoformat(),
                                            "period_end": end.isoformat(),
                                            "error": code, "attempt": row.attempts},
                                     actor_type="system.revisor_package")
                        db.commit()
                    summary["failed"] += 1
                    failures.append(code)
                    continue
                # Delivered. If this commit fails the claim stays and is
                # never sent again (stale claim → ops), never twice.
                db.commit()
                summary["sent"] += 1
            except Exception as e:  # noqa: BLE001 — one owner never stops the run
                logger.exception("revisor package schedule failed for profile=%s", profile.id)
                db.rollback()
                summary["failed"] += 1
                failures.append(type(e).__name__)

        # The ZIP behind an expired link is a copy of the books with no
        # retention basis of its own — remove it a day after the link died.
        try:
            summary["purged"] = purge_expired(db, now=now)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            summary["purge_error"] = type(e).__name__
    finally:
        db.close()
    if failures:
        # *_error reaches ops (job_events → error_logs → ops triage).
        summary["send_error"] = ",".join(sorted(set(failures)))[:200]
    return summary


def purge_expired(db: Session, *, now: datetime | None = None) -> int:
    from app.models.revisor_package import RevisorPackageSend as R
    from app.services.storage import get_storage
    now = now or utc_now()
    cutoff = now - timedelta(days=1)
    rows = (
        db.query(R)
        .filter(R.status == "sent", R.storage_key.isnot(None), R.purged_at.is_(None),
                R.link_expires_at < cutoff)
        .limit(200)
        .all()
    )
    n = 0
    storage = get_storage()
    for r in rows:
        still_used = (
            db.query(R.id)
            .filter(R.storage_key == r.storage_key, R.id != r.id, R.purged_at.is_(None),
                    R.link_expires_at >= cutoff)
            .first()
        )
        if not still_used:
            try:
                storage.delete(r.storage_key)
            except Exception:  # noqa: BLE001 — retried next run
                logger.warning("revisor package purge failed for %s", r.id)
                continue
        r.purged_at = now
        n += 1
    db.commit()
    return n
