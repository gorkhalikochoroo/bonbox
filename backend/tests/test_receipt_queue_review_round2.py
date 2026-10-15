"""Receipt queue hardening — 12 Oct accountant review, second round.

minor 5  "Godkend alle" never books a foreign receipt that matches an expense
         the owner typed in kroner (its kroner amount is compared once a rate
         gives it one).
minor 6  The revisor package reads an inbox blob only when the mail intake
         recorded it for THIS owner — the file name carries no owner.
M6       Approving a "[needs review]" receipt removes the marker, and the
         boot-time backfill keyed on that marker is one-shot (the Postgres
         two-boot proof is test_needs_review_backfill_pg.py).
"""
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import importlib as _il
import pkgutil as _pu
import app.models as _models
for _m in _pu.iter_modules(_models.__path__):
    _il.import_module(f"app.models.{_m.name}")

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db):
    def _get():
        yield db
    app.dependency_overrides[get_db] = _get
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x", business_name="Café",
             business_type="cafe", currency="DKK", plan="starter", email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, u, name="Software"):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


# ── minor 5 ──────────────────────────────────────────────────────────

def test_a_foreign_receipt_matching_a_typed_expense_is_offered_not_swept(client, db):
    u = _owner(db); cat = _cat(db, u)
    typed = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 5), amount=112.50,
                    description="Adobe", payment_method="card")
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 5), amount=112.50,
                    description="Adobe Inc.", payment_method="card", status="pending",
                    receipt_photo=f"{u.id}/expense/{'ab' * 32}.jpg", currency="USD",
                    original_amount=16.25, fx_rate=6.923077)
    db.add_all([typed, draft]); db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    m = client.get("/api/expenses/pending/bilag-matches").json()
    assert [c["id"] for c in m["matches"][str(draft.id)]] == [str(typed.id)]
    r = client.post("/api/expenses/approve-batch", json={"ids": [str(draft.id)]}).json()
    assert r["count"] == 0 and r["skipped_by_reason"] == {"mulig dublet": [str(draft.id)]}


def test_a_foreign_receipt_without_a_rate_matches_nothing_yet(db):
    from app.routers.expenses import _draft_bilag_candidates
    u = _owner(db); cat = _cat(db, u)
    db.add(Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 5), amount=112.50,
                   description="Adobe", payment_method="card"))
    draft = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 10, 5), amount=112.50,
                    description="Adobe Inc.", payment_method="card", status="pending",
                    receipt_photo=f"{u.id}/expense/{'ab' * 32}.jpg", currency="USD",
                    original_amount=None, fx_rate=None)
    db.add(draft); db.commit()
    assert _draft_bilag_candidates(db, u, draft) == []


# ── minor 6 ──────────────────────────────────────────────────────────

def test_an_inbox_blob_is_read_only_for_the_owner_the_intake_recorded(db, monkeypatch):
    from app.models.email_message import EmailMessage
    from app.models.receipt_intake import ReceiptIntake
    from app.services import revisor_package as rp
    reads = []
    monkeypatch.setattr("app.services.inbox_service.load_attachment_blob",
                        lambda path: reads.append(path) or b"%PDF-1.4 kvittering")
    owner, other = _owner(db), _owner(db)
    path = "uploads/receipts/" + "c" * 64 + ".enc"
    em = EmailMessage(id=uuid.uuid4(), user_id=other.id, alias="x", from_addr="s@x.dk",
                      subject="Faktura", status="processed")
    db.add(em); db.commit()
    db.add(ReceiptIntake(email_message_id=em.id, user_id=other.id, storage_path=path,
                         sha256="c" * 64))
    db.commit()
    # The owner typed someone else's blob path into an expense: refused, unread.
    assert rp.load_bilag(owner.id, path, db=db) is None
    assert reads == []
    # Without a session nothing can vouch for it: refused.
    assert rp.load_bilag(other.id, path) is None
    # The owner the intake recorded reads it.
    assert rp.load_bilag(other.id, path, db=db) == (b"%PDF-1.4 kvittering", "pdf")
    assert reads == [path]


# ── M6 ───────────────────────────────────────────────────────────────

def test_approving_removes_the_needs_review_marker(client, db):
    u = _owner(db); cat = _cat(db, u, "Varekøb")
    e = Expense(user_id=u.id, category_id=cat.id, date=date(2026, 9, 25), amount=480,
                description="From Faktura 123 [needs review]", payment_method="card",
                status="pending", receipt_photo="uploads/receipts/" + "b" * 64 + ".enc",
                receipt_source="scan")
    db.add(e); db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post(f"/api/expenses/{e.id}/approve")
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.get(Expense, e.id)
    assert row.status == "approved" and row.voucher_number is not None
    assert row.description == "From Faktura 123"


def test_the_needs_review_backfill_is_one_shot_and_spares_approved_rows():
    """Static guard on the migration list (the statement itself is
    Postgres-only; the two-boot run is test_needs_review_backfill_pg.py)."""
    import app.main as m
    stmts = [" ".join(s.split()) for s in m._migrations]
    assert not any(s.startswith("UPDATE expenses SET status = 'pending'") for s in stmts)
    (bf,) = [s for s in stmts if "expenses_needs_review_to_pending_v1" in s]
    assert "ON CONFLICT (name) DO NOTHING" in bf and "EXISTS (SELECT 1 FROM first_run)" in bf
    assert "voucher_number IS NULL" in bf
    i_table = next(i for i, s in enumerate(stmts) if s.startswith("CREATE TABLE IF NOT EXISTS data_backfills"))
    assert i_table < stmts.index(bf)
