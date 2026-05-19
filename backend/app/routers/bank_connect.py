"""
Aiia (Mastercard Open Banking) — connect, callback, list, sync, revoke.
Task #67 — bank-on-autopilot.

Endpoints (all under /api/bank-connect | /api/bank-connections):

  POST   /bank-connect/init               Starter+. Begin OAuth flow.
  GET    /bank-connect/callback           PUBLIC (state token validates).
                                           Aiia redirects the owner here
                                           after SCA. Code-exchange,
                                           encrypt refresh, mark active,
                                           bounce to /connections?bank_connected=1.
  GET    /bank-connections                Auth. List the current user's
                                           connections (no secrets ever).
  DELETE /bank-connections/{id}            Auth + ownership. Revoke at Aiia
                                           + set status='revoked'. Audit.
  POST   /bank-connections/{id}/sync       Auth + ownership. Manual sync.
                                           Returns suggestion count +
                                           auto-confirmed count.

Multi-layer defense (the BonBox standard stack):
  L1 auth          — get_current_user dep on every non-callback route
  L2 tier gate     — enforce_feature(user, "bank_auto_reconcile") on
                      init/sync (mutations); list/delete intentionally
                      tier-ungated on READ so a former Starter who
                      downgraded can still see + clean up
  L3 tenant scope  — every query filters by user.id; the callback
                      additionally validates a per-row consent_state
                      that was minted at init time
  L4 input bounds  — Pydantic schema for body + Query() on callback;
                      bank_slug whitelisted against SUPPORTED_BANKS
  L5 audit trail   — bank_connect.init, bank_connect.activated,
                      bank_connect.sync, bank_connect.revoked
  L6 secrets       — refresh_token NEVER returned by any endpoint;
                      stored AES-encrypted via utils/crypto.py

Sandbox-mode default: every new BankConnection is sandbox_mode=True
until AIIA_ENV=live is set. This lets us ship without real Aiia creds
and run tests + dev flows end-to-end against MockAiiaClient.
"""
from __future__ import annotations

import logging
import secrets
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.bank_connection import BankConnection
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.schemas.bank_connection import (
    BankConnectionInit,
    BankConnectionInitResponse,
    BankConnectionResponse,
    BankSyncResponse,
)
from app.services import audit_service, bank_reconciliation
from app.services.aiia_client import (
    AiiaClientError,
    AiiaTransaction,
    get_aiia_client,
    sandbox_mode_default,
)
from app.services.auth import get_current_user
from app.services.billing import enforce_feature
from app.services.cash_sync import sync_cash_out_for_expense
from app.utils.crypto import encrypt
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
# Two router objects so we can mount them under different prefixes in
# main.py — /api/bank-connect (init + callback) and /api/bank-connections
# (list + sync + revoke). Spec calls for this split because the OAuth-
# flow endpoints are conceptually different from the connection-CRUD
# endpoints (e.g. callback is public).
router = APIRouter()
connections_router = APIRouter()


# ─── Helpers ──────────────────────────────────────────────────────────


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _callback_url() -> str:
    """The redirect_uri we hand to Aiia. Must exactly match what's
    registered in the Aiia portal. For the BonBox dev/sandbox path we
    use the backend's own /api/bank-connect/callback so the flow
    completes without going through the SPA — the callback redirects
    onward to the frontend at the end."""
    # Prefer an explicit AIIA_REDIRECT_URI env var so deployment-specific
    # values (api.bonbox.dk vs localhost) can be set in Render. Fall back
    # to FRONTEND_URL-derived value (less reliable in prod) only for dev.
    explicit = (settings.FRONTEND_URL or "").rstrip("/")
    return f"{explicit}/api/bank-connect/callback"


def _to_response(conn: BankConnection) -> BankConnectionResponse:
    return BankConnectionResponse(
        id=conn.id,
        user_id=conn.user_id,
        provider=conn.provider,
        bank_slug=conn.bank_slug,
        account_label=conn.account_label,
        status=conn.status,
        aiia_account_id=conn.aiia_account_id,
        consent_expires_at=conn.consent_expires_at,
        last_synced_at=conn.last_synced_at,
        sandbox_mode=conn.sandbox_mode,
        created_at=conn.created_at,
    )


def _get_owned_connection(
    db: Session, user: User, connection_id: uuid.UUID,
) -> BankConnection:
    """Tenant-scoped fetch. Returns 404 (not 403) for cross-tenant
    requests so a probe can't enumerate other users' ids."""
    conn = (
        db.query(BankConnection)
        .filter(
            BankConnection.id == connection_id,
            BankConnection.user_id == user.id,
        )
        .first()
    )
    if not conn:
        raise HTTPException(status_code=404, detail="Bank connection not found")
    return conn


# ─── POST /api/bank-connect/init ──────────────────────────────────────


@router.post("/init", response_model=BankConnectionInitResponse)
def init_bank_connection(
    body: BankConnectionInit,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Begin the Aiia OAuth flow.

    Creates a BankConnection row with status='pending' + a random
    consent_state, then asks Aiia for the consent URL the owner needs
    to visit at their bank to grant SCA. Returns the URL — frontend
    redirects the owner there.

    Tier: Starter+ (`bank_auto_reconcile`). Free users get 402.
    """
    enforce_feature(user, "bank_auto_reconcile")

    # CSRF token bound to this consent. 32 bytes → 64 hex chars.
    state = secrets.token_hex(32)
    sandbox = sandbox_mode_default()

    # Create the row up front so we have somewhere to write the
    # tokens when the callback resolves. Status stays 'pending' until
    # then. If the owner never completes consent, a sweeper can purge
    # pending rows older than 1 hour (out of scope for v0.1).
    conn = BankConnection(
        id=uuid.uuid4(),
        user_id=user.id,
        provider="aiia",
        bank_slug=body.bank_slug,
        consent_state=state,
        status="pending",
        sandbox_mode=sandbox,
    )
    db.add(conn)
    db.flush()

    # Ask Aiia for the consent URL. Errors → 502 so caller can retry.
    try:
        client = get_aiia_client()
        consent_url = client.init_consent(
            redirect_uri=_callback_url(),
            state=state,
            bank_slug=body.bank_slug,
        )
    except AiiaClientError as e:
        db.rollback()
        logger.exception("bank_connect.init: Aiia init_consent failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    audit_service.record(
        db, user, "bank_connect.init",
        entity_type="bank_connection", entity_id=conn.id,
        after={
            "bank_slug": body.bank_slug,
            "status": "pending",
            "sandbox_mode": sandbox,
        },
        ip_address=_client_ip(request),
    )
    db.commit()

    return BankConnectionInitResponse(
        connection_id=conn.id,
        consent_url=consent_url,
        state=state,
        sandbox_mode=sandbox,
    )


# ─── GET /api/bank-connect/callback ───────────────────────────────────


@router.get("/callback")
def bank_callback(
    request: Request,
    code: str = Query(..., min_length=4, max_length=512),
    state: str = Query(..., min_length=8, max_length=128),
    db: Session = Depends(get_db),
):
    """Aiia → us. PUBLIC endpoint — the owner is mid-SCA and has no
    BonBox session in this redirect. Authn = the `state` token, which
    we minted at init time and bound to a specific BankConnection row.

    Flow:
      1. Look up BankConnection by consent_state. 400 if unknown.
      2. Refuse if status != 'pending' (replay defense).
      3. Exchange code at Aiia → refresh_token + account_id.
      4. AES-encrypt refresh_token; stamp aiia_account_id, status='active'.
      5. Audit + redirect to /connections?bank_connected=1.
    """
    conn = (
        db.query(BankConnection)
        .filter(BankConnection.consent_state == state)
        .first()
    )
    if not conn:
        raise HTTPException(status_code=400, detail="Unknown consent state")
    if conn.status != "pending":
        # Already processed or revoked — refuse replay
        raise HTTPException(
            status_code=400,
            detail=f"Connection in {conn.status} state — cannot complete consent",
        )

    # Re-fetch the user so the audit trail has a real User object.
    user = db.query(User).filter(User.id == conn.user_id).first()
    if not user:
        # Defensive — shouldn't happen; FK should prevent it. Bail safely.
        raise HTTPException(status_code=404, detail="Owner account missing")

    try:
        client = get_aiia_client()
        result = client.exchange_code(code)
    except AiiaClientError as e:
        logger.exception("bank_connect.callback: Aiia exchange_code failed")
        # We don't 500 — friendlier to bounce the owner back with an
        # error flag so the UI can show "Bank connection failed, try
        # again". State token is still consumed below to prevent replay.
        conn.status = "revoked"
        conn.consent_state = None
        audit_service.record(
            db, user, "bank_connect.callback_failed",
            entity_type="bank_connection", entity_id=conn.id,
            after={"error": str(e)[:200]},
            ip_address=_client_ip(request),
        )
        db.commit()
        return RedirectResponse(
            url=f"{settings.FRONTEND_URL.rstrip('/')}/connections?bank_error=1",
            status_code=303,
        )

    refresh_token = result.get("refresh_token") or ""
    if not refresh_token:
        raise HTTPException(
            status_code=502,
            detail="Aiia exchange_code returned no refresh token",
        )

    # Encrypt-at-rest. Fernet token is bytes — stored in LargeBinary col.
    conn.refresh_token_enc = encrypt(refresh_token)
    conn.aiia_account_id = result.get("account_id") or ""
    conn.account_label = result.get("account_label") or None
    conn.status = "active"
    # Clear the state so a stolen URL can't be replayed.
    conn.consent_state = None
    expires_in = int(result.get("expires_in") or 7776000)  # 90d default
    conn.consent_expires_at = utc_now() + timedelta(seconds=expires_in)

    audit_service.record(
        db, user, "bank_connect.activated",
        entity_type="bank_connection", entity_id=conn.id,
        after={
            "bank_slug": conn.bank_slug,
            "aiia_account_id": conn.aiia_account_id,
            "consent_expires_at": conn.consent_expires_at.isoformat() if conn.consent_expires_at else None,
            "sandbox_mode": conn.sandbox_mode,
        },
        ip_address=_client_ip(request),
    )
    db.commit()

    # Bounce back to the connections page so the owner sees a "🎉
    # Bank connected" toast.
    return RedirectResponse(
        url=f"{settings.FRONTEND_URL.rstrip('/')}/connections?bank_connected=1",
        status_code=303,
    )


# ─── GET /api/bank-connections ────────────────────────────────────────


@connections_router.get("", response_model=list[BankConnectionResponse])
def list_bank_connections(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List the current user's bank connections — no secrets ever.

    Intentionally tier-ungated on READ: a user who downgraded from
    Starter must still be able to see + revoke leftover connections.
    """
    rows = (
        db.query(BankConnection)
        .filter(BankConnection.user_id == user.id)
        .order_by(BankConnection.created_at.desc())
        .all()
    )
    return [_to_response(c) for c in rows]


# ─── DELETE /api/bank-connections/{id} ────────────────────────────────


@connections_router.delete("/{connection_id}", status_code=204)
def revoke_bank_connection(
    connection_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Revoke a bank connection.

    Effect:
      • Tells Aiia to drop the access at their end (best-effort — we
        log + continue on Aiia failure rather than block the owner).
      • Sets status='revoked' on our row.
      • Burns refresh_token_enc so a future leak of the DB row alone
        can't be used.
      • Writes audit log.

    Tier-ungated so downgrades can still clean up. Idempotent on
    already-revoked rows.
    """
    conn = _get_owned_connection(db, user, connection_id)

    if conn.status == "revoked":
        return  # 204, idempotent

    before = {"status": conn.status, "aiia_account_id": conn.aiia_account_id}

    # Best-effort revoke at Aiia. If it fails we still mark our row
    # revoked — owner intent is clear, and we'd rather be conservative
    # locally than leave a "looks active" row after an Aiia hiccup.
    if conn.aiia_account_id:
        try:
            client = get_aiia_client()
            client.revoke(conn.aiia_account_id)
        except AiiaClientError as e:
            logger.warning(
                "bank_connect.revoke: Aiia revoke failed for conn=%s — continuing locally. %s",
                conn.id, e,
            )

    conn.status = "revoked"
    conn.refresh_token_enc = None
    conn.consent_state = None

    audit_service.record(
        db, user, "bank_connect.revoked",
        entity_type="bank_connection", entity_id=conn.id,
        before=before,
        after={"status": "revoked"},
        ip_address=_client_ip(request),
    )
    db.commit()
    # 204 — no body


# ─── POST /api/bank-connections/{id}/sync ─────────────────────────────


def _resolve_bank_category(db: Session, user: User) -> ExpenseCategory:
    """Ensure a 'Bank' ExpenseCategory exists for this user. We use
    a single catch-all for Aiia-imported expenses; the owner can
    re-categorize later. Idempotent."""
    cat = (
        db.query(ExpenseCategory)
        .filter(
            ExpenseCategory.user_id == user.id,
            ExpenseCategory.name == "Bank",
        )
        .first()
    )
    if cat:
        return cat
    cat = ExpenseCategory(
        id=uuid.uuid4(),
        user_id=user.id,
        name="Bank",
        color="#3B82F6",
    )
    db.add(cat)
    db.flush()
    return cat


def _ingest_transactions(
    db: Session, user: User, conn: BankConnection, txns: list[AiiaTransaction],
) -> tuple[int, int, int]:
    """Materialize Aiia transactions into Sale (credit) / Expense
    (debit) rows, deduped on reference_id. Returns (new_sales,
    new_expenses, skipped_duplicates)."""
    new_sales = 0
    new_expenses = 0
    skipped = 0

    bank_slug = conn.bank_slug or "aiia"
    # Lazy-import voucher allocator — matches bank_import.py pattern.
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

    bank_category: ExpenseCategory | None = None

    for txn in txns:
        ref_id = f"bank_{bank_slug}_{txn.aiia_txn_id}"

        if txn.amount >= 0:
            # Inflow → Sale
            exists = (
                db.query(Sale.id)
                .filter(Sale.user_id == user.id, Sale.reference_id == ref_id)
                .first()
            )
            if exists:
                skipped += 1
                continue
            sale = Sale(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn.booked_date,
                amount=Decimal(str(abs(txn.amount))),
                payment_method="bank_transfer",
                notes=(txn.description or "")[:1000],
                reference_id=ref_id,
                status="completed",
                voucher_number=_allocate("sale", txn.booked_date.year),
            )
            db.add(sale)
            db.flush()
            new_sales += 1
        else:
            # Outflow → Expense (under the 'Bank' category)
            exists = (
                db.query(Expense.id)
                .filter(Expense.user_id == user.id, Expense.reference_id == ref_id)
                .first()
            )
            if exists:
                skipped += 1
                continue
            if bank_category is None:
                bank_category = _resolve_bank_category(db, user)
            exp = Expense(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn.booked_date,
                amount=Decimal(str(abs(txn.amount))),
                description=(txn.description or "Bank transaction")[:255],
                category_id=bank_category.id,
                payment_method="bank_transfer",
                reference_id=ref_id,
                voucher_number=_allocate("expense", txn.booked_date.year),
            )
            db.add(exp)
            db.flush()
            try:
                sync_cash_out_for_expense(db, exp, category_name="Bank")
            except Exception:  # noqa: BLE001
                logger.exception(
                    "bank_connect.sync: cash sync failed for expense %s", exp.id,
                )
            new_expenses += 1

    return new_sales, new_expenses, skipped


def _auto_confirm_high_confidence(
    db: Session, user: User, suggestions, request: Request | None,
) -> int:
    """Apply any HIGH confidence suggestions where amount_diff <= 0.01
    automatically. Returns the count we auto-confirmed.

    Conservative gate — matches the spec's auto-confirm policy without
    the per-user toggle (deferred to v0.2). Only invoice matches are
    auto-confirmed here; expense-to-expense links always need owner
    review."""
    if not suggestions:
        return 0
    high_matches = []
    for row in suggestions:
        if not row.suggestions:
            continue
        top = row.suggestions[0]
        if (
            top.confidence == "high"
            and top.amount_diff <= 0.01
            and top.target_type == "invoice"
        ):
            high_matches.append({
                "txn_id": top.txn_id,
                "target_type": top.target_type,
                "target_id": top.target_id,
                "action": "mark_paid",
            })
    if not high_matches:
        return 0
    ip = _client_ip(request)
    result = bank_reconciliation.confirm_matches(
        db, user, matches=high_matches, ip_address=ip,
    )
    return int(result.get("confirmed", 0))


@connections_router.post("/{connection_id}/sync", response_model=BankSyncResponse)
def sync_bank_connection(
    connection_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Manually trigger a sync for one connection. Same code path the
    cron uses. Pulls transactions since last_synced_at, materializes
    Sale/Expense rows (deduped on reference_id), runs them through
    bank_reconciliation, auto-confirms HIGH+exact-amount matches.

    Tier: Starter+ — every sync writes audit_logs, generates real
    matches, and costs Aiia API calls.
    """
    enforce_feature(user, "bank_auto_reconcile")

    conn = _get_owned_connection(db, user, connection_id)
    if conn.status != "active":
        raise HTTPException(
            status_code=400,
            detail=f"Connection not active (status={conn.status})",
        )
    if not conn.aiia_account_id:
        raise HTTPException(
            status_code=400,
            detail="Connection has no Aiia account id — re-connect required",
        )

    # Pull txns since last_synced_at - 1d (overlap window guards against
    # late-clearing rows). On a fresh connection (last_synced_at=NULL)
    # we let Aiia's default lookback apply.
    since: datetime | None = None
    if conn.last_synced_at:
        since = conn.last_synced_at - timedelta(days=1)

    try:
        client = get_aiia_client()
        txns = client.list_transactions(conn.aiia_account_id, since=since)
    except AiiaClientError as e:
        # 401 from Aiia → consent expired
        if e.kind in ("revoked", "unauthorized") or e.status == 401:
            before = {"status": conn.status}
            conn.status = "expired"
            audit_service.record(
                db, user, "bank_connect.expired",
                entity_type="bank_connection", entity_id=conn.id,
                before=before,
                after={"status": "expired", "error": str(e)[:200]},
                ip_address=_client_ip(request),
            )
            db.commit()
            raise HTTPException(
                status_code=409,
                detail="Bank consent expired or revoked — please re-connect.",
            ) from e
        logger.exception("bank_connect.sync: list_transactions failed")
        raise HTTPException(status_code=502, detail=str(e)) from e

    new_sales, new_expenses, skipped = _ingest_transactions(db, user, conn, txns)
    db.flush()

    # Run reconciliation over the freshly imported rows. import_id
    # 'latest' = all bank-imported rows, scoped to this user.
    suggestions = bank_reconciliation.match_transactions(
        db, user.id, import_id="latest", lookback_days=90,
    )
    auto_confirmed = _auto_confirm_high_confidence(db, user, suggestions, request)

    # Stamp last_synced_at + write audit
    conn.last_synced_at = utc_now()
    audit_service.record(
        db, user, "bank_connect.sync",
        entity_type="bank_connection", entity_id=conn.id,
        after={
            "new_sales": new_sales,
            "new_expenses": new_expenses,
            "skipped": skipped,
            "suggestions": len(suggestions),
            "auto_confirmed": auto_confirmed,
        },
        ip_address=_client_ip(request),
    )
    db.commit()

    return BankSyncResponse(
        connection_id=conn.id,
        new_sales=new_sales,
        new_expenses=new_expenses,
        skipped_duplicates=skipped,
        suggestions=len(suggestions),
        auto_confirmed=auto_confirmed,
        errors=[],
        last_synced_at=conn.last_synced_at,
    )
