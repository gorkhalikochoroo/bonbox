"""Visitor-facing gavekort endpoint (no auth) — the /g/<token> surface.

  • GET /api/public/gavekort/{token}  — the recipient's live gift-card page

This is what the BUYER walks away with: a no-login link/QR that shows the
LIVE saldo (re-checked on every load, so it self-updates as the card is
spent — the #1 thing a paper gavekort gets wrong) plus the venue it's
redeemed at. The token IS the signed QR JWT (BB1.G.<jwt>) the owner handed
over; possession of it is the bearer credential, exactly like the QR.

MULTI-BARRIER (mirrors public_reservations.py):
  L1  no auth by design — the signed token is the credential.
  L2  tenant scope re-derived: the card is loaded by gid AND uid FROM THE
      TOKEN's claims, never from a URL-supplied id. A forged/cross-tenant gid
      can't surface another owner's card.
  L3  token shape validated by verify_gavekort (sub/gid/uid/sig/exp).
  L4  per-IP rate limit (read-only, generous).
  L5  PII-MINIMAL: only {business_name, business_type, beløb, saldo, status,
      udløber, voucher_class, code_last4} leave the building. The recipient's
      name, the owner's internal note, the code_hash, and ANY buyer
      phone/email are never selected, never serialised.
  L6  IDOR-safe 404 on any verify/lookup miss — never leak existence.
  L9  503 (generic) if the signing key is unset in prod (fail-closed) —
      never fall back to SECRET_KEY for a value-bearing token.
  L10 honest read-only: this page NEVER redeems, NEVER moves money. It is a
      mirror of the ledger-reconciled balance.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.gift_card import GiftCard
from app.models.user import User
from app.services.qr_signer import GavekortKeyUnset, verify_gavekort

logger = logging.getLogger(__name__)

router = APIRouter()

# Read-only public endpoint — generous per-IP brake (see gavekort.py note on
# why explicit decorators fire even though SlowAPIMiddleware is unregistered).
limiter = Limiter(key_func=get_remote_address)

# The envelope prefix the owner's QR carries. The signed JWT is everything
# after it; verify_gavekort expects the bare JWT.
_ENVELOPE_PREFIX = "BB1.G."


def _strip_envelope(token: str) -> str:
    """`BB1.G.<jwt>` → `<jwt>`. Tolerates a bare JWT (no prefix) too."""
    if token and token.startswith(_ENVELOPE_PREFIX):
        return token[len(_ENVELOPE_PREFIX):]
    return token


def _effective_status(card: GiftCard, now: datetime) -> str:
    """Lazily resolve 'expired' on read so the recipient's link reflects a
    past expiry the instant they open it — without mutating the row here."""
    if card.status == "active" and card.expires_at is not None:
        exp = card.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= now:
            return "expired"
    return card.status


@router.get("/{token}")
@limiter.limit("60/minute")
def public_gavekort(request: Request, token: str = Path(..., max_length=2048),
                    db: Session = Depends(get_db)):
    # L3 — verify the signed token. None on any failure (bad sig / wrong
    # subject / missing claims / expired). GavekortKeyUnset only in prod with
    # the key unset → fail closed with a generic 503 (never SECRET_KEY).
    try:
        claims = verify_gavekort(_strip_envelope(token))
    except GavekortKeyUnset:
        logger.error("public_gavekort: signing key unset in production — refusing.")
        raise HTTPException(status_code=503, detail={"error": "gavekort_unconfigured"})

    if not claims:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    gid = claims.get("gid")
    uid = claims.get("uid")
    if not gid or not uid:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    # L2/L6 — re-derive the card from the TOKEN's gid AND uid. A card only
    # surfaces if BOTH match, so a forged gid can't read another tenant's row.
    card = (
        db.query(GiftCard)
        .filter(GiftCard.id == gid, GiftCard.user_id == uid)
        .first()
    )
    if card is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    # A voided card is gone — don't render a "balance" the owner cancelled.
    if card.status == "voided":
        raise HTTPException(status_code=410, detail={"error": "voided"})

    now = datetime.now(timezone.utc)
    status = _effective_status(card, now)

    # L5 — the venue name the recipient redeems at. Public trading name first,
    # legal company_name as fallback. Resolve via a tenant-scoped owner read;
    # never select the owner's PII.
    owner = db.query(User).filter(User.id == card.user_id).first()
    business_name = (
        getattr(owner, "business_name", None) if owner else None
    ) or "BonBox"
    business_type = (getattr(owner, "business_type", None) if owner else None) or "restaurant"

    return {
        "business_name": business_name,
        "business_type": business_type,
        "face_value_minor": int(card.face_value_minor),
        # The LIVE saldo — reconciled to the ledger on every redeem. This is the
        # whole point of the page: it self-updates as the card is spent.
        "balance_minor": int(card.balance_minor),
        "status": status,                       # active | expired | redeemed
        "voucher_class": card.voucher_class,
        "code_last4": card.code_last4,          # a "…AB3K" hint, not secret
        "expires_at": card.expires_at.isoformat() if card.expires_at else None,
    }
