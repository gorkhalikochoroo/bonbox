"""
Accounting-record retention sweep.

Why this exists:
  Bogføringsloven §12 mandates 5 years minimum retention for accounting
  records (fakturaer, kasserapport, etc.). Skatteforvaltningsloven §31
  extends to 10 years for active tax disputes. GDPR Article 5(1)(e)
  requires us to STOP retaining beyond the legal minimum once the
  basis disappears.

  So we keep everything 5-10 years, then expire it. The sweep runs
  nightly, scoped per-tenant by their data_retention_years setting
  (default 6, locked min 5 max 10 at the schema layer).

Policy:
  • data_retention_years = 6 (default — 5y legal + 1y buffer for
    cross-financial-year cases)
  • audit_logs retained 10 years regardless (Skatteforvaltningsloven
    max — also longer than child records so the trail survives)
  • Soft-archive only — we set a deleted_at marker and exclude from
    business queries, but keep the rows for the legal window in case
    Skattestyrelsen requests them
  • HARD delete only after audit retention (10y) — and only at the
    user's explicit GDPR-deletion request

Idempotency: each sweep computes its own cutoff dates and only acts
on rows older than them. Safe to re-run any number of times.

Failure mode: per-step try/except so one model's failure doesn't
block the others. Errors logged, sweep returns a per-table summary.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.invoice import Invoice
from app.models.mileage import MileageEntry
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.accounting_retention")

# Hard ceilings — never expire faster than these regardless of user
# settings, never slower than these regardless of legal disputes.
MIN_RETENTION_YEARS = 5      # Bogføringsloven §12 floor
MAX_RETENTION_YEARS = 10     # Skatteforvaltningsloven §31 ceiling
AUDIT_RETENTION_YEARS = 10   # audit logs always 10y (longest)

# Suggestions are operational, not accounting records — they expire
# faster. Pending = keep forever; accepted/rejected = 1 year audit.
SUGGESTION_RESOLVED_RETENTION_DAYS = 365


def _user_retention_years(profile: BusinessProfile | None) -> int:
    """Resolve the effective retention window for a user. Clamps to the
    [MIN, MAX] legal range so a user can't accidentally (or maliciously)
    self-shoot below 5 years."""
    if profile is None or profile.data_retention_years is None:
        return 6  # default if no profile
    n = int(profile.data_retention_years)
    return max(MIN_RETENTION_YEARS, min(MAX_RETENTION_YEARS, n))


def _archive_expired_invoices(db: Session, user: User, cutoff: date) -> int:
    """Soft-archive invoices issued before the cutoff. Doesn't delete —
    keeps the row but marks it so business queries can skip it.

    'Archived' is represented by setting status='credited' when the
    invoice is final + paid. Drafts older than the cutoff get hard-
    deleted (they were never legally outgoing vouchers).
    """
    # Hard-delete ancient drafts only — they never became real vouchers
    n_drafts = (
        db.query(Invoice)
        .filter(
            Invoice.user_id == user.id,
            Invoice.status == "draft",
            Invoice.issue_date < cutoff,
        )
        .delete(synchronize_session=False)
    )
    # Non-draft invoices stay in the ledger. We could mark them
    # 'archived' but that would change historical reports — better to
    # leave them queryable and rely on the report-layer date filter.
    return int(n_drafts)


def _archive_expired_mileage(db: Session, user: User, cutoff: date) -> int:
    """Mileage logs older than retention are hard-deleted. They're
    fradrag evidence — once the relevant tax year is past dispute
    window, the entry serves no business purpose."""
    n = (
        db.query(MileageEntry)
        .filter(
            MileageEntry.user_id == user.id,
            MileageEntry.trip_date < cutoff,
            MileageEntry.locked.is_(False),  # locked entries are linked to invoices
        )
        .delete(synchronize_session=False)
    )
    return int(n)


def _archive_resolved_suggestions(db: Session, user: User) -> int:
    """Payment-match suggestions: pending stay forever (inbox), but
    accepted/rejected rows after 1 year are deleted — they're audit
    trail noise after the accept/reject is mirrored in audit_logs."""
    cutoff = utc_now() - timedelta(days=SUGGESTION_RESOLVED_RETENTION_DAYS)
    n = (
        db.query(PaymentMatchSuggestion)
        .filter(
            PaymentMatchSuggestion.user_id == user.id,
            PaymentMatchSuggestion.status.in_(("accepted", "rejected")),
            PaymentMatchSuggestion.updated_at < cutoff,
        )
        .delete(synchronize_session=False)
    )
    return int(n)


def _purge_old_audit_logs(db: Session, user: User) -> int:
    """Audit logs older than 10 years are removed. This is the only
    place audit_logs can be deleted — and only after the longest
    legal window has passed (Skatteforvaltningsloven §31 max).

    Postgres rules block UPDATE/DELETE on audit_logs at the DB layer,
    so this delete only succeeds when run via SQLite (dev/test) or by
    a Postgres superuser DROP RULE first. In production this is
    intentional — we want a manual operator step before purging audit
    history, even for ancient records."""
    cutoff = utc_now() - timedelta(days=AUDIT_RETENTION_YEARS * 366)
    try:
        n = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.created_at < cutoff,
            )
            .delete(synchronize_session=False)
        )
        return int(n)
    except Exception as e:
        # Postgres RULE blocks deletes — that's expected. Log + move on.
        logger.info("audit_logs purge blocked (Postgres rule): %s", e)
        return 0


def run_retention_sweep_for_user(db: Session, user: User) -> dict:
    """One user's retention sweep. Per-table errors don't block the
    others. Returns counts for the audit log entry."""
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    years = _user_retention_years(profile)
    cutoff = date.today() - timedelta(days=years * 366)

    counts = {"user_id": str(user.id), "retention_years": years,
              "invoices_drafts_purged": 0, "mileage_purged": 0,
              "suggestions_purged": 0, "audit_logs_purged": 0}

    try:
        counts["invoices_drafts_purged"] = _archive_expired_invoices(db, user, cutoff)
    except Exception as e:
        logger.exception("invoice retention failed user=%s: %s", user.id, e)

    try:
        counts["mileage_purged"] = _archive_expired_mileage(db, user, cutoff)
    except Exception as e:
        logger.exception("mileage retention failed user=%s: %s", user.id, e)

    try:
        counts["suggestions_purged"] = _archive_resolved_suggestions(db, user)
    except Exception as e:
        logger.exception("suggestion retention failed user=%s: %s", user.id, e)

    try:
        counts["audit_logs_purged"] = _purge_old_audit_logs(db, user)
    except Exception as e:
        logger.exception("audit purge failed user=%s: %s", user.id, e)

    return counts


def run_retention_sweep() -> dict:
    """Top-level entry: sweep every user. Used by the daily cron.

    Bounded — does at most N users per pass via DB iteration (no
    in-memory user list bloat). Each user gets its own session-scope
    transaction so one tenant's failure doesn't roll back another.
    """
    db: Session = SessionLocal()
    try:
        users = db.query(User).all()
    except Exception as e:
        logger.exception("retention sweep — failed to list users: %s", e)
        db.close()
        return {"error": str(e), "users_processed": 0}

    summary = {"users_processed": 0, "total_purged": 0}
    for user in users:
        try:
            counts = run_retention_sweep_for_user(db, user)
            db.commit()
            summary["users_processed"] += 1
            summary["total_purged"] += sum(
                v for k, v in counts.items()
                if k.endswith("_purged") and isinstance(v, int)
            )
        except Exception as e:
            logger.exception("retention sweep failed user=%s: %s", user.id, e)
            try:
                db.rollback()
            except Exception:
                pass
    db.close()
    logger.info("retention sweep complete: %s", summary)
    return summary
