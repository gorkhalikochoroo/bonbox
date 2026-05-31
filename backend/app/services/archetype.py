"""Canonical business-archetype layer — the single source of truth that maps a
raw ``user.business_type`` string to a coherent *archetype* and everything that
should follow from it: onboarding focus, smart signup defaults, dashboard
layout mode, floor vocabulary, suggested modules, and nav emphasis.

WHY THIS EXISTS
---------------
``business_type`` is a free-text column that today holds ~26 different strings
depending on entry point (RegisterPage offers 24, ProfilePage 11, OnboardingPage
6). Vertical→behaviour logic is scattered and divergent across:
  • frontend ``config/dashboardCardSets.js``  — 2 archetypes (dashboard layout)
  • frontend ``config/venueProfiles.js``       — 4 archetypes (floor vocabulary)
  • backend  ``services/branchekode_map.py``   — 7 verticals + module suggestions
  • backend  ``services/inventory_categorizer.py`` TAXONOMY — 5 verticals
  • backend  ``services/schedule_autopilot.py`` shift templates, etc.
Each has a slightly different keyset, so they silently disagree. This module
consolidates the *mapping* so onboarding, signup defaults, nav, and the
dashboard all resolve the same archetype from the same business_type.

DOCTRINE (do not violate)
-------------------------
1. **Archetype sets DEFAULTS + EMPHASIS only.** It is ORTHOGONAL to:
     - *tier* — ``billing.py`` gates ACCESS (has_feature / caps). Never gate a
       paid feature here.
     - *live data* — a surface shows when real data exists regardless of the
       declared type (see ``dashboardCardSets.deriveActivations`` — the #178
       footgun fix). Archetype only supplies the *fallback default* for a
       brand-new account with no rows yet. NEVER hide a surface the owner
       already has data in.
2. **Unknown / null / unmapped business_type → ``generic``** (the most
   permissive, transactionalDaily-backed default) so a mis-typed or
   OAuth-blank account still gets the safety surfaces.
3. Keep module / dashboard_mode / floor_vocab / taxonomy values IDENTICAL to
   the keysets the downstream systems already use, so they can read from here
   without a translation layer.
"""
from __future__ import annotations

from typing import Any

# ── Suggested opt-in modules (User.enabled_modules) per archetype. Values must
#    match the module keys used by Layout.jsx requiresModule + branchekode_map:
#    pour | wine | competitor | weather | expiry | khata | workshop | loan
# ── dashboard_mode ∈ {transactionalDaily, projectWeekly}  (dashboardCardSets.js)
# ── floor_vocab    ∈ {dining, bar, salon, generic}        (venueProfiles.js)
# ── inv_taxonomy   ∈ {restaurant, cafe, bar, retail, salon, generic} (inventory_categorizer)

ARCHETYPES: dict[str, dict[str, Any]] = {
    # ── Food service: dine-in restaurants, cafés, bakeries, tea shops, trucks.
    "food_service": {
        "id": "food_service",
        "label_key": "archFoodService",
        "dashboard_mode": "transactionalDaily",
        "floor_vocab": "dining",
        "inv_taxonomy": "restaurant",
        "default_cutoff_hour": 6,  # DK restaurant business-day convention
        "suggested_modules": ["competitor", "weather", "expiry"],
        # Ordered feature/route emphasis the onboarding + nav lead with.
        "lead_features": ["daily_close", "tax", "reservations", "schedule", "inventory"],
        # The single fastest "win" we steer a new owner toward.
        "first_win": "daily_close",
        # Sales channels to surface first (slugs from channel_defaults.SYSTEM_CHANNELS).
        "emphasize_channels": ["dine_in", "takeaway", "wolt", "uber_eats"],
    },
    # ── Bar / pub. Same daily-close rhythm; pour + wine modules; bar floor.
    "bar": {
        "id": "bar",
        "label_key": "archBar",
        "dashboard_mode": "transactionalDaily",
        "floor_vocab": "bar",
        "inv_taxonomy": "bar",
        "default_cutoff_hour": 6,
        "suggested_modules": ["pour", "wine", "competitor"],
        "lead_features": ["daily_close", "tax", "inventory", "schedule"],
        "first_win": "daily_close",
        "emphasize_channels": ["dine_in", "takeaway"],
    },
    # ── Retail / shop: kiosk, grocery, clothing, pharmacy, electronics, etc.
    #    Inventory-led; midnight cutoff (no late-night service window).
    "retail": {
        "id": "retail",
        "label_key": "archRetail",
        "dashboard_mode": "transactionalDaily",
        "floor_vocab": "generic",
        "inv_taxonomy": "retail",
        "default_cutoff_hour": 0,
        "suggested_modules": ["khata", "expiry"],
        "lead_features": ["inventory", "daily_close", "tax", "expenses"],
        "first_win": "inventory",
        "emphasize_channels": ["web", "phone"],
    },
    # ── Salon / barber / beauty: chair/station + appointments + staff.
    "salon": {
        "id": "salon",
        "label_key": "archSalon",
        "dashboard_mode": "transactionalDaily",
        "floor_vocab": "salon",
        "inv_taxonomy": "salon",
        "default_cutoff_hour": 0,
        "suggested_modules": ["competitor"],
        "lead_features": ["reservations", "schedule", "tax", "daily_close"],
        "first_win": "reservations",
        "emphasize_channels": ["phone", "web"],
    },
    # ── Services / repair / trades / workshop / laundry. Invoice-led, no till
    #    close; weekly burst rhythm → projectWeekly dashboard.
    "services": {
        "id": "services",
        "label_key": "archServices",
        "dashboard_mode": "projectWeekly",
        "floor_vocab": "generic",
        "inv_taxonomy": "generic",
        "default_cutoff_hour": 0,
        "suggested_modules": ["workshop", "loan", "khata"],
        "lead_features": ["faktura", "expenses", "tax"],
        "first_win": "faktura",
        "emphasize_channels": ["phone", "web"],
    },
    # ── Personal finance mode (a distinct lightweight nav already in the app).
    "personal": {
        "id": "personal",
        "label_key": "archPersonal",
        "dashboard_mode": "projectWeekly",
        "floor_vocab": "generic",
        "inv_taxonomy": "generic",
        "default_cutoff_hour": 0,
        "suggested_modules": [],
        "lead_features": ["expenses", "tax"],
        "first_win": "expenses",
        "emphasize_channels": [],
    },
    # ── Generic / other / unknown. Most permissive — keep every safety surface.
    "generic": {
        "id": "generic",
        "label_key": "archGeneric",
        "dashboard_mode": "transactionalDaily",
        "floor_vocab": "generic",
        "inv_taxonomy": "generic",
        "default_cutoff_hour": 0,
        "suggested_modules": [],
        "lead_features": ["daily_close", "tax", "expenses", "inventory"],
        "first_win": "daily_close",
        "emphasize_channels": [],
    },
}

# Every business_type string any entry point can produce → archetype id.
# Sources reconciled: RegisterPage.jsx (24), ProfilePage.jsx (11),
# OnboardingPage.jsx (6: incl. workshop/general), branchekode_map (kiosk).
# Anything missing here falls through to ``generic`` via archetype_id_for().
BUSINESS_TYPE_TO_ARCHETYPE: dict[str, str] = {
    # food service
    "restaurant": "food_service",
    "cafe": "food_service",
    "bakery": "food_service",
    "tea_shop": "food_service",
    "food_truck": "food_service",
    # bar
    "bar": "bar",
    # retail / shop
    "retail": "retail",
    "clothing": "retail",
    "online_clothing": "retail",
    "grocery": "retail",
    "veggie_shop": "retail",
    "kiosk": "retail",
    "electronics": "retail",
    "pharmacy": "retail",
    "cosmetics": "retail",
    "stationery": "retail",
    "hardware": "retail",
    "flower_shop": "retail",
    "jewelry": "retail",
    "thrift": "retail",
    "wholesale": "retail",
    # salon / personal services
    "salon": "salon",
    # services / repair / trades
    "mobile_repair": "services",
    "laundry": "services",
    "workshop": "services",
    "freelancer": "services",
    "event_organizer": "services",
    # personal
    "personal": "personal",
    # explicit generic
    "general": "generic",
    "other": "generic",
}


def archetype_id_for(business_type: str | None) -> str:
    """Resolve a business_type string to a canonical archetype id.

    Never raises; unknown / null / blank → ``generic``.
    """
    if not business_type:
        return "generic"
    return BUSINESS_TYPE_TO_ARCHETYPE.get(business_type.strip().lower(), "generic")


def archetype_for(business_type: str | None) -> dict[str, Any]:
    """Return the full archetype record for a business_type (never ``None``;
    unknown → the ``generic`` record)."""
    return ARCHETYPES[archetype_id_for(business_type)]


def archetype_defaults(business_type: str | None) -> dict[str, Any]:
    """The smart signup/onboarding defaults to materialise for a new account of
    this type. Consumed by ``apply_archetype_defaults`` (idempotent — callers
    must not clobber values the owner already set).

    Returns a plain dict so it is trivially testable + JSON-serialisable:
      {
        "archetype": "food_service",
        "day_cutoff_hour": 6,
        "suggested_modules": ["competitor", "weather", "expiry"],
        "first_win": "daily_close",
        "lead_features": [...],
        "emphasize_channels": [...],
      }
    """
    a = archetype_for(business_type)
    return {
        "archetype": a["id"],
        "day_cutoff_hour": a["default_cutoff_hour"],
        "suggested_modules": list(a["suggested_modules"]),
        "first_win": a["first_win"],
        "lead_features": list(a["lead_features"]),
        "emphasize_channels": list(a["emphasize_channels"]),
    }


def archetype_summary(business_type: str | None) -> dict[str, Any]:
    """A compact, frontend-facing view of the resolved archetype — what the
    detection endpoint + the onboarding/nav/dashboard layers read. Carries the
    cross-system keys (dashboard_mode, floor_vocab) so the frontend configs can
    align to ONE resolved archetype instead of re-deriving from business_type.
    """
    a = archetype_for(business_type)
    return {
        "id": a["id"],
        "label_key": a["label_key"],
        "dashboard_mode": a["dashboard_mode"],
        "floor_vocab": a["floor_vocab"],
        "first_win": a["first_win"],
        "lead_features": list(a["lead_features"]),
        "suggested_modules": list(a["suggested_modules"]),
        "emphasize_channels": list(a["emphasize_channels"]),
    }
