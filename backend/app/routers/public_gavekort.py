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
import html as _html
import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.business_profile import BusinessProfile
from app.models.gift_card import GiftCard
from app.models.gift_card_order import GiftCardOrder
from app.models.user import User
from app.services.qr_signer import GavekortKeyUnset, verify_gavekort
from app.utils.time import utc_now

# A conservative email shape. `[^\s@]` already forbids whitespace — including the
# newlines/CRs an attacker would need for header injection into a later
# `to:`/`reply_to:` — and we additionally reject any control character. Not a
# full RFC 5322 validator (we don't need one); a gate that the stored address is
# safe to hand to the mail API.
_EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,60}$")

# Per-owner backpressure for the UNAUTHENTICATED buy POST (spam-awareness red
# line): collapse a refresh-burst of the SAME request, and cap how many pending
# orders one owner can accrue per hour so a flood can't bomb their inbox / bloat
# the table. The per-IP @limiter is the first brake; these are the second.
_ORDER_DEDUP_MINUTES = 10
_ORDER_PENDING_WINDOW_HOURS = 1
_ORDER_PENDING_MAX_PER_WINDOW = 30

logger = logging.getLogger(__name__)

router = APIRouter()

# Read-only public endpoint — generous per-IP brake (see gavekort.py note on
# why explicit decorators fire even though SlowAPIMiddleware is unregistered).
limiter = Limiter(key_func=client_ip)

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


# ═════════════════════════════════════════════════════════════════════
# /buy/<slug> — "order online, owner collects" (the red-line-safe purchase)
#
# The customer REQUESTS a gavekort; the owner confirms payment out-of-band
# and issues it (owner side, gavekort.py). This surface NEVER takes a card
# number, never moves money, never reveals a code — it only logs a request
# and emails the owner. Honest framing throughout: "request → the business
# confirms your payment → your gavekort is emailed".
# ═════════════════════════════════════════════════════════════════════

# Platform amount defaults (integer øre) — mirror gavekort.py. The owner can
# narrow these per-business in settings.
_ORDER_MIN_MINOR_DEFAULT = 5_000        # 50 kr.
_ORDER_MAX_MINOR_DEFAULT = 500_000      # 5,000 kr.


class OrderCreateBody(BaseModel):
    amount_minor: int = Field(gt=0, le=100_000_000)
    buyer_name: str | None = Field(default=None, max_length=120)
    buyer_email: str = Field(min_length=3, max_length=255)
    recipient_name: str | None = Field(default=None, max_length=120)
    message: str | None = Field(default=None, max_length=280)
    voucher_class: str = Field(default="mpv", pattern="^(mpv|spv)$")


def _kr(minor: int) -> str:
    """da-DK kr. string for an øre amount — '500000' → '5.000,00'."""
    s = f"{int(minor) / 100:,.2f}"           # en-US grouping: 5,000.00
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def _read_order_settings(profile: BusinessProfile) -> tuple[int, int, str | None]:
    """(min, max, instructions) with platform defaults. Tolerant of bad JSON."""
    raw = getattr(profile, "gavekort_order_settings_json", None)
    data: dict = {}
    if raw:
        try:
            import json
            data = json.loads(raw) or {}
        except Exception:  # noqa: BLE001
            data = {}
    mn = int(data.get("min_amount_minor") or _ORDER_MIN_MINOR_DEFAULT)
    mx = int(data.get("max_amount_minor") or _ORDER_MAX_MINOR_DEFAULT)
    if mx < mn:
        mn, mx = _ORDER_MIN_MINOR_DEFAULT, _ORDER_MAX_MINOR_DEFAULT
    instr = (data.get("instructions") or "").strip()[:500] or None
    return mn, mx, instr


def _resolve_buy_owner(db: Session, slug: str) -> tuple[BusinessProfile, User]:
    """slug → (profile, owner) ONLY when online orders are enabled. 410 (a
    closed-not-found shape) otherwise — never leak which slugs exist."""
    profile = (
        db.query(BusinessProfile)
        .filter(
            BusinessProfile.gavekort_slug == slug,
            BusinessProfile.gavekort_orders_enabled.is_(True),
        )
        .first()
    )
    if profile is None:
        raise HTTPException(status_code=410, detail={"error": "orders_closed"})
    owner = db.query(User).filter(User.id == profile.user_id).first()
    if owner is None:
        raise HTTPException(status_code=410, detail={"error": "orders_closed"})
    return profile, owner


def _notify_owner_new_order(owner: User, order: GiftCardOrder) -> None:
    """Best-effort email to the OWNER when a customer requests a gavekort.
    All buyer-supplied strings are HTML-escaped — they land in the owner's
    inbox, so they must never carry markup/script. Never blocks the request."""
    to = (getattr(owner, "email", None) or "").strip()
    if not to:
        return
    try:
        from app.services.email_service import send_email
        biz = _html.escape(getattr(owner, "business_name", None) or "BonBox")
        kr = _kr(order.amount_minor)
        buyer = _html.escape(order.buyer_name or "Ukendt")
        buyer_email = _html.escape(order.buyer_email or "")
        recip = f" til {_html.escape(order.recipient_name)}" if order.recipient_name else ""
        msg = (
            f"<p><strong>Besked:</strong> {_html.escape(order.message)}</p>"
            if order.message else ""
        )
        html = (
            f"<p><strong>Ny gavekort-bestilling via din side</strong></p>"
            f"<p style=\"font-size:20px;font-weight:700\">{kr} kr.{recip}</p>"
            f"<p>Køber: {buyer} · {buyer_email}</p>"
            f"{msg}"
            f"<p>Bekræft betalingen på din egen måde og udsted gavekortet i "
            f"BonBox — så sender vi linket til køberen. BonBox håndterer ikke "
            f"selve betalingen.</p>"
        )
        send_email(
            to=to,
            subject=f"{getattr(owner, 'business_name', None) or 'BonBox'} — ny gavekort-bestilling: {kr} kr.",
            html=html,
            reply_to=(order.buyer_email or None),
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("gavekort order owner-notify failed: %s", exc)


@router.get("/buy/{slug}")
@limiter.limit("60/minute")
def public_buy_page(request: Request, slug: str = Path(..., max_length=80),
                    db: Session = Depends(get_db)):
    """Buy-page data: venue + amount bounds + the owner's payment instructions.
    NEVER reveals codes/balances of any existing card — this is a fresh order."""
    profile, owner = _resolve_buy_owner(db, slug)
    mn, mx, instr = _read_order_settings(profile)
    return {
        "business_name": getattr(owner, "business_name", None) or "BonBox",
        "business_type": getattr(owner, "business_type", None) or "restaurant",
        "min_amount_minor": mn,
        "max_amount_minor": mx,
        "instructions": instr,
    }


@router.post("/buy/{slug}", status_code=201)
@limiter.limit("10/minute")
def public_create_order(body: OrderCreateBody, request: Request,
                        slug: str = Path(..., max_length=80),
                        db: Session = Depends(get_db)):
    """Log a PENDING request. No card minted, no code revealed, no money moved
    — the owner confirms payment and issues. The buyer is told exactly that."""
    profile, owner = _resolve_buy_owner(db, slug)
    mn, mx, _instr = _read_order_settings(profile)

    amt = int(body.amount_minor)
    if amt < mn or amt > mx:
        raise HTTPException(status_code=422, detail={"error": "amount_out_of_range"})

    email = (body.buyer_email or "").strip()
    # Reject anything that isn't a clean, single-line address — the stored value
    # is later handed to send_email(to=...) / reply_to, so a newline/control char
    # must never slip through (header-injection hardening).
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail={"error": "invalid_email"})

    now = utc_now()

    # Dedup a refresh-burst: an identical (owner, email, amount) pending request
    # within the window is treated as the same order — no extra row, no extra
    # owner email. The buyer still gets the same honest "we'll confirm" ack.
    dup = (
        db.query(GiftCardOrder.id)
        .filter(
            GiftCardOrder.user_id == owner.id,
            GiftCardOrder.status == "pending",
            GiftCardOrder.buyer_email == email,
            GiftCardOrder.amount_minor == amt,
            GiftCardOrder.created_at >= now - timedelta(minutes=_ORDER_DEDUP_MINUTES),
        )
        .first()
    )
    if dup is None:
        # Per-owner backpressure: cap how many pending orders one owner accrues
        # per hour so an unauthenticated flood can't bomb their inbox / bloat
        # the table (spam-awareness red line — the per-IP brake is layer one).
        recent = (
            db.query(func.count(GiftCardOrder.id))
            .filter(
                GiftCardOrder.user_id == owner.id,
                GiftCardOrder.status == "pending",
                GiftCardOrder.created_at >= now - timedelta(hours=_ORDER_PENDING_WINDOW_HOURS),
            )
            .scalar()
        ) or 0
        if recent >= _ORDER_PENDING_MAX_PER_WINDOW:
            raise HTTPException(status_code=429, detail={"error": "too_many_orders"})

        order = GiftCardOrder(
            user_id=owner.id,
            amount_minor=amt,
            voucher_class=body.voucher_class,
            buyer_name=(body.buyer_name or "").strip()[:120] or None,
            buyer_email=email[:255],
            recipient_name=(body.recipient_name or "").strip()[:120] or None,
            message=(body.message or "").strip()[:280] or None,
            status="pending",
        )
        db.add(order)
        db.commit()
        db.refresh(order)
        _notify_owner_new_order(owner, order)

    # Honest confirmation — NO card, NO code. The buyer waits for the owner.
    # (Identical whether this was a fresh order or a deduped refresh.)
    return {
        "ok": True,
        "business_name": getattr(owner, "business_name", None) or "BonBox",
        "buyer_email": email,
    }


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
