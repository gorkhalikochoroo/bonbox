"""
Procedurebeskrivelse endpoints (Bogføringsloven § 6) — Task: Audit-Tryg S1.

Registered under /api/reports (see main.py), so the member-seat READ deny
prefix and owner-only report posture apply exactly as for the other revisor
artifacts. Flow:

  GET  /api/reports/procedure        → skabelon points + observed prefill +
                                       any saved answers (merged view for the
                                       wizard; recomputes prefill each call so
                                       "aflæst" facts stay current)
  PUT  /api/reports/procedure        → owner-confirmed answers (validated,
                                       bounded) → business_profiles.procedure_json
  GET  /api/reports/procedure/pdf    → Danish PDF from SAVED answers only
                                       (never from unconfirmed prefill), with
                                       doc-hash footer + L7 audit row

The PDF is never built from prefill directly: the owner must have SAVED
(= confirmed) the text first — we don't put words in the virksomhed's mouth.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import get_current_user
from app.services import procedure_service
from app.services.bonbox_pdf_kit import write_export_audit_row
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()


class ProcedureAnswers(BaseModel):
    answers: dict[str, str]


def _profile(db: Session, user: User) -> BusinessProfile | None:
    return (
        db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    )


@router.get("/procedure")
def get_procedure(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    profile = _profile(db, user)
    saved = procedure_service.load_saved(profile)
    return {
        "points": procedure_service.PROCEDURE_POINTS,
        "sections": procedure_service.SECTION_TITLES,
        "prefill": procedure_service.collect_prefill(db, user),
        "answers": (saved or {}).get("answers"),
        "saved_at": (saved or {}).get("saved_at"),
    }


@router.put("/procedure")
def save_procedure(
    payload: ProcedureAnswers,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        clean = procedure_service.validate_answers(payload.answers)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not any(v for v in clean.values()):
        raise HTTPException(status_code=422, detail="Beskrivelsen er tom")

    profile = _profile(db, user)
    if profile is None:
        profile = BusinessProfile(user_id=user.id)
        db.add(profile)

    saved_at = utc_now().isoformat()
    profile.procedure_json = json.dumps(
        {"answers": clean, "saved_at": saved_at}, ensure_ascii=False
    )
    db.commit()
    return {"saved_at": saved_at, "answers": clean}


@router.get("/procedure/pdf")
def procedure_pdf(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    profile = _profile(db, user)
    saved = procedure_service.load_saved(profile)
    if not saved or not saved.get("answers"):
        raise HTTPException(
            status_code=404,
            detail="Ingen procedurebeskrivelse gemt endnu — udfyld og gem først",
        )

    now = utc_now()
    # saved_at is ISO (yyyy-mm-dd…) — render Danish day-first in the document.
    saved_at_raw = str(saved.get("saved_at") or "")[:10]
    try:
        y, m, d = saved_at_raw.split("-")
        saved_at_da = f"{d}-{m}-{y}"
    except ValueError:
        saved_at_da = now.strftime("%d-%m-%Y")
    pdf = procedure_service.build_procedure_pdf(
        user=user,
        profile=profile,
        answers=saved["answers"],
        saved_at_str=saved_at_da,
        generated_at_str=now.strftime("%d-%m-%Y %H:%M"),
    )

    write_export_audit_row(
        db,
        user,
        doc_type="procedurebeskrivelse",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="procedurebeskrivelse-bonbox.pdf"',
        },
    )
