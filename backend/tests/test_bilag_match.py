"""Photo-later matching — "Knyt til eksisterende udgift".

The owner typed an expense by hand; the receipt arrives later (Scan bunke,
single scan, e-mail inbox). BonBox must OFFER the typed row instead of booking
the receipt as a second expense (the same købsmoms twice), never merge on its
own, and attaching may add the bilag and fill EMPTY fields only — never the
amount, and no VAT field on a locked period.

Run:
  cd backend && python3 -m pytest tests/test_bilag_match.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.services.receipt_ocr as receipt_ocr
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.routers.expenses import _limiter as _exp_limiter
from app.services import bilag_match
from app.services.auth import get_current_user
from app.services.tax_filing_pdf import compute_filing_data

_db_ready.set()
_exp_limiter.enabled = False

D = date(2026, 10, 3)


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(receipt_ocr, "save_receipt_photo_ex",
                        lambda raw, fn, uid, kind="expense": (
                            f"uploads/receipts/{uid}_{uuid.uuid4().hex[:6]}.jpg",
                            "/tmp/none.jpg",
                        ))
    monkeypatch.setattr(receipt_ocr, "save_receipt_photo",
                        lambda raw, fn, uid, kind="expense": f"uploads/receipts/{uid}_att.jpg")
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, plan="starter") -> User:
    u = User(email=f"m-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Café Match", business_type="cafe", currency="DKK", plan=plan)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, u, name="Råvarer"):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _typed(db, u, cat, amount=129.95, d=D, **kw) -> Expense:
    e = Expense(user_id=u.id, category_id=cat.id, date=d, amount=amount,
                description=kw.pop("description", "Netto"), payment_method="card",
                vendor_key=kw.pop("vendor_key", "netto"), **kw)
    db.add(e); db.commit(); db.refresh(e)
    return e


def _draft(db, u, cat, amount=129.95, d=D, photo=None, **kw) -> Expense:
    e = Expense(user_id=u.id, category_id=cat.id, date=d, amount=amount,
                description=kw.pop("description", "NETTO"), payment_method="card",
                status="pending", receipt_source="scan",
                receipt_photo=photo or f"uploads/receipts/{u.id}_draft.jpg",
                vendor_key=kw.pop("vendor_key", "netto"), **kw)
    db.add(e); db.commit(); db.refresh(e)
    return e


# ── The rule itself ───────────────────────────────────────────────────

def test_candidates_window_amount_and_bilag_rules(db):
    u = _owner(db); other = _owner(db); cat = _cat(db, u); ocat = _cat(db, other)
    hit = _typed(db, u, cat, 129.95, D)
    _typed(db, u, cat, 129.95, D, receipt_photo="uploads/receipts/x.jpg")      # has a bilag
    _typed(db, u, cat, 129.95, D, is_personal=True)                           # personal
    _typed(db, u, cat, 129.95, D, is_deleted=True)                            # deleted
    _typed(db, u, cat, 129.95, D, status="pending")                           # a draft is not "typed"
    _typed(db, other, ocat, 129.95, D)                                        # another owner

    def ids(**kw):
        return [c.expense.id for c in bilag_match.find_candidates(db, u.id, **kw)]

    assert ids(amount=129.50, on_date=date(2026, 10, 5)) == [hit.id]       # -0,45 kr / +2 d
    assert ids(amount=130.45, on_date=date(2026, 9, 30)) == [hit.id]       # +0,50 kr / -3 d
    assert ids(amount=129.40, on_date=D) == []                              # 0,55 off
    assert ids(amount=129.95, on_date=date(2026, 10, 7)) == []             # 4 days
    assert ids(amount=0, on_date=D) == []                                   # a 0 kr. draft matches nothing
    assert ids(amount=129.95, on_date=None) == []


def test_same_supplier_first_then_nearest_date(db):
    u = _owner(db); cat = _cat(db, u)
    far_same = _typed(db, u, cat, 50, date(2026, 10, 1), description="Netto", vendor_key="netto")
    near_other = _typed(db, u, cat, 50, D, description="Rema", vendor_key="rema 1000")
    out = bilag_match.find_candidates(db, u.id, amount=50, on_date=D, vendor_key="netto")
    assert [c.expense.id for c in out] == [far_same.id, near_other.id]
    out = bilag_match.find_candidates(db, u.id, amount=50, on_date=D)
    assert [c.expense.id for c in out] == [near_other.id, far_same.id]


def test_branch_known_on_receipt_side_excludes_other_branch(db):
    from app.models.branch import Branch
    u = _owner(db); cat = _cat(db, u)
    b1 = Branch(user_id=u.id, name="A"); b2 = Branch(user_id=u.id, name="B")
    db.add_all([b1, b2]); db.commit()
    in_b2 = _typed(db, u, cat, 80, D, branch_id=b2.id)
    no_branch = _typed(db, u, cat, 80, D)
    got = {c.expense.id for c in bilag_match.find_candidates(db, u.id, amount=80, on_date=D, branch_id=b1.id)}
    assert got == {no_branch.id}
    got = {c.expense.id for c in bilag_match.find_candidates(db, u.id, amount=80, on_date=D)}
    assert got == {no_branch.id, in_b2.id}


# ── Scan bunke → queue → link: no duplicate ───────────────────────────

def test_pile_draft_is_offered_the_typed_row_and_never_booked_twice(client, db, monkeypatch):
    u = _owner(db); cat = _cat(db, u)
    typed = _typed(db, u, cat, 129.95, D)
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "NETTO", "amount": 129.95, "date": "2026-10-04",
                                      "payment_method": "card"})
    _as(u)
    r = client.post("/api/expenses/burst-scan",
                    files=[("files", ("a.jpg", b"\xff\xd8\xff\xe0x", "image/jpeg"))])
    assert r.status_code == 200, r.text
    draft_id = r.json()["drafts"][0]["id"]

    m = client.get("/api/expenses/pending/bilag-matches").json()["matches"]
    assert [c["id"] for c in m[draft_id]] == [str(typed.id)]
    assert m[draft_id][0]["same_vendor"] is True and m[draft_id][0]["day_diff"] == 1

    # Give the draft a category so it is otherwise "klar" — the sweep must
    # STILL leave it, because it may be the typed row's bilag.
    db.query(Expense).filter(Expense.id == uuid.UUID(draft_id)).update({"category_id": cat.id})
    db.commit()
    before_kob = compute_filing_data(db, u, date(2026, 10, 1), date(2026, 10, 31))["moms_af_kob"]
    r = client.post("/api/expenses/approve-batch", json={"ids": [draft_id]})
    assert r.json()["approved"] == []
    assert r.json()["skipped_by_reason"] == {"mulig dublet": [draft_id]}

    r = client.post(f"/api/expenses/{typed.id}/link-bilag", json={"draft_id": draft_id})
    assert r.status_code == 200, r.text
    db.expire_all()
    rows = db.query(Expense).filter(Expense.user_id == u.id, Expense.is_deleted.isnot(True)).all()
    assert len(rows) == 1                                   # the draft is gone, no second expense
    row = rows[0]
    assert row.id == typed.id and float(row.amount) == 129.95
    assert row.receipt_photo and row.receipt_source == "scan"
    after = compute_filing_data(db, u, date(2026, 10, 1), date(2026, 10, 31))
    assert after["moms_af_kob"] == before_kob               # købsmoms counted once
    audit = db.query(AuditLog).filter(AuditLog.action == "expense.bilag_linked").one()
    a = json.loads(audit.after_state)
    assert a["draft_id"] == draft_id and a["expense_id"] == str(typed.id)


def test_single_approve_stays_the_owners_explicit_new_expense(client, db):
    u = _owner(db); cat = _cat(db, u)
    _typed(db, u, cat, 40, D)
    d = _draft(db, u, cat, 40, D)
    _as(u)
    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved"


# ── Locked period: the bilag goes on, no VAT field moves ─────────────

def test_link_on_a_locked_day_adds_bilag_only(client, db):
    u = _owner(db); cat = _cat(db, u)
    typed = _typed(db, u, cat, 250, D)
    db.add(DailyClose(user_id=u.id, date=D, revenue_total=5000, moms_total=1000, status="confirmed"))
    db.commit()
    d = _draft(db, u, cat, 250, D, vat_amount=50, vat_rate=0.25)
    _as(u)
    r = client.post(f"/api/expenses/{typed.id}/link-bilag", json={"draft_id": str(d.id)})
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.get(Expense, typed.id)
    assert row.receipt_photo
    assert float(row.amount) == 250
    assert row.vat_amount is None and row.vat_source is None   # locked: VAT untouched
    a = json.loads(db.query(AuditLog).filter(AuditLog.action == "expense.bilag_linked").one().after_state)
    assert a["locked_period"] == "close_locked" and a["filled"] == []


def test_link_on_an_open_day_fills_empty_vat_never_the_amount(client, db):
    u = _owner(db); cat = _cat(db, u)
    typed = _typed(db, u, cat, 250, D, vendor_key=None)
    d = _draft(db, u, cat, 249.60, D, vat_amount=49.92, vat_rate=0.25, vendor_key="netto")
    _as(u)
    r = client.post(f"/api/expenses/{typed.id}/link-bilag", json={"draft_id": str(d.id)})
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.get(Expense, typed.id)
    assert float(row.amount) == 250                         # the owner's figure stands
    assert float(row.vat_amount) == 49.92 and row.vat_source == "receipt"
    assert row.vendor_key == "netto"


def test_a_period_sent_to_the_revisor_counts_as_locked(db):
    u = _owner(db)
    from app.services.audit_service import record
    record(db, u, "tax.filing_sent_to_accountant", "tax_filing",
           after={"period_start": "2026-10-01", "period_end": "2026-10-31"})
    db.commit()
    assert bilag_match.locked_reason(db, u.id, D) == "moms_sent"
    assert bilag_match.locked_reason(db, u.id, date(2026, 11, 2)) is None


# ── Guards ───────────────────────────────────────────────────────────

def test_link_refuses_overwrite_draft_target_and_foreign_paths(client, db):
    u = _owner(db); other = _owner(db); cat = _cat(db, u)
    has = _typed(db, u, cat, 10, D, receipt_photo=f"uploads/receipts/{u.id}_old.jpg")
    d = _draft(db, u, cat, 10, D)
    _as(u)
    r = client.post(f"/api/expenses/{has.id}/link-bilag", json={"draft_id": str(d.id)})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_has_bilag"
    r = client.post(f"/api/expenses/{d.id}/link-bilag",
                    json={"receipt_photo": f"uploads/receipts/{u.id}_x.jpg"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "target_is_draft"
    plain = _typed(db, u, cat, 10, D)
    r = client.post(f"/api/expenses/{plain.id}/link-bilag",
                    json={"receipt_photo": f"uploads/receipts/{other.id}_theirs.jpg"})
    assert r.status_code == 422
    r = client.post(f"/api/expenses/{plain.id}/link-bilag",
                    json={"receipt_photo": "https://evil.example/x.jpg"})
    assert r.status_code == 422
    r = client.post(f"/api/expenses/{plain.id}/link-bilag", json={})
    assert r.status_code == 422
    # Another owner's draft cannot be pulled onto my expense.
    ocat = _cat(db, other)
    their = _draft(db, other, ocat, 10, D)
    r = client.post(f"/api/expenses/{plain.id}/link-bilag", json={"draft_id": str(their.id)})
    assert r.status_code == 404
    db.expire_all()
    assert db.get(Expense, their.id) is not None


def test_link_from_single_scan_upload_path(client, db):
    u = _owner(db); cat = _cat(db, u)
    typed = _typed(db, u, cat, 99, D, vendor_key=None)
    _as(u)
    m = client.get("/api/expenses/bilag-matches",
                   params={"amount": 99.2, "date": "2026-10-04", "vendor": "Netto"}).json()
    assert m["count"] == 1 and m["candidates"][0]["category_name"] == "Råvarer"
    path = f"https://proj.supabase.co/storage/v1/object/sign/receipts/{u.id}/expense/{'a' * 64}.jpg?token=t"
    r = client.post(f"/api/expenses/{typed.id}/link-bilag",
                    json={"receipt_photo": path, "vendor": "Netto", "vat_amount": 19.8, "vat_rate": 0.25})
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.get(Expense, typed.id)
    assert row.receipt_photo == path and row.receipt_source == "scan"
    assert float(row.amount) == 99 and float(row.vat_amount) == 19.8


def test_smart_scan_attach_link_mode(client, db):
    u = _owner(db); cat = _cat(db, u)
    typed = _typed(db, u, cat, 75, D)
    _as(u)
    img = ("bilag.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")
    r = client.post(f"/api/expenses/{typed.id}/attach-receipt", files={"file": img},
                    data={"link": "true", "vat_amount": "15", "vat_rate": "0.25"})
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.get(Expense, typed.id)
    assert row.receipt_photo and float(row.vat_amount) == 15 and float(row.amount) == 75
    # A second link onto the same row never overwrites the evidence.
    r = client.post(f"/api/expenses/{typed.id}/attach-receipt", files={"file": img},
                    data={"link": "true"})
    assert r.status_code == 409


# ── E-mail inbox: a draft, not a booked expense ──────────────────────

def test_inbox_receipt_lands_as_a_draft_out_of_moms(db):
    from app.models.email_message import EmailMessage
    from app.routers import inbox as inbox_router
    u = _owner(db); cat = _cat(db, u)
    _typed(db, u, cat, 432.50, date(2026, 5, 20))
    em = EmailMessage(id=uuid.uuid4(), user_id=u.id, alias="x", from_addr="s@x.dk",
                      subject="Faktura", received_at=datetime(2026, 5, 21, 9, 0), status="queued")
    db.add(em); db.commit()

    import app.services.smart_scan_service as sss
    orig = sss.route_and_extract
    sss.route_and_extract = lambda *a, **k: {
        "confidence": 0.95,
        "extracted_data": {"vendor": "Hørkram", "amount": 432.50, "date": "2026-05-20"},
    }
    orig_persist = inbox_router.persist_attachment_blob
    inbox_router.persist_attachment_blob = lambda plain, sha: f"uploads/receipts/{sha}.enc"
    try:
        import base64
        out = inbox_router._ingest_attachment(db, u, em, {
            "Name": "r.pdf", "ContentType": "application/pdf",
            "Content": base64.b64encode(b"%PDF-1.4 test").decode(),
        })
    finally:
        sss.route_and_extract = orig
        inbox_router.persist_attachment_blob = orig_persist
    db.commit()
    assert out == "drafted"
    drafted = db.query(Expense).filter(Expense.reference_id.like("inbox_%")).one()
    assert drafted.status == "pending"
    assert drafted.payment_method is None                  # the paper did not say
    kob = compute_filing_data(db, u, date(2026, 5, 1), date(2026, 5, 31))
    # Only the typed expense is in MOMS; the forwarded copy waits in the queue.
    assert kob["kob_med_moms"] == 432.50
