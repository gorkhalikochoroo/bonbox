"""
Bookkeeping export endpoints — produce a CSV that imports cleanly into
Dinero / Billy / e-conomic / generic.

Every endpoint streams a binary file response. No data is mutated; this
router is read-only.

Multi-layer defense:
  - Layer 1: input validation (date range sanity)
  - Layer 2: try/except around the exporter so a single bad row doesn't 503
  - Layer 3: explicit error JSON (200 with _error or 422) — easier for the
    frontend to handle than an opaque 503 from Render
"""

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.bookkeeping_export import FORMATS

router = APIRouter()
log = logging.getLogger("bonbox.exports")

# Hard cap on date range — protects against accidental year-long exports
# that would time out on Render's worker timeout (≈ 30s).
_MAX_DAYS = 366

# Rate limit — bookkeeping exports are heavy and unauth-bypassable scanners
# could hammer this endpoint. 10/min per IP is more than any real user needs.
limiter = Limiter(key_func=get_remote_address)


@router.get("/formats")
def list_formats(_: User = Depends(get_current_user)):
    """Available export formats — used to render the dropdown in the UI."""
    return [
        {"id": k, "label": v["label"], "instructions": v["instructions"]}
        for k, v in FORMATS.items()
    ]


@router.get("/{format_id}")
@limiter.limit("10/minute")
def export_bookkeeping(
    request: Request,
    format_id: str,
    start: date | None = Query(None),
    end: date | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Download bookkeeping CSV for the given range.

    Defaults: start = first of last month, end = today.

    Multi-layer defense:
      - Validates format_id, date order, and range cap before touching DB.
      - Wraps the exporter in try/except — if the CSV writer hits a bad row,
        we return a structured 422 with a recoverable message instead of 503.
      - Errors return JSON, success returns binary CSV — frontend distinguishes
        by content-type.
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

    days = (end - start).days
    if days > _MAX_DAYS:
        return JSONResponse(
            status_code=422,
            content={
                "detail": f"Date range too large ({days} days). Max {_MAX_DAYS} days at a time — try a quarter or year-to-date.",
                "_error": True,
                "_recoverable": True,
            },
        )

    try:
        body = fmt["exporter"](user, db, start, end)
    except Exception as e:
        log.exception(
            "Export failed for user=%s format=%s range=%s..%s: %s",
            user.id, format_id, start, end, e,
        )
        return JSONResponse(
            status_code=422,
            content={
                "detail": (
                    "Could not generate the export. This usually means a bad row "
                    "in your sales or expenses for the chosen range. Try a shorter "
                    "range and we'll log the issue for fixing."
                ),
                "_error": True,
                "_recoverable": True,
            },
        )

    if body is None or len(body) == 0:
        # Defense: don't ship a 0-byte file as a "success"
        return JSONResponse(
            status_code=422,
            content={
                "detail": "No sales or expenses found in the selected range.",
                "_error": True,
                "_recoverable": True,
            },
        )

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
