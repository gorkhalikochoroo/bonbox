"""
Per-user pattern endpoints — read + dismiss + feedback.

The detection itself runs server-side (services/owner_patterns.py). Users
cannot create patterns; they can only view, dismiss, mark-acted, and provide
👍 / 👎 feedback. The feedback column is the thesis instrument for RQ1.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.owner_pattern import OwnerPattern
from app.models.user import User
from app.services.auth import get_current_user
from app.services.owner_patterns import run_for_user

router = APIRouter()


class PatternOut(BaseModel):
    id: str
    pattern_type: str
    severity: str
    title: str
    detail: str
    suggested_action: str | None
    detected_at: str
    valid_until: str | None
    state: str
    feedback: str | None


class FeedbackBody(BaseModel):
    feedback: str  # "useful" | "not_useful"

    @field_validator("feedback")
    @classmethod
    def _v(cls, v: str) -> str:
        if v not in ("useful", "not_useful"):
            raise ValueError("feedback must be 'useful' or 'not_useful'")
        return v


def _serialize(p: OwnerPattern) -> PatternOut:
    return PatternOut(
        id=str(p.id),
        pattern_type=p.pattern_type,
        severity=p.severity,
        title=p.title,
        detail=p.detail,
        suggested_action=p.suggested_action,
        detected_at=p.detected_at.isoformat(),
        valid_until=p.valid_until.isoformat() if p.valid_until else None,
        state=p.state,
        feedback=p.feedback,
    )


@router.get("/active", response_model=list[PatternOut])
def list_active_patterns(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """All active (non-dismissed, non-expired) patterns for this owner."""
    rows = (
        db.query(OwnerPattern)
        .filter(
            OwnerPattern.user_id == user.id,
            OwnerPattern.state == "active",
        )
        .order_by(OwnerPattern.detected_at.desc())
        .all()
    )
    return [_serialize(r) for r in rows]


@router.get("", response_model=list[PatternOut])
def list_patterns(
    state: str | None = Query(None, description="active|dismissed|acted|expired"),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """All patterns for this owner with optional state filter."""
    q = db.query(OwnerPattern).filter(OwnerPattern.user_id == user.id)
    if state:
        q = q.filter(OwnerPattern.state == state)
    rows = q.order_by(OwnerPattern.detected_at.desc()).limit(limit).all()
    return [_serialize(r) for r in rows]


@router.post("/refresh")
def refresh_patterns(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Manually re-run pattern detection for the calling user. Cheap enough that
    we let users trigger it themselves — but the scheduled job runs nightly
    too.
    """
    new_count = run_for_user(user, db)
    return {"new_patterns": new_count}


def _get_owned(pattern_id: str, user: User, db: Session) -> OwnerPattern:
    """Fetch a pattern by id with strict ownership check."""
    p = (
        db.query(OwnerPattern)
        .filter(OwnerPattern.id == pattern_id, OwnerPattern.user_id == user.id)
        .first()
    )
    if not p:
        # Generic 404 — never reveals existence of patterns from other users
        raise HTTPException(status_code=404, detail="Not found")
    return p


@router.post("/{pattern_id}/dismiss")
def dismiss_pattern(
    pattern_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = _get_owned(pattern_id, user, db)
    p.state = "dismissed"
    db.commit()
    return {"ok": True}


@router.post("/{pattern_id}/acted")
def mark_pattern_acted(
    pattern_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = _get_owned(pattern_id, user, db)
    p.state = "acted"
    db.commit()
    return {"ok": True}


@router.post("/{pattern_id}/feedback")
def feedback_pattern(
    pattern_id: str,
    body: FeedbackBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    👍 / 👎 feedback. This is the thesis instrument for RQ1 (which patterns
    correlate with retention vs. which the user dismisses).
    """
    p = _get_owned(pattern_id, user, db)
    p.feedback = body.feedback
    p.feedback_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "feedback": body.feedback}
