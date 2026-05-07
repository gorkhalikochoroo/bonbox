"""Vertical-module endpoints — list catalog + select which modules are
enabled for the current user. Cap enforced via PLAN_CAPS["modules"].

Multi-layer defense (matches /branch/create + /team/invite pattern):
  Layer 1 (service): MODULES allowlist in app/services/modules.py — the
    canonical set frontend + tests + this router all reference.
  Layer 2 (this router): cap check on PUT — refuse with 403 if requested
    selection exceeds plan's modules cap (-1 means unlimited).
  Layer 3 (frontend, separate commit): hide non-enabled modules from
    nav, show upgrade prompt on cap hit.

Endpoint contract:
  GET  /api/modules           → catalog with per-user enabled flag
  PUT  /api/modules/select    → body: {modules: ["bar_pour", "workshop"]}
                                returns 403 if over cap, 400 on unknown ID
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
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


class SelectModulesRequest(BaseModel):
    modules: list[str]


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
def select_modules_endpoint(
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
