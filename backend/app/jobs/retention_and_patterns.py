"""
Daily cron tasks:
  1. Purge event_logs older than EVENT_RETENTION_DAYS (GDPR compliance —
     we collect analytics under legitimate-interest basis but bound how long
     we keep raw event data).
  2. Run owner_patterns detectors for every user so the AI Copilot has fresh
     insights to pull from on first morning chat.
  3. Auto-expire owner_patterns whose valid_until has passed (also handled
     in run_for_user, but a cleanup pass catches dormant rows too).

Both jobs are idempotent and bounded — safe to retry on failure. Failures
in one don't block the other.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.event_log import EventLog
from app.models.owner_pattern import OwnerPattern
from app.models.user import User
from app.services.owner_patterns import run_for_user
from app.services.smart_drift import run_drift_scan_for_user
from app.utils.time import utc_now

# Retain raw event_log rows for 180 days. After that, individual events are
# purged but aggregated counts in owner_patterns persist. Adjust here, not
# in scattered call sites.
EVENT_RETENTION_DAYS = 180


def purge_old_events() -> int:
    """Delete event_log rows older than EVENT_RETENTION_DAYS. Returns count."""
    db: Session = SessionLocal()
    try:
        cutoff = utc_now() - timedelta(days=EVENT_RETENTION_DAYS)
        n = (
            db.query(EventLog)
            .filter(EventLog.created_at < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        return n
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[retention] purge_old_events failed: {e}")
        return 0
    finally:
        db.close()


def expire_stale_patterns() -> int:
    """Mark active patterns whose valid_until has passed as 'expired'."""
    db: Session = SessionLocal()
    try:
        now = utc_now()
        n = (
            db.query(OwnerPattern)
            .filter(
                OwnerPattern.state == "active",
                OwnerPattern.valid_until.isnot(None),
                OwnerPattern.valid_until < now,
            )
            .update({"state": "expired"}, synchronize_session=False)
        )
        db.commit()
        return n
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[retention] expire_stale_patterns failed: {e}")
        return 0
    finally:
        db.close()


def detect_patterns_for_all() -> dict:
    """Run pattern detectors for every user. Bounded by max_users to keep one
    cron run from running forever."""
    db: Session = SessionLocal()
    try:
        users = db.query(User).limit(2000).all()
        out = {"processed": 0, "patterns_added": 0}
        for u in users:
            try:
                added = run_for_user(u, db)
                out["processed"] += 1
                out["patterns_added"] += added
            except Exception as e:  # noqa: BLE001
                # Per-user failure must not stop the batch
                db.rollback()
                print(f"[patterns] user {u.id} failed: {e}")
        return out
    finally:
        db.close()


def smart_drift_scan_for_all() -> dict:
    """Re-run Smart inferences for every user; persist any material drift
    findings. Bounded by user count, capped per-user via dismissal
    cooldown so we don't spam banners. Per-user failures don't stop
    the batch."""
    db: Session = SessionLocal()
    try:
        users = db.query(User).limit(2000).all()
        out = {"drift_processed": 0, "drift_findings_written": 0}
        for u in users:
            try:
                rows = run_drift_scan_for_user(db, user=u)
                out["drift_processed"] += 1
                out["drift_findings_written"] += len(rows)
            except Exception as e:  # noqa: BLE001
                db.rollback()
                print(f"[smart_drift] user {u.id} failed: {e}")
        return out
    finally:
        db.close()


def daily_maintenance() -> dict:
    """Composite job — run all maintenance steps and return a summary.

    Ordering note: accounting_retention runs LAST so any new drafts
    created during the night's other work are still subject to the
    cutoff on the next sweep, not this one. Each step is wrapped in
    its own try/except so a failure in one doesn't block the others."""
    summary: dict = {
        "events_purged": purge_old_events(),
        "patterns_expired": expire_stale_patterns(),
        **detect_patterns_for_all(),
        **smart_drift_scan_for_all(),
        "ran_at": utc_now().isoformat(),
    }
    # An unanswered group request must not sit in limbo past its own
    # sitting — the guest is never told yes or no otherwise.
    try:
        from app.jobs.reservation_request_expiry import expire_stale_requests
        summary.update(expire_stale_requests())
    except Exception as e:  # noqa: BLE001
        summary["request_expiry_error"] = str(e)

    # Accounting retention sweep — Bogføringsloven §12 (5y min) +
    # Skatteforvaltningsloven §31 (10y max) compliance. Soft-archive
    # only; permanent deletes only for orphan drafts + ancient audit
    # logs. Per-tenant scoped by data_retention_years setting.
    try:
        from app.services.accounting_retention import run_retention_sweep
        summary["accounting_retention"] = run_retention_sweep()
    except Exception as e:
        # Retention failure must not block the rest of nightly maintenance.
        summary["accounting_retention_error"] = str(e)
    return summary
