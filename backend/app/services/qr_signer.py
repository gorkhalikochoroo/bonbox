"""QR signing + booking-token JWT helpers.

Per `docs/event-booking-product-spec.md` §5.3 + §7 L1. Two small JWT
families that share signing infrastructure:

  • Ticket QR    — signed payload encoded inside the QR image.
                   `{tid, eid, exp, sub: "bonbox-ticket"}`
                   Exp = event.ends_at + 6h.
                   Signed with TICKET_SIGNING_KEY env var.

  • Booking token — short-lived (24h) token returned to the visitor
                   after POST /api/public/bookings so their SPA can
                   poll GET /api/public/bookings/{id} without user
                   auth. `{bid, sub: "bonbox-booking", exp}`.
                   Signed with BOOKING_TOKEN_KEY env var.

Why two keys (not one):
  • Ticket QRs are long-lived (event-day + 6h grace) and end up on
    visitors' screens / printed. Booking tokens are short-lived
    session tokens. Rotating one shouldn't invalidate the other.

Fallback when env vars are unset:
  • In development we fall back to `settings.SECRET_KEY` so the local
    stack stays usable. We log a WARNING (the operator sees it on boot)
    so production never silently relies on this. A separate prod-config
    test (out of scope for this module) asserts the env vars are set
    when ENVIRONMENT=production.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt

from app.config import settings

logger = logging.getLogger(__name__)

# Algorithm — match the rest of the codebase (auth.py uses HS256).
_ALGORITHM = "HS256"

# Subject claims — distinct so a leaked ticket-JWT can't be replayed
# as a booking-poll token and vice-versa. Verifier always checks the
# `sub` claim matches the expected use.
_SUB_TICKET = "bonbox-ticket"
_SUB_BOOKING = "bonbox-booking"

# Grace window past event end during which the QR remains valid. Lets
# late arrivals still scan in (spec §5.3 calls for ends_at + 6h).
_TICKET_GRACE_HOURS = 6


# ── Key resolution ───────────────────────────────────────────────────


def _ticket_signing_key() -> str:
    """Return the key used to sign + verify ticket QR JWTs.

    Resolves TICKET_SIGNING_KEY env var first; falls back to
    SECRET_KEY (with a WARNING) so dev stacks keep working without
    forcing operators to set a new env var on day one.
    """
    key = (os.environ.get("TICKET_SIGNING_KEY") or "").strip()
    if not key:
        if not getattr(_ticket_signing_key, "_warned", False):
            logger.warning(
                "qr_signer: TICKET_SIGNING_KEY env var not set; "
                "falling back to SECRET_KEY. Set the dedicated env var "
                "before production launch so ticket-signing rotates "
                "independently of session auth.",
            )
            _ticket_signing_key._warned = True  # type: ignore[attr-defined]
        return settings.SECRET_KEY
    return key


def _booking_token_key() -> str:
    """Return the key used to sign + verify visitor booking-token JWTs."""
    key = (os.environ.get("BOOKING_TOKEN_KEY") or "").strip()
    if not key:
        if not getattr(_booking_token_key, "_warned", False):
            logger.warning(
                "qr_signer: BOOKING_TOKEN_KEY env var not set; "
                "falling back to SECRET_KEY. Set the dedicated env var "
                "before production launch.",
            )
            _booking_token_key._warned = True  # type: ignore[attr-defined]
        return settings.SECRET_KEY
    return key


# ── Ticket QR — sign + verify ────────────────────────────────────────


def sign_ticket(*, ticket_id: str, event_id: str, event_ends_at: datetime | None) -> str:
    """Sign a ticket QR payload.

    Args:
      ticket_id: UUID-stringified Ticket.id (`tid` claim).
      event_id:  UUID-stringified Event.id (`eid` claim).
      event_ends_at: When the event ends (naive UTC). The token's exp
                    is set to this + 6h grace. If None (legacy events
                    without an explicit end), we default to +24h from
                    now — fail-soft so legacy data still gets a QR.

    Returns:
      The JWT string. Caller stores it on Ticket.qr_payload and
      renders the QR image at email-send / page-load time.
    """
    if event_ends_at is None:
        exp = datetime.now(timezone.utc) + timedelta(hours=24)
    else:
        # event_ends_at is naive UTC per utc_now() convention. Convert
        # to aware before adding the grace so the JWT exp claim is
        # interpreted consistently by jose.
        if event_ends_at.tzinfo is None:
            event_ends_at = event_ends_at.replace(tzinfo=timezone.utc)
        exp = event_ends_at + timedelta(hours=_TICKET_GRACE_HOURS)

    payload = {
        "tid": str(ticket_id),
        "eid": str(event_id),
        "sub": _SUB_TICKET,
        "exp": exp,
    }
    return jwt.encode(payload, _ticket_signing_key(), algorithm=_ALGORITHM)


def verify_ticket(token: str) -> dict[str, Any] | None:
    """Verify a ticket QR JWT.

    Returns the decoded claims dict on success, or None on any failure
    (bad sig, expired, wrong subject). Caller MUST also verify that
    `tid` matches a real Ticket row + `eid` matches that ticket's
    event_id — JWT validity is layer 1 of multi-barrier (the DB row
    is the source of truth for is_void / scanned_at).
    """
    if not token or not isinstance(token, str):
        return None
    try:
        claims = jwt.decode(token, _ticket_signing_key(), algorithms=[_ALGORITHM])
    except JWTError as exc:
        logger.debug("qr_signer.verify_ticket: jwt decode failed: %s", exc)
        return None
    if claims.get("sub") != _SUB_TICKET:
        logger.debug("qr_signer.verify_ticket: wrong subject claim")
        return None
    if not claims.get("tid") or not claims.get("eid"):
        return None
    return claims


# ── Booking token — sign + verify ────────────────────────────────────


def sign_booking_token(booking_id: str, ttl_hours: int = 24) -> str:
    """Sign a visitor-side booking-poll JWT.

    Returned in PublicBookingResponse.booking_token. The visitor's SPA
    stores it (sessionStorage, not a cookie) and sends it as the
    `?token=` query param on GET /api/public/bookings/{id}.
    """
    if ttl_hours <= 0:
        ttl_hours = 24
    payload = {
        "bid": str(booking_id),
        "sub": _SUB_BOOKING,
        "exp": datetime.now(timezone.utc) + timedelta(hours=ttl_hours),
    }
    return jwt.encode(payload, _booking_token_key(), algorithm=_ALGORITHM)


def verify_booking_token(token: str) -> str | None:
    """Verify a booking-poll JWT.

    Returns the booking_id (str) on success or None on any failure.
    The router MUST additionally check that the resolved booking
    matches the URL's booking_id (defense-in-depth — same pattern as
    the magic-link verifier).
    """
    if not token or not isinstance(token, str):
        return None
    try:
        claims = jwt.decode(token, _booking_token_key(), algorithms=[_ALGORITHM])
    except JWTError as exc:
        logger.debug("qr_signer.verify_booking_token: jwt decode failed: %s", exc)
        return None
    if claims.get("sub") != _SUB_BOOKING:
        return None
    bid = claims.get("bid")
    if not isinstance(bid, str) or not bid:
        return None
    return bid
