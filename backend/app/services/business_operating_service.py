"""Business operating profile service — open days, hours, peak
windows, and per-role headcount targets.

This is the deterministic data layer that the AI demand forecast
(future Phase 3) consumes. The forecast multiplies these targets by
demand modifiers (sales-history × weather × peak windows) to suggest
a concrete schedule. Without these targets the forecast falls back
to pure-history heuristics ("you had 3 staff last Friday so probably
3 again this Friday") — useful but blunt. With them, the forecast
can suggest "1 head_chef + 2 line_cooks + 1 dishwasher + 3 servers"
specifically.

Multi-layer responsibilities:

  L1 — TENANT BOUNDARY
       Every query filters by user_id. Cross-owner reads / writes are
       impossible at the service layer; routers are a second wall.

  L2 — INPUT VALIDATION
       open_days_mask:   only digits 1-7, no dupes, length 0-7
       operating_hours:  per-day "HH:MM-HH:MM" or "closed", capped 500c
       peak_windows:     array of {day,start,end,label}, capped 1000c
       role:             must exist in ROLE_CATALOG_BY_VERTICAL
                         (broader vertical fallback so cross-vertical
                         roles work — e.g. "bartender" valid for
                         restaurant+bar+cafe)
       default_count:    [0, 99] inclusive — ≥0 (some businesses set
                         "0 dishwashers, owner cleans") and ≤99 (sanity
                         bound)

  L3 — IDEMPOTENT UPSERT
       upsert_role_target merges on (user_id, role) — running it twice
       with the same values is a no-op. Owner can re-run onboarding
       without duplicating data.

  L4 — FAIL-CLOSED DEFAULTS
       get_or_create_profile returns an empty profile shell when none
       exists; never returns None. Onboarding flow can render its
       form against a known shape.

ROLE_CATALOG_BY_VERTICAL is the canonical role list per business
type. The catalog is intentionally OPINIONATED (curated, not free-
text) so the AI demand forecast knows what each role does. Owners
who need a custom role can use the "notes" field on the target row.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.staff_role_target import StaffRoleTarget
from app.models.user import User
from app.utils.time import utc_now

log = logging.getLogger(__name__)


class OperatingProfileError(ValueError):
    """Service-layer rejection. Routers map these to 422."""


# ─── ROLE_CATALOG_BY_VERTICAL ─────────────────────────────────────────
#
# Per-vertical curated role lists. Each role has:
#   • role         — stable identifier (snake_case, never user-facing)
#   • label        — i18n EN/DA labels (the UI picks the user's locale)
#   • default_count — what the onboarding form pre-fills (owner can
#                     override). 0 means "rare for this vertical, but
#                     some owners do it" (e.g. bar/host at a small cafe).
#   • category      — coarse bucket: "front_of_house" | "kitchen" |
#                     "support" | "specialist". Drives the UI grouping.
#
# Adding a new vertical:
#   1. Add the key + role list here
#   2. Re-run tests — test_role_catalog_shape_invariants ensures every
#      new vertical has at least one role per category bucket
#
# Adding a new role to an existing vertical:
#   1. Append the dict
#   2. No DB migration needed — StaffRoleTarget.role is free-text;
#      the catalog is the validation gate
ROLE_CATALOG_BY_VERTICAL: dict[str, list[dict[str, Any]]] = {
    "restaurant": [
        {"role": "server",       "category": "front_of_house", "default_count": 2.0,
         "label": {"en": "Server",          "da": "Tjener"}},
        {"role": "host",         "category": "front_of_house", "default_count": 0.0,
         "label": {"en": "Host",            "da": "Vært"}},
        {"role": "runner",       "category": "front_of_house", "default_count": 0.0,
         "label": {"en": "Runner",          "da": "Runner"}},
        {"role": "bartender",    "category": "front_of_house", "default_count": 0.0,
         "label": {"en": "Bartender",       "da": "Bartender"}},
        {"role": "head_chef",    "category": "kitchen",        "default_count": 1.0,
         "label": {"en": "Head chef",       "da": "Køkkenchef"}},
        {"role": "line_cook",    "category": "kitchen",        "default_count": 1.0,
         "label": {"en": "Line cook",       "da": "Kok"}},
        {"role": "prep_cook",    "category": "kitchen",        "default_count": 0.0,
         "label": {"en": "Prep cook",       "da": "Forkok"}},
        {"role": "dishwasher",   "category": "support",        "default_count": 1.0,
         "label": {"en": "Dishwasher",      "da": "Opvask"}},
    ],
    "cafe": [
        {"role": "barista",      "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Barista",         "da": "Barista"}},
        {"role": "server",       "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Server",          "da": "Tjener"}},
        {"role": "kitchen_helper","category": "kitchen",       "default_count": 0.0,
         "label": {"en": "Kitchen helper",  "da": "Køkkenmedhjælper"}},
        {"role": "dishwasher",   "category": "support",        "default_count": 0.0,
         "label": {"en": "Dishwasher",      "da": "Opvask"}},
    ],
    "bar": [
        {"role": "bartender",    "category": "front_of_house", "default_count": 2.0,
         "label": {"en": "Bartender",       "da": "Bartender"}},
        {"role": "barback",      "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Barback",         "da": "Barback"}},
        {"role": "server",       "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Server",          "da": "Tjener"}},
        {"role": "door",         "category": "specialist",     "default_count": 0.0,
         "label": {"en": "Door / security", "da": "Dørmand"}},
        {"role": "kitchen_helper","category": "kitchen",       "default_count": 0.0,
         "label": {"en": "Kitchen helper",  "da": "Køkkenmedhjælper"}},
    ],
    "retail": [
        {"role": "cashier",       "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Cashier",          "da": "Kassemedarbejder"}},
        {"role": "sales_associate","category": "front_of_house","default_count": 1.0,
         "label": {"en": "Sales associate",  "da": "Sælger"}},
        {"role": "stock",         "category": "support",        "default_count": 0.0,
         "label": {"en": "Stock / restock",  "da": "Lager"}},
        {"role": "manager",       "category": "specialist",     "default_count": 0.0,
         "label": {"en": "Manager",          "da": "Leder"}},
    ],
    "salon": [
        {"role": "stylist",      "category": "specialist",     "default_count": 2.0,
         "label": {"en": "Stylist",         "da": "Frisør"}},
        {"role": "apprentice",   "category": "specialist",     "default_count": 0.0,
         "label": {"en": "Apprentice",      "da": "Lærling"}},
        {"role": "receptionist", "category": "front_of_house", "default_count": 0.0,
         "label": {"en": "Receptionist",    "da": "Receptionist"}},
        {"role": "cleaner",      "category": "support",        "default_count": 0.0,
         "label": {"en": "Cleaner",         "da": "Rengøring"}},
    ],
    "workshop": [
        {"role": "mechanic",       "category": "specialist",   "default_count": 1.0,
         "label": {"en": "Mechanic",         "da": "Mekaniker"}},
        {"role": "apprentice",     "category": "specialist",   "default_count": 0.0,
         "label": {"en": "Apprentice",       "da": "Lærling"}},
        {"role": "service_advisor","category": "front_of_house","default_count": 0.0,
         "label": {"en": "Service advisor",  "da": "Service-rådgiver"}},
        {"role": "parts_manager",  "category": "support",      "default_count": 0.0,
         "label": {"en": "Parts manager",    "da": "Reservedele"}},
    ],
    "grocery": [
        {"role": "cashier",      "category": "front_of_house", "default_count": 1.0,
         "label": {"en": "Cashier",         "da": "Kassemedarbejder"}},
        {"role": "stock",        "category": "support",        "default_count": 1.0,
         "label": {"en": "Stock",           "da": "Lager"}},
        {"role": "manager",      "category": "specialist",     "default_count": 0.0,
         "label": {"en": "Manager",         "da": "Leder"}},
        {"role": "cleaner",      "category": "support",        "default_count": 0.0,
         "label": {"en": "Cleaner",         "da": "Rengøring"}},
    ],
}


# Set of all role identifiers across all verticals — used to validate
# that a role passed in by the client is one we know about. A role
# that's only on retail BUT a restaurant owner picks it is allowed
# (cross-vertical roles like "manager" exist in multiple lists).
_ALL_ROLE_IDS: frozenset[str] = frozenset(
    r["role"]
    for roles in ROLE_CATALOG_BY_VERTICAL.values()
    for r in roles
)


# ─── Validators ───────────────────────────────────────────────────────


_OPEN_DAYS_RE = re.compile(r"^[1-7]*$")
_HOURS_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$")
_VALID_DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _validate_open_days(mask: Optional[str]) -> Optional[str]:
    """Ensure the mask is digits 1-7 only, no dupes, length 0-7. Empty
    string normalises to None so the column ends up cleanly NULL."""
    if mask is None or mask == "":
        return None
    if not isinstance(mask, str):
        raise OperatingProfileError("open_days_mask must be a string")
    if len(mask) > 7:
        raise OperatingProfileError("open_days_mask too long (max 7 digits)")
    if not _OPEN_DAYS_RE.match(mask):
        raise OperatingProfileError(
            "open_days_mask must contain only digits 1-7"
        )
    if len(set(mask)) != len(mask):
        raise OperatingProfileError("open_days_mask has duplicate days")
    return mask


def _validate_operating_hours(payload: Any) -> Optional[str]:
    """Accept dict or None. Each key must be a day key (mon..sun) and
    each value either 'closed' or 'HH:MM-HH:MM'. Returns the JSON
    string ready to persist, or None.
    """
    if payload in (None, "", {}):
        return None
    if not isinstance(payload, dict):
        raise OperatingProfileError("operating_hours must be an object")
    cleaned: dict[str, str] = {}
    for k, v in payload.items():
        kk = str(k).lower()
        if kk not in _VALID_DAY_KEYS:
            raise OperatingProfileError(
                f"operating_hours: unknown day key '{k}'"
            )
        if v in (None, "", "closed"):
            cleaned[kk] = "closed"
            continue
        if not isinstance(v, str) or not _HOURS_RE.match(v):
            raise OperatingProfileError(
                f"operating_hours[{kk}] must be 'closed' or 'HH:MM-HH:MM'"
            )
        cleaned[kk] = v
    serialized = json.dumps(cleaned, separators=(",", ":"), sort_keys=True)
    if len(serialized) > 500:
        raise OperatingProfileError("operating_hours payload too large")
    return serialized


def _validate_peak_windows(payload: Any) -> Optional[str]:
    """Accept list of {day, start, end, label}, or None. Each entry
    validated; invalid entries are dropped (lenient — peak hints are
    advisory). Returns JSON string."""
    if payload in (None, "", []):
        return None
    if not isinstance(payload, list):
        raise OperatingProfileError("peak_windows must be a list")
    cleaned: list[dict[str, str]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        day = str(entry.get("day", "")).lower()
        start = entry.get("start", "")
        end = entry.get("end", "")
        label = (entry.get("label") or "")[:80]
        if day not in _VALID_DAY_KEYS:
            continue
        if not _HOURS_RE.match(f"{start}-{end}"):
            continue
        cleaned.append({"day": day, "start": start, "end": end, "label": label})
    if not cleaned:
        return None
    serialized = json.dumps(cleaned, separators=(",", ":"))
    if len(serialized) > 1000:
        raise OperatingProfileError("peak_windows payload too large")
    return serialized


def _validate_role(role: str) -> str:
    """Reject unknown role identifiers. Cross-vertical roles allowed
    (e.g. 'bartender' is valid for any vertical that lists it)."""
    if not isinstance(role, str) or not role:
        raise OperatingProfileError("role must be a non-empty string")
    role = role.strip().lower()
    if role not in _ALL_ROLE_IDS:
        raise OperatingProfileError(
            f"Unknown role '{role}'. Use one from the role catalog."
        )
    return role


def _validate_default_count(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise OperatingProfileError("default_count must be a number")
    if v < 0:
        raise OperatingProfileError("default_count cannot be negative")
    if v > 99:
        raise OperatingProfileError("default_count cannot exceed 99")
    return v


def _normalize_notes(notes: Optional[str]) -> Optional[str]:
    if not notes:
        return None
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", notes).strip()
    if not cleaned:
        return None
    return cleaned[:200]


# ─── Public service API ──────────────────────────────────────────────


def role_catalog_for(business_type: Optional[str]) -> list[dict[str, Any]]:
    """Returns the role catalog for the given vertical, falling back
    to 'restaurant' when unknown / not-set. Defensive default keeps
    the onboarding form usable when business_type is empty or weird.
    """
    bt = (business_type or "restaurant").strip().lower()
    return ROLE_CATALOG_BY_VERTICAL.get(bt) or ROLE_CATALOG_BY_VERTICAL["restaurant"]


def get_or_create_profile(db: Session, *, owner: User) -> BusinessProfile:
    """Return the owner's BusinessProfile, creating an empty shell
    if missing. Never returns None — onboarding form needs a known
    shape to render against."""
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == owner.id,
    ).first()
    if profile:
        return profile
    profile = BusinessProfile(user_id=owner.id, company_name=owner.business_name or "")
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


def upsert_operating_profile(
    db: Session,
    *,
    owner_id: uuid.UUID,
    open_days_mask: Optional[str] = None,
    operating_hours: Any = None,
    peak_windows: Any = None,
) -> BusinessProfile:
    """Idempotent upsert of the operating-profile fields on
    BusinessProfile. Validates each input independently — an invalid
    value rejects the whole call (no half-applied state).
    """
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == owner_id,
    ).first()
    if not profile:
        profile = BusinessProfile(user_id=owner_id, company_name="")
        db.add(profile)

    profile.open_days_mask = _validate_open_days(open_days_mask)
    profile.operating_hours_json = _validate_operating_hours(operating_hours)
    profile.peak_windows_json = _validate_peak_windows(peak_windows)
    profile.updated_at = utc_now()

    db.commit()
    db.refresh(profile)
    return profile


def list_role_targets(
    db: Session, *, owner_id: uuid.UUID,
) -> list[StaffRoleTarget]:
    """Owner's configured role targets. Tenant-scoped via owner_id."""
    return (
        db.query(StaffRoleTarget)
        .filter(StaffRoleTarget.user_id == owner_id)
        .order_by(StaffRoleTarget.role.asc())
        .all()
    )


def upsert_role_target(
    db: Session,
    *,
    owner_id: uuid.UUID,
    role: str,
    default_count: Any,
    notes: Optional[str] = None,
) -> StaffRoleTarget:
    """Upsert one (owner, role) row. Validates role + count, scrubs
    notes. Idempotent — running with the same values is a no-op."""
    role_id = _validate_role(role)
    count = _validate_default_count(default_count)
    notes_clean = _normalize_notes(notes)

    existing = db.query(StaffRoleTarget).filter(
        StaffRoleTarget.user_id == owner_id,
        StaffRoleTarget.role == role_id,
    ).first()
    if existing:
        existing.default_count = count
        existing.notes = notes_clean
        existing.updated_at = utc_now()
        db.commit()
        db.refresh(existing)
        return existing

    target = StaffRoleTarget(
        user_id=owner_id,
        role=role_id,
        default_count=count,
        notes=notes_clean,
    )
    db.add(target)
    db.commit()
    db.refresh(target)
    return target


def delete_role_target(
    db: Session, *, owner_id: uuid.UUID, role: str,
) -> bool:
    """Tenant-scoped delete. Returns True if a row was removed."""
    role_id = _validate_role(role)
    n = (
        db.query(StaffRoleTarget)
        .filter(
            StaffRoleTarget.user_id == owner_id,
            StaffRoleTarget.role == role_id,
        )
        .delete()
    )
    db.commit()
    return n > 0


def bulk_upsert_role_targets(
    db: Session,
    *,
    owner_id: uuid.UUID,
    targets: list[dict[str, Any]],
) -> list[StaffRoleTarget]:
    """Onboarding submits the whole role list at once; this helper
    walks it, upserts each, and returns the final list. Validation
    failure on ANY entry rejects the whole batch (atomic semantics
    — owner sees one error, fixes one thing, re-submits).
    """
    if not isinstance(targets, list):
        raise OperatingProfileError("targets must be a list")
    if len(targets) > 30:
        raise OperatingProfileError("Too many roles in one batch (max 30)")

    # Pre-validate everything BEFORE writing anything — atomic.
    validated: list[tuple[str, float, Optional[str]]] = []
    for t in targets:
        if not isinstance(t, dict):
            raise OperatingProfileError("each target must be an object")
        validated.append((
            _validate_role(t.get("role", "")),
            _validate_default_count(t.get("default_count", 1.0)),
            _normalize_notes(t.get("notes")),
        ))

    out: list[StaffRoleTarget] = []
    for role_id, count, notes in validated:
        out.append(upsert_role_target(
            db,
            owner_id=owner_id,
            role=role_id,
            default_count=count,
            notes=notes,
        ))
    return out


def parse_operating_hours(profile: BusinessProfile) -> dict[str, str]:
    """Parse the persisted JSON-as-text back into a dict for the API
    response. Defensive — returns an empty dict if the column is
    missing or corrupt rather than raising."""
    if not profile.operating_hours_json:
        return {}
    try:
        data = json.loads(profile.operating_hours_json)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError):
        log.warning(
            "[operating_profile] invalid operating_hours_json on profile %s",
            profile.id,
        )
    return {}


def parse_peak_windows(profile: BusinessProfile) -> list[dict[str, str]]:
    if not profile.peak_windows_json:
        return []
    try:
        data = json.loads(profile.peak_windows_json)
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, TypeError):
        log.warning(
            "[operating_profile] invalid peak_windows_json on profile %s",
            profile.id,
        )
    return []
