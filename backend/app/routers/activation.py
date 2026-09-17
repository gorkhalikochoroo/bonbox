"""Activation-gated disclosure — the 4th orthogonal IA axis (CONSERVATIVE v1).

GET /api/activation returns, for the CURRENT owner, a per-pillar "activated"
boolean DERIVED from real usage/config rows, plus the cohort `in_scope` flag
and the feature `enabled` kill-switch. The frontend uses this to drop a
DORMANT pillar (relevant, never used, not owner-hidden, in an in-scope
account) out of the dense nav and surface it as a one-tap "Sæt op" tile (still
findable in ⌘K). When the owner uses the feature, the usage row flips the
boolean → the pillar AUTO-GRADUATES back into normal nav.

THE FOUR FIREWALLS (a violation breaks existing owners):
  1. DERIVED, never stored — activation is computed from usage rows; nothing
     is written to hidden_pillars or anywhere else by this endpoint.
  2. NEW ACCOUNTS ONLY — `in_scope` is True ONLY when the account completed
     onboarding at-or-after ACTIVATION_DISCLOSURE_LAUNCH_AT. Established
     accounts (onboarding before the cutoff, OR onboarding_completed_at NULL)
     are EXEMPT → in_scope=False → the frontend treats every pillar as
     activated → today's nav exactly.
  3. FEATURE FLAG — the single kill-switch. enabled=False → the frontend
     treats every pillar as activated.
  4. FAIL-OPEN everywhere — any query / resolution error makes a pillar (or
     the whole cohort check) resolve to the visible direction.

`insights` is NOT gated (always-on) and is therefore absent from the per-pillar
map. The accountant role is handled frontend-side (no-op); this endpoint is
owner-scoped via get_current_user and never mutates.

SECOND CONSUMER — THE USAGE GATE (Sep 2026, frontend-only, no change here):
the frontend also reads the per-pillar booleans OUTSIDE the cohort firewall,
to hide a pillar nobody uses (today: events — navManifest USAGE_GATED_PILLARS
+ useActivation.usageDormantPillars) from EVERY owner's nav until their first
real row. That works because `in_scope` only gates the ACTIVATION axis
frontend-side, while the booleans themselves are returned truthfully for
out-of-scope accounts too (see the docstring below).

The coupling to remember: those booleans are truthful only while
ACTIVATION_DISCLOSURE_ENABLED is ON (its default — utils/features.py). With
the flag OFF this endpoint forces every pillar True, so the usage gate resolves
to "events used" and Events is VISIBLE for everyone. That is the safe
direction, and it makes the one env var the kill-switch for both features.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.pillars import ACTIVATION_PILLARS, activated_pillars
from app.utils.features import (
    ACTIVATION_DISCLOSURE_LAUNCH_AT,
    is_activation_disclosure_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _is_in_scope(user: User) -> bool:
    """An account is in-scope (gateable) iff it completed onboarding AT-OR-AFTER
    the launch cutoff. Everything else — onboarding before the cutoff, OR a
    NULL/absent onboarding timestamp — is EXEMPT (out of scope). FAIL-OPEN:
    any resolution error → False (exempt → fully visible)."""
    try:
        completed = getattr(user, "onboarding_completed_at", None)
        if completed is None:
            return False
        cutoff = ACTIVATION_DISCLOSURE_LAUNCH_AT
        # Normalize naive datetimes to the cutoff's tz so the comparison never
        # raises on a tz-naive DB value (SQLite stores naive UTC).
        if getattr(completed, "tzinfo", None) is None:
            completed = completed.replace(tzinfo=cutoff.tzinfo)
        return completed >= cutoff
    except Exception:  # noqa: BLE001 — fail-open: exempt on any error
        logger.warning("activation: in_scope resolution failed; exempting", exc_info=True)
        return False


@router.get("")
@router.get("/")
def get_activation(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Activation map for the current owner.

    Shape:
        {
          "inventory": bool, "reservations": bool,
          "events": bool, "staff": bool,   # insights NOT gated (omitted)
          "in_scope": bool,                # cohort firewall
          "enabled": bool                  # feature-flag kill-switch
        }

    When `enabled` is False the per-pillar booleans are all forced True (the
    frontend would treat them as activated anyway, but we make the payload
    self-consistent so a stale client can't mis-hide). When out of scope the
    real derived booleans are returned but the ACTIVATION axis ignores them
    (in_scope=False ⇒ nothing hidden) — kept truthful for diagnostics, and now
    also LOAD-BEARING for the frontend usage gate, which reads them for every
    account regardless of cohort. Flag OFF ⇒ all True ⇒ that gate hides
    nothing either. Do not "simplify" this into returning False out of scope.
    """
    enabled = is_activation_disclosure_enabled()
    in_scope = _is_in_scope(user)

    if not enabled:
        # Kill-switch OFF — force every gateable pillar activated. Today's nav.
        payload = {p: True for p in ACTIVATION_PILLARS}
        payload["in_scope"] = in_scope
        payload["enabled"] = False
        return payload

    # Derived per-pillar activation (fail-open per pillar inside the helper).
    derived = activated_pillars(db, user)
    payload = {p: bool(derived.get(p, True)) for p in ACTIVATION_PILLARS}
    payload["in_scope"] = in_scope
    payload["enabled"] = True
    return payload
