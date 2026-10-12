"""Postgres only: the '[needs review]' backfill runs once, never again.

12 Oct review M6. main.py ran
  UPDATE expenses SET status='pending' WHERE status='approved'
    AND description LIKE '%[needs review]%'
on EVERY Postgres boot: an owner approved a low-confidence inbox receipt and
the next deploy sent it back to the Godkend-kø (out of the MOMS again).

Two boots against a real Postgres (16 in the proof run):
  boot 1  the backfill flips the legacy machine-booked row (approved, no
          bilagsnummer) to pending — once;
  owner   approves it (bilagsnummer, marker removed);
  boot 2  nothing moves — not the approved row, not an old approved row that
          still carries the marker, not a new marker row.

Skipped on SQLite (the statement is Postgres-only).
Run: DATABASE_URL=postgresql://… python -m pytest tests/test_needs_review_backfill_pg.py
"""
import os
import uuid
from datetime import date

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL", "").startswith("postgresql"),
    reason="Postgres-only migration statement",
)


def test_two_boots_never_send_an_approved_receipt_back_to_the_queue():
    import app.main as m
    from fastapi.testclient import TestClient
    from sqlalchemy import text
    from app.database import SessionLocal
    from app.models.expense import Expense, ExpenseCategory
    from app.models.user import User
    from app.services.auth import get_current_user

    try:
        m._scheduler.shutdown(wait=False)
    except Exception:  # noqa: BLE001
        pass
    with m.engine.begin() as c:
        c.execute(text("DROP TABLE IF EXISTS data_backfills"))
    m._init_db()                                   # tables in place (first boot of an empty DB)
    db = SessionLocal()
    u = User(email=f"nr-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x", business_name="NR",
             business_type="cafe", currency="DKK", plan="starter", email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    c_ = ExpenseCategory(user_id=u.id, name="Varekøb"); db.add(c_); db.commit(); db.refresh(c_)
    # Booked by the pre-queue inbox: approved, no bilagsnummer, marked.
    legacy = Expense(user_id=u.id, category_id=c_.id, date=date(2026, 9, 25), amount=480,
                     description="From Faktura 123 [needs review]", payment_method="card",
                     status="approved", receipt_source="scan")
    # Approved by its owner under the old code: bilagsnummer, marker still there.
    old_ok = Expense(user_id=u.id, category_id=c_.id, date=date(2026, 9, 26), amount=99,
                     description="Netto [needs review]", payment_method="card",
                     status="approved", voucher_number=41, receipt_source="scan")
    db.add_all([legacy, old_ok]); db.commit()
    with m.engine.begin() as c:
        if c.execute(text("SELECT to_regclass('data_backfills')")).scalar():
            c.execute(text("DELETE FROM data_backfills"))

    m._run_migrations()                            # boot 1 of this code: the one-shot runs
    db.expire_all()
    assert db.get(Expense, legacy.id).status == "pending"
    assert db.get(Expense, old_ok.id).status == "approved"

    m.app.dependency_overrides[get_current_user] = lambda: u
    try:
        r = TestClient(m.app).post(f"/api/expenses/{legacy.id}/approve")
    finally:
        m.app.dependency_overrides.pop(get_current_user, None)
    assert r.status_code == 200, r.text
    # A row a later code path might still mark (never flipped by a later boot).
    later = Expense(user_id=u.id, category_id=c_.id, date=date(2026, 9, 27), amount=12,
                    description="Kiosk [needs review]", payment_method="card", status="approved")
    db.add(later); db.commit()

    m._run_migrations()                            # boot 2
    m._run_migrations()                            # boot 3
    db.expire_all()
    row = db.get(Expense, legacy.id)
    assert (row.status, row.description) == ("approved", "From Faktura 123")
    assert row.voucher_number is not None
    assert db.get(Expense, old_ok.id).status == "approved"
    assert db.get(Expense, later.id).status == "approved"
    with m.engine.connect() as c:
        assert c.execute(text(
            "SELECT count(*) FROM data_backfills WHERE name = 'expenses_needs_review_to_pending_v1'"
        )).scalar() == 1
    db.close()
