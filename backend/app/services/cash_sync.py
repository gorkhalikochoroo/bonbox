from sqlalchemy.orm import Session
from app.models.cashbook import CashTransaction
import uuid
from datetime import date as date_type


def sync_cash_in_for_sale(db: Session, sale):
    """Post the cash_in for a cash sale — and leave EXACTLY ONE behind.

    The clear-first is the same key argument the unsyncs rest on:
    `sale_<this id>` scoped to this owner can only ever match a line this
    same sale produced, so removing it first cannot touch anybody else's
    row. Without it this was a blind INSERT, and the drawer counted one
    sale twice wherever a line already existed — an importer syncs a
    "mixed" sale (bank_import:151, payment_import:415), the owner then
    corrects the method to "cash", and update_sale's create branch adds a
    SECOND cash_in for the same 2.400 kr.
    """
    ref_id = f"sale_{sale.id}"
    delete_cash_entry_by_ref(db, ref_id, sale.user_id)
    txn = CashTransaction(
        id=uuid.uuid4(),
        user_id=sale.user_id,
        date=sale.date,
        type="cash_in",
        amount=float(sale.amount),
        description=f"{sale.notes or 'Sale'} (auto)",
        category="Sales",
        reference_id=ref_id,
    )
    db.add(txn)


def sync_cash_out_for_expense(db: Session, expense, category_name=None):
    """Post the cash_out for a cash expense — and leave EXACTLY ONE behind.

    Same rule as sync_cash_in_for_sale: keyed by `expense_<this id>` for
    this owner, so the clear-first is provably confined to this expense's
    own line. The blind INSERT double-counted real money on two reachable
    paths — an imported bank_transfer expense (the four importers sync
    with no method check) later corrected to "cash", and a pending draft
    synced by an edit and then synced again by _promote_to_approved.
    Re-posting rather than editing in place is deliberate: the line is a
    mirror of its parent, so it should carry the parent's current
    description and category, not the ones it had when it was first cut.
    """
    from app.models.expense import ExpenseCategory
    if not category_name:
        cat = db.query(ExpenseCategory).filter(ExpenseCategory.id == expense.category_id).first()
        category_name = cat.name if cat else "Purchase"
    ref_id = f"expense_{expense.id}"
    delete_cash_entry_by_ref(db, ref_id, expense.user_id)
    txn = CashTransaction(
        id=uuid.uuid4(),
        user_id=expense.user_id,
        date=expense.date,
        type="cash_out",
        amount=float(expense.amount),
        description=f"{expense.description} (auto)",
        category=category_name,
        reference_id=ref_id,
    )
    db.add(txn)


def delete_cash_entry_by_ref(db: Session, reference_id: str, user_id):
    """Delete the cash entry linked to a sale or expense.

    The key IS the proof of provenance — but only because nothing outside
    this module and khata_sync can write `cash_transactions.reference_id`.
    Keep it that way: it is deliberately absent from CashTransactionCreate
    and CashTransactionUpdate, so no client can hand-type a row that
    another record's delete would sweep up.
    """
    db.query(CashTransaction).filter(
        CashTransaction.reference_id == reference_id,
        CashTransaction.user_id == user_id,
    ).delete()


def update_cash_entry_for_ref(db: Session, reference_id: str, user_id, **updates):
    """Update an existing auto-synced cash entry."""
    txn = db.query(CashTransaction).filter(
        CashTransaction.reference_id == reference_id,
        CashTransaction.user_id == user_id,
    ).first()
    if txn:
        for k, v in updates.items():
            setattr(txn, k, v)
