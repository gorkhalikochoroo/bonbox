"""Sync Khata transactions to Sales and CashBook entries."""
from sqlalchemy.orm import Session
from app.models.sale import Sale
from app.models.cashbook import CashTransaction
import uuid


def sync_sale_for_khata_purchase(db: Session, txn, customer_name: str):
    """When purchase_amount > 0, create a Sale entry."""
    if float(txn.purchase_amount) <= 0:
        return
    ref_id = f"khata_purchase_{txn.id}"
    existing = db.query(Sale).filter(Sale.reference_id == ref_id).first()
    if existing:
        return
    sale = Sale(
        id=uuid.uuid4(),
        user_id=txn.user_id,
        date=txn.date,
        amount=float(txn.purchase_amount),
        payment_method="credit",
        notes=f"Khata: {customer_name}",
        reference_id=ref_id,
    )
    db.add(sale)


def sync_cashbook_for_khata_payment(db: Session, txn, customer_name: str):
    """When paid_amount > 0, create a CashBook cash_in entry."""
    if float(txn.paid_amount) <= 0:
        return
    ref_id = f"khata_payment_{txn.id}"
    existing = db.query(CashTransaction).filter(CashTransaction.reference_id == ref_id).first()
    if existing:
        return
    cash_txn = CashTransaction(
        id=uuid.uuid4(),
        user_id=txn.user_id,
        date=txn.date,
        type="cash_in",
        amount=float(txn.paid_amount),
        description=f"Khata payment: {customer_name} (auto)",
        category="Khata",
        reference_id=ref_id,
    )
    db.add(cash_txn)


def delete_khata_synced_entries(db: Session, txn_id, user_id):
    """Delete Sale and CashBook entries linked to a khata transaction."""
    db.query(Sale).filter(
        Sale.reference_id == f"khata_purchase_{txn_id}",
        Sale.user_id == user_id,
    ).delete()
    db.query(CashTransaction).filter(
        CashTransaction.reference_id == f"khata_payment_{txn_id}",
        CashTransaction.user_id == user_id,
    ).delete()


def update_khata_synced_entries(db: Session, txn, customer_name: str):
    """Update synced entries when khata transaction is edited."""
    # Update sale
    sale = db.query(Sale).filter(Sale.reference_id == f"khata_purchase_{txn.id}").first()
    if sale and float(txn.purchase_amount) > 0:
        sale.amount = float(txn.purchase_amount)
        sale.date = txn.date
        sale.notes = f"Khata: {customer_name}"
    elif sale and float(txn.purchase_amount) <= 0:
        db.delete(sale)
    elif not sale and float(txn.purchase_amount) > 0:
        sync_sale_for_khata_purchase(db, txn, customer_name)

    # Update cashbook
    cash = db.query(CashTransaction).filter(
        CashTransaction.reference_id == f"khata_payment_{txn.id}"
    ).first()
    if cash and float(txn.paid_amount) > 0:
        cash.amount = float(txn.paid_amount)
        cash.date = txn.date
        cash.description = f"Khata payment: {customer_name} (auto)"
    elif cash and float(txn.paid_amount) <= 0:
        db.delete(cash)
    elif not cash and float(txn.paid_amount) > 0:
        sync_cashbook_for_khata_payment(db, txn, customer_name)
