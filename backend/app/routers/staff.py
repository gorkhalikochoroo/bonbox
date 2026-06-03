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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr

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
    NotificationLog,
)
from app.services.email_service import send_email
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
from app.services import audit_service
from app.services.tz_utils import business_today_local
from app.database import SessionLocal
from app.utils.time import utc_now

router = APIRouter()

# Rate-limit shared with the "today on shift" dashboard card.  60/min is
# permissive (the card refetches on focus + bonbox-data-changed events),
# but blocks the obvious scrape vector if /today is harvested in a loop.
_limiter = Limiter(key_func=get_remote_address)


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
    # 2 decimals (not 1) so an 07:00–15:20 shift logs as 8.33h, not 8.3h —
    # 1-decimal rounding systematically shaved minutes off staff pay vs the
    # exact preview shown in ShiftModal/PublishConfirm.
    return round(max(net, 0), 2)


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
#  TODAY ON SHIFT (Task #204, P2.6)
#  Powers the dashboard "Today on shift" card — owners' literal #1 question
#  when they open the app: "who is working RIGHT NOW?".  Uses
#  `business_today_local(user)` per the TZ convention so a 02:00 CEST
#  query (still on yesterday's business day under the 06:00 DK cutoff)
#  returns yesterday's shifts, not today's empty plan.
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/today")
@_limiter.limit("60/minute")
def list_shifts_today(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Today's shifts for the authenticated owner.

    Returns a small, name-flat payload so the dashboard card can render
    without join logic on the client:

      {
        "date": "2026-05-26",
        "shifts": [
          {
            "id": "...",
            "staff_id": "...",
            "name": "Anna",
            "role": "Bartender",
            "start_time": "17:00",
            "end_time": "23:00",
            "status": "published",
            "confirmed_at": "2026-05-25T18:34:00Z" | null,
          },
          ...
        ]
      }

    Multi-barrier defense (per Manoj's 10-layer doctrine):
      L1 — Auth gate (Depends(get_current_user))
      L2 — Strict tenant scope (Schedule.user_id == user.id)
      L3 — Tenant cross-check on each row (defensive — staff_member's
           user_id must also match; never trust a single filter)
      L4 — SlowAPI rate limit (60/min/IP)
      L5 — Read-only (no audit row needed; this is a GET that mutates
           nothing — per Manoj's audit-row convention)
      L6 — Fail-soft: empty list when no shifts (the card handles the
           empty state in copy, no 404)
    """
    today = business_today_local(user)

    # Inner join — only rows where staff_member.user_id matches the
    # caller AND staff_member.is_deleted is not True.  Belt-and-braces
    # tenant filter on top of the schedule.user_id filter below.
    shifts = (
        db.query(Schedule, StaffMember)
        .join(StaffMember, Schedule.staff_id == StaffMember.id)
        .filter(
            Schedule.user_id == user.id,
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
            Schedule.date == today,
        )
        .order_by(Schedule.start_time)
        .all()
    )

    payload = []
    for shift, staff in shifts:
        payload.append(
            {
                "id": str(shift.id),
                "staff_id": str(staff.id),
                "name": staff.name,
                "role": shift.role_on_shift or staff.role or "",
                "start_time": shift.start_time,
                "end_time": shift.end_time,
                "status": shift.status,
                "confirmed_at": shift.confirmed_at.isoformat() if shift.confirmed_at else None,
            }
        )

    return {"date": today.isoformat(), "shifts": payload}


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
    # Defense-in-depth: re-run the schema validators at the boundary even
    # though Pydantic already coerced. Catches malformed clients sending
    # raw strings/etc bypassing the Pydantic model.
    from app.schemas.staff import _validate_tax_card_type, _validate_tax_card_rate
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
        tax_card_type=_validate_tax_card_type(data.tax_card_type),
        tax_card_rate=_validate_tax_card_rate(data.tax_card_rate),
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

    # Validate trækkort fields before applying — multi-barrier defense so
    # a malformed value can't poison the DB and break payroll estimates.
    from app.schemas.staff import _validate_tax_card_type, _validate_tax_card_rate
    updates = data.model_dump(exclude_unset=True)
    if "tax_card_type" in updates:
        updates["tax_card_type"] = _validate_tax_card_type(updates["tax_card_type"])
    if "tax_card_rate" in updates:
        updates["tax_card_rate"] = _validate_tax_card_rate(updates["tax_card_rate"])

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
    member.updated_at = utc_now()
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════
#  STAFF PORTAL LINKS (magic links for staff self-service)
# ═══════════════════════════════════════════════════════════════════════════

_pin_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


@router.post("/members/{member_id}/link")
def generate_staff_link(
    member_id: str,
    rotate: bool = Query(False, description="Force a brand-new token, revoking the old one"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get-or-create the magic portal link for a staff member.

    Idempotent by default: if an active link already exists we RETURN IT
    unchanged. This matters because the owner shares the same link repeatedly
    ("Copy links" for the whole team, re-share after adding staff, etc.) and the
    staff member bookmarks it once — rotating the token on every call silently
    broke every bookmarked link. Pass ?rotate=true to deliberately mint a fresh
    token and revoke the old one (e.g. a link leaked); the DELETE endpoint still
    fully revokes.
    """
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    existing = db.query(StaffLink).filter(
        StaffLink.staff_id == member.id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).first()

    if existing and not rotate:
        # Reuse the durable link — do NOT rotate (would break bookmarks).
        return {
            "id": str(existing.id),
            "staff_id": str(member.id),
            "staff_name": member.name,
            "token": existing.token,
            "active": existing.active,
            "has_pin": bool(existing.pin_hash),
            "portal_url": f"/s/{existing.token}",
            "created_at": existing.created_at,
        }

    # Either rotating on request, or no active link exists: revoke any active
    # links, then mint a fresh one.
    db.query(StaffLink).filter(
        StaffLink.staff_id == member.id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).update({"active": False})

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


@router.get("/schedules/share-links")
def list_share_links(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get-or-create active portal links for every (non-deleted) staff member
    in ONE round-trip.

    Powers the Share sheet's instant "Copy links": instead of firing N parallel
    POST /members/{id}/link calls (slow on a cold backend, and the clipboard
    write loses its user-gesture window on big teams), the modal pre-fetches
    every link here on open. Reuses each staff's durable token via
    get-or-create — never rotates an existing link.
    """
    members = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
        )
        .all()
    )
    out = []
    minted = False
    for m in members:
        link = (
            db.query(StaffLink)
            .filter(
                StaffLink.staff_id == m.id,
                StaffLink.user_id == user.id,
                StaffLink.active.is_(True),
            )
            .first()
        )
        if not link:
            link = StaffLink(
                id=uuid.uuid4(),
                user_id=user.id,
                staff_id=m.id,
                token=secrets.token_urlsafe(24),
                active=True,
            )
            db.add(link)
            minted = True
        out.append({
            "staff_id": str(m.id),
            "staff_name": m.name,
            "email": m.email,
            "portal_url": f"/s/{link.token}",
        })
    if minted:
        db.commit()
    return out


# ═══════════════════════════════════════════════════════════════════════════
#  Staff v2 — Share with staff (bulk magic-link issue + email)
# ═══════════════════════════════════════════════════════════════════════════
#
# Used by the "Share with staff" CTA on /staff/schedule. For every staff
# with at least one published shift in the target week:
#   1. Ensure an active StaffLink exists (mint if missing — `token_urlsafe(24)`
#      = 192 bits of entropy, same convention as the existing single-staff
#      issue endpoint above at line 422).
#   2. Email them the portal URL with the link to /s/{token}.
# Schedule-change emails go out automatically via send_shift_notifications
# (which embeds the same portal_url). This endpoint is the on-ramp: staff
# get one welcome email with the link to bookmark, and every subsequent
# schedule change automatically reaches them via push + email update.
#
# Tier-gated on `staff_portal_link` — Free owners see an UpgradeNudge on
# the frontend; the endpoint returns 402 (canonical upgrade payload) if a
# Free owner somehow hits it directly.


class ShareWithStaffRequest(BaseModel):
    week_start: date


@router.post("/schedules/share-with-staff")
def share_with_staff(
    body: ShareWithStaffRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Issue/refresh StaffLinks for every staff scheduled in the target week
    and send each one a welcome email with their portal URL.

    Multi-barrier:
      L1 Auth: get_current_user.
      L2 Bounds: week_start in [today - 90d, today + 365d].
      L3 Rate-limit: 6/minute on the underlying email send, plus a soft
         cap of 25 staff per call (a single tenant scheduling > 25 staff in
         one week is the cap_staff_members_active path, not the email path).
      L5 Tenant: only StaffMembers with user_id == user.id.
      L6 Fail-closed: 402 if Free tier (missing staff_portal_link).
      L7 Audit: one `staff_link.shared_week` row per call summarizing
         {staff_count, emailed_count, link_issued_count}.
      L8 Fallback: per-staff exceptions wrapped so a single failed email
         doesn't kill the batch.
      L9 4xx for validation, 402 for tier, never 5xx.
      L10 Response reflects ACTUAL counts (links_issued + emailed_count
          + email_failed_count + skipped_no_email), not optimistic totals.
    """
    from app.services.billing import enforce_feature

    # L6 Tier check — raises 402 with canonical upgrade payload when missing.
    enforce_feature(user, "staff_portal_link")

    # L2 Bounds.
    today_local = business_today_local(user)
    if body.week_start < (today_local - timedelta(days=90)):
        raise HTTPException(status_code=422, detail="week_start_too_old")
    if body.week_start > (today_local + timedelta(days=365)):
        raise HTTPException(status_code=422, detail="week_start_too_far")
    week_end = body.week_start + timedelta(days=6)

    # Find every staff with a published shift in the target week.
    scheduled_staff_ids = {
        s.staff_id for s in db.query(Schedule).filter(
            Schedule.user_id == user.id,
            Schedule.date >= body.week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        ).all()
    }

    if not scheduled_staff_ids:
        return {
            "ok": True,
            "staff_count": 0,
            "links_issued": 0,
            "emailed_count": 0,
            "email_failed_count": 0,
            "skipped_no_email": 0,
            "week_start": body.week_start.isoformat(),
        }

    # L3 Soft cap — 25 staff per call. The cap_staff_members_active gate
    # in the architecture doc (Pro=25) makes this a no-op upper bound for
    # any sensible tenant; a tenant that wires 200 staff into one week is
    # almost certainly a misuse pattern.
    if len(scheduled_staff_ids) > 25:
        raise HTTPException(status_code=422, detail="too_many_staff_for_share")

    members = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.id.in_(scheduled_staff_ids),
        StaffMember.is_deleted.isnot(True),
    ).all()

    # Resolve business name once for the email body.
    try:
        profile = db.query(BusinessProfile).filter(
            BusinessProfile.user_id == user.id,
        ).first()
        restaurant_name = profile.business_name if profile and profile.business_name else "BonBox"
    except Exception:  # noqa: BLE001
        restaurant_name = "BonBox"

    links_issued = 0
    emailed_count = 0
    email_failed_count = 0
    skipped_no_email = 0
    week_label = f"Week of {body.week_start.strftime('%d %b %Y')}"

    for member in members:
        try:
            # Step 1 — ensure an active link exists (mint if missing).
            link = db.query(StaffLink).filter(
                StaffLink.staff_id == member.id,
                StaffLink.user_id == user.id,
                StaffLink.active.is_(True),
            ).first()
            if link is None:
                token = secrets.token_urlsafe(24)
                link = StaffLink(
                    id=uuid.uuid4(),
                    user_id=user.id,
                    staff_id=member.id,
                    token=token,
                    active=True,
                )
                db.add(link)
                db.flush()
                links_issued += 1

            # Step 2 — email the link.
            if not member.email:
                skipped_no_email += 1
                continue

            portal_url = f"https://bonbox.dk/s/{link.token}"
            first_name = (member.name or "").split(" ")[0] or member.name or ""
            # DK-first niche email — restaurant/butik/værksted markets in DK
            # expect Danish.  Keep brand-locked vocabulary (vagtplan, push,
            # notifikationer) per convention_dk_terminology_lock.md.
            subject = f"{restaurant_name} — din vagtplan er klar"
            # Plain, branded HTML. Inlined styles so email clients render it
            # consistently (Outlook, Gmail, Apple Mail).
            html = (
                f"<div style=\"font-family: -apple-system, BlinkMacSystemFont, "
                f"'Segoe UI', system-ui, sans-serif; max-width: 520px; "
                f"color: #111; line-height: 1.5;\">"
                f"<h2 style=\"color:#111;margin:0 0 12px;font-size:20px;\">"
                f"Hej {first_name},</h2>"
                f"<p style=\"color:#333;margin:0 0 16px;\">"
                f"{restaurant_name} har delt din vagtplan med dig. "
                f"Bogmærk linket — hver gang vagtplanen ændres, ser du "
                f"opdateringen her med det samme."
                f"</p>"
                f"<p style=\"margin:24px 0;\">"
                f"<a href=\"{portal_url}\" "
                f"style=\"display:inline-block;background:#111;color:#fff;"
                f"padding:12px 22px;text-decoration:none;border-radius:8px;"
                f"font-weight:600;font-size:15px;\">"
                f"Åbn min vagtplan</a>"
                f"</p>"
                f"<p style=\"color:#666;font-size:13px;margin:0 0 8px;\">"
                f"<strong>Tip:</strong> Tryk på del-ikonet i Safari og vælg "
                f"<em>Føj til hjemmeskærm</em> for at få push-notifikationer "
                f"når vagter ændres."
                f"</p>"
                f"<p style=\"color:#666;font-size:13px;margin:0 0 24px;\">"
                f"Linket er personligt — del det ikke med andre."
                f"</p>"
                f"<p style=\"color:#999;font-size:12px;margin:32px 0 0;"
                f"padding-top:16px;border-top:1px solid #eee;\">"
                f"{restaurant_name} · sendt via BonBox</p>"
                f"</div>"
            )
            success = send_email(to=member.email, subject=subject, html=html)
            log = NotificationLog(
                id=uuid.uuid4(),
                user_id=user.id,
                staff_id=member.id,
                channel="email",
                event_type="staff_link_shared",
                subject=subject,
                body=html,
                status="sent" if success else "failed",
                error_message=None if success else "Email delivery failed",
            )
            db.add(log)
            if success:
                emailed_count += 1
            else:
                email_failed_count += 1
        except Exception as exc:  # noqa: BLE001
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
            email_failed_count += 1
            logger.exception(
                "share_with_staff: per-staff error for staff_id=%s: %s",
                member.id, exc,
            )
            continue

    # L7 Audit — one row per call summarizing what happened.
    audit_service.record(
        db, user, "staff_link.shared_week", "staff_link",
        after={
            "week_start": body.week_start.isoformat(),
            "staff_count": len(members),
            "links_issued": links_issued,
            "emailed_count": emailed_count,
            "email_failed_count": email_failed_count,
            "skipped_no_email": skipped_no_email,
        },
        ip_address=request.client.host if request and request.client else None,
    )
    db.commit()

    return {
        "ok": True,
        "staff_count": len(members),
        "links_issued": links_issued,
        "emailed_count": emailed_count,
        "email_failed_count": email_failed_count,
        "skipped_no_email": skipped_no_email,
        "week_start": body.week_start.isoformat(),
    }


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
        config.updated_at = utc_now()
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

    # Honest post-publish count: of the staff with changes, how many have a
    # reachable email on file? This mirrors EXACTLY who send_shift_notifications
    # will email (same tenant-scope + non-deleted + email-present filter), but
    # computed synchronously so the UI can report a truthful "N staff emailed"
    # figure instead of fabricating one. We count addressable recipients we
    # dispatch to — never inflated beyond staff with an email. (Per-staff
    # delivery can still fail downstream; that's logged to notification_log.)
    notify_count = 0
    if changes:
        changed_ids = []
        for sid in changes.keys():
            try:
                changed_ids.append(uuid.UUID(str(sid)))
            except (ValueError, TypeError):
                continue
        if changed_ids:
            notify_count = (
                db.query(StaffMember)
                .filter(
                    StaffMember.id.in_(changed_ids),
                    StaffMember.user_id == user.id,
                    StaffMember.is_deleted.isnot(True),
                    StaffMember.email.isnot(None),
                    StaffMember.email != "",
                )
                .count()
            )

        user_id = user.id
        week_label = f"Week of {week_start.strftime('%d %b %Y')}"

        def _send_bg():
            bg_db = SessionLocal()
            try:
                send_shift_notifications(bg_db, user_id, changes, week_label)
            finally:
                bg_db.close()

        background_tasks.add_task(_send_bg)

    # Staff live-sync Phase 2: nudge any connected staff portals to refetch NOW
    # (instant) instead of waiting for their 20s poll. Best-effort, carries no
    # schedule data — just a "published" signal keyed by tenant (owner id). If
    # nothing was published/changed, skip it. The poll remains the fallback.
    if updated or changes:
        try:
            from app.services import portal_events
            portal_events.publish(
                str(user.id),
                {"type": "schedule_published", "week_start": week_start.isoformat()},
            )
        except Exception:  # noqa: BLE001 — a nudge must never break publish
            import logging
            logging.getLogger(__name__).debug(
                "portal_events publish failed", exc_info=True
            )

    return {
        "published": updated,
        "week_start": week_start.isoformat(),
        "changed_staff": len(changes),
        "notify_count": notify_count,
    }


# ═══════════════════════════════════════════════════════════════════════════
#  SCHEDULE AUTOPILOT — Pro-tier killer feature (Task #50)
#
#  Reads 8 weeks of revenue history + 7-day weather forecast + each staff
#  member's hourly cost, then proposes next week's schedule that meets
#  demand at minimum labor cost while respecting DK labor law. Owner can
#  edit per-shift before applying. Tier-gated on Pro only — NOT Starter.
# ═══════════════════════════════════════════════════════════════════════════


class AutopilotSuggestBody(BaseModel):
    week_start: date
    branch_id: Optional[uuid.UUID] = None


class AutopilotShiftBody(BaseModel):
    date: date
    staff_id: uuid.UUID
    start: str
    end: str
    break_minutes: int | None = None
    role: str | None = None
    notes: str | None = None


class AutopilotApplyBody(BaseModel):
    week_start: date
    shifts: list[AutopilotShiftBody]
    branch_id: Optional[uuid.UUID] = None


def _enforce_autopilot_tier(user: User) -> None:
    """402 plan_required if the user doesn't have Pro. Same shape as the
    rest of the codebase (code/feature/upgrade_to/current_plan/message)
    so the frontend renders the UpgradeNudge from one error contract.
    """
    from app.services.billing import effective_plan, has_feature

    if not has_feature(user, "schedule_autopilot"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "error": "feature_locked",
                "feature": "schedule_autopilot",
                "required_plan": "pro",
                "upgrade_to": "pro",
                "current_plan": effective_plan(user),
                "plan": effective_plan(user),
                "message": (
                    "Schedule Autopilot is on Pro. You can still build "
                    "the schedule manually or copy last week's shifts."
                ),
            },
        )


@router.post("/schedules/autopilot")
def schedule_autopilot_suggest(
    body: AutopilotSuggestBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a one-week schedule suggestion. Read-only — never writes
    Schedule rows. The owner reviews + edits before calling
    /schedules/autopilot/apply.

    Tier-gated: Pro+ only (Starter is intentionally excluded — this is
    the Pro killer feature).
    """
    _enforce_autopilot_tier(user)

    # Input bounds: only allow suggestions for weeks within ±60 days
    # of today. The autopilot has no business writing into 2027 from a
    # 2026 console — that's a typo defense not a security one.
    today = date.today()
    if body.week_start < today - timedelta(days=60):
        raise HTTPException(
            status_code=422,
            detail="week_start is more than 60 days in the past",
        )
    if body.week_start > today + timedelta(days=365):
        raise HTTPException(
            status_code=422,
            detail="week_start is more than a year in the future",
        )

    from app.services import schedule_autopilot

    suggestion = schedule_autopilot.suggest_week_schedule(
        db,
        user=user,
        week_start=body.week_start,
        branch_id=body.branch_id,
    )
    payload = suggestion.to_dict()

    # Audit — record every suggestion so the owner can later answer
    # "what did autopilot tell me on Tuesday?" if a Skattestyrelsen
    # dispute traces back to a labor-law issue.
    audit_service.record(
        db,
        user=user,
        action="schedule.autopilot_suggested",
        entity_type="schedule",
        entity_id=None,
        after={
            "week_start": payload["week_start"],
            "branch_id": payload["branch_id"],
            "confidence": payload["confidence"],
            "basis": payload["basis"],
            "week_total_cost": payload["week_total_cost"],
            "week_total_hours": payload["week_total_hours"],
            "compliance_warnings": payload["compliance_warnings"],
        },
        ip_address=getattr(request.client, "host", None) if request and request.client else None,
    )
    db.commit()
    return payload


@router.post("/schedules/autopilot/apply")
def schedule_autopilot_apply(
    body: AutopilotApplyBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Materialize the (possibly owner-edited) suggestion into draft
    Schedule rows. The owner still has to hit Publish to notify staff.
    Tier-gated: Pro+ only.
    """
    _enforce_autopilot_tier(user)

    today = date.today()
    if body.week_start < today - timedelta(days=60):
        raise HTTPException(
            status_code=422,
            detail="week_start is more than 60 days in the past",
        )
    if body.week_start > today + timedelta(days=365):
        raise HTTPException(
            status_code=422,
            detail="week_start is more than a year in the future",
        )

    from app.services import schedule_autopilot

    payload_shifts = [
        {
            "date": s.date.isoformat(),
            "staff_id": str(s.staff_id),
            "start": s.start,
            "end": s.end,
            "break_minutes": s.break_minutes,
            "role": s.role,
            "notes": s.notes,
        }
        for s in body.shifts
    ]

    try:
        result = schedule_autopilot.apply_suggestion(
            db,
            user=user,
            week_start=body.week_start,
            shifts=payload_shifts,
        )
    except ValueError as e:
        # ValueError from apply_suggestion = tenant-boundary violation
        # (foreign staff_id). Return 400 — defensive, the frontend
        # never sends foreign IDs in normal flow.
        raise HTTPException(status_code=400, detail=str(e))

    audit_service.record(
        db,
        user=user,
        action="schedule.autopilot_applied",
        entity_type="schedule",
        entity_id=None,
        after={
            "week_start": body.week_start.isoformat(),
            "branch_id": str(body.branch_id) if body.branch_id else None,
            "applied": result["applied"],
            "deleted_existing": result["deleted_existing"],
        },
        ip_address=getattr(request.client, "host", None) if request and request.client else None,
    )
    db.commit()
    return {
        "applied": result["applied"],
        "deleted_existing": result["deleted_existing"],
        "week_start": body.week_start.isoformat(),
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Schedule-confirmation summary — calm awareness signal for the owner
#
#  "Have my staff seen this week's schedule?" without nagging anyone.
#  Reads aggregate counts of published vs. confirmed shifts in a window;
#  the dashboard renders a small chip "✓ 3 of 4 staff confirmed for next
#  week". Tenant-scoped, read-only.
# ═══════════════════════════════════════════════════════════════════════════


@router.get("/schedules/pdf")
def export_schedule_pdf(
    week_start: date = Query(..., description="Monday of the week to render"),
    lang: str = Query("en", pattern="^(en|da)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Render the week's published schedule as a printable A4 landscape
    PDF. Owners print this and pin it on the back-of-house staff board.

    Multi-layer:
      • Auth-gated (Depends(get_current_user)).
      • Tenant-scoped: render service queries Staff + Schedule by
        user_id only.
      • Read-only.
      • Lang restricted to {"en","da"} via Pydantic regex pattern;
        any other value 422s before reaching the service.
    """
    from io import BytesIO
    from app.services.staff_schedule_pdf import render_schedule_pdf

    try:
        pdf_bytes = render_schedule_pdf(
            db, user_id=user.id, week_start=week_start, lang=lang,
        )
    except Exception as exc:  # noqa: BLE001
        # Service already logs; surface a calm error instead of leaking
        # internals.
        raise HTTPException(
            status_code=500,
            detail="Could not render schedule PDF. Try again in a moment.",
        ) from exc

    filename = f"bonbox-schedule-{week_start.isoformat()}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════
#  Email the week's schedule to all staff (bulk send)
# ═══════════════════════════════════════════════════════════════════════════
#
# Replaces the "download then paste-into-WhatsApp" workflow most owners
# do today. One tap → every staff member with an email on file gets the
# week's schedule PDF in their inbox, reply-to set to the owner so any
# "can I swap Thursday?" question lands in their actual inbox.
#
# Recipient resolution per staff member:
#   1. StaffMember.email if set
#   2. Skip (no email) — included in the response so the UI can show
#      "12 sent, 2 staff have no email — add an address?"


class _EmailScheduleRequest(BaseModel):
    """Body for POST /staff/schedules/email."""
    week_start: date
    lang: str = "en"  # "en" | "da"
    # Optional staff_ids filter — None means "every active staff member
    # with an email". Lets the owner re-send to one or two people who
    # missed it without spamming the whole crew.
    staff_ids: list[str] | None = None
    # Free-text message rendered at the top of the email body
    message: str | None = None
    # cc the owner so they have a record / can forward
    cc_self: bool = True


@router.post("/schedules/email")
def email_schedule_to_staff(
    body: _EmailScheduleRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Email the week's schedule PDF to all (or selected) staff via Resend.

    Multi-layer:
      • Auth-gated.
      • Tenant-scoped: staff/schedule queries filter on user_id.
      • Reply-to = owner.email so the staff member can reply back
        directly (not to noreply@bonbox.dk).
      • Per-recipient failures are isolated — one bad email address
        doesn't tank the whole send. Returns counts so the UI can
        show "Sent to 12 of 14 — 2 had no email".

    Returns:
      {
        ok: True,
        sent: int,           # successfully delivered
        skipped_no_email: int,
        failed: [{name, email, reason}],
        attempted: int,
      }
    """
    if (body.lang or "").lower() not in ("en", "da"):
        raise HTTPException(status_code=422, detail="lang must be 'en' or 'da'")

    # Tier gate (Pro+ — bulk-staff feature for multi-employee operations)
    from app.services.billing import has_feature, effective_plan
    if not has_feature(user, "bulk_staff_email"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "bulk_staff_email",
                "required_plan": "pro",
                "current_plan": effective_plan(user),
                "message": (
                    "Email-to-all-staff is on Pro. You can still print the "
                    "schedule PDF and share it via WhatsApp."
                ),
            },
        )

    from io import BytesIO  # noqa: F401 (matches pattern in /schedules/pdf)
    from app.services.staff_schedule_pdf import render_schedule_pdf
    from app.services.email_service import send_email_with_attachment

    try:
        pdf_bytes = render_schedule_pdf(
            db, user_id=user.id, week_start=body.week_start, lang=body.lang,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail="Could not render schedule PDF. Try again in a moment.",
        ) from exc

    # Staff filter — selected ids OR every active staff member
    staff_q = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.is_active.isnot(False),
    )
    if body.staff_ids:
        staff_q = staff_q.filter(StaffMember.id.in_(body.staff_ids))
    targets = staff_q.all()

    if not targets:
        return {
            "ok": True, "sent": 0, "skipped_no_email": 0,
            "failed": [], "attempted": 0,
            "message": "No active staff matched.",
        }

    # Business name on the email body / subject
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    biz_name = (
        getattr(profile, "company_name", None)
        or getattr(user, "business_name", None)
        or "BonBox"
    )

    is_danish = (body.lang or "").lower() == "da"
    week_iso = body.week_start.isoformat()
    filename = f"bonbox-schedule-{week_iso}.pdf"

    # HTML body — personalized per-staff so we re-render the greeting
    # for each recipient. Owner's free-text message goes above the
    # standard intro and is HTML-escaped.
    from html import escape
    user_note_html = ""
    if (body.message or "").strip():
        safe = escape(body.message.strip()).replace("\n", "<br>")
        user_note_html = (
            "<div style='margin:16px 0;padding:12px;background:#f9fafb;"
            "border-left:3px solid #10b981;color:#374151;font-size:14px;"
            "line-height:1.5;'>"
            f"{safe}"
            "</div>"
        )

    sent = 0
    skipped = 0
    failed: list[dict] = []
    cc = [user.email] if (body.cc_self and user.email) else None

    for s in targets:
        addr = (s.email or "").strip().lower()
        if not addr or "@" not in addr:
            skipped += 1
            continue

        first_name = (s.name or "").split(" ")[0] or s.name or ""
        if is_danish:
            subject = f"Vagtplan uge {body.week_start.strftime('%V')} — {biz_name}"
            greeting = f"Hej {first_name},".strip(", ")
            intro = (
                f"Vedhæftet finder du vagtplanen for ugen "
                f"<strong>fra mandag {week_iso}</strong>."
            )
            footer = (
                "Sendt direkte fra BonBox. "
                f"Svar på denne mail for at kontakte {biz_name}."
            )
        else:
            subject = f"Schedule week {body.week_start.strftime('%V')} — {biz_name}"
            greeting = f"Hi {first_name},".strip(", ")
            intro = (
                f"Attached is the schedule for the week starting "
                f"<strong>Monday {week_iso}</strong>."
            )
            footer = (
                "Sent directly from BonBox. "
                f"Reply to this email to reach {biz_name}."
            )

        html = (
            "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
            "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
            f"<p>{greeting}</p>"
            f"<p>{intro}</p>"
            f"{user_note_html}"
            f"<p style='color:#6b7280;font-size:13px;margin-top:16px;'>{footer}</p>"
            "</div>"
        )

        ok, err = send_email_with_attachment(
            addr, subject, html,
            attachment_bytes=pdf_bytes,
            attachment_filename=filename,
            attachment_mime="application/pdf",
            reply_to=user.email,
            cc=cc,
        )
        if ok:
            sent += 1
        else:
            failed.append({"name": s.name, "email": addr, "reason": err or "unknown"})

    # Bogføringsloven §10 — bulk staff-email distribution is sensitive (touches
    # personal data + scheduling commitments). Capture WHO got the schedule
    # and HOW MANY were sent so disputes / GDPR queries can be answered.
    audit_service.record(
        db, user=user,
        action="staff_schedule.email_bulk",
        entity_type="staff_schedule_week",
        entity_id=None,
        before=None,
        after={
            "week_start": body.week_start.isoformat(),
            "lang": body.lang, "attempted": len(targets),
            "sent": sent, "skipped_no_email": skipped, "failed_count": len(failed),
            "staff_ids": [str(t.id) for t in targets],
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()

    return {
        "ok": True,
        "sent": sent,
        "skipped_no_email": skipped,
        "failed": failed,
        "attempted": len(targets),
    }


@router.get("/schedule-confirmation-summary")
def schedule_confirmation_summary(
    week_start: Optional[date] = Query(None, description="Defaults to current week's Monday"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return how many distinct staff have confirmed the published
    schedule for the given week. Multi-tenant: all queries filter by
    user_id. Idempotent / read-only.
    """
    if week_start is None:
        today = date.today()
        # Current week's Monday (matches _get_week_start in staff_portal.py)
        week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)

    # Count distinct staff who have at least one published shift this week
    total_q = db.query(Schedule.staff_id).filter(
        Schedule.user_id == user.id,
        Schedule.date >= week_start,
        Schedule.date <= week_end,
        Schedule.status == "published",
    ).distinct()
    total_staff = total_q.count()

    confirmed_q = db.query(Schedule.staff_id).filter(
        Schedule.user_id == user.id,
        Schedule.date >= week_start,
        Schedule.date <= week_end,
        Schedule.status == "published",
        Schedule.confirmed_at.isnot(None),
    ).distinct()
    confirmed_staff = confirmed_q.count()

    return {
        "week_start": week_start.isoformat(),
        "total_staff": total_staff,
        "confirmed_staff": confirmed_staff,
        "all_confirmed": total_staff > 0 and confirmed_staff == total_staff,
        "none_confirmed": confirmed_staff == 0,
    }


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

    hours_by_id = {str(r.staff_id): r for r in hours_rows}
    hours_staff_ids = set(hours_by_id.keys())

    # Scheduled hours per staff in the period (from the roster) so the table
    # can show Scheduled vs Actual vs Diff. start/end are "HH:MM" strings, so
    # we sum in Python. Defensive — a failure just leaves scheduled_hours=0.
    def _shift_hours(start, end, brk):
        try:
            sh, sm = int(start[:2]), int(start[3:5])
            eh, em = int(end[:2]), int(end[3:5])
            mins = (eh * 60 + em) - (sh * 60 + sm)
            if mins < 0:
                mins += 24 * 60  # overnight shift
            mins -= int(brk or 0)
            return max(0.0, mins / 60.0)
        except Exception:
            return 0.0

    sched_map: dict[str, float] = {}
    try:
        for s in (
            db.query(Schedule)
            .filter(
                Schedule.user_id == user.id,
                Schedule.date >= from_date,
                Schedule.date <= to_date,
            )
            .all()
        ):
            sid = str(s.staff_id)
            sched_map[sid] = sched_map.get(sid, 0.0) + _shift_hours(
                s.start_time, s.end_time, s.break_minutes
            )
    except Exception as e:
        log.warning("hours_summary: scheduled-hours aggregation failed: %s", e)
        sched_map = {}

    # Staff names + pay/limit fields — wrapped so a corrupt member row doesn't
    # kill the report. base_rate → hourly_rate, max_hours_month → work_limit.
    staff_ids = list(hours_staff_ids | set(tips_map.keys()) | set(sched_map.keys()))
    staff_names: dict[str, str] = {}
    rate_map: dict[str, float | None] = {}
    limit_map: dict[str, float | None] = {}
    if staff_ids:
        try:
            for m in db.query(StaffMember).filter(StaffMember.id.in_(staff_ids)).all():
                mid = str(m.id)
                staff_names[mid] = m.name or "Unknown"
                rate_map[mid] = float(m.base_rate) if m.base_rate is not None else None
                limit_map[mid] = (
                    float(m.max_hours_month) if m.max_hours_month is not None else None
                )
        except Exception as e:
            log.warning("hours_summary: staff lookup failed: %s", e)

    # One row per staff who has actual hours, tips, OR a scheduled shift.
    summary = []
    for sid in staff_ids:
        r = hours_by_id.get(sid)
        actual = round(float(r.total_hours or 0), 1) if r else 0.0
        earned = round(float(r.total_earned or 0), 2) if r else 0.0
        overtime = round(float(r.overtime_hours or 0), 1) if r else 0.0
        tips = round(float(tips_map.get(sid, 0)), 2)
        scheduled = round(sched_map.get(sid, 0.0), 1)
        summary.append({
            "staff_id": sid,
            "staff_name": staff_names.get(sid, f"Staff #{sid[:8]}"),
            # legacy keys (back-compat for any other caller)
            "total_hours": actual,
            "total_earned": earned,
            "overtime_hours": overtime,
            "tips_received": tips,
            # keys the Hours "Period summary" table reads
            "actual_hours": actual,
            "scheduled_hours": scheduled,
            "hourly_rate": rate_map.get(sid),
            "earned": earned,
            "tips": tips,
            "total": round(earned + tips, 2),
            "work_limit": limit_map.get(sid),
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
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Generate accountant-grade Lønseddel PDF (one page per active employee).

    Delegates rendering to `build_loenseddel_pdf` in `loenseddel_pdf.py` —
    the dedicated service mirrors the gold-standard accountant-grade
    pattern from `build_moms_filing_pdf` in `tax_filing_pdf.py`. Every
    page carries the 6 required revisor-bound fields:
      1. Bilagsnummer (`LON-{employee}-{YYYYMMDD}-{YYYYMMDD}`)
      2. Doc-hash (SHA-256, 16-char short in footer)
      3. Signature line for the medarbejder
      4. Bogføringsloven §10 notice (5-year retention)
      5. Provenance footer (BonBox v… · UTC timestamp · owner email)
      6. Source reconciliation (every HoursLogged row that fed the gross)

    Per Manoj's locked doctrine ("Accountant-grade artifacts"):
      Tier controls cap / period auto-resolution / send-access — NEVER
      artifact content. Every plan that has access to the endpoint gets
      the same 6-field accountant-grade PDF.

    Multi-layer defense:
      - empty staff/period returns 404 (don't ship a blank PDF)
      - per-employee try/except: one bad row doesn't kill the whole PDF
      - PDF lib import wrapped — 500 if reportlab missing
      - L7 audit_logs row written per employee rendered
    """
    from app.services.loenseddel_pdf import build_loenseddel_pdf_multi

    # Resolve all eligible staff (active, non-deleted) AND restrict to
    # those who logged hours in the period. We feed them all into one
    # multi-page accountant-grade PDF — each employee gets their own
    # bilagsnummer and source-reconciliation block.
    staff_rows = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .order_by(StaffMember.name.asc())
        .all()
    )
    if not staff_rows:
        raise HTTPException(404, "No staff with hours logged in this period")

    has_hours_ids = set(
        str(r[0]) for r in db.query(HoursLogged.staff_id)
        .filter(
            HoursLogged.user_id == user.id,
            HoursLogged.date >= period_start,
            HoursLogged.date <= period_end,
        )
        .distinct()
        .all()
    )
    eligible = [s for s in staff_rows if str(s.id) in has_hours_ids]
    if not eligible:
        raise HTTPException(404, "No staff with hours logged in this period")

    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )

    ip_address = (
        getattr(request.client, "host", None)
        if request and request.client else None
    )

    try:
        pdf_bytes, summary = build_loenseddel_pdf_multi(
            db, user, eligible, period_start, period_end, profile=profile,
        )
    except ImportError:
        raise HTTPException(500, "PDF library not available")

    # L7 audit row — accountant-grade requirement. One row per
    # employee rendered so a revisor can later see exactly which staff
    # member's lønseddel went out. The doc_hash on EACH row is the
    # combined-PDF hash (the artifact the user actually downloads), so
    # later tamper-checks can verify against any of them.
    for entry in summary["per_employee"]:
        audit_service.record(
            db,
            user=user,
            action="staff.loenseddel_pdf_generated",
            entity_type="staff_member",
            entity_id=entry["employee_id"],
            after={
                "period_start": summary["period_start"],
                "period_end": summary["period_end"],
                "total_hours": entry["total_hours"],
                "total_gross": entry["total_gross"],
                "doc_hash": summary["doc_hash"],
                "bilagsnummer": entry["bilagsnummer"],
            },
            ip_address=ip_address,
        )
    db.commit()

    filename = f"bonbox_loenseddel_{period_start}_{period_end}.pdf"
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def _render_payroll_pdf_bytes(body: "PayrollPDFRequest", db: Session, user: User) -> bytes:
    """Build the payroll PDF and return the raw bytes.

    Extracted so both the download endpoint (/payroll/pdf) and the
    send-to-accountant endpoint can share one rendering pipeline —
    guarantees the emailed file is byte-identical to the downloaded
    one. Raises HTTPException on failure (same shape as before).
    """
    import html as _html
    import logging as _logging
    log = _logging.getLogger("bonbox.payroll_pdf")

    def _safe(s):
        # reportlab Paragraph interprets <, >, & as markup — escape for safety.
        return _html.escape(str(s)) if s is not None else ""

    # Gather staff
    staff_q = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    )
    if body.staff_ids:
        staff_q = staff_q.filter(StaffMember.id.in_(body.staff_ids))
    staff_list = staff_q.order_by(StaffMember.name).all()
    if not staff_list:
        raise HTTPException(status_code=404, detail="No staff with logged hours in this period")

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
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, PageBreak
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF library not installed on server")

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=20 * mm, bottomMargin=15 * mm,
        leftMargin=20 * mm, rightMargin=20 * mm,
    )
    styles = getSampleStyleSheet()
    story = []

    def fmt(v):
        if v is None:
            return "---"
        try:
            return f"{float(v):,.2f} {currency}"
        except (TypeError, ValueError):
            return "---"

    # ── Title page ──
    title_style = ParagraphStyle("Title", parent=styles["Title"], fontSize=18, spaceAfter=4)
    story.append(Paragraph("Payroll Report", title_style))

    biz_name = profile.business_name if profile else ""
    if biz_name:
        story.append(Paragraph(_safe(biz_name), styles["Heading3"]))
    if profile:
        addr_parts = [p for p in [profile.address, profile.zipcode, profile.city] if p]
        if addr_parts:
            story.append(Paragraph(_safe(", ".join(addr_parts)), styles["Normal"]))
        if profile.org_number:
            story.append(Paragraph(f"CVR: {_safe(profile.org_number)}", styles["Normal"]))

    story.append(Paragraph(
        f"Period: {body.period_start.strftime('%d %B %Y')} - {body.period_end.strftime('%d %B %Y')}",
        styles["Normal"],
    ))
    story.append(Spacer(1, 10 * mm))

    # ── Per-staff pages ──
    for sid in staff_ids:
        sd = staff_data[sid]

        try:
            story.append(Paragraph(_safe(sd["name"] or "—"), styles["Heading2"]))
            story.append(Paragraph(
                f"Role: {_safe(sd.get('role') or '—')}  |  Contract: {_safe(sd.get('contract_type') or '—')}",
                styles["Normal"],
            ))
            story.append(Spacer(1, 4 * mm))

            # Hours detail table — only render if employee has entries this period
            if sd["entries"]:
                detail_data = [["Date", "Time", "Break", "Hours", "Rate", "Earned"]]
                for h in sd["entries"]:
                    # If neither start nor end is logged (manual quick-entry of total
                    # hours only), show a single em-dash instead of "--- - ---".
                    if h.start_time or h.end_time:
                        time_str = f"{h.start_time or '—'} – {h.end_time or '—'}"
                    else:
                        time_str = "—"
                    date_str = h.date.strftime("%d/%m") if h.date else "—"
                    break_str = f"{int(h.break_minutes or 0)}m"
                    hrs_str = f"{float(h.total_hours or 0):.1f}"
                    detail_data.append([
                        date_str,
                        time_str,
                        break_str,
                        hrs_str,
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
            grand_total_row = (sd.get("total_earned") or 0.0) + (sd.get("tips") or 0.0)
            totals_data = [
                ["Total Hours", f"{float(sd.get('total_hours') or 0):.1f}"],
                ["Overtime Hours", f"{float(sd.get('overtime_hours') or 0):.1f}"],
                ["Total Earned", fmt(sd.get("total_earned"))],
                ["Tips Received", fmt(sd.get("tips"))],
                ["GRAND TOTAL", fmt(grand_total_row)],
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
        except Exception as e:  # noqa: BLE001
            log.warning("payroll_pdf: failed to render staff %s: %s", sd.get("name"), e)
            story.append(Paragraph(
                f"Could not render details for {_safe(sd.get('name') or '?')} — "
                "skipped this employee.",
                styles["Normal"],
            ))
            story.append(Spacer(1, 4 * mm))

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
        # All numbers come from server-side aggregation but be defensive in case
        # of None / missing keys — a single bad row shouldn't kill the summary.
        sd_hours = float(sd.get("total_hours") or 0)
        sd_ot = float(sd.get("overtime_hours") or 0)
        sd_earned = float(sd.get("total_earned") or 0)
        sd_tips = float(sd.get("tips") or 0)
        row_total = sd_earned + sd_tips
        sum_data.append([
            _safe(sd.get("name") or "—"),
            f"{sd_hours:.1f}",
            f"{sd_ot:.1f}",
            fmt(sd_earned),
            fmt(sd_tips),
            fmt(row_total),
        ])
        grand_hours += sd_hours
        grand_overtime += sd_ot
        grand_earned += sd_earned
        grand_tips += sd_tips
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
        f"Generated from BonBox on {utc_now().strftime('%d/%m/%Y %H:%M')}",
        styles["Normal"],
    ))

    try:
        doc.build(story)
    except Exception as e:  # noqa: BLE001
        log.error("payroll_pdf: doc.build failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"PDF rendering failed ({type(e).__name__}). Check Admin → Errors for details.",
        )

    buf.seek(0)
    return buf.getvalue()


@router.post("/payroll/pdf")
def generate_payroll_pdf(
    body: PayrollPDFRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Build a payroll PDF (per-staff hours detail + summary page).

    Thin wrapper around _render_payroll_pdf_bytes — see that helper for
    rendering logic. Kept separate so the rendering is reusable from
    /payroll/send-to-accountant without duplicating reportlab code.
    """
    pdf_bytes = _render_payroll_pdf_bytes(body, db, user)
    filename = f"payroll_{body.period_start.isoformat()}_{body.period_end.isoformat()}.pdf"
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── Payroll → accountant email ───────────────────────────────────────────
#
# Same pattern as daily-close-to-accountant and faktura-to-customer:
# one button → server-side Resend delivery with attachment. Reply-to
# is the owner's email so the accountant's reply lands in the owner's
# inbox, not noreply@bonbox.dk. cc_self default true so the owner has
# a copy for their records.


class PayrollSendToAccountantRequest(BaseModel):
    """Body for POST /staff/payroll/send-to-accountant."""
    period_start: date
    period_end: date
    staff_ids: list[str] | None = None
    # Override recipient — defaults to BusinessProfile.accountant_email
    accountant_email: EmailStr | None = None
    # Free-text message (HTML-escaped before render)
    message: str | None = None
    cc_self: bool = True


@router.post("/payroll/send-to-accountant")
def send_payroll_to_accountant(
    body: PayrollSendToAccountantRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Email the payroll PDF directly to the accountant. Starter+ feature
    (shares the `direct_accountant_email` flag with the daily-close send).

    Free users get a 402 + can still download the PDF manually via the
    existing /payroll/pdf endpoint and attach it themselves.
    """
    # Tier gate (Polish Pass tier reshuffle)
    from app.services.billing import has_feature, effective_plan
    if not has_feature(user, "direct_accountant_email"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "direct_accountant_email",
                "required_plan": "starter",
                "current_plan": effective_plan(user),
                "message": (
                    "Direct email to your accountant is on Starter. "
                    "You can still download the payroll PDF and attach it manually."
                ),
            },
        )

    from app.services.email_service import send_email_with_attachment

    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    recipient = (
        (body.accountant_email or "").strip().lower()
        if body.accountant_email else ""
    ) or ((getattr(profile, "accountant_email", None) or "").strip().lower())
    if not recipient:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_accountant_email",
                "message": (
                    "Set your accountant's email on Profile, or include "
                    "accountant_email in the request body."
                ),
            },
        )

    # Reuse the PDF rendering pipeline — exact same bytes the
    # download endpoint produces (audit-friendly: identical files).
    pdf_payload = PayrollPDFRequest(
        period_start=body.period_start,
        period_end=body.period_end,
        staff_ids=body.staff_ids,
    )
    try:
        pdf_bytes = _render_payroll_pdf_bytes(pdf_payload, db, user)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f"Could not render payroll PDF: {type(e).__name__}",
        ) from e

    currency = user.currency or "DKK"
    is_danish = (currency == "DKK")
    biz_name = (
        getattr(profile, "company_name", None)
        or getattr(user, "business_name", None)
        or "BonBox"
    )

    filename = f"payroll_{body.period_start.isoformat()}_{body.period_end.isoformat()}.pdf"
    if is_danish:
        subject = (
            f"Lønningsliste {body.period_start.isoformat()} → "
            f"{body.period_end.isoformat()} — {biz_name}"
        )
        greeting = "Hej,"
        intro = (
            f"Vedhæftet finder du lønningslisten for <strong>{biz_name}</strong> "
            f"for perioden <strong>{body.period_start.isoformat()} → "
            f"{body.period_end.isoformat()}</strong>."
        )
        footer = (
            "Sendt direkte fra BonBox. "
            "Svar på denne mail for at kontakte ejeren."
        )
    else:
        subject = (
            f"Payroll {body.period_start.isoformat()} → "
            f"{body.period_end.isoformat()} — {biz_name}"
        )
        greeting = "Hello,"
        intro = (
            f"Attached is the payroll report for <strong>{biz_name}</strong> "
            f"for the period <strong>{body.period_start.isoformat()} → "
            f"{body.period_end.isoformat()}</strong>."
        )
        footer = (
            "Sent directly from BonBox. "
            "Reply to this email to reach the owner."
        )

    user_note_html = ""
    if (body.message or "").strip():
        from html import escape
        safe = escape(body.message.strip()).replace("\n", "<br>")
        user_note_html = (
            "<div style='margin:16px 0;padding:12px;background:#f9fafb;"
            "border-left:3px solid #10b981;color:#374151;font-size:14px;"
            "line-height:1.5;'>"
            f"{safe}"
            "</div>"
        )

    html = (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        f"{user_note_html}"
        f"<p style='color:#6b7280;font-size:13px;margin-top:16px;'>{footer}</p>"
        "</div>"
    )

    cc = [user.email] if (body.cc_self and user.email) else None
    ok, err = send_email_with_attachment(
        recipient, subject, html,
        attachment_bytes=pdf_bytes,
        attachment_filename=filename,
        attachment_mime="application/pdf",
        reply_to=user.email,
        cc=cc,
    )

    if not ok:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "email_send_failed",
                "reason": err or "unknown",
                "message": "Couldn't send right now. You can still download the PDF and email it manually.",
            },
        )

    # Bogføringsloven §10 — record the payroll delivery for audit
    # reconstruction. Payroll touches personal data (CPR if configured)
    # so the WHO/WHEN/TO of every send must be traceable.
    audit_service.record(
        db, user=user,
        action="payroll.send_to_accountant",
        entity_type="payroll_range",
        entity_id=None,
        before=None,
        after={
            "recipient": recipient, "cc_self": bool(cc),
            "filename": filename,
            "period_start": body.period_start.isoformat(),
            "period_end": body.period_end.isoformat(),
            "staff_ids": [str(s) for s in (body.staff_ids or [])],
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()

    return {
        "ok": True,
        "sent_to": recipient,
        "cc_self": bool(cc),
        "filename": filename,
        "subject": subject,
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Staff absences (sick calls today, PTO + future)
# ═══════════════════════════════════════════════════════════════════════════
#
# Owner-facing endpoints. Staff-facing endpoint lives in staff_portal.py
# (POST /portal/{token}/sick-call) so unauth'd staff can call sick from
# their phone without an account.
#
# Multi-layer:
#   L1 — get_current_user resolves the OWNER (no staff hits these)
#   L2 — service layer enforces tenant scoping (StaffAbsence.user_id ==
#        owner.id) on every read + mutation
#   L3 — pydantic schemas bound the input
#   L4 — distinct status codes for distinct failures (404 not-found,
#        422 validation, 403 cross-tenant — though service collapses
#        cross-tenant to 404 to avoid enumeration)

from pydantic import BaseModel as _BM, Field as _F  # local alias to keep imports tidy
from app.models.absence import StaffAbsence as _StaffAbsence
from app.services.sick_call_service import (
    acknowledge_sick_call as _ack_sick_call,
    assign_cover as _assign_cover,
    suggest_replacements as _suggest_replacements,
    SickCallError as _SickCallError,
)


class _AbsenceResponse(_BM):
    id: str
    staff_id: str
    staff_name: str | None = None
    kind: str
    schedule_id: str | None = None
    date: date
    reason: str | None = None
    status: str
    replacement_staff_id: str | None = None
    replacement_staff_name: str | None = None
    acknowledged_at: datetime | None = None
    called_at: datetime


class _AssignCoverRequest(_BM):
    replacement_staff_id: str = _F(..., description="Staff member who'll cover the shift")


def _serialize_absence(absence: _StaffAbsence, db: Session) -> _AbsenceResponse:
    """Hydrate display names — staff_name and replacement_staff_name —
    so the dashboard card can render without a second round-trip per
    row. One small N+1 here; if it ever shows in profiling we'll batch.
    """
    staff = db.query(StaffMember).filter(StaffMember.id == absence.staff_id).first()
    repl = None
    if absence.replacement_staff_id:
        repl = db.query(StaffMember).filter(
            StaffMember.id == absence.replacement_staff_id,
        ).first()
    return _AbsenceResponse(
        id=str(absence.id),
        staff_id=str(absence.staff_id),
        staff_name=staff.name if staff else None,
        kind=absence.kind,
        schedule_id=str(absence.schedule_id) if absence.schedule_id else None,
        date=absence.date,
        reason=absence.reason,
        status=absence.status,
        replacement_staff_id=str(absence.replacement_staff_id) if absence.replacement_staff_id else None,
        replacement_staff_name=repl.name if repl else None,
        acknowledged_at=absence.acknowledged_at,
        called_at=absence.called_at,
    )


@router.get("/absences", response_model=list[_AbsenceResponse])
def list_absences(
    days_back: int = Query(14, ge=1, le=90, description="How many days of history"),
    include_resolved: bool = Query(True, description="Include covered + cancelled"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner's recent absences. Default last 14 days. Tenant-scoped via
    user_id == user.id."""
    since = date.today() - timedelta(days=days_back)
    q = db.query(_StaffAbsence).filter(
        _StaffAbsence.user_id == user.id,
        _StaffAbsence.date >= since,
    )
    if not include_resolved:
        q = q.filter(_StaffAbsence.status.in_(("pending", "acknowledged")))
    rows = q.order_by(_StaffAbsence.date.desc(), _StaffAbsence.called_at.desc()).all()
    return [_serialize_absence(a, db) for a in rows]


@router.post("/absences/{absence_id}/acknowledge", response_model=_AbsenceResponse)
def acknowledge_absence(
    absence_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner clicked the notification / opened the dashboard surface.
    Bumps status pending → acknowledged + records timestamp. Idempotent
    (no-op if already acknowledged or covered)."""
    import uuid as _uuid
    try:
        absence_uuid = _uuid.UUID(absence_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid absence_id")
    try:
        absence = _ack_sick_call(db, owner_id=user.id, absence_id=absence_uuid)
    except _SickCallError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _serialize_absence(absence, db)


@router.post("/absences/{absence_id}/cover", response_model=_AbsenceResponse)
def assign_absence_cover(
    absence_id: str,
    body: _AssignCoverRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner picks a replacement staff. Service layer validates the
    replacement is real, active, and not the same person as the
    absentee."""
    import uuid as _uuid
    try:
        absence_uuid = _uuid.UUID(absence_id)
        replacement_uuid = _uuid.UUID(body.replacement_staff_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid id")
    try:
        absence = _assign_cover(
            db,
            owner_id=user.id,
            absence_id=absence_uuid,
            replacement_staff_id=replacement_uuid,
        )
    except _SickCallError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _serialize_absence(absence, db)


@router.get("/absences/{absence_id}/replacement-suggestions")
def suggest_absence_replacements(
    absence_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Returns up to 5 active staff who could cover this shift.
    Phase-1 heuristic: not already scheduled today + not the absent
    staff. Future iterations will rank by availability + recent hours."""
    import uuid as _uuid
    try:
        absence_uuid = _uuid.UUID(absence_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid absence_id")

    absence = db.query(_StaffAbsence).filter(
        _StaffAbsence.id == absence_uuid,
        _StaffAbsence.user_id == user.id,
    ).first()
    if not absence:
        raise HTTPException(status_code=404, detail="Absence not found")

    # If we know the role on the missed shift, prefer same role.
    role_filter: str | None = None
    if absence.schedule_id:
        sched = db.query(Schedule).filter(Schedule.id == absence.schedule_id).first()
        if sched:
            role_filter = sched.role_on_shift

    candidates = _suggest_replacements(
        db,
        owner_id=user.id,
        absent_staff_id=absence.staff_id,
        absence_date=absence.date,
        role_filter=role_filter,
    )
    return [
        {
            "id": str(c.id),
            "name": c.name,
            "role": c.role,
            "phone": c.phone,
        }
        for c in candidates
    ]


# ═══════════════════════════════════════════════════════════════════════════
#  Shift swap requests — owner approval surface
# ═══════════════════════════════════════════════════════════════════════════
#
# Staff propose + respond from the magic-link portal (staff_portal.py).
# Owner approves or denies here. Service layer enforces the atomic
# Schedule.staff_id flip on approve.

from app.models.shift_swap import ShiftSwapRequest as _ShiftSwapRequest
from app.services.shift_swap_service import (
    decide_swap as _decide_swap,
    list_pending_for_owner as _list_pending_for_owner,
    ShiftSwapError as _ShiftSwapError,
)


class _SwapDecideRequest(_BM):
    approve: bool
    note: str | None = None


class _SwapOwnerResponse(_BM):
    id: str
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


def _hydrate_swap_owner(swap: _ShiftSwapRequest, db: Session) -> _SwapOwnerResponse:
    """Same shape as the portal hydration, minus the viewer-direction
    field (owner sees both directions equally)."""
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
    return _SwapOwnerResponse(
        id=str(swap.id),
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


@router.get("/swap-requests", response_model=list[_SwapOwnerResponse])
def list_swap_requests(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner card / page — pending-approval swaps."""
    swaps = _list_pending_for_owner(db, owner_id=user.id)
    return [_hydrate_swap_owner(s, db) for s in swaps]


@router.post("/swap-requests/{swap_id}/decide", response_model=_SwapOwnerResponse)
def decide_swap_request(
    swap_id: str,
    body: _SwapDecideRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner approves or denies. On approve, the service layer atomically
    flips Schedule.staff_id on both shifts in the same transaction."""
    import uuid as _uuid
    try:
        swap_uuid = _uuid.UUID(swap_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid swap_id")
    try:
        swap = _decide_swap(
            db,
            owner_id=user.id,
            swap_id=swap_uuid,
            approve=body.approve,
            note=body.note,
        )
    except _ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _hydrate_swap_owner(swap, db)
