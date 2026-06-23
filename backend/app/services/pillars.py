"""Pillar visibility — the RELEVANCE axis of the 3-axis IA model.

Three orthogonal axes, never collapsed (panel verdict, June 2026 —
see memory/architecture_pillar_visibility.md):

  1. RELEVANCE (this file): per-account pillar toggles — Reservations,
     Events, Inventory, Staff, Insights. FREE at every tier, uncapped,
     owner-UI only. "Hidden" means the owner said "my venue doesn't do
     this" — it is a navigation preference, nothing more.
  2. ENTITLEMENT (services/billing.py PLAN_FEATURES, unchanged): tier
     locks stay visible-but-locked in the UI. A pillar that is ON but
     tier-locked renders the UpgradeNudge funnel; an item is never
     both hidden and tier-locked at once.
  3. BUSINESS TYPE (frontend visibleFor, unchanged): hides truly
     irrelevant surfaces within ON pillars.

OWN NAMESPACE — deliberately NOT services/modules.py:
  modules.py carries the tier-CAPPED vertical-module vocabulary
  (bar_pour / wine_sommelier / workshop / staff_payroll, cap enforced
  via PLAN_CAPS["modules"]). Reusing User.enabled_modules for pillars
  would (a) let the cap layer 403 free pillar presets, (b) collide
  with archetype_defaults.py's keys, and (c) conflate "hidden because
  irrelevant" with "locked because unpaid" — the exact conflation the
  3-axis model exists to prevent. Zero imports from modules.py here.

Storage shape: User.hidden_pillars is a comma-separated OFF-list of
allowlisted pillar IDs. NULL/empty = NOTHING hidden — every existing
account is grandfathered all-visible on deploy day with zero backfill.
Coercion is defensive — unknown IDs are silently dropped on read (not
raised) so a stale DB row from a removed pillar can't 500 a session.

HARD CONTRACT: no backend behavior reads hidden_pillars. Public
surfaces (/r/:slug, /e/:slug, staff portal /s/:token, door scan),
crons, reservation reminders, push notifications and revisor exports
all ignore it. BusinessProfile.reservations_enabled remains the only
public-widget kill-switch. This module exists solely so the OWNER UI
can ask "what did this owner hide?".
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.user import User


# ─── Canonical allowlist ───────────────────────────────────────────────
#
# The five owner-UI pillars. The "spine" (Home, Today/kasserapport,
# Sales, Expenses, Reports & MOMS, revisor export, Settings) is NEVER
# optional and therefore deliberately NOT in this list — there is no
# valid hidden_pillars value that can hide a compliance surface.
# Ordering is the canonical display/serialization order.
PILLARS: tuple[str, ...] = (
    "reservations",
    "events",
    "inventory",
    "staff",
    "insights",
)

# Frozenset for O(1) membership lookup — used by the validator.
_PILLAR_IDS: frozenset[str] = frozenset(PILLARS)


# ─── Onboarding presets — the DK OFF-list per business type ─────────────
#
# The RELEVANCE axis seeded ONCE at onboarding (C12, panel-approved June
# 2026). A preset is a SUGGESTION shown as pre-checked chips, never a
# silent default and NEVER retroactive — it is applied exactly once, only
# when the owner's hidden_pillars is still NULL (the grandfather state),
# and only on the onboarding-completion path. An existing account, or one
# the owner has already shaped, is never touched. See the apply-once guard
# in routers/auth.complete_onboarding and routers/pillars.preset endpoint.
#
# Each value is the set of pillars HIDDEN by default for that type (the
# "my venue doesn't do this" list). The remainder stay visible. The spine
# (Home/Today/Sales/Expenses/Reports & MOMS/Settings) is never a pillar so
# can never appear here. Mapping is LOCKED (founder + panel verdict):
#
#   restaurant                  → {} (full-service: nothing hidden)
#   cafe / tea_shop             → {events, insights}      (DK brunch booking
#                                  culture keeps Reservations ON)
#   bakery                      → {reservations, events, insights}  (Phase A:
#                                  counter trade, NO booking primitive — was
#                                  leaking Reservations ON, BUG #2)
#   takeaway / kiosk            → {reservations, events, inventory, insights}
#                                  (counter trade — Staff stays on)
#   bar                         → {events, insights}      (Reservations +
#                                  Inventory stay on; bar_pour is a separate
#                                  capped module, untouched here)
#   salon / service / general   → {events}
#   retail                      → {reservations, events}  (Phase A: inventory-
#                                  led, no floor — was leaking Reservations ON)
#   unknown / null / anything   → {} (FAIL-OPEN: hide nothing — a mis-typed
#     else                         or blank type must never lose surfaces)
#
# Two-layer resolution (so the full real RegisterPage token set is covered
# without re-listing every retail/services variant here):
#   1. Exact raw-token table below — the locked, hand-tuned tokens whose
#      OFF-list the panel pinned specifically (restaurant/cafe/bakery/
#      tea_shop/takeaway/kiosk/bar/salon/retail/service/general).
#   2. Fallback to the canonical ARCHETYPE OFF-list — so sibling tokens that
#      resolve to the same archetype get the same treatment automatically
#      (clothing/grocery/electronics/… → retail archetype → {events};
#      mobile_repair/laundry/workshop/… → services archetype → {events}).
#   3. Anything still unresolved → {} (fail-open).
_PRESET_OFF_LISTS: dict[str, frozenset[str]] = {
    "restaurant": frozenset(),
    "cafe": frozenset({"events", "insights"}),
    # Phase A bug fix (BUG #2): a production bakery is counter trade with NO
    # table-booking primitive — Reservations must be OFF (was leaking ON). The
    # bakery pre-order / click-collect primitive does NOT exist; keep it OFF
    # rather than offer booking it can't use.
    "bakery": frozenset({"reservations", "events", "insights"}),
    "tea_shop": frozenset({"events", "insights"}),
    "takeaway": frozenset({"reservations", "events", "inventory", "insights"}),
    "kiosk": frozenset({"reservations", "events", "inventory", "insights"}),
    "bar": frozenset({"events", "insights"}),
    "salon": frozenset({"events"}),
    # Phase A bug fix (BUG #2): retail is inventory-led with no floor/booking —
    # Reservations OFF by default (was leaking ON via the {events}-only list).
    "retail": frozenset({"reservations", "events"}),
    "service": frozenset({"events"}),
    "general": frozenset({"events"}),
}

# Archetype-level fallback (canonical ids from services/archetype.py). Keeps
# the locked retail/services verdict ({events}) applying to every sibling
# token of those archetypes without enumerating them all above. food_service
# is deliberately ABSENT — restaurant vs cafe vs takeaway diverge sharply, so
# food-service tokens must hit the exact table or fail open, never a blanket
# archetype default. generic/personal/bar also stay out of the fallback (bar
# is pinned exactly; generic/personal fail open).
_PRESET_OFF_LISTS_BY_ARCHETYPE: dict[str, frozenset[str]] = {
    # Phase A (BUG #2): every retail sibling token (clothing/grocery/electronics/
    # …) hides Reservations by default — inventory-led, no floor/booking.
    "retail": frozenset({"reservations", "events"}),
    "services": frozenset({"events"}),
    "salon": frozenset({"events"}),
}


def preset_hidden_pillars(business_type: str | None) -> set[str]:
    """The suggested OFF-list (set of pillar IDs to hide) for a NEW account
    of this business type — the C12 onboarding preset.

    PURE + total: never raises, never touches the DB. Resolution is exact
    raw token first, then canonical archetype fallback, then empty set
    (FAIL-OPEN: hide nothing — a mis-typed / blank / unmapped type must
    never lose surfaces). The returned set is always a subset of PILLARS by
    construction (every table value references only valid IDs), and a fresh
    mutable copy so callers can union/diff it freely.

    This is the SUGGESTION only. Whether/when it is persisted is the
    caller's concern — see the apply-once NULL guard at the onboarding
    wire-in. An owner override is honoured: the endpoint commits whatever
    final set the owner confirms, not necessarily this preset.
    """
    if not business_type:
        return set()
    key = business_type.strip().lower()
    if key in _PRESET_OFF_LISTS:
        return set(_PRESET_OFF_LISTS[key])
    # Fall back to the canonical archetype OFF-list for sibling tokens.
    from app.services.archetype import archetype_id_for  # model-free, no cycle

    archetype = archetype_id_for(key)
    return set(_PRESET_OFF_LISTS_BY_ARCHETYPE.get(archetype, frozenset()))


def is_valid_pillar_id(pillar_id: str | None) -> bool:
    """O(1) check against the allowlist. None / empty / unknown → False."""
    if not pillar_id:
        return False
    return pillar_id in _PILLAR_IDS


def parse_hidden(raw: str | None) -> set[str]:
    """Coerce User.hidden_pillars (CSV string or None) to a clean set of
    valid pillar IDs. Defensive — unknown / blank / duplicate entries
    are silently dropped so a stale DB value can never 500 a session.
    NULL/empty → empty set → nothing hidden (the grandfather state)."""
    if not raw:
        return set()
    out: set[str] = set()
    for piece in raw.split(","):
        pid = piece.strip()
        if pid and pid in _PILLAR_IDS:
            out.add(pid)
    return out


def serialize_hidden(hidden: set[str]) -> str | None:
    """Inverse of parse_hidden — canonical CSV form for storage.
    Filters to allowlisted IDs, dedupes (set input), and orders by the
    canonical PILLARS order so the stored value (and audit diffs) are
    deterministic. Empty selection → None (NULL column, NOT "" — NULL
    is the grandfather state and keeps query semantics clean)."""
    cleaned = [p for p in PILLARS if p in hidden]
    return ",".join(cleaned) or None


def get_hidden(user: User) -> set[str]:
    """Currently hidden pillars for this user, parsed + cleaned."""
    return parse_hidden(getattr(user, "hidden_pillars", None))


def is_pillar_hidden(user: User, pillar: str) -> bool:
    """True iff the owner has toggled this pillar OFF. Unknown pillar
    IDs are never hidden (False) — fail-open keeps surfaces visible,
    which is the safe direction for a navigation preference."""
    if not is_valid_pillar_id(pillar):
        return False
    return pillar in get_hidden(user)


def set_hidden(db: Session, user: User, hidden: set[str]) -> set[str]:
    """Persist a new hidden-pillars set on THIS user's row. Defensive —
    unknown IDs are silently dropped at the storage gate (the router
    rejects them loudly with 422 first; this is defense-in-depth).
    No cap, no tier check anywhere: pillars are free at every tier
    (founder decision). Returns the cleaned set actually persisted."""
    cleaned = serialize_hidden(hidden)
    user.hidden_pillars = cleaned  # None when nothing hidden
    db.commit()
    db.refresh(user)
    return parse_hidden(cleaned)


# ─── ACTIVATION axis (CONSERVATIVE v1) ──────────────────────────────────
#
# The 4th orthogonal IA axis: RELEVANCE ⊥ ENTITLEMENT ⊥ BUSINESS-TYPE ⊥
# ACTIVATION. A pillar is "activated" iff a REAL usage/config row exists for
# the owner. A DORMANT pillar (relevant, never used, not owner-hidden, in an
# in-scope account) is dropped from the dense nav and surfaces as a one-tap
# "Sæt op" tile + stays findable in ⌘K. Activation is DERIVED here, NEVER
# stored, and NEVER written to hidden_pillars.
#
# The four gateable pillars + their REAL signals (count>0 usage rows ONLY —
# NEVER archetype defaults, NEVER a fabricated flag). `insights` is NOT
# gateable (always-on) and is therefore absent from this map.
#
# HARD CONTRACT — FAIL-OPEN: any query error for a pillar makes that pillar
# `activated = True` (visible). Losing a real surface is worse than showing a
# dormant one. The frontend mirrors this on its side (fetch error → all
# activated). The four counts are issued independently so one failing query
# only fails-open its own pillar, not the whole map.
#
# The audit action emitted when the frontend detects a dormant→active
# graduation (optional, owner-scoped telemetry rail).
AUDIT_PILLAR_AUTO_ACTIVATED = "pillar.auto_activated"

# The activation-gateable pillars, in canonical order. `insights` is
# deliberately EXCLUDED (always-on, never gated).
ACTIVATION_PILLARS: tuple[str, ...] = ("inventory", "reservations", "events", "staff")


def activated_pillars(db: Session, user: User) -> dict[str, bool]:
    """Per-pillar activation booleans for THIS owner, DERIVED from real usage.

    Returns ``{inventory, reservations, events, staff}`` (insights is NOT
    gated and is omitted). True = the owner has a real usage/config row for
    that pillar → it graduates into normal nav. False = DORMANT → it drops to
    a "Sæt up" tile (still findable in ⌘K).

    FAIL-OPEN per pillar: any query error → that pillar = True (activated /
    visible). Each signal is computed in its own try/except so a single
    failing query never collapses the whole map and never hides a pillar.

    Signals (count>0 real rows only — NEVER archetype defaults):
      • inventory     — an InventoryItem row exists for the user.
      • reservations  — BusinessProfile.reservations_enabled true OR
                        reservation_slug set OR any Reservation row.
      • events        — any Event row.
      • staff         — any active (active=True, not deleted) StaffMember row.

    Tenant-scoped: every query filters on ``user.id``. Read-only — no writes,
    no commit, no side effects.
    """
    from sqlalchemy import func

    result: dict[str, bool] = {}

    # inventory — any InventoryItem row.
    try:
        from app.models.inventory import InventoryItem
        has_inventory = (
            db.query(InventoryItem.id)
            .filter(InventoryItem.user_id == user.id)
            .first()
        ) is not None
        result["inventory"] = bool(has_inventory)
    except Exception:  # noqa: BLE001 — fail-open: visible on any error
        result["inventory"] = True

    # reservations — profile kill-switch / public slug / any booking row.
    try:
        from app.models.business_profile import BusinessProfile
        from app.models.reservation import Reservation
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
        prof_signal = bool(
            profile
            and (
                bool(getattr(profile, "reservations_enabled", False))
                or (getattr(profile, "reservation_slug", None) or "").strip()
            )
        )
        if prof_signal:
            result["reservations"] = True
        else:
            has_reservation = (
                db.query(Reservation.id)
                .filter(Reservation.user_id == user.id)
                .first()
            ) is not None
            result["reservations"] = bool(has_reservation)
    except Exception:  # noqa: BLE001 — fail-open
        result["reservations"] = True

    # events — any Event row (count>0).
    try:
        from app.models.event import Event
        has_event = (
            db.query(Event.id)
            .filter(Event.user_id == user.id)
            .first()
        ) is not None
        result["events"] = bool(has_event)
    except Exception:  # noqa: BLE001 — fail-open
        result["events"] = True

    # staff — any ACTIVE StaffMember row (active=True, not deleted).
    try:
        from app.models.staff import StaffMember
        has_staff = (
            db.query(StaffMember.id)
            .filter(
                StaffMember.user_id == user.id,
                StaffMember.active.is_(True),
                StaffMember.is_deleted.isnot(True),
            )
            .first()
        ) is not None
        result["staff"] = bool(has_staff)
    except Exception:  # noqa: BLE001 — fail-open
        result["staff"] = True

    # Suppress the unused-import lint if func was only conditionally needed.
    _ = func
    return result


def active_staff_count(db: Session, user: User) -> int:
    """Count of ACTIVE (active=True, not deleted) StaffMember rows for THIS
    owner. Real signal backing the dead `staff_headcount` dashboard input.
    Fail-open to 0 on error (0 is the honest "no staff configured" value —
    NOT a fabricated flag). Tenant-scoped, read-only."""
    try:
        from sqlalchemy import func
        from app.models.staff import StaffMember
        return int(
            db.query(func.count(StaffMember.id))
            .filter(
                StaffMember.user_id == user.id,
                StaffMember.active.is_(True),
                StaffMember.is_deleted.isnot(True),
            )
            .scalar()
            or 0
        )
    except Exception:  # noqa: BLE001
        return 0


def event_counts(db: Session, user: User) -> tuple[int, int]:
    """(`recurring_count`, `total_count`) of non-deleted Event rows for THIS
    owner. Real signal backing the dead `events: {recurringCount, totalCount}`
    dashboard input. Fail-open to (0, 0). Tenant-scoped, read-only.

    `recurring_count` is the subset flagged recurring when the model carries
    such a column; otherwise it degrades to 0 (a count, never a fabricated
    flag). `total_count` is every live event row."""
    try:
        from sqlalchemy import func
        from app.models.event import Event
        total = int(
            db.query(func.count(Event.id))
            .filter(Event.user_id == user.id, Event.is_deleted.isnot(True))
            .scalar()
            or 0
        )
        recurring = 0
        recurring_col = getattr(Event, "is_recurring", None)
        if recurring_col is not None:
            recurring = int(
                db.query(func.count(Event.id))
                .filter(
                    Event.user_id == user.id,
                    Event.is_deleted.isnot(True),
                    recurring_col.is_(True),
                )
                .scalar()
                or 0
            )
        return recurring, total
    except Exception:  # noqa: BLE001
        return 0, 0
