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
