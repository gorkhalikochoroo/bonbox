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
from datetime import date, datetime, time as dtime, timedelta
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import Response, StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import case, func
from sqlalchemy.orm import Session
import json
from pydantic import BaseModel, EmailStr

from app.database import get_db
from app.models.user import User
from passlib.context import CryptContext
from app.models.staff import (
    StaffMember,
    StaffLink,
    StaffDocument,
    PayPeriodConfig,
    Schedule,
    HoursLogged,
    Tip,
    TipDistribution,
    NotificationLog,
    OpenShift,
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
    OpenShiftCreate,
    OpenShiftResponse,
)
from app.services.auth import get_current_user
from app.services.notification_service import (
    detect_shift_changes,
    send_shift_notifications,
    send_single_shift_notification,
    ShiftChange,
)
from app.services import audit_service
from app.services.tz_utils import business_today_local, now_local
from app.database import SessionLocal
from app.utils.time import utc_now
from app.utils.text import portal_path

def count_active_staff(db: Session, user_id) -> int:
    """Roster seats in use, for the `staff_members` cap.

    Named so the cap GATE and the usage PANEL call one function rather
    than two copies of the same query. A second copy is how a screen ends
    up telling an owner "3 of 50" while the gate blocks them — the count
    the owner sees has to be the count that stops them.

    A seat is active AND not deleted, so offboarding a leaver frees it —
    matching the /staff/members list exactly.
    """
    return (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user_id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .count()
    )


router = APIRouter()

# Rate-limit shared with the "today on shift" dashboard card.  60/min is
# permissive (the card refetches on focus + bonbox-data-changed events),
# but blocks the obvious scrape vector if /today is harvested in a loop.
_limiter = Limiter(key_func=client_ip)


# ═══════════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════════


def _require_owner_actor(user: User) -> None:
    """Owner-only gate for staff-CREDENTIAL surfaces (portal tokens + PINs).

    A staff magic-link token / PIN is a *credential*: whoever holds it can open
    the portal AS that staffer. It must never be readable or issuable by a
    delegated non-owner seat (manager/cashier/viewer) or an accountant view —
    otherwise a low-privilege seat could enumerate coworkers and harvest their
    portal tokens to impersonate them. get_current_user resolves those seats to
    the OWNER User for tenant reads, so the endpoints' own user.id filter does
    NOT distinguish them; this explicit check (a second, independent layer on
    top of the write-guard) is what draws the line. Real owner login only.
    """
    if getattr(user, "_is_member_view", False) or getattr(user, "_is_accountant_view", False):
        raise HTTPException(status_code=403, detail="owner_only")


def _parse_hhmm(t: str) -> float:
    """Parse 'HH:MM' into fractional hours from midnight."""
    parts = t.split(":")
    return int(parts[0]) + int(parts[1]) / 60.0


def _calc_shift_hours(start_time: str, end_time: str, break_minutes: int) -> float:
    """Calculate net hours for a shift, handling overnight spans."""
    s = _parse_hhmm(start_time)
    e = _parse_hhmm(end_time)
    if e < s:
        e += 24.0  # overnight shift (end strictly before start = crosses midnight)
    # end == start is a ZERO-length shift, NOT a 24h one — leave gross at 0 rather
    # than rolling +24h (which would silently pay a fat-fingered 16:00–16:00 as 24h).
    gross = e - s
    net = gross - (break_minutes / 60.0)
    # 2 decimals (not 1) so an 07:00–15:20 shift logs as 8.33h, not 8.3h —
    # 1-decimal rounding systematically shaved minutes off staff pay vs the
    # exact preview shown in ShiftModal/PublishConfirm.
    return round(max(net, 0), 2)


def _shift_end_dt(shift_date: date, start_time: str, end_time: str) -> datetime | None:
    """The naive-local instant a shift actually ENDS, or None if unparseable.

    Same overnight rule as _calc_shift_hours: an end strictly before the start
    crosses midnight, so a Friday 17:00-01:00 shift ends 01:00 SATURDAY — the
    thing a bare `date` comparison gets wrong. end == start is a zero-length
    shift, so it ends when it starts (never +24h).

    Callers use this to ask "has this shift finished?"; None means we cannot
    tell, and every caller must treat that as NOT finished.
    """
    try:
        s = _parse_hhmm(start_time)
        e = _parse_hhmm(end_time)
    except Exception:  # noqa: BLE001 — malformed row must not sink the request
        return None
    base = datetime.combine(shift_date, dtime(0, 0))
    if e < s:
        e += 24.0
    return base + timedelta(hours=e)


def _shifts_overlap(a_start: str, a_end: str, b_start: str, b_end: str) -> bool:
    """True if two same-day shifts share any clock time.

    Intervals are half-open [start, end) and use the same overnight rule as
    _calc_shift_hours (end <= start rolls the end past midnight, +24h). Two
    consequences that make this the *correct* guard, not a naive UNIQUE:

      • Split shifts are ALLOWED — 11:00–15:00 lunch + 18:00–23:00 dinner for
        the same person on the same day don't overlap, so both are kept.
      • Touching ends are ALLOWED — 11:00–15:00 + 15:00–23:00 (finish lunch,
        start dinner) don't overlap; the boundary belongs to neither.
      • A true double-booking IS rejected — 16:00–23:00 vs 18:00–02:00 overlap
        (one person can't be in two places at once). Overnight spans compare
        correctly because both roll past midnight before the test.

    Matches the half-open semantics of availability_engine._overlaps.
    """
    a_s = _parse_hhmm(a_start)
    a_e = _parse_hhmm(a_end)
    if a_e < a_s:
        a_e += 24.0  # crosses midnight (strict <; end == start is zero-length, not 24h)
    b_s = _parse_hhmm(b_start)
    b_e = _parse_hhmm(b_end)
    if b_e < b_s:
        b_e += 24.0
    return a_s < b_e and b_s < a_e


def _find_overlapping_shift(
    db: Session,
    *,
    user_id,
    staff_id,
    shift_date: date,
    start_time: str,
    end_time: str,
    exclude_id=None,
):
    """First existing same-staff, same-date shift whose clock time overlaps
    [start_time, end_time), or None.

    Tenant-scoped by user_id so the guard can never read another owner's rows.
    `exclude_id` skips the row being updated, so re-saving an unchanged shift
    never conflicts with itself.

    Scope: overlap is checked WITHIN a single calendar date — the cell the grid
    is keyed on. A shift that crosses midnight is matched on its start date
    only; cross-date bleed (a Mon 22:00–02:00 vs a separate Tue 01:00 row) is
    intentionally out of scope — the grid models one cell per staff per date and
    the owner sees both rows before publishing. Bulk paths (copy-week,
    autopilot/apply) build Schedule rows directly and are not routed through
    this guard; they produce drafts the owner reviews before publish.
    """
    q = db.query(Schedule).filter(
        Schedule.user_id == user_id,
        Schedule.staff_id == staff_id,
        Schedule.date == shift_date,
    )
    if exclude_id is not None:
        q = q.filter(Schedule.id != exclude_id)
    for other in q.all():
        if _shifts_overlap(start_time, end_time, other.start_time, other.end_time):
            return other
    return None


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

    # Branch names for the per-location grouping on the Today card (S4) —
    # one batch query, only when any shift carries a branch.
    _b_ids = {sh.branch_id for sh, _ in shifts if sh.branch_id}
    _b_names = {}
    if _b_ids:
        from app.models.branch import Branch
        for b in db.query(Branch).filter(Branch.id.in_(_b_ids)).all():
            _b_names[b.id] = b.name

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
                "branch_name": _b_names.get(shift.branch_id),
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
    members = q.order_by(StaffMember.name).all()

    # Delegated non-owner seats (manager/cashier/viewer) get the roster for
    # SCHEDULING (name / role / max-hours), but per-employee WAGES, TAX-CARD and
    # home contact are owner-only HR + GDPR-personal data. Strip them so a low-
    # privilege seat can never harvest coworkers' pay + home address. This is a
    # second, field-level layer on top of member_read_guard; the real owner
    # (no _is_member_view flag) sees everything.
    if getattr(user, "_is_member_view", False):
        redacted = []
        for m in members:
            r = StaffMemberResponse.model_validate(m)
            r.base_rate = r.evening_rate = r.weekend_rate = r.holiday_rate = None
            r.tax_card_type = r.tax_card_rate = None
            r.phone = r.email = r.address = r.postal_code = r.city = None
            redacted.append(r)
        return redacted
    return members


@router.post("/members", response_model=StaffMemberResponse)
def create_staff_member(
    data: StaffMemberCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # ── L6 tier gate — Vagtplan roster size (Free 3 / Starter 10 / Pro 25) ──
    # This is the ONLY place a StaffMember row is born, so it's the only gate
    # needed. A seat = active AND NOT is_deleted — the exact filter GET
    # /members uses, so the gate and the roster the owner sees can never
    # disagree, and offboarding a leaver frees a seat.
    #
    # Counted fresh on every add (not cached) so the gate can't drift.
    # GRANDFATHERED by construction: an account already over its cap keeps
    # every staffer and every shift — this refuses only the NEXT add, with
    # the canonical 402 upgrade payload. It never deletes or hides anyone.
    from app.services.billing import enforce_cap
    enforce_cap(user, "staff_members", count_active_staff(db, user.id))

    # Defense-in-depth: re-run the schema validators at the boundary even
    # though Pydantic already coerced. Catches malformed clients sending
    # raw strings/etc bypassing the Pydantic model.
    from app.schemas.staff import (
        _validate_tax_card_type, _validate_tax_card_rate, _clean_address_field,
    )
    addr = _clean_address_field(data.address, 200)
    postal = _clean_address_field(data.postal_code, 20)
    city = _clean_address_field(data.city, 120)
    member = StaffMember(
        id=uuid.uuid4(),
        user_id=user.id,
        name=data.name,
        phone=data.phone,
        email=data.email,
        address=addr,
        postal_code=postal,
        city=city,
        address_updated_at=utc_now() if (addr or postal or city) else None,
        role=data.role,
        contract_type=data.contract_type,
        base_rate=data.base_rate,
        evening_rate=data.evening_rate,
        weekend_rate=data.weekend_rate,
        holiday_rate=data.holiday_rate,
        max_hours_month=data.max_hours_month,
        max_hours_week=data.max_hours_week,
        hour_limit_warn=data.hour_limit_warn if data.hour_limit_warn is not None else True,
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
    from app.schemas.staff import (
        _validate_tax_card_type, _validate_tax_card_rate, _clean_address_field,
    )
    updates = data.model_dump(exclude_unset=True)
    if "tax_card_type" in updates:
        updates["tax_card_type"] = _validate_tax_card_type(updates["tax_card_type"])
    if "tax_card_rate" in updates:
        updates["tax_card_rate"] = _validate_tax_card_rate(updates["tax_card_rate"])
    # Address fields: trim/cap, blank → NULL. Stamp address_updated_at ONLY when
    # a value actually CHANGES — the owner's editor always sends these fields
    # (they're seeded from the row), so stamping on mere presence would refresh
    # "Opdateret {dato}" on every unrelated save (a rate tweak) and misrepresent
    # when the address was really last updated. Honest = stamp on real change.
    _addr_caps = {"address": 200, "postal_code": 20, "city": 120}
    _addr_changed = False
    for _f, _cap in _addr_caps.items():
        if _f in updates:
            new_val = _clean_address_field(updates[_f], _cap)
            updates[_f] = new_val
            if new_val != getattr(member, _f):
                _addr_changed = True
    if _addr_changed:
        member.address_updated_at = utc_now()

    # ── L6 tier gate — reactivation claims a seat, so it gates like an add ──
    # Deactivating frees a seat, so turning one back ON must pass the same cap
    # check; otherwise deactivate → add → reactivate walks straight past the
    # limit. Fires only on a real False → True flip (re-saving an already-active
    # member is untouched). The member being reactivated is excluded from the
    # count because it isn't holding a seat yet.
    if updates.get("active") is True and not member.active:
        from app.services.billing import enforce_cap
        active_others = (
            db.query(StaffMember)
            .filter(
                StaffMember.user_id == user.id,
                StaffMember.id != member.id,
                StaffMember.is_deleted.isnot(True),
                StaffMember.active.is_(True),
            )
            .count()
        )
        enforce_cap(user, "staff_members", active_others)

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


@router.get("/members/{member_id}/bank")
def get_staff_member_bank(
    member_id: str,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The FULL bank account for one staff member — owner only, and audited.

    This is the other half of the staff-entered account: the staffer types it in
    the portal, the owner reads it here to pay them. It is the only place the
    plaintext leaves the database, so three things are deliberate:

      • OWNER ONLY, via `_require_owner_actor`. The tenant filter below is NOT
        sufficient on its own: get_current_user resolves a delegated manager /
        cashier / viewer / accountant seat to the OWNER User, so
        `user_id == user.id` passes for all of them. A kontonummer is at least
        as sensitive as the portal tokens that gate already protects — a manager
        has no business reading a colleague's bank details. Relaxing this must
        be a deliberate decision, never a side effect of adding a role.
      • AUDITED ON READ, not just on write. A write trail tells you the number
        changed; only a read trail tells you who looked at it.
      • SEPARATE ENDPOINT. It is not folded into the member list, so the account
        is fetched when someone actually needs to pay — never sprayed across
        every roster render.
    """
    _require_owner_actor(user)  # a kontonummer is owner-only, like portal credentials
    # Shared-device curtain. The middleware's deny-prefix list is the MANAGER
    # deny-list and /api/staff is deliberately not on it (managers need the
    # roster), so this endpoint has to check the flag itself — the same
    # per-endpoint hatch dashboard.py:269 uses. Without it, a curtained tablet
    # hides revenue while every employee's full kontonummer is one tap away.
    if getattr(user, "_shared_device_locked", False):
        raise HTTPException(status_code=403, detail="device_pin_required")

    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    from app.services import staff_bank

    if not staff_bank.has_bank(member):
        return {"has_bank": False, "reg_nr": None, "account_number": None, "updated_at": None}

    reg = staff_bank.decrypt_account(member.bank_reg_nr_enc)
    acct = staff_bank.decrypt_account(member.bank_account_enc)

    # The owner UI tells the owner "viewing an account is recorded in the audit
    # log", so a failure here must be LOUD. `audit_service.record` swallows its
    # own exceptions and returns normally, so a bare `except: pass` around it
    # would catch nothing and the promise would quietly become false — log the
    # failure and roll back rather than leaving a half-written transaction.
    try:
        from app.services import audit_service

        audit_service.record(
            db, user.id, "staff.bank_viewed", "staff_member",
            entity_id=member.id,
            # Masked in the trail — the audit log must not become a plaintext
            # mirror of the column it is auditing.
            after={"masked": staff_bank.mask(acct)},
            actor_type="owner",
            ip_address=client_ip(request) if request else None,
        )
        db.commit()
    except Exception as e:  # noqa: BLE001 — never block the read, but say so
        import logging  # module-local, matching this file's existing pattern

        logging.getLogger(__name__).warning(
            "staff.bank_viewed audit failed for member=%s: %s", member_id, e
        )
        db.rollback()

    return {
        "has_bank": True,
        "reg_nr": reg,
        "account_number": acct,
        "updated_at": member.bank_updated_at.isoformat() if member.bank_updated_at else None,
    }


@router.delete("/members/{member_id}/bank")
def clear_staff_member_bank(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner clears a staff member's account. Owner-only, audited, idempotent.

    Exists because the staffer's own DELETE stops working the moment they are
    offboarded: `_get_staff_from_token` requires `active.is_(True)`, so every
    portal /bank route 404s for a deactivated staffer. Without this the data
    subject loses their only erasure lever exactly when the retention
    justification ("still owed a final salary") starts expiring — and
    account-level erasure does not reach the row either (see the note on
    StaffMember.bank_reg_nr_enc). This is the offboarding lever.

    Deliberately does NOT filter on `active`: clearing the account of someone
    who has already left is the entire point.
    """
    _require_owner_actor(user)  # a kontonummer is owner-only, like portal credentials
    # Shared-device curtain. The middleware's deny-prefix list is the MANAGER
    # deny-list and /api/staff is deliberately not on it (managers need the
    # roster), so this endpoint has to check the flag itself — the same
    # per-endpoint hatch dashboard.py:269 uses. Without it, a curtained tablet
    # hides revenue while every employee's full kontonummer is one tap away.
    if getattr(user, "_shared_device_locked", False):
        raise HTTPException(status_code=403, detail="device_pin_required")

    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    from app.services import staff_bank

    had = staff_bank.has_bank(member)
    staff_bank.clear_bank(member)

    if had:
        try:
            from app.services import audit_service

            audit_service.record(
                db, user.id, "staff.bank_cleared", "staff_member",
                entity_id=member.id, actor_type="owner",
            )
        except Exception:  # noqa: BLE001 — audit is best-effort, never blocks the clear
            pass

    db.commit()
    return {"has_bank": False}


# ── Employment documents ───────────────────────────────────────────────────
#
# The owner uploads a contract/addendum/certificate for ONE staff member; the
# staffer reads it in their portal behind the PIN. Same access shape as the bank
# endpoints: owner-only, curtain-checked, tenant-scoped.
#
# Not owner-only out of habit — a document addressed to one employee is that
# employee's personal data, and a delegated manager seat has no business
# enumerating their colleagues' contracts.


def _member_or_404(member_id: str, user: User, db: Session):
    """Tenant-scoped lookup. Deliberately does NOT filter on `active`: an
    offboarded staffer's documents still have to be listable and removable."""
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")
    return member


@router.get("/members/{member_id}/documents")
def list_staff_documents(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Documents shared with one staff member. Metadata only — no blob."""
    _require_owner_actor(user)
    if getattr(user, "_shared_device_locked", False):
        raise HTTPException(status_code=403, detail="device_pin_required")
    member = _member_or_404(member_id, user, db)

    rows = (
        db.query(StaffDocument)
        .filter(StaffDocument.staff_id == member.id, StaffDocument.user_id == user.id)
        .order_by(StaffDocument.uploaded_at.desc())
        .all()
    )
    return [
        {
            "id": str(r.id),
            "label": r.label,
            "content_type": r.content_type,
            "size_bytes": r.size_bytes,
            "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
        }
        for r in rows
    ]


@router.post("/members/{member_id}/documents")
def upload_staff_document(
    member_id: str,
    request: Request,
    label: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner shares a document with one staff member."""
    _require_owner_actor(user)
    if getattr(user, "_shared_device_locked", False):
        raise HTTPException(status_code=403, detail="device_pin_required")
    member = _member_or_404(member_id, user, db)

    from app.services import staff_documents
    from app.services.storage import compose_key, get_storage

    raw = file.file.read(staff_documents.MAX_BYTES + 1)
    try:
        content_type, ext, sha, clean_label = staff_documents.inspect_upload(raw, label)
    except staff_documents.DocumentRejected as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})

    key = compose_key(user.id, "staff_document", sha, ext=ext)
    get_storage().put(key, raw, content_type)

    doc = StaffDocument(
        user_id=user.id,
        staff_id=member.id,
        label=clean_label,
        storage_key=key,
        content_type=content_type,
        size_bytes=len(raw),
    )
    db.add(doc)

    try:
        from app.services import audit_service

        audit_service.record(
            db, user.id, "staff.document_shared", "staff_member",
            entity_id=member.id, after={"label": clean_label}, actor_type="owner",
            ip_address=client_ip(request) if request else None,
        )
    except Exception as e:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("staff.document_shared audit failed: %s", e)

    db.commit()
    return {
        "id": str(doc.id),
        "label": doc.label,
        "content_type": doc.content_type,
        "size_bytes": doc.size_bytes,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
    }


@router.delete("/documents/{doc_id}", status_code=204)
def delete_staff_document(
    doc_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner un-shares a document. Removes the row AND the blob.

    The blob is content-addressed, so two staffers given the identical file
    share one key — only delete it when no other row still points at it, or
    removing one person's copy would break the other's.
    """
    _require_owner_actor(user)
    doc = db.query(StaffDocument).filter(
        StaffDocument.id == doc_id,
        StaffDocument.user_id == user.id,
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    key = doc.storage_key
    db.delete(doc)
    db.flush()

    still_referenced = db.query(StaffDocument).filter(StaffDocument.storage_key == key).first()
    if not still_referenced:
        try:
            from app.services.storage import get_storage

            get_storage().delete(key)
        except Exception:  # noqa: BLE001 — the Art.17 prefix purge is the backstop
            pass

    try:
        from app.services import audit_service

        audit_service.record(
            db, user.id, "staff.document_removed", "staff_member",
            entity_id=doc.staff_id, after={"label": doc.label}, actor_type="owner",
        )
    except Exception:  # noqa: BLE001
        pass

    db.commit()


@router.get("/members/{member_id}/photo")
def get_staff_member_photo(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner-side proxy for a staffer's profile photo. Tenant-scoped
    (StaffMember.user_id == the caller) so an owner only ever sees their own
    staff. The staffer sets the photo from the portal; the owner UI renders it
    here with ?v={profile_photo_at} so a change shows up immediately. 404 when
    none set → the UI falls back to initials."""
    member = db.query(StaffMember).filter(
        StaffMember.id == member_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not member or not member.profile_photo_key:
        raise HTTPException(status_code=404, detail="No profile photo")
    from app.services.storage import get_storage

    data = get_storage().get(member.profile_photo_key)
    if data is None:
        raise HTTPException(status_code=404, detail="No profile photo")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# ═══════════════════════════════════════════════════════════════════════════
#  STAFF PORTAL LINKS (magic links for staff self-service)
# ═══════════════════════════════════════════════════════════════════════════

_pin_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Unambiguous alphabet for the short join code — no 0/O/1/I to avoid
# mistypes when a staffer reads it off the owner's screen.
_JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _gen_join_code(n: int = 6) -> str:
    return "".join(secrets.choice(_JOIN_ALPHABET) for _ in range(n))


# How long a join code stays valid. Long enough that an owner can text it and
# the staffer connects before their next shift; short enough that a code
# photographed off a staff-room whiteboard, or left in an old message thread,
# is dead by the time anyone finds it.
JOIN_CODE_TTL_DAYS = 7


def _join_code_live(link: StaffLink) -> bool:
    """True when the link's current code can still be redeemed."""
    if not link.join_code:
        return False
    if link.code_used_at is not None:
        return False
    if link.code_expires_at is not None and link.code_expires_at <= utc_now():
        return False
    # Codes minted before migration 072 have no expiry stamp. Treat them as
    # LIVE rather than silently dead — an owner mid-onboarding should not find
    # a code they just shared has stopped working because of a deploy. They
    # pick up a TTL the next time they are regenerated.
    return True


def _ensure_join_code(db: Session, link: StaffLink) -> str:
    """Get-or-mint the link's short join code.

    Idempotent while the code is still live; mints a fresh one once it has been
    redeemed or expired, so the owner never has to know the difference — they
    ask for the code and get one that works.
    """
    if _join_code_live(link):
        return link.join_code
    link.join_code = None      # release the old value so the unique index frees it
    link.code_used_at = None
    for _ in range(8):
        code = _gen_join_code()
        clash = db.query(StaffLink.id).filter(StaffLink.join_code == code).first()
        if not clash:
            link.join_code = code
            link.code_expires_at = utc_now() + timedelta(days=JOIN_CODE_TTL_DAYS)
            try:
                db.commit()
                return code
            except Exception:  # noqa: BLE001 — lost the unique race; retry
                db.rollback()
    # Astronomically unlikely fallback — widen the code space.
    link.join_code = _gen_join_code(8)
    link.code_expires_at = utc_now() + timedelta(days=JOIN_CODE_TTL_DAYS)
    db.commit()
    return link.join_code


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
    _require_owner_actor(user)  # minting a portal credential — owner-only
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
            "join_code": _ensure_join_code(db, existing),
            "portal_url": portal_path(existing.token, user.business_name, member.name),
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
        "join_code": _ensure_join_code(db, link),
        "portal_url": portal_path(link.token, user.business_name, member.name),
        "created_at": link.created_at,
    }


@router.get("/members/{member_id}/link")
def get_staff_link(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the active portal link for a staff member."""
    _require_owner_actor(user)  # a coworker's portal token is a credential — owner-only
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
        "portal_url": portal_path(link.token, user.business_name, member.name if member else None),
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
    _require_owner_actor(user)  # revoking a portal credential — owner-only
    db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).update({"active": False})
    db.commit()


class PinSetRequest(BaseModel):
    # Optional. Owners never need to invent a PIN — omit it and the server
    # generates a random 4-digit one, returned once so the owner can hand it
    # to the staffer. A custom pin is still accepted if provided.
    pin: str | None = None


def _gen_pin() -> str:
    """A random 4-digit PIN, avoiding the easily-shoulder-surfed all-same
    ('0000') and trivial sequences ('1234'/'4321')."""
    weak = {"0000", "1111", "2222", "3333", "4444", "5555", "6666",
            "7777", "8888", "9999", "1234", "4321"}
    for _ in range(20):
        p = f"{secrets.randbelow(10000):04d}"
        if p not in weak:
            return p
    return f"{secrets.randbelow(10000):04d}"


@router.post("/members/{member_id}/link/pin")
def set_staff_link_pin(
    member_id: str,
    # None default: FastAPI treats a Pydantic body param as REQUIRED even
    # when every field inside is optional — a bare no-body POST (the normal
    # "generate one for me" call) 422'd with "Field required".
    body: PinSetRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Turn ON the extra PIN lock for a staff link.

    Simple by design: the owner taps "Require PIN"; we GENERATE a random
    4-digit code and return it ONCE (plaintext) so they can read it to the
    staffer. Setting a new PIN clears any lockout and — because the L2 proof
    binds to pin_hash — signs out every device that was already in (staff
    re-enter the new PIN once). See [staff_portal multi-layer]."""
    _require_owner_actor(user)  # setting a staff PIN — owner-only
    link = db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="No active link found")

    if body is not None and body.pin is not None:
        if len(body.pin) != 4 or not body.pin.isdigit():
            raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")
        pin = body.pin
    else:
        pin = _gen_pin()

    link.pin_hash = _pin_ctx.hash(pin)
    link.pin_failed_count = 0
    link.pin_locked_until = None
    audit_service.record(
        db, user, "staff.link.pin_set", "staff_link",
        entity_id=link.id, after={"staff_id": str(member_id)},
    )
    db.commit()
    # Plaintext returned ONCE — never stored, never logged.
    return {"pin": pin, "has_pin": True}


@router.delete("/members/{member_id}/link/pin", status_code=200)
def clear_staff_link_pin(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Turn OFF the PIN lock — the link works with no PIN again."""
    _require_owner_actor(user)  # clearing a staff PIN — owner-only
    link = db.query(StaffLink).filter(
        StaffLink.staff_id == member_id,
        StaffLink.user_id == user.id,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="No active link found")

    link.pin_hash = None
    link.pin_failed_count = 0
    link.pin_locked_until = None
    audit_service.record(
        db, user, "staff.link.pin_cleared", "staff_link",
        entity_id=link.id, after={"staff_id": str(member_id)},
    )
    db.commit()
    return {"has_pin": False}


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
    _require_owner_actor(user)  # bulk portal credentials — owner-only
    members = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
        )
        .all()
    )
    out = []
    dirty = False
    used: set = set()  # codes assigned in THIS batch (not yet committed → invisible to DB query)
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
            dirty = True
        if not link.join_code:
            for _ in range(8):
                code = _gen_join_code()
                if code in used:
                    continue
                clash = db.query(StaffLink.id).filter(StaffLink.join_code == code).first()
                if not clash:
                    link.join_code = code
                    used.add(code)
                    dirty = True
                    break
        out.append({
            "staff_id": str(m.id),
            "staff_name": m.name,
            "email": m.email,
            "join_code": link.join_code,
            "has_pin": bool(link.pin_hash),
            "portal_url": portal_path(link.token, user.business_name, m.name),
        })
    if dirty:
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
        restaurant_name = (
            getattr(user, "business_name", None)
            or (profile.business_name if profile else None)
            or "BonBox"
        )
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

            portal_url = f"https://www.bonbox.dk{portal_path(link.token, user.business_name, member.name)}"
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
        ip_address=client_ip(request) if request else None,
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
    # Include the frame fields alongside the computed window so the client can
    # hydrate its picker + navigate prev/next on the correct frame from first
    # load (without a second GET /pay-period). Back-compatible: purely additive.
    result = _compute_pay_period(config, date.today())
    result["period_type"] = config.period_type
    result["custom_start_day"] = config.custom_start_day
    return result


# ═══════════════════════════════════════════════════════════════════════════
#  SCHEDULES
# ═══════════════════════════════════════════════════════════════════════════


class CopyWeekBody(BaseModel):
    source_week: date
    target_week: date


@router.get("/availability")
def owner_list_availability(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """All staff availability for this owner — the grid paints 'kan ikke' cells
    so at 15-30 rows the owner spots conflicts at a glance. Recurring weekday
    rows apply every week; one-off date rows carry their date. Tenant-scoped.
    A soft signal only — the owner can still place a shift there, they just see
    the clash. The staffer's `note` is operational (e.g. 'undervisning til 16'),
    shown to the owner who needs it to schedule around it."""
    from app.models.staff import StaffAvailability
    rows = (
        db.query(StaffAvailability)
        .filter(StaffAvailability.user_id == user.id)
        .all()
    )
    return {
        "availability": [
            {
                "id": str(a.id),
                "staff_id": str(a.staff_id),
                "kind": a.kind,
                "weekday": a.weekday,
                "date": a.specific_date.isoformat() if a.specific_date else None,
                "start_time": a.start_time,
                "end_time": a.end_time,
                "note": a.note,
            }
            for a in rows
        ]
    }


@router.get("/schedules", response_model=list[ScheduleResponse])
def list_schedules(
    week_start: date = Query(..., description="Monday of the target week (YYYY-MM-DD)"),
    branch_id: str | None = Query(None, description="Filter to one location (multi-location S3)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    week_end = week_start + timedelta(days=6)
    q = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
        )
    )
    # Location lens — ONE roster, filtered; never separate rosters. The
    # branch view includes UNASSIGNED shifts (branch_id NULL): they belong
    # everywhere, and hiding them would make a shift silently vanish the
    # moment the owner switches location.
    if branch_id:
        from sqlalchemy import or_
        q = q.filter(or_(Schedule.branch_id == branch_id, Schedule.branch_id.is_(None)))
    return q.order_by(Schedule.date, Schedule.start_time).all()


def _validated_branch_id(db: Session, user: User, branch_id):
    """None-safe gate: a shift's branch must be one of the OWNER's active
    branches — a bogus/foreign id degrades to None (unassigned) rather than
    422 so a stale branch picker never blocks shift creation."""
    if not branch_id:
        return None
    from app.models.branch import Branch
    b = (
        db.query(Branch)
        .filter(
            Branch.id == branch_id,
            Branch.user_id == user.id,
            Branch.is_active.is_(True),
        )
        .first()
    )
    return b.id if b else None


@router.get("/schedules/week-cost")
def schedule_week_cost(
    week_start: date = Query(..., description="Monday of the target week (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Labor-cost rollup for the owner's weekly schedule grid (Planday-style).

    Returns gross wage (hourly rate x worked hours) per shift, per staff, per
    day, and for the week — plus an "inkl. feriepenge" loaded estimate (+12.5%)
    and labor% vs effective revenue (locked DailyClose wins). The hourly rate
    is resolved PER SHIFT via _pick_rate, so a staff member's evening/weekend
    premium (when set) lifts that shift's cost; staff with no premium are
    billed at base — identical to before.

    OWNER-ONLY by construction: every query is scoped to user.id and the staff
    portal never calls this. Raw wage rates stay server-side — only computed
    costs cross the wire.

    Multi-barrier: L1 auth (get_current_user) - L5 tenant scope (user.id on
    every query) - L4 fail-soft (missing rate -> autopilot default; missing
    revenue -> labor% null, never 500) - honest (loaded cost is flagged a
    feriepenge estimate; ATP is excluded since it is monthly-tiered, not
    per-shift, and would mislead).
    """
    from app.services.schedule_autopilot import (
        _staff_hourly_rate,
        _shift_hours,
        DEFAULT_HOURLY_RATE,
    )
    from app.services.revenue_resolver import effective_revenue_by_date
    from app.services.reservation_insights_service import booked_covers_by_business_day

    FERIE_UPLIFT = 0.125  # feriepenge — the clean, dominant employer on-cost

    week_end = week_start + timedelta(days=6)

    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
        )
        .all()
    )

    staff_rows = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
        )
        .all()
    )
    staff_by_id = {s.id: s for s in staff_rows}
    name_by_staff = {s.id: s.name for s in staff_rows}

    per_shift: dict[str, dict] = {}
    staff_acc: dict[str, dict] = {}
    day_acc: dict[str, dict] = {}

    for sh in shifts:
        st = staff_by_id.get(sh.staff_id)
        # Per-shift rate: _pick_rate applies the member's evening/weekend
        # premium WHEN configured, else returns base. Guard the no-rate case
        # (base unset) with the autopilot's DEFAULT-backed floor, so a venue
        # that never sets a premium sees identical numbers to before.
        if st is not None:
            rate = _pick_rate(st, sh.date, sh.start_time)
            if rate <= 0:
                rate = _staff_hourly_rate(st)
        else:
            rate = DEFAULT_HOURLY_RATE
        hours = _shift_hours(sh.start_time, sh.end_time, sh.break_minutes or 0)
        gross = hours * rate
        loaded = gross * (1.0 + FERIE_UPLIFT)

        per_shift[str(sh.id)] = {
            "hours": round(hours, 2),
            "cost_gross": round(gross, 2),
            "cost_loaded": round(loaded, 2),
        }

        sa = staff_acc.setdefault(
            str(sh.staff_id),
            {
                "staff_id": str(sh.staff_id),
                "name": name_by_staff.get(sh.staff_id) or "—",
                "hours": 0.0,
                "cost_gross": 0.0,
                "cost_loaded": 0.0,
            },
        )
        sa["hours"] += hours
        sa["cost_gross"] += gross
        sa["cost_loaded"] += loaded

        di = sh.date.isoformat()
        da = day_acc.setdefault(
            di, {"hours": 0.0, "cost_gross": 0.0, "cost_loaded": 0.0}
        )
        da["hours"] += hours
        da["cost_gross"] += gross
        da["cost_loaded"] += loaded

    try:
        rev_by_date = effective_revenue_by_date(db, user.id, week_start, week_end)
    except Exception:
        rev_by_date = {}

    # Booked covers per day — the demand half of the grid. Already fail-soft
    # internally (returns None on any error), so the wage-cost rollup can never
    # 500 because the booking book hiccuped.
    #
    # NOTE on bucketing: covers are bucketed by BUSINESS day (DK 06:00 cutoff —
    # a 00:30 Saturday booking is Friday's service), while hours/cost above are
    # bucketed by Schedule.date, a plain CALENDAR day. They intentionally differ.
    # "Tonight" for a restaurant means the business day, and re-bucketing cost to
    # business day would move every labor% and wage number downstream. Do not
    # "fix" this to match without pricing that change.
    covers_by_date = booked_covers_by_business_day(db, user, week_start, week_end)

    daily = []
    week_hours = week_gross = week_loaded = week_rev = 0.0
    for i in range(7):
        d = week_start + timedelta(days=i)
        di = d.isoformat()
        da = day_acc.get(di, {"hours": 0.0, "cost_gross": 0.0, "cost_loaded": 0.0})
        rev = float(rev_by_date.get(d, 0.0) or 0.0)
        week_hours += da["hours"]
        week_gross += da["cost_gross"]
        week_loaded += da["cost_loaded"]
        week_rev += rev
        daily.append({
            "date": di,
            "hours": round(da["hours"], 2),
            "cost_gross": round(da["cost_gross"], 2),
            "cost_loaded": round(da["cost_loaded"], 2),
            "revenue": round(rev, 2) if rev > 0 else None,
            "labor_pct_gross": round(da["cost_gross"] / rev, 4) if rev > 0 else None,
            "labor_pct_loaded": round(da["cost_loaded"] / rev, 4) if rev > 0 else None,
            # null = not a reservations venue (render nothing) — NOT the same as
            # 0 = reservations on, empty book. Never collapse the two.
            "covers_booked": (
                covers_by_date.get(d, 0) if covers_by_date is not None else None
            ),
        })

    per_staff = sorted(
        (
            {
                "staff_id": v["staff_id"],
                "name": v["name"],
                "hours": round(v["hours"], 2),
                "cost_gross": round(v["cost_gross"], 2),
                "cost_loaded": round(v["cost_loaded"], 2),
            }
            for v in staff_acc.values()
        ),
        key=lambda r: r["cost_gross"],
        reverse=True,
    )

    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    target_pct = float(getattr(profile, "target_labor_pct", None) or 0.30)

    return {
        "week_start": week_start.isoformat(),
        "ferie_uplift": FERIE_UPLIFT,
        "target_labor_pct": round(target_pct, 4),
        "per_shift": per_shift,
        "per_staff": per_staff,
        "daily": daily,
        "week": {
            "hours": round(week_hours, 2),
            "cost_gross": round(week_gross, 2),
            "cost_loaded": round(week_loaded, 2),
            "revenue": round(week_rev, 2) if week_rev > 0 else None,
            "labor_pct_gross": round(week_gross / week_rev, 4) if week_rev > 0 else None,
            "labor_pct_loaded": round(week_loaded / week_rev, 4) if week_rev > 0 else None,
        },
    }


@router.get("/schedules/week-load")
def schedule_week_load(
    week_start: date = Query(..., description="Monday of the target week (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Vagtplan Shield — per-staff weekly load + DK labour-law signals for the
    owner grid and the pre-publish check.

    The Autopilot already enforces the contract cap + the DK ceilings when IT
    proposes a week, but the MANUAL path (Add Shift / drag / copy-week) had no
    surfacing at all — an owner could publish 41 hours onto a 25-hour
    part-timer without ever seeing a number. This returns, per staff member
    with any shift in the window:

      hours          — scheduled hours inside the week (draft + published;
                       the owner is planning, so drafts count)
      cap            — their contract max_hours_week (null when unset)
      over_cap       — hours exceed the contract cap
      over_dk48      — hours exceed the DK 48h weekly ceiling
      rest_warnings  — 11-timers reglen: consecutive shifts with under
                       DK_MIN_DAILY_REST_HOURS between end and next start
                       (arbejdsmiljøloven). Shifts are scanned with a ±1 day
                       margin so a Sunday→Monday violation across the week
                       boundary is still caught; only pairs touching the
                       requested week are reported.

    Signals only — publishing is NEVER blocked (proposes-never-decides
    doctrine; §-checks are the owner's call, we just make them visible).
    Owner-scoped like week-cost: every query filters user.id; the staff
    portal never calls this."""
    from datetime import datetime as _dt, timedelta as _td

    from app.services.schedule_autopilot import (
        _shift_hours,
        DK_MAX_HOURS_PER_WEEK,
        DK_MIN_DAILY_REST_HOURS,
    )

    week_end = week_start + timedelta(days=6)
    # Monthly counting window = the tenant's OWN counting period when a
    # PayPeriodConfig exists (1.–31., 15.–14., custom start day like 16.–15.)
    # — workplaces count "the month" from their payroll cut, so a 90 t-md
    # limit must follow the same window or the number the owner sees here
    # disagrees with the number on the lønseddel. Fallbacks: no config →
    # calendar month; biweekly payroll → ALSO calendar month (a 14-day pay
    # period is not a monthly window; comparing a per-month cap against 14
    # days would systematically under-warn).
    import calendar as _cal

    _cfg = (
        db.query(PayPeriodConfig)
        .filter(PayPeriodConfig.user_id == user.id)
        .first()
    )

    def _month_window(ref: date) -> tuple[date, date]:
        if _cfg is not None and _cfg.period_type != "biweekly":
            # _compute_pay_period returns isoformat STRINGS (API-facing).
            p = _compute_pay_period(_cfg, ref)
            return date.fromisoformat(p["start_date"]), date.fromisoformat(p["end_date"])
        return (
            ref.replace(day=1),
            ref.replace(day=_cal.monthrange(ref.year, ref.month)[1]),
        )

    # A week can straddle a period boundary — evaluate both windows.
    _windows = {_month_window(week_start), _month_window(week_end)}
    lo = min([week_start - timedelta(days=1)] + [w[0] for w in _windows])
    hi = max([week_end + timedelta(days=1)] + [w[1] for w in _windows])

    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= lo,
            Schedule.date <= hi,
        )
        .all()
    )
    staff_rows = (
        db.query(StaffMember)
        .filter(StaffMember.user_id == user.id)
        .all()
    )
    staff_by_id = {s.id: s for s in staff_rows}

    def _parse_hhmm(v: str):
        try:
            h, m = (v or "0:0").split(":")
            return int(h), int(m)
        except Exception:  # noqa: BLE001 — malformed time reads as midnight
            return 0, 0

    def _bounds(s: Schedule):
        sh, sm = _parse_hhmm(s.start_time)
        eh, em = _parse_hhmm(s.end_time)
        start_dt = _dt(s.date.year, s.date.month, s.date.day, sh, sm)
        end_dt = _dt(s.date.year, s.date.month, s.date.day, eh, em)
        if end_dt < start_dt:  # overnight — mirrors _shift_hours's strict `<`
            end_dt += _td(days=1)
        return start_dt, end_dt

    by_staff: dict = {}
    for s in shifts:
        by_staff.setdefault(s.staff_id, []).append(s)

    out = []
    for sid, rows in by_staff.items():
        member = staff_by_id.get(sid)
        if member is None:
            continue

        hours = sum(
            _shift_hours(s.start_time, s.end_time, s.break_minutes or 0)
            for s in rows
            if week_start <= s.date <= week_end
        )
        hours = round(hours, 2)

        rest_warnings = []
        ordered = sorted(rows, key=lambda s: _bounds(s)[0])
        for prev, nxt in zip(ordered, ordered[1:]):
            # Only report pairs that touch the requested week — the margin
            # days exist to catch boundary gaps, not to police other weeks.
            if not (week_start <= prev.date <= week_end or week_start <= nxt.date <= week_end):
                continue
            gap_h = (_bounds(nxt)[0] - _bounds(prev)[1]).total_seconds() / 3600.0
            if gap_h < DK_MIN_DAILY_REST_HOURS:
                rest_warnings.append({
                    "prev_date": prev.date.isoformat(),
                    "next_date": nxt.date.isoformat(),
                    "gap_hours": round(gap_h, 1),
                })

        cap = float(member.max_hours_week) if member.max_hours_week else None

        # Monthly load — hours inside the counting window(s) this week
        # touches (see _month_window above; report the highest-loaded one so
        # the warning fires as soon as EITHER is at risk). Effective cap:
        # explicit max_hours_month wins; else part-time/student contracts
        # default to the 90 t-md limit (the SIRI student-work ceiling —
        # widely applicable in DK hospitality and visa-serious to breach).
        # Owner can adjust or toggle off per staff.
        month_hours = 0.0
        month_window = None
        for (ws, we) in sorted(_windows):  # deterministic label on ties
            mh = sum(
                _shift_hours(s.start_time, s.end_time, s.break_minutes or 0)
                for s in rows
                if ws <= s.date <= we
            )
            if mh > month_hours or month_window is None:
                month_hours = mh
                month_window = (ws, we)
        month_hours = round(month_hours, 2)
        period_label = (
            f"{month_window[0].day}.{month_window[0].month}.–"
            f"{month_window[1].day}.{month_window[1].month}."
            if month_window else None
        )

        if member.max_hours_month:
            month_cap, month_cap_source = float(member.max_hours_month), "explicit"
        elif (member.contract_type or "") in ("part", "student"):
            month_cap, month_cap_source = 90.0, "default90"
        else:
            month_cap, month_cap_source = None, None

        # The toggle silences hour-LIMIT warnings only. Rest warnings
        # (11-timers reglen) always report — hviletid is safety law.
        warn = member.hour_limit_warn is not False

        out.append({
            "staff_id": str(sid),
            "name": member.name,
            "hours": hours,
            "cap": cap,
            "warn_enabled": warn,
            "over_cap": bool(warn and cap is not None and hours > cap + 0.01),
            "over_dk48": bool(warn and hours > DK_MAX_HOURS_PER_WEEK + 0.01),
            "month_hours": month_hours,
            "month_cap": month_cap,
            "month_cap_source": month_cap_source,
            "period_label": period_label,
            "over_month": bool(warn and month_cap is not None and month_hours > month_cap + 0.01),
            "rest_warnings": rest_warnings,
        })

    return {
        "week_start": week_start.isoformat(),
        "dk_max_week": DK_MAX_HOURS_PER_WEEK,
        "dk_min_rest": DK_MIN_DAILY_REST_HOURS,
        "staff": out,
    }


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

    # A zero-length shift (start == end) is always a typo, never intended, and
    # it used to render inconsistently across surfaces (0h vs 24h). Reject it at
    # the source so the bad row never reaches the grid/payroll.
    if data.start_time == data.end_time:
        raise HTTPException(status_code=400, detail={
            "code": "equal_times", "message": "Start og slut kan ikke være ens."})

    # Bounds layer — one person can't work two overlapping shifts the same day.
    # The grid disables occupied cells client-side; this is the server-side
    # barrier against a stale grid / race / direct API call that would double-
    # book a staffer and silently inflate labor cost + payroll. Split shifts and
    # back-to-back shifts stay allowed (see _shifts_overlap).
    conflict = _find_overlapping_shift(
        db,
        user_id=user.id,
        staff_id=data.staff_id,
        shift_date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
    )
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "shift_overlap",
                "message": (
                    f"{staff.name} already has a shift "
                    f"{conflict.start_time}–{conflict.end_time} that day."
                ),
            },
        )

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
        branch_id=_validated_branch_id(db, user, data.branch_id),
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

    # Validate the (possibly reassigned) staff_id belongs to this owner.
    # create_schedule already does this; update must too, or an owner could
    # point their shift at another tenant's staff member (IDOR parity).
    new_staff = db.query(StaffMember).filter(
        StaffMember.id == data.staff_id,
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not new_staff:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # Zero-length shift (start == end) is always a typo — reject at the source.
    if data.start_time == data.end_time:
        raise HTTPException(status_code=400, detail={
            "code": "equal_times", "message": "Start og slut kan ikke være ens."})

    # Bounds layer — reject a move/edit that lands this shift on top of another
    # shift the same staffer already has that day (excluding this row itself, so
    # an unchanged re-save never self-conflicts). Covers the drag-to-move PUT:
    # the client only drops onto empty cells, but a stale grid / race / direct
    # API call must not be able to double-book. Split + back-to-back stay legal.
    conflict = _find_overlapping_shift(
        db,
        user_id=user.id,
        staff_id=data.staff_id,
        shift_date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
        exclude_id=shift.id,
    )
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "shift_overlap",
                "message": (
                    f"{new_staff.name} already has a shift "
                    f"{conflict.start_time}–{conflict.end_time} that day."
                ),
            },
        )

    shift.staff_id = data.staff_id
    shift.date = data.date
    shift.start_time = data.start_time
    shift.end_time = data.end_time
    shift.break_minutes = data.break_minutes
    shift.role_on_shift = data.role_on_shift
    shift.status = data.status
    shift.notes = data.notes
    shift.branch_id = _validated_branch_id(db, user, data.branch_id)
    db.commit()
    db.refresh(shift)

    # Notify staff of a PUBLISHED-shift change — to the RIGHT person.
    #   • Reassigned (staffer changed): tell the OLD staffer it was REMOVED and
    #     the NEW staffer it was ADDED. (The old code emailed the OLD staffer the
    #     NEW times for a shift no longer theirs, and never told the new one.)
    #   • Same staffer, times changed: 'modified' to that staffer.
    user_id = user.id
    staffer_changed = str(old_staff_id) != str(data.staff_id)
    times_changed = old_start != data.start_time or old_end != data.end_time
    notifs = []  # list[(recipient_staff_id, ShiftChange)]
    if was_published:
        if staffer_changed:
            notifs.append((old_staff_id, ShiftChange(
                change_type="removed", date=old_date,
                old_start=old_start, old_end=old_end,
                new_start=old_start, new_end=old_end, role=data.role_on_shift)))
            notifs.append((data.staff_id, ShiftChange(
                change_type="added", date=str(data.date),
                old_start=data.start_time, old_end=data.end_time,
                new_start=data.start_time, new_end=data.end_time, role=data.role_on_shift)))
        elif times_changed:
            notifs.append((old_staff_id, ShiftChange(
                change_type="modified", date=old_date,
                old_start=old_start, old_end=old_end,
                new_start=data.start_time, new_end=data.end_time, role=data.role_on_shift)))

    if notifs:
        def _send_bg():
            bg_db = SessionLocal()
            try:
                for _sid, _ch in notifs:
                    send_single_shift_notification(bg_db, user_id, _sid, _ch, "shift_changed")
            finally:
                bg_db.close()

        background_tasks.add_task(_send_bg)

        # Staff live-sync nudge — same signal publish_week sends, so a single
        # published-shift edit refreshes connected portals instantly (not just
        # by the 20s poll) and the staff sees the real-change toast. ONLY inside
        # the was_published guard — a draft edit must never emit schedule_published.
        try:
            from app.services import portal_events
            _d = date.fromisoformat(old_date)
            _monday = _d - timedelta(days=_d.weekday())
            portal_events.publish(
                str(user.id),
                {"type": "schedule_published", "week_start": _monday.isoformat()},
            )
        except Exception:  # noqa: BLE001 — a nudge must never break the edit
            import logging
            logging.getLogger(__name__).debug(
                "portal_events publish (update) failed", exc_info=True
            )

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

        # Staff live-sync nudge — instant portal refresh on a published-shift
        # cancellation. ONLY inside the was_published guard — deleting a draft
        # must never emit schedule_published.
        try:
            from app.services import portal_events
            _d = date.fromisoformat(shift_date)
            _monday = _d - timedelta(days=_d.weekday())
            portal_events.publish(
                str(user.id),
                {"type": "schedule_published", "week_start": _monday.isoformat()},
            )
        except Exception:  # noqa: BLE001 — a nudge must never break the delete
            import logging
            logging.getLogger(__name__).debug(
                "portal_events publish (delete) failed", exc_info=True
            )


# ── Open shifts (Åbne vagter) ──────────────────────────────────────────────
# Owner posts an UNASSIGNED slot; staff claim it one-tap via the portal (the
# claim endpoint lives in staff_portal.py). Gated on staff_portal_link
# (Starter+) — an open shift only has a point if staff can reach the portal.


def _serialize_open_shift(o: OpenShift, name_by_id: dict | None = None) -> OpenShiftResponse:
    name = None
    if o.claimed_by_staff_id is not None and name_by_id is not None:
        name = name_by_id.get(o.claimed_by_staff_id)
    return OpenShiftResponse(
        id=o.id,
        date=o.date,
        start_time=o.start_time,
        end_time=o.end_time,
        break_minutes=o.break_minutes or 0,
        role_on_shift=o.role_on_shift,
        notes=o.notes,
        status=o.status,
        branch_id=o.branch_id,
        claimed_by_staff_id=o.claimed_by_staff_id,
        claimed_by_name=name,
        claimed_at=o.claimed_at,
        created_at=o.created_at,
    )


@router.get("/open-shifts", response_model=list[OpenShiftResponse])
def list_open_shifts(
    week_start: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner's open shifts (excludes cancelled). With ?week_start=YYYY-MM-DD,
    just that Mon–Sun week to feed the grid lane. Tenant-scoped. No tier gate on
    READ — the owner can always see what they have; create/claim enforce it."""
    q = db.query(OpenShift).filter(
        OpenShift.user_id == user.id,
        OpenShift.status != "cancelled",
    )
    if week_start:
        try:
            ws = date.fromisoformat(week_start)
        except ValueError:
            raise HTTPException(status_code=422, detail="bad week_start")
        q = q.filter(OpenShift.date >= ws, OpenShift.date <= ws + timedelta(days=6))
    rows = q.order_by(OpenShift.date.asc(), OpenShift.start_time.asc()).all()
    # Resolve claimer names in one query (owner-side display only — never PII).
    claimer_ids = [r.claimed_by_staff_id for r in rows if r.claimed_by_staff_id]
    name_by_id = {}
    if claimer_ids:
        for sm in db.query(StaffMember).filter(StaffMember.id.in_(claimer_ids)).all():
            name_by_id[sm.id] = sm.name
    return [_serialize_open_shift(r, name_by_id) for r in rows]


@router.post("/open-shifts", response_model=OpenShiftResponse)
def create_open_shift(
    data: OpenShiftCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Post an unassigned slot. Starter+ (staff_portal_link). Multi-barrier:
    L1 auth, L2 date bounds, L6 tier 402, L7 audit row, L9 422-not-5xx."""
    from app.services.billing import enforce_feature
    enforce_feature(user, "staff_portal_link")  # L6 — 402 canonical upgrade payload

    # L2 Bounds — an open shift is a future cover need; reject the distant past
    # / absurd future (the HH:MM + start!=end checks live in the schema).
    today_local = business_today_local(user)
    if data.date < (today_local - timedelta(days=1)):
        raise HTTPException(status_code=422, detail="date_in_past")
    if data.date > (today_local + timedelta(days=365)):
        raise HTTPException(status_code=422, detail="date_too_far")

    o = OpenShift(
        id=uuid.uuid4(),
        user_id=user.id,
        date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
        break_minutes=data.break_minutes,
        role_on_shift=data.role_on_shift,
        notes=data.notes,
        status="open",
        branch_id=_validated_branch_id(db, user, data.branch_id),
    )
    db.add(o)
    db.commit()
    db.refresh(o)

    audit_service.record(  # L7
        db, user, "open_shift.created", "open_shift",
        after={"date": data.date.isoformat(),
               "start": data.start_time, "end": data.end_time,
               "role": data.role_on_shift},
        ip_address=client_ip(request) if request else None,
    )
    return _serialize_open_shift(o)


@router.delete("/open-shifts/{open_shift_id}", status_code=204)
def cancel_open_shift(
    open_shift_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Withdraw an OPEN slot nobody has claimed (soft-cancel, kept for audit).
    A FILLED slot already spawned a real Schedule row — cancelling it is a
    schedule edit, so we 409 rather than silently orphan that shift."""
    o = db.query(OpenShift).filter(
        OpenShift.id == open_shift_id,
        OpenShift.user_id == user.id,
    ).first()
    if not o:
        raise HTTPException(status_code=404, detail="Open shift not found")
    if o.status == "filled":
        raise HTTPException(
            status_code=409,
            detail={"code": "open_shift_filled",
                    "message": "Already taken — edit the staffer's shift instead."},
        )
    o.status = "cancelled"
    db.commit()


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
    # IDEMPOTENCY: skip source shifts that already exist in the target week on
    # the same (staff, date, start, end). Without this, a second click — or a
    # manager on another session — silently DOUBLED every staffer's week (and
    # doubled the labor cost the owner trusts + pushed duplicates to staff on
    # publish). Exact-match dedup, not overlap, so it never drops a legit copy.
    target_start = body.target_week
    target_end = body.target_week + timedelta(days=6)
    existing = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= target_start,
            Schedule.date <= target_end,
        )
        .all()
    )
    seen = {(str(e.staff_id), e.date, e.start_time, e.end_time) for e in existing}
    created = []
    skipped = 0
    for s in source_shifts:
        target_date = s.date + timedelta(days=day_offset)
        key = (str(s.staff_id), target_date, s.start_time, s.end_time)
        if key in seen:
            skipped += 1
            continue
        seen.add(key)  # also dedupes identical rows within the source week
        new_shift = Schedule(
            id=uuid.uuid4(),
            user_id=user.id,
            staff_id=s.staff_id,
            date=target_date,
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
    return {
        "copied": len(created),
        "skipped": skipped,
        "target_week": body.target_week.isoformat(),
    }


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


@router.get("/schedules/forecast")
def schedule_demand_forecast(
    week_start: date = Query(..., description="Monday of the target week (YYYY-MM-DD)"),
    branch_id: Optional[uuid.UUID] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Forecast-only demand for one week — powers the PERSISTENT "predicted
    demand vs your roster" chip on the schedule grid. Read-only, no roster
    build (cheap enough to fetch on every week navigation), never writes. It
    lets the owner FEEL the forecast at the point of decision instead of only
    in the one-shot Autopilot card. Tier-gated Pro+ (same feature as
    autopilot — it is the autopilot's forecasting brain).
    """
    _enforce_autopilot_tier(user)

    today = date.today()
    if week_start < today - timedelta(days=60):
        raise HTTPException(status_code=422, detail="week_start is more than 60 days in the past")
    if week_start > today + timedelta(days=365):
        raise HTTPException(status_code=422, detail="week_start is more than a year in the future")

    from app.services import schedule_autopilot

    return schedule_autopilot.forecast_week_demand(
        db, user=user, week_start=week_start, branch_id=branch_id,
    )


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


# ─── Tidsregistrering — DK working-time compliance (Arbejdstidsloven) ───
# Reads the existing HoursLogged rows (Stempelur clock + manual logs) and
# returns the per-employee register + 11h-rest / 48h-weekly-cap compliance
# view an Arbejdstilsynet inspection needs. No new data is captured — this is
# the interpretation/export layer over hours you already record.
# Starter+ (sits with the rest of the staff section).
# Route order matters: the literal /export.csv MUST come before /{staff_id}
# or FastAPI matches "export.csv" as a staff_id (the route-shadow trap).
def _require_time_registration(user: User):
    from app.services.billing import has_feature, feature_locked_detail
    if not has_feature(user, "time_registration"):
        raise HTTPException(status_code=402, detail={
            "error": "feature_locked",
            **feature_locked_detail(user, "time_registration"),
        })


def _active_staff(db: Session, user_id) -> list[StaffMember]:
    return (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user_id,
            StaffMember.active.is_(True),
            StaffMember.is_deleted.isnot(True),
        )
        .order_by(StaffMember.name)
        .all()
    )


@router.get("/time-registration")
def time_registration_summary(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner overview — one compliance scan-line per active employee."""
    _require_time_registration(user)
    from app.services import time_registration as tr
    members = _active_staff(db, user.id)
    return tr.venue_compliance_summary(db, user.id, members, from_date, to_date)


@router.get("/time-registration/export.csv")
def time_registration_csv(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Machine-readable register for the whole venue — inspection-ready CSV."""
    _require_time_registration(user)
    import csv as _csv
    import io as _io
    from app.services import time_registration as tr
    from app.utils.csv_safe import csv_safe
    members = _active_staff(db, user.id)
    # Kilde stays Danish — this CSV is an Arbejdstilsynet-facing artifact,
    # so raw entry_method enums ("clock") must not leak into it.
    kilde = {"clock": "Stempelur", "schedule": "Vagtplan"}
    buf = _io.StringIO()
    w = _csv.writer(buf, delimiter=";")
    w.writerow(["Medarbejder", "Dato", "Start", "Slut", "Pause (min)", "Timer", "Kilde"])
    for m in members:
        ec = tr.employee_compliance(db, user.id, m, from_date, to_date)
        for e in ec["register"]:
            w.writerow([
                csv_safe(ec["staff_name"]), e["date"], e["start"] or "", e["end"] or "",
                e["break_minutes"], f"{e['hours']:.1f}".replace(".", ","),
                kilde.get(e["source"], "Manuel"),
            ])
    buf.seek(0)
    fname = f"tidsregistrering_{from_date.isoformat()}_{to_date.isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


@router.get("/time-registration/{staff_id}")
def time_registration_employee(
    staff_id: str,
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Full register + compliance detail for one employee."""
    _require_time_registration(user)
    from app.services import time_registration as tr
    member = db.query(StaffMember).filter(
        StaffMember.id == staff_id,
        StaffMember.user_id == user.id,
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")
    return tr.employee_compliance(db, user.id, member, from_date, to_date)


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


@router.get("/clocked-in")
def get_clocked_in_staff(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Who's on the clock right now — open punches (clock-in without a clock-out).
    Powers the owner's live "clocked in now" strip. Read-only + owner-scoped;
    these rows only exist for owners who use the staff portal (already gated)."""
    rows = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == user.id,
            HoursLogged.entry_method == "clock",
            HoursLogged.end_time.is_(None),
        )
        .all()
    )
    now_dt = now_local(user)
    out = []
    for r in rows:
        m = db.query(StaffMember).filter(StaffMember.id == r.staff_id).first()
        elapsed = None
        if r.start_time:
            try:
                hh, mm = (int(x) for x in r.start_time.split(":"))
                start_dt = now_dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if start_dt > now_dt:
                    start_dt -= timedelta(days=1)
                elapsed = max(0, int((now_dt - start_dt).total_seconds() // 60))
            except Exception:
                elapsed = None
        out.append({
            "staff_id": str(r.staff_id),
            "name": (m.name if m else None) or "—",
            "since": r.start_time,
            "elapsed_min": elapsed,
            # Surface the geofence "couldn't confirm location" flag so the owner
            # can actually SEE it on the live strip — otherwise the location
            # lock is invisible theatre. (Written by portal clock-in when GPS is
            # off/denied or the fix was too imprecise to trust.)
            "unverified": bool(getattr(r, "notes", None) == "Location unverified"),
        })
    out.sort(key=lambda x: x["since"] or "")
    return {"clocked_in": out, "count": len(out)}


# ── Clock-in geofence (Stempelur location lock) ───────────────────────────
# Config lives in BusinessProfile.clock_settings_json (no migration churn).
# Privacy: a staff device's location is checked at the INSTANT of clock-in
# only (staff_portal), never stored or tracked. The owner sets the venue
# coordinates from their own device ("use current location") at the venue.

def _load_clock_settings(profile):
    raw = getattr(profile, "clock_settings_json", None) if profile else None
    try:
        d = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        d = {}
    win_minutes = int(d.get("window_minutes") or 0)
    return {
        "enabled": bool(d.get("enabled")),
        "lat": d.get("lat"),
        "lng": d.get("lng"),
        "radius_m": int(d.get("radius_m") or 150),
        # Clock-in TIME window (separate axis from the geofence LOCATION lock):
        # staff can clock in at most `window_minutes` before their shift start.
        # 0 / disabled → no time lock (clock-in open any time, as before).
        "window_enabled": bool(d.get("window_enabled")) and win_minutes > 0,
        "window_minutes": win_minutes,
    }


class ClockGeofenceUpdate(BaseModel):
    # All optional so a partial save (e.g. just the window) never wipes the
    # geofence half, and vice-versa — each field falls back to the stored value.
    enabled: bool | None = None
    lat: float | None = None
    lng: float | None = None
    radius_m: int | None = None
    window_enabled: bool | None = None
    window_minutes: int | None = None


@router.get("/clock-geofence")
def get_clock_geofence(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Owner reads the clock-in geofence config (venue location + radius + on/off)."""
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    cfg = _load_clock_settings(profile)
    cfg["has_location"] = cfg["lat"] is not None and cfg["lng"] is not None
    return cfg


@router.post("/clock-geofence")
def set_clock_geofence(
    payload: ClockGeofenceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner sets venue location (captured from their device at the venue),
    radius, and on/off. Coordinates kept only as the geofence anchor."""
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail={"error": "no_profile"})
    cur = _load_clock_settings(profile)
    lat = payload.lat if payload.lat is not None else cur["lat"]
    lng = payload.lng if payload.lng is not None else cur["lng"]
    if lat is not None and not (-90 <= float(lat) <= 90):
        lat = None
    if lng is not None and not (-180 <= float(lng) <= 180):
        lng = None
    radius = max(25, min(2000, int(payload.radius_m or cur["radius_m"] or 150)))
    enabled = payload.enabled if payload.enabled is not None else cur["enabled"]
    win_enabled = payload.window_enabled if payload.window_enabled is not None else cur["window_enabled"]
    win_minutes = payload.window_minutes if payload.window_minutes is not None else cur["window_minutes"]
    win_minutes = max(0, min(240, int(win_minutes or 0)))  # cap at 4h before start
    profile.clock_settings_json = json.dumps({
        "enabled": bool(enabled),
        "lat": lat,
        "lng": lng,
        "radius_m": radius,
        "window_enabled": bool(win_enabled) and win_minutes > 0,
        "window_minutes": win_minutes,
    })
    db.commit()
    out = _load_clock_settings(profile)
    out["has_location"] = out["lat"] is not None and out["lng"] is not None
    return out


@router.post("/hours/confirm-schedule")
def confirm_schedule_hours(
    week_start: date = Query(..., description="Monday of the week"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Bulk-create hours entries from published schedule shifts for the week.

    This is the no-clock-in path, and it is a legitimate one: an owner who
    doesn't run a punch clock shouldn't have to retype a whole roster to say
    "the week happened". What it records is the OWNER'S assertion that the
    rostered shifts were worked — which is why the rows carry
    entry_method="schedule" rather than "clock".

    But an assertion about the future isn't one. Shifts whose end time hasn't
    passed yet are skipped: the staff portal reports these rows as "hours
    worked", and nobody can truthfully say a 16:00-23:00 shift was worked at
    08:22 that morning. (That is not hypothetical — it is what this endpoint
    did before the guard.) The owner can confirm the same week again once the
    shifts have actually ended; the dedupe below makes that safe to repeat.
    """
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

    # Owner-local now — a Copenhagen owner confirming at 23:30 must not be
    # judged against a UTC clock that already thinks it's tomorrow.
    now = now_local(user).replace(tzinfo=None)
    ended, not_ended_yet = [], 0
    for s in published_shifts:
        end_dt = _shift_end_dt(s.date, s.start_time, s.end_time)
        if end_dt is None or end_dt > now:
            not_ended_yet += 1
            continue
        ended.append(s)
    if not ended:
        raise HTTPException(
            status_code=400,
            detail="These shifts haven't finished yet — you can log them once they're over.",
        )
    published_shifts = ended

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
    # Report what we DIDN'T do, not just what we did — a bare "created: 3" on a
    # 5-shift week reads as "all done" when two were deliberately left out.
    return {
        "created": created,
        "skipped_not_ended": not_ended_yet,
        "week_start": week_start.isoformat(),
    }


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
    sched_by_day: dict = {}
    try:
        for s in (
            db.query(Schedule)
            .filter(
                Schedule.user_id == user.id,
                Schedule.date >= from_date,
                Schedule.date <= to_date,
                # "Scheduled" = the COMMITTED roster, not drafts the owner is
                # still planning. Matches the rostered-hours rule used everywhere
                # else (staff portal ~line 406) so a draft week can't inflate the
                # payroll-facing Scheduled/Diff numbers.
                Schedule.status.in_(("published", "confirmed")),
            )
            .all()
        ):
            sid = str(s.staff_id)
            hrs = _shift_hours(s.start_time, s.end_time, s.break_minutes)
            sched_map[sid] = sched_map.get(sid, 0.0) + hrs
            # Per-DAY as well as per-period. The period total alone cannot tell
            # you whether anyone actually turned up — see _shift_states below.
            sched_by_day[(sid, s.date)] = sched_by_day.get((sid, s.date), 0.0) + hrs
    except Exception as e:
        log.warning("hours_summary: scheduled-hours aggregation failed: %s", e)
        sched_map = {}
        sched_by_day = {}

    # ── Per-SHIFT state ──────────────────────────────────────────────────
    #
    # The period totals cannot answer "did everyone turn up". A staffer who
    # no-shows an 8h shift and then covers 16h two days later nets to a diff of
    # ZERO, and the table renders the same em-dash it uses for "worked exactly
    # as scheduled" — reporting a perfect week over a no-show and eight hours of
    # unplanned overtime. Verified on the running app before this was written.
    #
    # So state is computed per DAY and the row inherits its worst shift. It is
    # never derived from the aggregates.
    TOL = 0.25          # a few minutes either side of the roster is not an event

    actual_by_day: dict = {}
    open_punch_days: set = set()
    try:
        for h in (
            db.query(HoursLogged)
            .filter(
                HoursLogged.user_id == user.id,
                HoursLogged.date >= from_date,
                HoursLogged.date <= to_date,
            )
            .all()
        ):
            k = (str(h.staff_id), h.date)
            actual_by_day[k] = actual_by_day.get(k, 0.0) + float(h.total_hours or 0)
            if h.start_time and not h.end_time:
                open_punch_days.add(k)
    except Exception as e:      # noqa: BLE001 — never kill the report
        log.warning("hours_summary: per-day actuals failed: %s", e)
        actual_by_day = {}
        open_punch_days = set()

    def _classify(scheduled: float, actual: float, has_row: bool, open_punch: bool) -> str:
        """One shift → one state. Order matters; the first match wins."""
        if open_punch:
            return "running"                     # still on the clock
        if scheduled > 0 and not has_row:
            # The clock measured NOTHING. That is all we know. Whether they
            # no-showed or worked and forgot to punch is not knowable here, and
            # this state deliberately does not claim to know.
            return "no_clock_in"
        if scheduled <= 0 and actual > 0:
            return "unplanned"                   # picked up a shift
        if abs(actual - scheduled) <= TOL:
            return "matched"
        return "short" if actual < scheduled else "over"

    # Worst-first. "needs your answer" outranks everything the clock measured,
    # because it is the only state that cannot be resolved without a human.
    _RANK = ["no_clock_in", "over", "short", "unplanned", "running", "matched"]

    states_by_staff: dict = {}
    for (sid, day) in set(list(sched_by_day.keys()) + list(actual_by_day.keys())):
        scheduled = sched_by_day.get((sid, day), 0.0)
        actual = actual_by_day.get((sid, day), 0.0)
        st = _classify(
            scheduled, actual,
            has_row=(sid, day) in actual_by_day,
            open_punch=(sid, day) in open_punch_days,
        )
        bucket = states_by_staff.setdefault(sid, {"states": [], "exceptions": []})
        bucket["states"].append(st)
        if st not in ("matched", "running"):
            bucket["exceptions"].append({
                "date": day.isoformat() if hasattr(day, "isoformat") else str(day),
                "state": st,
                "scheduled_hours": round(scheduled, 1),
                "actual_hours": round(actual, 1),
            })

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

    def _worst(sid: str) -> str:
        sts = states_by_staff.get(sid, {}).get("states", [])
        for candidate in _RANK:
            if candidate in sts:
                return candidate
        return "matched"

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
            # Per-shift truth. `worst_state` is what the row should SAY; the
            # aggregates above are only what it should show as numbers.
            "worst_state": _worst(sid),
            "needs_answer_count": sum(
                1 for e in states_by_staff.get(sid, {}).get("exceptions", [])
                if e["state"] == "no_clock_in"
            ),
            "exceptions": sorted(
                states_by_staff.get(sid, {}).get("exceptions", []),
                key=lambda e: e["date"],
            ),
        })

    return summary


@router.get("/hours/overview")
def hours_overview(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    compare: Optional[str] = Query(None, description="'prev' to include a prior equal-length period trend"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """One-glance owner overview: how staff hours are flowing this period and what
    they cost — plus a deterministic, honest narrative (services/hours_narrative).

    This is the aggregate behind the /staff/hours "Oversigt" surface. It COMPOSES
    the same facts the desktop summary table already shows (it does NOT change
    /hours/summary or /hours), adds the entry-method split (measured vs typed vs
    schedule), the feriepenge-loaded cost estimate, labor% vs effective revenue,
    and work-limit flags — then hands the numbers to a pure rule engine that
    speaks plainly.

    Honesty invariants (mirrored from the design synthesis):
      • Cost is gross logged wages × 1.125 (feriepenge ESTIMATE) — ATP/pension/
        skat excluded, same doctrine as /schedules/week-cost. Never exact payroll.
      • labor.pct_* is NULL (never 0, never guessed) whenever revenue is 0/unknown.
      • MEASURED ≠ PLANNED ≠ ESTIMATED: measured_share exposes the clocked share so
        typed hours can't masquerade as measured.
      • Trend only when the current period is COMPLETE and a prior equal-length
        period has data (no partial-vs-full compare).
      • Raw hourly_rate/base_rate NEVER crosses the wire — only computed
        gross/loaded/pct, exactly like /schedules/week-cost.

    Multi-barrier: L1 auth (get_current_user) · L2 date bounds (422, never 5xx) ·
    L4 fail-soft (revenue sub-query failure → revenue null → pct null, never 500) ·
    L5 tenant scope (user.id on every query). Owner + manager by construction: the
    staff portal authenticates via token (portalApi), never get_current_user, so a
    staffer's phone can't reach this. No audit row — read-only GET (Manoj's
    convention, see /today above). No payroll fields (no CPR/konto/net-pay).
    """
    from app.services.revenue_resolver import effective_revenue_total
    from app.services.hours_narrative import build_hours_narrative

    FERIE_UPLIFT = 0.125  # feriepenge — same dominant per-shift on-cost as week-cost

    # L2 — date bounds. Inverted or absurd ranges are a 422, never a 5xx.
    if to_date < from_date:
        raise HTTPException(422, "'to' must be on or after 'from'.")
    if (to_date - from_date).days > 366:
        raise HTTPException(422, "Range too large (max 366 days).")

    def _sum_hours_by_method(f: date, t: date):
        """Return (actual, gross, measured, typed, schedule, per_staff_actual{},
        per_staff_gross{}). One grouped query; fail-soft to zeros on schema drift."""
        actual = gross = measured = typed = schedule_h = 0.0
        per_staff: dict[str, float] = {}
        per_staff_g: dict[str, float] = {}
        try:
            rows = (
                db.query(
                    HoursLogged.staff_id,
                    HoursLogged.entry_method,
                    func.sum(HoursLogged.total_hours).label("h"),
                    func.sum(HoursLogged.earned).label("e"),
                )
                .filter(
                    HoursLogged.user_id == user.id,
                    HoursLogged.date >= f,
                    HoursLogged.date <= t,
                )
                .group_by(HoursLogged.staff_id, HoursLogged.entry_method)
                .all()
            )
        except Exception:
            return 0.0, 0.0, 0.0, 0.0, 0.0, {}, {}
        for r in rows:
            h = float(r.h or 0)
            e = float(r.e or 0)
            actual += h
            gross += e
            method = (r.entry_method or "quick").lower()
            if method == "clock":
                measured += h
            elif method == "schedule":
                schedule_h += h
            else:
                typed += h
            sid = str(r.staff_id)
            per_staff[sid] = per_staff.get(sid, 0.0) + h
            per_staff_g[sid] = per_staff_g.get(sid, 0.0) + e
        return actual, gross, measured, typed, schedule_h, per_staff, per_staff_g

    (actual_total, gross, measured_hours, typed_hours,
     schedule_hours, per_staff_actual, per_staff_gross) = _sum_hours_by_method(from_date, to_date)

    # Overtime — independent + defensive (is_overtime may be absent on stale schema).
    overtime_hours = 0.0
    try:
        ot = (
            db.query(func.sum(HoursLogged.total_hours))
            .filter(
                HoursLogged.user_id == user.id,
                HoursLogged.date >= from_date,
                HoursLogged.date <= to_date,
                HoursLogged.is_overtime.is_(True),
            )
            .scalar()
        )
        overtime_hours = float(ot or 0)
    except Exception:
        overtime_hours = 0.0

    # Scheduled (rostered) hours — published/confirmed only, same rule as the
    # summary table so Scheduled/Diff never disagree between surfaces.
    def _shift_hours(start, end, brk):
        try:
            sh, sm = int(start[:2]), int(start[3:5])
            eh, em = int(end[:2]), int(end[3:5])
            mins = (eh * 60 + em) - (sh * 60 + sm)
            if mins < 0:
                mins += 24 * 60
            mins -= int(brk or 0)
            return max(0.0, mins / 60.0)
        except Exception:
            return 0.0

    scheduled_total = 0.0
    try:
        for s in (
            db.query(Schedule)
            .filter(
                Schedule.user_id == user.id,
                Schedule.date >= from_date,
                Schedule.date <= to_date,
                Schedule.status.in_(("published", "confirmed")),
            )
            .all()
        ):
            scheduled_total += _shift_hours(s.start_time, s.end_time, s.break_minutes)
    except Exception:
        scheduled_total = 0.0

    # Names + monthly limits for the flags. Wrapped — a corrupt row never 500s.
    over_limit: list[dict] = []
    near_limit: list[dict] = []
    staff_ids = list(per_staff_actual.keys())
    if staff_ids:
        try:
            for m in (
                db.query(StaffMember)
                .filter(
                    StaffMember.id.in_(staff_ids),
                    StaffMember.user_id == user.id,
                )
                .all()
            ):
                limit = float(m.max_hours_month) if m.max_hours_month is not None else None
                if not limit or limit <= 0:
                    continue  # no limit set for this staffer → never flagged
                actual = round(per_staff_actual.get(str(m.id), 0.0), 1)
                entry = {"staff_id": str(m.id), "name": m.name or "?",
                         "actual": actual, "limit": round(limit, 1)}
                if actual >= limit:
                    over_limit.append(entry)
                elif actual >= 0.95 * limit:
                    near_limit.append(entry)
        except Exception:
            over_limit, near_limit = [], []

    # Revenue — DailyClose-wins effective revenue. Fail-soft: any error → None so
    # labor% degrades to "Afventer omsætning", never a 500 and never a fake 0%.
    revenue: Optional[float] = None
    try:
        rev = effective_revenue_total(db, user.id, from_date, to_date)
        revenue = float(rev) if rev and rev > 0 else None
    except Exception:
        revenue = None

    # Target labor % (owner-editable) — same source + default as week-cost.
    try:
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
        target_pct = float(getattr(profile, "target_labor_pct", None) or 0.30)
    except Exception:
        target_pct = 0.30

    # No configured wage rate anywhere → gross=0 → cost + labor% are UNKNOWN, not
    # zero. Serialize pct as null (never a reassuring 0%) and flag the missing
    # basis so the UI shows a neutral "set wage rates" state.
    has_cost_basis = gross > 0
    loaded_est = gross * (1.0 + FERIE_UPLIFT)
    pct_loaded = (loaded_est / revenue) if (revenue and has_cost_basis) else None
    pct_gross = (gross / revenue) if (revenue and has_cost_basis) else None
    measured_share = (measured_hours / actual_total) if actual_total > 0 else 0.0

    # In-progress vs complete → drives the "Hidtil / so far" prefix + trend gate.
    try:
        today_local = business_today_local(user)
    except Exception:
        today_local = date.today()
    is_complete = to_date < today_local
    total_days = (to_date - from_date).days + 1
    elapsed_days = max(0, min(total_days, (today_local - from_date).days + 1))

    # Optional prior equal-length period (immediately preceding). We only treat it
    # as comparable when the CURRENT period is complete — never compare a
    # half-elapsed period to a full one.
    compare_block = None
    prev_actual = None
    comparable = False
    if (compare or "").lower() == "prev":
        length = total_days
        prev_to = from_date - timedelta(days=1)
        prev_from = prev_to - timedelta(days=length - 1)
        pa, *_ = _sum_hours_by_method(prev_from, prev_to)
        prev_actual = round(pa, 1)
        comparable = bool(is_complete)
        compare_block = {
            "prev_from": prev_from.isoformat(),
            "prev_to": prev_to.isoformat(),
            "prev_actual": prev_actual,
            "comparable": comparable,
        }

    narrative_input = {
        "actual_total": round(actual_total, 1),
        "scheduled_total": round(scheduled_total, 1),
        "gross": round(gross, 2),
        "loaded_est": round(loaded_est, 2),
        "revenue": (round(revenue, 2) if revenue is not None else None),
        "pct_loaded": pct_loaded,
        "target_pct": target_pct,
        "measured_share": measured_share,
        "typed_hours": round(typed_hours, 1),
        "has_cost_basis": has_cost_basis,
        "over_limit": over_limit,
        "near_limit": near_limit,
        "comparable": comparable,
        "prev_actual": prev_actual,
    }
    narrative, banner_severity = build_hours_narrative(narrative_input)

    # Labour COST split by department (front of house / kitchen / support /
    # specialist). Honest: by PRIMARY role, same feriepenge estimate as the cost
    # tile, and self-hidden unless cost genuinely splits across ≥2 departments
    # (services/labor_split enforces the gate). Fail-soft — an additive courtesy
    # on top of the numbers, must never 500 the overview.
    labor_split = None
    try:
        from app.services.labor_split import build_labor_split

        role_rows = (
            db.query(StaffMember.id, StaffMember.role)
            .filter(StaffMember.user_id == user.id)
            .all()
        )
        staff_roles = {str(rid): role for rid, role in role_rows}
        labor_split = build_labor_split(
            staff_roles=staff_roles,
            per_staff_hours=per_staff_actual,
            per_staff_gross=per_staff_gross,
            vertical=(getattr(user, "business_type", None) or None),
            ferie_uplift=FERIE_UPLIFT,
        )
    except Exception:
        labor_split = None

    return {
        "period": {
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
            "is_complete": is_complete,
            "elapsed_days": elapsed_days,
            "total_days": total_days,
        },
        "hours": {
            "actual_total": round(actual_total, 1),
            "scheduled_total": round(scheduled_total, 1),
            "diff": round(actual_total - scheduled_total, 1),
            "measured_hours": round(measured_hours, 1),
            "typed_hours": round(typed_hours, 1),
            "schedule_hours": round(schedule_hours, 1),
            "measured_share": round(measured_share, 3),
        },
        "cost": {
            "gross": round(gross, 2),
            "ferie_uplift": FERIE_UPLIFT,
            "loaded_est": round(loaded_est, 2),
            "ferie_is_estimate": True,
            "has_basis": has_cost_basis,
            "currency": user.currency or "DKK",
        },
        "revenue": {
            "effective_total": (round(revenue, 2) if revenue is not None else None),
            "source": "effective_revenue (DailyClose-wins)",
        },
        "labor": {
            "pct_loaded": (round(pct_loaded, 4) if pct_loaded is not None else None),
            "pct_gross": (round(pct_gross, 4) if pct_gross is not None else None),
            "target_pct": round(target_pct, 4),
            "basis": "loaded",
        },
        "flags": {
            "overtime_hours": round(overtime_hours, 1),
            "over_limit": over_limit,
            "near_limit": near_limit,
            "follow_up_count": len(over_limit) + len(near_limit),
        },
        "compare": compare_block,
        "narrative": narrative,
        "banner_severity": banner_severity,
        "labor_split": labor_split,
        "staff_count": len(per_staff_actual),
        "has_any_hours": actual_total > 0,
    }


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
    from app.utils.csv_safe import csv_safe

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
            csv_safe(s.get("name", "")),
            csv_safe(s.get("role", "")),
            csv_safe(s.get("contract_type", "")),
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


@router.post("/absences/{absence_id}/decline", response_model=_AbsenceResponse)
def decline_absence(
    absence_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner declines a fravær request (e.g. can't grant this ferie week) →
    status 'cancelled'. Tenant-scoped; the record is kept (documented), just
    marked declined. Acknowledge is the 'godkend' side; this is 'afvis'."""
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
    absence.status = "cancelled"
    db.commit()
    db.refresh(absence)
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
