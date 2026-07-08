"""
MobilePay Erhverv (Vipps MobilePay Business) — connect, callback, list,
disconnect. Task #71 — second half of the payment story alongside Aiia.

Endpoints (all under /api/mobilepay):

  POST   /init               Starter+. Begin OAuth flow. Rate-limited
                              10/hour per IP via slowapi.
  POST   /callback           Body {state, code}. Exchanges code for
                              tokens via the client + activates the row.
                              Auth-gated — owner is back from the
                              MobilePay redirect with our cookie intact
                              (frontend handles the redirect hop).
  GET    /payments           Starter+. Fetches recent MobilePay payments
                              + auto-matches against open invoices using
                              the existing payment_match logic.
  DELETE /connection         Starter+. Disconnects + deletes the row.
                              Idempotent (404 if nothing to delete).

Multi-layer defense (the BonBox standard stack):
  L1 auth          — get_current_user dep on every route. The POST
                      callback is auth-gated by design — the owner
                      walked through MitID Business in another tab, the
                      frontend redirects them back to our SPA which
                      POSTs the code+state with the session cookie.
  L2 tier gate     — enforce_feature(user, "mobilepay_autosync") on
                      every mutation + GET. Free users blocked at 402.
  L3 tenant scope  — every query filters by user.id; the callback
                      additionally validates a per-row consent_state
                      that was minted at init time.
  L4 input bounds  — Pydantic schemas for bodies; rate-limit on /init
                      (10/hour per IP).
  L5 audit trail   — mobilepay.connect, mobilepay.disconnect,
                      mobilepay.sync entries on every state change.
  L6 secrets       — access_token + refresh_token NEVER returned by
                      any endpoint; stored Fernet-encrypted via
                      app.utils.crypto.

Privacy: tax / accountant / lønseddel content stays in Danish per
project rules — only the UI chrome translates. This router emits
audit entries with neutral keys, not user-facing text.
"""
import logging
import secrets
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.mobilepay_connection import MobilePayConnection
from app.models.sale import Sale
from app.models.user import User
from app.schemas.mobilepay_connection import (
    MobilePayCallback,
    MobilePayConnectionInit,
    MobilePayConnectionInitResponse,
    MobilePayConnectionResponse,
    MobilePayPayment as MobilePayPaymentSchema,
    MobilePayPaymentsResponse,
)
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import enforce_feature
from app.services.mobilepay_client import (
    MobilePayClientError,
    MobilePayPayment,
    get_mobilepay_client,
)
from app.services.payment_match_service import _text_signal_matches
from app.services.voucher_service import format_voucher_number
from app.utils.crypto import decrypt, encrypt
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
# Rate limiter for /init — 10/hour per IP. Mirrors the magic-link
# pattern. The other routes don't get a custom limit beyond the global
# 120/minute since they're tied to an existing connection.
limiter = Limiter(key_func=client_ip)


# --- Helpers ---------------------------------------------------------


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _redirect_uri() -> str:
    """The redirect_uri we hand to MobilePay. Frontend handles the hop
    back to our SPA; the SPA POSTs to /api/mobilepay/callback. We pass
    the SPA URL here so MobilePay redirects there directly."""
    from app.config import settings
    base = (settings.FRONTEND_URL or "").rstrip("/")
    return f"{base}/connections?mobilepay_returning=1"


def _to_response(conn: MobilePayConnection) -> MobilePayConnectionResponse:
    return MobilePayConnectionResponse(
        id=conn.id,
        user_id=conn.user_id,
        mp_merchant_id=conn.mp_merchant_id,
        merchant_name=conn.merchant_name,
        status=conn.status,
        consent_expires_at=conn.consent_expires_at,
        last_synced_at=conn.last_synced_at,
        connected_at=conn.connected_at,
    )


def _get_owned_connection(
    db: Session, user: User,
) -> MobilePayConnection | None:
    """Tenant-scoped fetch. Returns the user's single MobilePay
    connection (UNIQUE per user in v1) or None.

    Critical: always filters by user_id even though the model enforces
    UNIQUE(user_id) — we never trust the table state to scope queries
    by accident.
    """
    return (
        db.query(MobilePayConnection)
        .filter(MobilePayConnection.user_id == user.id)
        .first()
    )


def _refresh_token_if_needed(
    db: Session, user: User, conn: MobilePayConnection,  # noqa: ARG001
    request: Request | None = None,  # noqa: ARG001
) -> str:
    """Return a live access_token for `conn`. Refreshes via the
    MobilePay client if the cached token is within 1 day of
    expiry (or missing). Writes the encrypted refresh result back to
    the connection row.

    The 1-day window aligns with the nightly cron cadence: any token
    that would expire before the next cron run gets refreshed eagerly
    so the user-facing /payments endpoint never falls into a 401 loop
    when MobilePay's access tokens (typically 1h TTL) age out between
    nightly syncs.

    Raises MobilePayClientError if the refresh fails — caller maps to
    the right HTTP status.
    """
    # utc_now() returns NAIVE UTC; token_expires_at is also NAIVE
    # (DateTime column, no tz). Both compare cleanly without coercion.
    now = utc_now()
    threshold = timedelta(days=1)
    expires_at = conn.token_expires_at
    needs_refresh = (
        conn.access_token_enc is None
        or expires_at is None
        or (expires_at - now) <= threshold
    )
    if not needs_refresh and conn.access_token_enc:
        return decrypt(bytes(conn.access_token_enc))

    if not conn.refresh_token_enc:
        raise MobilePayClientError(
            "Connection has no refresh token — re-connect required.",
            status=401, kind="missing_refresh",
        )
    refresh_token_plain = decrypt(bytes(conn.refresh_token_enc))

    client = get_mobilepay_client()
    result = client.refresh_token(refresh_token_plain)
    new_access = result.get("access_token") or ""
    new_refresh = result.get("refresh_token") or refresh_token_plain
    expires_in = int(result.get("expires_in") or 3600)

    conn.access_token_enc = encrypt(new_access)
    conn.refresh_token_enc = encrypt(new_refresh)
    conn.token_expires_at = utc_now() + timedelta(seconds=expires_in)
    db.flush()
    return new_access


def _auto_match_payments(
    db: Session, user: User, payments: list[MobilePayPayment],
) -> tuple[int, int, dict[str, uuid.UUID]]:
    """Persist new MobilePay payments as Sale rows + auto-match them
    against open invoices when the payment text contains the
    fakturanummer or customer name prefix.

    Returns (new_payments, auto_matched, payment_id -> invoice_id map).

    Why this lives here (not in payment_match_service): MobilePay
    payments are not "bank import" rows — they carry a per-payment
    description from MobilePay directly that includes the payer name
    and reference. The standard payment_match_service was built around
    the bank CSV shape. We reuse its core helper (_text_signal_matches)
    but the matcher loop is bespoke.
    """
    new_payments = 0
    auto_matched = 0
    invoice_map: dict[str, uuid.UUID] = {}

    # Lazy import to avoid circular — voucher_service lives near the
    # invoice service which imports back into us at module-load time.
    try:
        from app.services.voucher_service import allocate_voucher
    except Exception:  # noqa: BLE001
        allocate_voucher = None

    def _allocate(kind: str, year: int) -> int | None:
        if not allocate_voucher:
            return None
        try:
            return allocate_voucher(db, user.id, kind, year)
        except Exception:  # noqa: BLE001
            return None

    for payment in payments:
        ref_id = f"mobilepay_{payment.mp_payment_id}"

        existing = (
            db.query(Sale)
            .filter(Sale.user_id == user.id, Sale.reference_id == ref_id)
            .first()
        )
        if existing:
            if existing.invoice_id:
                invoice_map[payment.mp_payment_id] = existing.invoice_id
            continue

        sale = Sale(
            id=uuid.uuid4(),
            user_id=user.id,
            date=payment.booked_at.date(),
            amount=Decimal(str(abs(payment.amount))),
            payment_method="mobilepay",
            notes=(payment.description or "")[:1000],
            reference_id=ref_id,
            status="completed",
            voucher_number=_allocate("sale", payment.booked_at.year),
        )
        db.add(sale)
        db.flush()
        new_payments += 1

        # Look for an exact open invoice (±2 kr tolerance). MobilePay
        # payments are typically exact to the øre so tolerance is more
        # generous than strictly needed — matches the Aiia matcher.
        amount = Decimal(str(payment.amount))
        candidates = (
            db.query(Invoice)
            .filter(
                Invoice.user_id == user.id,
                Invoice.status.in_(("sent", "overdue")),
                Invoice.is_credit_note.is_(False),
                Invoice.total_gross >= amount - Decimal("2.00"),
                Invoice.total_gross <= amount + Decimal("2.00"),
            )
            .order_by(Invoice.issue_date.desc())
            .limit(10)
            .all()
        )
        if len(candidates) != 1:
            continue
        invoice = candidates[0]
        customer = (
            db.query(Customer)
            .filter(
                Customer.id == invoice.customer_id,
                Customer.user_id == user.id,
            )
            .first()
        )
        customer_name = customer.name if customer else ""
        fakturanummer_str = format_voucher_number(
            "invoice", invoice.issue_date.year, invoice.fakturanummer,
        )
        has_text_signal, reason = _text_signal_matches(
            payment.description or "", customer_name, fakturanummer_str,
        )
        if not has_text_signal:
            continue

        # HIGH confidence — flip to paid. Same shape as
        # payment_match_service.try_match_sale_to_invoice but with
        # paid_via='mobilepay' so the audit trail shows the source.
        from app.services.invoice_service import _sanitize_paid_reference
        before = {
            "id": str(invoice.id),
            "status": invoice.status,
            "paid_via": invoice.paid_via,
        }
        invoice.status = "paid"
        invoice.paid_amount = amount
        invoice.paid_at = utc_now()
        invoice.paid_via = "mobilepay"
        invoice.paid_reference = _sanitize_paid_reference(payment.description)
        invoice.auto_match_reversible = True
        sale.invoice_id = invoice.id
        db.flush()
        auto_matched += 1
        invoice_map[payment.mp_payment_id] = invoice.id

        audit_service.record(
            db, user, "invoice.mark_paid",
            entity_type="invoice", entity_id=invoice.id,
            before=before,
            after={
                "status": "paid",
                "paid_at": invoice.paid_at.isoformat(),
                "paid_amount": str(amount),
                "paid_via": "mobilepay",
                "match_reason": reason,
                "mp_payment_id": payment.mp_payment_id,
            },
            actor_type="system.mobilepay",
            ip_address=None,
        )

    return new_payments, auto_matched, invoice_map


# --- POST /api/mobilepay/init ---------------------------------------


@router.post("/init", response_model=MobilePayConnectionInitResponse)
@limiter.limit("10/hour")
def init_mobilepay(
    request: Request,
    # Body(...) keeps the JSON-body parser engaged even though
    # MobilePayConnectionInit has no required fields. Without this
    # hint, FastAPI 0.115 falls back to treating the model as a query
    # string (since every field is optional) and the route 422s before
    # our handler ever runs.
    body: MobilePayConnectionInit = Body(default_factory=MobilePayConnectionInit),  # noqa: ARG001
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Begin the MobilePay OAuth flow.

    Creates (or revives) a MobilePayConnection row with status='pending'
    + a random consent_state, then asks MobilePay for the consent URL
    the owner needs to visit to grant MitID Business access. Returns
    the URL — frontend redirects the owner there.

    Tier: Starter+ (`mobilepay_autosync`). Free users get 402.
    Rate-limited 10/hour per IP via slowapi to prevent spam.
    """
    enforce_feature(user, "mobilepay_autosync")

    # Task #106: production hard-gate. Don't claim "Connect MobilePay
    # Erhverv" when only the in-process mock is wired in. Frontend
    # hides the card via /api/config/features; this is the
    # defence-in-depth so direct API hits get a meaningful 503.
    from app.utils.features import is_mobilepay_enabled
    if not is_mobilepay_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "MobilePay Erhverv auto-sync is not configured yet — "
                "we're awaiting the Vipps partner agreement. Enter "
                "MobilePay payments manually for now; we'll switch on "
                "auto-match the moment the integration is live."
            ),
        )

    # CSRF token bound to this consent. 32 bytes -> 64 hex chars.
    state = secrets.token_hex(32)

    # Re-use any existing row (UNIQUE(user_id)) — if the owner clicks
    # Connect a second time without finishing the first, we flip the
    # existing pending row to a new state rather than failing on the
    # unique constraint.
    conn = _get_owned_connection(db, user)
    if conn is None:
        conn = MobilePayConnection(
            id=uuid.uuid4(),
            user_id=user.id,
            status="pending",
            consent_state=state,
        )
        db.add(conn)
        db.flush()
    else:
        conn.status = "pending"
        conn.consent_state = state
        # Zero out the old tokens — if the owner is re-connecting, the
        # old tokens are about to be replaced anyway. Defense in depth
        # against a partial-state leak.
        conn.access_token_enc = None
        conn.refresh_token_enc = None
        conn.token_expires_at = None
        db.flush()

    try:
        client = get_mobilepay_client()
        redirect_url = client.init_connection(
            redirect_uri=_redirect_uri(),
            state=state,
        )
    except MobilePayClientError as e:
        db.rollback()
        logger.exception("mobilepay.init: client init_connection failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    audit_service.record(
        db, user, "mobilepay.connect",
        entity_type="mobilepay_connection", entity_id=conn.id,
        after={"status": "pending", "phase": "init"},
        ip_address=_client_ip(request),
    )
    db.commit()

    return MobilePayConnectionInitResponse(
        connection_id=conn.id,
        redirect_url=redirect_url,
        state=state,
    )


# --- POST /api/mobilepay/callback -----------------------------------


@router.post("/callback", response_model=MobilePayConnectionResponse)
def mobilepay_callback(
    body: MobilePayCallback,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """MobilePay -> us via the frontend.

    Frontend handles the MobilePay redirect (state + code arrive as
    query params on /connections?mobilepay_returning=1) and POSTs
    them here with the owner's session cookie intact. Auth-gated so
    we can verify the connection row belongs to the authenticated user
    before exchanging the code.

    Flow:
      1. Look up MobilePayConnection by user_id + consent_state. 400
         if state doesn't match (replay / mismatched session).
      2. Exchange code at MobilePay -> tokens + merchant_id.
      3. Fernet-encrypt both tokens; stamp mp_merchant_id, status='active'.
      4. Audit + return the connection.
    """
    enforce_feature(user, "mobilepay_autosync")

    # Diagnostic logging (truncated state for readability) — helps debug
    # production "Invalid state" / "state already consumed" failures
    # without leaking the full token to logs.
    incoming = (body.state or "")[:8] + "…" if body.state else "<empty>"
    conn = _get_owned_connection(db, user)
    if not conn:
        logger.warning(
            "mobilepay.callback: no connection row for user_id=%s state=%s",
            user.id, incoming,
        )
        raise HTTPException(status_code=400, detail="Invalid state")
    stored = (conn.consent_state or "")[:8] + "…" if conn.consent_state else "<cleared>"
    if conn.consent_state != body.state:
        logger.warning(
            "mobilepay.callback: state mismatch user_id=%s status=%s "
            "incoming=%s stored=%s",
            user.id, conn.status, incoming, stored,
        )
        # Don't leak whether the state is unknown vs unowned vs wrong-
        # user. One generic 400 covers all three.
        raise HTTPException(status_code=400, detail="Invalid state")
    if conn.status != "pending":
        logger.warning(
            "mobilepay.callback: connection not in pending state "
            "user_id=%s status=%s",
            user.id, conn.status,
        )
        raise HTTPException(
            status_code=400,
            detail=f"Connection in {conn.status} state — cannot complete consent",
        )

    try:
        client = get_mobilepay_client()
        result = client.complete_callback(body.code, body.state)
    except MobilePayClientError as e:
        logger.exception(
            "mobilepay.callback: complete_callback failed user_id=%s "
            "state=%s status=%s kind=%s",
            user.id, incoming, getattr(e, "status", "?"), getattr(e, "kind", "?"),
        )
        audit_service.record(
            db, user, "mobilepay.connect",
            entity_type="mobilepay_connection", entity_id=conn.id,
            after={"phase": "callback_failed", "error": str(e)[:200]},
            ip_address=_client_ip(request),
        )
        db.commit()
        raise HTTPException(status_code=400, detail=str(e)) from e

    access_token = result.get("access_token") or ""
    refresh_token = result.get("refresh_token") or ""
    if not access_token or not refresh_token:
        raise HTTPException(
            status_code=502,
            detail="MobilePay complete_callback returned incomplete tokens",
        )

    conn.access_token_enc = encrypt(access_token)
    conn.refresh_token_enc = encrypt(refresh_token)
    conn.mp_merchant_id = result.get("mp_merchant_id") or ""
    conn.merchant_name = result.get("merchant_name") or None
    conn.scopes = result.get("scopes") or None
    conn.status = "active"
    # Clear the state so a stolen/duplicated code can't be replayed.
    conn.consent_state = None
    expires_in = int(result.get("expires_in") or 3600)
    conn.token_expires_at = utc_now() + timedelta(seconds=expires_in)
    consent_expires_in = result.get("consent_expires_in")
    if consent_expires_in:
        conn.consent_expires_at = utc_now() + timedelta(seconds=int(consent_expires_in))

    audit_service.record(
        db, user, "mobilepay.connect",
        entity_type="mobilepay_connection", entity_id=conn.id,
        after={
            "status": "active",
            "phase": "callback_complete",
            "mp_merchant_id": conn.mp_merchant_id,
            "merchant_name": conn.merchant_name,
            "scopes": conn.scopes,
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(conn)
    return _to_response(conn)


# --- GET /api/mobilepay/payments ------------------------------------


@router.get("/payments", response_model=MobilePayPaymentsResponse)
def list_mobilepay_payments(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch recent MobilePay payments + auto-match against open
    fakturaer using the standard text-signal matcher.

    Tier: Starter+ — feeds the same audit trail as the bank-side
    reconciliation, and burns MobilePay API quota.
    """
    enforce_feature(user, "mobilepay_autosync")

    conn = _get_owned_connection(db, user)
    if not conn:
        raise HTTPException(status_code=404, detail="No MobilePay connection")
    if conn.status != "active":
        raise HTTPException(
            status_code=400,
            detail=f"Connection not active (status={conn.status})",
        )
    if not conn.mp_merchant_id:
        raise HTTPException(
            status_code=400,
            detail="Connection has no merchant id — re-connect required",
        )

    # Refresh-if-near-expiry. Fails cleanly into a 401 if MobilePay
    # rejects our refresh token (consent revoked at their end).
    try:
        access_token = _refresh_token_if_needed(db, user, conn, request)
    except MobilePayClientError as e:
        if e.kind in ("revoked", "unauthorized", "missing_refresh") or e.status == 401:
            before = {"status": conn.status}
            conn.status = "expired"
            audit_service.record(
                db, user, "mobilepay.sync",
                entity_type="mobilepay_connection", entity_id=conn.id,
                before=before,
                after={"status": "expired", "error": str(e)[:200]},
                ip_address=_client_ip(request),
            )
            db.commit()
            raise HTTPException(
                status_code=409,
                detail="MobilePay consent expired or revoked — please re-connect.",
            ) from e
        logger.exception("mobilepay.payments: token refresh failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    since: datetime | None = None
    if conn.last_synced_at:
        since = conn.last_synced_at - timedelta(days=1)

    try:
        client = get_mobilepay_client()
        payments = client.list_payments(
            conn.mp_merchant_id, access_token, since=since,
        )
    except MobilePayClientError as e:
        if e.kind in ("revoked", "unauthorized") or e.status == 401:
            before = {"status": conn.status}
            conn.status = "expired"
            audit_service.record(
                db, user, "mobilepay.sync",
                entity_type="mobilepay_connection", entity_id=conn.id,
                before=before,
                after={"status": "expired", "error": str(e)[:200]},
                ip_address=_client_ip(request),
            )
            db.commit()
            raise HTTPException(
                status_code=409,
                detail="MobilePay consent expired or revoked — please re-connect.",
            ) from e
        logger.exception("mobilepay.payments: list_payments failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    new_payments, auto_matched, invoice_map = _auto_match_payments(
        db, user, payments,
    )

    conn.last_synced_at = utc_now()
    audit_service.record(
        db, user, "mobilepay.sync",
        entity_type="mobilepay_connection", entity_id=conn.id,
        after={
            "new_payments": new_payments,
            "auto_matched": auto_matched,
            "total_fetched": len(payments),
            "source": "api",
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(conn)

    return MobilePayPaymentsResponse(
        payments=[
            MobilePayPaymentSchema(
                mp_payment_id=p.mp_payment_id,
                booked_at=p.booked_at,
                amount=p.amount,
                currency=p.currency,
                description=p.description,
                payer_name=p.payer_name,
                matched_invoice_id=invoice_map.get(p.mp_payment_id),
            )
            for p in payments
        ],
        new_payments=new_payments,
        auto_matched=auto_matched,
        last_synced_at=conn.last_synced_at,
    )


# --- DELETE /api/mobilepay/connection -------------------------------


@router.delete("/connection", status_code=204)
def disconnect_mobilepay(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Disconnect the user's MobilePay connection.

    Effect:
      * Tells MobilePay to drop the access at their end (best-effort —
        we log + continue on MobilePay failure rather than block the
        owner).
      * Deletes the local row entirely (audit trail in audit_logs).
      * Token bytes are gone with the row.

    Tier: Starter+ (the user is mutating their own state). Idempotent
    — second DELETE returns 204 with no body even if there's nothing
    to delete. (Frontend sends a fire-and-forget.)
    """
    enforce_feature(user, "mobilepay_autosync")

    conn = _get_owned_connection(db, user)
    if not conn:
        # Idempotent — 204 with no body. The frontend doesn't need to
        # know whether the row existed; the user's state is "no
        # MobilePay connection" either way.
        return

    before = {
        "id": str(conn.id),
        "status": conn.status,
        "mp_merchant_id": conn.mp_merchant_id,
    }

    if conn.mp_merchant_id and conn.access_token_enc:
        try:
            client = get_mobilepay_client()
            # Best-effort revoke. Don't refresh on the way out — if the
            # access token is stale we still want to mark our side
            # disconnected.
            try:
                access_token = decrypt(bytes(conn.access_token_enc))
            except Exception:  # noqa: BLE001
                access_token = ""
            client.disconnect(conn.mp_merchant_id, access_token)
        except MobilePayClientError as e:
            logger.warning(
                "mobilepay.disconnect: MobilePay disconnect failed for "
                "conn=%s — continuing locally. %s",
                conn.id, e,
            )

    audit_service.record(
        db, user, "mobilepay.disconnect",
        entity_type="mobilepay_connection", entity_id=conn.id,
        before=before,
        after={"status": "disconnected", "deleted": True},
        ip_address=_client_ip(request),
    )
    db.delete(conn)
    db.commit()
    # 204 — no body
