"""Opt-in Postgres test: a linked bank line counts once (Push 8, 12 Oct 2026).

SKIPPED unless BONBOX_TEST_PG_URL names a Postgres database. The SQLite half
is tests/test_bank_reconcile_link_counts_once.py. This runs the shared money
gate (expense_status.not_pending, now with a correlated NOT EXISTS on the
same table) inside the filing's real queries on Postgres 16 — the SUM and the
GROUP BY category behind købsmoms — and the migration's ALTER.

    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/postgres \\
        python -m pytest -q tests/test_pg_bank_reconcile_link.py

Own schema (bl_<random>), own engine, dropped at the end. Never production.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, timedelta

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres bank-link test: set BONBOX_TEST_PG_URL",
                allow_module_level=True)

import sqlalchemy as sa  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database import Base  # noqa: E402
import app.models  # noqa: E402,F401
from app.models.expense import Expense, ExpenseCategory  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import bank_reconciliation as recon  # noqa: E402
from app.services.tax_filing_pdf import compute_filing_data  # noqa: E402

DAY = date.today() - timedelta(days=3)


@pytest.fixture(scope="module")
def eng():
    admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    schema = "bl_" + uuid.uuid4().hex[:12]
    with admin.connect() as c:
        c.execute(text(f'CREATE SCHEMA "{schema}"'))
    e = sa.create_engine(PG_URL + ("&" if "?" in PG_URL else "?") + f"options=-csearch_path%3D{schema}")
    Base.metadata.create_all(e)
    yield e
    e.dispose()
    with admin.connect() as c:
        c.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


def test_the_alter_matches_the_model_type(eng):
    from app import main

    sql = [s for s in main._migrations if isinstance(s, str) and "linked_expense_id" in s][0]
    with eng.begin() as c:
        c.execute(text("ALTER TABLE expenses DROP COLUMN linked_expense_id"))
        c.execute(text(sql))
        c.execute(text(sql))  # idempotent
        row = c.execute(text(
            "SELECT data_type, character_maximum_length, is_nullable, column_default "
            "FROM information_schema.columns WHERE table_schema = current_schema() "
            "AND table_name = 'expenses' AND column_name = 'linked_expense_id'")).one()
    assert tuple(row) == ("character varying", 36, "YES", None)


def test_link_and_unlink_through_the_filing_queries(eng):
    s = sessionmaker(bind=eng, autoflush=False)()
    u = User(email=f"{uuid.uuid4().hex[:8]}@pg.test", password_hash="x", business_name="B",
             business_type="cafe", currency="DKK", role="owner", plan="pro")
    s.add(u)
    s.commit()
    cat = ExpenseCategory(user_id=u.id, name="Varekøb")
    s.add(cat)
    s.commit()
    receipt = Expense(user_id=u.id, category_id=cat.id, date=DAY, amount=1250, description="bon")
    bank = Expense(user_id=u.id, category_id=cat.id, date=DAY, amount=1250, description="BANK",
                   reference_id="bank_danske_bank_x1")
    s.add_all([receipt, bank])
    s.commit()

    def filing():
        fd = compute_filing_data(s, u, DAY.replace(day=1), DAY)
        return round(float(fd["kob_med_moms"]), 2), round(float(fd["moms_af_kob"]), 2)

    assert filing() == (2500.0, 500.0)
    out = recon.confirm_matches(s, u, [{"txn_id": str(bank.id), "target_type": "expense",
                                        "target_id": str(receipt.id), "action": "link"}])
    s.commit()
    assert out["confirmed"] == 1, out
    assert filing() == (1250.0, 250.0)
    rows = {r.txn_id: r for r in recon.match_transactions(s, u.id)}
    assert rows[str(bank.id)].linked_target_id == str(receipt.id)
    recon.confirm_matches(s, u, [{"txn_id": str(bank.id), "target_type": "expense",
                                  "target_id": str(receipt.id), "action": "unlink"}])
    s.commit()
    assert filing() == (2500.0, 500.0)
    s.close()
