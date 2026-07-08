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

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.diagnostics_service import run_diagnostics

router = APIRouter()

# Public beacon endpoint needs its own limiter (auth endpoints elsewhere use
# their own). SlowAPIMiddleware is registered app-wide, so this enforces.
_limiter = Limiter(key_func=client_ip)

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


# ── Client-error beacon ──────────────────────────────────────────────
# The one thing that could NOT be caught server-side: a broken/stale
# frontend deploy (Vercel serving an index that references a chunk hash it
# no longer builds) dead-ends users at the ErrorBoundary and we never hear
# about it. This public, unauthenticated beacon lets the app phone home when
# it crashes in the browser, so the operator sees "route X is throwing a
# chunk-load error on build Y across N devices" in the existing super-admin
# error panel (rows land as method=CLIENT).
#
# Red-lines: minimal-PII (6 bounded fields, no body/token/financial data,
# UA read server-side from the request — never trusted from the payload),
# rate-limited, and fail-soft (ALWAYS 204, never 500 — a reporting endpoint
# that can itself error is worse than useless).
_VALID_KINDS = {"chunk_load", "render", "unhandled", "route", "other"}


class ClientErrorIn(BaseModel):
    route: str = Field("", max_length=200)
    message: str = Field("", max_length=500)
    kind: str = Field("other", max_length=40)
    build_id: str = Field("", max_length=60)
    chunk: str = Field("", max_length=160)


@router.post("/client-error", status_code=204)
@_limiter.limit("10/minute")
def report_client_error(
    payload: ClientErrorIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Fire-and-forget crash beacon from the browser. Never raises."""
    try:
        from app.models.error_log import ErrorLog

        kind = payload.kind if payload.kind in _VALID_KINDS else "other"
        # Pack build/chunk into the message so the existing panel shows them
        # without a schema change (stale-deploy skew = build_id != server build).
        parts = [(payload.message or "").strip()[:400]]
        if payload.build_id:
            parts.append(f"build={payload.build_id[:60]}")
        if payload.chunk:
            parts.append(f"chunk={payload.chunk[:160]}")
        msg = " | ".join(p for p in parts if p)

        ua = (request.headers.get("user-agent") or "")[:500]
        try:
            ip = (get_remote_address(request) or "")[:64]
        except Exception:
            ip = ""

        db.add(ErrorLog(
            method="CLIENT",
            path=(payload.route or "")[:500],
            status_code=0,               # 0 = client-side, not an HTTP status
            error_type=f"client:{kind}"[:100],
            message=msg or None,
            user_agent=ua or None,
            ip_address=ip or None,
        ))
        db.commit()
    except Exception:
        # Fail-soft: swallow everything. The beacon must never surface an
        # error to the crashing client (it's already having a bad day).
        try:
            db.rollback()
        except Exception:
            pass
    return Response(status_code=204)
