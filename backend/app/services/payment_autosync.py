"""Background auto-sync for connected payment providers.

Runs every 6 hours via APScheduler. For each active connection with
auto_sync=True, fetches the last 3 days of transactions and imports
new ones automatically (duplicates are skipped via ref_hash dedup).

This means: connect MobilePay once → your sales appear in BonBox
automatically, no manual clicking needed.
"""
import asyncio
import json
import uuid
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.payment_connection import PaymentConnection
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.services.payment_providers import fetch_transactions, PROVIDERS
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense


# How far back to look on each auto-sync (days)
AUTO_SYNC_LOOKBACK_DAYS = 3


def _import_transactions_for_connection(db: Session, conn: PaymentConnection, raw_txns: list[dict]) -> tuple[int, int]:
    """Import fetched transactions, skip duplicates. Returns (imported, skipped)."""
    imported = 0
    skipped = 0

    for txn in raw_txns:
        ref_id = f"pay_{conn.provider}_{txn['ref_hash']}"

        try:
            txn_date = date.fromisoformat(txn["date"])
        except ValueError:
            continue

        if txn.get("type") == "income" or txn.get("amount", 0) >= 0:
            # Check duplicate
            exists = db.query(Sale.id).filter(
                Sale.user_id == conn.user_id,
                Sale.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            # Voucher allocator (lazy, defensive — autosync runs every 6h
            # so a voucher_service hiccup mustn't break the scheduled job)
            try:
                from app.services.voucher_service import allocate_voucher
                vn = allocate_voucher(db, conn.user_id, "sale", txn_date.year)
            except Exception:  # noqa: BLE001
                vn = None

            sale = Sale(
                id=uuid.uuid4(),
                user_id=conn.user_id,
                date=txn_date,
                amount=abs(txn.get("amount", 0)),
                payment_method=txn.get("payment_method", "mobilepay"),
                notes=txn.get("description", ""),
                reference_id=ref_id,
                status="completed",
                voucher_number=vn,
            )
            db.add(sale)
            db.flush()
            # Auto-sync to cashbook for cash/mixed payments
            if txn.get("payment_method") in ("cash", "mixed"):
                sync_cash_in_for_sale(db, sale)
            imported += 1

        else:
            # Expense
            exists = db.query(Expense.id).filter(
                Expense.user_id == conn.user_id,
                Expense.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            cat_name = "Payment Fees"
            category = db.query(ExpenseCategory).filter(
                ExpenseCategory.user_id == conn.user_id,
                ExpenseCategory.name == cat_name,
            ).first()
            if not category:
                category = ExpenseCategory(
                    id=uuid.uuid4(),
                    user_id=conn.user_id,
                    name=cat_name,
                )
                db.add(category)
                db.flush()

            try:
                from app.services.voucher_service import allocate_voucher
                vn = allocate_voucher(db, conn.user_id, "expense", txn_date.year)
            except Exception:  # noqa: BLE001
                vn = None

            expense = Expense(
                id=uuid.uuid4(),
                user_id=conn.user_id,
                date=txn_date,
                amount=abs(txn.get("amount", 0)),
                description=txn.get("description", ""),
                category_id=category.id,
                payment_method=txn.get("payment_method", "mobilepay"),
                reference_id=ref_id,
                voucher_number=vn,
            )
            db.add(expense)
            db.flush()
            sync_cash_out_for_expense(db, expense, category_name=cat_name)
            imported += 1

    return imported, skipped


async def _sync_one_connection(conn_id: uuid.UUID, provider: str, creds_json: str, user_id: uuid.UUID) -> tuple[int, int]:
    """Fetch + import for a single connection. Returns (imported, skipped)."""
    creds = json.loads(creds_json)
    d_to = date.today()
    d_from = d_to - timedelta(days=AUTO_SYNC_LOOKBACK_DAYS)

    try:
        raw_txns = await fetch_transactions(provider, creds, d_from, d_to)
    except Exception as e:
        print(f"  Auto-sync fetch error for {provider}: {e}")
        return 0, 0

    if not raw_txns:
        return 0, 0

    # Import in a fresh DB session
    db = SessionLocal()
    try:
        imported, skipped = _import_transactions_for_connection(
            db,
            # We need the connection object for user_id and provider
            type("Conn", (), {"user_id": user_id, "provider": provider})(),
            raw_txns,
        )
        # Update last_synced_at and last_auto_imported
        conn = db.query(PaymentConnection).filter(PaymentConnection.id == conn_id).first()
        if conn:
            conn.last_synced_at = datetime.utcnow()
            conn.last_auto_imported = imported
        db.commit()
        return imported, skipped
    except Exception as e:
        db.rollback()
        print(f"  Auto-sync import error for {provider}: {e}")
        return 0, 0
    finally:
        db.close()


def run_auto_sync():
    """Main entry point — called by APScheduler every 6 hours.

    Finds all active auto_sync connections and fetches their recent transactions.
    """
    print(f"[Auto-sync] Starting payment auto-sync at {datetime.utcnow().isoformat()}")

    db = SessionLocal()
    try:
        connections = db.query(PaymentConnection).filter(
            PaymentConnection.is_active == True,
            PaymentConnection.auto_sync == True,
        ).all()

        if not connections:
            print("[Auto-sync] No active auto-sync connections found")
            return

        print(f"[Auto-sync] Found {len(connections)} connection(s) to sync")

        # Collect connection info before closing the session
        conn_infos = [
            (conn.id, conn.provider, conn.credentials, conn.user_id, conn.label)
            for conn in connections
        ]
    finally:
        db.close()

    # Run async fetches
    total_imported = 0
    total_skipped = 0

    async def _run_all():
        nonlocal total_imported, total_skipped
        for conn_id, provider, creds_json, user_id, label in conn_infos:
            print(f"  Syncing: {label} ({provider})")
            imported, skipped = await _sync_one_connection(conn_id, provider, creds_json, user_id)
            total_imported += imported
            total_skipped += skipped
            if imported > 0:
                print(f"  → {imported} new, {skipped} duplicates skipped")

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If we're inside an existing event loop (FastAPI),
            # schedule as a task
            asyncio.ensure_future(_run_all())
        else:
            loop.run_until_complete(_run_all())
    except RuntimeError:
        # No event loop exists yet
        asyncio.run(_run_all())

    print(f"[Auto-sync] Done: {total_imported} imported, {total_skipped} duplicates skipped")
