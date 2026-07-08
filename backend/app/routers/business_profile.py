"""Business profile — multilayer auto-detect + verification.

Endpoints:
  GET    /api/business/countries        — supported countries + lookup
                                           availability
  GET    /api/business/lookup           — search the register (smart
                                           input: CVR / domain / name)
  POST   /api/business/verify-address   — cross-check address against
                                           DAWA (Danmarks Adressers Web
                                           API)
  POST   /api/business/reverify         — re-fetch from CVR + bump
                                           cvr_verified_at on the user's
                                           saved profile
  GET    /api/business                  — get the user's saved profile
  PUT    /api/business                  — save / update profile
"""
# NOTE: no `from __future__ import annotations` — verify-address / logo are
# slowapi-rate-limited, and under PEP 563 string annotations FastAPI resolves
# their body / UploadFile params through slowapi's wrapper globals, fails to
# find the request model, and demotes the param to a required query param →
# 422 on every call. Eager annotations avoid the resolution step. (Same in
# pillars.py / modules.py.)
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
# Brand-on-faktura is part of the invoicing module; same plan gate as
# the rest of /api/invoices/*. Free tier can't issue fakturaer, so they
# would never see the logo — keep the surface consistent.
from app.routers.customers import (
    _require_invoicing_plan,
    _STARTER_AND_ABOVE,
    effective_plan,
)
from app.models.business_profile import BusinessProfile
from app.schemas.business_profile import (
    BusinessProfileCreate,
    BusinessProfileResponse,
    BusinessLookupResult,
)
from app.services.auth import get_current_user
from app.services.business_lookup import (
    lookup_business,
    get_supported_countries,
    LookupError,
)
from app.services.dawa_verify import verify_address as dawa_verify
from app.services.dawa_verify import addresses_match

router = APIRouter()

# Per-IP rate limiter for the lookup-and-verify endpoints. cvrapi.dk
# free tier has plenty of headroom but we don't want a single client
# (or a script masquerading as one) to chew through it for the whole
# tenant. Same limiter pattern as the rest of the app.
_limiter = Limiter(key_func=client_ip)

# Per-user cooldown on the Re-verify button — measured against the
# saved profile's cvr_verified_at column rather than a separate
# table. 1 hour matches the typical "I edited something, refresh"
# cadence; if the owner hits it twice in a minute, they don't get
# any new info because cvrapi caches at 6h anyway.
_REVERIFY_COOLDOWN_SECONDS = 3600  # 1 hour


# ─── Country list ─────────────────────────────────────────────────────

@router.get("/countries")
def list_countries():
    """Return supported countries with auto-lookup info."""
    return get_supported_countries()


# ─── Smart lookup ─────────────────────────────────────────────────────

@router.get("/lookup")
@_limiter.limit("30/minute")
async def search_business(
    request: Request,
    q: str = Query(..., min_length=2, description="CVR / domain / name"),
    country: str = Query("DK", description="Country code (DK, NO, GB, etc.)"),
    user: User = Depends(get_current_user),
):
    """Search public business registers.

    Smart-input:
      • 8 digits → direct CVR lookup (fast path)
      • email / domain → domain search
      • free text → name search (current behavior)

    Each result carries `confidence` (verified | likely | guess),
    `status_flags` (konkurs/ophoert/protected/no_vat), and
    `branchekode_inference` (suggested business_type + modules).
    """
    try:
        results = await lookup_business(q, country)
        return results
    except LookupError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ─── Signup-time domain lookup (unauthenticated) ──────────────────────
#
# Used by the registration form to suggest "Are you Mirabelle ApS?"
# when the user types an email like lars@mirabelle.dk. Pre-signup
# means no user object → can't share the authenticated /lookup gate.
#
# Stricter than the authenticated variant:
#   • Domain-only input (rejects CVR numbers + free-text names) —
#     the only legitimate signup-time use case is "I just typed my
#     email; what's the company?"
#   • Tighter rate limit (5/min/IP) since unauth'd
#   • Only returns the top 3 results — fewer signals = less surface
#     for company enumeration abuse
#   • Skips PII fields (phone, email, status_flags) in the response —
#     pre-signup users don't need contact info, just identity.
#
# cvrapi.dk + virk.dk are public anyway — an attacker can scrape
# them directly. The rate limit is about protecting OUR cvrapi
# free-tier quota, not about protecting "secret" data.

import re
from app.utils.time import utc_now

_DOMAIN_RE = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}$", re.IGNORECASE)


@router.get("/signup-lookup")
@_limiter.limit("5/minute")
async def signup_lookup(
    request: Request,
    domain: str = Query(..., min_length=4, max_length=120,
                        description="Bare domain like mirabelle.dk"),
    country: str = Query("DK", description="DK | NO | GB"),
):
    """Unauthenticated domain → company lookup for the signup form.

    Returns up to 3 candidates with reduced fields so the signup
    page can prefill business_name + business_type + currency from
    the user's email domain alone. No auth needed — this only
    surfaces data already public on virk.dk / Companies House.
    """
    domain = domain.strip().lower()
    if not _DOMAIN_RE.match(domain):
        raise HTTPException(
            status_code=422,
            detail="Invalid domain format. Expected something like 'mirabelle.dk'.",
        )

    # Country normalize — we only support DK/NO/GB lookups
    country_norm = (country or "DK").upper()
    if country_norm not in ("DK", "NO", "GB"):
        return []

    try:
        results = await lookup_business(domain, country_norm)
    except LookupError:
        # Pre-signup we're forgiving about errors — better to let
        # the user type manually than to block registration.
        return []

    # Trim to 3 + strip PII the signup form doesn't need
    trimmed = []
    for r in (results or [])[:3]:
        trimmed.append({
            "name": r.get("name", ""),
            "org_number": r.get("org_number", ""),
            "address": r.get("address", ""),
            "city": r.get("city", ""),
            "zipcode": r.get("zipcode", ""),
            "country": r.get("country", country_norm),
            "industry": r.get("industry", ""),
            "industry_code": r.get("industry_code", ""),
            "confidence": r.get("confidence", "guess"),
            "branchekode_inference": r.get("branchekode_inference"),
        })
    return trimmed


# ─── DAWA address verification ────────────────────────────────────────

class AddressVerifyRequest(BaseModel):
    address: str | None = None
    zipcode: str | None = None
    city: str | None = None


@router.post("/verify-address")
@_limiter.limit("60/minute")
async def verify_address_endpoint(
    request: Request,
    payload: AddressVerifyRequest,
    user: User = Depends(get_current_user),
):
    """Cross-check an address against DAWA (Danmarks Adressers Web API).

    Returns:
      {
        "verified": true,
        "id": "0a3f50ad-...",
        "betegnelse": "Vestergade 1, 1456 København K",
        "category": "A",
        "matches_input": true   — whether the canonical form matches
                                   what the user supplied (false means
                                   we'd update + show "we corrected
                                   this")
      }
      or {"verified": false} when DAWA returns no match (or is down,
      or the address is non-DK).

    No rate limit — DAWA is free + public + the user's own input.
    """
    record = await dawa_verify(payload.address, payload.zipcode, payload.city)
    if not record:
        return {"verified": False}
    matches = addresses_match(
        {
            "address": payload.address or "",
            "zipcode": payload.zipcode or "",
            "city": payload.city or "",
        },
        record,
    )
    return {"verified": True, "matches_input": matches, **record}


# ─── Re-verify saved profile ──────────────────────────────────────────

class ReverifyResponse(BaseModel):
    """Result of the Re-verify button."""
    refreshed: bool
    fields_changed: list[str] = []
    message: str | None = None


@router.post("/reverify", response_model=ReverifyResponse)
@_limiter.limit("10/minute")
async def reverify_profile(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Re-pull the user's profile from the official register.

    Triggered by the "Re-verify" button on the Profile page. Updates:
      • company_name, address, city, zipcode (if changed)
      • industry, industry_code (in case of branchekode change)
      • status_flags (konkurs / no_vat etc.)
      • cvr_verified_at = now
      • cvr_verified_source = whichever source served the response

    Two layers of throttling:
      • Per-IP rate limit (10/min) — abuse defense.
      • Per-user cooldown (1h) — measured against cvr_verified_at on
        the saved profile. cvrapi caches at 6h anyway, so multiple
        re-verifies inside that window get the same data — better to
        tell the owner "wait 47 min" than to silently re-fetch the
        same bytes.

    Returns the list of fields that actually changed so the UI can
    show "Updated address + industry" instead of a generic toast.
    """
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No business profile to re-verify. Set one up first.",
        )

    if not profile.org_number:
        raise HTTPException(
            status_code=422,
            detail="Profile has no registration number to verify against.",
        )

    # Per-user cooldown — measured against cvr_verified_at. Skipped
    # for never-verified profiles (cvr_verified_at is NULL → first
    # verification proceeds immediately).
    if profile.cvr_verified_at:
        elapsed = (utc_now() - profile.cvr_verified_at).total_seconds()
        if elapsed < _REVERIFY_COOLDOWN_SECONDS:
            wait_seconds = int(_REVERIFY_COOLDOWN_SECONDS - elapsed)
            wait_minutes = max(1, wait_seconds // 60)
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "reverify_cooldown",
                    "message": (
                        f"Just verified — try again in {wait_minutes} minute"
                        f"{'s' if wait_minutes != 1 else ''}. "
                        "(CVR data is cached for an hour to keep things fast.)"
                    ),
                    "retry_after_seconds": wait_seconds,
                },
                headers={"Retry-After": str(wait_seconds)},
            )

    try:
        results = await lookup_business(profile.org_number, profile.country or "DK")
    except LookupError as e:
        raise HTTPException(status_code=503, detail=str(e))

    if not results:
        return ReverifyResponse(
            refreshed=False,
            message="Register has no record for this number anymore.",
        )

    fresh = results[0]
    changed = []

    def _maybe_update(field: str, new_value):
        """Update the profile field iff the new value is non-empty
        and differs from the old. Records the change for the response."""
        old = getattr(profile, field, None)
        if new_value in (None, ""):
            return
        if (old or "") != new_value:
            setattr(profile, field, new_value)
            changed.append(field)

    _maybe_update("company_name", fresh.get("name"))
    _maybe_update("address", fresh.get("address"))
    _maybe_update("city", fresh.get("city"))
    _maybe_update("zipcode", fresh.get("zipcode"))
    _maybe_update("industry", fresh.get("industry"))
    _maybe_update("industry_code", fresh.get("industry_code"))
    _maybe_update("phone", fresh.get("phone"))
    _maybe_update("email", fresh.get("email"))

    # Status flags + VAT — encode flags as pipe-delim
    new_flags = "|".join(fresh.get("status_flags") or [])
    if (profile.status_flags or "") != new_flags:
        profile.status_flags = new_flags or None
        changed.append("status_flags")
    if profile.vat_registered != fresh.get("vat_registered"):
        profile.vat_registered = fresh.get("vat_registered")
        changed.append("vat_registered")

    # Always bump the verified-at timestamp + source — even if nothing
    # changed, the "fresh check" itself is valuable info for the UI.
    profile.cvr_verified_at = utc_now()
    profile.cvr_verified_source = fresh.get("source", "cvrapi.dk")

    db.commit()
    db.refresh(profile)

    return ReverifyResponse(
        refreshed=True,
        fields_changed=changed,
        message=(
            f"Updated {len(changed)} field{'s' if len(changed) != 1 else ''}"
            if changed else "Profile is already up to date."
        ),
    )


# ─── GET / PUT (existing) ─────────────────────────────────────────────

@router.get("", response_model=BusinessProfileResponse | None)
def get_profile(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the user's saved business profile."""
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    if not profile:
        return None
    return profile


@router.put("", response_model=BusinessProfileResponse)
def save_profile(
    data: BusinessProfileCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save or update the user's business profile.

    When the source is cvrapi.dk / virk.dk / companies_house (i.e. the
    user picked an auto-lookup result rather than typing manually),
    we stamp cvr_verified_at = now so the "Verified" badge shows
    immediately.
    """
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    # day_cutoff_hour — clamp to [0, 23] so a typo (e.g. "26") can't
    # land a junk value that the tz_utils helper would then defensively
    # clamp on every read forever. Doing it here keeps stored values
    # honest and matches the validator bounds documented on the model.
    if data.day_cutoff_hour is not None:
        try:
            h = int(data.day_cutoff_hour)
            if h < 0:
                h = 0
            elif h > 23:
                h = 23
            data.day_cutoff_hour = h
        except (TypeError, ValueError):
            data.day_cutoff_hour = None

    # target_labor_pct — clamp to [0.10, 0.50] so the schedule autopilot
    # never proposes an over- or under-staffed week from a typo. Stored
    # as a fraction. Default 0.30 is the documented baseline.
    if data.target_labor_pct is not None:
        try:
            v = float(data.target_labor_pct)
            if v < 0.10:
                v = 0.10
            elif v > 0.50:
                v = 0.50
            data.target_labor_pct = round(v, 3)
        except (TypeError, ValueError):
            data.target_labor_pct = None

    if profile:
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(profile, field, value)
    else:
        profile = BusinessProfile(
            id=uuid.uuid4(),
            user_id=user.id,
            **data.model_dump(),
        )
        db.add(profile)

    # Stamp verified-at when saving from a register source. Frontend
    # passes source as one of "cvrapi.dk" | "virk.dk" |
    # "companies_house" | "manual" — only the first three count as
    # verified. Manual entries leave cvr_verified_at = NULL so the UI
    # shows the "Re-verify with CVR" prompt.
    if (data.source or "").lower() in ("cvrapi.dk", "virk.dk", "companies_house"):
        profile.cvr_verified_at = utc_now()
        profile.cvr_verified_source = data.source

    # Also update user's business_name if company_name provided
    if data.company_name:
        user.business_name = data.company_name

    db.commit()
    db.refresh(profile)
    return profile


# ═══════════════════════════════════════════════════════════════════════════
#  Smart Staffing — operating profile + role targets
# ═══════════════════════════════════════════════════════════════════════════
#
# Multi-layer:
#   L1 — get_current_user gates every endpoint (no public reads of role
#        catalog because it depends on the user's business_type)
#   L2 — service layer enforces tenant scoping (user_id == owner.id)
#        on every read/mutation
#   L3 — pydantic schemas bound the input shape; service has stricter
#        domain validation (regex, enum-like role check, etc.)

from typing import Any as _Any
from app.services.business_operating_service import (
    OperatingProfileError as _OPError,
    bulk_upsert_role_targets as _bulk_upsert_role_targets,
    delete_role_target as _delete_role_target,
    get_or_create_profile as _get_or_create_profile,
    list_role_targets as _list_role_targets,
    parse_operating_hours as _parse_operating_hours,
    parse_peak_windows as _parse_peak_windows,
    role_catalog_for as _role_catalog_for,
    upsert_operating_profile as _upsert_operating_profile,
    upsert_role_target as _upsert_role_target,
)


class _OperatingProfileBody(BaseModel):
    open_days_mask: str | None = None
    operating_hours: dict[str, str] | None = None  # {"mon": "10:00-22:00", ...}
    peak_windows: list[dict[str, _Any]] | None = None  # [{day,start,end,label}, ...]


class _OperatingProfileResponse(BaseModel):
    open_days_mask: str | None
    operating_hours: dict[str, str]
    peak_windows: list[dict[str, _Any]]


class _RoleTargetBody(BaseModel):
    role: str
    default_count: float = 1.0
    notes: str | None = None


class _RoleTargetBulkBody(BaseModel):
    targets: list[_RoleTargetBody]


class _RoleTargetResponse(BaseModel):
    id: str
    role: str
    default_count: float
    notes: str | None


@router.get("/operating-profile", response_model=_OperatingProfileResponse)
def get_operating_profile(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner reads their operating profile (open days + hours + peak
    windows). Returns an empty shell when never set — frontend renders
    the onboarding form against a known shape."""
    profile = _get_or_create_profile(db, owner=user)
    return _OperatingProfileResponse(
        open_days_mask=profile.open_days_mask,
        operating_hours=_parse_operating_hours(profile),
        peak_windows=_parse_peak_windows(profile),
    )


@router.put("/operating-profile", response_model=_OperatingProfileResponse)
def update_operating_profile(
    body: _OperatingProfileBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner saves the operating profile during onboarding (or edits
    later from Profile page). All three fields validated independently;
    one bad value rejects the whole call (no half-applied state)."""
    try:
        profile = _upsert_operating_profile(
            db,
            owner_id=user.id,
            open_days_mask=body.open_days_mask,
            operating_hours=body.operating_hours,
            peak_windows=body.peak_windows,
        )
    except _OPError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _OperatingProfileResponse(
        open_days_mask=profile.open_days_mask,
        operating_hours=_parse_operating_hours(profile),
        peak_windows=_parse_peak_windows(profile),
    )


@router.get("/role-catalog")
def get_role_catalog(
    user: User = Depends(get_current_user),
):
    """Returns the suggested role list for THIS owner's vertical.
    Auth-required so we can read user.business_type — also keeps the
    catalog out of unauthenticated scrape paths."""
    catalog = _role_catalog_for(user.business_type)
    return {
        "vertical": (user.business_type or "restaurant").lower(),
        "roles": catalog,
    }


@router.get("/staff-role-targets", response_model=list[_RoleTargetResponse])
def get_role_targets(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner's configured role targets — what they answered during
    onboarding (or edited later). Tenant-scoped via owner_id at the
    service layer."""
    rows = _list_role_targets(db, owner_id=user.id)
    return [
        _RoleTargetResponse(
            id=str(r.id),
            role=r.role,
            default_count=float(r.default_count),
            notes=r.notes,
        )
        for r in rows
    ]


@router.put("/staff-role-targets", response_model=list[_RoleTargetResponse])
def upsert_role_targets_bulk(
    body: _RoleTargetBulkBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Bulk upsert — onboarding submits the whole role list at once.
    Service layer pre-validates everything BEFORE writing so a bad
    entry rejects the whole batch atomically."""
    try:
        rows = _bulk_upsert_role_targets(
            db,
            owner_id=user.id,
            targets=[t.model_dump() for t in body.targets],
        )
    except _OPError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return [
        _RoleTargetResponse(
            id=str(r.id),
            role=r.role,
            default_count=float(r.default_count),
            notes=r.notes,
        )
        for r in rows
    ]


@router.delete("/staff-role-targets/{role}", status_code=204)
def delete_role_target_by_role(
    role: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner removes a role target. Service layer validates `role`
    against the catalog so a 422 fires for unknown identifiers
    instead of a silent 204."""
    try:
        _delete_role_target(db, owner_id=user.id, role=role)
    except _OPError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/staffing-suggestion")
def get_staffing_suggestion(
    branch_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The "we watched your data, here's what we see" proposal.
    Pure inference from existing sales + staff data; never writes.

    Branch-aware (May 2026): if `branch_id` is supplied (e.g. via the
    BranchSelector on a multi-location Pro account), the inference
    only sees that branch's data — so a per-location proposal is
    accurate, not blended across all 3 locations. Defense:
    branch ownership is re-checked here even though the inference
    service ALSO filters; cross-tenant branch_id silently 404s.
    """
    import uuid as _uuid
    import logging as _logging
    from app.models.branch import Branch
    from app.services.staffing_inference import infer_staffing_profile

    _log = _logging.getLogger("bonbox.business_profile.staffing_suggestion")

    bid = None
    if branch_id:
        try:
            bid = _uuid.UUID(branch_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch_id")
        own = (
            db.query(Branch.id)
            .filter(Branch.id == bid, Branch.user_id == user.id)
            .first()
        )
        if not own:
            raise HTTPException(status_code=404, detail="Branch not found")

    # Multi-layer fail-closed: the inference service is supposed to
    # always return a complete shape, but in production a Postgres
    # query stall, a malformed Sale.created_at, or any new edge case
    # could throw. Catching unhandled exceptions here so the SmartCard
    # never ends up showing the user a red "Couldn't load" box. Worst
    # case they see the conservative low-confidence default. The real
    # exception lands in stderr where the operator can spot it.
    _SAFE_DEFAULT = {
        "open_days_mask": "12345",
        "operating_hours": {
            "mon": "10:00-18:00", "tue": "10:00-18:00", "wed": "10:00-18:00",
            "thu": "10:00-18:00", "fri": "10:00-18:00",
            "sat": "closed", "sun": "closed",
        },
        "peak_windows": [],
        "role_targets": [],
        "confidence": "low",
        "data_quality": {"days_observed": 0, "sales_observed": 0, "lookback_days": 60},
        "reasoning": "Inference temporarily unavailable — using conservative defaults.",
    }
    try:
        return infer_staffing_profile(db, user=user, branch_id=bid)
    except Exception as exc:  # noqa: BLE001
        _log.exception("staffing inference failed for user %s: %s", user.id, exc)
        # Never propagate to a 5xx — the SmartCard's job is to be calm
        # and dismissible, not to crash the whole profile page.
        return _SAFE_DEFAULT


# ─── Logo + brand customization (migration 034) ──────────────────────────
#
# Layer architecture:
#   • logo_service.py — sanitization + storage (pure function-style)
#   • here          — HTTP boundary: auth, rate limit, audit, ownership
#   • storage.py    — backend abstraction (Supabase/local)
#
# Security:
#   • Rate limited (10/hour for upload — protects against abuse +
#     storage quota burn)
#   • Multipart file handled by FastAPI's UploadFile (streamed, not
#     loaded entirely into memory until we read bytes)
#   • Tenant ownership enforced via _get_or_create_profile + user.id
#   • Audit-logged on success
#   • Errors never leak storage paths to the client

from typing import Annotated
from fastapi import UploadFile, File
from app.services.logo_service import (
    upload_logo,
    delete_logo,
    logo_signed_url,
    validate_accent_color,
    validate_logo_position,
    ACCENT_COLOR_PALETTE,
    MAX_LOGO_BYTES,
)
from app.services import audit_service


class _BrandUpdateRequest(BaseModel):
    """Patch payload for /api/business/brand. All fields optional —
    user can change just one without echoing the others. Validation
    runs server-side via validate_* helpers to keep the schema layer
    dumb and the policy layer in services/logo_service.py."""
    accent_color: str | None = None  # palette name or hex
    logo_position: str | None = None  # 'left'|'center'


class _BrandResponse(BaseModel):
    logo_url: str | None = None  # signed URL with 1h TTL, never the storage key
    accent_color: str | None = None
    logo_position: str = "left"
    accent_palette: dict[str, str]  # so the frontend can render the picker

    model_config = {"from_attributes": False}


def _get_or_create_profile(db: Session, user: User) -> BusinessProfile:
    """Helper — every brand/logo endpoint needs a profile row."""
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    if profile is None:
        profile = BusinessProfile(
            id=uuid.uuid4(),
            user_id=user.id,
            company_name=user.business_name or "",
        )
        db.add(profile)
        db.flush()
    return profile


def _require_brand_access(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Brand / logo access — available to any venue that can actually show a
    logo: an INVOICING plan (logo on invoices + kasserapport) OR a venue that has
    turned RESERVATIONS on (logo on the public booking page). So a
    reservations-only salon on Free can still add the logo its booking-page guests
    see. Everyone else gets the same 402 upgrade nudge as before."""
    if (effective_plan(user) or "free").lower() in _STARTER_AND_ABOVE:
        return user
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    if profile is not None and getattr(profile, "reservations_enabled", False):
        return user
    raise HTTPException(
        402, "Upgrade to Starter, or turn on reservations, to add a logo",
    )


@router.get("/brand", response_model=_BrandResponse)
def get_brand(
    db: Session = Depends(get_db),
    user: User = Depends(_require_brand_access),
):
    """Read brand settings — used by Profile UI and the faktura PDF
    renderer. Returns a SIGNED URL for the logo (1h TTL), never the
    raw storage key.
    """
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    storage_key = profile.logo_url if profile else None
    return _BrandResponse(
        logo_url=logo_signed_url(storage_key) if storage_key else None,
        accent_color=profile.accent_color if profile else None,
        logo_position=(profile.logo_position if profile else None) or "left",
        accent_palette=ACCENT_COLOR_PALETTE,
    )


@router.post("/logo", response_model=_BrandResponse)
@_limiter.limit("10/hour")
async def upload_logo_endpoint(
    request: Request,
    file: Annotated[UploadFile, File(...)],
    db: Session = Depends(get_db),
    user: User = Depends(_require_brand_access),
):
    """Upload a new logo. PNG or JPEG, max 1 MB.

    Multi-layer validation pipeline (every step can reject):
      1. Size check (HTTP-level via FastAPI's request size config)
      2. Magic byte verification (logo_service)
      3. Pillow re-encode (strips EXIF, validates format, downscales)
      4. SHA-content-addressed storage path (no filename collision)
      5. Tenant-isolated S3 prefix
      6. Audit log entry on success
    """
    # FastAPI streams the upload — read it fully here. We bound the read
    # via MAX_LOGO_BYTES + a 1-byte overshoot to detect oversized files
    # WITHOUT loading the entire payload first.
    raw = await file.read(MAX_LOGO_BYTES + 1)
    if len(raw) > MAX_LOGO_BYTES:
        raise HTTPException(
            413,
            f"Logo too large (max {MAX_LOGO_BYTES // 1000} KB)",
        )

    profile = _get_or_create_profile(db, user)

    # Remember the old key so we can clean it up after successful save.
    old_key = profile.logo_url

    storage_key, out_bytes = upload_logo(user.id, raw)

    before = {"logo_url": old_key}
    profile.logo_url = storage_key
    after = {"logo_url": storage_key, "size_bytes": out_bytes}

    audit_service.record(
        db, user, "business_profile.logo_upload",
        entity_type="business_profile", entity_id=profile.id,
        before=before, after=after,
        ip_address=getattr(request.client, "host", None),
    )
    db.commit()

    # Delete the old logo from storage AFTER the DB commit succeeded —
    # if storage delete fails, we still have the new logo recorded.
    if old_key and old_key != storage_key:
        delete_logo(old_key)

    return _BrandResponse(
        logo_url=logo_signed_url(storage_key),
        accent_color=profile.accent_color,
        logo_position=profile.logo_position or "left",
        accent_palette=ACCENT_COLOR_PALETTE,
    )


@router.delete("/logo", response_model=_BrandResponse)
def delete_logo_endpoint(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_brand_access),
):
    """Remove the logo. Faktura PDFs revert to plain business name."""
    profile = _get_or_create_profile(db, user)
    old_key = profile.logo_url
    profile.logo_url = None

    audit_service.record(
        db, user, "business_profile.logo_delete",
        entity_type="business_profile", entity_id=profile.id,
        before={"logo_url": old_key}, after={"logo_url": None},
        ip_address=getattr(request.client, "host", None),
    )
    db.commit()

    if old_key:
        delete_logo(old_key)

    return _BrandResponse(
        logo_url=None,
        accent_color=profile.accent_color,
        logo_position=profile.logo_position or "left",
        accent_palette=ACCENT_COLOR_PALETTE,
    )


@router.patch("/brand", response_model=_BrandResponse)
def update_brand(
    data: _BrandUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_brand_access),
):
    """Update accent color and/or logo position.

    Color is server-validated against the 6-preset palette — anything
    else is rejected with 422. This is intentional: a free hex picker
    on the frontend would let users ship neon-green tax invoices,
    which damages our brand and accessibility.
    """
    profile = _get_or_create_profile(db, user)
    before = {
        "accent_color": profile.accent_color,
        "logo_position": profile.logo_position,
    }

    if data.accent_color is not None:
        try:
            profile.accent_color = validate_accent_color(data.accent_color)
        except ValueError as e:
            raise HTTPException(422, str(e))
    if data.logo_position is not None:
        try:
            profile.logo_position = validate_logo_position(data.logo_position)
        except ValueError as e:
            raise HTTPException(422, str(e))

    after = {
        "accent_color": profile.accent_color,
        "logo_position": profile.logo_position,
    }
    audit_service.record(
        db, user, "business_profile.brand_update",
        entity_type="business_profile", entity_id=profile.id,
        before=before, after=after,
        ip_address=getattr(request.client, "host", None),
    )
    db.commit()

    return _BrandResponse(
        logo_url=logo_signed_url(profile.logo_url) if profile.logo_url else None,
        accent_color=profile.accent_color,
        logo_position=profile.logo_position or "left",
        accent_palette=ACCENT_COLOR_PALETTE,
    )
