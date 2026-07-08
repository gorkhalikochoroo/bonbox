"""Demo data toggle — per-user sample data (Task #68).

A new owner who just signed up faces a blank app. "Try BonBox with
sample data" lets them seed their OWN account with a realistic
30-day Mirabelle-style dataset (closes, inventory, expenses) so the
dashboard, brief, and reports light up immediately. One tap to undo.

Endpoints:
  GET    /api/demo/status   → {has_demo, has_real}  — light read
                              the frontend uses to decide between
                              "Show seed CTA" vs "Show clear option".
  POST   /api/demo/seed     → materializes sample rows.  Refuses if
                              the user has any real (non-demo) rows
                              or if demo data is already seeded.
  POST   /api/demo/clear    → deletes rows tagged " · demo".

Safety posture
--------------
1. Multi-layer auth: get_current_user → tenant_scope (the seed
   helpers take user.id and only ever filter on that).
2. Idempotent: seed refuses to overwrite, clear is a no-op when
   there are no demo rows.
3. Marker contract: ONLY rows whose description/name/notes ends in
   " · demo" are ever touched on clear. The owner's real data is
   never at risk.
4. Audit-logged: every seed and clear is recorded for GDPR and
   Bogføringsloven §9 trail.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.demo_seed import (
    clear_for_user,
    seed_for_user,
    status_for_user,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Audit P3 (Task #75 follow-up): rate-limit seed/clear so a hostile
# owner can't churn the DB.  Each seed is ~75 rows and clear deletes
# them — without a cap, a loop costs almost nothing to the attacker
# and meaningful CPU/IO to the server.  3/hour per IP is generous for
# a genuine "tried sample, decided I'm done" flow.
limiter = Limiter(key_func=client_ip)


def _client_ip(request: Request) -> str | None:
    """Capture the request IP for the audit row."""
    try:
        return request.client.host if request.client else None
    except Exception:
        return None


@router.get("/status")
def get_demo_status(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Frontend decides: show 'Try sample data' vs 'Clear sample data'.

    Returns a dict with two booleans:
      has_demo: at least one row tagged " · demo" exists for this user
      has_real: at least one row of real (non-demo) data exists
    """
    return status_for_user(db, user)


@router.post("/seed")
@limiter.limit("3/hour")
def seed_demo(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Drop a realistic 30-day Mirabelle-style dataset onto the user's
    account so the dashboard, brief, and reports light up instantly.

    Refuses (409) if:
      • the user already has real data — we never overwrite work
      • demo data is already present — user should clear first
    """
    result = seed_for_user(db, user)
    if not result.get("ok"):
        # Best-effort audit so we can spot abuse patterns
        audit_service.record(
            db,
            user,
            action="demo.seed.rejected",
            entity_type="user",
            entity_id=user.id,
            after={"reason": result.get("reason")},
            ip_address=_client_ip(request),
        )
        db.commit()
        # Use 409 Conflict — the state of the resource (user account)
        # prevents the operation.  Body still carries machine-readable
        # reason so the frontend can show the right message.
        raise HTTPException(status_code=409, detail=result)

    audit_service.record(
        db,
        user,
        action="demo.seed",
        entity_type="user",
        entity_id=user.id,
        after={
            "closes": int(result.get("closes", 0)),
            "inventory": int(result.get("inventory", 0)),
            "expenses": int(result.get("expenses", 0)),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    return result


@router.post("/clear")
@limiter.limit("3/hour")
def clear_demo(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Remove every row tagged ' · demo' for this user.  Rows the
    owner has typed by hand stay put because they lack the marker."""
    result = clear_for_user(db, user)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result)

    deleted = result.get("deleted") or {}
    audit_service.record(
        db,
        user,
        action="demo.clear",
        entity_type="user",
        entity_id=user.id,
        after={
            "expenses": int(deleted.get("expenses", 0)),
            "closes": int(deleted.get("closes", 0)),
            "inventory": int(deleted.get("inventory", 0)),
            "expense_cats": int(deleted.get("expense_cats", 0)),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    return result
