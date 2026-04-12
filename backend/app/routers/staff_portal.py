"""
Staff Portal — PUBLIC endpoints (no auth required, token-based access).

Staff open a magic link like bonbox.dk/s/j8k2m4 and see their own
schedule, hours, and tips. No login, no password, no account needed.

Endpoints:
  GET    /portal/{token}           — validate link, return staff info
  GET    /portal/{token}/schedule  — their shifts (this + next 2 weeks)
  GET    /portal/{token}/hours     — hours logged for current pay period
  GET    /portal/{token}/tips      — tip distributions for last 30 days
  POST   /portal/{token}/verify-pin — optional PIN verification
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
    Tip, TipDistribution, PayPeriodConfig,
)
from app.models.business_profile import BusinessProfile

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ═══════════════════════════════════════════════════════════════════════════
#  Schemas (kept here since they're portal-specific and small)
# ═══════════════════════════════════════════════════════════════════════════

class PortalInfo(BaseModel):
    staff_name: str
    role: str
    restaurant_name: str | None = None
    has_pin: bool = False
    max_hours_month: float | None = None
    max_hours_week: float | None = None

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
    link.last_accessed = datetime.utcnow()
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
            PortalShift(
                date=s.date,
                start_time=s.start_time,
                end_time=s.end_time,
                break_minutes=s.break_minutes,
                role_on_shift=s.role_on_shift,
                status=s.status,
                net_hours=_calc_hours(s.start_time, s.end_time, s.break_minutes),
            )
            for s in shifts
        ],
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
