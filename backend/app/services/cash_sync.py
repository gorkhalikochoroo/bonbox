from sqlalchemy.orm import Session
from app.models.cashbook import CashTransaction
import uuid
from datetime import date as date_type


def sync_cash_in_for_sale(db: Session, sale):
    """Create cash_in entry when a cash sale is created."""
    ref_id = f"sale_{sale.id}"
    txn = CashTransaction(
        id=uuid.uuid4(),
        user_id=sale.user_id,
        date=sale.date,
        type="cash_in",
        amount=float(sale.amount),
        description=f"Sale (auto)",
        category="Sales",
        reference_id=ref_id,
    )
    db.add(txn)


def sync_cash_out_for_expense(db: Session, expense):
    """Create cash_out entry when a cash expense is created."""
    ref_id = f"expense_{expense.id}"
    txn = CashTransaction(
        id=uuid.uuid4(),
        user_id=expense.user_id,
        date=expense.date,
        type="cash_out",
        amount=float(expense.amount),
        description=f"{expense.description} (auto)",
        category="Purchase",
        reference_id=ref_id,
    )
    db.add(txn)


def delete_cash_entry_by_ref(db: Session, reference_id: str, user_id):
    """Delete cash entry linked to a sale or expense."""
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
