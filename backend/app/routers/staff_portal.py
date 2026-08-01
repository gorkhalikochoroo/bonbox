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
import hashlib
import uuid
import hmac
import json
import logging
import os
import secrets
import time
from contextvars import ContextVar
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from passlib.context import CryptContext

from app.database import get_db, SessionLocal
logger = logging.getLogger(__name__)

from app.models.staff import (
    StaffMember, StaffLink, Schedule, HoursLogged,
    Tip, TipDistribution, PayPeriodConfig, NotificationLog, OpenShift,
    StaffAvailability,
)
from app.models.business_profile import BusinessProfile
from app.services import portal_events
from app.utils.text import portal_path

import re
from app.utils.time import utc_now
from app.models.user import User
from app.services.tz_utils import now_local, business_today_local

# ── Multi-layer link protection ──────────────────────────────────────────
# The magic link is the staff credential, so it gets defense in depth —
# each layer holds on its own if another breaks:
#   L1 secrecy     — 192-bit token (secrets.token_urlsafe(24)): unguessable.
#   L2 PIN gate    — optional PIN is a SERVER-SIDE gate (not UI decoration):
#                    with PORTAL_PIN_ENFORCE (default on) every data endpoint
#                    on a PIN-protected link demands proof-of-PIN, so a
#                    leaked link alone reveals nothing.
#   L3 lockout     — per-LINK counter: 8 wrong PINs locks the link 15 min +
#                    audit row. Per-IP limits alone don't stop a distributed
#                    guesser on a 4-digit space.
#   L4 rate limits — per-IP slowapi caps on every endpoint.
#   L5 revocation  — owner `active` flag kills the link; PIN proofs bind to
#                    pin_hash, so changing the PIN voids every issued proof;
#                    proofs also expire after 30 days.
_PIN_PROOF_TTL = 30 * 24 * 3600  # seconds — re-verify at most every 30 days
_PIN_MAX_FAILS = 8
_PIN_LOCK_MINUTES = 15

# Stashed by a router-level dependency so the single token→staff chokepoint
# (_get_staff_from_token) can read the proof header without threading Request
# through ~30 call sites.
_portal_request: ContextVar = ContextVar("bonbox_portal_request", default=None)


async def _stash_portal_request(request: Request):
    # MUST be async: a sync dependency runs in its own threadpool context
    # copy that does NOT propagate to the (sync) endpoint. An async
    # dependency runs in the request task, whose context IS copied into the
    # threadpool when the endpoint is dispatched — so the ContextVar is
    # visible in _get_staff_from_token.
    _portal_request.set(request)


def _pin_proof_sig(link: "StaffLink", ts: int) -> str:
    from app.config import settings

    msg = f"{link.id}:{link.pin_hash}:{ts}".encode()
    return hmac.new(str(settings.SECRET_KEY).encode(), msg, hashlib.sha256).hexdigest()


def _mint_pin_proof(link: "StaffLink") -> str:
    ts = int(time.time())
    return f"v1.{ts}.{_pin_proof_sig(link, ts)}"


def _pin_proof_valid(link: "StaffLink", proof: str | None) -> bool:
    if not proof or not link.pin_hash:
        return False
    parts = str(proof).split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return False
    try:
        ts = int(parts[1])
    except ValueError:
        return False
    now = time.time()
    if ts > now + 300 or (now - ts) > _PIN_PROOF_TTL:
        return False
    return hmac.compare_digest(_pin_proof_sig(link, ts), parts[2])


router = APIRouter(dependencies=[Depends(_stash_portal_request)])
limiter = Limiter(key_func=client_ip)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ═══════════════════════════════════════════════════════════════════════════
#  Schemas (kept here since they're portal-specific and small)
# ═══════════════════════════════════════════════════════════════════════════

class PortalInfo(BaseModel):
    staff_name: str
    role: str
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    # ISO stamp of the last profile-photo change — None if no photo. The client
    # uses it both to decide whether to render the avatar image and as a
    # cache-buster (?v=) so a new photo shows immediately.
    profile_photo_at: datetime | None = None
    pin_ok: bool = False
    restaurant_name: str | None = None
    # Venue location (the workplace) — NOT the staffer's home. Shown in the hero
    # ("BonBox · København") and drives the tap-for-directions link. Not PII (a
    # business's own address), so it's returned un-gated like the venue name.
    restaurant_city: str | None = None
    restaurant_address: str | None = None
    has_pin: bool = False
    max_hours_month: float | None = None
    max_hours_week: float | None = None


class ContactUpdateRequest(BaseModel):
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None


class BankUpdateRequest(BaseModel):
    """Staff's own DK bank account. Both fields are free text on the way in —
    people paste spaces, dots and dashes — and are normalised server-side by
    staff_bank.normalise(), which is the single source of truth for the format."""

    reg_nr: str | None = None
    account_number: str | None = None


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
    # Owner-written shift note (Schedule.notes). Staff couldn't see these
    # before — the field was omitted from the serializer entirely. Now the
    # portal surfaces them so "bring your own knives", "trial shift", etc.
    # actually reach the person working the shift.
    notes: str | None = None

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
    # STRICT `<` so end == start is a ZERO-length shift, NOT a 24h one — MUST
    # match _calc_shift_hours in staff.py (owner grid + payroll). A `<=` here
    # made a fat-fingered 08:00–08:00 read 0h on the owner grid but 24h in the
    # staffer's portal + labor-cost ledger (owner↔staff disagreed on the same
    # shift). 2 decimals to match _calc_shift_hours (1-decimal under-counted pay).
    if e < s:
        e += 24.0
    return round(max(e - s - brk / 60.0, 0), 2)

def _get_staff_from_token(token: str, db: Session):
    """Validate magic link token, return (link, staff_member)."""
    link = db.query(StaffLink).filter(
        StaffLink.token == token,
        StaffLink.active.is_(True),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found or inactive")

    # `active` is the FIRED gate, `is_deleted` is the ERASED gate — both must
    # close the link. DELETE /api/staff/members/{id} (the owner's "remove this
    # employee" action) only sets member.active = False; it does NOT deactivate
    # the StaffLink and does not drop future shifts. So without the active check
    # a fired staffer's magic link kept working — schedule, team roster and
    # hours, from a token still sitting in their phone's browser history.
    # The link IS the credential, so ending employment must end access, and this
    # is the one chokepoint every portal endpoint funnels through.
    member = db.query(StaffMember).filter(
        StaffMember.id == link.staff_id,
        StaffMember.is_deleted.isnot(True),
        StaffMember.active.is_(True),
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # L2 proof-of-PIN: a PIN-protected link requires the X-BonBox-Pin header
    # (minted by /verify-pin) on every data endpoint. Exempt: the validate
    # endpoint itself (the UI needs has_pin to render the gate — and it gates
    # its OWN response so a pre-PIN caller sees only name/role/venue, never the
    # staffer's contact PII; see get_portal_info), the PWA manifest and the SSE
    # stream (both fetched by the browser, which cannot attach headers — the
    # stream carries only "something changed" pings, no business data).
    if link.pin_hash and os.getenv("PORTAL_PIN_ENFORCE", "1") == "1":
        req = _portal_request.get()
        path = (req.url.path if req is not None else "").rstrip("/")
        exempt = path.endswith(f"/{token}") or path.endswith("/manifest.webmanifest") or path.endswith("/stream") or path.endswith("/schedule.ics")
        if not exempt:
            proof = req.headers.get("x-bonbox-pin") if req is not None else None
            if not _pin_proof_valid(link, proof):
                raise HTTPException(status_code=401, detail="PIN required")

    # Update last accessed
    link.last_accessed = utc_now()
    db.commit()

    return link, member


class JoinCodeRequest(BaseModel):
    code: str


_JOIN_ALPHABET = set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")


@router.post("/join")
@limiter.limit("8/minute")
def portal_join(payload: JoinCodeRequest, request: Request, db: Session = Depends(get_db)):
    """Resolve a short join code → the staffer's portal path. Public + hard
    rate-limited (the code space + per-IP cap make brute force infeasible).
    A 404 is returned for every failure mode so codes can't be enumerated."""
    code = (payload.code or "").strip().upper().replace(" ", "").replace("-", "")
    if not (6 <= len(code) <= 12) or any(c not in _JOIN_ALPHABET for c in code):
        raise HTTPException(status_code=404, detail="Ukendt kode")
    link = (
        db.query(StaffLink)
        .filter(StaffLink.join_code == code, StaffLink.active.is_(True))
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Ukendt kode")
    member = (
        db.query(StaffMember)
        .filter(StaffMember.id == link.staff_id, StaffMember.is_deleted.isnot(True))
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Ukendt kode")
    owner = db.query(User).filter(User.id == link.user_id).first()
    biz = getattr(owner, "business_name", None) if owner else None
    return {"path": portal_path(link.token, biz, member.name)}


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

    pin_ok = bool(link.pin_hash) and _pin_proof_valid(link, request.headers.get("x-bonbox-pin"))
    # L2 PIN gate for PII: this validate endpoint is deliberately PIN-EXEMPT so
    # the app can learn has_pin and draw the PIN curtain on boot — but that means
    # it runs BEFORE the PIN is proven. So it must reveal only what draws the
    # gate (name / role / venue) and withhold the staffer's contact PII
    # (home address, phone, email are GDPR personal data) until the PIN is
    # proven. Otherwise a forwarded link or a shoulder-surfed/stolen phone leaks
    # PII pre-PIN — exactly what the PIN layer exists to prevent. A link with NO
    # PIN is inherently open (the 192-bit token IS the credential), so it still
    # returns contact info.
    pii_ok = pin_ok or not link.pin_hash
    return PortalInfo(
        staff_name=member.name,
        role=member.role or "staff",
        email=member.email if pii_ok else None,
        phone=member.phone if pii_ok else None,
        address=member.address if pii_ok else None,
        postal_code=member.postal_code if pii_ok else None,
        city=member.city if pii_ok else None,
        # The photo itself is served by a separate PIN-gated proxy endpoint;
        # the stamp is harmless (just "has a photo, changed at X") and lets the
        # avatar render once the PIN is proven. Gate it with the rest of the PII.
        profile_photo_at=member.profile_photo_at if pii_ok else None,
        restaurant_name=restaurant_name,
        # Venue location (workplace, not PII) — owner sets it on their business
        # profile; the staff hero shows it + offers tap-for-directions.
        restaurant_city=(profile.city if profile else None),
        restaurant_address=(profile.address if profile else None),
        has_pin=bool(link.pin_hash),
        pin_ok=pin_ok,
        max_hours_month=float(member.max_hours_month) if (pii_ok and member.max_hours_month) else None,
        max_hours_week=float(member.max_hours_week) if (pii_ok and member.max_hours_week) else None,
    )


# ─── Subscribed calendar feed (webcal) ────────────────────────────────
# One-tap "sync my shifts to my phone's calendar": the staffer subscribes to
# this URL once (webcal://) and iOS/Google RE-POLL it, so a published or
# changed shift appears automatically — no per-event "add to calendar" that
# iOS drops into Files and never opens. Read-only, shifts-only. Auth is the
# portal token (the staffer's own credential; the feed exposes only their own
# shift times/venue — strictly less than the portal itself). Header-less
# fetchers (Apple's calendar servers) are exempt from the PIN gate, like the
# SSE stream. Stable per-shift UID ⇒ an update REPLACES the event, never dupes.

# Fixed Europe/Copenhagen VTIMEZONE so naive wall-clock lands correctly on any
# client without ever UTC-converting (the naive-UTC bug class we avoid app-wide).
_CPH_VTIMEZONE = (
    "BEGIN:VTIMEZONE", "TZID:Europe/Copenhagen",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
    "TZNAME:CEST", "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
    "TZNAME:CET", "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
)


def _ics_esc(v) -> str:
    return (
        str(v or "")
        .replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
        .replace("\r\n", "\\n").replace("\n", "\\n")
    )


def _ics_local(date_str: str, hhmm: str) -> str:
    # "2026-06-22" + "16:00" → "20260622T160000" (local wall-clock digits, no Z)
    return f"{date_str.replace('-', '')}T{(hhmm or '00:00').replace(':', '')}00"


def _build_schedule_ics(member_name, venue, shifts) -> str:
    dtstamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
    out = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "PRODID:-//BonBox//Schedule//DA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_ics_esc((venue or 'BonBox') + ' — vagter')}",
        "X-WR-TIMEZONE:Europe/Copenhagen",
        # Refresh hints so subscribed clients re-poll ~hourly (Apple/Google honour these).
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
        *_CPH_VTIMEZONE,
    ]
    for s in shifts:
        end_date = s.date.isoformat()
        if s.end_time and s.start_time and s.end_time <= s.start_time:
            end_date = (s.date + timedelta(days=1)).isoformat()  # overnight
        role = getattr(s, "role_on_shift", None)
        summary = " · ".join([x for x in [role, venue] if x]) or "Vagt"
        out += [
            "BEGIN:VEVENT",
            f"UID:bonbox-shift-{s.id}@bonbox.dk",
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;TZID=Europe/Copenhagen:{_ics_local(s.date.isoformat(), s.start_time)}",
            f"DTEND;TZID=Europe/Copenhagen:{_ics_local(end_date, s.end_time)}",
            f"SUMMARY:{_ics_esc(summary)}",
        ]
        if getattr(s, "notes", None):
            out.append(f"DESCRIPTION:{_ics_esc(s.notes)}")
        if venue:
            out.append(f"LOCATION:{_ics_esc(venue)}")
        out.append("END:VEVENT")
    out.append("END:VCALENDAR")
    return "\r\n".join(out) + "\r\n"


@router.get("/{token}/schedule.ics")
@limiter.limit("60/minute")
def get_portal_schedule_ics(token: str, request: Request, db: Session = Depends(get_db)):
    """Subscribable calendar feed of the staffer's published shifts (this week
    → +8 weeks). text/calendar; re-polled by the client for auto-sync."""
    link, member = _get_staff_from_token(token, db)
    owner = db.query(User).filter(User.id == link.user_id).first()
    venue = getattr(owner, "business_name", None) if owner else None
    today = date.today()
    week_start = _get_week_start(today)
    shifts = db.query(Schedule).filter(
        Schedule.staff_id == member.id,
        Schedule.user_id == link.user_id,
        Schedule.date >= week_start,
        Schedule.date <= week_start + timedelta(days=56),
        Schedule.status == "published",
    ).order_by(Schedule.date, Schedule.start_time).all()
    body = _build_schedule_ics(member.name, venue, shifts)
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'inline; filename="bonbox-vagter.ics"',
            "Cache-Control": "max-age=1800",
        },
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

    # Location names/addresses for multi-location shifts — one query for the
    # whole page, only when any shift actually carries a branch. Kills the
    # "which restaurant am I at today?" confusion; single-location tenants
    # send nothing extra.
    branch_ids = {s.branch_id for s in shifts if s.branch_id}
    branches = {}
    if branch_ids:
        from app.models.branch import Branch
        for b in db.query(Branch).filter(Branch.id.in_(branch_ids)).all():
            branches[b.id] = b

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
                # Owner's per-shift note — now passed through to the staff's
                # phone (previously dropped, so notes were invisible).
                "notes": s.notes,
                # Bidirectional confirmation signal — UI lights the
                # "I've got it" button green if already confirmed.
                "confirmed_at": s.confirmed_at.isoformat() if s.confirmed_at else None,
                "branch_name": branches[s.branch_id].name if s.branch_id in branches else None,
                "branch_address": branches[s.branch_id].address if s.branch_id in branches else None,
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


@router.get("/{token}/covers")
@limiter.limit("30/minute")
def portal_covers(
    request: Request,
    token: str,
    db: Session = Depends(get_db),
):
    """Booked covers for the days THIS staffer is actually rostered.

    Why it exists: BonBox holds both the reservation book and the roster, so a
    waiter can walk in already knowing the night. "I aften · 38 gæster booket"
    is the whole feature.

    Privacy — this is the decisive constraint, read before extending:
      • Returns ONLY an aggregate integer per date. NO guest names, NO phone,
        NO email, NO notes, NO occasion, NO table/slot breakdown.
      • **NO ALLERGIES — not the note, not the severity, NOT EVEN A COUNT.**
        Allergies are GDPR Art.9 special-category health data. The owner's OWN
        host stand already refuses to show them next to a name (see
        reservations.py `_reservation_change_dict`) — and that is an
        owner-authenticated, venue-owned iPad. THIS surface is strictly weaker:
        the token sits in a URL, on a personal phone, and StaffLink.pin_hash is
        NULLABLE (the PIN is opt-in), so a default link has the token as its
        only credential. The portal can never receive more guest data than the
        host stand gets. A count is not a safe middle ground: a waiter cannot
        act on "2 allergies", so the only honest next tap is the detail — which
        is exactly the payload that must not ship. Do not add it behind an owner
        toggle either; Art.5(1)(c) minimisation is the controller's duty, not a
        café owner's preference.
      • Why the integer IS safe: the nightly GDPR purge nulls every guest field
        but deliberately KEEPS party_size "for aggregate stats"
        (jobs/reservation_jobs.py). A number computable from a fully erased row
        is not personal data.
      • Scope-bound: covers are returned ONLY for dates where this member has a
        PUBLISHED shift. Without that, any token holder becomes a
        covers-enumeration oracle over arbitrary dates — the same reason
        portal_team_schedule caps days_ahead.
      • Tenant-scoped: every query filters on the link's owner (link.user_id).

    Honesty: `covers` is Σ party_size over BOOKED statuses — booked, NOT served.
    Walk-ins never enter the book, so the client must keep the word "booket"
    welded to the number. `covers: null` for a day means "this owner doesn't
    take reservations" (render nothing) — never conflate that with 0.

    Keyed per SHIFT, and counted within the shift's OWN window — not per day.
    Two reasons:
      • The client can only join on what /schedule gave it (the shift id). Keying
        by business day forced it to join a business date against a raw calendar
        date, which silently diverges for every pre-cutoff shift.
      • A whole-day total under one shift's hours is a lie to a lunch waiter —
        they would read the dinner covers as theirs.
    A 17:00-01:00 shift IS [Fri 17:00, Sat 01:00), so a 00:30 booking falls in
    naturally and no business-day cutoff arithmetic is needed here at all.
    """
    from app.models.user import User
    from app.services.reservation_insights_service import booked_covers_in_window

    link, member = _get_staff_from_token(token, db)

    owner = db.query(User).filter(User.id == link.user_id).first()
    if not owner:
        # Defensive: FK should guarantee this, but a hard-deleted owner must
        # fail closed rather than 500 or leak a bare aggregate.
        raise HTTPException(status_code=404, detail="Link not found or inactive")

    # Report the flag from the PROFILE, never inferred from a helper returning
    # None — that would turn "our query failed" into the affirmative claim
    # "this venue takes no bookings".
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    enabled = bool(profile and profile.reservations_enabled)
    if not enabled:
        return {"reservations_enabled": False, "shifts": []}

    today = business_today_local(owner)
    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == link.user_id,
            Schedule.staff_id == member.id,
            Schedule.status == "published",
            Schedule.date >= today - timedelta(days=1),
            Schedule.date <= today + timedelta(days=21),
        )
        .all()
    )

    out = []
    for s in shifts:
        try:
            sh, sm = (s.start_time or "").split(":")[:2]
            eh, em = (s.end_time or "").split(":")[:2]
            lo = datetime.combine(s.date, datetime.min.time().replace(hour=int(sh), minute=int(sm)))
            hi = datetime.combine(s.date, datetime.min.time().replace(hour=int(eh), minute=int(em)))
            if hi <= lo:
                hi += timedelta(days=1)   # the shift crosses midnight
        except Exception:  # noqa: BLE001
            # A malformed row must not sink the card — just omit that shift.
            continue
        try:
            out.append({"shift_id": str(s.id), "covers": booked_covers_in_window(db, owner, lo, hi)})
        except Exception:  # noqa: BLE001
            logger.warning("covers window query failed for shift %s", s.id, exc_info=True)
            continue

    return {"reservations_enabled": True, "shifts": out}


@router.get("/{token}/hours")
@limiter.limit("30/minute")
def get_portal_hours(token: str, request: Request, db: Session = Depends(get_db)):
    """Return the staff member's hours for the current pay period.

    Source of truth (the original bug): owners build the schedule by
    creating *Schedule* (shift) rows — they do NOT create HoursLogged
    rows. The old endpoint summed only HoursLogged, so staff always saw
    0 hours even with a full published roster. The data staff actually
    have — and the question they're really asking ("how many hours am I
    rostered for?") — is the published schedule.

    So:
      • We compute ROSTERED hours from published/confirmed Schedule rows
        in the period using `_shift_hours` (the same helper the owner-side
        schedule uses, so the numbers reconcile to the dollar/krone).
      • If the owner ALSO logs actual hours (HoursLogged rows exist), we
        keep those — `total_hours` then reflects the logged actuals
        (more authoritative than the plan), and we still expose the
        rostered figure separately.
      • The headline `total_hours` is therefore never 0 when a roster
        exists, which is the whole point of the fix. Existing HoursTab
        fields (`total_hours`, `entries`, `period_start/end`) keep working.
    """
    from app.services.schedule_autopilot import _shift_hours, _staff_hourly_rate

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

    # ── Logged actuals (may be empty — most owners never log these) ──
    hours = db.query(HoursLogged).filter(
        HoursLogged.staff_id == member.id,
        HoursLogged.user_id == link.user_id,
        HoursLogged.date >= period_start,
        HoursLogged.date <= period_end,
    ).order_by(HoursLogged.date.desc()).all()

    logged_hours = sum(float(h.total_hours or 0) for h in hours)
    total_earned = sum(float(h.earned or 0) for h in hours)

    # ── Rostered hours from the PUBLISHED schedule (the real data) ──
    # Only published/confirmed shifts count — drafts the owner is still
    # editing must never show (mirrors the schedule-tab filter). Tenant-
    # scoped on user_id like every sibling portal query.
    scheduled_shifts = db.query(Schedule).filter(
        Schedule.staff_id == member.id,
        Schedule.user_id == link.user_id,
        Schedule.date >= period_start,
        Schedule.date <= period_end,
        Schedule.status.in_(("published", "confirmed")),
    ).order_by(Schedule.date.desc(), Schedule.start_time.desc()).all()

    scheduled_hours = sum(
        _shift_hours(s.start_time, s.end_time, s.break_minutes or 0)
        for s in scheduled_shifts
    )

    # This week (Mon→Sun containing today), rostered — a calmer "right now"
    # number than the whole pay period, mirrors the schedule tab KPI.
    week_start = _get_week_start(today)
    week_end = week_start + timedelta(days=6)
    this_week_hours = sum(
        _shift_hours(s.start_time, s.end_time, s.break_minutes or 0)
        for s in scheduled_shifts
        if week_start <= s.date <= week_end
    )

    # Headline: prefer logged actuals when the owner records them
    # (authoritative), otherwise the rostered plan. This guarantees a
    # non-zero number whenever a roster exists — the fix.
    use_logged = len(hours) > 0
    total_hours = logged_hours if use_logged else scheduled_hours

    # Entries the existing HoursTab renders. When we have logged rows we
    # show those; otherwise we synthesize entries from the schedule so the
    # "Recent shifts" list + "Shifts logged" count are populated from the
    # roster instead of sitting empty.
    if use_logged:
        entries = [
            PortalHoursEntry(
                date=h.date,
                start_time=h.start_time,
                end_time=h.end_time,
                total_hours=float(h.total_hours or 0),
                earned=float(h.earned) if h.earned else None,
            )
            for h in hours
        ]
    else:
        rate = _staff_hourly_rate(member)
        entries = [
            PortalHoursEntry(
                date=s.date,
                start_time=s.start_time,
                end_time=s.end_time,
                total_hours=round(
                    _shift_hours(s.start_time, s.end_time, s.break_minutes or 0), 2
                ),
                # Indicative gross at the member's effective rate — same
                # rate basis the owner schedule uses. Not a payslip.
                earned=round(
                    _shift_hours(s.start_time, s.end_time, s.break_minutes or 0) * rate,
                    2,
                ) if rate else None,
            )
            for s in scheduled_shifts
        ]

    # ── Recently clocked (period-INDEPENDENT proof-of-punch) ─────────────
    # The pay period is dated by BUSINESS DAY (06:00 cutoff), so a shift
    # clocked at 00:29 is dated to the previous calendar day and can fall in
    # the PREVIOUS pay period — invisible in the period summary above. A
    # worker who just clocked out would then see "0 worked hours this period".
    # This list is their proof the punch landed: the last COMPLETED clock
    # punches (end_time NOT NULL — the open/live punch is the clock hero's job,
    # never a finished 0h shift), newest-first, over a 14-day business-day
    # window, regardless of period. Tenant-scoped; never summed into any total.
    RECENT_WINDOW_DAYS = 14
    owner_user = db.query(User).filter(User.id == link.user_id).first()
    try:
        recent_cutoff = business_today_local(owner_user) - timedelta(days=RECENT_WINDOW_DAYS - 1)
    except Exception:
        recent_cutoff = date.today() - timedelta(days=RECENT_WINDOW_DAYS - 1)
    recent_rows = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.staff_id == member.id,
            HoursLogged.user_id == link.user_id,
            HoursLogged.entry_method == "clock",
            HoursLogged.end_time.isnot(None),
            HoursLogged.date >= recent_cutoff,
        )
        .order_by(HoursLogged.date.desc(), HoursLogged.created_at.desc())
        .limit(8)
        .all()
    )
    recent_clocked = [
        PortalHoursEntry(
            date=r.date,
            start_time=r.start_time,
            end_time=r.end_time,
            total_hours=float(r.total_hours or 0),
            earned=float(r.earned) if r.earned else None,
        )
        for r in recent_rows
    ]

    return {
        "staff_name": member.name,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "total_hours": round(total_hours, 2),
        "total_earned": round(total_earned, 2),
        "max_hours_month": float(member.max_hours_month) if member.max_hours_month else None,
        # New, additive fields — let the UI distinguish rostered vs logged
        # without breaking the existing `total_hours` contract.
        "scheduled_hours": round(scheduled_hours, 2),
        "logged_hours": round(logged_hours, 2),
        "this_week_hours": round(this_week_hours, 2),
        # "schedule" => headline is the rostered plan; "logged" => actuals.
        "hours_source": "logged" if use_logged else "schedule",
        "entries": entries,
        # Period-independent recent clock punches (proof-of-punch across the
        # pay-period boundary). Display-only; the frontend dedups vs `entries`.
        "recent_clocked": recent_clocked,
        "recent_clocked_window_days": RECENT_WINDOW_DAYS,
    }


@router.get("/{token}/time-registration")
@limiter.limit("30/minute")
def get_portal_time_registration(token: str, request: Request, db: Session = Depends(get_db)):
    """The staff member's own working-time register (Tidsregistrering).

    Arbejdstidsloven requires employees to be able to access their own
    recorded working time. This returns their daily register — built from the
    same HoursLogged rows the Stempelur clock + owner logging write — for the
    current calendar month, so they can verify it. Compliance flags
    (rest/cap) stay owner-side; staff just see their own registered time.
    """
    link, member = _get_staff_from_token(token, db)
    from app.services import time_registration as tr
    import calendar as _cal
    today = date.today()
    start = today.replace(day=1)
    end = today.replace(day=_cal.monthrange(today.year, today.month)[1])
    rows = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == link.user_id,
            HoursLogged.staff_id == member.id,
            HoursLogged.date >= start,
            HoursLogged.date <= end,
        )
        .order_by(HoursLogged.date)
        .all()
    )
    register = [
        {"date": e.date, "start": e.start, "end": e.end,
         "break_minutes": e.break_minutes, "hours": e.hours, "source": e.source}
        for e in tr.daily_register(rows)
    ]
    return {
        "staff_name": member.name,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "total_hours": round(sum(r["hours"] for r in register), 1),
        "days_registered": len(register),
        "register": register,
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Punch-clock — staff self-clock from the portal. A clock-in/out writes the
#  SAME HoursLogged rows the owner already sees (entry_method="clock"), so it
#  flows straight into the owner's hours + payroll with zero extra wiring.
#  An OPEN punch = a HoursLogged row with entry_method="clock" AND end_time
#  IS NULL. (Owner-logged clock rows always carry both times, so they never
#  read as "open".) Times are SERVER-stamped in the owner's local tz — we
#  never trust a client clock.
# ═══════════════════════════════════════════════════════════════════════════

class ClockInBody(BaseModel):
    lat: float | None = None
    lng: float | None = None
    accuracy: float | None = None  # device GPS accuracy (metres); used as a grace radius


def _haversine_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres."""
    from math import radians, sin, cos, asin, sqrt
    dlat = radians(float(lat2) - float(lat1))
    dlng = radians(float(lng2) - float(lng1))
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(float(lat1))) * cos(radians(float(lat2))) * sin(dlng / 2) ** 2
    )
    return 2 * 6371000.0 * asin(sqrt(a))


def _clock_geofence(db: Session, owner) -> dict:
    """Owner's clock-in geofence config. enabled is only effective once a
    venue location is set (can't enforce distance to nothing)."""
    prof = (
        db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
        if owner else None
    )
    raw = getattr(prof, "clock_settings_json", None) if prof else None
    try:
        d = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        d = {}
    has_loc = d.get("lat") is not None and d.get("lng") is not None
    return {
        "enabled": bool(d.get("enabled")) and has_loc,
        "lat": d.get("lat"),
        "lng": d.get("lng"),
        "radius_m": int(d.get("radius_m") or 150),
    }


def _open_punch(db: Session, member):
    """The staff's current open clock-in (clocked in, not yet out), if any."""
    return (
        db.query(HoursLogged)
        .filter(
            HoursLogged.staff_id == member.id,
            HoursLogged.entry_method == "clock",
            HoursLogged.end_time.is_(None),
        )
        .order_by(HoursLogged.created_at.desc())
        .first()
    )


def _elapsed_min(start_hhmm, now_dt):
    """Minutes from an 'HH:MM' start (owner-local) to now; wraps a start that
    is 'after' now back to yesterday (overnight shift)."""
    if not start_hhmm:
        return None
    try:
        hh, mm = (int(x) for x in start_hhmm.split(":"))
    except (ValueError, AttributeError):
        return None
    start_dt = now_dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if start_dt > now_dt:
        start_dt -= timedelta(days=1)
    return max(0, int((now_dt - start_dt).total_seconds() // 60))


def _elapsed_sec(created_at):
    """Whole seconds from the punch's created_at (naive UTC — the exact clock-in
    instant) to now. Second-precision + reload-safe (the row's created_at IS the
    baseline, so the client never invents it); never negative; None on bad input.
    This is what lets the staff hero tick a live counter starting at 0s."""
    if not created_at:
        return None
    try:
        return max(0, int((utc_now() - created_at).total_seconds()))
    except (TypeError, ValueError):
        return None


def _shift_start_dt(hhmm, ref_dt, on_date):
    """Stamp an 'HH:MM' shift time onto a SPECIFIC calendar date (the shift's own
    Schedule.date), keeping ref_dt's tz. Anchoring on the shift's date — not
    'now' — is what keeps the pre-06:00 window correct: between midnight and the
    DK cutoff, business_today_local is yesterday, so stamping onto now's date
    would place the shift a full day off and wrongly lock a mid-shift / overnight
    / early-morning worker. None on bad input."""
    try:
        hh, mm = (int(x) for x in hhmm.split(":"))
    except (ValueError, AttributeError):
        return None
    return ref_dt.replace(year=on_date.year, month=on_date.month, day=on_date.day,
                          hour=hh, minute=mm, second=0, microsecond=0)


def _clock_window(db: Session, owner) -> dict:
    """Owner's clock-in TIME window: staff may clock in at most `minutes` before
    their shift start. Shares clock_settings_json with the geofence. Disabled →
    no time lock (open any time — back-compat with venues that never set it)."""
    prof = (
        db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
        if owner else None
    )
    raw = getattr(prof, "clock_settings_json", None) if prof else None
    try:
        d = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        d = {}
    minutes = int(d.get("window_minutes") or 0)
    return {"enabled": bool(d.get("window_enabled")) and minutes > 0, "minutes": minutes}


def _clock_window_status(db: Session, member, owner) -> dict:
    """Is clock-in currently time-locked for this staffer, and when does it open?
    Anchored to the first still-unfinished published shift TODAY (business day).
    Never locks when the window is off or there is no upcoming shift, so an
    unscheduled cover / walk-in is never stranded."""
    win = _clock_window(db, owner)
    off = {"locked": False, "opens_at": None, "shift_start": None,
           "window_minutes": win["minutes"]}
    if not win["enabled"]:
        return off
    now_dt = now_local(owner)
    today = now_dt.date()
    # Candidate shifts by CALENDAR date around now (±1 day) — cutoff-independent,
    # so BOTH an overnight shift started yesterday and an early-morning shift
    # dated today are considered. Each shift is anchored to its OWN date below,
    # then compared by absolute time (never the business day, which drifts a day
    # before the 06:00 cutoff and mis-locks overnight/opener staff).
    rows = (
        db.query(Schedule)
        .filter(
            Schedule.staff_id == member.id,
            Schedule.user_id == member.user_id,
            Schedule.date >= today - timedelta(days=1),
            Schedule.date <= today + timedelta(days=1),
            Schedule.status == "published",
        )
        .order_by(Schedule.date, Schedule.start_time)
        .all()
    )
    target_start = None
    for s in rows:
        start_dt = _shift_start_dt(s.start_time, now_dt, s.date)
        if start_dt is None:
            continue
        end_dt = _shift_start_dt(s.end_time, now_dt, s.date) or start_dt
        if end_dt <= start_dt:  # end wraps past midnight (overnight shift)
            end_dt += timedelta(days=1)
        if end_dt >= now_dt:  # first shift (by absolute time) not yet finished
            target_start = start_dt
            break
    if target_start is None:
        return off
    opens_dt = target_start - timedelta(minutes=win["minutes"])
    return {
        "locked": now_dt < opens_dt,
        "opens_at": opens_dt.strftime("%H:%M"),
        "shift_start": target_start.strftime("%H:%M"),
        "window_minutes": win["minutes"],
    }


def _clock_status_dict(db: Session, member, owner) -> dict:
    now_dt = now_local(owner)
    bday = business_today_local(owner)
    today_rows = (
        db.query(HoursLogged)
        .filter(HoursLogged.staff_id == member.id, HoursLogged.date == bday)
        .all()
    )
    today_hours = round(sum(float(r.total_hours or 0) for r in today_rows), 2)
    geofence_on = _clock_geofence(db, owner)["enabled"]
    win = _clock_window_status(db, member, owner)
    punch = _open_punch(db, member)
    if not punch:
        return {"clocked_in": False, "since": None, "elapsed_min": None,
                "elapsed_sec": None, "today_hours": today_hours,
                "geofence_on": geofence_on,
                "locked": win["locked"], "opens_at": win["opens_at"],
                "shift_start": win["shift_start"], "window_minutes": win["window_minutes"]}
    return {
        "clocked_in": True,
        "since": punch.start_time,
        "elapsed_min": _elapsed_min(punch.start_time, now_dt),  # back-compat (whole min)
        "elapsed_sec": _elapsed_sec(punch.created_at),          # live-counter seed (seconds)
        "today_hours": today_hours,
        "geofence_on": geofence_on,
        # Already clocked in → never "locked"; keep window context for the UI.
        "locked": False, "opens_at": None,
        "shift_start": win["shift_start"], "window_minutes": win["window_minutes"],
    }


@router.get("/{token}/clock")
@limiter.limit("60/minute")
def get_portal_clock(token: str, request: Request, db: Session = Depends(get_db)):
    """Current clock state — clocked in since when, minutes elapsed, today's hours."""
    link, member = _get_staff_from_token(token, db)
    owner = db.query(User).filter(User.id == member.user_id).first()
    return _clock_status_dict(db, member, owner)


@router.post("/{token}/clock-in")
@limiter.limit("20/minute")
def portal_clock_in(
    token: str,
    request: Request,
    body: ClockInBody | None = None,
    db: Session = Depends(get_db),
):
    """Staff clocks IN. Server-stamped; idempotent (already-in → returns state).
    If the owner enabled the location lock, the device must be within radius of
    the venue — outside → 403; GPS off/denied → allowed but flagged."""
    link, member = _get_staff_from_token(token, db)
    owner = db.query(User).filter(User.id == member.user_id).first()
    if _open_punch(db, member):
        return _clock_status_dict(db, member, owner)  # already clocked in — no dupe
    # Time-window gate (owner-configured): a punch before the window opens is
    # rejected server-side, so the lock can't be bypassed by a crafted request.
    _win = _clock_window_status(db, member, owner)
    if _win["locked"]:
        raise HTTPException(status_code=403, detail={
            "error": "too_early",
            "opens_at": _win["opens_at"],
            "shift_start": _win["shift_start"],
        })
    geo_note = None
    cfg = _clock_geofence(db, owner)
    if cfg["enabled"]:
        import math
        lat = body.lat if body else None
        lng = body.lng if body else None
        acc = body.accuracy if body else None
        # The staffer fully controls this body (token auth) and is the exact
        # adversary the fence exists to stop. NaN/Inf parse through the default
        # JSON loader and would make every distance comparison False — sailing
        # past the fence UNFLAGGED. Neutralise non-finite spoof values: bad
        # coords → "no fix" (allow + flag, like GPS-denied); bad accuracy →
        # unknown (strict distance, no grace). No clean unflagged remote punch.
        if lat is not None and not math.isfinite(lat):
            lat = None
        if lng is not None and not math.isfinite(lng):
            lng = None
        if acc is not None and not math.isfinite(acc):
            acc = None
        if lat is not None and lng is not None:
            # A phone fix is routinely 50–200 m off (indoors / urban canyon /
            # cold start). Treat a too-imprecise fix as "no usable fix" — allow
            # but flag — so a present worker is never hard-locked-out, and a
            # spoofed accuracy=99999 can't blanket-satisfy the fence either.
            if acc is not None and acc > 200:
                geo_note = "Location unverified"
            else:
                dist = _haversine_m(lat, lng, cfg["lat"], cfg["lng"])
                # Give the worker the benefit of their fix's own stated
                # uncertainty (clamped to 0–200 m): if they could plausibly be
                # inside the fence given GPS error, let them in. Clamp floors a
                # negative/spoofed accuracy at 0 (→ strict distance check).
                grace = max(0, min(acc or 0, 200))
                if dist - grace > cfg["radius_m"]:
                    raise HTTPException(status_code=403, detail={
                        "error": "too_far",
                        "distance_m": int(round(dist)),
                        "radius_m": cfg["radius_m"],
                    })
        else:
            # GPS off/denied (or non-finite/missing coords) → allow but flag
            # (never lock a real worker out over flaky indoor GPS; the owner
            # sees the "unverified" marker).
            geo_note = "Location unverified"
    now_dt = now_local(owner)
    db.add(HoursLogged(
        user_id=member.user_id,
        staff_id=member.id,
        date=business_today_local(owner),
        start_time=now_dt.strftime("%H:%M"),
        end_time=None,
        break_minutes=0,
        total_hours=0,
        entry_method="clock",
        notes=geo_note,
    ))
    # L7 best-effort audit: a self-service punch becomes paid labor, so the
    # owner gets an immutable "who clocked in, from the portal, when" trail
    # (mirrors the contact-edit audit). Fail-soft — never blocks the punch.
    try:
        from app.services import audit_service

        audit_service.record(
            db, member.user_id, "staff.portal.clock_in", "staff_member",
            entity_id=member.id,
            after={"start_time": now_dt.strftime("%H:%M"), "geo": geo_note},
            actor_type="staff",
        )
    except Exception:  # noqa: BLE001 — audit is best-effort
        pass
    db.commit()
    return _clock_status_dict(db, member, owner)


@router.post("/{token}/clock-out")
@limiter.limit("20/minute")
def portal_clock_out(token: str, request: Request, db: Session = Depends(get_db)):
    """Staff clocks OUT — close the open punch, compute hours + (premium-aware) pay."""
    link, member = _get_staff_from_token(token, db)
    owner = db.query(User).filter(User.id == member.user_id).first()
    punch = _open_punch(db, member)
    if not punch:
        raise HTTPException(status_code=409, detail={"error": "not_clocked_in"})
    end_str = now_local(owner).strftime("%H:%M")
    # _calc_shift_hours lives in routers/staff.py. Imported locally (like
    # _pick_rate just below) to avoid a module-level circular import — it
    # was previously referenced here but never imported, which 500'd every
    # staff clock-out. (Audit 2026-06-10)
    from app.routers.staff import _calc_shift_hours
    # Gross elapsed first (no break yet) — drives both the trust guard and the
    # size of the DK break below.
    gross = (
        0.0 if end_str == (punch.start_time or "")
        else _calc_shift_hours(punch.start_time, end_str, 0)
    )
    # TRUST GUARD: an in→out within the same minute (or anything that rounds to
    # 0.0h at the stored 1-decimal precision, i.e. < ~3 min) is a misclick or a
    # test, not real work. Persisting it would drop a junk "0.0h" row into the
    # owner's hours — which reads as the clock inventing random entries and
    # quietly erodes trust. So we DISCARD the open punch instead of saving it.
    if round(gross, 1) == 0.0:
        db.delete(punch)
        db.commit()
        out = _clock_status_dict(db, member, owner)
        out["clocked_out"] = True
        out["worked_hours"] = 0.0
        out["discarded"] = True  # too short to log — nothing written
        return out
    # DK BREAK AUTO-DEDUCTION: a punch carries no break entry (the staffer just
    # taps in/out), so a 6h+ shift used to pay a full day with ZERO break — while
    # the SAME shift on the roster deducted 45 min. Apply the shared DK suggestion
    # so a punched shift reads the SAME hours a scheduled one does. It lands on
    # break_minutes, which the owner can still adjust on the hours page (visible,
    # editable — never a hidden deduction).
    from app.services.schedule_autopilot import suggested_break_minutes
    if not punch.break_minutes:
        punch.break_minutes = suggested_break_minutes(gross)
    total = _calc_shift_hours(punch.start_time, end_str, punch.break_minutes or 0)
    punch.end_time = end_str
    punch.total_hours = total
    try:
        from app.routers.staff import _pick_rate
        rate = _pick_rate(member, punch.date, punch.start_time)
        if rate is not None:
            punch.rate_applied = rate
            punch.earned = round(total * float(rate), 2)
    except Exception:
        pass  # pay can be filled owner-side; never block a clock-out on it
    # L7 best-effort audit — the paid-hours side of the punch (see clock-in).
    try:
        from app.services import audit_service

        audit_service.record(
            db, member.user_id, "staff.portal.clock_out", "staff_member",
            entity_id=member.id,
            after={"end_time": end_str, "total_hours": round(total, 2)},
            actor_type="staff",
        )
    except Exception:  # noqa: BLE001 — audit is best-effort
        pass
    db.commit()
    out = _clock_status_dict(db, member, owner)
    out["clocked_out"] = True
    out["worked_hours"] = round(total, 2)
    return out


# ═══════════════════════════════════════════════════════════════════════════
#  Availability — staff-side "kan ikke arbejde" (standing unavailability)
#  A STANDING preference (recurring weekday or one-off date), distinct from a
#  sick-call/absence EVENT. The owner sees it while building the roster and the
#  autopilot respects it — a soft signal, never a hidden hard block.
# ═══════════════════════════════════════════════════════════════════════════
class AvailabilityBody(BaseModel):
    """Exactly one of weekday / date is set. Times optional (null = all day)."""
    weekday: int | None = None       # 0=Mon..6=Sun (recurring)
    date: str | None = None          # ISO "YYYY-MM-DD" (one-off)
    kind: str = "unavailable"        # "unavailable" | "preferred"
    start_time: str | None = None    # "HH:MM"; null = whole day
    end_time: str | None = None
    note: str | None = None


def _avail_dict(a: StaffAvailability) -> dict:
    return {
        "id": str(a.id),
        "kind": a.kind,
        "weekday": a.weekday,
        "date": a.specific_date.isoformat() if a.specific_date else None,
        "start_time": a.start_time,
        "end_time": a.end_time,
        "note": a.note,
    }


def _valid_hhmm(v: str) -> bool:
    return bool(re.match(r"^([01]\d|2[0-3]):[0-5]\d$", v or ""))


@router.get("/{token}/availability")
@limiter.limit("60/minute")
def portal_list_availability(token: str, request: Request, db: Session = Depends(get_db)):
    """This staffer's own standing availability blocks ('kan ikke')."""
    link, member = _get_staff_from_token(token, db)
    rows = (
        db.query(StaffAvailability)
        .filter(
            StaffAvailability.staff_id == member.id,
            StaffAvailability.user_id == member.user_id,
        )
        .order_by(StaffAvailability.weekday.asc(), StaffAvailability.specific_date.asc())
        .all()
    )
    return {"availability": [_avail_dict(a) for a in rows]}


@router.post("/{token}/availability")
@limiter.limit("30/minute")
def portal_add_availability(
    token: str, body: AvailabilityBody, request: Request, db: Session = Depends(get_db)
):
    """Add a 'kan ikke' block. Owner + staff identity are re-derived from the
    token — NEVER trusted from the body — so a peer can't write for someone else."""
    link, member = _get_staff_from_token(token, db)

    kind = body.kind if body.kind in ("unavailable", "preferred") else "unavailable"

    has_weekday = body.weekday is not None
    has_date = bool(body.date)
    if has_weekday == has_date:  # exactly one of the two is required
        raise HTTPException(status_code=422, detail={"error": "need_weekday_or_date"})

    weekday = None
    specific_date = None
    if has_weekday:
        if not isinstance(body.weekday, int) or not (0 <= body.weekday <= 6):
            raise HTTPException(status_code=422, detail={"error": "bad_weekday"})
        weekday = body.weekday
    else:
        try:
            specific_date = date.fromisoformat(body.date)
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail={"error": "bad_date"})

    st, et = body.start_time, body.end_time
    if (st is None) != (et is None):  # both or neither
        raise HTTPException(status_code=422, detail={"error": "need_both_times"})
    if st is not None:
        if not _valid_hhmm(st) or not _valid_hhmm(et):
            raise HTTPException(status_code=422, detail={"error": "bad_time"})
        if et <= st:  # same-day window; end==start is zero-length → reject
            raise HTTPException(status_code=422, detail={"error": "end_not_after_start"})

    note = (body.note or "").strip()[:200] or None

    row = StaffAvailability(
        user_id=member.user_id, staff_id=member.id, kind=kind,
        weekday=weekday, specific_date=specific_date,
        start_time=st, end_time=et, note=note,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _avail_dict(row)


@router.delete("/{token}/availability/{avail_id}")
@limiter.limit("30/minute")
def portal_delete_availability(
    token: str, avail_id: str, request: Request, db: Session = Depends(get_db)
):
    """Remove one of THIS staffer's own availability blocks."""
    link, member = _get_staff_from_token(token, db)
    import uuid as _uuid
    try:
        aid = _uuid.UUID(str(avail_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    row = (
        db.query(StaffAvailability)
        .filter(
            StaffAvailability.id == aid,
            StaffAvailability.staff_id == member.id,
            StaffAvailability.user_id == member.user_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    db.delete(row)
    db.commit()
    return {"deleted": True}


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

    now = utc_now()
    # L3 per-link lockout — holds even when the guesser rotates IPs.
    if link.pin_locked_until and link.pin_locked_until > now:
        raise HTTPException(status_code=429, detail="Too many attempts — try again later")

    if not pwd_context.verify(body.pin, link.pin_hash):
        link.pin_failed_count = (link.pin_failed_count or 0) + 1
        if link.pin_failed_count >= _PIN_MAX_FAILS:
            link.pin_locked_until = now + timedelta(minutes=_PIN_LOCK_MINUTES)
            link.pin_failed_count = 0
            try:
                from app.services import audit_service

                audit_service.record(
                    db, link.user_id, "staff.portal.pin_locked", "staff_link",
                    entity_id=link.id,
                    after={"staff_id": str(link.staff_id), "lock_minutes": _PIN_LOCK_MINUTES},
                    actor_type="staff",
                )
            except Exception:  # noqa: BLE001 — audit is best-effort
                pass
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid PIN")

    link.pin_failed_count = 0
    link.pin_locked_until = None
    db.commit()
    # Proof binds to pin_hash (changing the PIN voids it) and expires in 30d.
    return {"verified": True, "pin_proof": _mint_pin_proof(link)}


@router.put("/{token}/email")
@limiter.limit("5/minute")
def update_portal_contact(token: str, body: ContactUpdateRequest, request: Request, db: Session = Depends(get_db)):
    """Staff updates their own contact details (email, phone, home address) from
    the portal. Token-scoped: `_get_staff_from_token` resolves to exactly ONE
    staff row, so a staffer can only ever edit their own record — never anyone
    else's. Address is contact info for the owner, never a gate: we trim + cap
    but never reject it."""
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

    # Handle home address — DK-structured (adresse / postnr / by). Trim + cap,
    # blank → NULL. Stamp address_updated_at ONLY when a value actually CHANGES
    # so "Opdateret {dato}" honestly reflects the last real edit (the portal
    # always sends all three fields on save, so stamping on presence would lie).
    from app.schemas.staff import _clean_address_field
    _addr_changed = False
    if body.address is not None:
        _v = _clean_address_field(body.address, 200)
        if _v != member.address:
            member.address = _v
            _addr_changed = True
    if body.postal_code is not None:
        _v = _clean_address_field(body.postal_code, 20)
        if _v != member.postal_code:
            member.postal_code = _v
            _addr_changed = True
    if body.city is not None:
        _v = _clean_address_field(body.city, 120)
        if _v != member.city:
            member.city = _v
            _addr_changed = True
    if _addr_changed:
        member.address_updated_at = utc_now()
        # Best-effort audit — the owner's trail of who changed contact PII.
        try:
            from app.services import audit_service

            audit_service.record(
                db, link.user_id, "staff.portal.profile_updated", "staff_member",
                entity_id=member.id,
                after={"field": "address"},
                actor_type="staff",
            )
        except Exception:  # noqa: BLE001 — audit is best-effort, never blocks the save
            pass

    db.commit()
    return {
        "email": member.email,
        "phone": member.phone,
        "address": member.address,
        "postal_code": member.postal_code,
        "city": member.city,
        "message": "Contact info updated",
    }


# ── Bank account ───────────────────────────────────────────────────────────
#
# The staff member enters their own konto so the owner has it for the payroll
# export. Three properties hold this together, and none is optional:
#
#   1. PIN. These paths are NOT in the exempt list in `_get_staff_from_token`,
#      so on a PIN-protected link every call here 401s without a valid proof.
#      That is what stops a forwarded link or a borrowed phone reading it.
#   2. LAST-4 ONLY on the way out. The full number never leaves the server
#      towards the staff phone — not even to the person who typed it. There is
#      nothing they can do with the full digits that "•••• 8901 · reg 1234"
#      does not already let them do, which is confirm it is the right account.
#   3. AUDITED. Writes and clears land in audit_logs. The owner is paying money
#      to this number; a silent change is the one thing that must not happen.
#
# The reg-nr IS returned in full: it names the bank branch, is not a secret,
# and without it "•••• 8901" is not enough for someone to tell Danske from Nordea.


@router.get("/{token}/bank")
def get_portal_bank(token: str, request: Request, db: Session = Depends(get_db)):
    """The staff member's own account, masked. PIN-gated via _get_staff_from_token."""
    link, member = _get_staff_from_token(token, db)

    from app.services import staff_bank

    if not staff_bank.has_bank(member):
        return {"has_bank": False, "reg_nr": None, "masked": None, "updated_at": None}

    # A decrypt failure here means APP_SECRET_KEY rotated without _PREVIOUS.
    # Fail loud rather than rendering "no account" — the silent version would
    # have the owner paying nobody with nothing in any log.
    reg = staff_bank.decrypt_account(member.bank_reg_nr_enc)
    acct = staff_bank.decrypt_account(member.bank_account_enc)

    return {
        "has_bank": True,
        "reg_nr": reg or None,
        "masked": staff_bank.mask(acct),
        "updated_at": member.bank_updated_at.isoformat() if member.bank_updated_at else None,
    }


@router.put("/{token}/bank")
@limiter.limit("5/minute")
def update_portal_bank(token: str, body: BankUpdateRequest, request: Request, db: Session = Depends(get_db)):
    """Staff sets or replaces their own account.

    Token-scoped exactly like the contact endpoint: `_get_staff_from_token`
    resolves to one staff row, so nobody can write anyone else's account.
    """
    link, member = _get_staff_from_token(token, db)

    from app.services import staff_bank

    # Refuse to accept an account we cannot promise to give back. Without a
    # dedicated APP_SECRET_KEY the at-rest key is derived from the JWT secret,
    # and a documented JWT rotation would make every stored account permanently
    # undecryptable. Taking someone's bank details under those conditions and
    # losing them silently is worse than not taking them.
    if not staff_bank.storage_available():
        raise HTTPException(
            status_code=503,
            detail={"code": "bank_storage_unavailable", "message": "Bank storage is not configured."},
        )

    try:
        reg, acct = staff_bank.normalise(body.reg_nr, body.account_number)
    except staff_bank.BankValidationError as e:
        # `code` is stable and translatable; the message is a developer aid.
        # The portal maps the code to Danish — never show this sentence raw.
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})

    member.bank_reg_nr_enc, member.bank_account_enc = staff_bank.encrypt_pair(reg, acct)
    member.bank_updated_at = utc_now()

    try:
        from app.services import audit_service

        audit_service.record(
            db, link.user_id, "staff.portal.bank_updated", "staff_member",
            entity_id=member.id,
            # Last-4 only — an audit row must never become the plaintext copy
            # of the thing the column is encrypted to protect.
            after={"field": "bank_account", "masked": staff_bank.mask(acct)},
            actor_type="staff",
        )
    except Exception:  # noqa: BLE001 — audit is best-effort, never blocks the save
        pass

    db.commit()
    return {
        "has_bank": True,
        "reg_nr": reg,
        "masked": staff_bank.mask(acct),
        "updated_at": member.bank_updated_at.isoformat(),
    }


@router.delete("/{token}/bank")
@limiter.limit("5/minute")
def delete_portal_bank(token: str, request: Request, db: Session = Depends(get_db)):
    """Staff removes their own account. Idempotent — deleting nothing is fine.

    Exists because "you may enter it" is only honest if "you may take it back"
    is also true; it is also the staffer's own GDPR erasure lever for the one
    financial field they gave us.
    """
    link, member = _get_staff_from_token(token, db)

    from app.services import staff_bank

    had = staff_bank.has_bank(member)
    staff_bank.clear_bank(member)

    if had:
        try:
            from app.services import audit_service

            audit_service.record(
                db, link.user_id, "staff.portal.bank_cleared", "staff_member",
                entity_id=member.id, actor_type="staff",
            )
        except Exception:  # noqa: BLE001
            pass

    db.commit()
    return {"has_bank": False, "reg_nr": None, "masked": None, "updated_at": None}


@router.post("/{token}/profile-photo")
@limiter.limit("6/minute")
def upload_portal_profile_photo(
    token: str,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Staffer uploads/replaces their OWN profile photo. Token-scoped, so a
    staffer can only ever set their own avatar. The image (a full-res phone
    photo up to 8 MB) is re-encoded to a small square JPEG — EXIF/GPS stripped,
    polyglots killed — BEFORE it touches storage, so what the owner sees is
    light and clean. Served only via the tenant-checked proxy below, never a
    public URL."""
    link, member = _get_staff_from_token(token, db)

    from app.services.chat_image import sanitize_profile_photo
    from app.services.storage import compose_key, get_storage

    raw = file.file.read()
    data, content_type, sha = sanitize_profile_photo(raw)  # validates + resizes; raises on bad input

    storage = get_storage()
    # "staff_avatar" is the registered kind for this — it's in BOTH
    # storage.ALLOWED_KINDS (so compose_key accepts it) AND ERASURE_PURGE_KINDS
    # (so the GDPR account-delete prefix purge actually removes the face photo).
    key = compose_key(member.user_id, "staff_avatar", sha, ext="jpg")
    storage.put(key, data, content_type)

    old_key = member.profile_photo_key
    member.profile_photo_key = key
    member.profile_photo_at = utc_now()
    # Best-effort orphan cleanup: drop the previous blob when the key actually
    # changed (content-addressed keys mean re-uploading the SAME image reuses
    # the key). The GDPR delete-account prefix purge is the backstop.
    if old_key and old_key != key:
        try:
            storage.delete(old_key)
        except Exception:  # noqa: BLE001
            pass

    try:
        from app.services import audit_service

        audit_service.record(
            db, link.user_id, "staff.portal.profile_photo", "staff_member",
            entity_id=member.id, after={"action": "upload"}, actor_type="staff",
        )
    except Exception:  # noqa: BLE001 — audit is best-effort
        pass

    db.commit()
    return {"profile_photo_at": member.profile_photo_at}


@router.delete("/{token}/profile-photo")
@limiter.limit("6/minute")
def delete_portal_profile_photo(token: str, request: Request, db: Session = Depends(get_db)):
    """Staffer removes their own profile photo."""
    link, member = _get_staff_from_token(token, db)
    old_key = member.profile_photo_key
    member.profile_photo_key = None
    member.profile_photo_at = None
    if old_key:
        try:
            from app.services.storage import get_storage

            get_storage().delete(old_key)
        except Exception:  # noqa: BLE001
            pass
    db.commit()
    return {"profile_photo_at": None}


@router.get("/{token}/profile-photo")
@limiter.limit("60/minute")
def get_portal_profile_photo(token: str, request: Request, db: Session = Depends(get_db)):
    """Proxy-serve the token-owner's OWN profile photo (self-only via the
    token). 404 when none set — the client falls back to initials."""
    _link, member = _get_staff_from_token(token, db)
    if not member.profile_photo_key:
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
#  Fravær (absence) — staff registers ferie / sygdom for a date RANGE.
#  Distinct from the single-shift sick-call above: this is the Planday-style
#  "I'm off these days" that the owner sees + documents. Tracking only — no
#  pay/sygeløn/feriepenge is computed anywhere.
# ═══════════════════════════════════════════════════════════════════════════
class AbsenceRegisterBody(BaseModel):
    kind: str = "sick"           # sick | ferie | barns_syg | andet
    date_from: date
    date_to: date | None = None  # null → single day (== date_from)
    reason: str | None = None


@router.post("/{token}/absence")
@limiter.limit("6/minute")
def portal_register_absence(
    token: str, body: AbsenceRegisterBody, request: Request, db: Session = Depends(get_db)
):
    """Staffer registers a fravær over a date range. Owner + staff are
    re-derived from the token — never the body. Materializes one row per day
    (idempotent per day+kind); returns how many were created vs already there."""
    _link, member = _get_staff_from_token(token, db)
    from app.services.sick_call_service import register_absence, SickCallError
    date_to = body.date_to or body.date_from
    try:
        created, skipped = register_absence(
            db,
            owner_id=member.user_id,
            staff_id=member.id,
            kind=body.kind,
            date_from=body.date_from,
            date_to=date_to,
            reason=body.reason,
        )
    except SickCallError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "created": created,
        "skipped": skipped,
        "kind": body.kind,
        "date_from": body.date_from.isoformat(),
        "date_to": date_to.isoformat(),
    }


@router.get("/{token}/absence")
@limiter.limit("30/minute")
def portal_list_absence(token: str, request: Request, db: Session = Depends(get_db)):
    """This staffer's own fravær (recent + upcoming), so they see their own
    ferie/syg. reason is theirs to see; peers never get this list."""
    from app.models.absence import StaffAbsence
    _link, member = _get_staff_from_token(token, db)
    since = date.today() - timedelta(days=31)
    rows = (
        db.query(StaffAbsence)
        .filter(
            StaffAbsence.staff_id == member.id,
            StaffAbsence.user_id == member.user_id,
            StaffAbsence.date >= since,
        )
        .order_by(StaffAbsence.date.desc())
        .all()
    )
    return {
        "absence": [
            {
                "id": str(a.id),
                "kind": a.kind,
                "date": a.date.isoformat(),
                "status": a.status,
                "reason": a.reason,
            }
            for a in rows
        ]
    }


class AbsenceWithdrawBody(BaseModel):
    ids: list[str]


@router.post("/{token}/absence/withdraw")
@limiter.limit("6/minute")
def portal_withdraw_absence(
    token: str, body: AbsenceWithdrawBody, request: Request, db: Session = Depends(get_db)
):
    """Staffer withdraws their OWN still-pending fravær rows (the UI sends the
    whole grouped range's ids). Identity re-derived from the token — a peer's
    or foreign id silently matches nothing (filtered by staff_id+user_id), and
    already-decided rows (godkendt/afvist) are never touched. Status becomes
    'cancelled' so every existing consumer (owner grid tint, approval card)
    treats it exactly like a declined row: gone from the roster view."""
    import uuid as _uuid
    from app.models.absence import StaffAbsence
    _link, member = _get_staff_from_token(token, db)
    if not body.ids or len(body.ids) > 62:
        raise HTTPException(status_code=422, detail="1-62 ids")
    try:
        uuids = [_uuid.UUID(i) for i in body.ids]
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=422, detail="Invalid id")
    n = (
        db.query(StaffAbsence)
        .filter(
            StaffAbsence.id.in_(uuids),
            StaffAbsence.staff_id == member.id,
            StaffAbsence.user_id == member.user_id,
            StaffAbsence.status == "pending",
        )
        .update({"status": "cancelled"}, synchronize_session=False)
    )
    db.commit()
    return {"withdrawn": int(n)}


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
    # Location of the offered shift (multi-location S5) — pool rows show
    # WHERE the shift is so a colleague knows before taking it. Name only.
    from_branch_name: str | None = None
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
    from_branch_name = None
    if from_sched is not None and from_sched.branch_id:
        from app.models.branch import Branch
        _b = db.query(Branch).filter(Branch.id == from_sched.branch_id).first()
        from_branch_name = _b.name if _b else None
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
        from_branch_name=from_branch_name,
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
    # Multi-location S4 — lets the who's-on strip scope to the viewer's
    # floor. Name only (no address): a teammate's location is coordination
    # info, their venue address is not the viewer's business.
    branch_name: str | None = None


@router.get("/{token}/team-schedule", response_model=list[TeamShift])
@limiter.limit("30/minute")
def portal_team_schedule(
    token: str,
    request: Request,
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
            # Only PUBLISHED (or already-confirmed) shifts reach a teammate's
            # phone — same rule as the staff's own schedule (line ~254) and the
            # rostered-hours query (line ~406). Draft shifts the owner is still
            # planning must never leak into the who's-on strip or the swap-target
            # picker: they're not real commitments and you can't swap a draft.
            Schedule.status.in_(("published", "confirmed")),
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .order_by(Schedule.date.asc(), Schedule.start_time.asc())
        .all()
    )

    # Branch names for location-scoped who's-on (S4) — one batch query,
    # only when any shift actually carries a branch.
    _b_ids = {s.branch_id for s, _ in shifts if s.branch_id}
    _b_names = {}
    if _b_ids:
        from app.models.branch import Branch
        for b in db.query(Branch).filter(Branch.id.in_(_b_ids)).all():
            _b_names[b.id] = b.name

    return [
        TeamShift(
            shift_id=str(s.id),
            staff_id=str(staff.id),
            staff_name=staff.name,
            date=s.date,
            start_time=s.start_time,
            end_time=s.end_time,
            role=s.role_on_shift,
            branch_name=_b_names.get(s.branch_id),
        )
        for s, staff in shifts
    ]


# ── Open shifts (Åbne vagter) — staff side ─────────────────────────────────


class PortalOpenShift(BaseModel):
    """An unassigned slot the staffer can claim. Lightweight — date/time/role
    only; no owner data, no cost, no PII."""
    id: str
    date: date
    start_time: str
    end_time: str
    role: str | None
    break_minutes: int = 0
    # Where the hole is (multi-location S5). Name only, same privacy rule
    # as the who's-on strip.
    branch_name: str | None = None


@router.get("/{token}/open-shifts", response_model=list[PortalOpenShift])
@limiter.limit("30/minute")
def portal_open_shifts(token: str, request: Request, db: Session = Depends(get_db)):
    """Open shifts this staffer can pick up — their owner's, status='open',
    upcoming (today..+21d). PULL model (no blast on creation) = spam-safe.
    Tenant-bound by the magic-link token."""
    _link, member = _get_staff_from_token(token, db)
    today = date.today()
    end = today + timedelta(days=21)
    rows = (
        db.query(OpenShift)
        .filter(
            OpenShift.user_id == member.user_id,
            OpenShift.status == "open",
            OpenShift.date >= today,
            OpenShift.date <= end,
        )
        .order_by(OpenShift.date.asc(), OpenShift.start_time.asc())
        .all()
    )
    _b_ids = {o.branch_id for o in rows if o.branch_id}
    _b_names = {}
    if _b_ids:
        from app.models.branch import Branch
        for b in db.query(Branch).filter(Branch.id.in_(_b_ids)).all():
            _b_names[b.id] = b.name

    return [
        PortalOpenShift(
            id=str(o.id), date=o.date, start_time=o.start_time,
            end_time=o.end_time, role=o.role_on_shift,
            break_minutes=o.break_minutes or 0,
            branch_name=_b_names.get(o.branch_id),
        )
        for o in rows
    ]


@router.post("/{token}/open-shifts/{open_shift_id}/claim")
@limiter.limit("12/minute")
def portal_claim_open_shift(
    token: str, open_shift_id: str, request: Request,
    db: Session = Depends(get_db),
):
    """Staffer claims an open shift one-tap. ATOMIC: a conditional UPDATE on
    status='open' means only ONE concurrent claimer wins — the rest get 409
    already_taken, never an orphan shift. Overlap-guarded against the claimer's
    own shifts that day. On success it materializes a real PUBLISHED Schedule
    row for the claimer and notifies the owner (awareness, never a gate)."""
    import uuid as _uuid
    from app.routers.staff import _find_overlapping_shift

    _link, member = _get_staff_from_token(token, db)
    try:
        os_uuid = _uuid.UUID(open_shift_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid open_shift_id")

    o = db.query(OpenShift).filter(
        OpenShift.id == os_uuid,
        OpenShift.user_id == member.user_id,  # tenant-bound by the token's owner
    ).first()
    if not o:
        raise HTTPException(status_code=404, detail="Open shift not found")
    if o.status != "open":
        raise HTTPException(
            status_code=409,
            detail={"code": "already_taken", "message": "That shift was just taken."},
        )
    # The list only surfaces upcoming slots, but a stale client / direct call
    # must not materialize a shift in the past.
    if o.date < date.today():
        raise HTTPException(
            status_code=409,
            detail={"code": "shift_passed", "message": "That shift has already passed."},
        )

    # Overlap guard — can't claim a slot that collides with a shift you already
    # have that day (same half-open semantics as the owner-grid guard).
    conflict = _find_overlapping_shift(
        db, user_id=member.user_id, staff_id=member.id,
        shift_date=o.date, start_time=o.start_time, end_time=o.end_time,
    )
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={"code": "shift_overlap",
                    "message": "You already have a shift that overlaps this one."},
        )

    # ATOMIC claim — conditional on still-open. Done BEFORE creating the
    # Schedule row so a lost race never spawns a shift.
    new_schedule_id = _uuid.uuid4()
    claimed = (
        db.query(OpenShift)
        .filter(OpenShift.id == os_uuid, OpenShift.status == "open")
        .update(
            {
                OpenShift.status: "filled",
                OpenShift.claimed_by_staff_id: member.id,
                OpenShift.claimed_schedule_id: new_schedule_id,
                OpenShift.claimed_at: utc_now(),
            },
            synchronize_session=False,
        )
    )
    if not claimed:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"code": "already_taken", "message": "That shift was just taken."},
        )

    # Materialize a real PUBLISHED shift for the claimer (flows into hours,
    # who's-on, payroll like any committed shift).
    shift = Schedule(
        id=new_schedule_id,
        user_id=member.user_id,
        staff_id=member.id,
        date=o.date,
        start_time=o.start_time,
        end_time=o.end_time,
        break_minutes=o.break_minutes or 0,
        role_on_shift=o.role_on_shift,
        status="published",
        branch_id=o.branch_id,  # the claim inherits WHERE the hole was (S5)
    )
    db.add(shift)
    db.commit()

    # Tell the owner the hole is filled (best-effort; never blocks the claim).
    try:
        owner = db.query(User).filter(User.id == member.user_id).first()
        if owner:
            from app.services.notification_service import notify_owner_shift_claimed
            notify_owner_shift_claimed(
                db, owner=owner, staff_name=member.name, shift_date=o.date,
                start_time=o.start_time, end_time=o.end_time,
            )
    except Exception:  # noqa: BLE001
        pass

    # Live-sync nudge so connected portals + the owner grid refresh.
    try:
        _monday = o.date - timedelta(days=o.date.weekday())
        portal_events.publish(
            str(member.user_id),
            {"type": "schedule_published", "week_start": _monday.isoformat()},
        )
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "schedule_id": str(new_schedule_id),
        "date": o.date.isoformat(),
        "start_time": o.start_time,
        "end_time": o.end_time,
    }


class GiveawayOfferBody(BaseModel):
    shift_id: str
    reason: str | None = None


@router.post("/{token}/give-aways", response_model=SwapPortalResponse)
@limiter.limit("6/minute")
def portal_offer_giveaway(
    token: str,
    body: GiveawayOfferBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """Staffer puts their own shift up for grabs ("Sæt vagt til salg").
    staff_id is bound by the magic-link token, never the body."""
    import uuid as _uuid
    from app.services.shift_swap_service import offer_giveaway, ShiftSwapError

    _link, member = _get_staff_from_token(token, db)
    try:
        shift_id = _uuid.UUID(body.shift_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid id")
    try:
        swap = offer_giveaway(
            db, owner_id=member.user_id, from_staff_id=member.id,
            from_shift_id=shift_id, reason=body.reason,
        )
    except ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _hydrate_swap(swap, db, viewer_staff_id=member.id)


@router.get("/{token}/give-aways", response_model=list[SwapPortalResponse])
@limiter.limit("30/minute")
def portal_list_giveaways(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Open give-aways from COLLEAGUES (the claimable pool). The viewer's own
    offers already appear in their swap-requests list (same table)."""
    from app.services.shift_swap_service import list_open_giveaways

    _link, member = _get_staff_from_token(token, db)
    rows = list_open_giveaways(
        db, owner_id=member.user_id, exclude_staff_id=member.id,
    )
    return [_hydrate_swap(s, db, viewer_staff_id=member.id) for s in rows]


@router.post("/{token}/give-aways/{giveaway_id}/claim", response_model=SwapPortalResponse)
@limiter.limit("10/minute")
def portal_claim_giveaway(
    token: str,
    giveaway_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Colleague takes an open give-away — executes immediately (the shift
    reassigns), per the auto-execute-on-mutual-handshake swap doctrine.
    Owner is notified, not gated."""
    import uuid as _uuid
    from app.services.shift_swap_service import claim_giveaway, ShiftSwapError

    _link, member = _get_staff_from_token(token, db)
    try:
        ga_uuid = _uuid.UUID(giveaway_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid id")
    try:
        swap = claim_giveaway(
            db, owner_id=member.user_id, swap_id=ga_uuid,
            claimer_staff_id=member.id,
        )
    except ShiftSwapError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Owner awareness + live grid/portal refresh — both best-effort.
    sched = db.query(Schedule).filter(Schedule.id == swap.from_shift_id).first()
    offerer = db.query(StaffMember).filter(
        StaffMember.id == swap.from_staff_id
    ).first()
    if sched is not None:
        try:
            owner = db.query(User).filter(User.id == member.user_id).first()
            if owner:
                from app.services.notification_service import notify_owner_shift_claimed
                notify_owner_shift_claimed(
                    db, owner=owner,
                    staff_name=(
                        f"{member.name} (overtog {offerer.name}s vagt)"
                        if offerer else member.name
                    ),
                    shift_date=sched.date,
                    start_time=sched.start_time, end_time=sched.end_time,
                )
        except Exception:  # noqa: BLE001
            pass
        try:
            _monday = sched.date - timedelta(days=sched.date.weekday())
            portal_events.publish(
                str(member.user_id),
                {"type": "schedule_published", "week_start": _monday.isoformat()},
            )
        except Exception:  # noqa: BLE001
            pass

    return _hydrate_swap(swap, db, viewer_staff_id=member.id)


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
@limiter.limit("30/minute")
def portal_list_swaps(
    token: str,
    request: Request,
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

    # When an accept auto-executes the swap (status 'done'), inform the
    # owner — awareness only, never a gate (the schedules are already
    # reassigned). Best-effort: a notification failure must not undo or
    # block the completed swap.
    if swap.status == "done":
        try:
            from app.services.notification_service import notify_owner_swap_executed
            notify_owner_swap_executed(db, owner_id=member.user_id, swap=swap)
        except Exception:  # noqa: BLE001
            pass

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
#  NATIVE DEVICE TOKENS — APNs push for the BonBox Scheduler app
# ═══════════════════════════════════════════════════════════════════════════
# Web push above is dead inside the native shell's WKWebView, so the App
# Store app registers an APNs device token here instead. Same doctrine as
# /push/subscribe: link-token capability auth (PIN-gated when the link has
# one), tier gate via _staff_push_feature_check, bounds, tenant scoping,
# audit rows, and an explicit unregister the Frakobl action calls.

_APNS_TOKEN_RE = re.compile(r"^[A-Fa-f0-9]{16,200}$")


class PortalDeviceIn(BaseModel):
    token: str
    platform: str = "ios"


@router.post("/{token}/device")
@limiter.limit("10/minute")
def portal_device_register(
    token: str,
    body: PortalDeviceIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Idempotent upsert of the phone's APNs token for THIS staff link.

    Rebinding is deliberate: a phone that connects to a NEW workplace moves
    its token row to the new link — the old workplace must stop pushing to
    a phone that left (same reasoning as the disconnect action)."""
    from app.models.staff_device_token import StaffDeviceToken
    from app.services import audit_service
    from app.utils.time import utc_now

    link, member = _get_staff_from_token(token, db)
    owner = _staff_push_feature_check(link, db)

    device_token = (body.token or "").strip()
    if not _APNS_TOKEN_RE.fullmatch(device_token):
        raise HTTPException(status_code=422, detail="invalid_device_token")
    if body.platform not in ("ios",):
        raise HTTPException(status_code=422, detail="invalid_platform")

    row = (
        db.query(StaffDeviceToken)
        .filter(StaffDeviceToken.token == device_token)
        .first()
    )
    created = False
    if row is None:
        row = StaffDeviceToken(
            id=uuid.uuid4(),
            user_id=owner.id,
            staff_id=member.id,
            link_id=link.id,
            platform=body.platform,
            token=device_token,
        )
        db.add(row)
        created = True
    else:
        # Same physical device, possibly a new workplace/staffer — rebind.
        row.user_id = owner.id
        row.staff_id = member.id
        row.link_id = link.id
        row.platform = body.platform
        row.last_seen_at = utc_now()

    audit_service.record(
        db, owner, "staff.device.registered", "staff_device_token",
        entity_id=row.id,
        after={"staff_id": str(member.id), "platform": body.platform,
               "token_suffix": device_token[-6:], "created": created},
    )
    db.commit()
    return {"ok": True, "created": created}


@router.delete("/{token}/device")
@limiter.limit("10/minute")
def portal_device_unregister(
    token: str,
    body: PortalDeviceIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Remove this phone's APNs token — called by the Frakobl (disconnect)
    action so a departed phone goes quiet. Scoped to THIS link's tenant so
    a token value can never be used to delete another workplace's row."""
    from app.models.staff_device_token import StaffDeviceToken
    from app.services import audit_service

    link, member = _get_staff_from_token(token, db)

    device_token = (body.token or "").strip()
    if not _APNS_TOKEN_RE.fullmatch(device_token):
        raise HTTPException(status_code=422, detail="invalid_device_token")

    row = (
        db.query(StaffDeviceToken)
        .filter(
            StaffDeviceToken.token == device_token,
            StaffDeviceToken.user_id == link.user_id,
        )
        .first()
    )
    deleted = False
    if row is not None:
        from app.models.user import User
        owner = db.query(User).filter(User.id == link.user_id).first()
        if owner is not None:
            audit_service.record(
                db, owner, "staff.device.unregistered", "staff_device_token",
                entity_id=row.id,
                before={"staff_id": str(member.id),
                        "token_suffix": device_token[-6:]},
            )
        db.delete(row)
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
def portal_manifest(token: str, request: Request, lang: str = "da", db: Session = Depends(get_db)):
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
    # Schedule-branded, language-aware identity so the installed app is clearly a
    # SEPARATE "Vagtplan/Schedule" app (own icon + name) — not the generic owner
    # app. DK-first default. The schedule word IS translatable (unlike locked
    # terms kasserapport/MOMS/faktura), so EN staff get "Schedule".
    _L = {
        "da": {"sched": "Vagtplan", "hours": "Timer", "tips": "Drikkepenge",
               "tips_short": "Tips", "desc": "Din vagtplan, timer og drikkepenge"},
        "en": {"sched": "Schedule", "hours": "Hours", "tips": "Tips",
               "tips_short": "Tips", "desc": "Your shifts, hours and tips"},
    }
    code = (lang or "da")[:2].lower()
    L = _L.get(code, _L["da"])
    sched = L["sched"]
    start = portal_path(token, name)  # /s/<slug>/<token>
    manifest = {
        "name": f"{name} · {sched}",
        # Icon label = venue brand (Manoj's call); the full `name` above still
        # marks it as the separate "· Vagtplan/Schedule" app in the install
        # dialog + app switcher, and the distinct id/start_url/scope keep it a
        # separate installed app from the owner app.
        "short_name": (name[:12] or sched),
        "description": L["desc"],
        "id": start,
        "start_url": start,
        "scope": "/s/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": "#ffffff",
        "orientation": "portrait-primary",
        "lang": code,
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": sched, "short_name": sched, "url": f"{start}?tab=schedule"},
            {"name": L["hours"], "short_name": L["hours"], "url": f"{start}?tab=hours"},
        ],
    }
    return Response(
        content=json.dumps(manifest),
        media_type="application/manifest+json",
        headers={"Cache-Control": "public, max-age=300"},
    )
