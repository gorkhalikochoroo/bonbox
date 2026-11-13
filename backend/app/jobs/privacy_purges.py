"""
R-h privacy purges — personal data that nothing removed.

  • LEG-05 Venteliste guests: reservation_waitlist rows past `purge_after`
    get guest name, phone, e-mail and note nulled (the model docstring has
    always said so; nothing did it). The party itself stays, so the
    Genvundet card and the owner's history still count it.
  • LEG-18 rows nobody ever deleted:
      - whatsapp_messages older than 90 days (no reader, no user FK, so the
        account erasure never reaches them);
      - magic_link_tokens 30 days past expiry (they hold request/used IP; a
        token with no user is never erased otherwise);
      - waitlist_entries (paid-plan interest) without an account, after
        12 months (rows with a user_id go with the account).

Every irreversible step sits behind a flag that defaults OFF
(settings.PRIVACY_PURGE_WAITLIST_ENABLED / PRIVACY_PURGE_ORPHANS_ENABLED) —
except the ONLINE waitlist rows (booking R12, source='public'): a guest who
joined from the booking page is told the name and number are kept for the
waitlist only, so those are always nulled at most 30 days after the night.
OFF = the nightly run only counts what is due and writes nothing; the counts
are at GET /api/admin/privacy-purges. Each purge opens its own session,
commits per batch, rolls back on error and logs counts only — never a name,
phone number, e-mail or IP.

At most BATCH x MAX_BATCHES rows per table per night; the rest goes the next
night (every purge selects "everything past due", so a skipped night catches
up by itself).

  • Egenkontrol readings (food_check_entries) older than 2 years
    (EGENKONTROL_RETENTION_DAYS = 730) — ALWAYS ON, no flag: /privacy promises
    "2 years, then deleted automatically". Readings only: the revisions and
    checks they point at hold no personal data and stay referenced. Nothing
    is due before Nov 2028. R1b: the PHOTOS on those readings go first (row
    + blob; a blob is deleted only when no other photo row uses its key, and
    a storage error leaves the row for the next night), and a reading whose
    photo is still there waits a night (never an FK failure). Weekly reviews
    (food_check_reviews) go 730 days after reviewed_at. The owner's documents
    are NOT purged by time: they stay until the owner deletes them or the
    account.

Accounting records and everything /privacy says is kept (reservations,
audit_logs, security_events, notification_log, event_logs, invoices,
daily_closes) are never touched here — tests/test_privacy_purges.py pins it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from sqlalchemy import exists

from app.models.food_check import FoodCheckEntry, FoodCheckPhoto, FoodCheckReview
from app.models.magic_link_token import MagicLinkToken
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.waitlist import WaitlistEntry
from app.models.whatsapp import WhatsAppMessage
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

BATCH = 500
MAX_BATCHES = 20  # at most 10,000 rows per table per night

WHATSAPP_MESSAGE_RETENTION_DAYS = 90
MAGIC_LINK_RETENTION_DAYS_AFTER_EXPIRY = 30
ANON_PAID_WAITLIST_RETENTION_DAYS = 365
# Egenkontrol readings (with the name of whoever measured): 2 years, then
# deleted automatically. Pinned with the /privacy text by
# tests/test_privacy_matches_code.py.
EGENKONTROL_RETENTION_DAYS = 730


# ── What is due (shared by the purges and the admin dry-run count) ──────

def _waitlist_due(db: Session, now: datetime):
    W = ReservationWaitlistEntry
    return db.query(W.id).filter(
        W.purge_after.isnot(None),
        W.purge_after <= now,
        W.purged_at.is_(None),
    )


def _whatsapp_due(db: Session, now: datetime):
    cutoff = now - timedelta(days=WHATSAPP_MESSAGE_RETENTION_DAYS)
    return db.query(WhatsAppMessage.id).filter(WhatsAppMessage.created_at < cutoff)


def _magic_link_due(db: Session, now: datetime):
    cutoff = now - timedelta(days=MAGIC_LINK_RETENTION_DAYS_AFTER_EXPIRY)
    return db.query(MagicLinkToken.id).filter(MagicLinkToken.expires_at < cutoff)


def _anon_paid_waitlist_due(db: Session, now: datetime):
    cutoff = now - timedelta(days=ANON_PAID_WAITLIST_RETENTION_DAYS)
    return db.query(WaitlistEntry.id).filter(
        WaitlistEntry.user_id.is_(None),
        WaitlistEntry.created_at < cutoff,
    )


def _egenkontrol_due(db: Session, now: datetime):
    cutoff = now - timedelta(days=EGENKONTROL_RETENTION_DAYS)
    # A reading whose photo row is still there (its blob could not be
    # deleted tonight) waits for the next night — never an FK failure.
    has_photo = exists().where(FoodCheckPhoto.entry_id == FoodCheckEntry.id)
    return db.query(FoodCheckEntry.id).filter(FoodCheckEntry.recorded_at < cutoff, ~has_photo)


def _egenkontrol_photos_due(db: Session, now: datetime):
    """Photo rows (removed tombstones included) whose READING is due."""
    cutoff = now - timedelta(days=EGENKONTROL_RETENTION_DAYS)
    return (
        db.query(FoodCheckPhoto.id)
        .join(FoodCheckEntry, FoodCheckEntry.id == FoodCheckPhoto.entry_id)
        .filter(FoodCheckEntry.recorded_at < cutoff)
    )


def _egenkontrol_reviews_due(db: Session, now: datetime):
    cutoff = now - timedelta(days=EGENKONTROL_RETENTION_DAYS)
    return db.query(FoodCheckReview.id).filter(FoodCheckReview.reviewed_at < cutoff)


def _count(q) -> int:
    return int(q.count() or 0)


def dry_run_counts(db: Session, now: datetime | None = None) -> dict:
    """How many rows each purge would touch right now. Counts only."""
    now = now or utc_now()
    return {
        "waitlist_guest_pii": _count(_waitlist_due(db, now)),
        "whatsapp_messages": _count(_whatsapp_due(db, now)),
        "magic_link_tokens": _count(_magic_link_due(db, now)),
        "anonymous_paid_waitlist": _count(_anon_paid_waitlist_due(db, now)),
        "egenkontrol_photos": _count(_egenkontrol_photos_due(db, now)),
        "egenkontrol_entries": _count(_egenkontrol_due(db, now)),
        "egenkontrol_reviews": _count(_egenkontrol_reviews_due(db, now)),
    }


# ── LEG-05: Venteliste guest PII ─────────────────────────────────────────

def purge_waitlist_guest_pii(*, enabled: bool | None = None, now: datetime | None = None,
                             batch: int = BATCH, max_batches: int = MAX_BATCHES) -> dict:
    """Null guest name, phone, e-mail and note on Venteliste rows past
    purge_after, and stamp purged_at. Flag OFF = count only."""
    if enabled is None:
        enabled = bool(settings.PRIVACY_PURGE_WAITLIST_ENABLED)
    now = now or utc_now()
    W = ReservationWaitlistEntry
    db: Session = SessionLocal()
    try:
        due = _count(_waitlist_due(db, now))
        if not enabled:
            return {"due": due, "purged": 0, "dry_run": True}
        purged = 0
        for _ in range(max_batches):
            ids = [r[0] for r in _waitlist_due(db, now).order_by(W.purge_after).limit(batch).all()]
            if not ids:
                break
            db.query(W).filter(W.id.in_(ids)).update(
                {
                    W.guest_name: None,
                    W.guest_phone: None,
                    W.guest_email: None,
                    W.note: None,
                    W.purged_at: now,
                },
                synchronize_session=False,
            )
            db.commit()
            purged += len(ids)
        return {"due": due, "purged": purged, "dry_run": False}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("[retention] waitlist guest purge failed: %s", type(e).__name__)
        raise
    finally:
        db.close()


# ── Booking R12: a guest who joined the waitlist online ──────────────────

def _public_waitlist_due(db: Session, now: datetime):
    W = ReservationWaitlistEntry
    return _waitlist_due(db, now).filter(W.source == "public")


def purge_public_waitlist_guest_pii(*, now: datetime | None = None, batch: int = BATCH,
                                    max_batches: int = MAX_BATCHES) -> dict:
    """Null guest name, phone, e-mail and note on ONLINE waitlist rows
    (source='public', booking R12) past purge_after — the night + at most 30
    days — and stamp purged_at. No flag: the booking page tells the guest it
    is kept for the waitlist only, and these rows are a new class with no
    legacy data behind the cautious dry run of PRIVACY_PURGE_WAITLIST_ENABLED
    (which still governs the door's own entries)."""
    now = now or utc_now()
    W = ReservationWaitlistEntry
    db: Session = SessionLocal()
    try:
        due = _count(_public_waitlist_due(db, now))
        purged = 0
        for _ in range(max_batches):
            ids = [r[0] for r in _public_waitlist_due(db, now).order_by(W.purge_after).limit(batch).all()]
            if not ids:
                break
            db.query(W).filter(W.id.in_(ids)).update(
                {
                    W.guest_name: None,
                    W.guest_phone: None,
                    W.guest_email: None,
                    W.note: None,
                    W.purged_at: now,
                },
                synchronize_session=False,
            )
            db.commit()
            purged += len(ids)
        return {"due": due, "purged": purged, "dry_run": False}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("[retention] public waitlist purge failed: %s", type(e).__name__)
        raise
    finally:
        db.close()


# ── LEG-18: rows nobody ever deleted ─────────────────────────────────────

def _delete_due(due_fn, model, order_col, *, enabled: bool, now: datetime,
                batch: int, max_batches: int, label: str) -> dict:
    db: Session = SessionLocal()
    try:
        due = _count(due_fn(db, now))
        if not enabled:
            return {"due": due, "deleted": 0, "dry_run": True}
        deleted = 0
        for _ in range(max_batches):
            ids = [r[0] for r in due_fn(db, now).order_by(order_col).limit(batch).all()]
            if not ids:
                break
            db.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False)
            db.commit()
            deleted += len(ids)
        return {"due": due, "deleted": deleted, "dry_run": False}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("[retention] %s purge failed: %s", label, type(e).__name__)
        raise
    finally:
        db.close()


def _orphans_enabled(enabled: bool | None) -> bool:
    return bool(settings.PRIVACY_PURGE_ORPHANS_ENABLED) if enabled is None else bool(enabled)


def purge_old_whatsapp_messages(*, enabled: bool | None = None, now: datetime | None = None,
                                batch: int = BATCH, max_batches: int = MAX_BATCHES) -> dict:
    """Delete whatsapp_messages older than 90 days (every row)."""
    return _delete_due(_whatsapp_due, WhatsAppMessage, WhatsAppMessage.created_at,
                       enabled=_orphans_enabled(enabled), now=now or utc_now(),
                       batch=batch, max_batches=max_batches, label="whatsapp_messages")


def purge_expired_magic_links(*, enabled: bool | None = None, now: datetime | None = None,
                              batch: int = BATCH, max_batches: int = MAX_BATCHES) -> dict:
    """Delete magic_link_tokens 30 days past expiry, with or without a user.
    The rate limit reads only the last 10 minutes; the sign-in trail lives in
    security_events and audit_logs."""
    return _delete_due(_magic_link_due, MagicLinkToken, MagicLinkToken.expires_at,
                       enabled=_orphans_enabled(enabled), now=now or utc_now(),
                       batch=batch, max_batches=max_batches, label="magic_link_tokens")


def purge_anonymous_paid_waitlist(*, enabled: bool | None = None, now: datetime | None = None,
                                  batch: int = BATCH, max_batches: int = MAX_BATCHES) -> dict:
    """Delete paid-plan waitlist e-mails without an account after 12 months.
    A row with a user_id is kept: it goes with the account."""
    return _delete_due(_anon_paid_waitlist_due, WaitlistEntry, WaitlistEntry.created_at,
                       enabled=_orphans_enabled(enabled), now=now or utc_now(),
                       batch=batch, max_batches=max_batches, label="anonymous_paid_waitlist")


def purge_old_egenkontrol_entries(*, now: datetime | None = None, batch: int = BATCH,
                                  max_batches: int = MAX_BATCHES) -> dict:
    """Delete egenkontrol readings recorded more than 730 days ago. ALWAYS
    ON (no flag), like the online-waitlist purge: /privacy promises it. Counts
    are logged, never a name or a value. The Postgres immutability trigger is
    BEFORE UPDATE only, so this DELETE is allowed."""
    return _delete_due(_egenkontrol_due, FoodCheckEntry, FoodCheckEntry.recorded_at,
                       enabled=True, now=now or utc_now(),
                       batch=batch, max_batches=max_batches, label="egenkontrol_entries")


def purge_old_egenkontrol_photos(*, now: datetime | None = None, batch: int = BATCH,
                                 max_batches: int = MAX_BATCHES) -> dict:
    """Delete the photos of egenkontrol readings older than 730 days — the
    blob first, then the row. ALWAYS ON. A blob is deleted only when no
    photo row OUTSIDE this batch still uses its key (keys are
    content-addressed); a storage error leaves that row for the next night
    (its reading then waits too). Counts only in the logs."""
    from app.services.storage import get_storage

    now = now or utc_now()
    P = FoodCheckPhoto
    db: Session = SessionLocal()
    try:
        due = _count(_egenkontrol_photos_due(db, now))
        deleted = skipped = 0
        held: set = set()
        storage = None
        for _ in range(max_batches):
            q = (
                db.query(P.id, P.storage_key)
                .join(FoodCheckEntry, FoodCheckEntry.id == P.entry_id)
                .filter(FoodCheckEntry.recorded_at
                        < now - timedelta(days=EGENKONTROL_RETENTION_DAYS))
            )
            if held:
                q = q.filter(~P.id.in_(list(held)))
            rows = q.order_by(FoodCheckEntry.recorded_at).limit(batch).all()
            if not rows:
                break
            batch_ids = [r[0] for r in rows]
            gone = []
            for pid, key in rows:
                if key:
                    other = (
                        db.query(P.id)
                        .filter(P.storage_key == key, ~P.id.in_(batch_ids))
                        .first()
                    )
                    if other is None:
                        try:
                            storage = storage or get_storage()
                            storage.delete(key)
                        except Exception:  # noqa: BLE001 — retried next night
                            held.add(pid)
                            skipped += 1
                            continue
                gone.append(pid)
            if gone:
                db.query(P).filter(P.id.in_(gone)).delete(synchronize_session=False)
                db.commit()
                deleted += len(gone)
        if skipped:
            logger.warning("[retention] egenkontrol photos: %d held for the next night", skipped)
        return {"due": due, "deleted": deleted, "dry_run": False}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("[retention] egenkontrol_photos purge failed: %s", type(e).__name__)
        raise
    finally:
        db.close()


def purge_old_egenkontrol_reviews(*, now: datetime | None = None, batch: int = BATCH,
                                  max_batches: int = MAX_BATCHES) -> dict:
    """Delete weekly reviews reviewed more than 730 days ago. ALWAYS ON."""
    return _delete_due(_egenkontrol_reviews_due, FoodCheckReview, FoodCheckReview.reviewed_at,
                       enabled=True, now=now or utc_now(),
                       batch=batch, max_batches=max_batches, label="egenkontrol_reviews")


# ── The nightly step ─────────────────────────────────────────────────────

_PURGES = (
    # First: online waitlist rows (booking R12) are purged with no flag, so
    # the flag-gated purge below then sees only the door's own entries.
    ("waitlist_public_guest_pii", "purge_public_waitlist_guest_pii"),
    ("waitlist_guest_pii", "purge_waitlist_guest_pii"),
    ("whatsapp_messages", "purge_old_whatsapp_messages"),
    ("magic_link_tokens", "purge_expired_magic_links"),
    ("anonymous_paid_waitlist", "purge_anonymous_paid_waitlist"),
    # Photos BEFORE their readings (FK entry_id), reviews after.
    ("egenkontrol_photos", "purge_old_egenkontrol_photos"),
    ("egenkontrol_entries", "purge_old_egenkontrol_entries"),
    ("egenkontrol_reviews", "purge_old_egenkontrol_reviews"),
)


def run_privacy_purges() -> dict:
    """Run every purge in its own try/except (one failure never blocks the
    others) and log ONE line of flags and counts — the nightly dry-run log."""
    import sys
    mod = sys.modules[__name__]  # look up by name so a test can swap one out
    out: dict = {
        "flags": {
            "PRIVACY_PURGE_WAITLIST_ENABLED": bool(settings.PRIVACY_PURGE_WAITLIST_ENABLED),
            "PRIVACY_PURGE_ORPHANS_ENABLED": bool(settings.PRIVACY_PURGE_ORPHANS_ENABLED),
        },
    }
    for key, fn_name in _PURGES:
        try:
            out[key] = getattr(mod, fn_name)()
        except Exception as e:  # noqa: BLE001
            out[key] = {"error": type(e).__name__}
    logger.info("[retention] privacy purges: %s", out)
    return out
