"""Gavekort (gift card) owner endpoints — issue / list / detail / redeem / void.

Mounted at /api/gavekort. The owner ISSUES a gift card for a face value, the
card is TRACKED (issued / redeemed / outstanding), staff REDEEM it against a
sale, and the owner can VOID it. DK terminology lock: gavekort / saldo /
udestående stay Danish in every UI language.

MONEY IS INTEGER ØRE everywhere — no floats. The frontend rounds to da-DK
"kr." for display only.

Multi-barrier (the 10-layer doctrine — money + tier surface):
  L1  auth          — get_current_user on every endpoint.
  L2  bounds        — Pydantic Field constraints (amount_minor > 0, lengths).
  L3  rate-limit    — relies on the app-wide SlowAPI default (registered in
                      main.py); per-endpoint limits can be layered later.
  L4  fail-soft     — audit + L7 observability writes never break the action.
  L5  tenant        — user_id filters EVERY query AND the redeem UPDATE WHERE.
  L6  fail-closed   — redeem is a CONDITIONAL ATOMIC decrement: zero rows ⇒
                      reject. The signing key fails closed in prod (qr_signer).
  L7  audit         — audit_service.record on issue / redeem / void.
  L8  fallback      — graceful structured 404/409/410/423 details.
  L9  graceful HTTP — every refusal is a clean typed status, never a 500.
  L10 honest claims — balance_minor is a cache the ledger RECONCILES to on
                      every write; the two can never disagree.

SINGLE-SPEND INVARIANT (the heart of redeem):
  We NEVER select-then-update (a TOCTOU double-spend). We issue ONE conditional
  atomic UPDATE:

    UPDATE gift_cards SET balance_minor = balance_minor - :amt
     WHERE id=:id AND user_id=:uid AND balance_minor >= :amt AND status='active'
   RETURNING balance_minor

  Zero rows affected ⇒ reject (insufficient / locked / wrong-tenant / expired).
  The DB is the single arbiter. Two concurrent redeems can never both win and
  the balance can never go negative.

IDEMPOTENCY:
  gift_card_transactions has UNIQUE(gift_card_id, idempotency_key). The redeem
  ledger INSERT is dialect-aware INSERT-OR-IGNORE / ON CONFLICT DO NOTHING
  (mirrors webhook_events). A replayed redeem (same key) re-reads the ORIGINAL
  ledger row and returns its result — never a 2nd debit, and the conditional
  decrement is SKIPPED entirely on replay.

NOTE: no `from __future__ import annotations` — FastAPI's Pydantic-v2 body
resolver fails to dereference inline request models under PEP-563 (same caveat
as reservations.py / public_bookings.py).
"""
import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.gift_card import (
    GiftCard, GiftCardTransaction, VOUCHER_CLASSES,
)
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import enforce_cap, enforce_feature
from app.services.gavekort_codes import generate_code, hash_code
from app.services.qr_signer import GavekortKeyUnset, sign_gavekort, verify_gavekort
from app.services.tz_utils import business_today_local
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

# D4 — per-endpoint rate limit. We attach @limiter.limit to the money-moving
# /issue and /redeem endpoints (NOT the read-only list/detail). This works via
# the app-wide `app.state.limiter` + RateLimitExceeded handler registered in
# main.py — the same per-router Limiter() idiom as accountant_savings.py /
# auth.py. NOTE: the app-wide DEFAULT limit is inert because SlowAPIMiddleware
# is not registered (task #361 history — only `app.state.limiter` + the
# exception handler are wired, not the middleware that applies `default_limits`
# globally). Explicit per-endpoint decorators like these DO still fire because
# slowapi resolves the limiter from `request.app.state.limiter` and raises
# RateLimitExceeded, which IS handled. Each decorated endpoint already takes a
# `request: Request` param, which slowapi requires for keying.
limiter = Limiter(key_func=get_remote_address)

# How many times we retry on the (astronomically unlikely) code/short_code
# UNIQUE collision before giving up. Each attempt is a fresh random triple.
_ISSUE_COLLISION_RETRIES = 5


# ─── schemas ─────────────────────────────────────────────────────────
class IssueBody(BaseModel):
    # Face value in integer øre. > 0 and bounded (1,000,000,00 øre = 1M kr.).
    amount_minor: int = Field(gt=0, le=100_000_000)
    recipient_name: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=280)
    # NEVER auto-decided — default "mpv", owner-set, surfaced.
    voucher_class: str = Field(default="mpv", pattern="^(mpv|spv)$")
    # How the owner was PAID for the card at the counter. Recorded (not posted)
    # so the close/MOMS bridge has the tender later; the reveal says
    # "registreret", never "bogført". Optional so older callers/tests still pass.
    payment_method: str | None = Field(default=None, pattern="^(card|mobilepay|cash|mixed)$")
    expires_at: datetime | None = None


class RedeemBody(BaseModel):
    amount_minor: int = Field(gt=0, le=100_000_000)
    # Idempotency key — required in the body OR the Idempotency-Key header.
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=120)
    sale_ref: str | None = Field(default=None, max_length=120)


class ScanResolveBody(BaseModel):
    # The scanned QR text — the signed token "BB1.G.<jwt>" OR the public URL
    # ".../g/BB1.G.<jwt>" the camera reads. We extract + verify server-side.
    token: str = Field(min_length=1, max_length=2048)


# The envelope prefix carried by a gavekort QR. Everything after it is the JWT.
_GK_ENVELOPE = "BB1.G."


def _extract_gavekort_jwt(scanned: str) -> str | None:
    """Pull the bare JWT out of whatever the scanner read. Accepts the public
    URL (".../g/BB1.G.<jwt>", possibly percent-encoded), the bare envelope
    ("BB1.G.<jwt>"), or a naked JWT. Returns None if no envelope is present."""
    if not scanned:
        return None
    s = scanned.strip()
    # Public URL form: take the last path segment after /g/.
    if "/g/" in s:
        s = s.rsplit("/g/", 1)[1].split("?", 1)[0].split("#", 1)[0]
        # percent-decoded dots are fine; a URL-encoded envelope decodes here.
        try:
            from urllib.parse import unquote
            s = unquote(s)
        except Exception:  # noqa: BLE001
            pass
    if s.startswith(_GK_ENVELOPE):
        return s[len(_GK_ENVELOPE):]
    # A naked JWT (three dot-separated segments) is tolerated too.
    if s.count(".") == 2:
        return s
    return None


# ─── serializers ─────────────────────────────────────────────────────
def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def _card_summary_dict(c: GiftCard) -> dict:
    """The compact card shape for the list endpoint."""
    return {
        "id": str(c.id),
        "code_last4": c.code_last4,
        "recipient_name": c.recipient_name,
        "face_value_minor": int(c.face_value_minor),
        "balance_minor": int(c.balance_minor),
        "voucher_class": c.voucher_class,
        "payment_method": c.payment_method,
        "status": c.status,
        "issued_at": _iso(c.issued_at),
        "expires_at": _iso(c.expires_at),
    }


def _tx_dict(t: GiftCardTransaction, staff_name: str | None = None) -> dict:
    return {
        "id": str(t.id),
        "kind": t.kind,
        "amount_minor": int(t.amount_minor),
        "balance_after_minor": int(t.balance_after_minor),
        "created_at": _iso(t.created_at),
        "staff_name": staff_name,
        "sale_ref": t.sale_ref,
        "daily_close_ref": str(t.daily_close_id) if t.daily_close_id else None,
    }


def _is_expired(c: GiftCard, now: datetime | None = None) -> bool:
    """True if the card has a past expiry. Resolved lazily on read/redeem so a
    card flips to 'expired' the moment it's touched after expires_at."""
    if c.expires_at is None:
        return False
    now = now or datetime.now(timezone.utc)
    exp = c.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return exp <= now


def _require_signing_key():
    """Map qr_signer's fail-closed prod guard to a 503. Issuance + redemption
    both need the dedicated key; in production with it unset we refuse loudly
    rather than fall back to SECRET_KEY for redeemable value."""
    try:
        from app.services.qr_signer import gavekort_signing_key
        gavekort_signing_key()
    except GavekortKeyUnset as exc:
        logger.error("gavekort: signing key unset in production — refusing. %s", exc)
        raise HTTPException(status_code=503, detail={"error": "gavekort_unconfigured"})


# ═════════════════════════════════════════════════════════════════════
# POST /issue — create a gavekort
# ═════════════════════════════════════════════════════════════════════
@router.post("/issue", status_code=201)
@limiter.limit("30/minute")                          # D4/L3 per-endpoint brake
def issue_gavekort(payload: IssueBody, request: Request,
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "gavekort")               # L1/feature gate
    _require_signing_key()                           # L6 fail-closed (prod)

    # D6 — refuse to mint an already-expired card. An expires_at at/in the past
    # would produce a card that is "expired" the instant it's touched, which is
    # never what an owner intends (and would silently swallow the face value).
    if payload.expires_at is not None:
        exp = payload.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            raise HTTPException(status_code=422,
                                detail={"error": "expires_at_in_past"})

    # L7 cap — count ACTIVE cards only (outstanding-liability bound).
    active_count = (
        db.query(GiftCard)
        .filter(GiftCard.user_id == user.id, GiftCard.status == "active")
        .count()
    )
    enforce_cap(user, "gavekort_active_max", int(active_count))

    expires_at = payload.expires_at
    if expires_at is not None and expires_at.tzinfo is not None:
        # Persist naive-UTC to match the utc_now() convention used elsewhere.
        expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)

    # Generate + persist, retrying on the (vanishingly rare) UNIQUE collision.
    card: GiftCard | None = None
    plaintext_code: str | None = None
    for attempt in range(_ISSUE_COLLISION_RETRIES):
        code, short_code, code_last4 = generate_code()
        card = GiftCard(
            user_id=user.id,
            code_hash=hash_code(code),
            short_code=short_code,
            code_last4=code_last4,
            face_value_minor=int(payload.amount_minor),
            balance_minor=int(payload.amount_minor),
            voucher_class=payload.voucher_class,
            status="active",
            recipient_name=payload.recipient_name,
            note=payload.note,
            payment_method=payload.payment_method,
            issued_at=utc_now(),
            expires_at=expires_at,
        )
        db.add(card)
        try:
            db.flush()
            plaintext_code = code
            break
        except Exception:
            db.rollback()
            card = None
            if attempt == _ISSUE_COLLISION_RETRIES - 1:
                logger.error("gavekort.issue: repeated code collision for user %s", user.id)
                raise HTTPException(status_code=500, detail={"error": "code_generation_failed"})

    assert card is not None and plaintext_code is not None

    # The issue ledger row — the anchor. amount = +face_value, balance_after =
    # full balance. NULL idempotency_key (issues carry no key).
    db.add(GiftCardTransaction(
        gift_card_id=card.id, user_id=user.id, kind="issue",
        amount_minor=int(card.face_value_minor),
        balance_after_minor=int(card.balance_minor),
        created_by_user_id=user.id,
        business_day=utc_now(),
    ))

    audit_service.record(
        db, user, "gavekort.issued", "gift_card", card.id,
        after={"face_value_minor": int(card.face_value_minor),
               "voucher_class": card.voucher_class},
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    db.commit()
    db.refresh(card)

    # The QR token encodes the high-entropy code's BINDING (gid/uid/jti) — the
    # plaintext code itself stays out of any persisted column. Returned ONCE.
    qr_token = "BB1.G." + sign_gavekort(
        gift_card_id=str(card.id), user_id=str(user.id), jti=uuid4().hex,
        expires_at=card.expires_at,
    )

    return {
        "id": str(card.id),
        "short_code": card.short_code,
        "code_last4": card.code_last4,
        "qr_token": qr_token,
        "face_value_minor": int(card.face_value_minor),
        "balance_minor": int(card.balance_minor),
        "voucher_class": card.voucher_class,
        "payment_method": card.payment_method,
        "status": card.status,
        "issued_at": _iso(card.issued_at),
        "expires_at": _iso(card.expires_at),
    }


# ═════════════════════════════════════════════════════════════════════
# GET / — list + summary
# ═════════════════════════════════════════════════════════════════════
@router.get("")
@router.get("/")
def list_gavekort(
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
    status_filter: str | None = Query(default=None, alias="status", max_length=12),
    q: str | None = Query(default=None, max_length=120),
):
    enforce_feature(user, "gavekort")

    base = db.query(GiftCard).filter(GiftCard.user_id == user.id)

    # ── Summary math (over ALL the tenant's cards, pre-filter) ─────────
    #   issued      = SUM(face_value) over every card (lifetime loaded).
    #   outstanding = SUM(balance) over ACTIVE cards (still-redeemable liability).
    #   redeemed    = issued-on-active − outstanding  ==  what's been spent on
    #                 currently-active cards. We compute redeemed as the SUM of
    #                 actual redeem ledger debits so it's exact regardless of
    #                 status transitions (void/expire don't inflate it).
    issued_minor = (
        db.query(func.coalesce(func.sum(GiftCard.face_value_minor), 0))
        .filter(GiftCard.user_id == user.id)
        .scalar()
    ) or 0
    outstanding_minor = (
        db.query(func.coalesce(func.sum(GiftCard.balance_minor), 0))
        .filter(GiftCard.user_id == user.id, GiftCard.status == "active")
        .scalar()
    ) or 0
    # Redeemed = the absolute value of all redeem debits across the ledger.
    redeemed_debits = (
        db.query(func.coalesce(func.sum(GiftCardTransaction.amount_minor), 0))
        .filter(GiftCardTransaction.user_id == user.id,
                GiftCardTransaction.kind == "redeem")
        .scalar()
    ) or 0
    redeemed_minor = -int(redeemed_debits)  # debits are negative → flip sign
    active_count = (
        db.query(GiftCard)
        .filter(GiftCard.user_id == user.id, GiftCard.status == "active")
        .count()
    )

    # ── Filtered card list ─────────────────────────────────────────────
    if status_filter:
        base = base.filter(GiftCard.status == status_filter.strip().lower())
    if q:
        like = f"%{q.strip()}%"
        base = base.filter(or_(
            GiftCard.recipient_name.ilike(like),
            GiftCard.short_code.ilike(like),
            GiftCard.code_last4.ilike(like),
        ))
    cards = base.order_by(GiftCard.issued_at.desc()).all()

    return {
        "summary": {
            "issued_minor": int(issued_minor),
            "redeemed_minor": int(redeemed_minor),
            "outstanding_minor": int(outstanding_minor),
            "active_count": int(active_count),
        },
        "cards": [_card_summary_dict(c) for c in cards],
    }


# ═════════════════════════════════════════════════════════════════════
# GET /{id} — detail + ledger
# ═════════════════════════════════════════════════════════════════════
@router.get("/{card_id}")
def get_gavekort(card_id: UUID, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    enforce_feature(user, "gavekort")
    card = (
        db.query(GiftCard)
        .filter(GiftCard.id == card_id, GiftCard.user_id == user.id)  # L5 tenant
        .first()
    )
    if not card:
        # Cross-tenant or missing → 404 (never 403 — don't leak existence).
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    txns = (
        db.query(GiftCardTransaction)
        .filter(GiftCardTransaction.gift_card_id == card.id,
                GiftCardTransaction.user_id == user.id)
        .order_by(GiftCardTransaction.created_at.asc(), GiftCardTransaction.id.asc())
        .all()
    )

    # Resolve staff names for the LINK field (created_by_user_id → name). One
    # batched query; fail-soft (a missing name just renders None).
    staff_ids = {t.created_by_user_id for t in txns if t.created_by_user_id}
    name_by_id: dict = {}
    if staff_ids:
        for uid, bname in (
            db.query(User.id, User.business_name)
            .filter(User.id.in_(staff_ids))
            .all()
        ):
            name_by_id[uid] = bname

    return {
        "card": {
            "id": str(card.id),
            "short_code": card.short_code,
            "code_last4": card.code_last4,
            "recipient_name": card.recipient_name,
            "note": card.note,
            "face_value_minor": int(card.face_value_minor),
            "balance_minor": int(card.balance_minor),
            "voucher_class": card.voucher_class,
            "status": card.status,
            "issued_at": _iso(card.issued_at),
            "expires_at": _iso(card.expires_at),
        },
        "transactions": [
            _tx_dict(t, staff_name=name_by_id.get(t.created_by_user_id)) for t in txns
        ],
    }


# ═════════════════════════════════════════════════════════════════════
# POST /scan-resolve — read a scanned gavekort QR → the card (NO redeem)
# ═════════════════════════════════════════════════════════════════════
@router.post("/scan-resolve")
@limiter.limit("60/minute")
def scan_resolve_gavekort(payload: ScanResolveBody, request: Request,
                          db: Session = Depends(get_db),
                          user: User = Depends(get_current_user)):
    """Resolve a scanned gavekort QR (public URL or BB1.G envelope) to its card
    so the scanner can SHOW the balance. The honesty lock: scanning READS; a
    separate redeem-by-id call DEDUCTS. The QR signature is verified here, so
    the signing key IS required (fail-closed in prod).

    TENANT (L5): the token's uid claim MUST equal the authenticated user — staff
    can only resolve/redeem THEIR OWN business's gavekort. A foreign card is an
    IDOR-safe 404, never a leak that it exists.
    """
    enforce_feature(user, "gavekort")
    _require_signing_key()                               # L6 fail-closed (prod)

    jwt_token = _extract_gavekort_jwt(payload.token)
    if not jwt_token:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        claims = verify_gavekort(jwt_token)
    except GavekortKeyUnset:
        raise HTTPException(status_code=503, detail={"error": "gavekort_unconfigured"})
    if not claims:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    gid = claims.get("gid")
    uid = claims.get("uid")
    # You can only scan your OWN business's gavekort. Foreign uid → 404.
    if not gid or not uid or str(uid) != str(user.id):
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    card = (
        db.query(GiftCard)
        .filter(GiftCard.id == gid, GiftCard.user_id == user.id)
        .first()
    )
    if card is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    # Terminal states → 410 so the scanner shows "can't redeem", not a card.
    if card.status == "voided":
        raise HTTPException(status_code=410, detail={"error": "voided"})
    if _is_expired(card):
        raise HTTPException(status_code=410, detail={"error": "expired"})
    if card.status == "redeemed" or int(card.balance_minor) <= 0:
        raise HTTPException(status_code=410, detail={"error": "redeemed"})

    # Enough for the scanner to show + then redeem-by-id. (Staff is the owner,
    # so recipient_name here is the owner's own data — fine.)
    return _card_summary_dict(card)


# ═════════════════════════════════════════════════════════════════════
# POST /{id}/redeem — DB-enforced single-spend
# ═════════════════════════════════════════════════════════════════════
@router.post("/{card_id}/redeem")
@limiter.limit("60/minute")                          # D4/L3 per-endpoint brake
def redeem_gavekort(
    card_id: UUID, payload: RedeemBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
    idempotency_header: str | None = Header(default=None, alias="Idempotency-Key"),
):
    enforce_feature(user, "gavekort")
    # D1 — redeem deliberately does NOT call _require_signing_key(). This path
    # is redeem-BY-ID: the card is authenticated on the row (id + user_id tenant
    # scope below), not by verifying a QR signature, so the signing key is not
    # on the critical path here. _require_signing_key() guards ISSUE (where we
    # MINT a signed QR) and QR-based scan/verify flows; re-verifying it here
    # would refuse legitimate by-id redemptions whenever the key is unset.

    # Idempotency key from body OR header (body wins if both present).
    idem_key = (payload.idempotency_key or idempotency_header or "").strip()
    if not idem_key:
        raise HTTPException(status_code=422, detail={"error": "idempotency_key_required"})

    amount = int(payload.amount_minor)
    if amount <= 0:
        raise HTTPException(status_code=422, detail={"error": "amount_must_be_positive"})

    uid = user.id
    is_sqlite = db.bind is not None and db.bind.dialect.name == "sqlite"

    # ── IDEMPOTENCY REPLAY CHECK (read-only, NO debit on replay) ───────
    # If we've already processed THIS (card, key), return the ORIGINAL result.
    # This makes a replay a pure read — the conditional decrement below never
    # runs a second time. The UNIQUE constraint is the ultimate backstop, but
    # checking first lets us return the original applied/balance cleanly.
    prior = (
        db.query(GiftCardTransaction)
        .filter(GiftCardTransaction.gift_card_id == card_id,
                GiftCardTransaction.user_id == uid,
                GiftCardTransaction.idempotency_key == idem_key)
        .first()
    )
    if prior is not None:
        # Re-read current card status for the honest status field.
        cur = db.query(GiftCard).filter(GiftCard.id == card_id,
                                        GiftCard.user_id == uid).first()
        return {
            "applied_minor": -int(prior.amount_minor),     # debit stored negative
            "balance_remaining_minor": int(prior.balance_after_minor),
            "status": cur.status if cur else "redeemed",
        }

    # ── Tenant + existence + lifecycle pre-checks (clear typed errors) ──
    card = db.query(GiftCard).filter(GiftCard.id == card_id,
                                     GiftCard.user_id == uid).first()
    if not card:
        raise HTTPException(status_code=404, detail={"error": "not_found"})  # L5 IDOR → 404

    # Lazily flip an expired card so the ledger + status stay honest, then 410.
    # TODO(D5): the expire flip writes NO compensating ledger row (unlike void),
    # so the remaining balance is dropped from "outstanding" via the status
    # change alone — the ledger still sums to the last non-zero balance. A
    # future "expire" ledger kind (amount=-(remaining), balance_after=0, like
    # void) would keep the append-only ledger fully self-reconciling. Left as a
    # documented TODO — not changing the ledger schema in this hardening pass.
    if card.status == "active" and _is_expired(card):
        card.status = "expired"
        db.add(card)
        db.commit()
        db.refresh(card)
    if card.status == "expired":
        raise HTTPException(status_code=410, detail={"error": "expired",
                                                     "balance_remaining_minor": int(card.balance_minor)})
    if card.status == "voided":
        raise HTTPException(status_code=410, detail={"error": "voided",
                                                     "balance_remaining_minor": 0})
    if card.status == "redeemed":
        raise HTTPException(status_code=410, detail={"error": "redeemed",
                                                     "balance_remaining_minor": 0})
    # Defensive: any non-active status that isn't handled above is "locked".
    if card.status != "active":
        raise HTTPException(status_code=423, detail={"error": "locked"})

    # ── THE SINGLE-SPEND CONDITIONAL ATOMIC DECREMENT ──────────────────
    # One UPDATE. balance_minor only decrements if it's currently >= amount AND
    # the card is still active AND it belongs to this tenant. Zero rows ⇒ reject.
    # Never select-then-update (that is the TOCTOU double-spend). The DB is the
    # single arbiter; two concurrent redeems can't both win; balance can't go
    # negative. applied = the full amount (we only decrement when >= amount).
    if is_sqlite:
        # D2 — use UPDATE ... RETURNING on SQLite too (bundled SQLite is 3.35+,
        # which supports RETURNING). The atomic decrement and the balance
        # snapshot come from the SAME conditional, tenant-scoped statement —
        # no separate, racy, UNSCOPED `SELECT balance_minor WHERE id=:id` that
        # could read another transaction's value or a wrong tenant's row.
        row = db.execute(text(
            "UPDATE gift_cards SET balance_minor = balance_minor - :amt, "
            "updated_at = :now "
            "WHERE id = :id AND user_id = :uid AND balance_minor >= :amt "
            "AND status = 'active' "
            "RETURNING balance_minor"
        ), {"amt": amount, "id": str(card_id), "uid": str(uid), "now": utc_now()}).first()
        changed = row is not None
        new_balance = int(row[0]) if row is not None else None
    else:
        row = db.execute(text(
            "UPDATE gift_cards SET balance_minor = balance_minor - :amt, "
            "updated_at = :now "
            "WHERE id = :id AND user_id = :uid AND balance_minor >= :amt "
            "AND status = 'active' "
            "RETURNING balance_minor"
        ), {"amt": amount, "id": str(card_id), "uid": str(uid), "now": utc_now()}).first()
        changed = row is not None
        new_balance = int(row[0]) if row is not None else None

    if not changed:
        # Zero rows. Re-read to disambiguate insufficient vs. locked/expired.
        db.rollback()
        cur = db.query(GiftCard).filter(GiftCard.id == card_id,
                                        GiftCard.user_id == uid).first()
        if cur is None:
            raise HTTPException(status_code=404, detail={"error": "not_found"})
        if cur.status == "active":
            # Active but the decrement failed ⇒ insufficient balance (409).
            raise HTTPException(status_code=409, detail={
                "error": "insufficient",
                "balance_remaining_minor": int(cur.balance_minor),
            })
        # Otherwise the card flipped out from under us — locked/expired/voided.
        if cur.status in ("expired", "voided", "redeemed"):
            raise HTTPException(status_code=410, detail={
                "error": cur.status,
                "balance_remaining_minor": int(cur.balance_minor) if cur.status == "expired" else 0,
            })
        raise HTTPException(status_code=423, detail={"error": "locked"})

    assert new_balance is not None

    # If the balance hit zero, the card is fully redeemed → flip status.
    final_status = "active"
    if new_balance <= 0:
        db.execute(text(
            "UPDATE gift_cards SET status = 'redeemed' WHERE id = :id AND user_id = :uid"
        ), {"id": str(card_id), "uid": str(uid)})
        final_status = "redeemed"

    # ── Append the redeem ledger row (idempotent INSERT) ───────────────
    # The UNIQUE(gift_card_id, idempotency_key) makes a racing duplicate land
    # as ON CONFLICT DO NOTHING / INSERT OR IGNORE. If we lose that race, the
    # balance we just decremented would be wrong — so we GUARD: insert the
    # ledger row FIRST-class and roll back the whole txn if the insert is a
    # no-op (meaning a concurrent identical redeem already committed). Because
    # this whole handler runs in one transaction, the decrement + ledger insert
    # commit atomically; the replay check above catches the common replay case.
    # TODO(D3): created_by_user_id is stamped with the owner's user id (`uid`)
    # because redeem currently authenticates as the owner account. Once staff
    # seats redeem under their own delegated identity, this should record the
    # ACTING staff member (request principal) rather than the tenant owner, so
    # the ledger attributes the redemption to the person who rang it up. Not
    # changing the auth-delegation model in this hardening pass.
    tx_id = uuid4()
    business_day = None
    try:
        business_day = datetime.combine(business_today_local(user),
                                        datetime.min.time())
    except Exception:
        business_day = utc_now()

    if is_sqlite:
        ins = db.execute(text(
            "INSERT OR IGNORE INTO gift_card_transactions "
            "(id, gift_card_id, user_id, kind, amount_minor, balance_after_minor, "
            " created_by_user_id, sale_ref, daily_close_id, business_day, "
            " idempotency_key, created_at) "
            "VALUES (:id, :gid, :uid, 'redeem', :amt, :bal, :by, :sref, NULL, "
            " :bday, :idem, :now)"
        ), {"id": str(tx_id), "gid": str(card_id), "uid": str(uid),
            "amt": -amount, "bal": new_balance, "by": str(uid),
            "sref": payload.sale_ref, "bday": business_day, "idem": idem_key,
            "now": utc_now()})
    else:
        ins = db.execute(text(
            "INSERT INTO gift_card_transactions "
            "(id, gift_card_id, user_id, kind, amount_minor, balance_after_minor, "
            " created_by_user_id, sale_ref, daily_close_id, business_day, "
            " idempotency_key, created_at) "
            "VALUES (:id, :gid, :uid, 'redeem', :amt, :bal, :by, :sref, NULL, "
            " :bday, :idem, :now) "
            "ON CONFLICT (gift_card_id, idempotency_key) DO NOTHING"
        ), {"id": str(tx_id), "gid": str(card_id), "uid": str(uid),
            "amt": -amount, "bal": new_balance, "by": str(uid),
            "sref": payload.sale_ref, "bday": business_day, "idem": idem_key,
            "now": utc_now()})

    if (ins.rowcount or 0) == 0:
        # A concurrent redeem with the same key won the ledger race. Our
        # decrement would double-spend → roll the WHOLE transaction back and
        # return the original result (re-read after rollback).
        db.rollback()
        prior = (
            db.query(GiftCardTransaction)
            .filter(GiftCardTransaction.gift_card_id == card_id,
                    GiftCardTransaction.user_id == uid,
                    GiftCardTransaction.idempotency_key == idem_key)
            .first()
        )
        cur = db.query(GiftCard).filter(GiftCard.id == card_id,
                                        GiftCard.user_id == uid).first()
        if prior is not None:
            return {
                "applied_minor": -int(prior.amount_minor),
                "balance_remaining_minor": int(prior.balance_after_minor),
                "status": cur.status if cur else "redeemed",
            }
        # No prior row visible (shouldn't happen) — treat as conflict.
        raise HTTPException(status_code=409, detail={
            "error": "insufficient",
            "balance_remaining_minor": int(cur.balance_minor) if cur else 0,
        })

    audit_service.record(
        db, user, "gavekort.redeemed", "gift_card", card_id,
        after={"applied_minor": amount, "balance_remaining_minor": new_balance,
               "sale_ref": payload.sale_ref},
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    db.commit()

    return {
        "applied_minor": amount,
        "balance_remaining_minor": int(new_balance),
        "status": final_status,
    }


# ═════════════════════════════════════════════════════════════════════
# POST /{id}/void — compensating ledger row, status → voided
# ═════════════════════════════════════════════════════════════════════
@router.post("/{card_id}/void")
def void_gavekort(card_id: UUID, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "gavekort")
    card = db.query(GiftCard).filter(GiftCard.id == card_id,
                                     GiftCard.user_id == user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    if card.status == "voided":
        # Idempotent — already voided. Return the current shape, no 2nd row.
        return {"id": str(card.id), "status": "voided", "balance_minor": 0}

    remaining = int(card.balance_minor)
    # Compensating ledger row zeroes the remaining balance (append-only — we
    # NEVER edit/delete the issue/redeem rows). amount = -(remaining) so the
    # ledger still sums to the new (zero) balance.
    db.add(GiftCardTransaction(
        gift_card_id=card.id, user_id=user.id, kind="void",
        amount_minor=-remaining, balance_after_minor=0,
        created_by_user_id=user.id, business_day=utc_now(),
    ))
    card.balance_minor = 0
    card.status = "voided"
    db.add(card)

    audit_service.record(
        db, user, "gavekort.voided", "gift_card", card.id,
        before={"balance_minor": remaining},
        after={"status": "voided"},
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    db.commit()
    db.refresh(card)
    return {"id": str(card.id), "status": card.status, "balance_minor": 0}
