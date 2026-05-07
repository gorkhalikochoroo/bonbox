"""Vertical-module gating — stakes the marketing claim:

  Free / Starter: 1 vertical module (pick one)
  Pro / trial / Business: ALL vertical modules at once

A "vertical module" is a self-contained feature area that's relevant
to specific business types — Bar Pour for venues with cocktail/wine
programs, Workshop for auto-repair shops, Wine/Sommelier for fine-
dining, Staff Payroll Suite for restaurants with shift workers.

Gating only the LANDING-PAGE-promised "vertical modules" — NOT core
close-flow features (kasserapport snap, daily close, multi-terminal
aggregation). Those are everyone-gets-them.

Multi-layer defense:
  Layer 1 (this file): MODULES allowlist + helpers — single source of
    truth that get_enabled / set_enabled / is_enabled all use.
  Layer 2 (router): /api/modules + /api/modules/select endpoints
    enforce cap via at_cap("modules", count).
  Layer 3 (frontend, separate commit): hide nav items + features for
    modules the user hasn't enabled, show upgrade prompt on cap hit.

Storage shape: User.enabled_modules is a comma-separated string of
allowlisted IDs. NULL/empty = no modules picked yet. Coercion is
defensive — unknown IDs are silently dropped (not raised) so a stale
DB row from a removed module doesn't 500 the user's session.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.user import User


# ─── Canonical allowlist ───────────────────────────────────────────────
#
# Pin the exact set that the marketing page ("ALL vertical modules at
# once (Bar Pour + Workshop + etc.)") refers to. Adding a new module
# requires a deliberate code change here PLUS a frontend hookup that
# checks is_enabled() before rendering the feature's nav/page.
#
# Each module's "id" is the storage value; "name"/"description" are the
# display strings the picker UI shows. Keeping name/description in
# English here — frontend translates via i18n keys (modules.<id>.name).
MODULES: tuple[dict, ...] = (
    {
        "id": "bar_pour",
        "name": "Bar Pour",
        "description": "Pour-cost tracking, bottle scan, cocktail recipe books — for bars and wine venues.",
    },
    {
        "id": "wine_sommelier",
        "name": "Wine & Sommelier",
        "description": "Wine list, by-the-glass yields, vintage tracking, pairing suggestions — for fine dining.",
    },
    {
        "id": "workshop",
        "name": "Workshop",
        "description": "Job tickets, parts inventory, labor logging — for auto-repair shops and similar service trades.",
    },
    {
        "id": "staff_payroll",
        "name": "Staff Payroll Suite",
        "description": "Shift scheduling, hour logging, tip pool, lønseddel-ready exports — for venues with employees.",
    },
)

# Frozenset for O(1) membership lookup — used by the validator.
_MODULE_IDS: frozenset[str] = frozenset(m["id"] for m in MODULES)


def list_modules() -> list[dict]:
    """Return the canonical module catalog (read-only list of dicts).
    Frontend GET /api/modules wraps this with each module's enabled
    flag for the current user."""
    return [dict(m) for m in MODULES]  # copy so caller can't mutate


def is_valid_module_id(module_id: str | None) -> bool:
    """O(1) check against the allowlist. None / empty / unknown → False."""
    if not module_id:
        return False
    return module_id in _MODULE_IDS


def parse_enabled(raw: str | None) -> list[str]:
    """Coerce User.enabled_modules (CSV string or None) to a clean list of
    valid module IDs. Defensive — unknown / blank / duplicate entries are
    silently dropped. Order is preserved (first-seen wins) so the picker
    UI can show "your selected modules" deterministically."""
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for piece in raw.split(","):
        mid = piece.strip()
        if not mid or mid in seen:
            continue
        if mid in _MODULE_IDS:
            out.append(mid)
            seen.add(mid)
    return out


def serialize_enabled(modules: list[str]) -> str:
    """Inverse of parse_enabled — produces the canonical CSV form for
    storage. Filters to allowlisted IDs and dedupes."""
    seen: set[str] = set()
    out: list[str] = []
    for mid in modules:
        m = (mid or "").strip()
        if m and m in _MODULE_IDS and m not in seen:
            out.append(m)
            seen.add(m)
    return ",".join(out)


def get_enabled(user: User) -> list[str]:
    """Currently enabled modules for this user, parsed + cleaned."""
    return parse_enabled(getattr(user, "enabled_modules", None))


def is_enabled(user: User, module_id: str) -> bool:
    """True iff the module is in the user's current selection. Pro / trial
    users who haven't explicitly picked anything still return False here —
    the router layer wraps this with their unlimited cap so the frontend
    can offer to auto-enable all on first visit."""
    if not is_valid_module_id(module_id):
        return False
    return module_id in get_enabled(user)


def set_enabled(db: Session, user: User, modules: list[str]) -> list[str]:
    """Persist a new enabled-modules list. Defensive — unknown IDs are
    silently dropped; cap enforcement is the ROUTER's job (this function
    just stores). Returns the cleaned list that was actually persisted.

    Why cap is enforced upstream: this service is also called by admin /
    test paths that legitimately bypass cap (e.g. unit tests, owner
    upgrade-flow side-effect of enabling all modules at once on Pro).
    The router's at_cap check is the user-facing barrier."""
    cleaned = serialize_enabled(modules)
    user.enabled_modules = cleaned or None  # NULL when empty, cleaner than ""
    db.commit()
    db.refresh(user)
    return parse_enabled(cleaned)
