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
