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
#   cafe / bakery / tea_shop    → {events, insights}      (DK brunch booking
#                                  culture keeps Reservations ON)
#   takeaway / kiosk            → {reservations, events, inventory, insights}
#                                  (counter trade — Staff stays on)
#   bar                         → {events, insights}      (Reservations +
#                                  Inventory stay on; bar_pour is a separate
#                                  capped module, untouched here)
#   salon / retail / service /  → {events}
#     general
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
    "bakery": frozenset({"events", "insights"}),
    "tea_shop": frozenset({"events", "insights"}),
    "takeaway": frozenset({"reservations", "events", "inventory", "insights"}),
    "kiosk": frozenset({"reservations", "events", "inventory", "insights"}),
    "bar": frozenset({"events", "insights"}),
    "salon": frozenset({"events"}),
    "retail": frozenset({"events"}),
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
    "retail": frozenset({"events"}),
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
