"""Visitor-facing reservation endpoints (no auth) — the /r/<slug> surface.

  • GET  /api/public/reservations/{slug}               — page data
  • GET  /api/public/reservations/{slug}/availability  — bookable slots
  • POST /api/public/reservations/{slug}               — create (idempotent)
  • GET  /api/public/reservations/booking/{id}         — visitor poll (token)
  • POST /api/public/reservations/booking/{id}/cancel  — visitor cancel (token)

Multi-barrier: L1 no auth (identity = idempotency key + booking-token JWT)
· L2 tenant scope via the slug→owner resolution · L3 Pydantic bounds · L4
rate limits · L5 fail-soft · L6 IDOR-safe 404 on token mismatch · L7
PLAN_CAPS fail-closed (owner's monthly cap → generic 409, never a tier
leak to the visitor) · L8 audit · L9 410 when reservations disabled · L10
honest "no availability": a per-day `reason` names why a day is unbookable
(reservation_service.DAY_REASONS); never a plan or tier word.

NOTE: no `from __future__ import annotations` (FastAPI body-resolver, see
public_bookings.py).
"""
import logging
from datetime import datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import (
    APIRouter, BackgroundTasks, Body, Depends, Header, HTTPException, Path, Query, Request,
)
import re

from pydantic import BaseModel, Field, field_validator, model_validator
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import StaffMember
from app.models.user import User
from app.services import audit_service, reservation_service as rsvc
from app.services import booking_screen
from app.services import owner_booking_alerts
from app.services import reservation_emails
from app.services import venue_identity
from app.services import reservation_occupancy_service as occ_service
from app.services.venue_lock import venue_lock
from app.services.allergens import allergen_set_for, collects_allergies, sanitize_severity, sanitize_tags
from app.services.billing import at_cap, has_feature
from app.services.logo_service import logo_signed_url
from app.services.owner_language import venue_language
from app.services.qr_signer import sign_booking_token, verify_booking_token
from app.utils import abuse_signals
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
internal_router = APIRouter()
_limiter = Limiter(key_func=client_ip)
_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Europe/Copenhagen wall-clock, matching the engine's naive
    local windows."""
    return datetime.now(_TZ).replace(tzinfo=None)


# Shape checks for guest contact. Deliberately permissive: a booking form
# is not a signup, and a tourist's +44 number must go through. They exist
# to catch a typo before it becomes a confirmation nobody receives.
# The longest form_ms the server keeps (a day); larger is clamped to it.
FORM_MS_MAX = 86_400_000

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$")
_PHONE_RE = re.compile(r"^\+?[0-9 ()\-./]{6,40}$")


class PublicReservationCreate(BaseModel):
    day: str = Field(description="YYYY-MM-DD")
    time: str = Field(description="HH:MM")
    party_size: int = Field(ge=1, le=100)
    guest_name: str = Field(min_length=1, max_length=160)
    guest_email: str | None = Field(default=None, max_length=255)
    guest_phone: str | None = Field(default=None, max_length=40)
    # ── Contact is REQUIRED, and it is required HERE ──────────────────
    # The booking form has always demanded one ("Vi skal bruge én måde at
    # kontakte dig på"), but the API did not — so a script could post a
    # one-character name and nothing else, and the row auto-confirmed. At
    # 6/min per IP that fills a Friday service with untraceable holds the
    # venue cannot call to verify. A validator in the browser is a
    # courtesy; a validator on the server is the rule.
    occasion: str | None = Field(default=None, max_length=60)
    guest_notes: str | None = Field(default=None, max_length=2000)
    allergen_tags: list[str] | None = None
    allergy_note: str | None = Field(default=None, max_length=2000)
    allergy_severity: str | None = None
    consent_marketing: bool = False

    @field_validator("guest_email")
    @classmethod
    def _clean_email(cls, v):
        """Shape-check only. A booking is not an account, so we do not
        verify deliverability — but a value that cannot be an address is
        a typo the guest should fix now, not a bounced confirmation they
        never see."""
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not _EMAIL_RE.match(v):
            raise ValueError("invalid_email")
        return v

    @field_validator("guest_phone")
    @classmethod
    def _clean_phone(cls, v):
        if v is None:
            return None
        v = " ".join(v.split())
        if not v:
            return None
        digits = sum(c.isdigit() for c in v)
        # DK numbers are 8 digits; +45 and spacing push the ceiling up.
        # Loose on purpose — a tourist's foreign number must still work.
        if digits < 6 or digits > 15 or not _PHONE_RE.match(v):
            raise ValueError("invalid_phone")
        return v

    @model_validator(mode="after")
    def _require_a_way_to_reach_you(self):
        if not (self.guest_email or self.guest_phone):
            raise ValueError("contact_required")
        return self
    # Optional table the guest tapped on the public floor map. Honored only if
    # it's still free for this party at this time; otherwise we auto-assign
    # (the occupancy exclusion constraint is the real race backstop).
    resource_id: str | None = Field(default=None, max_length=64)
    # ── Salon appointment (S3a) ──────────────────────────────────────
    # When behandling_id is set, this is a SALON booking: the server resolves
    # the duration + service_name from the owner's behandlinger catalog (never
    # trusting a client-sent length), and books a PROVIDER. stylist_id pins a
    # specific stylist and FAILS CLOSED (409) if that stylist is taken — never
    # a silent reassign. Omitting stylist_id = "valgfri behandler" (any free
    # provider auto-assigned).
    behandling_id: str | None = Field(default=None, max_length=64)
    stylist_id: str | None = Field(default=None, max_length=64)
    # The language the guest is booking in — every email to them is written in
    # it. Only "da" / "en" are kept ("en-GB" → "en"); anything else, or a
    # non-string, becomes None (→ the venue's default language) rather than a
    # 422, so a client sending junk still books. Older clients omit it.
    lang: str | None = None
    # ── Guest-invisible spam guards (services/booking_screen.py) ──────
    # `website` is a trap: the field sits off-screen on our page, a person
    # never fills it, a form-filling bot does. `form_ms` is how long the
    # page was open before the guest pressed Book — a booking typed in under
    # two seconds is held as a request the owner approves, never refused. A
    # client that does not say (a page loaded before the frontend deploy)
    # books as on live (R1a fix round).
    website: str = Field(default="", max_length=200)
    form_ms: int | None = None

    @field_validator("lang", mode="before")
    @classmethod
    def _clean_lang(cls, v):
        return reservation_emails.normalize_lang(v)

    @field_validator("website", mode="before")
    @classmethod
    def _clean_website(cls, v):
        return v if isinstance(v, str) else ""

    @field_validator("form_ms", mode="before")
    @classmethod
    def _clamp_form_ms(cls, v):
        """Clamped, never refused: a page left open overnight (a desktop tab,
        the embed on the owner's site, a booking iPad at the door) sends a
        huge value, and a 422 there was a booking the guest could not make
        until they reloaded. Junk reads as "not said" — unknown, booked as
        on live (R1a fix round) — a negative as 0, anything over a day as a
        day."""
        if v is None or isinstance(v, bool):
            return None
        try:
            n = int(float(v))
        except (TypeError, ValueError, OverflowError):
            return None
        return max(0, min(n, FORM_MS_MAX))


def _resolve_owner(db: Session, slug: str) -> tuple[BusinessProfile, User]:
    """slug → (profile, owner). 410 when not found or reservations off."""
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.reservation_slug == slug)
        .first()
    )
    if profile is None or not getattr(profile, "reservations_enabled", False):
        raise HTTPException(status_code=410, detail={"error": "not_accepting"})
    owner = db.query(User).filter(User.id == profile.user_id).first()
    if owner is None or not has_feature(owner, "reservations"):
        raise HTTPException(status_code=410, detail={"error": "not_accepting"})
    return profile, owner


def _month_reservations_used(db: Session, owner: User) -> int:
    """Bookings this calendar month that CONSUME the owner's monthly quota.

    Extracted verbatim from the create handler so the availability endpoints,
    the create guard and the owner's own usage read can never disagree about
    what "used" means. Three prior outages are encoded in this filter — do not
    widen the status list without re-reading them:

    Counts bookings that EXIST, not creation attempts. Counting cancelled
    rows made the cap a denial-of-business weapon: at the 6/min public
    limit, ~20 create-then-cancel round trips (about four minutes) burned
    a Free venue's entire month, and cancelling left the floor plan clean
    so the owner saw a dead booking page with no cause. A cancelled table
    consumes nothing — the guest freed it — so it must not consume quota.

    no_show and completed DO count: the table was held, the cover was
    real. Only a cancellation gives the capacity back.

    "requested" does NOT count, by that same rule — and leaving it in was a
    live outage an anonymous stranger could trigger with curl. A group
    request (party_size >= group_request_threshold) skips the availability
    engine entirely and is a plain insert, so it ALWAYS succeeds: there is no
    capacity to bounce off. It also holds no table and no occupancy row until
    the owner approves it. So by the cancellation rule above, it consumes
    nothing.

    Counting it meant ~20 posts dated far enough out — expire_stale_requests
    only sweeps rows within 6h of the sitting, so distant junk never clears —
    held a Free venue's ENTIRE monthly allowance for as long as the attacker
    chose, and the venue's real guests then got 409 not_accepting with the
    owner seeing no cause. It starts counting the moment the owner confirms
    it, which is when a table is actually held.
    """
    month_start = _now_local().replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    return int(
        (
            db.query(func.count(Reservation.id))
            .filter(Reservation.user_id == owner.id,
                    Reservation.created_at >= month_start,
                    Reservation.is_deleted.is_(False),
                    Reservation.status.in_(
                        ("confirmed", "seated", "completed", "no_show")
                    ))
            .scalar()
        ) or 0
    )


def _at_month_cap(db: Session, owner: User) -> bool:
    """True when this venue may not accept another online booking this month.

    Called from the AVAILABILITY endpoints as well as create. Before this, the
    cap was checked only inside the POST: a venue at its ceiling still
    advertised open evenings and per-slot "2 left" scarcity hints, and the
    guest learned the truth only after typing their name, phone, party size and
    allergy notes — with the client's 409 handler leaving them on a filled-in
    dead form, because it only returns to step 1 for slot_unavailable.

    Fails OPEN on error: a billing hiccup must never take a venue's booking
    page down. The create guard is the barrier that actually enforces the cap;
    this one only decides whether to show a closed page instead of a trap.
    """
    try:
        return at_cap(owner, "reservations_per_month",
                      _month_reservations_used(db, owner))
    except Exception:  # noqa: BLE001 — never break the public page on this
        logger.warning("reservation cap check failed for owner %s", owner.id,
                       exc_info=True)
        return False


def _cap_closes_page(db: Session, owner: User) -> bool:
    """Does the plan's monthly cap close the booking page right now? Only
    when the cap is reached AND the cap does not take requests instead
    (R1b, booking_screen.plan_cap_requests_on — off unless the volume switch
    or BOOKING_PLAN_CAP_REQUESTS says so). With requests on, the page stays
    open at the cap: every day keeps its times, and a booking made there
    waits for the owner's yes (plan_cap) — never "not accepting"."""
    if booking_screen.plan_cap_requests_on():
        return False
    return _at_month_cap(db, owner)



def _receipt_token(r) -> str:
    """The booking-poll token the receipt page keeps. Same lifetime as the
    email link — until the booking plus 48 h (min 24 h): a phone-only guest
    is told to keep the page as their receipt, and a 24-hour token turned it
    into "Vi kunne ikke åbne reservationen" — cancel link included — a day
    later."""
    ttl = 24
    try:
        if r.starts_at:
            from datetime import datetime as _dt
            delta_h = (r.starts_at - _dt.now()).total_seconds() / 3600.0
            ttl = max(24, int(delta_h) + 48)
    except Exception:  # noqa: BLE001
        ttl = 24
    return sign_booking_token(str(r.id), ttl_hours=ttl)

@router.get("/{slug}")
@_limiter.limit("60/minute")
def public_page(request: Request, slug: str = Path(...), db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)
    settings = rsvc.load_settings(profile)
    btype = getattr(owner, "business_type", None) or "restaurant"
    # Provider venues (salon) expose their bookable stylists so the public page
    # can offer "book with <behandler>" instead of Valgfri-only. Each entry is
    # {id, name}: `id` is the resource id the booking endpoint accepts as
    # stylist_id; `name` is the bound staff member's CURRENT display name (the
    # source of truth — it tracks a rename the free-text station label wouldn't),
    # falling back to the label, then a neutral word so it is never blank.
    #
    # Filter mirrors _has_active_provider (active, non-deleted provider rows),
    # so a non-salon venue — which has zero kind='provider' rows — returns []
    # and never leaks that it isn't a salon. LEFT join keeps a station whose
    # staff_id is NULL (it falls back to its label).
    #
    # PII-safe: ONLY {id, name} leaves the building. StaffMember.name is the
    # public-facing display name; the row's email / phone / wage / tax-card
    # fields are never selected, never serialised.
    _provider_rows = (
        db.query(BookableResource, StaffMember.name)
        # Tenant-scope the join: only THIS owner's staff name may be joined.
        # If a station's staff_id ever pointed at another tenant's StaffMember,
        # the LEFT join yields NULL → we fall back to the label and never leak
        # a foreign staff member's name on this public page (Layer-5 isolation).
        .outerjoin(
            StaffMember,
            and_(
                StaffMember.id == BookableResource.staff_id,
                StaffMember.user_id == owner.id,
            ),
        )
        .filter(
            BookableResource.user_id == owner.id,
            BookableResource.kind == "provider",
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
        )
        .order_by(BookableResource.label)
        .all()
    )
    providers = [
        {"id": str(r.id), "name": (staff_name or r.label or "Behandler")}
        for r, staff_name in _provider_rows
    ]
    name, contact = _safe_identity(owner, profile, settings)
    return {
        # Consumer-facing venue name (venue_identity.public_venue_name): the
        # owner's trading name (Profile → business_name), then the company
        # name, whitespace-collapsed. Never our product name and never the
        # demo seeder's sample company: None = no usable name, and the page
        # words a nameless venue itself ("Book et bord"). It used to fall back
        # to "BonBox" — our name on the restaurant's page.
        "business_name": name,
        # The owner's own brand logo (same one used on invoices/kasserapport) so
        # the public booking page carries their identity, not just initials. A
        # short-lived SIGNED url — never the storage key. None if unset / storage
        # error (the page falls back to the typographic monogram). Not PII.
        "logo_url": (logo_signed_url(profile.logo_url)
                     if getattr(profile, "logo_url", None) else None),
        "business_type": btype,
        # Provider stations (salon stylists) for the public "book with <behandler>"
        # picker. PII-safe: only public label + resource id. [] for table venues.
        "providers": providers,
        # Where it is and how to call (venue_identity.public_venue_contact):
        # public_address wins over the BOOKKEEPING address (which prints on
        # invoices and, for a home-run venue, carries a floor and door number
        # that has no business being served to anonymous visitors); the
        # reservations "call us" number wins over the Profile phone. The demo
        # seeder's sample street, city and phone (a stranger's number) are
        # withheld while the identity is the demo's, field by field.
        "city": contact["city"],
        "address": contact["address"],
        "phone": contact["phone"],
        "allergen_set": allergen_set_for(btype),
        # The ceiling as the engine applies it (None = no limit): a stored 0
        # is "no limit" on every path (rsvc.online_party_ceiling).
        "max_party_size": rsvc.online_party_ceiling(settings),
        "group_request_threshold": settings.get("group_request_threshold"),
        "guest_can_pick_table": bool(settings.get("guest_can_pick_table")),
        "max_advance_days": settings.get("max_advance_days"),
        "lead_time_min": settings.get("lead_time_min"),
        # Best-effort default UI language for this venue's public page — Danish
        # only on a genuine DK signal (owner_language.venue_language). The
        # guest can still switch; guest emails fall back to the same language.
        "language": venue_language(profile, owner),
        # The venue's week as the booking engine reads it (rsvc.public_week):
        # None when no single weekly claim is true (a salon on stylist
        # shifts, tables and chairs together, no resource) or nothing is
        # declared. Opening hours only — no bookability claim (the date strip
        # owns that), and nothing about plans or caps.
        "hours": _safe_week(db, owner, profile, settings),
        # Dates the owner closed for online booking inside the booking window
        # ({from, to, note, kind}) and, while a pause covers today, the last
        # paused day — the page says "opens again <the day after>".
        **_safe_closures(settings),
    }


def _safe_closures(settings: dict) -> dict:
    """The page's closures and pause, fail-soft (a read error = none)."""
    try:
        today = _now_local().date()
        max_advance = int(settings.get("max_advance_days", 60))
        pause = rsvc.pause_covering(settings, today)
        return {
            "closures": [
                {k: c[k] for k in ("from", "to", "note", "kind")}
                for c in rsvc.closures_between(settings, today, today + timedelta(days=max_advance))
            ],
            "paused_until": pause["to"] if pause else None,
        }
    except Exception:  # noqa: BLE001 — context, never a 500 for the page
        logger.warning("public closures read failed", exc_info=True)
        return {"closures": [], "paused_until": None}


def _closure_for(settings: dict, day) -> dict | None:
    """The owner's closure on `day` ({note, kind}), fail-open: a read error
    means "not closed" — the hours and the engine still decide."""
    try:
        c = rsvc.closure_on(settings, day)
    except Exception:  # noqa: BLE001
        logger.warning("closure read failed", exc_info=True)
        return None
    return {"note": c["note"], "kind": c["kind"]} if c else None


def _safe_identity(owner: User, profile: BusinessProfile, settings: dict):
    """(name, contact) from venue_identity, fail-closed: a read error gives a
    nameless venue with no address, city or phone — never the raw (possibly
    seeded) values and never a 500 for the whole page. The page still loads
    with "Book et bord" and its times."""
    try:
        return (venue_identity.public_venue_name(owner, profile),
                venue_identity.public_venue_contact(owner, profile, settings))
    except Exception:  # noqa: BLE001 — identity is context, never a 500
        logger.warning("public identity failed for owner %s", getattr(owner, "id", None), exc_info=True)
        return None, {"address": None, "city": None, "phone": None}


def _safe_week(db: Session, owner: User, profile: BusinessProfile, settings: dict):
    """rsvc.public_week, fail-soft: a read error gives NO claim (None), never
    "closed all week" and never a 500 for the whole page."""
    try:
        return rsvc.public_week(profile, settings, rsvc.active_resources(db, owner.id))
    except Exception:  # noqa: BLE001 — the hours list is context, never a 500
        logger.warning("public hours failed for owner %s", getattr(owner, "id", None), exc_info=True)
        return None


@router.get("/{slug}/availability")
@_limiter.limit("60/minute")
def availability(request: Request, slug: str = Path(...),
                 day: str = Query(...), party: int = Query(ge=1, le=100),
                 db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)
    try:
        target = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})

    settings = rsvc.load_settings(profile)
    # Don't offer dates beyond the advance window or in the past.
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    if target < today or target > today + timedelta(days=max_advance):
        return {"date": day, "party_size": party, "slots": [], "group_request": False,
                "reason": rsvc.window_reason(target, today, max_advance)}

    # At the monthly ceiling the answer is "closed", not a list of times the
    # create endpoint is about to refuse. `closed_reason` is additive — an
    # older client sees an empty `slots` array and renders its normal
    # no-availability state, which is already the honest outcome. `reason`
    # (additive, only when `slots` is empty) speaks the day-strip vocabulary.
    # R1b: when the cap takes requests (_cap_closes_page), the page stays
    # open and nothing here changes — the booking itself waits for the owner.
    if _cap_closes_page(db, owner):
        return {"date": day, "party_size": party, "slots": [],
                "group_request": False, "closed_reason": "not_accepting",
                "reason": "not_accepting"}

    # A date the owner closed for online booking (a holiday, a pause).
    closure = _closure_for(settings, target)
    if closure:
        return {"date": day, "party_size": party, "slots": [], "slot_remaining": {},
                "group_request": rsvc.is_group_request(settings, party),
                "reason": "closed_date", "closure": closure}

    group_request = rsvc.is_group_request(settings, party)
    if group_request:
        # A group REQUEST holds no table until the owner approves it, so table
        # capacity is not the question. Offer the venue's normal time grid for
        # the day (same opening hours / interval / lead time) as PREFERRED
        # times. Before this, "no table seats 12" returned no slots at all and
        # the page stored an invented time as the booking time. No scarcity
        # hint: nothing is being held.
        grid = rsvc.group_request_slots(
            db, profile=profile, user_id=owner.id, day=target,
            party_size=party, now=_now_local(),
        )
        body = {
            "date": day,
            "party_size": party,
            "group_request": True,
            "slots": [s.strftime("%H:%M") for s in grid],
            "slot_remaining": {},
        }
        if not grid:
            body["reason"] = rsvc.empty_day_reason(
                db, profile=profile, user_id=owner.id, day=target,
                party_size=party, now=_now_local(), settings=settings,
            )
        return body

    slots = rsvc.available_slots(
        db, profile=profile, user_id=owner.id, day=target,
        party_size=party, now=_now_local(),
    )
    # Per-slot scarcity, for the "2 left" / "Last table" hint. Additive: the
    # `slots` list is unchanged, so an older client ignores this and behaves
    # exactly as before. Computed from the same engine pass that decided
    # bookability, and it understates rather than overstates — a hint that
    # invents urgency would be a lie told to make someone book faster.
    remaining = rsvc.available_slot_details(
        db, profile=profile, user_id=owner.id, day=target,
        party_size=party, now=_now_local(),
    )
    body = {
        "date": day,
        "party_size": party,
        "group_request": group_request,
        "slots": [s.strftime("%H:%M") for s in slots],
        "slot_remaining": remaining,
    }
    # Only an empty day carries a reason; a day with times is byte-identical
    # to before. A failed classification reads "closed_or_full" (neutral).
    if not slots:
        body["reason"] = rsvc.empty_day_reason(
            db, profile=profile, user_id=owner.id, day=target,
            party_size=party, now=_now_local(), settings=settings,
        )
    return body


@router.get("/{slug}/availability-summary")
@_limiter.limit("60/minute")
def availability_summary(request: Request, slug: str = Path(...),
                         start: str = Query(..., alias="from"),
                         days: int = Query(14, ge=1, le=30),
                         party: int = Query(ge=1, le=100),
                         db: Session = Depends(get_db)):
    """Multi-day open/closed overview so the public page can render a date strip
    and AUTO-ADVANCE to the next open day (never dead-ends on a closed today).
    Uses the same slots the diner sees (via rsvc.summarize_days), so the strip
    can't disagree — for a group-request party that is the venue's time grid,
    so a day is open whenever the venue is. Shared with the public-surface
    monitor."""
    profile, owner = _resolve_owner(db, slug)
    try:
        base = datetime.strptime(start, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})
    # Same rule as /availability: at the ceiling every in-window day is closed,
    # and next_open_day is None so the date strip's auto-advance stops instead
    # of walking the whole horizon looking for an evening that cannot exist.
    # The top-level `closed_reason` (the name /availability already uses) lets
    # the page show one "paused" panel instead of a strip of dead days.
    if _cap_closes_page(db, owner):
        return {
            "from": base.isoformat(), "party_size": party, "next_open_day": None,
            "closed_reason": "not_accepting",
            "days": [
                {"date": (base + timedelta(days=i)).isoformat(),
                 "has_slots": False, "reason": "not_accepting"}
                for i in range(days)
            ],
        }

    # A salon whose chairs are set up but which offers no service: a guest
    # must pick a behandling before any time, so NO day can be booked. The
    # strip said days were open (counting a hidden 60-minute default) and
    # the owner believed the page worked (settings audit, 24 Oct 2026).
    if _provider_only_without_service(db, owner.id):
        settings = rsvc.load_settings(profile)
        today = _now_local().date()
        max_advance = int(settings.get("max_advance_days", 60))
        out_days = []
        for i in range(days):
            d = base + timedelta(days=i)
            outside = rsvc.window_reason(d, today, max_advance)
            out_days.append({"date": d.isoformat(), "has_slots": False,
                             "reason": outside or "no_times"})
        return {"from": base.isoformat(), "party_size": party, "next_open_day": None,
                "group_request": False, "closed_reason": "no_service", "days": out_days}

    summary = rsvc.summarize_days(
        db, profile=profile, user_id=owner.id, start_date=base,
        days=days, party_size=party, now=_now_local(),
    )
    return {"from": base.isoformat(), "party_size": party, **summary}


def _provider_only_without_service(db: Session, user_id) -> bool:
    """Active chairs, no active table, and no active behandling. Fail-soft:
    a read error answers False (the normal summary runs)."""
    try:
        kinds = {k for (k,) in (
            db.query(BookableResource.kind)
            .filter(BookableResource.user_id == user_id,
                    BookableResource.is_active.is_(True),
                    BookableResource.is_deleted.is_(False))
            .distinct()
            .all()
        )}
        if kinds != {"provider"}:
            return False
        return (
            db.query(Behandling.id)
            .filter(Behandling.user_id == user_id, Behandling.active.is_(True))
            .first()
        ) is None
    except Exception:  # noqa: BLE001
        logger.warning("no-service check failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False


@router.get("/{slug}/floor")
@_limiter.limit("30/minute")
def floor(request: Request, slug: str = Path(...),
          day: str = Query(...), party: int = Query(ge=1, le=100),
          at: str = Query(..., description="HH:MM — the chosen slot"),
          db: Session = Depends(get_db)):
    """Public floor map for a specific slot: each active table's position +
    free/taken status for this party at this time. LAYOUT-ONLY — no guest data,
    no booking ids (see reservation_service.public_floor). Lets the booker pick
    a real table on the same 2D room the owner arranges."""
    profile, owner = _resolve_owner(db, slug)
    try:
        start = datetime.strptime(f"{day} {at}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_datetime"})

    settings = rsvc.load_settings(profile)
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    empty = {"date": day, "time": at, "party_size": party, "tables": [],
             "tables_total": 0, "seats_total": 0, "free_total": 0}
    if start.date() < today or start.date() > today + timedelta(days=max_advance):
        return empty
    closure = _closure_for(settings, start.date())
    if closure:
        return {**empty, "reason": "closed_date", "closure": closure}

    tables = rsvc.public_floor(
        db, profile=profile, user_id=owner.id, start=start,
        party_size=party, now=_now_local(),
    )
    return {
        "date": day, "time": at, "party_size": party,
        "tables": tables,
        "tables_total": len(tables),
        "seats_total": sum(t["capacity_seats"] for t in tables),
        "free_total": sum(1 for t in tables if t["status"] == "free"),
    }


def _has_active_provider(db: Session, user_id) -> bool:
    """Does this venue run any active provider (kind='provider') resource?
    Used to return [] / empty availability for a non-salon venue rather than
    leaking that it's a restaurant."""
    return (
        db.query(BookableResource.id)
        .filter(
            BookableResource.user_id == user_id,
            BookableResource.kind == "provider",
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
        )
        .first()
    ) is not None


@router.get("/{slug}/behandlinger")
@_limiter.limit("60/minute")
def public_behandlinger(request: Request, slug: str = Path(...),
                        db: Session = Depends(get_db)):
    """Active behandlinger (salon services) for this venue's booking page.

    PII-safe (catalog data only). For a NON-provider venue (no provider
    resource — i.e. a restaurant) we return [] rather than leak that it isn't a
    salon. price_kr is DISPLAY-ONLY — it never charges money / feeds MOMS.
    Same slug→owner resolution, 410-when-off, and rate-limit guards as the
    other public endpoints."""
    profile, owner = _resolve_owner(db, slug)
    if not _has_active_provider(db, owner.id):
        return {"behandlinger": []}
    rows = (
        db.query(Behandling)
        .filter(Behandling.user_id == owner.id, Behandling.active.is_(True))
        .order_by(Behandling.sort_order, Behandling.name)
        .all()
    )
    return {
        "behandlinger": [
            {
                "id": str(b.id),
                "name": b.name,
                "duration_min": b.duration_min,
                "price_kr": b.price_kr,
            }
            for b in rows
        ]
    }


@router.get("/{slug}/provider-availability")
@_limiter.limit("60/minute")
def provider_availability(request: Request, slug: str = Path(...),
                          day: str = Query(...),
                          behandling_id: str = Query(...),
                          stylist_id: str | None = Query(default=None),
                          db: Session = Depends(get_db)):
    """Bookable appointment slots for a salon, by behandling (+ optional
    stylist). SIBLING of /availability — the table availability path is left
    completely untouched; a salon page calls THIS instead.

    The slot length is resolved SERVER-SIDE from the behandlinger catalog
    (rsvc.resolve_behandling_duration) — never from the client. Availability is
    100% published-shift-driven (rsvc.available_provider_slots → provider_
    windows → published Schedule rows): a provider with no published shift that
    day yields no slots. PII-safe — returns only start times + resource/staff
    ids + duration, no guest data.

    Same advance-window / past-date guard as the table availability endpoint."""
    profile, owner = _resolve_owner(db, slug)
    try:
        target = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})

    settings = rsvc.load_settings(profile)
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    duration = rsvc.resolve_behandling_duration(db, owner.id, behandling_id)
    empty = {"date": day, "behandling_id": behandling_id,
             "duration_min": duration, "slots": []}
    if target < today or target > today + timedelta(days=max_advance):
        return {**empty, "reason": rsvc.window_reason(target, today, max_advance)}
    # The monthly ceiling, as on the table path: a capped salon was still
    # offered times here, and the create endpoint then refused the booking
    # (409) after the guest had typed their details. Under the cap nothing
    # changes, and a billing error fails open (_at_month_cap).
    if _cap_closes_page(db, owner):
        return {**empty, "closed_reason": "not_accepting", "reason": "not_accepting"}
    closure = _closure_for(settings, target)
    if closure:
        return {**empty, "reason": "closed_date", "closure": closure}

    slots = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=target,
        duration_min=duration, stylist_resource_id=stylist_id or None,
        now=_now_local(),
    )
    return {
        "date": day,
        "behandling_id": behandling_id,
        "duration_min": duration,
        "slots": slots,
    }


# ── Booking email (services/reservation_emails.py owns every template) ──────
# The names below are kept as thin aliases/wrappers: the jobs and the tests
# reach them here, and the wiring reads better at the call sites.

# Booking-lifetime signed self-cancel link for guest messages.
_guest_cancel_url = reservation_emails.guest_cancel_url

# Confirmations one venue may send to one address per day — see
# reservation_emails.confirmation_quota_left for why this bound exists.
_CONFIRMATIONS_PER_ADDRESS_PER_DAY = reservation_emails.CONFIRMATIONS_PER_ADDRESS_PER_DAY
_confirmation_quota_left = reservation_emails.confirmation_quota_left


def _send_confirmation(owner: User, profile: BusinessProfile, r: Reservation,
                       db: Session | None = None, *, held: bool = False) -> bool:
    """Guest confirmation ("request received" for a group request), in the
    guest's language. Never blocks the booking; returns True only when the
    email was delivered, and only then stamps confirmation_sent_at — the
    per-address cap counts those stamps, so a failed send must not claim one.
    `held`: a person-like HELD booking's "request received" (the per-address
    cap gives it reservation_emails.held_request_extra() more)."""
    try:
        return reservation_emails.send_guest_confirmation(db, owner, profile, r, held=held)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("reservation confirmation email failed: %s", type(exc).__name__)
        return False


def _notify_owner_email(owner: User, profile: BusinessProfile, r: Reservation,
                        db: Session | None = None, *, hold_reason: str | None = None) -> bool:
    """Owner email for a new online booking, in the owner's language — the
    dependable companion to the device push (which only lands when the owner
    enabled notifications). Carries the guest's contact so the owner can call
    back; replying goes to the guest. Never blocks the booking.
    `hold_reason` "plan_cap" (R1b): the plan's monthly cap is reached — the
    mail says so and how to lift it (the upgrade nudge)."""
    try:
        plan_cap = None
        if hold_reason == "plan_cap":
            plan_cap = booking_screen.monthly_cap(owner)
        return reservation_emails.send_owner_new_booking(db, owner, profile, r, plan_cap=plan_cap)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("owner reservation email failed: %s", type(exc).__name__)
        return False


def _load_for_notify(db: Session, reservation_id: str, owner_id: str):
    r = (
        db.query(Reservation)
        .filter(Reservation.id == reservation_id, Reservation.user_id == owner_id)
        .first()
    )
    owner = db.query(User).filter(User.id == owner_id).first()
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == owner_id)
        .first()
    )
    return r, owner, profile


def _send_booking_notifications(reservation_id: str, owner_id: str,
                                hold_reason: str | None = None,
                                held_mail_ok: bool | None = None) -> None:
    """Run the post-booking notifications (guest confirmation email, owner push,
    owner email) OFF the request path, on a FRESH DB session.

    Why a fresh session + re-fetch by id: FastAPI tears down the request's
    ``get_db`` session once the response is sent, and SQLAlchemy expires the ORM
    objects on commit — so the request's ``r``/``owner``/``profile`` can't be
    reused here. Reloading by id is cheap and correct.

    This is the scale win: a slow email/push provider (≈0.3–2s of network I/O,
    plus one retry on failure) no longer holds a pooled DB connection or delays
    the guest's response — the booking commits and returns in milliseconds, and
    this runs after. Each send is individually best-effort; one failing never
    affects the booking or the others. Committed after each step so a later
    failure cannot roll back an earlier send's stamp or log row.

    `hold_reason` — the booking screen HELD it (booking_screen):
      • BOT_REASONS (a bot's form): no "request received" mail to the typed
        address, no owner ping of its own, and no summary starts because of
        it — the next summary, or the morning one, counts it;
      • other held bookings: the mail, within the venue's small held-mail
        budget — `held_mail_ok` is the claim the request path already made
        (so the page could say whether a mail is coming; None: claim here) —
        and the normal ping budget (requests_full: the summary only)."""
    db = SessionLocal()
    try:
        r, owner, profile = _load_for_notify(db, reservation_id, owner_id)
        if r is None or owner is None or profile is None:
            return
        # 1. The guest.
        if hold_reason is None:
            _send_confirmation(owner, profile, r, db)       # guest email (+ stamp on delivery)
        elif hold_reason in booking_screen.NO_GUEST_MAIL:
            reservation_emails._log(db, owner_id=owner.id, reservation_id=r.id,
                                    event_type=reservation_emails.GUEST_CONFIRMATION,
                                    status="failed", error="held_no_mail")
        elif (held_mail_ok if held_mail_ok is not None
              else owner_booking_alerts.claim_held_guest_mail(db, owner.id, now_utc=utc_now())):
            _send_confirmation(owner, profile, r, db, held=True)
        else:
            reservation_emails._log(db, owner_id=owner.id, reservation_id=r.id,
                                    event_type=reservation_emails.GUEST_CONFIRMATION,
                                    status="failed", error="held_mail_capped")
        db.commit()
        # 2. The owner — the ping budget (owner_booking_alerts): a few an hour,
        #    then one summary an hour; a flood never floods the phone.
        if hold_reason in booking_screen.BOT_REASONS:
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_created", why=owner_booking_alerts.HELD_BOT)
            return
        if hold_reason in booking_screen.SUMMARY_ONLY:
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_created", why=owner_booking_alerts.HELD_FOR_SUMMARY)
            return
        # R1b (D3): at night (22–07) only a booking that starts within
        # OWNER_NIGHT_PING_WITHIN_HOURS pings; the rest waits for the 07:00
        # summary (owner_booking_alerts.waits_for_morning; off unless the
        # volume switch or OWNER_NIGHT_QUIET says so).
        if owner_booking_alerts.waits_for_morning(r.starts_at, now_utc=utc_now()):
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_created", why=owner_booking_alerts.QUIET_NIGHT)
            return
        held = hold_reason is not None
        ping = owner_booking_alerts.decide(db, owner.id, now_utc=utc_now(),
                                           event="reservation_created", held=held)
        if ping.decision == "send":
            try:
                from app.services.notification_service import notify_owner_new_reservation
                notify_owner_new_reservation(db, owner, r)  # owner device push
            except Exception as exc:  # noqa: BLE001
                logger.warning("owner reservation notify failed: %s", exc)
            _notify_owner_email(owner, profile, r, db, hold_reason=hold_reason)  # owner email
        elif ping.decision == "burst":
            owner_booking_alerts.send_summary(db, owner, profile, ping,
                                              today=_now_local().date().isoformat())
        else:
            # Over the budget: held back; the next summary counts it (a held
            # booking's waits for the morning in the quiet hours).
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_created",
                why=(owner_booking_alerts.HELD_OVER_BUDGET if held
                     else owner_booking_alerts.OVER_BUDGET))
        db.commit()
    except Exception:  # noqa: BLE001 — never let a notification break anything
        logger.exception("booking notifications task failed")
        db.rollback()
    finally:
        db.close()


def _send_guest_cancel_notifications(reservation_id: str, owner_id: str,
                                     was_request: bool = False) -> None:
    """After a guest cancels online: tell the guest it worked, email the owner,
    and ping the owner's devices (freed-table nudge when a waiting party fits).

    Same shape as _send_booking_notifications — OFF the request path, fresh
    session, every step best-effort: a notification failure must never turn a
    successful self-cancel into an error for the guest."""
    db = SessionLocal()
    try:
        r, owner, profile = _load_for_notify(db, reservation_id, owner_id)
        if r is None or owner is None:
            return
        # 1. Guest — "your booking is cancelled" (only to a guest we already
        #    mailed about this booking; see send_guest_cancelled_by_guest).
        try:
            reservation_emails.send_guest_cancelled_by_guest(
                db, owner, profile, r, was_request=was_request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("guest cancel email failed: %s", type(exc).__name__)
        db.commit()

        # A booking the screen HELD and nobody approved (R1a). A bot-like
        # hold withdrawn with its own booking token pings no one: the owner
        # was never told about it, and a robot that posts and withdraws every
        # hour buzzed the owner every hour, night included (fix-2 verify S4). A person-like hold's
        # withdrawal waits for the morning in the quiet hours once the hour's
        # budget is spent — like its booking did.
        hold_reason = None
        # Only while it was still a REQUEST: a held booking the owner approved
        # is a normal booking from then on — its cancellation tells the owner
        # and nudges the waitlist like any other (R1a verify S1: an approved
        # robot-like hold cancelled later pinged no one).
        if was_request and r.status == "cancelled" and r.source == "public":
            hold_reason = (booking_screen.held_info(db, owner.id, [r.id])
                           .get(str(r.id), {}).get("reason"))
        if hold_reason in booking_screen.BOT_REASONS:
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_cancelled", why=owner_booking_alerts.HELD_BOT)
            db.commit()
            return
        # R1b (D3): at night a cancellation pings only when its booking
        # starts within OWNER_NIGHT_PING_WITHIN_HOURS — the table freed for
        # tonight or tomorrow's breakfast; the rest is in the 07:00 summary.
        if owner_booking_alerts.waits_for_morning(r.starts_at, now_utc=utc_now()):
            owner_booking_alerts.log_suppressed(
                db, owner.id, "reservation_cancelled", why=owner_booking_alerts.QUIET_NIGHT)
            db.commit()
            return

        # The owner's ping budget, shared with new bookings: a few an hour,
        # then one summary an hour, then nothing until the hour turns.
        held = hold_reason is not None
        ping = owner_booking_alerts.decide(db, owner.id, now_utc=utc_now(),
                                           event="reservation_cancelled", held=held)
        if ping.decision != "send":
            if ping.decision == "burst":
                owner_booking_alerts.send_summary(db, owner, profile, ping,
                                                  today=_now_local().date().isoformat())
            else:
                owner_booking_alerts.log_suppressed(
                    db, owner.id, "reservation_cancelled",
                    why=(owner_booking_alerts.HELD_OVER_BUDGET if held
                         else owner_booking_alerts.OVER_BUDGET))
            db.commit()
            return

        # 2. Owner devices. Prefer the freed-table nudge when a waiting party
        #    actually FITS the just-freed table: one owner push ("Bord frigivet
        #    — Navn (N) passer") deep-linking into the Venteliste so the host
        #    stand can re-offer the seat. Push ONLY — no waiting guest is
        #    messaged here. If no waiting party fits, fall back to the plain
        #    cancel ping (create-path template, cancelled=True).
        try:
            from app.routers.reservations import _waitlist_matches, _local_date_of
            from app.services.sms_service import sms_configured
            matches = []
            try:
                matches = _waitlist_matches(
                    db, owner,
                    waitlist_date=_local_date_of(r.starts_at, owner),
                    capacity=int(r.party_size or 0),
                )
            except Exception:  # noqa: BLE001
                matches = []
            if matches:
                from app.services.notification_service import notify_owner_freed_table
                notify_owner_freed_table(
                    db, owner, r, matches[0],
                    sms_available=(has_feature(owner, "sms_reminders") and sms_configured()),
                )
            else:
                from app.services.notification_service import notify_owner_new_reservation
                notify_owner_new_reservation(db, owner, r, cancelled=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner reservation cancel notify failed: %s", exc)

        # 3. Owner email — the one that lands even without push enabled.
        try:
            reservation_emails.send_owner_guest_cancelled(
                db, owner, profile, r, was_request=was_request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner cancel email failed: %s", type(exc).__name__)
        db.commit()
    except Exception:  # noqa: BLE001 — never let a notification break anything
        logger.exception("guest cancel notifications task failed")
        db.rollback()
    finally:
        db.close()


def _create_public_provider_booking(db: Session, owner: User, profile, payload,
                                    start, settings, idempotency_key,
                                    background_tasks: BackgroundTasks | None = None,
                                    hold_reason: str | None = None):
    """Public SALON booking (S3a) — books a PROVIDER for a behandling.

    In its own function so create_reservation's table flow is untouched.
    Honesty gates:
      • duration + service_name resolved SERVER-SIDE from the owner's
        behandlinger catalog (rsvc.resolve_behandling_duration) — the client
        cannot dictate the slot length.
      • a pinned stylist FAILS CLOSED: rsvc.recheck_provider_slot returns None
        if that exact stylist isn't free in a published shift → 409, never a
        silent reassign to a different stylist.
      • "valgfri behandler" (no stylist_id) auto-assigns among free providers
        via recheck_and_assign_combo.
    Reuses the same occupancy insert-and-catch + post-commit notifications as
    the table path.

    `hold_reason` (booking_screen said "hold"): the chair is resolved exactly
    as above, but the booking is stored as a REQUEST on NO chair — it holds
    nothing until the owner approves it. The chair (and whether the guest
    chose that stylist) goes on the held_public audit row; approving assigns
    it (reservations.update_status)."""
    duration = rsvc.resolve_behandling_duration(db, owner.id, payload.behandling_id)
    service_name = None
    if payload.behandling_id:
        b = (
            db.query(Behandling)
            .filter(Behandling.id == payload.behandling_id,
                    Behandling.user_id == owner.id, Behandling.active.is_(True))
            .first()
        )
        if b is None:
            # Unknown / inactive / foreign behandling — don't book on a guess.
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        service_name = b.name

    if payload.stylist_id:
        # Named stylist → that exact provider, free, in a published shift, or
        # FAIL CLOSED (409). Never reassign to someone else.
        picked = rsvc.recheck_provider_slot(
            db, profile=profile, user_id=owner.id, resource_id=payload.stylist_id,
            start=start, duration_min=duration, now=_now_local(),
        )
        if picked is None:
            raise HTTPException(status_code=409, detail={"error": "stylist_unavailable"})
        resource_ids = [picked]
        reassign = False
    else:
        # Valgfri behandler → auto-assign among free providers.
        resource_ids = rsvc.recheck_and_assign_combo(
            db, profile=profile, user_id=owner.id, start=start,
            party_size=1, now=_now_local(), duration_min=duration,
        )
        if not resource_ids:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        reassign = True

    btype = getattr(owner, "business_type", None) or "restaurant"
    r = Reservation(
        user_id=owner.id,
        guest_name=payload.guest_name, guest_email=payload.guest_email,
        guest_phone=payload.guest_phone,
        guest_consent_marketing=payload.consent_marketing,
        guest_lang=payload.lang,
        party_size=1,
        starts_at=start, ends_at=start + timedelta(minutes=duration),
        duration_min=duration, service_name=service_name,
        status="requested" if hold_reason else "confirmed", source="public",
        occasion=payload.occasion, guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        # A shop or a workshop asks no allergies (allergens.collects_allergies):
        # a note or a severity sent anyway is health data with no purpose.
        allergy_note=payload.allergy_note if collects_allergies(btype) else None,
        allergy_severity=(sanitize_severity(payload.allergy_severity)
                          if collects_allergies(btype) else None),
        idempotency_key=idempotency_key,
        purge_after=start + timedelta(days=int(settings.get("retention_days", 90))),
    )
    # Rule-based AI signals — unconfirmed allergy suggestion + note intent.
    # Fail-soft; NEVER overwrites the confirmed allergen fields set above.
    from app.services.reservation_ai import apply_ai_signals
    apply_ai_signals(r, btype)
    if hold_reason:
        # Held for the owner's OK: no chair, no occupancy — a request like a
        # group request, so nothing (the boot backfill, an owner edit)
        # mistakes it for a hold. The chosen chair waits on the audit row.
        db.add(r)
        db.flush()
    else:
        try:
            occ_service.create_reservation_with_occupancy(
                db, profile=profile, reservation=r, initial_resource_ids=resource_ids,
                party_size=1, start=start, duration_min=duration, now=_now_local(),
                reassign=reassign,
            )
        except occ_service.SlotUnavailable:
            # Pinned-stylist race loss surfaces as the stylist-specific 409 (still
            # fail-closed — reassign=False never re-picked another provider).
            err = "stylist_unavailable" if payload.stylist_id else "slot_unavailable"
            raise HTTPException(status_code=409, detail={"error": err})

    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    if hold_reason:
        audit_service.record(db, owner, booking_screen.HELD_ACTION, "reservation", r.id,
                             after=booking_screen.held_after(
                                 hold_reason, resource_ids, pinned=bool(payload.stylist_id)))
    # D-D: a page that sent no fill time — one countable row, no personal data.
    booking_screen.record_no_fill_time(db, owner, payload, r.id)
    db.commit()
    guest_mail, held_mail_ok = _guest_mail_plan(db, owner, r, hold_reason)
    # Same post-commit notifications as the table path, OFF the request path
    # (guest confirmation + owner push + owner email). They used to run inline
    # here, holding the guest's response for every provider round trip.
    if background_tasks is not None:
        background_tasks.add_task(_send_booking_notifications, str(r.id), str(owner.id),
                                  hold_reason, held_mail_ok)
    else:  # direct callers without a request — still best-effort, never raises
        _send_booking_notifications(str(r.id), str(owner.id), hold_reason, held_mail_ok)
    return {"id": str(r.id), "status": r.status, "booking_token": _receipt_token(r),
            "guest_mail": guest_mail,
            # The appointment's real length, for the receipt's calendar file
            # (R2, rubric V5: it said 120 min for every booking).
            "duration_min": r.duration_min}


@router.post("/{slug}")
@_limiter.limit("6/minute")
def create_reservation(request: Request, background_tasks: BackgroundTasks,
                       slug: str = Path(...),
                       payload: PublicReservationCreate = Body(...),
                       # Bounded at the edge: the column is VARCHAR(80), so an
                       # oversized header from an anonymous caller reached the DB
                       # and raised — a guaranteed unauthenticated 500. 422 here
                       # instead, before any query runs.
                       idempotency_key: str | None = Header(default=None, alias="X-Idempotency-Key", max_length=80),
                       db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)

    # Idempotency — same key returns the same reservation. MUST be scoped to
    # this owner: idempotency_key is client-supplied and NOT globally unique, so
    # a colliding key from another restaurant would otherwise leak that tenant's
    # reservation + a valid booking_token back to this visitor.
    if idempotency_key:
        prior = (
            db.query(Reservation)
            .filter(Reservation.user_id == owner.id,
                    Reservation.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            return {"id": str(prior.id), "status": prior.status,
                    "booking_token": _receipt_token(prior),
                    "duration_min": prior.duration_min}

    # Parse requested datetime (naive local).
    try:
        start = datetime.strptime(f"{payload.day} {payload.time}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_datetime"})

    settings = rsvc.load_settings(profile)
    # Date-window guard on BOTH paths. The confirmed path is also gated by
    # recheck_and_assign_combo, but the group-request branch below skips it —
    # without this, a crafted past/far-future date would insert a row and
    # pollute the owner's monthly cap counter. Same window the /availability +
    # /floor endpoints already enforce.
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    if start.date() < today or start.date() > today + timedelta(days=max_advance):
        raise HTTPException(status_code=422, detail={"error": "date_out_of_range"})
    max_party = rsvc.online_party_ceiling(settings)
    if max_party is not None and payload.party_size > max_party:
        raise HTTPException(status_code=409, detail={"error": "party_too_large"})

    # L7 — owner's monthly cap → generic 409 (no tier leak to the visitor).
    # Counting semantics live in _month_reservations_used; read that comment
    # before changing anything here.
    # R1b: when the cap takes requests (booking_screen.plan_cap_requests_on),
    # the booking goes in as a request on no table (plan_cap) instead — the
    # guest reads "Forespørgsel modtaget", the owner decides and is nudged to
    # upgrade. A group request is a request already. Never a tier word to the
    # guest either way.
    at_plan_cap = _at_month_cap(db, owner)
    if at_plan_cap and not booking_screen.plan_cap_requests_on():
        raise HTTPException(status_code=409, detail={"error": "not_accepting"})

    # A date the owner closed for online booking (Lukkedage og pauser) — on
    # every path: a table, a group request, a salon time. The owner's own
    # bookings (POST /reservations/book) never come through here.
    if _closure_for(settings, start.date()) is not None:
        raise HTTPException(status_code=409, detail={"error": "date_closed"})

    # A contact the owner BLOCKED (R2, services/contact_marks.py — a keyed
    # hash of the phone or mailbox, never the number itself): refused with
    # the venue's generic answer, the same 409 a capped page gives — the
    # page says the venue is not taking online bookings and offers the phone.
    # Never "you are blocked". No row and no audit row: a blocked script
    # posting all night must not fill the audit table; the abuse monitor
    # counts it. A contact merely marked as SPAM goes on to the screen and is
    # held quietly there (rule 3b).
    if _contact_blocked(owner, settings, payload, today):
        abuse_signals.bump("booking_blocked")
        raise HTTPException(status_code=409, detail={"error": "not_accepting"})

    salon = bool(payload.behandling_id or payload.stylist_id)
    is_request = (not salon) and rsvc.is_group_request(settings, payload.party_size)

    # One anonymous create at a time per venue, from the screen's counts to
    # the booking's commit (services/venue_lock.py): twelve posts at the same
    # instant all read "under the ceiling" and all went through (security
    # review, atk_b_race). Only fast database work happens under it.
    with venue_lock(db, f"bb-create:{owner.id}"):
        return _screen_and_book(
            db, background_tasks, owner=owner, profile=profile, payload=payload,
            start=start, settings=settings, idempotency_key=idempotency_key,
            salon=salon, is_request=is_request, at_plan_cap=at_plan_cap,
        )


def _contact_blocked(owner: User, settings: dict, payload, today) -> bool:
    """Is the booking's phone or mailbox on the owner's block list? Fail-open:
    a broken read never refuses a guest."""
    try:
        from app.services import contact_marks
        entries = settings.get(contact_marks.KEY)
        if not entries:
            return False
        return contact_marks.match(entries, owner.id, email=payload.guest_email,
                                   phone=payload.guest_phone, today=today) == "block"
    except Exception:  # noqa: BLE001
        logger.warning("contact block check failed — not refusing", exc_info=True)
        return False


def _screen_and_book(db: Session, background_tasks: BackgroundTasks, *, owner: User,
                     profile: BusinessProfile, payload, start: datetime, settings: dict,
                     idempotency_key, salon: bool, is_request: bool,
                     at_plan_cap: bool = False):
    """The screen and the write, under the venue lock (create_reservation).
    `at_plan_cap`: the plan's monthly cap is reached and it takes requests
    (R1b) — the screen holds the booking as plan_cap."""
    try:
        sitting_min = (rsvc.resolve_behandling_duration(db, owner.id, payload.behandling_id)
                       if salon else rsvc.resolve_duration(profile, payload.party_size))
    except Exception:  # noqa: BLE001 — the sitting rule just skips
        sitting_min = None
    n_tables, n_chairs = _resource_counts(db, owner.id)

    # Guest-invisible screening (services/booking_screen.py), on the text as
    # it was typed (a link in the name is one of its signals).
    screen = booking_screen.screen_public_booking(
        db, owner=owner, settings=settings, payload=payload, is_request=is_request,
        n_resources=n_tables + n_chairs, now_utc=utc_now(),
        now_local=_now_local(), start=start, duration_min=sitting_min, chairs=salon,
        profile=profile, n_tables=n_tables, n_chairs=n_chairs, at_plan_cap=at_plan_cap,
    )
    if screen.action == "drop":
        # The trap field, filled at bot speed. No row, no message — and never
        # a "confirmed" for a booking that does not exist: the page says
        # "request received" at most.
        audit_service.record(db, owner, "reservation.public_dropped", "business_profile",
                             profile.id, after={"reason": screen.reason})
        db.commit()
        abuse_signals.bump("booking_honeypot")
        return {"id": str(uuid4()), "status": "requested", "booking_token": "",
                "guest_mail": False}
    hold_reason = screen.reason if screen.action == "hold" else None

    # What the guest typed — name, notes, allergy note, occasion — is stored
    # EXACTLY as typed, as on live: the kitchen and the AI allergy reading
    # read the guest's own words. (R1 replaced anything link-like with
    # "[link]" here, and "Glutenfri.Laktosefri.Nøddeallergi" lost the
    # allergy — R1a fix round, 24 Oct.) A link is made harmless where the
    # text is SHOWN instead: reservation_emails passes every guest-typed
    # value through utils.text.defang_links, and the owner's screens do the
    # same (frontend/src/utils/guestText.js).

    # Salon appointment (S3a) — a behandling and/or a pinned stylist routes to
    # the provider path, handled separately so the table booking flow below is
    # byte-identical. A plain table booking carries neither field.
    if salon:
        return _create_public_provider_booking(
            db, owner, profile, payload, start, settings, idempotency_key,
            background_tasks, hold_reason=hold_reason,
        )

    duration = rsvc.resolve_duration(profile, payload.party_size)

    resource_ids = None
    if is_request:
        # A REQUEST still has to be for a time the venue is open and that
        # hasn't passed. It skipped every hours check, so a party of 10 could
        # ask for a closed Monday — or for 18:00 on a day already over, which
        # the page then promised to answer "inden dagen".
        windows = rsvc.restaurant_windows(profile, start.date(), settings)
        if start <= _now_local() or not any(w.start <= start < w.end for w in windows):
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
    if not is_request:
        # ALWAYS gate the slot through the engine FIRST. recheck_and_assign_combo
        # is the only path that consults the operating-window, pacing, and
        # lead-time guards (+ "is any table actually free"), and it returns the
        # table set it would auto-assign — or None if the slot isn't bookable.
        # Running it unconditionally is what stops a crafted `at` / picked
        # `resource_id` from booking outside hours, past a pacing cap, or inside
        # the lead-time window: public_floor() alone only knows busy-overlap +
        # seat-count, so honoring a pick must NEVER skip this gate.
        resource_ids = rsvc.recheck_and_assign_combo(
            db, profile=profile, user_id=owner.id, start=start,
            party_size=payload.party_size, now=_now_local(),
        )
        if not resource_ids:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        # The slot is bookable. Honor the table the guest tapped on the floor
        # map ONLY if it's genuinely free for this party at this time; a stale,
        # taken, too-small, or foreign id silently keeps the engine's pick (the
        # DB exclusion constraint is the real race backstop either way).
        if payload.resource_id:
            floor_now = rsvc.public_floor(
                db, profile=profile, user_id=owner.id, start=start,
                party_size=payload.party_size, now=_now_local(),
            )
            if any(t["id"] == payload.resource_id and t["status"] == "free"
                   for t in floor_now):
                resource_ids = [payload.resource_id]

    btype = getattr(owner, "business_type", None) or "restaurant"
    # A HELD booking is a request on NO table (resource_id NULL — the model's
    # "a request is pending, no hold yet"): the boot backfill of occupancy,
    # the owner's edit and the book's table lanes all read a table on a
    # request as a HOLD (review blocker, 24 Oct). The engine's pick waits on
    # the held_public audit row and is assigned when the owner approves.
    holds_table = bool(resource_ids) and not (is_request or hold_reason)
    r = Reservation(
        user_id=owner.id,
        resource_id=(resource_ids[0] if holds_table else None),
        guest_name=payload.guest_name, guest_email=payload.guest_email,
        guest_phone=payload.guest_phone,
        guest_consent_marketing=payload.consent_marketing,
        guest_lang=payload.lang,
        party_size=payload.party_size,
        starts_at=start, ends_at=start + timedelta(minutes=duration),
        duration_min=duration,
        status="requested" if (is_request or hold_reason) else "confirmed",
        source="public",
        occasion=payload.occasion, guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        # A shop or a workshop asks no allergies (allergens.collects_allergies):
        # a note or a severity sent anyway is health data with no purpose.
        allergy_note=payload.allergy_note if collects_allergies(btype) else None,
        allergy_severity=(sanitize_severity(payload.allergy_severity)
                          if collects_allergies(btype) else None),
        idempotency_key=idempotency_key,
        purge_after=start + timedelta(days=int(settings.get("retention_days", 90))),
    )
    # Rule-based AI signals — unconfirmed allergy suggestion + note intent.
    # Fail-soft; NEVER overwrites the confirmed allergen fields set above.
    from app.services.reservation_ai import apply_ai_signals
    apply_ai_signals(r, btype)

    if not holds_table:
        # Group request, or a HELD booking — does NOT hold a table (no
        # occupancy row) until the owner approves (→ confirmed assigns +
        # occupies). Plain insert.
        db.add(r)
        db.flush()
        db.commit()
    else:
        # Confirmed booking — insert reservation + an active occupancy row in
        # one transaction. On the Postgres exclusion violation (a concurrent
        # booking won this table) we rollback, re-assign another free table,
        # and retry; if none survive → 409 slot_unavailable. On SQLite the
        # constraint can't exist, so this is a plain commit + the app-level
        # recheck above is the only guard (local-dev caveat, by design).
        try:
            occ_service.create_reservation_with_occupancy(
                db, profile=profile, reservation=r, initial_resource_ids=resource_ids,
                party_size=payload.party_size, start=start, duration_min=duration,
                now=_now_local(),
            )
        except occ_service.SlotUnavailable:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

    # Audit commits durably WITH the booking (a cheap DB write — it stays on the
    # request path so the booking's audit trail is guaranteed before we respond).
    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    if hold_reason:
        audit_service.record(db, owner, booking_screen.HELD_ACTION, "reservation", r.id,
                             after=booking_screen.held_after(hold_reason, resource_ids))
    # D-D: a page that sent no fill time — one countable row, no personal
    # data (booking_screen.NO_FILL_TIME_ACTION). The booking itself is
    # handled exactly as on live.
    booking_screen.record_no_fill_time(db, owner, payload, r.id)
    db.commit()
    guest_mail, held_mail_ok = _guest_mail_plan(db, owner, r, hold_reason)
    # Notifications (guest confirmation email + owner push + owner email) run OFF
    # the request path on a fresh session, so a slow email/push provider no longer
    # holds the DB connection or delays the guest's response — the booking already
    # committed above. All best-effort inside the task.
    background_tasks.add_task(_send_booking_notifications, str(r.id), str(owner.id),
                              hold_reason, held_mail_ok)
    return {"id": str(r.id), "status": r.status, "booking_token": _receipt_token(r),
            "guest_mail": guest_mail,
            # The sitting's real length (the engine's turn time for this
            # party), for the receipt's calendar file (R2, rubric V5: the
            # .ics said 120 min while the engine held 90, 105 or 120).
            "duration_min": r.duration_min}


def _guest_mail_plan(db: Session, owner: User, r: Reservation,
                     hold_reason: str | None) -> tuple[bool, bool | None]:
    """(guest_mail, held_mail_ok) for a booking just committed.

    `guest_mail` tells the guest page whether an e-mail is coming, so the
    receipt never promises one that is not ("Vi svarer dig på {email}" over
    a held booking whose mail budget was spent — recheck, 24 Oct). It is
    read from every ceiling the send applies; the send itself still runs
    after the answer, best-effort.

    `held_mail_ok`: for a person-like HELD booking, the venue's held-mail
    budget is claimed HERE (under the create lock), and the background send
    uses that claim — None for every other booking. When another ceiling
    already says no, nothing is claimed and the send is left to log its own
    reason. A bot-like hold gets no mail and claims nothing. Fail-safe: an
    error promises no mail."""
    try:
        if not r.guest_email:
            return False, None
        if hold_reason in booking_screen.NO_GUEST_MAIL:
            return False, None
        if not reservation_emails.confirmation_will_send(db, owner.id, r.guest_email,
                                                         held=bool(hold_reason)):
            return False, (True if hold_reason else None)
        if hold_reason:
            ok = owner_booking_alerts.claim_held_guest_mail(db, owner.id, now_utc=utc_now())
            return ok, ok
        return True, None
    except Exception:  # noqa: BLE001 — never a 500 for the guest
        logger.warning("guest-mail plan failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False, (False if hold_reason else None)


def _resource_counts(db: Session, user_id) -> tuple[int, int]:
    """(tables, chairs) — the venue's size for the screen's ceilings (R1b:
    a chair's day is not a table's). One GROUP BY; a read error counts
    (0, 0) and the ceilings use their floors."""
    try:
        return booking_screen.resource_counts(db, user_id)
    except Exception:  # noqa: BLE001
        logger.warning("resource counts failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0, 0


def _bookable_count(db: Session, user_id) -> int:
    """Active tables and chairs — the venue's size for the screen's ceilings.
    One COUNT; a read error counts 0 (the ceilings then use their floors)."""
    try:
        return int(
            db.query(func.count(BookableResource.id))
            .filter(BookableResource.user_id == user_id,
                    BookableResource.is_active.is_(True),
                    BookableResource.is_deleted.is_(False))
            .scalar() or 0
        )
    except Exception:  # noqa: BLE001
        logger.warning("resource count failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0


def _verify(token: str | None, reservation_id: UUID, db: Session) -> Reservation:
    rid = verify_booking_token(token) if token else None
    if not rid or str(rid) != str(reservation_id):
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    r = db.query(Reservation).filter(Reservation.id == reservation_id,
                                     Reservation.is_deleted.is_(False)).first()
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return r


@router.get("/booking/{reservation_id}")
@_limiter.limit("30/minute")
def poll(request: Request, reservation_id: UUID = Path(...),
         token: str | None = Query(default=None),
         authorization: str | None = Header(default=None),
         db: Session = Depends(get_db)):
    raw = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else None)
    r = _verify(raw, reservation_id, db)
    return {
        "id": str(r.id), "status": r.status, "party_size": r.party_size,
        "starts_at": r.starts_at.isoformat() if r.starts_at else None,
        # The sitting's or the appointment's real length — the receipt's
        # calendar file reads it (R2, rubric V5).
        "duration_min": r.duration_min,
        "guest_name": r.guest_name,
        # What the guest told the venue, so a receipt reopened from the email
        # link or a reload can show it — in the language they booked in.
        # Structured values only: allergen_tags are sanitised catalogue keys
        # and severity is one of three words. Deliberately NOT returned to the
        # token holder: guest_email, guest_phone, guest_notes and allergy_note
        # (free-text health data). Purged rows come back empty.
        "occasion": r.occasion,
        "allergen_tags": [t for t in (r.allergen_tags or []) if isinstance(t, str)],
        "allergy_severity": r.allergy_severity,
        "guest_lang": r.guest_lang,
        "outcome": booking_outcome(r),
    }


# How a cancelled booking ended, in words the guest's receipt can use. Only
# these four values ever leave the server — never the stored cancel_reason,
# which an older owner client may have filled with free text.
_OUTCOME_BY_REASON = {
    "guest_withdrew": "withdrawn",
    "guest_cancelled": "cancelled_by_guest",
    "owner_declined": "declined",
    "request_expired_no_answer": "declined",
}


def booking_outcome(r) -> str | None:
    if r.status != "cancelled":
        return None
    if r.cancel_reason == "owner_spam":
        # Marked as spam by the owner (R2): the guest's receipt never says
        # "spam". A request that held no table reads as declined — the words
        # an owner's decline gets — and a booking as cancelled by the venue.
        held_none = r.resource_id is None and not (r.combined_resource_ids or None)
        return "declined" if held_none else "cancelled_by_venue"
    return _OUTCOME_BY_REASON.get(r.cancel_reason or "", "cancelled_by_venue")


@router.post("/booking/{reservation_id}/cancel")
@_limiter.limit("6/minute")
def visitor_cancel(request: Request, background_tasks: BackgroundTasks,
                   reservation_id: UUID = Path(...),
                   token: str | None = Query(default=None),
                   authorization: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    raw = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else None)
    r = _verify(raw, reservation_id, db)
    if r.status in ("cancelled", "completed", "no_show"):
        return {"id": str(r.id), "status": r.status, "outcome": booking_outcome(r)}
    was_request = r.status == "requested"
    r.status = "cancelled"
    r.cancelled_at = utc_now()
    # A request that is called off is WITHDRAWN — kept apart from a
    # cancelled booking so the receipt, reopened later, still says so.
    r.cancel_reason = "guest_withdrew" if was_request else "guest_cancelled"
    # Free the slot: flip the occupancy row(s) inactive so the exclusion
    # constraint stops blocking this table for other guests.
    occ_service.release_occupancy(db, r.id)
    audit_service.record(db, r.user_id, "reservation.cancelled_public", "reservation", r.id)
    db.commit()

    # Tell everyone, AFTER the cancel is durably committed and OFF the request
    # path: the guest ("your booking is cancelled"), the owner's devices (the
    # freed-table nudge / cancel ping) and the owner's inbox — the one channel
    # that lands for an owner who never enabled push, which is most of them.
    # Strictly best-effort: a notification failure must NEVER turn a successful
    # self-cancel into an error for the guest.
    background_tasks.add_task(_send_guest_cancel_notifications,
                              str(r.id), str(r.user_id), was_request)
    return {"id": str(r.id), "status": r.status, "outcome": booking_outcome(r)}
