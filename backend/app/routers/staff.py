"""
Staff Module — members, pay periods, schedules, hours, tips, payroll PDF.

Endpoints:
  # Members
  GET    /members                    — list active staff
  POST   /members                    — create staff member
  PUT    /members/{id}               — update
  DELETE /members/{id}               — soft-deactivate

  # Pay Period
  GET    /pay-period                 — get config (or default)
  POST   /pay-period                 — upsert config
  GET    /pay-period/current         — computed current period dates

  # Schedule
  GET    /schedules                  — shifts for a 7-day week
  POST   /schedules                  — create shift
  PUT    /schedules/{id}             — update shift
  DELETE /schedules/{id}             — delete shift
  POST   /schedules/copy-week        — copy all shifts from one week to another
  POST   /schedules/publish          — publish all draft shifts for a week

  # Hours
  GET    /hours                      — hours for a date range
  POST   /hours                      — log hours
  POST   /hours/confirm-schedule     — bulk-create from published schedule
  PUT    /hours/{id}                 — edit
  DELETE /hours/{id}                 — remove
  GET    /hours/summary              — per-staff summary

  # Tips
  GET    /tips                       — tips with distributions
  POST   /tips                       — create tip with auto-distribution
  PUT    /tips/{id}                  — update (before confirmed)
  POST   /tips/{id}/confirm          — lock distribution

  # Payroll
  POST   /payroll/pdf                — generate payroll PDF
"""

import uuid
import secrets
import calendar
from datetime import date, datetime, timedelta
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models.user import User
from passlib.context import CryptContext
from app.models.staff import (
    StaffMember,
    StaffLink,
    PayPeriodConfig,
    Schedule,
    HoursLogged,
    Tip,
    TipDistribution,
)
from app.models.business_profile import BusinessProfile
from app.schemas.staff import (
    StaffMemberCreate,
    StaffMemberUpdate,
    StaffMemberResponse,
    PayPeriodConfigCreate,
    PayPeriodConfigResponse,
    ScheduleCreate,
    ScheduleResponse,
    HoursLogCreate,
    HoursLogResponse,
    TipCreate,
    TipResponse,
)
from app.services.auth import get_current_user
from app.services.notification_service import (
    detect_shift_changes,
    send_shift_notifications,
    send_single_shift_notification,
    ShiftChange,
)
from app.database import SessionLocal

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════════


def _parse_hhmm(t: str) -> float:
    """Parse 'HH:MM' into fractional hours from midnight."""
    parts = t.split(":")
    return int(parts[0]) + int(parts[1]) / 60.0


def _calc_shift_hours(start_time: str, end_time: str, break_minutes: int) -> float:
    """Calculate net hours for a shift, handling overnight spans."""
    s = _parse_hhmm(start_time)
    e = _parse_hhmm(end_time)
    if e <= s:
        e += 24.0  # overnight shift
    gross = e - s
    net = gross - (break_minutes / 60.0)
    return round(max(net, 0), 1)


def _pick_rate(staff: StaffMember, shift_date: date, start_time: Optional[str]) -> float:
    """Choose dominant rate: weekend > evening > base."""
    base = float(staff.base_rate or 0)
    evening = float(staff.evening_rate or base)
    weekend = float(staff.weekend_rate or base)

    # Weekend check (Saturday=5, Sunday=6)
    if shift_date.weekday() in (5, 6) and weekend > 0:
        return weekend

    # Evening check (dominant hours after 18:00)
    if start_time:
        start_h = _parse_hhmm(start_time)
        if start_h >= 18.0 and evening > 0:
            return evening

    return base


def _compute_pay_period(config: PayPeriodConfig, ref_date: date) -> dict:
    """Compute {start_date, end_date} for the current pay period."""
    ptype = config.period_type

    if ptype == "monthly_1st":
        start = ref_date.replace(day=1)
        last_day = calendar.monthrange(ref_date.year, ref_date.month)[1]
        end = ref_date.replace(day=last_day)

    elif ptype == "monthly_15th":
        if ref_date.day >= 15:
            start = ref_date.replace(day=15)
            # 14th of next month
            if ref_date.month == 12:
                end = date(ref_date.year + 1, 1, 14)
            else:
                end = date(ref_date.year, ref_date.month + 1, 14)
        else:
            # Before the 15th: period started on 15th of previous month
            if ref_date.month == 1:
                start = date(ref_date.year - 1, 12, 15)
            else:
                start = date(ref_date.year, ref_date.month - 1, 15)
            end = ref_date.replace(day=14)

    elif ptype == "biweekly":
        # Every 2 weeks from epoch Monday 2024-01-01
        epoch = date(2024, 1, 1)
        days_since = (ref_date - epoch).days
        period_start_offset = (days_since // 14) * 14
        start = epoch + timedelta(days=period_start_offset)
        end = start + timedelta(days=13)

    elif ptype == "custom":
        csd = config.custom_start_day or 1
        if ref_date.day >= csd:
            start = ref_date.replace(day=csd)
            # Day before next occurrence
            if ref_date.month == 12:
                next_start = date(ref_date.year + 1, 1, csd)
            else:
                next_start = date(ref_date.year, ref_date.month + 1, csd)
            end = next_start - timedelta(days=1)
        else:
            if ref_date.month == 1:
                start = date(ref_date.year - 1, 12, csd)
            else:
                start = date(ref_date.year, ref_date.month - 1, csd)
            end = ref_date.replace(day=csd) - timedelta(days=1)

    else:
        # Fallback to monthly_1st
        start = ref_date.replace(day=1)
        last_day = calendar.monthrange(ref_date.year, ref_date.month)[1]
        end = ref_date.replace(day=last_day)

    return {"start_date": start.isoformat(), "end_date": end.isoformat()}


# ═══════════════════════════════════════════════════════════════════════════
#  STAFF MEMBERS CRUD
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/members", response_model=list[StaffMemberResponse])
def list_staff_members(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    )
    if not include_inactive:
        q = q.filter(StaffMember.active.is_(True))
    return q.order_by(StaffMember.name).all()


@router.post("/members", response_model=StaffMemberResponse)
def create_staff_member(
    data: StaffMemberCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    member = StaffMember(
        id=uuid.uuid4(),
        user_id=user.id,
        name=data.name,
        phone=data.phone,
        email=data.email,
        role=data.role,
        contract_type=data.contract_type,
        base_rate=data.base_rate,
        evening_rate=data.evening_rate,
        weekend_rate=data.weekend_rate,
        holiday_rate=data.holiday_rate,
        max_hours_month=data.max_hours_month,
        max_hours_week=data.max_hours_week,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.put("/members/{member_id}", response_model=StaffMemberResponse)
def update_staff_member(
    member_id: str,
    data: StaffMemberUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(member, field, value)

    db.commit()
    db.refresh(member)
    return member


@router.delete("/members/{member_id}", status_code=204)
def deactivate_staff_member(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")
    member.active = False
    member.updated_at = datetime.utcnow()
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════
#  STAFF PORTAL LINKS (magic links for staff self-service)
# ═══════════════════════════════════════════════════════════════════════════

_pin_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


@router.post("/members/{member_id}/link")
def generate_staff_link(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a magic portal link for a staff member."""
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # Deactivate any existing links
    db.query(StaffLink).filter(
        StaffLink.staff_id == member.id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).update({"active": False})

    # Create new link
    token = secrets.token_urlsafe(24)  # ~32 chars, 192 bits of entropy
    link = StaffLink(
        id=uuid.uuid4(),
        user_id=user.id,
        staff_id=member.id,
        token=token,
        active=True,
    )
    db.add(link)
    db.commit()
    db.refresh(link)

    return {
        "id": str(link.id),
        "staff_id": str(member.id),
        "staff_name": member.name,
        "token": link.token,
        "active": link.active,
        "has_pin": False,
        "portal_url": f"/s/{link.token}",
        "created_at": link.created_at,
    }


@router.get("/members/{member_id}/link")
def get_staff_link(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the active portal link for a staff member."""
    link = db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        return {"active": False}

    member = db.query(StaffMember).filter(StaffMember.id == member_id).first()
    return {
        "id": str(link.id),
        "staff_id": str(link.staff_id),
        "staff_name": member.name if member else "Unknown",
        "token": link.token,
        "active": link.active,
        "has_pin": bool(link.pin_hash),
        "portal_url": f"/s/{link.token}",
        "created_at": link.created_at,
        "last_accessed": link.last_accessed,
    }


@router.delete("/members/{member_id}/link", status_code=204)
def deactivate_staff_link(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Deactivate all portal links for a staff member."""
    db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).update({"active": False})
    db.commit()


class PinSetRequest(BaseModel):
    pin: str  # 4-digit PIN


@router.post("/members/{member_id}/link/pin")
def set_staff_link_pin(
    member_id: str,
    body: PinSetRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set or update PIN for a staff portal link."""
    link = db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="No active link found")

    if not body.pin or len(body.pin) != 4 or not body.pin.isdigit():
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")

    link.pin_hash = _pin_ctx.hash(body.pin)
    db.commit()
    return {"message": "PIN set successfully"}


# ═══════════════════════════════════════════════════════════════════════════
#  PAY PERIOD CONFIG
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/pay-period", response_model=PayPeriodConfigResponse)
def get_pay_period_config(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    config = db.query(PayPeriodConfig).filter(
        PayPeriodConfig.user_id == user.id,
    ).first()
    if not config:
        # Create default config
        config = PayPeriodConfig(
            id=uuid.uuid4(),
            user_id=user.id,
            period_type="monthly_1st",
        )
        db.add(config)
        db.commit()
        db.refresh(config)
    return config


@router.post("/pay-period", response_model=PayPeriodConfigResponse)
def upsert_pay_period_config(
    data: PayPeriodConfigCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    config = db.query(PayPeriodConfig).filter(
        PayPeriodConfig.user_id == user.id,
    ).first()
    if config:
        config.period_type = data.period_type
        config.custom_start_day = data.custom_start_day
        config.updated_at = datetime.utcnow()
    else:
        config = PayPeriodConfig(
            id=uuid.uuid4(),
            user_id=user.id,
            period_type=data.period_type,
            custom_start_day=data.custom_start_day,
        )
        db.add(config)
    db.commit()
    db.refresh(config)
    return config


@router.get("/pay-period/current")
def get_current_pay_period(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    config = db.query(PayPeriodConfig).filter(
        PayPeriodConfig.user_id == user.id,
    ).first()
    if not config:
        config = PayPeriodConfig(
            id=uuid.uuid4(),
            user_id=user.id,
            period_type="monthly_1st",
        )
        db.add(config)
        db.commit()
        db.refresh(config)
    return _compute_pay_period(config, date.today())


# ═══════════════════════════════════════════════════════════════════════════
#  SCHEDULES
# ═══════════════════════════════════════════════════════════════════════════


class CopyWeekBody(BaseModel):
    source_week: date
    target_week: date


@router.get("/schedules", response_model=list[ScheduleResponse])
def list_schedules(
    week_start: date = Query(..., description="Monday of the target week (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    week_end = week_start + timedelta(days=6)
    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
        )
        .order_by(Schedule.date, Schedule.start_time)
        .all()
    )
    return shifts


@router.post("/schedules", response_model=ScheduleResponse)
def create_schedule(
    data: ScheduleCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify staff belongs to user
    staff = db.query(StaffMember).filter(
        StaffMember.id == data.staff_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")

    shift = Schedule(
        id=uuid.uuid4(),
        user_id=user.id,
        staff_id=data.staff_id,
        date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
        break_minutes=data.break_minutes,
        role_on_shift=data.role_on_shift,
        status=data.status,
        notes=data.notes,
    )
    db.add(shift)
    db.commit()
    db.refresh(shift)
    return shift


@router.put("/schedules/{schedule_id}", response_model=ScheduleResponse)
def update_schedule(
    schedule_id: str,
    data: ScheduleCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    shift = db.query(Schedule).filter(
        Schedule.id == schedule_id,
        Schedule.user_id == user.id,
    ).first()
    if not shift:
        raise HTTPException(status_code=404, detail="Schedule not found")

    # Snapshot old values for notification (only if published)
    was_published = shift.status == "published"
    old_start = shift.start_time
    old_end = shift.end_time
    old_staff_id = shift.staff_id
    old_date = str(shift.date)

    shift.staff_id = data.staff_id
    shift.date = data.date
    shift.start_time = data.start_time
    shift.end_time = data.end_time
    shift.break_minutes = data.break_minutes
    shift.role_on_shift = data.role_on_shift
    shift.status = data.status
    shift.notes = data.notes
    db.commit()
    db.refresh(shift)

    # Notify staff if a published shift was modified
    if was_published and (old_start != data.start_time or old_end != data.end_time):
        user_id = user.id
        staff_id = old_staff_id
        change = ShiftChange(
            change_type="modified",
            date=old_date,
            old_start=old_start,
            old_end=old_end,
            new_start=data.start_time,
            new_end=data.end_time,
            role=data.role_on_shift,
        )

        def _send_bg():
            bg_db = SessionLocal()
            try:
                send_single_shift_notification(bg_db, user_id, staff_id, change, "shift_changed")
            finally:
                bg_db.close()

        background_tasks.add_task(_send_bg)

    return shift


@router.delete("/schedules/{schedule_id}", status_code=204)
def delete_schedule(
    schedule_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    shift = db.query(Schedule).filter(
        Schedule.id == schedule_id,
        Schedule.user_id == user.id,
    ).first()
    if not shift:
        raise HTTPException(status_code=404, detail="Schedule not found")

    # Snapshot for notification before deleting
    was_published = shift.status == "published"
    staff_id = shift.staff_id
    shift_date = str(shift.date)
    shift_start = shift.start_time
    shift_end = shift.end_time
    shift_role = shift.role_on_shift

    db.delete(shift)
    db.commit()

    # Notify staff if a published shift was deleted
    if was_published:
        user_id = user.id
        change = ShiftChange(
            change_type="removed",
            date=shift_date,
            old_start=shift_start,
            old_end=shift_end,
            role=shift_role,
        )

        def _send_bg():
            bg_db = SessionLocal()
            try:
                send_single_shift_notification(bg_db, user_id, staff_id, change, "shift_deleted")
            finally:
                bg_db.close()

        background_tasks.add_task(_send_bg)


@router.post("/schedules/copy-week")
def copy_week(
    body: CopyWeekBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    source_end = body.source_week + timedelta(days=6)
    source_shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= body.source_week,
            Schedule.date <= source_end,
        )
        .all()
    )
    if not source_shifts:
        raise HTTPException(status_code=404, detail="No shifts found in source week")

    day_offset = (body.target_week - body.source_week).days
    created = []
    for s in source_shifts:
        new_shift = Schedule(
            id=uuid.uuid4(),
            user_id=user.id,
            staff_id=s.staff_id,
            date=s.date + timedelta(days=day_offset),
            start_time=s.start_time,
            end_time=s.end_time,
            break_minutes=s.break_minutes,
            role_on_shift=s.role_on_shift,
            status="draft",
            notes=s.notes,
        )
        db.add(new_shift)
        created.append(new_shift)

    db.commit()
    return {"copied": len(created), "target_week": body.target_week.isoformat()}


@router.post("/schedules/publish")
def publish_week(
    background_tasks: BackgroundTasks,
    week_start: date = Query(..., description="Monday of the week to publish"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    week_end = week_start + timedelta(days=6)

    # Snapshot existing published shifts BEFORE publishing new ones
    old_published = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        )
        .all()
    )
    old_snapshot = [
        {
            "staff_id": str(s.staff_id),
            "date": str(s.date),
            "start_time": s.start_time,
            "end_time": s.end_time,
            "role_on_shift": s.role_on_shift,
        }
        for s in old_published
    ]

    # Get draft shifts that will be published
    drafts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "draft",
        )
        .all()
    )

    updated = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "draft",
        )
        .update({"status": "published"})
    )
    db.commit()

    # Build new snapshot (all published shifts after update)
    all_published = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        )
        .all()
    )
    new_snapshot = [
        {
            "staff_id": str(s.staff_id),
            "date": str(s.date),
            "start_time": s.start_time,
            "end_time": s.end_time,
            "role_on_shift": s.role_on_shift,
        }
        for s in all_published
    ]

    # Detect changes and send notifications in background
    changes = detect_shift_changes(old_snapshot, new_snapshot)
    if changes:
        user_id = user.id
        week_label = f"Week of {week_start.strftime('%d %b %Y')}"

        def _send_bg():
            bg_db = SessionLocal()
            try:
                send_shift_notifications(bg_db, user_id, changes, week_label)
            finally:
                bg_db.close()

        background_tasks.add_task(_send_bg)

    return {"published": updated, "week_start": week_start.isoformat()}


# ═══════════════════════════════════════════════════════════════════════════
#  HOURS
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/hours", response_model=list[HoursLogResponse])
def list_hours(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    staff_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(HoursLogged).filter(
        HoursLogged.user_id == user.id,
        HoursLogged.date >= from_date,
        HoursLogged.date <= to_date,
    )
    if staff_id:
        q = q.filter(HoursLogged.staff_id == staff_id)
    return q.order_by(HoursLogged.date, HoursLogged.staff_id).all()


@router.post("/hours", response_model=HoursLogResponse)
def log_hours(
    data: HoursLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify staff
    staff = db.query(StaffMember).filter(
        StaffMember.id == data.staff_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")

    total_hours = data.total_hours
    entry_method = data.entry_method

    # If clock-in/out times provided, calculate hours from them
    if data.start_time and data.end_time:
        total_hours = _calc_shift_hours(data.start_time, data.end_time, data.break_minutes)
        entry_method = "clock"

    # Pick rate and compute earned
    rate = data.rate_applied if data.rate_applied else _pick_rate(staff, data.date, data.start_time)
    earned = data.earned if data.earned is not None else round(total_hours * rate, 2)

    entry = HoursLogged(
        id=uuid.uuid4(),
        user_id=user.id,
        staff_id=data.staff_id,
        date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
        break_minutes=data.break_minutes,
        total_hours=total_hours,
        rate_applied=rate,
        earned=earned,
        entry_method=entry_method,
        is_overtime=data.is_overtime,
        notes=data.notes,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.post("/hours/confirm-schedule")
def confirm_schedule_hours(
    week_start: date = Query(..., description="Monday of the week"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Bulk-create hours entries from published schedule shifts for the week."""
    week_end = week_start + timedelta(days=6)
    published_shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        )
        .all()
    )
    if not published_shifts:
        raise HTTPException(status_code=404, detail="No published shifts for this week")

    # Pre-load staff members for rate lookup
    staff_ids = list({s.staff_id for s in published_shifts})
    staff_map = {}
    for sid in staff_ids:
        m = db.query(StaffMember).filter(StaffMember.id == sid).first()
        if m:
            staff_map[sid] = m

    created = 0
    for shift in published_shifts:
        # Skip if hours already logged for this staff+date+time combo
        existing = db.query(HoursLogged).filter(
            HoursLogged.user_id == user.id,
            HoursLogged.staff_id == shift.staff_id,
            HoursLogged.date == shift.date,
            HoursLogged.start_time == shift.start_time,
            HoursLogged.end_time == shift.end_time,
        ).first()
        if existing:
            continue

        total_hours = _calc_shift_hours(shift.start_time, shift.end_time, shift.break_minutes)
        staff = staff_map.get(shift.staff_id)
        rate = _pick_rate(staff, shift.date, shift.start_time) if staff else 0
        earned = round(total_hours * rate, 2)

        entry = HoursLogged(
            id=uuid.uuid4(),
            user_id=user.id,
            staff_id=shift.staff_id,
            date=shift.date,
            start_time=shift.start_time,
            end_time=shift.end_time,
            break_minutes=shift.break_minutes,
            total_hours=total_hours,
            rate_applied=rate,
            earned=earned,
            entry_method="schedule",
            notes=f"From published schedule",
        )
        db.add(entry)
        created += 1

    db.commit()
    return {"created": created, "week_start": week_start.isoformat()}


@router.put("/hours/{hours_id}", response_model=HoursLogResponse)
def update_hours(
    hours_id: str,
    data: HoursLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    entry = db.query(HoursLogged).filter(
        HoursLogged.id == hours_id,
        HoursLogged.user_id == user.id,
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Hours entry not found")

    staff = db.query(StaffMember).filter(
        StaffMember.id == data.staff_id,
        StaffMember.user_id == user.id,
    ).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")

    total_hours = data.total_hours
    entry_method = data.entry_method

    if data.start_time and data.end_time:
        total_hours = _calc_shift_hours(data.start_time, data.end_time, data.break_minutes)
        entry_method = "clock"

    rate = data.rate_applied if data.rate_applied else _pick_rate(staff, data.date, data.start_time)
    earned = data.earned if data.earned is not None else round(total_hours * rate, 2)

    entry.staff_id = data.staff_id
    entry.date = data.date
    entry.start_time = data.start_time
    entry.end_time = data.end_time
    entry.break_minutes = data.break_minutes
    entry.total_hours = total_hours
    entry.rate_applied = rate
    entry.earned = earned
    entry.entry_method = entry_method
    entry.is_overtime = data.is_overtime
    entry.notes = data.notes
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/hours/{hours_id}", status_code=204)
def delete_hours(
    hours_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    entry = db.query(HoursLogged).filter(
        HoursLogged.id == hours_id,
        HoursLogged.user_id == user.id,
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Hours entry not found")
    db.delete(entry)
    db.commit()


@router.get("/hours/summary")
def hours_summary(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Per-staff summary: total_hours, total_earned, overtime_hours, tips_received.

    Multi-layer defense:
      - Hours and tips queried independently — if one fails, the other still
        contributes to the page so users see *some* accurate data.
      - Per-staff name lookup wrapped — schema drift on StaffMember doesn't tank
        the whole summary; we fall back to "Staff #<id>".
      - Overtime uses sqlalchemy.case (not func.case which doesn't exist in
        SQLAlchemy 2.x) — this was the original aggregation bug.
    """
    import logging
    log = logging.getLogger("bonbox.staff_payroll")

    # Hours aggregation — defensive
    try:
        hours_rows = (
            db.query(
                HoursLogged.staff_id,
                func.sum(HoursLogged.total_hours).label("total_hours"),
                func.sum(HoursLogged.earned).label("total_earned"),
                func.sum(
                    case(
                        (HoursLogged.is_overtime.is_(True), HoursLogged.total_hours),
                        else_=0,
                    )
                ).label("overtime_hours"),
            )
            .filter(
                HoursLogged.user_id == user.id,
                HoursLogged.date >= from_date,
                HoursLogged.date <= to_date,
            )
            .group_by(HoursLogged.staff_id)
            .all()
        )
    except Exception as e:
        # Fallback: drop overtime aggregation if `is_overtime` column is missing
        # on stale schemas. Better to return correct hours+earned with overtime=0
        # than to fail the whole report.
        log.warning("hours_summary: overtime aggregation failed (%s); falling back", e)
        try:
            hours_rows = (
                db.query(
                    HoursLogged.staff_id,
                    func.sum(HoursLogged.total_hours).label("total_hours"),
                    func.sum(HoursLogged.earned).label("total_earned"),
                )
                .filter(
                    HoursLogged.user_id == user.id,
                    HoursLogged.date >= from_date,
                    HoursLogged.date <= to_date,
                )
                .group_by(HoursLogged.staff_id)
                .all()
            )
            # Synthesise overtime_hours=0 on each row for shape consistency
            hours_rows = [
                type("Row", (), {
                    "staff_id": r.staff_id,
                    "total_hours": r.total_hours,
                    "total_earned": r.total_earned,
                    "overtime_hours": 0,
                })()
                for r in hours_rows
            ]
        except Exception as e2:
            log.exception("hours_summary: fallback hours query failed: %s", e2)
            hours_rows = []

    # Tips aggregation — independent so it won't be killed by a hours failure
    try:
        tips_rows = (
            db.query(
                TipDistribution.staff_id,
                func.sum(TipDistribution.amount).label("tips_received"),
            )
            .join(Tip, Tip.id == TipDistribution.tip_id)
            .filter(
                Tip.user_id == user.id,
                Tip.date >= from_date,
                Tip.date <= to_date,
            )
            .group_by(TipDistribution.staff_id)
            .all()
        )
        tips_map = {str(r.staff_id): float(r.tips_received or 0) for r in tips_rows}
    except Exception as e:
        log.warning("hours_summary: tips aggregation failed: %s", e)
        tips_map = {}

    # Staff names — wrapped so a corrupt member row doesn't kill the report
    staff_ids = list({str(r.staff_id) for r in hours_rows} | set(tips_map.keys()))
    staff_names = {}
    if staff_ids:
        try:
            members = db.query(StaffMember).filter(StaffMember.id.in_(staff_ids)).all()
            staff_names = {str(m.id): (m.name or "Unknown") for m in members}
        except Exception as e:
            log.warning("hours_summary: staff name lookup failed: %s", e)
            staff_names = {}

    summary = []
    for r in hours_rows:
        sid = str(r.staff_id)
        summary.append({
            "staff_id": sid,
            "staff_name": staff_names.get(sid, f"Staff #{sid[:8]}"),
            "total_hours": round(float(r.total_hours or 0), 1),
            "total_earned": round(float(r.total_earned or 0), 2),
            "overtime_hours": round(float(r.overtime_hours or 0), 1),
            "tips_received": round(tips_map.get(sid, 0), 2),
        })

    # Include staff who only have tips but no hours
    hours_staff_ids = {str(r.staff_id) for r in hours_rows}
    for sid, tip_amount in tips_map.items():
        if sid not in hours_staff_ids:
            summary.append({
                "staff_id": sid,
                "staff_name": staff_names.get(sid, f"Staff #{sid[:8]}"),
                "total_hours": 0,
                "total_earned": 0,
                "overtime_hours": 0,
                "tips_received": round(tip_amount, 2),
            })

    return summary


# ═══════════════════════════════════════════════════════════════════════════
#  TIPS
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/tips", response_model=list[TipResponse])
def list_tips(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tips = (
        db.query(Tip)
        .filter(
            Tip.user_id == user.id,
            Tip.date >= from_date,
            Tip.date <= to_date,
        )
        .order_by(Tip.date.desc())
        .all()
    )
    return tips


@router.post("/tips", response_model=TipResponse)
def create_tip(
    data: TipCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tip = Tip(
        id=uuid.uuid4(),
        user_id=user.id,
        date=data.date,
        total_amount=data.total_amount,
        split_method=data.split_method,
        notes=data.notes,
    )
    db.add(tip)
    db.flush()  # get tip.id for distributions

    if data.staff_hours:
        if data.split_method == "by_hours":
            total_hours = sum(sh.hours for sh in data.staff_hours)
            for sh in data.staff_hours:
                pct = (sh.hours / total_hours * 100) if total_hours > 0 else 0
                amount = round(data.total_amount * sh.hours / total_hours, 2) if total_hours > 0 else 0
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=sh.staff_id,
                    share_pct=round(pct, 2),
                    amount=amount,
                )
                db.add(dist)

        elif data.split_method == "by_role":
            # Look up contract types to assign shares
            staff_ids = [sh.staff_id for sh in data.staff_hours]
            members = db.query(StaffMember).filter(StaffMember.id.in_(staff_ids)).all()
            contract_map = {str(m.id): m.contract_type for m in members}

            shares = {}
            for sh in data.staff_hours:
                ct = contract_map.get(str(sh.staff_id), "full")
                shares[sh.staff_id] = 1.0 if ct == "full" else 0.5

            total_shares = sum(shares.values())
            for staff_id, share in shares.items():
                pct = (share / total_shares * 100) if total_shares > 0 else 0
                amount = round(data.total_amount * share / total_shares, 2) if total_shares > 0 else 0
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=staff_id,
                    share_pct=round(pct, 2),
                    amount=amount,
                )
                db.add(dist)

        else:
            # Equal split fallback
            count = len(data.staff_hours)
            per_person = round(data.total_amount / count, 2) if count > 0 else 0
            pct = round(100.0 / count, 2) if count > 0 else 0
            for sh in data.staff_hours:
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=sh.staff_id,
                    share_pct=pct,
                    amount=per_person,
                )
                db.add(dist)

    db.commit()
    db.refresh(tip)
    return tip


@router.put("/tips/{tip_id}", response_model=TipResponse)
def update_tip(
    tip_id: str,
    data: TipCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tip = db.query(Tip).filter(
        Tip.id == tip_id,
        Tip.user_id == user.id,
    ).first()
    if not tip:
        raise HTTPException(status_code=404, detail="Tip not found")
    if tip.confirmed:
        raise HTTPException(status_code=400, detail="Cannot edit a confirmed tip")

    tip.date = data.date
    tip.total_amount = data.total_amount
    tip.split_method = data.split_method
    tip.notes = data.notes

    # Delete old distributions and recreate
    db.query(TipDistribution).filter(TipDistribution.tip_id == tip.id).delete()
    db.flush()

    if data.staff_hours:
        if data.split_method == "by_hours":
            total_hours = sum(sh.hours for sh in data.staff_hours)
            for sh in data.staff_hours:
                pct = (sh.hours / total_hours * 100) if total_hours > 0 else 0
                amount = round(data.total_amount * sh.hours / total_hours, 2) if total_hours > 0 else 0
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=sh.staff_id,
                    share_pct=round(pct, 2),
                    amount=amount,
                )
                db.add(dist)

        elif data.split_method == "by_role":
            staff_ids = [sh.staff_id for sh in data.staff_hours]
            members = db.query(StaffMember).filter(StaffMember.id.in_(staff_ids)).all()
            contract_map = {str(m.id): m.contract_type for m in members}

            shares = {}
            for sh in data.staff_hours:
                ct = contract_map.get(str(sh.staff_id), "full")
                shares[sh.staff_id] = 1.0 if ct == "full" else 0.5

            total_shares = sum(shares.values())
            for staff_id, share in shares.items():
                pct = (share / total_shares * 100) if total_shares > 0 else 0
                amount = round(data.total_amount * share / total_shares, 2) if total_shares > 0 else 0
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=staff_id,
                    share_pct=round(pct, 2),
                    amount=amount,
                )
                db.add(dist)

        else:
            count = len(data.staff_hours)
            per_person = round(data.total_amount / count, 2) if count > 0 else 0
            pct = round(100.0 / count, 2) if count > 0 else 0
            for sh in data.staff_hours:
                dist = TipDistribution(
                    id=uuid.uuid4(),
                    tip_id=tip.id,
                    staff_id=sh.staff_id,
                    share_pct=pct,
                    amount=per_person,
                )
                db.add(dist)

    db.commit()
    db.refresh(tip)
    return tip


@router.post("/tips/{tip_id}/confirm", response_model=TipResponse)
def confirm_tip(
    tip_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tip = db.query(Tip).filter(
        Tip.id == tip_id,
        Tip.user_id == user.id,
    ).first()
    if not tip:
        raise HTTPException(status_code=404, detail="Tip not found")
    tip.confirmed = True
    db.commit()
    db.refresh(tip)
    return tip


# ═══════════════════════════════════════════════════════════════════════════
#  PAYROLL PDF
# ═══════════════════════════════════════════════════════════════════════════


class PayrollPDFRequest(BaseModel):
    period_start: date
    period_end: date
    staff_ids: list[str] | None = None


@router.get("/payroll/estimate")
def estimate_payroll(
    period_start: date,
    period_end: date,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Danish payroll estimate for a period.

    Returns gross + AM-bidrag + A-skat estimate + ATP + feriepenge,
    aggregated and per-staff. Marked is_estimate=True — the official
    A-skat figure comes from each employee's trækkort via eIndkomst,
    which only certified providers can call. This is for planning the
    10th-of-month deadline.

    Multi-tenant: only this user's staff hours are aggregated. No CPR
    handling, no SKAT submission, no bank file — pure math on the user's
    own data.
    """
    from app.services.payroll_service import estimate_period_payroll
    return estimate_period_payroll(db, user.id, period_start, period_end)


@router.get("/payroll/csv")
def export_payroll_csv(
    period_start: date,
    period_end: date,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Hours + gross wages CSV — drop-in import for DataLøn / Zenegy / Salary.

    Format: Name, Role, Contract type, Hours, Gross wage, Period start, Period end.
    Names match the universal columns these systems accept; users map them
    once in their lønsystem then re-import each period.

    Why CSV (not direct submit): submitting to SKAT/eIndkomst requires
    certification we don't have. The user's lønsystem (already certified)
    handles the official submission — we just save them the typing.

    Multi-layer defense: if payroll service errors, we still export an
    empty CSV with headers so the user's import job doesn't crash.
    """
    import csv
    import io
    from app.services.payroll_service import estimate_period_payroll

    try:
        est = estimate_period_payroll(db, user.id, period_start, period_end)
    except Exception:  # noqa: BLE001
        est = {"per_staff": []}

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")  # DK lønsystems prefer ; (Excel locale)
    writer.writerow([
        "Name", "Role", "Contract", "Hours", "Gross (DKK)",
        "AM-bidrag (8%)", "A-skat (est.)", "Net pay", "Period start", "Period end",
    ])
    for s in est.get("per_staff", []):
        writer.writerow([
            s.get("name", ""),
            s.get("role", ""),
            s.get("contract_type", ""),
            f"{float(s.get('hours', 0)):.2f}",
            f"{float(s.get('gross', 0)):.2f}",
            f"{float(s.get('am_bidrag', 0)):.2f}",
            f"{float(s.get('a_skat', 0)):.2f}",
            f"{float(s.get('net_pay', 0)):.2f}",
            str(period_start),
            str(period_end),
        ])

    csv_bytes = buf.getvalue().encode("utf-8-sig")  # BOM for Excel locale handling
    filename = f"bonbox_payroll_{period_start}_{period_end}.csv"
    return StreamingResponse(
        iter([csv_bytes]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/payroll/loenseddel")
def loenseddel_pdf(
    period_start: date,
    period_end: date,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Generate Danish Lønseddel PDFs (one page per active employee) — DK standard
    layout with Copenhagen-clean styling. Multi-tenant filtered.

    Layout per employee:
      [Header: business / period / "LØNSEDDEL"]
      [Employer info | Employee info — two columns]
      [Wage breakdown table]
      [Deductions table]
      [Employer contributions table]
      [Footer: estimate disclaimer]

    Multi-layer defense:
      - reportlab import inside fn so module loads even if lib missing
      - empty staff/period returns 404 (don't ship a blank PDF)
      - per-employee try/except: one bad row doesn't kill the whole PDF
    """
    from app.services.payroll_service import estimate_period_payroll

    est = estimate_period_payroll(db, user.id, period_start, period_end)
    if est["staff_count"] == 0 or not est["per_staff"]:
        raise HTTPException(404, "No staff with hours logged in this period")

    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
            HRFlowable, PageBreak,
        )
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_RIGHT
    except ImportError:
        raise HTTPException(500, "PDF library not available")

    # Copenhagen-clean palette: warm-white bg, near-black text, single accent
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    ACCENT = colors.HexColor("#1f2937")  # subdued dark accent

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title="Lønseddel",
    )

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=2,
                        textColor=INK, fontName="Helvetica-Bold")
    h_period = ParagraphStyle("Period", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, alignment=TA_RIGHT, fontName="Helvetica")
    label = ParagraphStyle("Label", parent=styles["Normal"], fontSize=8.5,
                           textColor=MUTED, fontName="Helvetica",
                           leading=12, spaceAfter=1)
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=10.5,
                         textColor=INK, fontName="Helvetica", leading=14)
    section_title = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8.5,
                                   textColor=MUTED, fontName="Helvetica-Bold",
                                   leading=12, spaceBefore=10, spaceAfter=4)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    # Employer info
    biz_name = (profile.business_name if profile and profile.business_name else user.business_name) or "Business"
    biz_addr_parts = []
    if profile:
        if profile.address: biz_addr_parts.append(profile.address)
        zip_city = " ".join(p for p in [getattr(profile, "zipcode", None), getattr(profile, "city", None)] if p)
        if zip_city: biz_addr_parts.append(zip_city)
    biz_addr = "<br/>".join(biz_addr_parts) or "—"
    biz_cvr = f"CVR {profile.org_number}" if profile and getattr(profile, "org_number", None) else ""

    period_label = f"{period_start.isoformat()} — {period_end.isoformat()}"

    def _money(v):
        if v is None:
            return "—"
        return f"{float(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    def _row(desc, amount, bold=False, indent=False):
        d = f"<b>{desc}</b>" if bold else desc
        a = f"<b>{_money(amount)}</b>" if bold else _money(amount)
        prefix = "&nbsp;&nbsp;&nbsp;" if indent else ""
        return [Paragraph(prefix + d, val), Paragraph(a, ParagraphStyle("Money", parent=val, alignment=TA_RIGHT))]

    story = []
    page_count = 0
    for s in est["per_staff"]:
        if page_count > 0:
            story.append(PageBreak())
        page_count += 1

        try:
            # Header row: title left, period right
            head_table = Table(
                [[Paragraph("LØNSEDDEL", h1), Paragraph(period_label, h_period)]],
                colWidths=[100 * mm, 66 * mm],
            )
            head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
            story.append(head_table)
            story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=4, spaceAfter=12))

            # Two-column employer / employee info
            employer_html = (
                f"<font name='Helvetica-Bold' size='10.5'>{biz_name}</font><br/>"
                f"<font color='#6b7280'>{biz_addr}</font><br/>"
                f"<font color='#6b7280'>{biz_cvr}</font>"
            )
            employee_html = (
                f"<font name='Helvetica-Bold' size='10.5'>{s.get('name', '—')}</font><br/>"
                f"<font color='#6b7280'>Role: {s.get('role') or '—'}</font><br/>"
                f"<font color='#6b7280'>Contract: {s.get('contract_type') or '—'}</font><br/>"
                f"<font color='#6b7280'>Hours: {float(s.get('hours', 0)):.2f}</font>"
            )
            info_table = Table(
                [[Paragraph("EMPLOYER", section_title), Paragraph("EMPLOYEE", section_title)],
                 [Paragraph(employer_html, val), Paragraph(employee_html, val)]],
                colWidths=[83 * mm, 83 * mm],
            )
            info_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.append(info_table)
            story.append(Spacer(1, 12 * mm))

            # Wage breakdown
            story.append(Paragraph("WAGE BREAKDOWN", section_title))
            wage_rows = [
                _row("Gross wage", s.get("gross"), bold=True),
            ]
            wage_table = Table(wage_rows, colWidths=[100 * mm, 66 * mm])
            wage_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("LINEBELOW", (0, -1), (-1, -1), 0.5, DIVIDER),
            ]))
            story.append(wage_table)

            # Deductions
            story.append(Paragraph("DEDUCTIONS", section_title))
            ded_rows = [
                _row("AM-bidrag (8%)", -float(s.get("am_bidrag") or 0), indent=True),
                _row("A-skat (estimate ≈ 36%)", -float(s.get("a_skat") or 0), indent=True),
                _row("Net pay", s.get("net_pay"), bold=True),
            ]
            ded_table = Table(ded_rows, colWidths=[100 * mm, 66 * mm])
            ded_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
            ]))
            story.append(ded_table)

            # Employer contributions
            story.append(Paragraph("EMPLOYER CONTRIBUTIONS", section_title))
            emp_rows = [
                _row("ATP", s.get("atp"), indent=True),
                _row("Feriepenge (12.5%)", s.get("feriepenge"), indent=True),
                _row("Total employer cost", s.get("employer_total_cost"), bold=True),
            ]
            emp_table = Table(emp_rows, colWidths=[100 * mm, 66 * mm])
            emp_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
            ]))
            story.append(emp_table)

            # Footer disclaimer
            story.append(Spacer(1, 14 * mm))
            story.append(Paragraph(
                "A-skat shown is an estimate (≈36% after personfradrag). The official "
                "figure depends on each employee's trækkort and is computed by your "
                "lønsystem (DataLøn / Zenegy / Visma) or by SKAT via eIndkomst. Use "
                "this lønseddel for internal records; submit official wages via your "
                "certified lønsystem.",
                foot,
            ))
        except Exception as e:  # noqa: BLE001
            import logging as _logging
            _logging.getLogger("bonbox.loenseddel").warning(
                "loenseddel: failed to render employee %s: %s", s.get("name"), e,
            )
            story.append(Paragraph(
                f"Could not render lønseddel for {s.get('name', 'employee')} — please check the data.",
                foot,
            ))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    filename = f"bonbox_loenseddel_{period_start}_{period_end}.pdf"
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/payroll/pdf")
def generate_payroll_pdf(
    body: PayrollPDFRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Gather staff
    staff_q = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    )
    if body.staff_ids:
        staff_q = staff_q.filter(StaffMember.id.in_(body.staff_ids))
    staff_list = staff_q.order_by(StaffMember.name).all()
    if not staff_list:
        raise HTTPException(status_code=404, detail="No staff found")

    staff_map = {str(m.id): m for m in staff_list}
    staff_ids = list(staff_map.keys())

    # Gather hours
    hours = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == user.id,
            HoursLogged.date >= body.period_start,
            HoursLogged.date <= body.period_end,
            HoursLogged.staff_id.in_(staff_ids),
        )
        .order_by(HoursLogged.date)
        .all()
    )

    # Gather tips
    tip_rows = (
        db.query(
            TipDistribution.staff_id,
            func.sum(TipDistribution.amount).label("tips_total"),
        )
        .join(Tip, Tip.id == TipDistribution.tip_id)
        .filter(
            Tip.user_id == user.id,
            Tip.date >= body.period_start,
            Tip.date <= body.period_end,
            TipDistribution.staff_id.in_(staff_ids),
        )
        .group_by(TipDistribution.staff_id)
        .all()
    )
    tips_map = {str(r.staff_id): float(r.tips_total or 0) for r in tip_rows}

    # Aggregate per staff
    staff_data = {}
    for sid in staff_ids:
        staff_data[sid] = {
            "name": staff_map[sid].name,
            "role": staff_map[sid].role,
            "contract_type": staff_map[sid].contract_type,
            "total_hours": 0.0,
            "overtime_hours": 0.0,
            "total_earned": 0.0,
            "tips": tips_map.get(sid, 0.0),
            "entries": [],
        }

    for h in hours:
        sid = str(h.staff_id)
        if sid not in staff_data:
            continue
        staff_data[sid]["total_hours"] += float(h.total_hours or 0)
        staff_data[sid]["total_earned"] += float(h.earned or 0)
        if h.is_overtime:
            staff_data[sid]["overtime_hours"] += float(h.total_hours or 0)
        staff_data[sid]["entries"].append(h)

    # Business profile
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    currency = user.currency or "DKK"

    # Build PDF
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=20 * mm, bottomMargin=15 * mm,
        leftMargin=20 * mm, rightMargin=20 * mm,
    )
    styles = getSampleStyleSheet()
    story = []

    fmt = lambda v: f"{v:,.2f} {currency}" if v is not None else "---"

    # ── Title page ──
    title_style = ParagraphStyle("Title", parent=styles["Title"], fontSize=18, spaceAfter=4)
    story.append(Paragraph("Payroll Report", title_style))

    biz_name = profile.business_name if profile else ""
    if biz_name:
        story.append(Paragraph(biz_name, styles["Heading3"]))
    if profile:
        addr_parts = [p for p in [profile.address, profile.zipcode, profile.city] if p]
        if addr_parts:
            story.append(Paragraph(", ".join(addr_parts), styles["Normal"]))
        if profile.org_number:
            story.append(Paragraph(f"CVR: {profile.org_number}", styles["Normal"]))

    story.append(Paragraph(
        f"Period: {body.period_start.strftime('%d %B %Y')} - {body.period_end.strftime('%d %B %Y')}",
        styles["Normal"],
    ))
    story.append(Spacer(1, 10 * mm))

    # ── Per-staff pages ──
    for sid in staff_ids:
        sd = staff_data[sid]

        story.append(Paragraph(sd["name"], styles["Heading2"]))
        story.append(Paragraph(
            f"Role: {sd['role']}  |  Contract: {sd['contract_type']}",
            styles["Normal"],
        ))
        story.append(Spacer(1, 4 * mm))

        # Hours detail table
        if sd["entries"]:
            detail_data = [["Date", "Time", "Break", "Hours", "Rate", "Earned"]]
            for h in sd["entries"]:
                time_str = f"{h.start_time or '---'} - {h.end_time or '---'}"
                detail_data.append([
                    h.date.strftime("%d/%m"),
                    time_str,
                    f"{h.break_minutes}m",
                    f"{float(h.total_hours):.1f}",
                    fmt(h.rate_applied),
                    fmt(h.earned),
                ])

            t = Table(detail_data, colWidths=[22 * mm, 32 * mm, 18 * mm, 18 * mm, 30 * mm, 30 * mm])
            # Copenhagen-clean: subtle gray header, hairline rules, no harsh GRID
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#374151")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 8),
                ("FONTSIZE", (0, 1), (-1, -1), 8.5),
                ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#d1d5db")),
                ("LINEBELOW", (0, -1), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(t)
            story.append(Spacer(1, 4 * mm))

        # Staff totals
        grand_total = sd["total_earned"] + sd["tips"]
        totals_data = [
            ["Total Hours", f"{sd['total_hours']:.1f}"],
            ["Overtime Hours", f"{sd['overtime_hours']:.1f}"],
            ["Total Earned", fmt(sd["total_earned"])],
            ["Tips Received", fmt(sd["tips"])],
            ["GRAND TOTAL", fmt(grand_total)],
        ]
        t = Table(totals_data, colWidths=[80 * mm, 60 * mm])
        t.setStyle(TableStyle([
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 4 * mm))
        story.append(HRFlowable(width="100%", color=colors.HexColor("#cccccc")))
        story.append(Spacer(1, 6 * mm))

    # ── Summary page ──
    story.append(PageBreak())
    story.append(Paragraph("Summary - All Staff", styles["Heading2"]))
    story.append(Spacer(1, 4 * mm))

    sum_data = [["Staff", "Hours", "Overtime", "Earned", "Tips", "Total"]]
    grand_hours = 0.0
    grand_overtime = 0.0
    grand_earned = 0.0
    grand_tips = 0.0
    grand_total = 0.0

    for sid in staff_ids:
        sd = staff_data[sid]
        row_total = sd["total_earned"] + sd["tips"]
        sum_data.append([
            sd["name"],
            f"{sd['total_hours']:.1f}",
            f"{sd['overtime_hours']:.1f}",
            fmt(sd["total_earned"]),
            fmt(sd["tips"]),
            fmt(row_total),
        ])
        grand_hours += sd["total_hours"]
        grand_overtime += sd["overtime_hours"]
        grand_earned += sd["total_earned"]
        grand_tips += sd["tips"]
        grand_total += row_total

    sum_data.append([
        "TOTAL",
        f"{grand_hours:.1f}",
        f"{grand_overtime:.1f}",
        fmt(grand_earned),
        fmt(grand_tips),
        fmt(grand_total),
    ])

    t = Table(sum_data, colWidths=[35 * mm, 20 * mm, 22 * mm, 28 * mm, 25 * mm, 30 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#374151")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#d1d5db")),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(Spacer(1, 8 * mm))

    # Footer
    story.append(HRFlowable(width="100%", color=colors.grey))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(
        f"Generated from BonBox on {datetime.utcnow().strftime('%d/%m/%Y %H:%M')}",
        styles["Normal"],
    ))

    doc.build(story)
    buf.seek(0)
    filename = f"payroll_{body.period_start.isoformat()}_{body.period_end.isoformat()}.pdf"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
