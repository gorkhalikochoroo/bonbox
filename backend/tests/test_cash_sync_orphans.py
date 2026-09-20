"""A synced cash-book line must never outlive the row it was synced from.

THE OWNER'S VERSION OF THIS BUG
The kassebog shows 1.070 kr. leaving the drawer, the line says
"Grossist (auto)" — and the expense it came from is gone. The owner
cannot open it, cannot trace it, and cannot even remove it: the
cash-book's own Recently Deleted tab filters `reference_id IS NULL`,
so an auto-synced row appears on no recovery surface at all. A revisor
reconciling the drawer queries it and there is no answer to give.

THE MECHANISM
cash_transactions.reference_id is a plain String(100) — no FK, no
cascade (backend/app/models/cashbook.py). The link is one-directional:
`expense_<id>` / `sale_<id>` strings built by string concatenation in
app/services/cash_sync.py. Nothing at the database level stops a parent
from being deleted out from under its cash line, so every delete path
has to remember to unsync — and the two hard-delete routes did not:

    DELETE /api/expenses/{id}/permanent  →  db.delete(expense), no unsync
    DELETE /api/sales/{id}/permanent     →  db.delete(sale),    no unsync

On the ordinary path the SOFT delete covered for them, because it
unsyncs first. But the soft delete asks a question the producers do not:
it unsyncs only when `payment_method == "cash"` (and, for expenses,
`not is_personal`), while several producers sync under much wider
conditions —

  • the four expense importers (bank_import:204, payment_import:455,
    bank_connect:1247, payment_autosync:143) sync with NO payment-method
    check at all, so a bank_transfer / mobilepay / card expense gets a
    cash_out the guard will never remove;
  • the three sale importers sync on ("cash", "mixed"), so every sale
    imported as "mixed" gets a cash_in no delete path removes;
  • flipping a synced cash expense to is_personal skipped the unsync
    entirely, because update_expense wrapped the whole block in
    `if not expense.is_personal:` using the NEW value.

So the guard evaluates false, the soft delete leaves the row, and the
permanent delete turns it into an orphan nobody can reach.

THE FIX THESE PIN
Stop asking the guard question twice. `delete_cash_entry_by_ref` matches
on the exact key `expense_<this id>` / `sale_<this id>` scoped to the
owner — the key IS the proof of provenance, so calling it with no
payment-method check can never remove a row that was not synced from the
thing being deleted. Every path that destroys a parent unsyncs by key.

Production at the time of writing: 644 cash_transactions, 584 with a
reference_id, ZERO orphans — an unexploded defect, not a historical
mess. No backfill is needed or included here.

Run:
  cd backend && python3 -m pytest tests/test_cash_sync_orphans.py -q
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.cashbook import CashTransaction
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.routers.expenses import _limiter as _exp_limiter
from app.routers.sales import limiter as _sale_limiter
from app.services.auth import get_current_user
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense

_db_ready.set()
_exp_limiter.enabled = False
_sale_limiter.enabled = False


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


# ── fixtures in the owner's shape ─────────────────────────────────────


def _owner(db) -> User:
    u = User(
        email=f"orph-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name="Café",
        business_type="cafe",
        currency="DKK",
        plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _category(db, user) -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name="Vareforbrug", color="#3B82F6")
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _expense(db, user, cat, *, method: str, personal: bool = False, amount: float = 1070.0) -> Expense:
    e = Expense(
        user_id=user.id,
        category_id=cat.id,
        date=date.today(),
        amount=amount,
        description="Grossist",
        payment_method=method,
        is_personal=personal,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _sale(db, user, *, method: str, amount: float = 2400.0) -> Sale:
    s = Sale(
        user_id=user.id,
        date=date.today(),
        amount=amount,
        payment_method=method,
        notes="Dagens salg",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _rows_for(db, user, ref_id: str):
    return (
        db.query(CashTransaction)
        .filter(
            CashTransaction.user_id == user.id,
            CashTransaction.reference_id == ref_id,
        )
        .all()
    )


def _orphans(db, user):
    """Every cash row whose `expense_`/`sale_` parent no longer exists.

    This is the invariant the whole file defends, stated once: a line in
    the kassebog that claims a source must have one. Matched by PREFIX,
    never by "reference_id IS NOT NULL" — the column is shared with
    `khata_payment_` rows that key a different table entirely.
    """
    out = []
    rows = (
        db.query(CashTransaction)
        .filter(
            CashTransaction.user_id == user.id,
            CashTransaction.reference_id.isnot(None),
        )
        .all()
    )
    for r in rows:
        ref = r.reference_id or ""
        if ref.startswith("expense_"):
            pid = ref[len("expense_"):]
            if not db.query(Expense).filter(Expense.id == pid).first():
                out.append(r)
        elif ref.startswith("sale_"):
            pid = ref[len("sale_"):]
            if not db.query(Sale).filter(Sale.id == pid).first():
                out.append(r)
    return out


# ── Expenses ──────────────────────────────────────────────────────────


def test_permanent_delete_of_a_cash_expense_leaves_no_orphan(client, db):
    """The control. A plain cash expense is already clean end to end —
    the soft delete unsyncs and restore re-syncs. If this ever fails the
    fix below has broken the ordinary path, which is the only thing that
    matters more than the bug."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="cash")
    sync_cash_out_for_expense(db, exp)
    db.commit()
    eid, ref = str(exp.id), f"expense_{exp.id}"
    assert len(_rows_for(db, u, ref)) == 1

    assert client.delete(f"/api/expenses/{eid}").status_code == 204
    assert client.delete(f"/api/expenses/{eid}/permanent").status_code == 204

    db.expire_all()
    assert _rows_for(db, u, ref) == []
    assert _orphans(db, u) == []


def test_permanent_delete_of_an_imported_expense_leaves_no_orphan(client, db):
    """Vector A — the four importers sync with no payment-method check,
    so a bank_transfer expense carries a cash_out that the cash-only
    soft-delete guard never removes. The permanent delete then destroys
    the only row that could explain it."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="bank_transfer")
    sync_cash_out_for_expense(db, exp, category_name="Bank")  # as bank_import.py:204 does
    db.commit()
    eid, ref = str(exp.id), f"expense_{exp.id}"
    assert len(_rows_for(db, u, ref)) == 1

    assert client.delete(f"/api/expenses/{eid}").status_code == 204
    assert client.delete(f"/api/expenses/{eid}/permanent").status_code == 204

    db.expire_all()
    assert _orphans(db, u) == [], (
        "the expense is gone; a cash_out keyed to it must not survive — "
        "it shows in the kassebog and on no recovery surface"
    )
    assert _rows_for(db, u, ref) == []


def test_permanent_delete_of_a_personal_flipped_expense_leaves_no_orphan(client, db):
    """Vector B — update_expense wrapped its whole sync block in
    `if not expense.is_personal:` using the NEW value, so flipping a
    synced cash expense to personal skipped the delete branch. The row is
    stranded the moment the owner taps "privat"."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="cash")
    sync_cash_out_for_expense(db, exp)
    db.commit()
    eid, ref = str(exp.id), f"expense_{exp.id}"

    r = client.put(f"/api/expenses/{eid}", json={"is_personal": True})
    assert r.status_code == 200, r.text

    db.expire_all()
    assert _rows_for(db, u, ref) == [], (
        "a private purchase must not post to the business kassebog — "
        "flipping to personal has to unsync what the business sync made"
    )

    assert client.delete(f"/api/expenses/{eid}").status_code == 204
    assert client.delete(f"/api/expenses/{eid}/permanent").status_code == 204
    db.expire_all()
    assert _orphans(db, u) == []


# ── Sales ─────────────────────────────────────────────────────────────


def test_permanent_delete_of_a_cash_sale_leaves_no_orphan(client, db):
    """Control, sales side."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sale = _sale(db, u, method="cash")
    sync_cash_in_for_sale(db, sale)
    db.commit()
    sid, ref = str(sale.id), f"sale_{sale.id}"

    assert client.delete(f"/api/sales/{sid}").status_code == 204
    assert client.delete(f"/api/sales/{sid}/permanent").status_code == 204

    db.expire_all()
    assert _orphans(db, u) == []


def test_permanent_delete_of_a_mixed_sale_leaves_no_orphan(client, db):
    """The sale importers sync on ("cash", "mixed") while every unsync
    is cash-only, so a "mixed" sale's cash_in is removed by no delete
    path at all — and the permanent delete makes it permanent."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sale = _sale(db, u, method="mixed")
    sync_cash_in_for_sale(db, sale)  # as bank_import.py:151 does
    db.commit()
    sid, ref = str(sale.id), f"sale_{sale.id}"
    assert len(_rows_for(db, u, ref)) == 1

    assert client.delete(f"/api/sales/{sid}").status_code == 204
    assert client.delete(f"/api/sales/{sid}/permanent").status_code == 204

    db.expire_all()
    assert _orphans(db, u) == [], (
        "money shown entering the drawer with the sale that explains it destroyed"
    )
    assert _rows_for(db, u, ref) == []


def test_csv_import_undo_removes_the_cash_in_it_undid(client, db):
    """rollback_csv_import bulk-sets is_deleted on up to 1000 sales and
    never unsyncs, so an "Undo" of a CSV import leaves the cash_in of
    every cash sale in the batch counting toward kassebeholdning for a
    sale the owner just took back."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sales = [_sale(db, u, method="cash", amount=500.0) for _ in range(3)]
    for s in sales:
        sync_cash_in_for_sale(db, s)
    db.commit()
    sids = [str(s.id) for s in sales]

    r = client.post("/api/sales/import-csv/rollback", json={"sale_ids": sids})
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 3

    db.expire_all()
    for sid in sids:
        assert _rows_for(db, u, f"sale_{sid}") == [], (
            "undoing the import must take back the cash it booked"
        )

    bal = client.get("/api/cashbook/balance").json()
    assert bal["total_in"] == 0.0, bal


# ── The cash book's own permanent delete ──────────────────────────────


def test_cashbook_permanent_delete_refuses_a_synced_row(client, db):
    """The mirror image of the same bug, closed before anything can
    reach it. The recently-deleted LIST and RESTORE both filter
    `reference_id IS NULL` to keep auto-synced rows off that tab, but the
    permanent delete filtered only on id + owner + is_deleted — so a
    synced row that ever reached is_deleted=True could be destroyed out
    from under its still-living parent."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="cash")
    sync_cash_out_for_expense(db, exp)
    db.commit()
    row = _rows_for(db, u, f"expense_{exp.id}")[0]
    row.is_deleted = True
    db.commit()
    txn_id = row.id

    r = client.delete(f"/api/cashbook/{txn_id}/permanent")
    assert r.status_code == 404, (
        "a row that belongs to a living expense is not the cash book's to destroy"
    )

    db.expire_all()
    assert db.query(CashTransaction).filter(CashTransaction.id == txn_id).first() is not None


def test_cashbook_permanent_delete_still_works_on_a_hand_typed_row(client, db):
    """The other half — a hand-created cash line is a leaf with no parent,
    and the owner must still be able to clear it for good."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post(
        "/api/cashbook",
        json={"date": date.today().isoformat(), "type": "cash_out", "amount": 200.0,
              "description": "Vekselpenge"},
    )
    assert r.status_code == 201, r.text
    txn_id = r.json()["id"]

    assert client.delete(f"/api/cashbook/{txn_id}").status_code == 204
    assert client.delete(f"/api/cashbook/{txn_id}/permanent").status_code == 204

    db.expire_all()
    assert db.query(CashTransaction).filter(CashTransaction.id == txn_id).first() is None


# ── The other half of the invariant: exactly ONE line, never two ──────
#
# Unsyncing by key stops a line outliving its parent. It does nothing
# about the opposite error — the same parent posting TWICE — and the
# producers make that reachable, because `sync_cash_*` was a blind
# INSERT and several paths call it on a parent that already has a line.
# A doubled cash_out is worse than an orphan: an orphan is money the
# owner cannot explain, a duplicate is money that never left the drawer.
# The sync helpers are now keyed-idempotent (clear by ref, then post),
# which is the same proof the unsyncs use, run in the other direction.


def test_correcting_an_imported_expense_to_cash_does_not_double_count(client, db):
    """bank_import syncs a cash_out for a bank_transfer expense. The owner
    then corrects the method to "kontant" — update_expense's create branch
    fired on a row that already had a line and booked 1.070 kr. twice."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="bank_transfer")
    sync_cash_out_for_expense(db, exp, category_name="Bank")  # as bank_import.py:204 does
    db.commit()
    eid, ref = str(exp.id), f"expense_{exp.id}"

    assert client.put(f"/api/expenses/{eid}", json={"payment_method": "cash"}).status_code == 200

    db.expire_all()
    assert len(_rows_for(db, u, ref)) == 1, "one expense, one cash_out"
    assert client.get("/api/cashbook/balance").json()["total_out"] == 1070.0


def test_imported_expense_flipped_to_privat_leaves_the_business_book(client, db):
    """The is_personal drift, one payment method over. `was_synced` asks
    `old_method == "cash"`, so flipping an IMPORTED mobilepay expense to
    "privat" matched no branch and left its cash_out posting a private
    purchase to the business kassebog — exactly what the old
    `if not expense.is_personal` wrapper did to cash ones."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    exp = _expense(db, u, cat, method="mobilepay")
    sync_cash_out_for_expense(db, exp, category_name="Bank")
    db.commit()
    eid, ref = str(exp.id), f"expense_{exp.id}"

    assert client.put(f"/api/expenses/{eid}", json={"is_personal": True}).status_code == 200

    db.expire_all()
    assert _rows_for(db, u, ref) == [], (
        "privat posts nothing to the business kassebog, whatever it was paid with"
    )


def test_correcting_an_imported_mixed_sale_moves_the_drawer_with_it(client, db):
    """An imported "mixed" sale carries a cash_in (importers sync on
    ("cash", "mixed")), but update_sale's keyed update ran only for
    "cash" — so correcting 2.400 kr. to 100 kr. left the drawer still
    quoting 2.400 for a sale that no longer says so. The keyed update
    is UPDATE-IF-EXISTS, so widening it can never invent a line."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sale = _sale(db, u, method="mixed", amount=2400.0)
    sync_cash_in_for_sale(db, sale)  # as bank_import.py:151 does
    db.commit()
    sid = str(sale.id)

    assert client.put(f"/api/sales/{sid}", json={"amount": 100.0}).status_code == 200

    db.expire_all()
    assert client.get("/api/cashbook/balance").json()["total_in"] == 100.0


def test_editing_a_plain_card_sale_never_invents_a_cash_in(client, db):
    """The guard on that widening. A card sale has no cash_in and editing
    it must not mint one — update_cash_entry_for_ref updates, never
    inserts, and this is the test that keeps it that way."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sale = _sale(db, u, method="card", amount=800.0)
    db.commit()
    sid = str(sale.id)

    assert client.put(f"/api/sales/{sid}", json={"amount": 950.0}).status_code == 200

    db.expire_all()
    assert _rows_for(db, u, f"sale_{sid}") == []
    assert client.get("/api/cashbook/balance").json()["total_in"] == 0.0


def test_a_pending_draft_does_not_post_to_the_kassebog_before_godkend(client, db):
    """expense_status.py: a draft is a machine-read guess and must reach
    no number the owner trusts — the kassebog balance included. A scanned
    draft whose receipt did not say how it was paid, then edited to
    "kontant", posted a cash_out immediately AND again at Godkend."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    draft = _expense(db, u, cat, method=None, amount=249.0)
    draft.status = "pending"
    db.commit()
    eid, ref = str(draft.id), f"expense_{draft.id}"

    assert client.put(f"/api/expenses/{eid}", json={"payment_method": "cash"}).status_code == 200
    db.expire_all()
    assert _rows_for(db, u, ref) == [], "a draft is not in the drawer yet"

    r = client.post(f"/api/expenses/{eid}/approve")
    assert r.status_code == 200, r.text
    db.expire_all()
    assert len(_rows_for(db, u, ref)) == 1, "Godkend posts it exactly once"
    assert client.get("/api/cashbook/balance").json()["total_out"] == 249.0


def test_cashbook_create_ignores_a_client_supplied_reference_id(client, db):
    """`reference_id` is the provenance proof every unsync leans on, so
    it is server-owned: delete_cash_entry_by_ref removes a row on the
    strength of that key alone. A client that could set it could plant a
    hand-typed line under a living sale's key — swept away with that
    sale, and invisible on the cash book's own Recently Deleted tab,
    which filters `reference_id IS NULL`."""
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u

    sale = _sale(db, u, method="cash")
    sync_cash_in_for_sale(db, sale)
    db.commit()
    sid = str(sale.id)

    r = client.post("/api/cashbook", json={
        "date": date.today().isoformat(), "type": "cash_out", "amount": 999.0,
        "description": "Vekselpenge", "reference_id": f"sale_{sid}",
    })
    assert r.status_code == 201, r.text
    assert r.json()["reference_id"] is None, "reference_id is server-owned"
    hand_id = uuid.UUID(r.json()["id"])

    assert client.delete(f"/api/sales/{sid}").status_code == 204
    assert client.delete(f"/api/sales/{sid}/permanent").status_code == 204

    db.expire_all()
    assert db.query(CashTransaction).filter(CashTransaction.id == hand_id).first() is not None, (
        "the owner's own hand-typed line is not collateral of a sale delete"
    )
