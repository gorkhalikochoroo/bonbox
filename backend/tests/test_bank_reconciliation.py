"""
Bank reconciliation auto-match — end-to-end tests for task #43.

Coverage:
  1. Free user → 402 plan_required on /suggestions
  2. Starter user gets matched suggestions for an obvious invoice match
  3. Confirm endpoint marks invoice paid + writes audit_logs row
  4. Tenant isolation — user A cannot match user B's invoices

Plus targeted service-layer tests for the matching ranker and the
hand-rolled Jaro-Winkler implementation (no rapidfuzz in requirements).

Run: cd backend && pytest tests/test_bank_reconciliation.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.expense import Expense, ExpenseCategory
from app.models.invoice import Invoice
from app.models.sale import Sale
from app.models.user import User
from app.services import bank_reconciliation as br
from app.services.auth import get_current_user
from app.services.invoice_service import InvoiceService

_db_ready.set()


# ─── Shared in-memory DB ───────────────────────────────────────────────
#
# We share a single sqlite-in-memory engine across the app dependency
# override + the test fixtures so the TestClient and the test code see
# the same rows. StaticPool is critical — without it, each connection
# gets its own fresh in-memory DB.

@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    """TestClient with the DB override wired to our shared in-memory
    engine. Caller installs a get_current_user override per test for
    the user they want to act as."""
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers: build a user + customer + invoice + bank sale ────────────

def _user(db, plan: str = "starter", email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.test",
        password_hash="x",
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _customer(db, user: User, name: str = "Lyngby Storkunde ApS", cvr: str | None = None) -> Customer:
    c = Customer(
        user_id=user.id,
        name=name,
        is_company=bool(cvr),
        cvr=cvr,
        email="finance@lyngby.test",
        country="DK",
        payment_terms_days=14,
        default_lang="da",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _send_invoice(db, user: User, customer: Customer, total: Decimal) -> Invoice:
    net = (total / Decimal("1.25")).quantize(Decimal("0.01"))
    inv = InvoiceService.create_draft(
        db, user, customer.id,
        lines=[{
            "description": "Konsulentydelse",
            "quantity": Decimal("1"),
            "unit_price_net": net,
            "moms_rate": Decimal("0.250"),
        }],
    )
    InvoiceService.mark_sent(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    return inv


def _bank_sale(
    db, user: User, amount: Decimal, notes: str,
    txn_date: date | None = None, bank: str = "danske_bank",
) -> Sale:
    """A Sale row that looks like it was imported from a bank CSV —
    `reference_id` starts with 'bank_<bank>_' to match our prefix."""
    s = Sale(
        user_id=user.id,
        date=txn_date or date.today(),
        amount=amount,
        payment_method="bank_transfer",
        notes=notes,
        order_channel="dine_in",
        reference_id=f"bank_{bank}_{uuid.uuid4().hex[:10]}",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


# ─── Test 1: Free user gets 402 plan_required ──────────────────────────


def test_free_user_blocked_from_suggestions(client, db):
    user = _user(db, plan="free")
    _override_user(user)

    res = client.get("/api/bank-import/latest/suggestions")
    assert res.status_code == 402, res.text
    body = res.json()
    assert body["detail"]["error"] == "feature_locked"
    assert body["detail"]["feature"] == "bank_auto_reconcile"
    assert body["detail"]["upgrade_to"] == "starter"


def test_free_user_blocked_from_confirm(client, db):
    user = _user(db, plan="free")
    _override_user(user)

    res = client.post(
        "/api/bank-import/latest/confirm-matches",
        json={
            "matches": [{
                "txn_id": str(uuid.uuid4()),
                "target_type": "invoice",
                "target_id": str(uuid.uuid4()),
                "action": "mark_paid",
            }],
        },
    )
    assert res.status_code == 402, res.text
    assert res.json()["detail"]["feature"] == "bank_auto_reconcile"


# ─── Test 2: Starter user sees matched suggestions ─────────────────────


def test_starter_user_gets_obvious_match(client, db):
    """Bank CSV imported a 1250 DKK incoming line on the same day as a
    1250 DKK open faktura, with the customer's name in the description.
    Reconciliation should return at least one HIGH-confidence
    suggestion."""
    user = _user(db, plan="starter")
    _override_user(user)

    cust = _customer(db, user, name="Lyngby Storkunde ApS")
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE APS REF 12345",
        txn_date=inv.issue_date,
    )

    res = client.get("/api/bank-import/latest/suggestions")
    assert res.status_code == 200, res.text
    body = res.json()

    # We expect at least one transaction row + at least one suggestion
    assert any(
        t["txn_id"] == str(sale.id)
        and any(
            s["target_id"] == str(inv.id) and s["confidence"] == "high"
            for s in t["suggestions"]
        )
        for t in body["transactions"]
    ), f"Expected high-confidence match for {sale.id} → {inv.id}, got {body}"

    # Counts payload includes the high bucket
    assert body["counts"]["high"] >= 1


def test_starter_filters_outside_amount_tolerance(client, db):
    """A 1250 invoice and a 1500 bank sale (250 DKK off) should NOT
    surface as a match — outside the ±2 DKK tolerance."""
    user = _user(db, plan="starter")
    _override_user(user)

    cust = _customer(db, user)
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1500.00"),
        notes="OVF FRA LYNGBY STORKUNDE",
        txn_date=inv.issue_date,
    )

    res = client.get("/api/bank-import/latest/suggestions")
    assert res.status_code == 200
    body = res.json()
    # Find this txn and confirm no candidate invoice matched
    matched = [
        t for t in body["transactions"]
        if t["txn_id"] == str(sale.id)
    ]
    assert len(matched) == 1
    target_ids = [s["target_id"] for s in matched[0]["suggestions"]]
    assert str(inv.id) not in target_ids


def test_starter_filters_outside_date_window(client, db):
    """Invoice issued 30 days before the bank sale falls outside the
    ±7 day window and shouldn't surface."""
    user = _user(db, plan="starter")
    _override_user(user)

    cust = _customer(db, user)
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    # Push the sale 30 days into the future from the issue date
    sale = _bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE",
        txn_date=inv.issue_date + timedelta(days=30),
    )

    res = client.get("/api/bank-import/latest/suggestions")
    body = res.json()
    matched = [t for t in body["transactions"] if t["txn_id"] == str(sale.id)]
    assert len(matched) == 1
    assert str(inv.id) not in [s["target_id"] for s in matched[0]["suggestions"]]


# ─── Test 3: Confirm endpoint marks invoice paid + writes audit ────────


def test_confirm_marks_invoice_paid_and_audits(client, db):
    user = _user(db, plan="starter")
    _override_user(user)

    cust = _customer(db, user)
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE",
        txn_date=inv.issue_date,
    )

    res = client.post(
        "/api/bank-import/latest/confirm-matches",
        json={
            "matches": [{
                "txn_id": str(sale.id),
                "target_type": "invoice",
                "target_id": str(inv.id),
                "action": "mark_paid",
            }],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["confirmed"] == 1
    assert body["skipped"] == 0
    assert body["errors"] == []

    # Invoice flipped to paid
    db.expire_all()
    db.refresh(inv)
    db.refresh(sale)
    assert inv.status == "paid"
    assert inv.paid_via == "bank_csv"
    assert sale.invoice_id == inv.id

    # bank_reconcile.match_confirmed audit row exists
    audits = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "bank_reconcile.match_confirmed",
            AuditLog.entity_id == inv.id,
        )
        .all()
    )
    assert len(audits) == 1, "Expected one bank_reconcile audit row"
    after = json.loads(audits[0].after_state)
    assert after["action"] == "mark_paid"
    assert after["source"] == "bank_csv"
    assert after["sale_id"] == str(sale.id)


def test_confirm_idempotent_skips_already_matched(client, db):
    """Re-submitting the same match must be a no-op (skipped, not
    confirmed twice). Critical for the bulk-confirm UX where the owner
    might double-click."""
    user = _user(db, plan="starter")
    _override_user(user)

    cust = _customer(db, user)
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1250.00"), notes="OVF LYNGBY",
        txn_date=inv.issue_date,
    )

    payload = {"matches": [{
        "txn_id": str(sale.id),
        "target_type": "invoice",
        "target_id": str(inv.id),
        "action": "mark_paid",
    }]}

    first = client.post("/api/bank-import/latest/confirm-matches", json=payload)
    assert first.status_code == 200
    assert first.json()["confirmed"] == 1

    second = client.post("/api/bank-import/latest/confirm-matches", json=payload)
    assert second.status_code == 200
    body = second.json()
    # Second attempt: invoice already paid → idempotent skip
    assert body["confirmed"] == 0
    assert body["skipped"] == 1


# ─── Test 4: Tenant isolation ──────────────────────────────────────────


def test_user_a_cannot_match_user_b_invoice(client, db):
    """User A submits a confirm with a Sale they own but an Invoice owned
    by User B. The Invoice fetch must fail with the user.id filter and
    the confirm result must report an error (NOT 500, NOT mutation)."""
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")

    # User B has an open invoice
    cust_b = _customer(db, user_b, name="Other Tenant")
    inv_b = _send_invoice(db, user_b, cust_b, Decimal("999.00"))

    # User A has a bank sale of the same amount
    sale_a = _bank_sale(
        db, user_a, Decimal("999.00"), notes="OVF",
        txn_date=inv_b.issue_date,
    )

    # Act as user A and try to mark user B's invoice paid
    _override_user(user_a)
    res = client.post(
        "/api/bank-import/latest/confirm-matches",
        json={"matches": [{
            "txn_id": str(sale_a.id),
            "target_type": "invoice",
            "target_id": str(inv_b.id),
            "action": "mark_paid",
        }]},
    )
    assert res.status_code == 200
    body = res.json()
    # Cross-tenant target_id resolves to None → error, not confirmation
    assert body["confirmed"] == 0
    assert any("not found" in e.lower() for e in body["errors"]), body

    # Invoice B must NOT be paid
    db.expire_all()
    db.refresh(inv_b)
    assert inv_b.status in ("sent", "overdue")
    assert inv_b.paid_via is None


def test_suggestions_scoped_to_caller(client, db):
    """User B's open invoices must NEVER appear in user A's suggestions
    list. The matcher itself enforces this via the user_id filter on
    every query."""
    user_a = _user(db, plan="starter", email_suffix="-a")
    user_b = _user(db, plan="starter", email_suffix="-b")

    cust_b = _customer(db, user_b, name="Other Tenant ApS")
    inv_b = _send_invoice(db, user_b, cust_b, Decimal("777.00"))

    # User A has a same-amount bank sale
    sale_a = _bank_sale(
        db, user_a, Decimal("777.00"), notes="OVF FRA OTHER TENANT",
        txn_date=inv_b.issue_date,
    )

    _override_user(user_a)
    res = client.get("/api/bank-import/latest/suggestions")
    assert res.status_code == 200
    body = res.json()
    for t in body["transactions"]:
        for s in t["suggestions"]:
            assert s["target_id"] != str(inv_b.id), (
                "Cross-tenant invoice leaked into suggestions"
            )


# ─── Service-level: Jaro-Winkler implementation ────────────────────────


def test_jaro_winkler_identical():
    assert br.jaro_winkler("Lyngby", "Lyngby") == 1.0


def test_jaro_winkler_empty():
    assert br.jaro_winkler("", "anything") == 0.0
    assert br.jaro_winkler("anything", "") == 0.0


def test_jaro_winkler_close_variants():
    # "Lyngby" vs "Lyngbi" — single char swap
    assert br.jaro_winkler("Lyngby", "Lyngbi") >= 0.85


def test_jaro_winkler_dissimilar():
    # Completely different strings should score low
    assert br.jaro_winkler("Lyngby", "Bavaria") < 0.5


def test_score_picks_high_when_text_signal_present(db):
    """Service-level: HIGH confidence iff (exact amount + same date +
    text signal)."""
    user = _user(db, plan="starter")
    cust = _customer(db, user, name="Lyngby Storkunde ApS")
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE APS",
        txn_date=inv.issue_date,
    )
    score = br._score_invoice_candidate(sale, inv, cust)
    assert score is not None
    confidence, _reason = score
    assert confidence == "high"


def test_score_drops_to_medium_without_text_signal(db):
    """Same amount + date but a description that mentions nothing
    identifiable about the customer → medium confidence."""
    user = _user(db, plan="starter")
    cust = _customer(db, user, name="Lyngby Storkunde ApS")
    inv = _send_invoice(db, user, cust, Decimal("1250.00"))
    sale = _bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF UDEN NAVN",
        txn_date=inv.issue_date,
    )
    score = br._score_invoice_candidate(sale, inv, cust)
    assert score is not None
    confidence, _reason = score
    assert confidence == "medium"


def test_top_n_suggestions_per_txn(db):
    """The matcher returns at most TOP_N_PER_TXN candidates per txn
    even when many invoices match the amount."""
    user = _user(db, plan="starter")
    cust = _customer(db, user)
    invs = [
        _send_invoice(db, user, cust, Decimal("500.00"))
        for _ in range(5)
    ]
    sale = _bank_sale(
        db, user, Decimal("500.00"),
        notes="OVF",
        txn_date=invs[0].issue_date,
    )
    rows = br.match_transactions(db, user.id, import_id="latest")
    matched = [r for r in rows if r.txn_id == str(sale.id)]
    assert len(matched) == 1
    assert len(matched[0].suggestions) <= br.TOP_N_PER_TXN


def test_invalid_import_id_returns_400(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    # Path-level whitelist rejects forbidden chars
    res = client.get("/api/bank-import/'%20OR%201=1--/suggestions")
    assert res.status_code in (400, 404)  # 404 if FastAPI rejects routing


def test_empty_match_list_rejected_by_schema(client, db):
    user = _user(db, plan="starter")
    _override_user(user)
    res = client.post(
        "/api/bank-import/latest/confirm-matches",
        json={"matches": []},
    )
    assert res.status_code == 422  # Pydantic min_length=1
