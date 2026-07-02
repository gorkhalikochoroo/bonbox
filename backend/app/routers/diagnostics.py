"""Diagnostics — the read-only "Needs du nu" action queue.

GET /api/diagnostics/needs-you → the few things that need the owner now, in
order, each with a deep-link to the exact spot. Strictly read-only (see
diagnostics_service): it observes and routes, never mutates or auto-resolves.

`skip` is an optional CSV of `code:YYYY-MM-DD` tokens the owner dismissed
(client-persisted — the server stores nothing). It must reach the detectors
rather than being filtered client-side because the close detectors are
worst-only/oldest-only: hiding the worst finding client-side would silently
mask every other broken close behind it, so the skip goes into the scan and
the next-worst surfaces instead. Malformed tokens are ignored (fail-soft),
and only date-anchored codes are skippable.
"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.diagnostics_service import run_diagnostics

router = APIRouter()

# Only date-anchored findings may be skipped; the ongoing-condition codes
# (stale_bank_feed, unconfirmed_reservations) are snoozed client-side so a
# persisting problem resurfaces.
_SKIPPABLE = {"close_missing", "stale_draft_close", "close_unreconciled"}
_MAX_SKIP_TOKENS = 60


def _parse_skip(raw: str) -> set[tuple[str, str]]:
    skipped: set[tuple[str, str]] = set()
    for token in raw.split(",")[:_MAX_SKIP_TOKENS]:
        code, _, iso = token.strip().partition(":")
        if code not in _SKIPPABLE or not iso:
            continue
        try:
            date.fromisoformat(iso)
        except ValueError:
            continue
        skipped.add((code, iso))
    return skipped


@router.get("/needs-you")
def needs_you(
    skip: str = Query("", max_length=2000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    findings = run_diagnostics(db, user, skip=_parse_skip(skip))
    return {"findings": findings}
