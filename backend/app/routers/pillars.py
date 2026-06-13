"""Pillar-visibility endpoints — GET/PUT /api/pillars.

The RELEVANCE axis of the 3-axis IA model (see services/pillars.py).
Same multi-barrier shape as routers/modules.py MINUS the cap layer —
pillars are FREE at every tier (founder decision, June 2026): no
PLAN_CAPS key, no PLAN_FEATURES gate, no upgrade payload. A Free user
hiding Events is a navigation preference, not an entitlement event.

  Layer 1 (auth): get_current_user — anonymous traffic stops here.
    Accountant-view sessions are additionally write-blocked on PUT
    (global middleware + belt-and-braces require_write_access) — a
    revisor must never re-shape the owner's navigation.
  Layer 2 (input bounds): Pydantic SetPillarsRequest caps list length
    at 10 and per-element string at 40 chars — payload-bomb defense
    (the whole allowlist has 5 entries; headroom only).
  Layer 3 (rate limit): @_limiter.limit("60/minute") per IP on PUT —
    toggling pillars is a low-frequency human action.
  Layer 4 (allowlist): every requested ID must be in PILLARS — typos
    and forged IDs bounce with 422 (matching the Pydantic-bounds
    status so the client has ONE invalid-input code to handle).
  Layer 5 (tenant scope): the handler writes ONLY the caller's own
    users row, re-fetched by primary key inside this request's
    session — there is no path to another tenant's row by construction.
  Layer 6 (storage gate): set_hidden re-filters against the allowlist
    as defense-in-depth if Layer 4 is ever bypassed.
  Layer 7 (audit): audit_service.record('pillars.updated') with
    before/after OFF-lists — preset-override telemetry rides on the
    existing audit_logs pattern.

Endpoint contract:
  GET /api/pillars  → {"hidden": [...], "available": [...PILLARS]}
  PUT /api/pillars  → body {"hidden": ["events", ...]}; full-set
                      semantics (pass [] to un-hide everything).
                      422 on unknown ID / bounds, 401 anon,
                      403 accountant-view, 429 rate-limited.

NULL semantics: a user who has never touched the toggles has
hidden_pillars = NULL → GET returns hidden: [] → everything visible.
"""
# NOTE: deliberately NO `from __future__ import annotations` here.
# This router rate-limits its state-changing endpoint with slowapi's
# @_limiter.limit(...), which wraps the handler. Under PEP 563 string
# annotations, FastAPI resolves the body parameter's annotation through the
# WRAPPER's module globals (slowapi's), can't find SetPillarsRequest, and
# silently demotes `body` to a required *query* param → every PUT 422s with
# loc=["query","body"]. Eager (real-object) annotations sidestep the whole
# resolution step. Same reason modules.py / business_profile.py omit it.
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user, require_write_access
from app.services.pillars import (
    PILLARS,
    get_hidden,
    is_valid_pillar_id,
    preset_hidden_pillars,
    set_hidden,
)

router = APIRouter()

# Rate limiter — same setup as routers/modules.py for consistency.
# Pillar toggling is a low-frequency human action (onboarding presets
# + the occasional "we started doing events"); 60/min/IP is far above
# any legitimate UI loop.
_limiter = Limiter(key_func=get_remote_address)


class SetPillarsRequest(BaseModel):
    """Body for PUT /api/pillars. Full-set semantics: the list IS the
    new OFF-list (pass [] to make everything visible again).

    Bounds defend against payload bombs: the allowlist has 5 entries,
    so 10 list slots and 40 chars per element is pure headroom — a
    request with hidden=["x"]*1_000_000 dies at the schema layer
    before it touches the allowlist loop or the DB."""

    hidden: list[Annotated[str, StringConstraints(max_length=40)]] = Field(
        default_factory=list,
        max_length=10,
    )


def _payload(hidden: set[str]) -> dict:
    """Canonical response shape for both endpoints. `hidden` is emitted
    in PILLARS order so clients see a deterministic list."""
    return {
        "hidden": [p for p in PILLARS if p in hidden],
        "available": list(PILLARS),
    }


@router.get("")
def get_pillars_endpoint(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return the caller's hidden-pillars OFF-list + the full catalog.
    NULL column → hidden: [] → every pillar visible (the grandfather
    state for all pre-feature accounts)."""
    # Re-fetch by PK in THIS request's session so a just-committed PUT
    # is always reflected (identity-map hit in production — free).
    row = db.get(User, user.id) or user
    return _payload(get_hidden(row))


@router.get("/preset")
def get_preset_endpoint(
    business_type: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Suggested onboarding OFF-list for C12 pre-checked chips.

    Pure read — never writes hidden_pillars (the commit happens via PUT
    /api/pillars once the owner confirms / overrides the chips). Resolves
    the business_type from the ?business_type query param if supplied
    (so the onboarding wizard can preview presets as the owner picks a
    type before it's saved), else falls back to the caller's stored
    business_type. Unknown / blank type → suggested: [] (fail-open).

    Shape:
      {"business_type": "cafe",
       "suggested": ["events", "insights"],   # PILLARS order
       "available": [...PILLARS]}
    """
    bt = (business_type or "").strip() or getattr(user, "business_type", None)
    suggested = preset_hidden_pillars(bt)
    return {
        "business_type": bt or None,
        "suggested": [p for p in PILLARS if p in suggested],
        "available": list(PILLARS),
    }


@router.put("")
@_limiter.limit("60/minute")
def set_pillars_endpoint(
    request: Request,
    body: SetPillarsRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Replace the caller's hidden-pillars set with exactly `body.hidden`.

    No tier gating, no caps — pillars are free (founder decision).
    Unknown IDs bounce 422 loudly (frontend bugs must surface, not
    silently drop). Accountant-view sessions are refused 403.
    """
    # Belt-and-braces on top of the global accountant write-block
    # middleware — a revisor session must never mutate owner nav state.
    require_write_access(user)

    requested = body.hidden or []

    # Layer 4 — allowlist. 422 to match the Pydantic-bounds status:
    # one invalid-input code for the client to handle.
    bad = sorted({p for p in requested if not is_valid_pillar_id(p)})
    if bad:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown pillar ID(s): {bad}. Valid IDs: {list(PILLARS)}",
        )

    # Layer 5 — tenant-safe by construction: write ONLY the caller's
    # own row, re-fetched by primary key inside this session. There is
    # no user-controlled tenant key anywhere in this handler.
    row = db.get(User, user.id)
    if row is None:
        # Account deleted mid-session — fail gracefully, not with a 500.
        raise HTTPException(status_code=404, detail="User not found")

    before = sorted(get_hidden(row))
    new_hidden = {p for p in requested}  # validated above; set() dedupes

    # Layer 7 — audit trail (also the preset-override telemetry rail).
    # Recorded BEFORE set_hidden's commit so the audit row lands in the
    # SAME transaction as the mutation (record() add+flushes, never
    # commits, never raises — best-effort by design).
    audit_service.record(
        db,
        row,
        action="pillars.updated",
        entity_type="user",
        entity_id=row.id,
        before={"hidden": before},
        after={"hidden": [p for p in PILLARS if p in new_hidden]},
        ip_address=request.client.host if request.client else None,
    )

    # Layer 6 lives inside set_hidden (allowlist re-filter at the
    # storage gate); its commit persists mutation + audit row together.
    persisted = set_hidden(db, row, new_hidden)

    return _payload(persisted)
