"""Smart Drift endpoints — read open findings, dismiss, mark applied.

The dashboard fetches open findings on mount and renders one calm banner
per finding. Owner taps "Apply" → frontend opens the relevant Smart
card pre-loaded; on save, we POST /smart-drift/{id}/apply to close the
finding. Owner taps "Not now" → we POST /smart-drift/{id}/dismiss with
a 14-day cooldown.

Multi-layer security:
  • Auth-gated (Depends(get_current_user)).
  • Tenant-scoped: all DB queries filter on user_id; cross-tenant
    finding_id silently 404s.
  • Service raises DriftFindingError → 422 with reason; never 500.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.smart_drift import (
    DriftFindingError,
    apply_finding,
    dismiss_finding,
    list_open_findings,
)

logger = logging.getLogger("bonbox.smart_drift_router")

router = APIRouter()


def _serialise(row):
    return {
        "id": str(row.id),
        "kind": row.kind,
        "title": row.title,
        "summary": row.summary,
        "payload": row.payload_json,
        "detected_at": row.detected_at.isoformat() if row.detected_at else None,
    }


@router.get("")
def list_findings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """All open (non-dismissed, non-applied) findings for this owner.

    Returns shape-stable {findings: [], count: 0} so the dashboard can
    safely .map() on a fresh account with no findings yet.
    """
    rows = list_open_findings(db, user=user)
    return {"findings": [_serialise(r) for r in rows], "count": len(rows)}


@router.post("/{finding_id}/dismiss")
def dismiss(
    finding_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        fid = uuid.UUID(finding_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid finding_id")
    try:
        row = dismiss_finding(db, user=user, finding_id=fid)
    except DriftFindingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("dismiss failed: %s", exc)
        raise HTTPException(status_code=500, detail="Could not dismiss") from exc
    return _serialise(row)


@router.post("/{finding_id}/apply")
def apply(
    finding_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark the finding as applied. The actual write to the operating
    profile is the frontend's job — it opens the Smart card and the
    owner saves. This endpoint just closes the finding so it doesn't
    keep nagging."""
    try:
        fid = uuid.UUID(finding_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid finding_id")
    try:
        row = apply_finding(db, user=user, finding_id=fid)
    except DriftFindingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("apply failed: %s", exc)
        raise HTTPException(status_code=500, detail="Could not apply") from exc
    return _serialise(row)
