"""
Bookkeeping export endpoints — produce a CSV that imports cleanly into
Dinero / Billy / e-conomic / generic.

Every endpoint streams a binary file response. No data is mutated; this
router is read-only.
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.bookkeeping_export import FORMATS

router = APIRouter()


@router.get("/formats")
def list_formats(_: User = Depends(get_current_user)):
    """Available export formats — used to render the dropdown in the UI."""
    return [
        {"id": k, "label": v["label"], "instructions": v["instructions"]}
        for k, v in FORMATS.items()
    ]


@router.get("/{format_id}")
def export_bookkeeping(
    format_id: str,
    start: date | None = Query(None),
    end: date | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Download bookkeeping CSV for the given range.

    Defaults: start = first of last month, end = today.
    """
    fmt = FORMATS.get(format_id)
    if not fmt:
        raise HTTPException(status_code=404, detail="Unknown format")

    today = date.today()
    if not end:
        end = today
    if not start:
        # Default: last calendar month → today
        first_of_this_month = today.replace(day=1)
        last_month_end = first_of_this_month - timedelta(days=1)
        start = last_month_end.replace(day=1)
    if start > end:
        raise HTTPException(status_code=400, detail="start must be before end")

    body = fmt["exporter"](user, db, start, end)
    filename = (
        f"bonbox-{format_id}-{start.isoformat()}-to-{end.isoformat()}.{fmt['ext']}"
    )
    return Response(
        content=body,
        media_type=fmt["mime"],
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Don't cache — every export is a fresh snapshot
            "Cache-Control": "no-store",
        },
    )
