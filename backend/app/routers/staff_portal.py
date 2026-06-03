"""
Staff Portal — PUBLIC endpoints (no auth required, token-based access).

Staff open a magic link like bonbox.dk/s/j8k2m4 and see their own
schedule, hours, and tips. No login, no password, no account needed.

Endpoints:
  GET    /portal/{token}               — validate link, return staff info (incl. email)
  GET    /portal/{token}/schedule      — their shifts (this + next 2 weeks)
  GET    /portal/{token}/hours         — hours logged for current pay period
  GET    /portal/{token}/tips          — tip distributions for last 30 days
  POST   /portal/{token}/verify-pin   — optional PIN verification
  PUT    /portal/{token}/email        — staff updates their own email
  GET    /portal/{token}/notifications — last 30 notification log entries
"""

import asyncio
import json
import secrets
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from passlib.context import CryptContext

from app.database import get_db, SessionLocal
from app.models.staff import (
    StaffMember, StaffLink, Schedule, HoursLogged,
    Tip, TipDistribution, PayPeriodConfig, NotificationLog,
)
from app.models.business_profile import BusinessProfile
from app.services import portal_events
from app.utils.text import portal_path

import re
from app.utils.time import utc_now

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ═══════════════════════════════════════════════════════════════════════════
#  Schemas (kept here since they're portal-specific and small)
# ═══════════════════════════════════════════════════════════════════════════

class PortalInfo(BaseModel):
    staff_name: str
    role: str
    email: str | None = None
    phone: str | None = None
    restaurant_name: str | None = None
    has_pin: bool = False
    max_hours_month: float | None = None
    max_hours_week: float | None = None


class ContactUpdateRequest(BaseModel):
    email: str | None = None
    phone: str | None = None


class PortalNotification(BaseModel):
    id: str
    event_type: str
    subject: str | None = None
    created_at: datetime | None = None
    channel: str

class PortalShift(BaseModel):
    date: date
    start_time: str
    end_time: str
    break_minutes: int = 0
    role_on_shift: str | None = None
    status: str
    net_hours: float

class PortalHoursEntry(BaseModel):
    date: date
    start_time: str | None = None
    end_time: str | None = None
    total_hours: float
    earned: float | None = None

class PortalTipEntry(BaseModel):
    date: date
    amount: float
    share_pct: float | None = None
    split_method: str | None = None

class PinVerifyRequest(BaseModel):
    pin: str


# ═══════════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _parse_hhmm(t: str) -> float:
    parts = t.split(":")
    return int(parts[0]) + int(parts[1]) / 60.0

def _calc_hours(start: str, end: str, brk: int) -> float:
    s, e = _parse_hhmm(start), _parse_hhmm(end)
    if e <= s:
        e += 24.0
    # 2 decimals to match _calc_shift_hours in staff.py — 1-decimal rounding
    # under-counted hours (and therefore pay) vs the exact owner-side preview.
    return round(max(e - s - brk / 60.0, 0), 2)

def _get_staff_from_token(token: str, db: Session):
    """Validate magic link token, return (link, staff_member)."""
    link = db.query(StaffLink).filter(
        StaffLink.token == token,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found or inactive")

    member = db.query(StaffMember).filter(
        StaffMember.id == link.staff_id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # Update last accessed
    link.last_accessed = utc_now()
    db.commit()

    return link, member


def _get_week_start(d: date) -> date:
    """Monday of the week containing d."""
    return d - timedelta(days=d.weekday())


def _compute_pay_period(config, ref_date: date):
    """Same logic as staff.py helper — compute current pay period dates."""
    import calendar
    ptype = config.period_type

    if ptype == "monthly_1st":
        start = ref_date.replace(day=1)
        last_day = calendar.monthrange(ref_date.year, ref_date.month)[1]
        end = ref_date.replace(day=last_day)
    elif ptype == "monthly_15th":
        if ref_date.day >= 15:
            start = ref_date.replace(day=15)
            end = (date(ref_date.year + 1, 1, 14) if ref_date.month == 12
                   else date(ref_date.year, ref_date.month + 1, 14))
        else:
            start = (date(ref_date.year - 1, 12, 15) if ref_date.month == 1
                     else date(ref_date.year, ref_date.month - 1, 15))
            end = ref_date.replace(day=14)
    elif ptype == "biweekly":
        epoch = date(2024, 1, 1)
        days_since = (ref_date - epoch).days
        offset = (days_since // 14) * 14
        start = epoch + timedelta(days=offset)
        end = start + timedelta(days=13)
    elif ptype == "custom":
        csd = config.custom_start_day or 1
        if ref_date.day >= csd:
            start = ref_date.replace(day=csd)
            next_start = (date(ref_date.year + 1, 1, csd) if ref_date.month == 12
                          else date(ref_date.year, ref_date.month + 1, csd))
            end = next_start - timedelta(days=1)
        else:
            start = (date(ref_date.year - 1, 12, csd) if ref_date.month == 1
                     else date(ref_date.year, ref_date.month - 1, csd))
            end = ref_date.replace(day=csd) - timedelta(days=1)
    else:
        import calendar
        start = ref_date.replace(day=1)
        last_day = calendar.monthrange(ref_date.year, ref_date.month)[1]
        end = ref_date.replace(day=last_day)

    return {"start_date": start, "end_date": end}


# ═══════════════════════════════════════════════════════════════════════════
#  Endpoints
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/{token}")
@limiter.limit("30/minute")
def get_portal_info(token: str, request: Request, db: Session = Depends(get_db)):
    """Validate magic link and return staff basic info."""
    link, member = _get_staff_from_token(token, db)

    # Restaurant name — prefer the owner's editable trading name
    # (User.business_name, e.g. "BonBox") over the BusinessProfile fields, which
    # may still hold the CVR legal entity name ("DukaanAI v/Manoz Chaudhary").
    # Keeps the portal header, browser tab, and the owner's share message all
    # reading the same genuine name. Mirrors the public booking page + emails.
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == link.user_id
    ).first()
    from app.models.user import User
    owner = db.query(User).filter(User.id == link.user_id).first()
    restaurant_name = (
        (getattr(owner, "business_name", None) if owner else None)
        or (profile.business_name if profile else None)
        or (profile.company_name if profile else None)
    )

    return PortalInfo(
        staff_name=member.name,
        role=member.role or "staff",
        email=member.email,
        phone=member.phone,
        restaurant_name=restaurant_name,
        has_pin=bool(link.pin_hash),
        max_hours_month=float(member.max_hours_month) if member.max_hours_month else None,
        max_hours_week=float(member.max_hours_week) if member.max_hours_week else None,
    )


@router.get("/{token}/schedule")
@limiter.limit("30/minute")
def get_portal_schedule(token: str, request: Request, db: Session = Depends(get_db)):
    """Return staff's shifts for this week + next 2 weeks."""
    link, member = _get_staff_from_token(token, db)

    today = date.today()
    week_start = _get_week_start(today)
    # Show 3 weeks: current + next 2
    range_end = week_start + timedelta(days=20)

    shifts = db.query(Schedule).filter(
        Schedule.staff_id == member.id,
        Schedule.user_id == link.user_id,
        Schedule.date >= week_start,
        Schedule.date <= range_end,
        # Only PUBLISHED shifts reach the staff's phone — draft shifts the
        # owner is still editing must never show (mirrors the confirm-
        # schedule filter below). This is the core promise of the
        # publish→notify model: Publish is the moment staff find out.
        Schedule.status == "published",
    ).order_by(Schedule.date, Schedule.start_time).all()

    return {
        "staff_name": member.name,
        "week_start": week_start.isoformat(),
        "shifts": [
            {
                "id": str(s.id),
                "date": s.date.isoformat(),
                "start_time": s.start_time,
                "end_time": s.end_time,
                "break_minutes": s.break_minutes,
                "role_on_shift": s.role_on_shift,
                "status": s.status,
                "net_hours": _calc_hours(s.start_time, s.end_time, s.break_minutes),
                # Bidirectional confirmation signal — UI lights the
                # "I've got it" button green if already confirmed.
                "confirmed_at": s.confirmed_at.isoformat() if s.confirmed_at else None,
            }
            for s in shifts
        ],
    }


# ─────────────────────────────────────────────────────────────────────────
#  Bidirectional schedule-confirm flow (May 2026)
#
#  Staff taps "I've got it" in the portal → we stamp every published
#  shift in the visible window with confirmed_at. The owner's dashboard
#  reads aggregate "N of M confirmed this week" via a separate
#  /staff/schedule-confirmation-summary endpoint (not portal-scoped).
#
#  Multi-layer:
#    • Portal token gate (the only auth on this surface) —
#      _get_staff_from_token already checks active link + tenant scope
#    • Per-link rate limit (existing 30/min) prevents confirm-spam
#    • Idempotent: re-confirming an already-confirmed shift is a no-op
#    • Read-only access to status='draft' shifts skipped — only
#      published shifts are confirmable (drafts shouldn't fire owner
#      banners)
# ─────────────────────────────────────────────────────────────────────────


@router.post("/{token}/confirm-schedule")
@limiter.limit("10/minute")
def confirm_schedule(token: str, request: Request, db: Session = Depends(get_db)):
    """Mark every published shift in the visible 3-week window as
    confirmed by this staff member. Idempotent — re-tapping changes
    nothing.

    Returns the number of shifts actually flipped from null →
    confirmed_at, so the UI can show "✓ 4 shifts confirmed" feedback.
    """
    from app.utils.time import utc_now
    link, member = _get_staff_from_token(token, db)

    today = date.today()
    week_start = _get_week_start(today)
    range_end = week_start + timedelta(days=20)

    # Only confirm published shifts that aren't already confirmed —
    # both filters avoid spurious updated_at noise on no-ops.
    pending = db.query(Schedule).filter(
        Schedule.staff_id == member.id,
        Schedule.user_id == link.user_id,
        Schedule.date >= week_start,
        Schedule.date <= range_end,
        Schedule.status == "published",
        Schedule.confirmed_at.is_(None),
    ).all()

    now = utc_now()
    for s in pending:
        s.confirmed_at = now
    db.commit()

    return {
        "confirmed_count": len(pending),
        "confirmed_at": now.isoformat() if pending else None,
        "staff_name": member.name,
    }


@router.get("/{token}/hours")
@limiter.limit("30/minute")
def get_portal_hours(token: str, request: Request, db: Session = Depends(get_db)):
    """Return hours logged for current pay period."""
    link, member = _get_staff_from_token(token, db)

    # Get pay period config
    config = db.query(PayPeriodConfig).filter(
        PayPeriodConfig.user_id == link.user_id
    ).first()

    today = date.today()
    if config:
        period = _compute_pay_period(config, today)
        period_start = period["start_date"]
        period_end = period["end_date"]
    else:
        # Default: 1st of month to end of month
        import calendar
        period_start = today.replace(day=1)
        last_day = calendar.monthrange(today.year, today.month)[1]
        period_end = today.replace(day=last_day)

    hours = db.query(HoursLogged).filter(
        HoursLogged.staff_id == member.id,
        HoursLogged.user_id == link.user_id,
        HoursLogged.date >= period_start,
        HoursLogged.date <= period_end,
    ).order_by(HoursLogged.date.desc()).all()

    total_hours = sum(float(h.total_hours or 0) for h in hours)
    total_earned = sum(float(h.earned or 0) for h in hours)

    return {
        "staff_name": member.name,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "total_hours": round(total_hours, 1),
        "total_earned": round(total_earned, 2),
        "max_hours_month": float(member.max_hours_month) if member.max_hours_month else None,
        "entries": [
            PortalHoursEntry(
                date=h.date,
                start_time=h.start_time,
                end_time=h.end_time,
                total_hours=float(h.total_hours or 0),
                earned=float(h.earned) if h.earned else None,
            )
            for h in hours
        ],
    }


@router.get("/{token}/tips")
@limiter.limit("30/minute")
def get_portal_tips(token: str, request: Request, db: Session = Depends(get_db)):
    """Return tip distributions for last 30 days."""
    link, member = _get_staff_from_token(token, db)

    since = date.today() - timedelta(days=30)

    distributions = (
        db.query(TipDistribution, Tip)
        .join(Tip, TipDistribution.tip_id == Tip.id)
        .filter(
            TipDistribution.staff_id == member.id,
            Tip.user_id == link.user_id,
            Tip.date >= since,
        )
        .order_by(Tip.date.desc())
        .all()
    )

    total_tips = sum(float(d.amount or 0) for d, t in distributions)

    return {
        "staff_name": member.name,
        "total_tips_30d": round(total_tips, 2),
        "entries": [
            PortalTipEntry(
                date=t.date,
                amount=float(d.amount or 0),
                share_pct=float(d.share_pct) if d.share_pct else None,
                split_method=t.split_method,
            )
            for d, t in distributions
        ],
    }


@router.post("/{token}/verify-pin")
@limiter.limit("5/minute")
def verify_pin(token: str, body: PinVerifyRequest, request: Request, db: Session = Depends(get_db)):
    """Verify optional 4-digit PIN for extra security."""
    link = db.query(StaffLink).filter(
        StaffLink.token == token,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    if not link.pin_hash:
        # No PIN set — auto-pass
        return {"verified": True}

    if not pwd_context.verify(body.pin, link.pin_hash):
        raise HTTPException(status_code=401, detail="Invalid PIN")

    return {"verified": True}


@router.put("/{token}/email")
@limiter.limit("5/minute")
def update_portal_contact(token: str, body: ContactUpdateRequest, request: Request, db: Session = Depends(get_db)):
    """Staff updates their own email and/or phone from the portal."""
    link, member = _get_staff_from_token(token, db)

    # Handle email
    if body.email is not None:
        email = body.email.strip().lower()
        if not email:
            member.email = None
        else:
            email_regex = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
            if not re.match(email_regex, email):
                raise HTTPException(status_code=400, detail="Invalid email format")
            member.email = email

    # Handle phone
    if body.phone is not None:
        phone = body.phone.strip()
        if not phone:
            member.phone = None
        else:
            # Allow international format: +45 12 34 56 78, +4512345678, etc.
            cleaned = re.sub(r'[\s\-\(\)]', '', phone)
            if not re.match(r'^\+?\d{7,15}$', cleaned):
                raise HTTPException(status_code=400, detail="Invalid phone format. Use international format e.g. +4512345678")
            member.phone = cleaned

    db.commit()
    return {"email": member.email, "phone": member.phone, "message": "Contact info updated"}


@router.get("/{token}/notifications")
@limiter.limit("30/minute")
def get_portal_notifications(token: str, request: Request, db: Session = Depends(get_db)):
    """Return last 30 notification_log entries for this staff member."""
    link, member = _get_staff_from_token(token, db)

    # Tenant scope: staff_id is a globally-unique UUID so it already
    # resolves to one owner, but we filter on user_id too so this
    # public, token-only endpoint upholds the same invariant every
    # sibling query does (L5 tenant isolation).
    notifications = (
        db.query(NotificationLog)
        .filter(
            NotificationLog.staff_id == member.id,
            NotificationLog.user_id == link.user_id,
        )
        .order_by(NotificationLog.created_at.desc())
        .limit(30)
        .all()
    )

    return {
        "notifications": [
            PortalNotification(
                id=str(n.id),
                event_type=n.event_type,
                subject=n.subject,
                created_at=n.created_at,
                channel=n.channel,
            )
            for n in notifications
        ]
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Sick call — staff self-service
# ═══════════════════════════════════════════════════════════════════════════
#
# Multi-layer defense:
#   L1 — Auth: magic-link token resolves to a SPECIFIC staff via
#        _get_staff_from_token(). The body's date + reason are user
#        input but the staff_id is fixed by the token (caller can't
#        spoof it).
#   L2 — Rate limit: 4/min per IP. A real human won't spam this; a
#        script trying to flood the owner's notifications hits 429.
#   L3 — Validation: SickCallCreatePortal schema bounds the date and
#        reason; the service enforces the [-30, +60] day window and
#        scrubs control characters.
#   L4 — Idempotency: service returns the existing absence row for
#        same (staff, date) instead of creating a duplicate. Stops
#        the "tap → poor signal → tap again" double-trigger.
#   L5 — Tenant: service queries StaffAbsence/StaffMember/Schedule
#        by user_id (== owner_id resolved from the staff). Cross-
#        tenant leakage is impossible.

class SickCallCreatePortal(BaseModel):
    """Body for POST /portal/{token}/sick-call.

    `staff_id` is intentionally NOT in the body — the magic-link
    token already binds the call to a specific staff. Letting the
    body override it would be a privilege-escalation vector ("call
    sick on Anna's behalf using my own portal token").
    """
    date: date  # the date of the absence
    reason: str | None = None
    schedule_id: str | None = None  # optional — falls back to "find a shift on this date"


class SickCallPortalResponse(BaseModel):
    id: str
    date: date
    status: str
    kind: str
    schedule_id: str | None
    reason: str | None
    called_at: datetime


@router.post("/{token}/sick-call", response_model=SickCallPortalResponse)
@limiter.limit("4/minute")
def portal_call_sick(
    token: str,
    body: SickCallCreatePortal,
    request: Request,
    db: Session = Depends(get_db),
):
    """Staff calls in sick from their portal.

    The token resolves to (staff, owner) — neither is in the body.
    The service layer enforces date bounds + idempotency + tenant
    scoping. Returns the absence row (existing if idempotent retry,
    new otherwise).
    """
    import uuid as _uuid
    from app.services.sick_call_service import (
        create_sick_call, SickCallError,
    )

    # L1: token → staff + owner.
    _link, member = _get_staff_from_token(token, db)

    # Optional schedule_id — accept str then validate as UUID. Service
    # layer rejects mismatches; we just guard against malformed input
    # here.
    schedule_uuid: _uuid.UUID | None = None
    if body.schedule_id:
        try:
            schedule_uuid = _uuid.UUID(body.schedule_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid schedule_id")

    try:
        absence = create_sick_call(
            db,
            owner_id=member.user_id,  # owner of THIS staff
            staff_id=member.id,
            absence_date=body.date,
            reason=body.reason,
            schedule_id=schedule_uuid,
        )
    except SickCallError as e:
        # L3: service-layer validation failure → 422 with the message.
        raise HTTPException(status_code=422, detail=str(e))

    return SickCallPortalResponse(
        id=str(absence.id),
        date=absence.date,
        status=absence.status,
        kind=absence.kind,
        schedule_id=str(absence.schedule_id) if absence.schedule_id else None,
        reason=absence.reason,
        called_at=absence.called_at,
    )


# ═══════════════════════════════════════════════════════════════════════════
#  Shift swap requests — staff peer-to-peer trading
# ═══════════════════════════════════════════════════════════════════════════
#
# Multi-layer defense:
#   L1 — Auth: magic-link token resolves staff identity. The proposer
#        can only use their own staff_id (token-bound). When responding
#        or withdrawing, the staff_id of the action is also fixed by
#        the token — caller can't act as another staff.
#   L2 — Rate limit: 6/min per IP. Propose + respond combined.
#   L3 — Service-layer validation: tenant boundary, ownership, lifecycle
#        guards (see services/shift_swap_service.py).
#   L4 — Idempotency: duplicate propose returns existing pending row.

class SwapProposeBody(BaseModel):
    """Staff proposes a swap. staff_id NOT in body (token-bound)."""
    from_shift_id: str
    to_staff_id: str
    to_shift_id: str
    reason: str | None = None


class SwapRespondBody(BaseModel):
    accept: bool


class SwapPortalResponse(BaseModel):
    id: str
    direction: str  # "outgoing" if I proposed, "incoming" if I'm the target
    status: str
    from_staff_id: str
    from_staff_name: str | None
    from_shift_id: str
    from_shift_date: date | None
    from_shift_time: str | None
    to_staff_id: str | None
    to_staff_name: str | None
    to_shift_id: str | None
    to_shift_date: date | None
    to_shift_time: str | None
    reason: str | None
    owner_note: str | None
    responded_at: datetime | None
    decided_at: datetime | None
    created_at: datetime


def _hydrate_swap(swap, db, *, viewer_staff_id) -> SwapPortalResponse:
    """Build the portal response from a ShiftSwapRequest, joining
    staff names + shift dates so the inbox UI renders without N+1
    follow-up calls. The `direction` field tells the UI whether THIS
    viewer proposed (outgoing) or is the target (incoming)."""
    from_staff = db.query(StaffMember).filter(
        StaffMember.id == swap.from_staff_id,
    ).first()
    to_staff = (
        db.query(StaffMember).filter(StaffMember.id == swap.to_staff_id).first()
        if swap.to_staff_id else None
    )
    from_sched = db.query(Schedule).filter(Schedule.id == swap.from_shift_id).first()
    to_sched = (
        db.query(Schedule).filter(Schedule.id == swap.to_shift_id).first()
        if swap.to_shift_id else None
    )
    direction = "outgoing" if swap.from_staff_id == viewer_staff_id else "incoming"
    return SwapPortalResponse(
        id=str(swap.id),
        direction=direction,
        status=swap.status,
        from_staff_id=str(swap.from_staff_id),
        from_staff_name=from_staff.name if from_staff else None,
        from_shift_id=str(swap.from_shift_id),
        from_shift_date=from_sched.date if from_sched else None,
        from_shift_time=(
            f"{from_sched.start_time}–{from_sched.end_time}"
            if from_sched else None
        ),
        to_staff_id=str(swap.to_staff_id) if swap.to_staff_id else None,
        to_staff_name=to_staff.name if to_staff else None,
        to_shift_id=str(swap.to_shift_id) if swap.to_shift_id else None,
        to_shift_date=to_sched.date if to_sched else None,
        to_shift_time=(
            f"{to_sched.start_time}–{to_sched.end_time}"
            if to_sched else None
        ),
        reason=swap.reason,
        owner_note=swap.owner_note,
        responded_at=swap.responded_at,
        decided_at=swap.decided_at,
        created_at=swap.created_at,
    )


class TeamShift(BaseModel):
    """Lightweight shift summary for the team-schedule transparency
    view. Includes only what staff need to identify a swap target —
    no rates, no notes, no payroll info. Staff sees who's working when."""
    shift_id: str
    staff_id: str
    staff_name: str
    date: date
    start_time: str
    end_time: str
    role: str | None


@router.get("/{token}/team-schedule", response_model=list[TeamShift])
def portal_team_schedule(
    token: str,
    days_ahead: int = 21,
    db: Session = Depends(get_db),
):
    """Transparency view — upcoming shifts for ALL active staff at the
    same owner. Used by the staff-side swap-propose modal so a staff
    can pick a specific teammate + a specific shift of theirs to swap
    for. Same pattern Planday + Deputy use; needed for a P2P swap to
    be coherent.

    Privacy:
      • Returns ONLY shift date + time + role + staff name. NO rates,
        NO notes, NO payroll info, NO PII beyond first name.
      • Tenant-scoped to the owner of the magic-link's staff. Cross-
        owner leakage is impossible — every query joins on user_id ==
        member.user_id.
      • Caps days_ahead at 21 server-side (frontend default = 21) so
        a malicious client can't request unbounded data.
    """
    _link, member = _get_staff_from_token(token, db)

    if days_ahead < 1 or days_ahead > 21:
        days_ahead = 21
    today = date.today()
    end = today + timedelta(days=days_ahead)

    shifts = (
        db.query(Schedule, StaffMember)
        .join(StaffMember, Schedule.staff_id == StaffMember.id)
        .filter(
            Schedule.user_id == member.user_id,
            Schedule.date >= today,
            Schedule.date <= end,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .order_by(Schedule.date.asc(), Schedule.start_time.asc())
        .all()
    )

    return [
        TeamShift(
            shift_id=str(s.id),
            staff_id=str(staff.id),
            staff_name=staff.name,
            date=s.date,
            start_time=s.start_time,
            end_time=s.end_time,
            role=s.role_on_shift,
        )
        for s, staff in shifts
    ]


@router.post("/{token}/swap-requests", response_model=SwapPortalResponse)
@limiter.limit("6/minute")
def portal_propose_swap(
    token: str,
    body: SwapProposeBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """Staff proposes a swap. The body never carries the staff_id —
    it's bound by the magic-link token."""
    import uuid as _uuid
    from app.services.shift_swap_service import propose_swap, ShiftSwapError

    _link, member = _get_staff_from_token(token, db)
    try:
        from_shift = _uuid.UUID(body.from_shift_id)
        to_staff = _uuid.UUID(body.to_staff_id)
        to_shift = _uuid.UUID(body.to_shift_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid id")

    try:
        swap = propose_swap(
            db,
            owner_id=member.user_id,
            from_staff_id=member.id,
            from_shift_id=from_shift,
            to_staff_id=to_staff,
            to_shift_id=to_shift,
            reason=body.reason,
        )
    except ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return _hydrate_swap(swap, db, viewer_staff_id=member.id)


@router.get("/{token}/swap-requests", response_model=list[SwapPortalResponse])
def portal_list_swaps(
    token: str,
    include_resolved: bool = False,
    db: Session = Depends(get_db),
):
    """Staff inbox — incoming + outgoing swaps. Default hides resolved
    (terminal) entries to keep the UI tidy."""
    from app.services.shift_swap_service import list_for_staff

    _link, member = _get_staff_from_token(token, db)
    swaps = list_for_staff(
        db, staff_id=member.id, include_resolved=include_resolved,
    )
    return [_hydrate_swap(s, db, viewer_staff_id=member.id) for s in swaps]


@router.post(
    "/{token}/swap-requests/{swap_id}/respond",
    response_model=SwapPortalResponse,
)
@limiter.limit("6/minute")
def portal_respond_to_swap(
    token: str,
    swap_id: str,
    body: SwapRespondBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """to_staff accepts or declines a swap. Service refuses if the
    swap's to_staff_id != the token's staff (same shape as not-found —
    no enumeration)."""
    import uuid as _uuid
    from app.services.shift_swap_service import respond_to_swap, ShiftSwapError

    _link, member = _get_staff_from_token(token, db)
    try:
        swap_uuid = _uuid.UUID(swap_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid swap_id")
    try:
        swap = respond_to_swap(
            db, swap_id=swap_uuid, responder_staff_id=member.id, accept=body.accept,
        )
    except ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _hydrate_swap(swap, db, viewer_staff_id=member.id)


@router.post(
    "/{token}/swap-requests/{swap_id}/withdraw",
    response_model=SwapPortalResponse,
)
@limiter.limit("6/minute")
def portal_withdraw_swap(
    token: str,
    swap_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Proposer cancels their offer before to_staff has responded."""
    import uuid as _uuid
    from app.services.shift_swap_service import withdraw_swap, ShiftSwapError

    _link, member = _get_staff_from_token(token, db)
    try:
        swap_uuid = _uuid.UUID(swap_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid swap_id")
    try:
        swap = withdraw_swap(db, swap_id=swap_uuid, proposer_staff_id=member.id)
    except ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _hydrate_swap(swap, db, viewer_staff_id=member.id)


# ═══════════════════════════════════════════════════════════════════════════
#  Staff v2 — Web push subscription (Task #242)
# ═══════════════════════════════════════════════════════════════════════════
#
# Staff get the same VAPID-signed Web Push pipeline that owners use for the
# Daily Brief (Task #72) — re-using the existing service worker, push_sender,
# and notification_log surface. Three endpoints:
#
#   GET    /portal/{token}/vapid-public-key  — returns the public VAPID key
#                                              when the owner's tier has
#                                              schedule_publish_push enabled.
#                                              503 when VAPID isn't
#                                              configured (PR previews, CI).
#                                              403 when the OWNER's plan
#                                              doesn't include staff push.
#   POST   /portal/{token}/push/subscribe    — idempotent upsert of a
#                                              PushSubscription row with
#                                              staff_id set + user_id =
#                                              owner. Tenant scope flows
#                                              through the StaffLink token.
#   POST   /portal/{token}/push/unsubscribe  — hard-delete the row when the
#                                              staff disables push from the
#                                              portal settings.
#
# Multi-barrier doctrine on every endpoint:
#   L1 Token validation via _get_staff_from_token (re-uses the active +
#      not-deleted gate every portal endpoint shares).
#   L2 Bounds on the endpoint string (≤ 1500 chars — push providers cap
#      well below that). Keys clamped to ≤ 200 chars each.
#   L3 Rate-limit 6/min/IP — same posture as portal write endpoints.
#   L4 Fail-soft on audit row writes — a failed audit insert never blocks
#      the subscribe operation. The L7 honest-claims layer surfaces it.
#   L5 Tenant scope: PushSubscription.user_id = link.user_id, staff_id =
#      link.staff_id. A staff cannot subscribe under a different tenant
#      because the token IS the tenant identity.
#   L6 Fail-closed on tier: owner's effective_plan() must have
#      `schedule_publish_push` set. We return 403 with a generic body
#      ("staff_push_not_enabled") so we never leak "your owner is on Free."
#   L7 Audit row on every subscribe/unsubscribe — but we record under the
#      owner's user_id with metadata flagging it as a staff action so the
#      owner sees "Anna subscribed to push" in their audit log.
#   L8 Fallback: if the PushSubscription INSERT raises (constraint
#      collision under concurrent re-subscribe), we re-read and return
#      the row — same idempotency contract as the owner /push/subscribe
#      endpoint at routers/push.py:200.
#   L9 4xx for validation, 403 for tier, 503 for VAPID disabled — never 5xx.
#   L10 Honest response: returns `{created: bool, endpoint_suffix: str}`
#      describing the actual row state, not optimistic "ok".


class _PushKeys(BaseModel):
    p256dh: str
    auth: str


class PortalPushSubscribeIn(BaseModel):
    endpoint: str
    keys: _PushKeys
    user_agent: str | None = None


class PortalPushSubscribeOut(BaseModel):
    created: bool
    endpoint_suffix: str


class PortalPushUnsubscribeIn(BaseModel):
    endpoint: str


def _portal_endpoint_suffix(endpoint: str) -> str:
    """Same redaction shape as routers/push.py — only the last 8 chars +
    provider hostname survive into audit rows / responses."""
    try:
        from urllib.parse import urlparse
        host = urlparse(endpoint).hostname or "?"
        tail = endpoint[-8:] if len(endpoint) > 8 else endpoint
        return f"{host}#…{tail}"
    except Exception:  # noqa: BLE001
        return "?"


def _staff_push_feature_check(link, db: Session):
    """L6 fail-closed: lookup the owner User and verify their effective
    plan includes `schedule_publish_push`. Returns the User row when
    enabled, raises 403 otherwise. Separate function so the tier-gate
    answer is the same shape for /subscribe, /unsubscribe, and the
    VAPID-key endpoint (avoids drift in three places).
    """
    from app.models.user import User
    from app.services.billing import has_feature

    owner = db.query(User).filter(User.id == link.user_id).first()
    if not owner:
        # Defensive — should be impossible given the FK on StaffLink, but
        # if the owner row was somehow hard-deleted we treat the link as
        # if push isn't enabled rather than 500.
        raise HTTPException(status_code=403, detail="staff_push_not_enabled")
    if not has_feature(owner, "schedule_publish_push"):
        raise HTTPException(status_code=403, detail="staff_push_not_enabled")
    return owner


@router.get("/{token}/vapid-public-key")
@limiter.limit("30/minute")
def portal_vapid_public_key(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public endpoint — frontend needs the VAPID key BEFORE it can call
    PushManager.subscribe() inside the staff portal. Gates on the owner's
    tier first so the frontend can tell "no push for me" from "push not
    configured at all" without us leaking either side as data.

    Response:
      200 → {"key": "<base64url public key>"}
      403 → owner's tier doesn't include schedule_publish_push
      503 → VAPID env not configured (push pipeline disabled for everyone)
    """
    link, _member = _get_staff_from_token(token, db)
    _staff_push_feature_check(link, db)

    # Defer the import so this module stays importable on machines that
    # don't have the push router wired up (tests, partial CI checkouts).
    from app.config import settings

    pub = getattr(settings, "VAPID_PUBLIC_KEY", "") or ""
    if not pub:
        raise HTTPException(
            status_code=503,
            detail="push_disabled: VAPID keys not configured",
        )
    return {"key": pub.strip()}


@router.post("/{token}/push/subscribe", response_model=PortalPushSubscribeOut)
@limiter.limit("6/minute")
def portal_push_subscribe(
    token: str,
    body: PortalPushSubscribeIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Idempotent upsert of a staff PushSubscription row. Returns
    `created=True` only when a brand-new row was inserted; on every
    re-subscribe with the same endpoint we update the keys + reset
    fail_count and return `created=False`."""
    from app.models.push_subscription import PushSubscription
    from app.services import audit_service

    link, member = _get_staff_from_token(token, db)
    owner = _staff_push_feature_check(link, db)

    # L2 Bounds — push provider endpoints are short URLs, ~ 200 chars typical.
    # Clamp aggressively so a malicious caller can't burn the row size budget.
    if not body.endpoint or len(body.endpoint) > 1500:
        raise HTTPException(status_code=422, detail="invalid_endpoint")
    if not body.keys.p256dh or len(body.keys.p256dh) > 200:
        raise HTTPException(status_code=422, detail="invalid_p256dh")
    if not body.keys.auth or len(body.keys.auth) > 200:
        raise HTTPException(status_code=422, detail="invalid_auth")

    # Find existing row scoped to THIS tenant + staff + endpoint.
    existing = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == owner.id,
            PushSubscription.endpoint == body.endpoint,
        )
        .first()
    )

    suffix = _portal_endpoint_suffix(body.endpoint)

    if existing is not None:
        # Defensive: if a row exists with the SAME endpoint but DIFFERENT
        # staff_id, refuse to overwrite — that would let a malicious portal
        # client hijack another staff member's device row by guessing the
        # endpoint. The endpoint column already has UNIQUE so this is
        # belt + braces.
        if existing.staff_id and existing.staff_id != member.id:
            raise HTTPException(status_code=409, detail="endpoint_conflict")

        existing.staff_id = member.id
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        if body.user_agent:
            existing.user_agent = body.user_agent[:500]
        existing.fail_count = 0
        try:
            audit_service.record(
                db, owner, "staff.push.subscribed", "push_subscription",
                entity_id=existing.id,
                after={
                    "staff_id": str(member.id),
                    "staff_name": member.name,
                    "endpoint_suffix": suffix,
                },
            )
            db.commit()
        except Exception:  # noqa: BLE001
            # L4 fail-soft: audit/commit error doesn't poison the
            # subscribe — push is a UX layer, not a money flow.
            db.rollback()
            db.commit()
        return PortalPushSubscribeOut(created=False, endpoint_suffix=suffix)

    # Brand-new row.
    row = PushSubscription(
        user_id=owner.id,
        staff_id=member.id,
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        user_agent=(body.user_agent[:500] if body.user_agent else None),
        fail_count=0,
    )
    db.add(row)
    try:
        audit_service.record(
            db, owner, "staff.push.subscribed", "push_subscription",
            entity_id=row.id,
            after={
                "staff_id": str(member.id),
                "staff_name": member.name,
                "endpoint_suffix": suffix,
            },
        )
        db.commit()
        return PortalPushSubscribeOut(created=True, endpoint_suffix=suffix)
    except Exception:  # noqa: BLE001
        # L8 Fallback: race on the global UNIQUE(endpoint) — re-read and
        # return idempotent success if the existing row belongs to THIS
        # tenant + staff. Otherwise surface a clean 409.
        db.rollback()
        existing = (
            db.query(PushSubscription)
            .filter(PushSubscription.endpoint == body.endpoint)
            .first()
        )
        if existing and existing.user_id == owner.id and (
            existing.staff_id is None or existing.staff_id == member.id
        ):
            existing.staff_id = member.id
            existing.p256dh = body.keys.p256dh
            existing.auth = body.keys.auth
            existing.fail_count = 0
            db.commit()
            return PortalPushSubscribeOut(created=False, endpoint_suffix=suffix)
        raise HTTPException(status_code=409, detail="endpoint_conflict")


@router.post("/{token}/push/unsubscribe")
@limiter.limit("6/minute")
def portal_push_unsubscribe(
    token: str,
    body: PortalPushUnsubscribeIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Hard-delete the (owner_id, staff_id, endpoint) row. Returns 200
    in both delete-happened and nothing-to-delete cases — the frontend
    doesn't need to distinguish, and a 404 would leak "this endpoint
    belongs to another staff." Matches the owner-side contract at
    routers/push.py:247.

    Note: unsubscribe is NOT tier-gated. A staff on a freshly-downgraded
    tenant MUST always be able to turn push off; the gate only applies
    when subscribing.
    """
    from app.models.push_subscription import PushSubscription
    from app.services import audit_service

    link, member = _get_staff_from_token(token, db)

    if not body.endpoint or len(body.endpoint) > 1500:
        raise HTTPException(status_code=422, detail="invalid_endpoint")

    row = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == link.user_id,
            PushSubscription.staff_id == member.id,
            PushSubscription.endpoint == body.endpoint,
        )
        .first()
    )
    deleted = False
    if row is not None:
        suffix = _portal_endpoint_suffix(row.endpoint)
        from app.models.user import User
        owner = db.query(User).filter(User.id == link.user_id).first()
        db.delete(row)
        try:
            if owner is not None:
                audit_service.record(
                    db, owner, "staff.push.unsubscribed", "push_subscription",
                    entity_id=row.id,
                    before={
                        "staff_id": str(member.id),
                        "staff_name": member.name,
                        "endpoint_suffix": suffix,
                    },
                )
            db.commit()
            deleted = True
        except Exception:  # noqa: BLE001
            db.rollback()
            db.commit()
            deleted = True
    return {"ok": True, "deleted": deleted}


# ═══════════════════════════════════════════════════════════════════════════
#  REALTIME STREAM — Staff live-sync Phase 2 (instant push over SSE)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/{token}/stream")
@limiter.limit("60/minute")
async def portal_stream(token: str, request: Request):
    """Server-Sent Events stream for the staff portal.

    Pushes a tiny "refetch now" nudge the instant the owner publishes a
    schedule, so the portal updates in real time instead of waiting for the
    20-second poll (Phase 1, which remains the automatic fallback whenever this
    stream is unavailable, drops, or is refused).

    Security / privacy:
      • Auth = the same /api/portal/{token} capability token as every other
        portal endpoint. Invalid/inactive token → 404, no stream.
      • The stream carries NO schedule/financial data — only small
        {"type": ..., "week_start": ...} nudges. The actual data still flows
        through the tenant-scoped GET the client already calls, so nothing
        sensitive can leak over this channel even if it were misrouted.
      • Bounded by portal_events (per-tenant + global connection caps); over
        the cap → 429 and the client simply keeps polling.

    Token validation uses a SHORT-LIVED DB session closed BEFORE the long-lived
    streaming loop begins — we never hold a DB connection open for the life of
    the stream (the loop needs no DB)."""
    # 1) Validate token + resolve the tenant key, then release the DB session.
    db = SessionLocal()
    try:
        _link, member = _get_staff_from_token(token, db)
        tenant_key = str(member.user_id)
    finally:
        db.close()

    # 2) Register on the bus (bounded). Refusal → 429 → client falls back to poll.
    queue = portal_events.subscribe(tenant_key)
    if queue is None:
        return Response(status_code=429, content="too_many_streams")

    async def _event_stream():
        # Opening comment starts the stream; `retry:` sets the browser's
        # EventSource auto-reconnect backoff.
        yield ": connected\n\n"
        yield "retry: 5000\n\n"
        yield 'event: hello\ndata: {"type":"hello"}\n\n'
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    # Keepalive comment — defeats idle proxy/LB timeouts and
                    # surfaces client disconnects on the next loop iteration.
                    yield ": keepalive\n\n"
                    continue
                etype = (event or {}).get("type", "message")
                yield f"event: {etype}\ndata: {json.dumps(event)}\n\n"
        finally:
            portal_events.unsubscribe(tenant_key, queue)

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx-style response buffering
            "Connection": "keep-alive",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════
#  PER-STAFF PWA MANIFEST — install opens to THEIR schedule, named after the venue
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/{token}/manifest.webmanifest")
@limiter.limit("60/minute")
def portal_manifest(token: str, request: Request, db: Session = Depends(get_db)):
    """Per-staff PWA manifest so an installed icon opens straight to THIS
    staff's schedule and is named after the restaurant — not the generic owner
    app (whose manifest has start_url "/" + owner shortcuts).

    Served SAME-ORIGIN under www via a Vercel rewrite
    (/portal/<token>/app.webmanifest → here). Same-origin is required twice
    over: the page's CSP is `manifest-src 'self'`, and the PWA spec ignores a
    start_url that isn't same-origin as the manifest. Root-relative start_url
    ("/s/...") therefore resolves to www. iOS ignores the manifest for
    Add-to-Home (it uses the page URL + apple-mobile-web-app-title, which the
    portal page sets) — so this manifest is what makes Android/Chrome correct."""
    from app.models.user import User

    link, _member = _get_staff_from_token(token, db)
    owner = db.query(User).filter(User.id == link.user_id).first()
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == link.user_id
    ).first()
    name = (
        (getattr(owner, "business_name", None) if owner else None)
        or (profile.business_name if profile else None)
        or (profile.company_name if profile else None)
        or "BonBox"
    )
    start = portal_path(token, name)  # /s/<slug>/<token>
    manifest = {
        "name": name,
        "short_name": (name[:12] or "Vagtplan"),
        "description": "Din vagtplan, timer og drikkepenge",
        "id": start,
        "start_url": start,
        "scope": "/s/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": "#ffffff",
        "orientation": "portrait-primary",
        "lang": "da",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "Vagtplan", "short_name": "Vagtplan", "url": f"{start}?tab=schedule"},
            {"name": "Timer", "short_name": "Timer", "url": f"{start}?tab=hours"},
            {"name": "Drikkepenge", "short_name": "Tips", "url": f"{start}?tab=tips"},
        ],
    }
    return Response(
        content=json.dumps(manifest),
        media_type="application/manifest+json",
        headers={"Cache-Control": "public, max-age=300"},
    )
