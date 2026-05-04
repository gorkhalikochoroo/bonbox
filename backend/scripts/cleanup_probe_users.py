#!/usr/bin/env python3
"""
Delete all multi_tenant_probe.py test users + their data.

The probe registers users with emails matching `@bonbox-probe.com`, including
the data each one creates (sales, expenses, khata customers, categories).

Run from the backend directory:
    PYTHONPATH=. python scripts/cleanup_probe_users.py

OR (after the import-path-fix deploy):
    python scripts/cleanup_probe_users.py

Defaults to DRY-RUN. Pass --confirm to actually delete.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Same import-path fix as promote_admin.py — works regardless of cwd
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


PROBE_EMAIL_DOMAIN = "@bonbox-probe.com"


def main(confirm: bool) -> int:
    try:
        from app.database import SessionLocal
        from app.models.user import User
        from app.models.sale import Sale
        from app.models.expense import Expense, ExpenseCategory
        from app.models.khata import KhataCustomer, KhataTransaction
    except ImportError as e:
        print(f"ERROR: cannot import backend modules ({e})")
        print("Run from the backend directory:  cd backend && python scripts/cleanup_probe_users.py")
        return 1

    db = SessionLocal()
    try:
        users = db.query(User).filter(User.email.like(f"%{PROBE_EMAIL_DOMAIN}")).all()
        if not users:
            print("No probe users found. Nothing to clean up.")
            return 0

        print(f"Found {len(users)} probe user(s):")
        for u in users:
            print(f"  - {u.email} (id={u.id}, role={u.role}, created={u.created_at})")
        print()

        if not confirm:
            print("DRY RUN. Pass --confirm to delete these users + their data.")
            return 0

        # Cascade delete each tenant's data
        deleted_summary = {"users": 0, "sales": 0, "expenses": 0, "categories": 0, "khata_customers": 0, "khata_txns": 0}
        for u in users:
            uid = u.id

            # Sales
            n = db.query(Sale).filter(Sale.user_id == uid).delete(synchronize_session=False)
            deleted_summary["sales"] += n

            # Expenses (must come before categories — FK)
            n = db.query(Expense).filter(Expense.user_id == uid).delete(synchronize_session=False)
            deleted_summary["expenses"] += n

            # Expense categories
            n = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == uid).delete(synchronize_session=False)
            deleted_summary["categories"] += n

            # Khata transactions (via customer relationship)
            cust_ids = [c.id for c in db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).all()]
            if cust_ids:
                n = db.query(KhataTransaction).filter(KhataTransaction.customer_id.in_(cust_ids)).delete(synchronize_session=False)
                deleted_summary["khata_txns"] += n

            # Khata customers
            n = db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).delete(synchronize_session=False)
            deleted_summary["khata_customers"] += n

            # Finally the user
            db.delete(u)
            deleted_summary["users"] += 1

        db.commit()

        print("Cleanup complete:")
        for k, v in deleted_summary.items():
            print(f"  {k:18s}: {v}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    confirm = "--confirm" in sys.argv
    sys.exit(main(confirm))
