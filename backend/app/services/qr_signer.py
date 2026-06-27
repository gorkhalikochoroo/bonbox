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
_SUB_GAVEKORT = "bonbox-gavekort"

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


class GavekortKeyUnset(RuntimeError):
    """Raised when GAVEKORT_SIGNING_KEY is unset in production.

    A gavekort is REDEEMABLE MONETARY VALUE. Unlike ticket/booking tokens —
    which fall back to SECRET_KEY in dev — the gavekort key MUST be set in
    production. We FAIL CLOSED rather than fall back, so a redeemable bearer
    secret is never signed/hashed under the session-auth key (which has a
    different rotation cadence + blast radius). The router maps this to a
    503 (service misconfigured) so issuance/redemption refuse loudly.
    """


def gavekort_signing_key() -> str:
    """Return the key used to sign gavekort QR tokens + HMAC gavekort codes.

    Resolution:
      • GAVEKORT_SIGNING_KEY env var (its OWN key — never shared with
        ticket/booking/session signing). Distinct sub claim too.
      • Outside production with the key unset → fall back to SECRET_KEY with
        a one-time WARNING so a local dev stack stays usable.
      • In ENVIRONMENT=production with the key unset → RAISE GavekortKeyUnset
        (fail closed). We do NOT fall back to SECRET_KEY for redeemable value.

    Shared by qr_signer (sign/verify_gavekort) AND gavekort_codes.hash_code so
    the QR token and the stored code_hash are bound to the same dedicated key.
    """
    key = (os.environ.get("GAVEKORT_SIGNING_KEY") or "").strip()
    if key:
        return key
    # Unset. In production this is fatal — fail closed.
    if (getattr(settings, "ENVIRONMENT", "development") or "").lower() == "production":
        raise GavekortKeyUnset(
            "GAVEKORT_SIGNING_KEY is not set in production. Refusing to sign "
            "or hash redeemable gavekort value under the session SECRET_KEY. "
            "Set GAVEKORT_SIGNING_KEY in the deploy environment."
        )
    if not getattr(gavekort_signing_key, "_warned", False):
        logger.warning(
            "qr_signer: GAVEKORT_SIGNING_KEY env var not set; falling back to "
            "SECRET_KEY for DEV only. Production fails closed — set the "
            "dedicated env var before launch.",
        )
        gavekort_signing_key._warned = True  # type: ignore[attr-defined]
    return settings.SECRET_KEY


def sign_gavekort(*, gift_card_id: str, user_id: str, jti: str,
                  expires_at: datetime | None = None) -> str:
    """Sign a gavekort QR JWT.

    Claims: {gid, uid, jti, sub: "bonbox-gavekort", exp}. Algorithm pinned
    to HS256. The token is the QR payload the buyer scans at redemption; the
    router ALWAYS re-checks gid→a real GiftCard row owned by uid (JWT validity
    is layer 1 — the DB row is the source of truth for balance/status).

    Args:
      gift_card_id: UUID-stringified GiftCard.id (`gid` claim).
      user_id:      UUID-stringified owner User.id (`uid` claim, tenant bind).
      jti:          unique token id (replay/uniqueness anchor).
      expires_at:   the card's expiry; the token exp is set to it (+ a small
                    grace) or, if None, far in the future (a no-expiry card).

    Raises GavekortKeyUnset in production with the key unset (fail closed).
    """
    if expires_at is None:
        exp = datetime.now(timezone.utc) + timedelta(days=3650)
    else:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        exp = expires_at + timedelta(hours=_TICKET_GRACE_HOURS)
    payload = {
        "gid": str(gift_card_id),
        "uid": str(user_id),
        "jti": str(jti),
        "sub": _SUB_GAVEKORT,
        "exp": exp,
    }
    return jwt.encode(payload, gavekort_signing_key(), algorithm=_ALGORITHM)


def verify_gavekort(token: str) -> dict[str, Any] | None:
    """Verify a gavekort QR JWT.

    Returns the decoded claims dict on success, or None on any failure (bad
    sig, expired, wrong subject, missing gid/uid). The router MUST also verify
    gid→a real GiftCard row whose user_id == uid before honoring the token.

    In production with GAVEKORT_SIGNING_KEY unset this raises GavekortKeyUnset
    (fail closed) rather than verifying under SECRET_KEY.
    """
    if not token or not isinstance(token, str):
        return None
    try:
        claims = jwt.decode(token, gavekort_signing_key(), algorithms=[_ALGORITHM])
    except JWTError as exc:
        logger.debug("qr_signer.verify_gavekort: jwt decode failed: %s", exc)
        return None
    if claims.get("sub") != _SUB_GAVEKORT:
        logger.debug("qr_signer.verify_gavekort: wrong subject claim")
        return None
    if not claims.get("gid") or not claims.get("uid"):
        return None
    return claims


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
