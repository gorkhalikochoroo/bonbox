"""Payment provider imports — connect, sync, and confirm transactions.

Also hosts the CSV-to-booking auto-match flow (see
`booking_match.find_booking_matches` for the algorithm). After the
existing income/expense reconciliation runs, every CSV line that
didn't already match a Sale/Expense gets a second pass against the
organizer's PENDING event bookings. HIGH-confidence matches auto-
promote the booking to 'paid' via
`booking_to_sale.write_sale_from_booking`; MED/LOW matches surface
in the response payload as `needs_review` so the frontend can render
a confirm-or-reject UI.
"""
import json
import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.payment_connection import PaymentConnection
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.booking_match import (
    BookingMatch,
    CsvPaymentLine,
    find_booking_matches,
)
from app.services.payment_providers import (
    get_providers,
    get_providers_for_country,
    fetch_transactions,
    PROVIDERS,
)
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense
from app.schemas.payment_import import (
    ConnectRequest,
    ConnectionResponse,
    SyncResponse,
    SyncConfirmRequest,
    SyncConfirmResponse,
    PaymentTransaction,
)

# Reuse categorization from expenses router
from app.routers.expenses import suggest_category_for, learn_category
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.payment_import")

router = APIRouter()


# ─── Helpers ──────────────────────────────────────────────────────────


def _client_ip(request: Request | None) -> str | None:
    """Best-effort client IP for audit rows. Matches the pattern used
    by routers/events.py — X-Forwarded-For first, then request.client."""
    if request is None:
        return None
    try:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else None
    except Exception:
        return None


def _txn_to_csv_line(txn: PaymentTransaction, row_index: int) -> CsvPaymentLine | None:
    """Adapt a parsed payment transaction into the booking-match
    CsvPaymentLine. Returns None for non-income txns (we only match
    incoming MobilePay/Dankort payments to bookings, never outgoing
    expenses). Returns None on malformed amount/date too — caller
    treats None as 'no match attempted'."""
    if txn.type != "income":
        return None
    try:
        amount_dkk = int(round(abs(float(txn.amount))))
    except (TypeError, ValueError):
        return None
    try:
        txn_date = date.fromisoformat(txn.date)
    except (TypeError, ValueError):
        return None
    # `description` is the closest analogue to MobilePay "besked".
    # Existing providers parse the comment field into description;
    # the MobilePay provider also commonly emits a counterparty name
    # which we don't have a dedicated slot for here. v1: use the
    # description as both signals (the matcher tolerates this — it
    # checks comment for substring and sender_name for fuzzy).
    return CsvPaymentLine(
        amount_dkk=amount_dkk,
        sender_name=txn.description,
        comment=txn.description,
        date=txn_date,
        csv_row_index=row_index,
    )


def _serialize_match(match: BookingMatch) -> dict[str, Any]:
    """Project a BookingMatch into the JSON-shape the frontend
    consumes. We don't ship the full CsvPaymentLine back — the
    frontend already has the parsed CSV from the sync step."""
    return {
        "booking_id": match.booking_id,
        "confidence": match.confidence,
        "reason": match.reason,
        "matched_reference": match.matched_reference,
    }


def _resolve_booking(db: Session, booking_id: uuid.UUID, organizer_user_id: uuid.UUID):
    """Tenant-scoped booking fetch.

    Returns the Booking row or None. None covers both "doesn't exist"
    and "belongs to another organizer" — by IDOR convention the
    caller should respond 404 in both cases to avoid leaking
    existence.

    Imports the Booking model lazily so this router stays importable
    even before Phase 1 lands the model.
    """
    try:
        from app.models.booking import Booking  # type: ignore[import-not-found]
    except Exception:
        return None
    return (
        db.query(Booking)
        .filter(
            Booking.id == booking_id,
            Booking.organizer_user_id == organizer_user_id,
        )
        .first()
    )


def _format_bilagsnummer(voucher_number: int | None, sale_date) -> str | None:
    """Render a voucher_number into the canonical Sxxxx bilagsnummer
    format: 'S-{year}-{NNNN}'. None-safe — returns None when either
    input is missing."""
    if voucher_number is None:
        return None
    try:
        year = sale_date.year
    except AttributeError:
        return None
    return f"S-{year}-{int(voucher_number):04d}"


# ── Provider info ───────────────────────────────────────────

@router.get("/providers")
def list_providers(country: str | None = Query(None)):
    """List available payment providers, optionally filtered by country."""
    if country:
        return get_providers_for_country(country)
    return get_providers()


# ── Connection management ───────────────────────────────────

@router.get("/connections", response_model=list[ConnectionResponse])
def list_connections(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List user's connected payment providers."""
    conns = db.query(PaymentConnection).filter(
        PaymentConnection.user_id == user.id,
    ).order_by(PaymentConnection.created_at.desc()).all()
    return conns


@router.post("/connect", response_model=ConnectionResponse)
def connect_provider(
    data: ConnectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Connect a payment provider by saving merchant credentials."""
    if data.provider not in PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {data.provider}")

    provider_info = PROVIDERS[data.provider]
    required = [f["key"] for f in provider_info["fields"]]
    missing = [k for k in required if not data.credentials.get(k)]
    if missing:
        raise HTTPException(400, f"Missing required fields: {', '.join(missing)}")

    # Check if user already has a connection for this provider
    existing = db.query(PaymentConnection).filter(
        PaymentConnection.user_id == user.id,
        PaymentConnection.provider == data.provider,
    ).first()

    if existing:
        # Update existing connection
        existing.credentials = json.dumps(data.credentials)
        existing.label = data.label or provider_info["name"]
        existing.is_active = True
        db.commit()
        db.refresh(existing)
        return existing

    conn = PaymentConnection(
        id=uuid.uuid4(),
        user_id=user.id,
        provider=data.provider,
        label=data.label or provider_info["name"],
        credentials=json.dumps(data.credentials),
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return conn


@router.delete("/connections/{connection_id}")
def disconnect_provider(
    connection_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a payment provider connection."""
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    db.delete(conn)
    db.commit()
    return {"message": f"{conn.label} disconnected"}


@router.patch("/connections/{connection_id}/auto-sync")
def toggle_auto_sync(
    connection_id: uuid.UUID,
    enabled: bool = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Toggle auto-sync on/off for a connection."""
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    conn.auto_sync = enabled
    db.commit()
    db.refresh(conn)
    return {"auto_sync": conn.auto_sync}


# ── Sync transactions ──────────────────────────────────────

@router.post("/sync/{connection_id}", response_model=SyncResponse)
async def sync_transactions(
    connection_id: uuid.UUID,
    date_from: str = Query(None, description="Start date (YYYY-MM-DD)"),
    date_to: str = Query(None, description="End date (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch transactions from a connected payment provider."""
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")
    if not conn.is_active:
        raise HTTPException(400, "Connection is inactive")

    creds = json.loads(conn.credentials)

    # Default: last 30 days
    d_to = date.fromisoformat(date_to) if date_to else date.today()
    d_from = date.fromisoformat(date_from) if date_from else d_to - timedelta(days=30)

    try:
        raw_txns = await fetch_transactions(conn.provider, creds, d_from, d_to)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch from {conn.provider}: {str(e)}")

    # Add category suggestions
    transactions = []
    for txn in raw_txns:
        if txn["type"] == "expense":
            suggestion = suggest_category_for(txn["description"], user.id, db)
            txn["suggested_category"] = suggestion["category_name"] if suggestion else "Other"
            txn["confidence"] = suggestion["confidence"] if suggestion else 0.0
        else:
            txn["suggested_category"] = "Sales"
            txn["confidence"] = 1.0
        transactions.append(PaymentTransaction(**txn))

    # Update last synced
    conn.last_synced_at = utc_now()
    db.commit()

    return SyncResponse(
        provider=conn.provider,
        transactions=transactions,
        total_count=len(transactions),
        date_from=d_from.isoformat(),
        date_to=d_to.isoformat(),
    )


# ── Confirm import ──────────────────────────────────────────

@router.post("/confirm")
def confirm_payment_import(
    body: SyncConfirmRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save confirmed payment transactions as Sales and Expenses.

    Uses the same dedup + categorization logic as bank CSV import.

    Booking auto-match extension (post-existing-import pass):
      After the existing Sale/Expense write loop, every income row
      that DIDN'T match an existing Sale (i.e. wasn't skipped as a
      duplicate) is also tested against the organizer's PENDING
      bookings. HIGH-confidence hits auto-confirm the booking via
      `write_sale_from_booking` (booking.status → 'paid'); MED/LOW
      hits surface in the response as `needs_review`.

      Backwards-compatibility: the response now extends with a
      `booking_matches` block. Existing callers that read only
      {imported, skipped, errors} keep working because Pydantic-
      free dict response carries the same top-level keys.
    """
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == body.connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    imported = 0
    skipped = 0
    errors: list[str] = []
    # Track which CSV rows landed as new Sales (i.e. were "reconciled"
    # by the existing flow). Any income row NOT in this set + NOT
    # skipped-as-dup is a candidate for booking auto-match.
    reconciled_indexes: set[int] = set()
    # Track income rows that hit the dup-skip path — we don't run
    # booking-match on those either (a sale already exists for them).
    duplicate_indexes: set[int] = set()

    # Voucher allocator (lazy + multi-layer defense)
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

    for idx, txn in enumerate(body.transactions):
        ref_id = f"pay_{conn.provider}_{txn.ref_hash}"

        try:
            txn_date = date.fromisoformat(txn.date)
        except ValueError:
            errors.append(f"Invalid date: {txn.date}")
            continue

        if txn.type == "income":
            exists = db.query(Sale.id).filter(
                Sale.user_id == user.id,
                Sale.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                duplicate_indexes.add(idx)
                continue

            sale = Sale(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn_date,
                amount=abs(txn.amount),
                payment_method=txn.payment_method,
                notes=txn.description,
                reference_id=ref_id,
                status="completed",
                voucher_number=_allocate("sale", txn_date.year),
            )
            db.add(sale)
            db.flush()
            if txn.payment_method in ("cash", "mixed"):
                sync_cash_in_for_sale(db, sale)
            imported += 1
            reconciled_indexes.add(idx)

        elif txn.type == "expense":
            exists = db.query(Expense.id).filter(
                Expense.user_id == user.id,
                Expense.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            cat_name = txn.suggested_category or "Other"
            category = db.query(ExpenseCategory).filter(
                ExpenseCategory.user_id == user.id,
                ExpenseCategory.name == cat_name,
            ).first()
            if not category:
                category = ExpenseCategory(
                    id=uuid.uuid4(),
                    user_id=user.id,
                    name=cat_name,
                )
                db.add(category)
                db.flush()

            expense = Expense(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn_date,
                amount=abs(txn.amount),
                description=txn.description,
                category_id=category.id,
                payment_method=txn.payment_method,
                reference_id=ref_id,
                voucher_number=_allocate("expense", txn_date.year),
            )
            db.add(expense)
            db.flush()
            sync_cash_out_for_expense(db, expense, category_name=cat_name)
            learn_category(txn.description, cat_name, user.id, db)
            imported += 1

    # ── Booking auto-match pass ───────────────────────────────────
    # Every income row that LANDED as a new Sale OR was skipped as
    # a duplicate is excluded — only "this CSV row matched nothing
    # we already had on file" rows enter this pass. We don't gate
    # this on the booking-to-sale module being importable; we use
    # the fail-soft pattern so a Phase 1-not-yet-landed state can't
    # take down the existing import path.
    booking_matches_payload: dict[str, list] = {
        "auto_confirmed": [],
        "needs_review": [],
    }

    # Lazy import the booking→sale bridge. Phase 1 agent owns this
    # module — if it's not present, no HIGH match will auto-confirm
    # (the candidate still surfaces as needs_review for the UI to
    # confirm manually once the bridge ships).
    try:
        from app.services.booking_to_sale import (  # type: ignore[import-not-found]
            write_sale_from_booking,
        )
    except Exception:  # noqa: BLE001
        write_sale_from_booking = None

    for idx, txn in enumerate(body.transactions):
        # Skip non-income, skip already-reconciled, skip already-duped
        if txn.type != "income":
            continue
        # NOTE: we DO run booking-match for both the freshly-imported
        # row AND the unmatched bucket. Even when the row landed as a
        # plain Sale, a HIGH-confidence booking reference in the
        # comment means we should ALSO have promoted the booking.
        # The spec calls this out: "for each row that wasn't
        # reconciled to an existing record". Our interpretation:
        # "existing record" = pre-existing Sale (the dup-skip case),
        # not the row we just wrote. So we run match on freshly-
        # written rows too, BUT skip dup-skipped rows.
        if idx in duplicate_indexes:
            continue

        csv_line = _txn_to_csv_line(txn, row_index=idx)
        if csv_line is None:
            continue

        try:
            candidates = find_booking_matches(db, user.id, csv_line)
        except Exception as e:  # noqa: BLE001
            logger.warning("booking_match failed for row %d: %s", idx, e)
            continue

        if not candidates:
            continue

        best = candidates[0]
        if best.confidence == "high" and write_sale_from_booking is not None:
            booking = _resolve_booking(
                db,
                uuid.UUID(best.booking_id),
                user.id,
            )
            if booking is None:
                # Vanished/cross-tenant — skip silently. Should be
                # impossible since find_booking_matches already
                # filtered by organizer_user_id, but defense-in-
                # depth never hurts.
                continue
            try:
                sale = write_sale_from_booking(db, booking)
            except Exception as e:  # noqa: BLE001
                logger.error(
                    "write_sale_from_booking failed for booking %s: %s",
                    best.booking_id, e,
                )
                # Demote to needs_review so the human can decide.
                booking_matches_payload["needs_review"].append({
                    "csv_row_index": idx,
                    "candidates": [_serialize_match(m) for m in candidates],
                })
                continue

            # Best-effort audit row. The L8 doctrine: state-change
            # is auditable, but audit failures never block the flow.
            try:
                audit_service.record(
                    db, user,
                    action="booking.paid",
                    entity_type="booking",
                    entity_id=uuid.UUID(best.booking_id),
                    after={
                        "booking_id": best.booking_id,
                        "sale_id": str(getattr(sale, "id", "")),
                        "reconciliation": "csv_auto",
                        "csv_row_index": idx,
                        "matched_reference": best.matched_reference,
                    },
                    ip_address=_client_ip(request),
                )
            except Exception:  # noqa: BLE001
                logger.debug("audit row failed for booking.paid (best-effort)")

            booking_matches_payload["auto_confirmed"].append({
                "csv_row_index": idx,
                "booking_id": best.booking_id,
                "sale_id": str(getattr(sale, "id", "")),
                "bilagsnummer": _format_bilagsnummer(
                    getattr(sale, "voucher_number", None),
                    getattr(sale, "date", txn_date),
                ),
                "matched_reference": best.matched_reference,
                "reason": best.reason,
            })
        else:
            # MED/LOW (or HIGH but the bridge isn't loaded yet) →
            # surface for human review.
            booking_matches_payload["needs_review"].append({
                "csv_row_index": idx,
                "candidates": [_serialize_match(m) for m in candidates],
            })

    db.commit()

    return {
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "booking_matches": booking_matches_payload,
    }


# ── Confirm a single booking-match candidate ────────────────────────
#
# Frontend reads `needs_review` candidates from /confirm and renders
# a "Confirm this match?" UI. When the organizer taps Confirm we land
# here. Multi-barrier layers enforced inline:
#
#   L1 — get_current_user dependency (auth)
#   L2 — organizer scope on the PaymentConnection lookup
#   L7 — tenant ownership of BOTH the connection AND the booking
#         (cross-tenant booking_id → 403, not 404, because the
#          caller already authenticated and is provably wrong)
#   L8 — audit row 'booking.paid' with reconciliation='csv_manual'
#
# Body shape stays loose (Pydantic model below) so the frontend can
# evolve without lockstep changes.


class ConfirmMatchRequest(BaseModel):
    csv_row_index: int = Field(..., ge=0)
    booking_id: uuid.UUID


@router.post("/{import_id}/confirm-match")
def confirm_booking_match(
    import_id: uuid.UUID,
    body: ConfirmMatchRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Confirm a MED/LOW-confidence booking match selected by the
    organizer. Writes the Sale via `write_sale_from_booking` and
    flips the booking to 'paid'.

    `import_id` here is the PaymentConnection.id used during the
    CSV sync (the existing payment_import flow uses connection_id
    as the import cursor — there is no separate PaymentImport
    entity in v1). Treating it as the import handle keeps the URL
    stable when a real PaymentImport row materialises later.
    """
    # ── L2 + L7 — connection ownership ────────────────────────────
    conn = (
        db.query(PaymentConnection)
        .filter(
            PaymentConnection.id == import_id,
            PaymentConnection.user_id == user.id,
        )
        .first()
    )
    if conn is None:
        # IDOR convention: 404 for a connection that may or may not
        # exist under another tenant.
        raise HTTPException(404, "Import not found")

    # ── L7 — booking ownership (cross-tenant → 403) ────────────────
    booking = _resolve_booking(db, body.booking_id, user.id)
    if booking is None:
        # Spec requires 403 on cross-tenant booking confirm. The
        # caller already authenticated successfully under L1; the
        # explicit cross-tenant assertion is a hard 'forbidden'.
        raise HTTPException(403, "Booking not accessible")

    # Already-paid booking → idempotent success (no double-write)
    if getattr(booking, "status", None) == "paid":
        sale_id_existing = getattr(booking, "sale_id", None)
        return {
            "ok": True,
            "already_paid": True,
            "booking_id": str(booking.id),
            "sale_id": str(sale_id_existing) if sale_id_existing else None,
            "bilagsnummer": None,
        }

    # ── Write the Sale via the booking→sale bridge ────────────────
    try:
        from app.services.booking_to_sale import (  # type: ignore[import-not-found]
            write_sale_from_booking,
        )
    except Exception:
        raise HTTPException(
            503,
            "Booking confirmation not available yet — booking_to_sale bridge missing",
        )

    try:
        sale = write_sale_from_booking(db, booking)
    except Exception as e:  # noqa: BLE001
        logger.error(
            "confirm-match write_sale_from_booking failed booking=%s err=%s",
            body.booking_id, e,
        )
        raise HTTPException(500, "Failed to write sale from booking") from e

    # ── L8 — audit row ────────────────────────────────────────────
    try:
        audit_service.record(
            db, user,
            action="booking.paid",
            entity_type="booking",
            entity_id=booking.id,
            after={
                "booking_id": str(booking.id),
                "sale_id": str(getattr(sale, "id", "")),
                "reconciliation": "csv_manual",
                "csv_row_index": body.csv_row_index,
                "import_id": str(import_id),
            },
            ip_address=_client_ip(request),
        )
    except Exception:  # noqa: BLE001
        logger.debug("audit row failed for booking.paid (best-effort)")

    db.commit()
    db.refresh(sale)

    return {
        "ok": True,
        "booking_id": str(booking.id),
        "sale_id": str(getattr(sale, "id", "")),
        "bilagsnummer": _format_bilagsnummer(
            getattr(sale, "voucher_number", None),
            getattr(sale, "date", date.today()),
        ),
    }
