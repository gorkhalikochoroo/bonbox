"""
Super-admin platform analytics. ALL endpoints in this router require
require_super_admin (multi-layer guard with audit logging).

This router exposes CROSS-USER aggregated data for the platform owner — used
to power the /admin dashboard and to feed the AI pattern-recognition engine.

Read-only by design. There are intentionally NO mutation endpoints here:
  - role elevation must be done in the DB directly
  - data deletions go through the regular user-scoped endpoints
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, distinct, or_, String
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.event_log import EventLog
from app.models.expense import Expense
from app.models.sale import Sale
from app.models.security_event import SecurityEvent
from app.models.triage_note import TriageNote
from app.models.user import User
from app.services.admin_security import require_super_admin
from app.services.triage_service import run_triage, serialize_note
from app.utils.time import utc_now

router = APIRouter()


@router.get("/overview")
def admin_overview(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Top-level platform KPIs."""
    now = utc_now()
    day_ago = now - timedelta(days=1)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    total_users = db.query(func.count(User.id)).scalar() or 0
    verified_users = (
        db.query(func.count(User.id)).filter(User.email_verified == True).scalar() or 0  # noqa: E712
    )

    dau = (
        db.query(func.count(distinct(EventLog.user_id)))
        .filter(EventLog.created_at >= day_ago)
        .scalar()
        or 0
    )
    wau = (
        db.query(func.count(distinct(EventLog.user_id)))
        .filter(EventLog.created_at >= week_ago)
        .scalar()
        or 0
    )
    mau = (
        db.query(func.count(distinct(EventLog.user_id)))
        .filter(EventLog.created_at >= month_ago)
        .scalar()
        or 0
    )

    signups_7d = (
        db.query(func.count(User.id)).filter(User.created_at >= week_ago).scalar() or 0
    )
    signups_30d = (
        db.query(func.count(User.id)).filter(User.created_at >= month_ago).scalar() or 0
    )

    activated_users = db.query(func.count(distinct(Sale.user_id))).scalar() or 0
    activation_rate = (activated_users / total_users * 100) if total_users else 0

    total_events = db.query(func.count(EventLog.id)).scalar() or 0
    total_sales = db.query(func.count(Sale.id)).scalar() or 0
    total_expenses = db.query(func.count(Expense.id)).scalar() or 0

    return {
        "total_users": total_users,
        "verified_users": verified_users,
        "dau": dau,
        "wau": wau,
        "mau": mau,
        "signups_7d": signups_7d,
        "signups_30d": signups_30d,
        "activated_users": activated_users,
        "activation_rate": round(activation_rate, 1),
        "total_events": total_events,
        "total_sales": total_sales,
        "total_expenses": total_expenses,
        "as_of": now.isoformat(),
    }


@router.get("/users")
def admin_user_list(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    search: str | None = Query(None, description="Match on user id prefix or email substring (case-insensitive)"),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """All users (paginated) with engagement stats.

    Optional `search` performs prefix match on UUID *or* case-insensitive substring
    match on email. Useful for resolving truncated 8-char user ids from security logs
    back to the actual account.
    """
    q = db.query(User)
    if search:
        s = search.strip().lower()
        if s:
            q = q.filter(
                or_(
                    func.lower(func.cast(User.id, String)).like(f"{s}%"),
                    func.lower(User.email).like(f"%{s}%"),
                )
            )
    users = (
        q.order_by(User.created_at.desc()).offset(offset).limit(limit).all()
    )
    out = []
    for u in users:
        sale_count = (
            db.query(func.count(Sale.id)).filter(Sale.user_id == u.id).scalar() or 0
        )
        expense_count = (
            db.query(func.count(Expense.id)).filter(Expense.user_id == u.id).scalar()
            or 0
        )
        last_event = (
            db.query(func.max(EventLog.created_at))
            .filter(EventLog.user_id == u.id)
            .scalar()
        )
        event_count = (
            db.query(func.count(EventLog.id))
            .filter(EventLog.user_id == u.id)
            .scalar()
            or 0
        )
        active_days = (
            db.query(func.count(distinct(func.date(EventLog.created_at))))
            .filter(EventLog.user_id == u.id)
            .scalar()
            or 0
        )
        out.append(
            {
                "id": str(u.id),
                "email": u.email,
                "business_name": u.business_name,
                "business_type": u.business_type,
                "currency": u.currency,
                "role": u.role,
                "email_verified": u.email_verified,
                "created_at": u.created_at.isoformat(),
                "last_active": last_event.isoformat() if last_event else None,
                "sale_count": sale_count,
                "expense_count": expense_count,
                "event_count": event_count,
                "active_days": active_days,
                "is_activated": sale_count > 0,
            }
        )
    return out


@router.get("/users/{user_id}/timeline")
def admin_user_timeline(
    user_id: str,
    limit: int = Query(200, ge=1, le=1000),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Recent event timeline for a single user — for deep diagnosis & RQ research."""
    rows = (
        db.query(EventLog)
        .filter(EventLog.user_id == user_id)
        .order_by(EventLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": str(r.id),
            "event": r.event,
            "page": r.page,
            "detail": r.detail,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/feature-usage")
def admin_feature_usage(
    days: int = Query(30, ge=1, le=365),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Most-used pages across all users in the last N days."""
    since = utc_now() - timedelta(days=days)
    rows = (
        db.query(
            EventLog.page,
            func.count(EventLog.id),
            func.count(distinct(EventLog.user_id)),
        )
        .filter(EventLog.created_at >= since, EventLog.event == "page_view")
        .group_by(EventLog.page)
        .order_by(func.count(EventLog.id).desc())
        .all()
    )
    return [
        {"page": p or "unknown", "total_views": v, "unique_users": u}
        for p, v, u in rows
    ]


@router.get("/business-types")
def admin_business_type_breakdown(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Vertical distribution — direct fuel for thesis RQ2."""
    rows = (
        db.query(User.business_type, func.count(User.id))
        .group_by(User.business_type)
        .order_by(func.count(User.id).desc())
        .all()
    )
    return [{"business_type": bt or "unknown", "count": c} for bt, c in rows]


@router.get("/currency-distribution")
def admin_currency_distribution(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Currency distribution — proxy for geographic/language reach."""
    rows = (
        db.query(User.currency, func.count(User.id))
        .group_by(User.currency)
        .order_by(func.count(User.id).desc())
        .all()
    )
    return [{"currency": c or "unknown", "count": n} for c, n in rows]


@router.get("/retention")
def admin_retention(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """D1 / D7 / D30 retention — fuel for thesis RQ1."""
    users = db.query(User.id, User.created_at).all()
    cohorts = {"d1": 0, "d7": 0, "d30": 0}
    eligible = {"d1": 0, "d7": 0, "d30": 0}
    now = utc_now()
    for uid, created in users:
        age = now - created
        for label, days in (("d1", 1), ("d7", 7), ("d30", 30)):
            if age >= timedelta(days=days):
                eligible[label] += 1
                cutoff = created + timedelta(days=days - 1)
                next_cutoff = created + timedelta(days=days)
                has_activity = (
                    db.query(EventLog.id)
                    .filter(
                        EventLog.user_id == uid,
                        EventLog.created_at >= cutoff,
                        EventLog.created_at <= next_cutoff,
                    )
                    .first()
                )
                if has_activity:
                    cohorts[label] += 1
    out = {}
    for k in cohorts:
        out[k] = {
            "retained": cohorts[k],
            "eligible": eligible[k],
            "rate": round(cohorts[k] / eligible[k] * 100, 1) if eligible[k] else 0.0,
        }
    return out


@router.get("/signups-timeline")
def admin_signups_timeline(
    days: int = Query(30, ge=1, le=365),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Daily new signups for the past N days."""
    since = utc_now() - timedelta(days=days)
    rows = (
        db.query(func.date(User.created_at), func.count(User.id))
        .filter(User.created_at >= since)
        .group_by(func.date(User.created_at))
        .order_by(func.date(User.created_at))
        .all()
    )
    return [{"date": str(d), "signups": int(c)} for d, c in rows]


@router.get("/security-events")
def admin_security_events(
    limit: int = Query(50, ge=1, le=200),
    event_type: str | None = Query(None),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Recent admin access attempts — successful and denied."""
    q = db.query(SecurityEvent)
    if event_type:
        q = q.filter(SecurityEvent.event_type == event_type)
    rows = q.order_by(SecurityEvent.created_at.desc()).limit(limit).all()
    return [
        {
            "id": str(r.id),
            "user_id": str(r.user_id) if r.user_id else None,
            "event_type": r.event_type,
            "ip_address": r.ip_address,
            "user_agent": (r.user_agent or "")[:120],
            "detail": r.detail,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/recent-errors")
def admin_recent_errors(
    limit: int = Query(50, ge=1, le=200),
    status_code: int | None = Query(None),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """
    Last N server-side errors (Sentry alternative).

    Populated automatically by the global exception handler in main.py
    every time an uncaught Exception propagates out of any route. Filter
    by status_code (typically 500) to narrow.

    Truncated traceback (5KB) and message (1KB) for UI rendering.
    """
    from app.models.error_log import ErrorLog
    q = db.query(ErrorLog)
    if status_code:
        q = q.filter(ErrorLog.status_code == status_code)
    rows = q.order_by(ErrorLog.created_at.desc()).limit(limit).all()
    return [
        {
            "id": str(r.id),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "method": r.method,
            "path": r.path,
            "status_code": r.status_code,
            "user_id": str(r.user_id) if r.user_id else None,
            "ip_address": r.ip_address,
            "error_type": r.error_type,
            "message": (r.message or "")[:240],
            # Last N lines of traceback are most useful in the UI; full text
            # available if the admin clicks through.
            "traceback_tail": "\n".join((r.traceback or "").splitlines()[-8:]),
        }
        for r in rows
    ]


# ─────────────────────── Spam cleanup ───────────────────────


@router.get("/spam-candidates")
def admin_spam_candidates(
    min_age_days: int = Query(3, ge=0, le=365, description="Account must be at least this many days old"),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Identify likely-spam accounts. A candidate is:
       - email_verified = False
       - 0 sales, 0 expenses
       - 0 events (never opened the app)
       - older than `min_age_days`

    Read-only — does NOT delete. The admin UI calls this first to show what
    WOULD be deleted, then the user clicks confirm to call /cleanup-spam.
    """
    cutoff = utc_now() - timedelta(days=min_age_days)
    users = (
        db.query(User)
        .filter(
            User.email_verified.is_(False),
            User.created_at < cutoff,
            User.role != "super_admin",  # Never sweep super_admins
        )
        .all()
    )
    candidates = []
    for u in users:
        sale_count = db.query(func.count(Sale.id)).filter(Sale.user_id == u.id).scalar() or 0
        expense_count = db.query(func.count(Expense.id)).filter(Expense.user_id == u.id).scalar() or 0
        event_count = db.query(func.count(EventLog.id)).filter(EventLog.user_id == u.id).scalar() or 0
        # Only flag truly inactive accounts — no engagement at all
        if sale_count == 0 and expense_count == 0 and event_count == 0:
            candidates.append({
                "id": str(u.id),
                "email": u.email,
                "business_name": u.business_name,
                "created_at": u.created_at.isoformat(),
                "age_days": (utc_now() - u.created_at).days,
            })
    return {
        "count": len(candidates),
        "min_age_days": min_age_days,
        "candidates": candidates,
    }


@router.post("/cleanup-spam")
def admin_cleanup_spam(
    confirm: bool = Query(False, description="Required — must be true to actually delete"),
    min_age_days: int = Query(3, ge=0, le=365),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Delete spam-candidate accounts. Same filter as /spam-candidates:
    unverified, no engagement, older than min_age_days, not super_admin.

    Multi-layer defense:
      • Requires `confirm=true` query param (prevents accidental DELETE).
      • Skips super_admins always.
      • Audit-logged via SecurityEvent.
      • Cascades to user's sales / expenses / categories / khata so we don't
        leave orphan rows.
    """
    if not confirm:
        return {"deleted": 0, "skipped": "confirm=true required to actually delete"}

    cutoff = utc_now() - timedelta(days=min_age_days)
    users = (
        db.query(User)
        .filter(
            User.email_verified.is_(False),
            User.created_at < cutoff,
            User.role != "super_admin",
        )
        .all()
    )

    # Defer model imports to avoid widening the module's startup cost
    from app.models.expense import ExpenseCategory
    from app.models.khata import KhataCustomer, KhataTransaction

    deleted = 0
    skipped_with_data = 0
    for u in users:
        sale_count = db.query(func.count(Sale.id)).filter(Sale.user_id == u.id).scalar() or 0
        expense_count = db.query(func.count(Expense.id)).filter(Expense.user_id == u.id).scalar() or 0
        event_count = db.query(func.count(EventLog.id)).filter(EventLog.user_id == u.id).scalar() or 0
        # Skip anyone who has ANY activity — only sweep ghost accounts
        if sale_count > 0 or expense_count > 0 or event_count > 0:
            skipped_with_data += 1
            continue

        try:
            # Cascade clean per user (orphan-safe). Most should be empty
            # already since we filtered to no-engagement accounts.
            cust_ids = [c.id for c in db.query(KhataCustomer).filter(KhataCustomer.user_id == u.id).all()]
            if cust_ids:
                db.query(KhataTransaction).filter(KhataTransaction.customer_id.in_(cust_ids)).delete(synchronize_session=False)
            db.query(KhataCustomer).filter(KhataCustomer.user_id == u.id).delete(synchronize_session=False)
            db.query(ExpenseCategory).filter(ExpenseCategory.user_id == u.id).delete(synchronize_session=False)
            db.delete(u)
            deleted += 1
        except Exception:
            # Don't let one bad row block the rest
            db.rollback()
            continue

    # Single audit-log entry for the whole sweep (each delete is destructive)
    try:
        evt = SecurityEvent(
            user_id=admin.id,
            event_type="admin_cleanup_spam",
            detail=f"Deleted {deleted} unverified inactive accounts (≥{min_age_days}d old). Skipped {skipped_with_data} with data.",
        )
        db.add(evt)
    except Exception:
        pass

    db.commit()
    return {
        "deleted": deleted,
        "skipped_with_data": skipped_with_data,
        "min_age_days": min_age_days,
    }


# ─────────────────────────────────────────────────────────────────
# AI On-call Triage — Round D
# ─────────────────────────────────────────────────────────────────

@router.post("/run-triage")
def run_triage_endpoint(
    window_minutes: int = Query(60, ge=10, le=10080),  # 10 min – 7 days
    send_emails: bool = Query(True),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Manually trigger an AI triage scan over the last N minutes of
    error_logs. Groups by fingerprint, generates AI triage notes for
    new groups, emails admin once per fingerprint per 24h cooldown.

    Wire to cron-job.org (POST every 15 min) once you're happy with
    the output, or trigger ad-hoc when something's on fire.
    """
    result = run_triage(db, window_minutes=window_minutes, send_emails=send_emails)
    return {
        "window_minutes": result.window_minutes,
        "errors_in_window": result.error_count,
        "new_triage_notes": [serialize_note(n) for n in result.new_notes],
        "fingerprints_skipped_cooldown": result.skipped_count,
    }


@router.get("/triage-notes")
def admin_triage_notes(
    limit: int = Query(30, ge=1, le=200),
    severity: str | None = Query(None),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Recent AI triage notes — for the admin panel UI."""
    q = db.query(TriageNote)
    if severity in ("low", "medium", "high", "critical"):
        q = q.filter(TriageNote.severity == severity)
    rows = q.order_by(TriageNote.created_at.desc()).limit(limit).all()
    return [serialize_note(r) for r in rows]


# ─── Kasserapport learning admin (the /admin/training page backend) ────

@router.get("/training/drift")
def admin_training_drift(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Per-POS-system drift signals. Returns the latest computed drift
    signal for each known POS system, OR null if no drift detected.

    Frontend renders this as a list with:
      - green if signal is None (healthy)
      - amber if drop is 5-10pp (degrading)
      - red if drop > 10pp (refresh prompt urgently)
    """
    from app.services.kasserapport_learning import compute_drift_signal
    from app.jobs.kasserapport_learning_jobs import KNOWN_POS_SYSTEMS

    out = []
    for pos in KNOWN_POS_SYSTEMS:
        try:
            signal = compute_drift_signal(db, pos)
        except Exception:  # noqa: BLE001
            signal = None
        out.append({
            "pos_system": pos,
            "signal": signal,  # None means healthy / not enough data
        })
    return {"systems": out, "checked_at": utc_now().isoformat()}


@router.get("/training/recent-examples")
def admin_training_recent_examples(
    limit: int = Query(20, ge=1, le=100),
    pos_system: str | None = Query(None),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Recent KasserapportExample rows that got auto-promoted. Founder
    reviews these during weekly admin triage to spot bad promotions
    (e.g. an extraction that scored 0.86 confidence but actually had
    a wrong field that wasn't caught by the validator).

    Filterable by pos_system so you can audit one format at a time.
    """
    from app.models.kasserapport import KasserapportExample

    q = db.query(KasserapportExample).filter(KasserapportExample.is_global.is_(False))
    if pos_system:
        q = q.filter(KasserapportExample.pos_system == pos_system)
    rows = q.order_by(KasserapportExample.created_at.desc()).limit(limit).all()
    return [
        {
            "id": str(r.id),
            "user_id": str(r.user_id) if r.user_id else None,
            "pos_system": r.pos_system,
            "notes": r.notes,
            "promoted_from_extraction_id": (
                str(r.promoted_from_extraction_id) if r.promoted_from_extraction_id else None
            ),
            "truth_json": r.truth_json,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/training/extraction-stats")
def admin_training_extraction_stats(
    days: int = Query(30, ge=1, le=180),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Cross-user aggregate stats for the training dashboard.

    Returns per-POS-system: total scans, avg extraction confidence,
    %manual_review_needed (validator-flagged), %user_corrected (owner
    edited before commit), total tokens consumed.

    The %manual_review and %user_corrected curves over time are the
    headline KPIs for the training loop's effectiveness — both should
    trend DOWN as the example library grows per user.
    """
    from sqlalchemy import case
    from app.models.kasserapport import KasserapportExtraction

    cutoff = utc_now() - timedelta(days=days)
    rows = (
        db.query(
            KasserapportExtraction.pos_system,
            func.count(KasserapportExtraction.id).label("total"),
            func.avg(KasserapportExtraction.extraction_confidence).label("avg_conf"),
            func.sum(
                case((KasserapportExtraction.manual_review_needed.is_(True), 1), else_=0)
            ).label("flagged"),
            func.sum(
                case((KasserapportExtraction.user_corrected.is_(True), 1), else_=0)
            ).label("corrected"),
            func.sum(KasserapportExtraction.input_tokens).label("input_tokens"),
            func.sum(KasserapportExtraction.output_tokens).label("output_tokens"),
        )
        .filter(KasserapportExtraction.created_at >= cutoff)
        .group_by(KasserapportExtraction.pos_system)
        .all()
    )
    return {
        "window_days": days,
        "by_pos": [
            {
                "pos_system": r.pos_system,
                "total_scans": int(r.total or 0),
                "avg_confidence": round(float(r.avg_conf or 0), 3),
                "pct_flagged_manual_review": (
                    round(float(r.flagged or 0) / float(r.total or 1) * 100, 1)
                ),
                "pct_user_corrected": (
                    round(float(r.corrected or 0) / float(r.total or 1) * 100, 1)
                ),
                "input_tokens": int(r.input_tokens or 0),
                "output_tokens": int(r.output_tokens or 0),
            }
            for r in rows
        ],
    }


@router.post("/training/run-drift-now")
def admin_training_run_drift_now(
    admin: User = Depends(require_super_admin),
):
    """Trigger the daily drift sweep on demand instead of waiting for
    03:00 UTC. Useful when you've just deployed a prompt change and
    want immediate feedback on impact."""
    from app.jobs.kasserapport_learning_jobs import daily_drift_sweep
    return daily_drift_sweep()


@router.post("/training/run-pattern-sweep-now")
def admin_training_run_pattern_sweep_now(
    lookback_days: int = Query(30, ge=1, le=180),
    admin: User = Depends(require_super_admin),
):
    """Trigger the weekly correction-pattern sweep on demand."""
    from app.jobs.kasserapport_learning_jobs import weekly_pattern_sweep
    return weekly_pattern_sweep(lookback_days=lookback_days)
