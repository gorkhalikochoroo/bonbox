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

# Retain raw event_log rows for 180 days. After that, individual events are
# purged but aggregated counts in owner_patterns persist. Adjust here, not
# in scattered call sites.
EVENT_RETENTION_DAYS = 180


def purge_old_events() -> int:
    """Delete event_log rows older than EVENT_RETENTION_DAYS. Returns count."""
    db: Session = SessionLocal()
    try:
        cutoff = datetime.utcnow() - timedelta(days=EVENT_RETENTION_DAYS)
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
        now = datetime.utcnow()
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


def daily_maintenance() -> dict:
    """Composite job — run all three steps and return a summary."""
    return {
        "events_purged": purge_old_events(),
        "patterns_expired": expire_stale_patterns(),
        **detect_patterns_for_all(),
        "ran_at": datetime.utcnow().isoformat(),
    }
