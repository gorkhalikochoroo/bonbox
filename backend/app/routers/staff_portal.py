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

import secrets
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from passlib.context import CryptContext

from app.database import get_db
from app.models.staff import (
    StaffMember, StaffLink, Schedule, HoursLogged,
    Tip, TipDistribution, PayPeriodConfig, NotificationLog,
)
from app.models.business_profile import BusinessProfile

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
    return round(max(e - s - brk / 60.0, 0), 1)

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

    # Get restaurant name from business profile
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == link.user_id
    ).first()

    return PortalInfo(
        staff_name=member.name,
        role=member.role or "staff",
        email=member.email,
        phone=member.phone,
        restaurant_name=profile.business_name if profile else None,
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

    notifications = (
        db.query(NotificationLog)
        .filter(NotificationLog.staff_id == member.id)
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


@router.post("/portal/{token}/sick-call", response_model=SickCallPortalResponse)
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


@router.get("/portal/{token}/team-schedule", response_model=list[TeamShift])
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


@router.post("/portal/{token}/swap-requests", response_model=SwapPortalResponse)
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


@router.get("/portal/{token}/swap-requests", response_model=list[SwapPortalResponse])
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
    "/portal/{token}/swap-requests/{swap_id}/respond",
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
    "/portal/{token}/swap-requests/{swap_id}/withdraw",
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
