"""A bank line linked to the expense it paid counts once (Push 8, 12 Oct 2026).

THE DEFECT. Bank reconcile's expense "link" (the owner says "this bank line
IS the receipt I snapped") only wrote "[linked:<id>]" into the bank line's
notes. Both rows stayed in every money total — expenses, the Foresight burn,
the reports — and in købsmoms: compute_filing_data deducted the same
purchase's MOMS twice.

THE FIX. The link is stored (expenses.linked_expense_id on the bank line)
and the shared money gate, expense_status.not_pending(), leaves the bank
line out while it is linked to a live, approved expense. Nothing is deleted:
the bank line keeps its row, voucher and notes; "unlink" (same endpoint,
action "unlink") puts it back in every total; both are audit-logged. If the
linked expense is deleted or is still an unapproved draft, the bank line
counts again on its own — the payment is never counted zero times. The
revisor export (bookkeeping_export) leaves the linked bank line out too, so
it ties out with the filing.

Run: cd backend && python -m pytest -q tests/test_bank_reconcile_link_counts_once.py
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.audit_log import AuditLog
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services import bank_reconciliation as recon
from app.services.auth import create_access_token, hash_password
from app.services.expense_status import not_pending
from app.services.tax_filing_pdf import compute_filing_data

_db_ready.set()

DAY = date.today() - timedelta(days=3)


@pytest.fixture
def factory():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def db(factory):
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(factory):
    def _get_test_db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@cafe.dk", password_hash=hash_password("x"),
             business_name="Bon Café", business_type="cafe", currency="DKK", role="owner",
             plan="pro", email_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _cat(db, u, name="Varekøb"):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c)
    db.commit()
    return c


def _exp(db, u, cat, amount, *, bank=False, status=None, d=DAY, desc="Hørkram"):
    e = Expense(user_id=u.id, category_id=cat.id, date=d, amount=amount, description=desc,
                payment_method="card",
                reference_id=f"bank_danske_bank_{uuid.uuid4().hex[:12]}" if bank else None)
    if status:
        e.status = status
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _pair(db):
    u = _owner(db)
    cat = _cat(db, u)
    receipt = _exp(db, u, cat, 1250, desc="Hørkram (bon)")
    bank = _exp(db, u, cat, 1250, bank=True, desc="HORKRAM A/S")
    return u, receipt, bank


def _link(db, u, bank, target, action="link"):
    out = recon.confirm_matches(db, u, [{"txn_id": str(bank.id), "target_type": "expense",
                                         "target_id": str(target.id), "action": action}])
    db.commit()
    return out


def _counted(db, u):
    return float(db.query(func.coalesce(func.sum(Expense.amount), 0))
                 .filter(Expense.user_id == u.id, Expense.is_deleted.isnot(True), not_pending())
                 .scalar())


def _filing(db, u):
    fd = compute_filing_data(db, u, DAY.replace(day=1), DAY)
    return round(float(fd["kob_med_moms"]), 2), round(float(fd["moms_af_kob"]), 2)


def test_a_link_counts_the_payment_once_in_totals_and_kobsmoms(db):
    u, receipt, bank = _pair(db)
    assert _counted(db, u) == 2500.0
    assert _filing(db, u) == (2500.0, 500.0)      # the double count
    out = _link(db, u, bank, receipt)
    assert out["confirmed"] == 1 and not out["errors"], out
    assert _counted(db, u) == 1250.0
    assert _filing(db, u) == (1250.0, 250.0)


def test_the_bank_line_is_kept_not_deleted(db):
    u, receipt, bank = _pair(db)
    _link(db, u, bank, receipt)
    db.expire_all()
    row = db.get(Expense, bank.id)
    assert row is not None and row.is_deleted is False
    assert row.linked_expense_id == receipt.id
    assert f"[linked:{receipt.id}]" in (row.notes or "")


def test_unlink_puts_both_back_and_both_steps_are_audited(db):
    u, receipt, bank = _pair(db)
    _link(db, u, bank, receipt)
    out = _link(db, u, bank, receipt, action="unlink")
    assert out["confirmed"] == 1 and not out["errors"], out
    db.expire_all()
    row = db.get(Expense, bank.id)
    assert row.linked_expense_id is None
    assert "[linked:" not in (row.notes or "")
    assert _counted(db, u) == 2500.0
    assert _filing(db, u) == (2500.0, 500.0)
    actions = [a.action for a in db.query(AuditLog).filter(AuditLog.user_id == u.id)
               .order_by(AuditLog.created_at)]
    assert "bank_reconcile.match_confirmed" in actions
    assert "bank_reconcile.match_unlinked" in actions


def test_a_deleted_or_draft_target_never_leaves_the_payment_uncounted(db):
    u, receipt, bank = _pair(db)
    _link(db, u, bank, receipt)
    receipt.is_deleted = True
    db.commit()
    assert _counted(db, u) == 1250.0               # the bank line, on its own

    u2 = _owner(db)
    cat = _cat(db, u2)
    draft = _exp(db, u2, cat, 800, status="pending")
    bank2 = _exp(db, u2, cat, 800, bank=True)
    _link(db, u2, bank2, draft)
    assert _counted(db, u2) == 800.0               # the draft is out, the bank line in
    draft.status = "approved"
    db.commit()
    assert _counted(db, u2) == 800.0               # approved: the receipt, not both


def test_one_payment_one_link(db):
    u, receipt, bank = _pair(db)
    cat = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == u.id).first()
    other_bank = _exp(db, u, cat, 1250, bank=True, desc="HORKRAM A/S #2")
    other_receipt = _exp(db, u, cat, 1250, desc="Hørkram (bon 2)")
    assert _link(db, u, bank, receipt)["confirmed"] == 1
    assert _link(db, u, bank, receipt)["skipped"] == 1               # idempotent
    second = _link(db, u, other_bank, receipt)                        # receipt already paid by `bank`
    assert second["confirmed"] == 0 and second["errors"], second
    moved = _link(db, u, bank, other_receipt)                         # bank already linked elsewhere
    assert moved["confirmed"] == 0 and moved["errors"], moved
    not_a_bank_line = _link(db, u, other_receipt, receipt)
    assert not_a_bank_line["confirmed"] == 0 and not_a_bank_line["errors"]
    assert _counted(db, u) == 1250.0 * 3


def test_another_tenants_expense_cannot_be_linked(db):
    u, _, bank = _pair(db)
    stranger = _owner(db)
    theirs = _exp(db, stranger, _cat(db, stranger), 1250)
    out = _link(db, u, bank, theirs)
    assert out["confirmed"] == 0 and out["errors"]
    assert _counted(db, u) == 2500.0


def test_the_reconcile_list_shows_the_link_and_hides_a_used_target(db):
    u, receipt, bank = _pair(db)
    cat = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == u.id).first()
    bank2 = _exp(db, u, cat, 1250, bank=True, desc="HORKRAM A/S #2")
    _link(db, u, bank, receipt)
    rows = {r.txn_id: r for r in recon.match_transactions(db, u.id)}
    linked = rows[str(bank.id)]
    assert linked.already_matched is True
    assert linked.linked_target_id == str(receipt.id)
    assert "Hørkram (bon)" in (linked.linked_target_label or "")
    # The receipt is paid by `bank` now: never offered to another bank line.
    assert all(s.target_id != str(receipt.id) for s in rows[str(bank2.id)].suggestions)


def test_unlink_over_http_like_the_page_sends_it(client, factory):
    s = factory()
    u, receipt, bank = _pair(s)
    _link(s, u, bank, receipt)
    uid, bid, rid = u.id, bank.id, receipt.id
    s.close()
    r = client.post("/api/bank-import/latest/confirm-matches",
                    headers={"Authorization": f"Bearer {create_access_token(str(uid))}"},
                    json={"matches": [{"txn_id": str(bid), "target_type": "expense",
                                       "target_id": str(rid), "action": "unlink"}]})
    assert r.status_code == 200, r.text
    assert r.json()["confirmed"] == 1
    s = factory()
    assert s.get(Expense, bid).linked_expense_id is None
    s.close()


def test_a_linked_line_is_not_counted_as_no_match(client, factory):
    s = factory()
    u, receipt, bank = _pair(s)
    _link(s, u, bank, receipt)
    uid = u.id
    s.close()
    r = client.get("/api/bank-import/latest/suggestions",
                   headers={"Authorization": f"Bearer {create_access_token(str(uid))}"})
    assert r.status_code == 200, r.text
    body = r.json()
    linked = [t for t in body["transactions"] if t["linked_target_id"]]
    assert len(linked) == 1 and linked[0]["already_matched"] is True
    assert linked[0]["linked_target_label"] == "Hørkram (bon)"
    assert body["counts"]["none"] == 0


def test_the_revisor_export_ties_out_with_the_filing(db):
    from app.services.bookkeeping_export import _query_expenses

    u, receipt, bank = _pair(db)
    _link(db, u, bank, receipt)
    ids = {e.id for e in _query_expenses(u, db, DAY.replace(day=1), DAY)}
    assert ids == {receipt.id}
    assert sum(float(e.amount) for e in _query_expenses(u, db, DAY.replace(day=1), DAY)) \
        == _filing(db, u)[0]


def test_schema_change_is_additive_on_both_branches():
    from app import main

    stmts = [s for s in main._migrations if isinstance(s, str) and "linked_expense_id" in s]
    assert stmts == ["ALTER TABLE expenses ADD COLUMN IF NOT EXISTS linked_expense_id VARCHAR(36)"]
    col = Expense.__table__.c.linked_expense_id
    assert col.nullable is True and col.default is None and col.server_default is None
    import inspect
    assert '_add("expenses", "linked_expense_id", "VARCHAR(36)")' in inspect.getsource(main._run_migrations)


# ── Readers that summed expenses without the shared gate (Push 8 finish) ──
# The AI agent's expense answer, the owner context the copilot reads and the
# weekly category-spike alert summed Expense.amount on their own, so a linked
# purchase still read twice there (and an unapproved draft counted). They now
# go through not_pending() like every other money read.


def test_the_agents_expense_answer_counts_a_linked_purchase_once(db):
    from app.services.agent_tools import query_expenses

    u, receipt, bank = _pair(db)
    before = query_expenses(db, u.id, from_date=DAY, to_date=DAY, period="custom")["data"]
    assert before["total_expenses"] == 2500.0          # both rows, before the link
    _link(db, u, bank, receipt)
    after = query_expenses(db, u.id, from_date=DAY, to_date=DAY, period="custom")["data"]
    assert after["total_expenses"] == 1250.0
    assert after["expense_count"] == 1
    assert [c["total"] for c in after["by_category"]] == [1250.0]


def test_the_owner_context_counts_a_linked_purchase_once(db):
    from app.services.owner_memory import build_owner_context

    u, receipt, bank = _pair(db)
    _link(db, u, bank, receipt)
    ctx = build_owner_context(u, db)
    assert "Last 30d expenses: 1,250 DKK" in ctx, ctx


def test_a_linked_purchase_is_not_a_category_spike(db):
    from app.services.alert_service import detect_expense_alerts

    u = _owner(db)
    cat = _cat(db, u)
    today = date.today()
    # Four earlier weeks at 1.000 a week (inside each [w_start, w_end) window).
    for w in range(1, 5):
        _exp(db, u, cat, 1000, d=today - timedelta(days=7 * (w + 1)), desc="Hørkram uge")
    # This week: the receipt and the bank line that paid it.
    receipt = _exp(db, u, cat, 1100, d=today - timedelta(days=1), desc="Hørkram (bon)")
    bank = _exp(db, u, cat, 1100, bank=True, d=today - timedelta(days=1), desc="HORKRAM A/S")
    spikes = [a for a in detect_expense_alerts(u, db) if a["type"] == "category_spike"]
    assert spikes and spikes[0]["this_week"] == 2200.0  # the double count read as +120 %
    _link(db, u, bank, receipt)
    spikes = [a for a in detect_expense_alerts(u, db) if a["type"] == "category_spike"]
    assert spikes == []                                  # 1.100 vs 1.000: +10 %, no alert
