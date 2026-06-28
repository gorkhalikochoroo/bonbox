"""Diagnostics — the read-only "Needs du nu" action queue.

GET /api/diagnostics/needs-you → the few things that need the owner now, in
order, each with a deep-link to the exact spot. Strictly read-only (see
diagnostics_service): it observes and routes, never mutates or auto-resolves.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.diagnostics_service import run_diagnostics

router = APIRouter()


@router.get("/needs-you")
def needs_you(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    findings = run_diagnostics(db, user)
    return {"findings": findings}
