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
from sqlalchemy import func, distinct
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.event_log import EventLog
from app.models.expense import Expense
from app.models.sale import Sale
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.admin_security import require_super_admin

router = APIRouter()


@router.get("/overview")
def admin_overview(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Top-level platform KPIs."""
    now = datetime.utcnow()
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
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """All users (paginated) with engagement stats."""
    users = (
        db.query(User).order_by(User.created_at.desc()).offset(offset).limit(limit).all()
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
    since = datetime.utcnow() - timedelta(days=days)
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
    now = datetime.utcnow()
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
    since = datetime.utcnow() - timedelta(days=days)
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
    cutoff = datetime.utcnow() - timedelta(days=min_age_days)
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
                "age_days": (datetime.utcnow() - u.created_at).days,
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

    cutoff = datetime.utcnow() - timedelta(days=min_age_days)
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
