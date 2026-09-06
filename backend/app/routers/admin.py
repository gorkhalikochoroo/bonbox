"""
Super-admin platform analytics. ALL endpoints in this router require
require_super_admin (multi-layer guard with audit logging).

This router exposes CROSS-USER aggregated data for the platform owner — used
to power the /admin dashboard and to feed the AI pattern-recognition engine.

Almost read-only. The only mutations exposed here:
  - /users/{id}/lock and /unlock — incident-response account control
  - /run-triage and /training/run-* — internal ML pipeline triggers
  - /cleanup-spam — anti-spam sweep
Role elevation must still be done in the DB directly.
Data deletions go through the regular user-scoped endpoints.
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, distinct, or_, String
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.event_log import EventLog
from app.models.expense import Expense
from app.models.sale import Sale
from app.models.security_event import SecurityEvent
from app.models.triage_note import TriageNote
from app.models.user import User
from app.services import reservation_adoption
from app.services.admin_security import _audit, require_super_admin
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

    # Reservation adoption. `activated_users` above is distinct(Sale.user_id) —
    # sales only — so until now the booking product appeared in no fleet metric
    # at all and multi-week decisions were being weighed against a number nobody
    # had run. Tiers are returned uncollapsed on purpose; see the service
    # docstring for why each filter is (and isn't) applied.
    reservations = reservation_adoption.collect(db)

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
        "reservations": reservations,
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
    # Tier display — effective_plan() resolves stored plan + active trial
    # into the UI-facing label (free / trial / starter / pro). Single
    # source of truth across the app; mirroring it inline would risk
    # drift if billing.py changes mapping rules.
    from app.services.billing import effective_plan as _eff_plan

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
        # Compute effective tier + raw plan + trial expiry. Three fields
        # so the admin UI can render a colored chip ("Pro") AND show the
        # trial countdown ("Trial · 7d left") without re-deriving.
        try:
            tier = _eff_plan(u)
        except Exception:  # noqa: BLE001
            tier = (getattr(u, "plan", None) or "free").lower()
        out.append(
            {
                "id": str(u.id),
                "email": u.email,
                "business_name": u.business_name,
                "business_type": u.business_type,
                "currency": u.currency,
                "role": u.role,
                "email_verified": u.email_verified,
                "is_locked": bool(getattr(u, "is_locked", False)),
                "locked_at": u.locked_at.isoformat() if getattr(u, "locked_at", None) else None,
                "locked_reason": getattr(u, "locked_reason", None),
                "created_at": u.created_at.isoformat(),
                "last_active": last_event.isoformat() if last_event else None,
                "sale_count": sale_count,
                "expense_count": expense_count,
                "event_count": event_count,
                "active_days": active_days,
                "is_activated": sale_count > 0,
                # Tier surface — see comment above.
                "tier": tier,                         # free | trial | starter | pro
                "plan_raw": (getattr(u, "plan", None) or "free").lower(),
                "trial_ends_at": u.trial_ends_at.isoformat() if getattr(u, "trial_ends_at", None) else None,
            }
        )
    return out


# ─────────────────────── Account lockdown ───────────────────────
#
# Super-admin can lock any account except their own (and any other super_admin).
# Locking flips `is_locked` → True; get_current_user rejects the JWT on next
# request (effective session kill) and /auth/login refuses re-auth.
#
# Audited via SecurityEvent so a malicious admin can't lock accounts quietly.


class LockRequest(BaseModel):
    reason: str = Field(default="", max_length=255, description="Free-text justification (audited)")


@router.post("/users/{user_id}/lock")
def admin_lock_user(
    user_id: str,
    request: Request,
    payload: LockRequest = LockRequest(),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Lock a user account. Refuses to lock self or other super_admins."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if str(target.id) == str(admin.id):
        raise HTTPException(status_code=400, detail="Cannot lock your own account")
    if target.role == "super_admin":
        raise HTTPException(status_code=400, detail="Cannot lock another super_admin")

    already = bool(getattr(target, "is_locked", False))
    target.is_locked = True
    target.locked_at = utc_now()
    target.locked_reason = (payload.reason or "")[:255] or None
    db.commit()

    _audit(
        db,
        admin.id,
        "admin_locked_user",
        request,
        detail=f"target={target.id} email={target.email} reason={target.locked_reason or '-'} already_locked={already}",
    )
    return {
        "ok": True,
        "user_id": str(target.id),
        "email": target.email,
        "is_locked": True,
        "locked_at": target.locked_at.isoformat() if target.locked_at else None,
        "locked_reason": target.locked_reason,
    }


@router.post("/users/{user_id}/unlock")
def admin_unlock_user(
    user_id: str,
    request: Request,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Unlock a previously locked account. Audited."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    was_locked = bool(getattr(target, "is_locked", False))
    target.is_locked = False
    target.locked_at = None
    target.locked_reason = None
    db.commit()

    _audit(
        db,
        admin.id,
        "admin_unlocked_user",
        request,
        detail=f"target={target.id} email={target.email} was_locked={was_locked}",
    )
    return {
        "ok": True,
        "user_id": str(target.id),
        "email": target.email,
        "is_locked": False,
    }


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


@router.get("/prod-health")
def admin_prod_health(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Live status of the prod frontend synthetic monitor.

    Written every 5 min by the frontend_monitor_job (jobs/frontend_monitor_job).
    Lets the super-admin panel render "prod frontend: healthy / BROKEN since
    HH:MM (entry=…, chunk=…)". Read-only. Returns a never-checked default if the
    monitor hasn't run yet (fresh deploy).
    """
    from app.models.monitor_state import MonitorState
    st = db.query(MonitorState).filter(MonitorState.service == "frontend_prod").first()
    if not st:
        return {"healthy": None, "state": "UNKNOWN", "fail_streak": 0,
                "broken_since": None, "last_check_at": None, "last_summary": None,
                "incident_entry": None, "incident_chunk": None}
    return {
        "healthy": st.state == "HEALTHY",
        "state": st.state,
        "fail_streak": st.fail_streak,
        "consecutive_ok": st.consecutive_ok,
        "broken_since": st.broken_since.isoformat() if st.broken_since else None,
        "last_check_at": st.last_check_at.isoformat() if st.last_check_at else None,
        "last_alert_at": st.last_alert_at.isoformat() if st.last_alert_at else None,
        "last_summary": st.last_summary,
        "incident_entry": st.incident_entry,
        "incident_chunk": st.incident_chunk,
    }


@router.get("/public-surface-health")
def admin_public_surface_health(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Live status of every public booking page (the public-surface monitor).

    Written every 15 min by public_surface_monitor_job. Degraded slugs also
    appear in /admin/recent-errors as method=MONITOR rows. Read-only. Ordered
    degraded-first so a genuinely-dead booking page surfaces at the top.
    """
    from app.models.surface_finding import SurfaceFinding
    rows = db.query(SurfaceFinding).all()
    findings = [
        {
            "slug": r.slug,
            "state": r.state,
            "severity": r.severity,
            "codes": r.codes or [],
            "detail": r.detail or {},
            "degraded_since": r.degraded_since.isoformat() if r.degraded_since else None,
            "last_scanned_at": r.last_scanned_at.isoformat() if r.last_scanned_at else None,
            "last_summary": r.last_summary,
        }
        for r in rows
    ]
    # Degraded first, then most-recently-scanned.
    findings.sort(key=lambda f: (f["state"] != "DEGRADED", f["last_scanned_at"] or ""))
    return {
        "total_slugs": len(findings),
        "degraded_count": sum(1 for f in findings if f["state"] == "DEGRADED"),
        "findings": findings,
    }


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


# ── PSD2 provider smoke tests ─────────────────────────────────────────
# Each smoke-test endpoint pings the real provider API from the deployed
# backend with the credentials it has in its env vars.  Lets us verify a
# provider is wired correctly WITHOUT exposing any unauthenticated public
# surface — super-admin gate + audit log on every call.
#
# Pattern to add a new provider:
#   1. Add a get_<provider>_client() factory in app/services/<provider>_client.py
#   2. Add a smoke endpoint here calling client.health_check()
#   3. Done — the super-admin guard + audit row are inherited from the
#      router boundary, no copy-paste of security plumbing needed.


@router.get("/psd2/yapily/smoke")
def admin_yapily_smoke(
    request: Request,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Verify Yapily credentials work from prod.

    Hits Yapily's `/institutions` endpoint with HTTP Basic auth using
    YAPILY_APPLICATION_ID + YAPILY_APPLICATION_SECRET from Render env.
    Returns ok=true + institution count if auth works.  ok=false +
    error_kind if auth fails or the network is unreachable.

    This is read-only — does NOT create connections, does NOT touch the
    bank_connections table, does NOT bill against any production quota.
    It's the cheapest possible Yapily call we can make.
    """
    from app.services.yapily_client import get_yapily_client
    try:
        client = get_yapily_client()
    except Exception as e:  # noqa: BLE001 — config-missing surfaces as 500-friendly JSON
        # Signature: _audit(db, user_id, event_type, request, detail=None).
        # Earlier revisions passed a dict as the 4th positional which
        # collided with the `request=` kwarg → TypeError swallowed by
        # _audit's try/except → NO security_events row was ever written
        # for any Yapily smoke call. Fixed in commit (security audit #221).
        _audit(db, admin.id, "admin.yapily.smoke.config_error", request,
               detail=f"error={str(e)[:200]}")
        return {"ok": False, "error": "config_error", "detail": str(e)}

    result = client.health_check()
    _audit(db, admin.id, "admin.yapily.smoke", request,
           detail=f"ok={result.get('ok')} status={result.get('status_code')}")
    return result


@router.get("/psd2/yapily/institutions")
def admin_yapily_institutions(
    country: str = Query("DK", min_length=2, max_length=2, description="ISO country code"),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
    request: Request = None,
):
    """Programmatic verification of DK bank coverage on Yapily.

    Returns a compact list of institutions in the given country with
    Yapily IDs we'll need later when building the bank picker.  Mirrors
    what the Yapily console shows in the Institutions tab — useful for
    confirming a specific bank (e.g. 'lunar') is in the catalog before
    promising it to a customer.
    """
    from app.services.yapily_client import get_yapily_client
    client = get_yapily_client()
    institutions = client.list_institutions(country=country.upper())
    # Same _audit signature fix as the smoke endpoint above — see #221.
    _audit(db, admin.id, "admin.yapily.institutions", request,
           detail=f"country={country.upper()} count={len(institutions)}")
    return {
        "country": country.upper(),
        "count": len(institutions),
        "institutions": [
            {
                "id": inst.id,
                "name": inst.name,
                "full_name": inst.full_name,
                "environment_type": inst.environment_type,
                "features_count": len(inst.features),
            }
            for inst in institutions
        ],
    }


# ─────────────────────── Terminal provider catalog ─────────────
#
# Read-only view of the global terminal_providers catalog (seeded at
# boot from backend/app/data/terminal_providers.json). Used by the
# admin to verify the catalog loaded correctly and to audit which
# DK/EU POS providers BonBox recognizes for auto-detect (Commit 2 of
# this feature will use these rows to fingerprint Z-report scans).
#
# No pagination — catalog is small (18 rows as of 2026-05-28, max ~50
# even years out). Ordered dominant > common > niche > fallback so the
# top of the list is the most important providers for DK SMBs.


_TIER_ORDER = {"dominant": 0, "common": 1, "niche": 2, "fallback": 3}


@router.get("/terminal-providers")
def admin_terminal_providers_list(
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """List the global POS terminal provider catalog.

    Returns every row in `terminal_providers`, ordered by DK market
    tier (dominant first) then display name. Super-admin only.

    Response shape:
        {
          "count": int,
          "providers": [
            {
              "id": str (UUID),
              "slug": str,
              "display_name": str,
              "country_hq": str | null,  -- ISO-3166-1 alpha-2
              "dk_market_tier": "dominant" | "common" | "niche" | "fallback",
              "industries": str | null,  -- comma-separated tags
              "psd2_settlement": "yes" | "no" | "partial",
              "signature_keywords": [str, ...],  -- list, normalized
              "is_active": bool,
              "created_at": str (ISO-8601),
              "updated_at": str (ISO-8601),
            },
            ...
          ]
        }
    """
    from app.models.terminal_provider import TerminalProvider

    rows = db.query(TerminalProvider).all()
    # Sort in Python by tier-rank then name so a niche provider with
    # name "Adyen" doesn't sort before a common one with name "Worldline".
    rows.sort(key=lambda r: (_TIER_ORDER.get(r.dk_market_tier, 99), r.display_name.lower()))

    return {
        "count": len(rows),
        "providers": [
            {
                "id": str(r.id),
                "slug": r.slug,
                "display_name": r.display_name,
                "country_hq": r.country_hq,
                "dk_market_tier": r.dk_market_tier,
                "industries": r.industries,
                "psd2_settlement": r.psd2_settlement,
                # Newline-separated → list for cleaner JSON consumption
                "signature_keywords": [
                    k for k in (r.signature_keywords or "").split("\n") if k
                ],
                "is_active": bool(r.is_active),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }


# ═══════════════════════════════════════════════════════════════════════
#  ACTIVATION FUNNEL — the Vagtplan loop, end to end
# ═══════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS
#
# Every activation number quoted during the 2026-09-06 readiness review was
# produced by hand-written SQL against production. That is fine once and
# corrosive as a habit: it means nobody can answer "did the last change move
# anything?" without a database session, so in practice nobody asks.
#
# The five steps below ARE the product's core loop. A venue that completes it
# has replaced a paper roster; a venue that stalls at step 2 has a schedule
# nobody ever saw.
#
#   1. rostered   — any shift exists
#   2. published  — a shift left draft, i.e. staff could actually see it
#   3. link_opened— a staffer opened their portal (staff_links.last_accessed)
#   4. clocked_in — a staffer punched in (hours_logged.entry_method == 'clock')
#   5. exported   — the owner took hours to their lønsystem
#
# HONESTY NOTES, because a funnel is exactly the kind of number that flatters:
#
#  • Steps 1-4 are DERIVED from durable rows, so they are retroactive: they
#    describe every venue that ever did the thing, not only those active since
#    this endpoint shipped. Step 5 is the exception — the payroll CSV wrote no
#    trace before `staff.payroll_csv_exported` was added, so `exported` counts
#    only from that deploy. `exported.retroactive: false` says so in the
#    payload rather than in a comment nobody reads.
#
#  • The steps are NOT forced to be monotonic. A venue can clock in without a
#    published shift (quick-add hours), and pretending otherwise by taking a
#    running minimum would hide exactly the odd paths worth seeing. Each count
#    is independent; `funnel_note` says so.
#
#  • Founder/test accounts are excluded via services/internal_accounts, the
#    SAME list the thesis export uses. An eight-venue funnel that silently
#    counts three of my own accounts is worse than no funnel — and using a
#    second, local list here is how the product and the thesis end up
#    reporting different populations from one database.
_ACTIVATION_STEPS = ("rostered", "published", "link_opened", "clocked_in", "exported")


@router.get("/activation")
def admin_activation(
    days: int = Query(0, ge=0, le=3650,
                      description="0 = all time; otherwise only venues created in the last N days"),
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Vagtplan activation funnel — one call instead of five ad-hoc queries."""
    from app.models.staff import HoursLogged, Schedule, StaffLink
    from app.models.audit_log import AuditLog
    from app.services.internal_accounts import EXCLUDED_ACCOUNTS

    base = db.query(User.id)
    if days:
        base = base.filter(User.created_at >= utc_now() - timedelta(days=days))
    # Compare as str: User.id is a UUID column on PG and a string on SQLite,
    # and the exclusion list is keyed by the canonical string form.
    cohort = {row[0] for row in base.all() if str(row[0]) not in EXCLUDED_ACCOUNTS}

    def _venues(q) -> set:
        if not cohort:
            return set()
        return {row[0] for row in q.all()} & cohort

    rostered = _venues(db.query(distinct(Schedule.user_id)))
    published = _venues(
        db.query(distinct(Schedule.user_id))
        .filter(Schedule.status.in_(("published", "confirmed")))
    )
    link_opened = _venues(
        db.query(distinct(StaffLink.user_id))
        .filter(StaffLink.last_accessed.isnot(None))
    )
    clocked_in = _venues(
        db.query(distinct(HoursLogged.user_id))
        .filter(HoursLogged.entry_method == "clock")
    )
    exported = _venues(
        db.query(distinct(AuditLog.user_id))
        .filter(AuditLog.action == "staff.payroll_csv_exported")
    )

    counts = {
        "rostered": rostered,
        "published": published,
        "link_opened": link_opened,
        "clocked_in": clocked_in,
        "exported": exported,
    }
    n = len(cohort)
    return {
        "cohort_days": days or None,
        "cohort_size": n,
        "steps": [
            {
                "key": k,
                "venues": len(counts[k]),
                # An empty cohort is 0.0%, not a 500 and not a fake 100%.
                "pct": round(len(counts[k]) / n * 100, 1) if n else 0.0,
                # Only step 5 starts from its deploy; the rest read durable rows.
                "retroactive": k != "exported",
            }
            for k in _ACTIVATION_STEPS
        ],
        # The one number the concierge week is judged on: venues that finished
        # the loop. Named separately because reading it off the last funnel row
        # invites treating the rows as monotonic, which they are not.
        "completed_loop": len(rostered & published & link_opened & clocked_in),
        "funnel_note": (
            "Steps are counted independently, not as a monotonic funnel — a venue "
            "can clock in without ever publishing (quick-add hours). "
            "`exported` counts only since staff.payroll_csv_exported shipped."
        ),
    }
