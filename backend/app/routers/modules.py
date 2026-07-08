"""Vertical-module endpoints — list catalog + select which modules are
enabled for the current user. Cap enforced via PLAN_CAPS["modules"].

Multi-layer defense (mirrors the /api/inventory/pour + /logs hardening
pattern shipped in 5ed501f — identical 6-barrier shape so a future
auditor can pattern-match instead of re-reading every endpoint):

  Layer 1 (auth): get_current_user — anonymous traffic stops here.
  Layer 2 (input bounds): Pydantic SelectModulesRequest caps list length
    at 20 and per-element string at 40 chars — defends against payload
    bombs (modules: ["x"]*1000000) and absurdly-long forged IDs that
    would push large blobs through to logs / DB writes.
  Layer 3 (rate limit): @_limiter.limit("60/minute") per IP — generous
    for normal use (a user picks modules a handful of times in onboarding
    + once or twice when upgrading), tight enough to slow a credential-
    stuffer probing for plan-cap edge cases.
  Layer 4 (allowlist): every requested ID must be in MODULES — typos
    + forged IDs bounce with 400 instead of silently dropping.
  Layer 5 (plan cap): refuse 403 if requested count > plan's modules cap
    (-1 means unlimited; Free/Starter = 1).
  Layer 6 (storage gate): set_enabled itself drops invalid IDs as a
    final defense-in-depth — the router rejects loudly above, but if the
    allowlist check is ever bypassed, storage stays clean.

Endpoint contract:
  GET  /api/modules           → catalog with per-user enabled flag
  PUT  /api/modules/select    → body: {modules: ["bar_pour", "workshop"]}
                                returns 403 if over cap, 400 on unknown ID,
                                429 if rate-limit exceeded, 422 on bounds.
"""
# NOTE: no `from __future__ import annotations` — PUT /modules/select is
# slowapi-rate-limited, and PEP 563 string annotations make FastAPI resolve
# the body param through slowapi's wrapper globals (where SelectModulesRequest
# doesn't exist), silently demoting it to a required query param → 422 on every
# save. Eager annotations avoid the resolution step. (Same in pillars.py.)
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import at_cap, get_cap, effective_plan
from app.services.modules import (
    MODULES,
    get_enabled,
    is_valid_module_id,
    list_modules,
    parse_enabled,
    set_enabled,
)


router = APIRouter()

# Rate limiter — protects PUT /select from being hammered. Module
# selection is a low-frequency human action (onboarding + occasional
# upgrade); 60/min/IP is well above any legitimate UI loop and well
# below the rate at which a malicious script could probe cap edges.
# Identical limiter setup to inventory.py for consistency.
_limiter = Limiter(key_func=client_ip)


class SelectModulesRequest(BaseModel):
    """Body for PUT /api/modules/select.

    Bounds defend against:
      • Payload bombs: a request with modules=["x"]*1_000_000 should be
        rejected at the schema layer before it ever touches the DB or
        the dedupe loop. Cap at 20 (well above any realistic user — the
        whole catalog has ~4 entries today, headroom for growth).
      • Forged IDs with absurd length (e.g. 10MB string) trying to
        exhaust memory in str.strip / set membership checks. Per-element
        cap at 40 chars covers every plausible module ID
        (longest today: "wine_sommelier" = 14).
    """
    modules: list[Annotated[str, StringConstraints(max_length=40)]] = Field(
        default_factory=list,
        max_length=20,
    )


@router.get("")
def list_modules_endpoint(
    user: User = Depends(get_current_user),
):
    """Return the module catalog with each module's enabled flag for
    THIS user. Frontend renders a picker with checkboxes; disabled
    checkbox shown when a Free/Starter user has already hit cap."""
    enabled = set(get_enabled(user))
    cap = get_cap(user, "modules")
    plan = effective_plan(user)
    return {
        "plan": plan,
        "modules_cap": cap,            # -1 = unlimited
        "enabled_count": len(enabled),
        "modules": [
            {
                "id": m["id"],
                "name": m["name"],
                "description": m["description"],
                "enabled": m["id"] in enabled,
            }
            for m in MODULES
        ],
    }


@router.put("/select")
@_limiter.limit("60/minute")
def select_modules_endpoint(
    request: Request,
    body: SelectModulesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set the user's enabled-modules list to exactly `body.modules`.

    Pass [] to disable all. Validates each ID against the canonical
    allowlist, then enforces the plan cap. Both barriers are required:
    the allowlist prevents typos / forged IDs, the cap prevents Free
    users from quietly unlocking Pro features.
    """
    requested = body.modules or []

    # Layer A — allowlist. Reject unknown IDs explicitly so frontend
    # bugs surface instead of silently dropping (which set_enabled would
    # do, but here we want louder failure on user-visible API).
    bad = [m for m in requested if not is_valid_module_id(m)]
    if bad:
        valid_ids = sorted(m["id"] for m in MODULES)
        raise HTTPException(
            status_code=400,
            detail=f"Unknown module ID(s): {bad}. Valid IDs: {valid_ids}",
        )

    # Dedupe so cap check is honest — submitting ["bar_pour", "bar_pour"]
    # shouldn't count as 2.
    deduped = list(dict.fromkeys(requested))  # preserves order

    # Layer B — cap. -1 = unlimited (Pro / trial / Business) → never trips.
    if at_cap(user, "modules", len(deduped)):
        # at_cap returns True when count >= cap; for our use we want
        # to refuse when count > cap (selecting AT cap is fine — equals
        # is allowed). Re-check explicitly.
        cap = get_cap(user, "modules")
        if cap >= 0 and len(deduped) > cap:
            plan = effective_plan(user)
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Module limit reached: requested {len(deduped)} but the "
                    f"{plan} plan allows {cap}. Upgrade to Pro for ALL modules."
                ),
            )

    cleaned = set_enabled(db, user, deduped)
    return {
        "plan": effective_plan(user),
        "modules_cap": get_cap(user, "modules"),
        "enabled": cleaned,
    }
