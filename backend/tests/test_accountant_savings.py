"""Accountant Hours Saved — service + router tests.

Pins the L4/L7/L10 honesty contract for the "we save you revisor hours"
tracker that ships under the accountant_hours_widget feature flag.

Why these tests matter (Manoj's mandate, verbatim):
    "those claims are big thats why we need to be very precise one breaks
    another gets back to work and give accuracy."

Multi-barrier layer mapping:
  L1 — Router auth + tier gate (Free returns zero payload via service)
  L2 — Router bounded range (max 1y, end >= start)
  L4 — Service NEVER raises; degrades to zero-source counts
  L7 — These tests prove the contract: zero state, mixed sources,
       period-boundary inclusion, env override propagation, free-tier
       short-circuit, reversed-range fallback.
  L10 — HONEST: every credited minute traces to a real DB row; this
       is what the boundary + sources tests guarantee.

Run:  cd backend && pytest tests/test_accountant_savings.py -v
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.invoice import Invoice
from app.models.user import User
from app.services.accountant_savings_service import (
    compute_hours_saved,
)
from app.services.auth import create_access_token, hash_password
from app.services.billing import PLAN_FEATURES
from app.utils.time import utc_now


_db_ready.set()


# ─── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def db_session(monkeypatch):
    """Per-test SQLite in-memory engine. Same pattern as
    test_close_auto_email.py — overrides the FastAPI get_db dep AND
    redirects the billing._record_gate_refusal short-lived sessions to
    the same in-memory engine so any SecurityEvent writes don't crash."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    monkeypatch.setattr(
        "app.services.billing.SessionLocal", SessionLocal, raising=False,
    )
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, *, plan="starter", currency="DKK", email=None):
    """Create a User with `plan`. Starter is the default since that's
    where the widget unlocks; tests parametrize to free/pro/trial as
    needed."""
    u = User(
        email=email or f"u_{uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Mirabelle Café",
        business_type="restaurant",
        currency=currency,
        plan=plan,
        email_verified=True,
        created_at=utc_now() - timedelta(days=30),
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_category(db, user):
    c = ExpenseCategory(user_id=user.id, name="General", color="#888888")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _make_customer(db, user):
    c = Customer(
        user_id=user.id,
        name="Test Kunde",
        is_company=True,
        country="DK",
        default_lang="da",
    )
    db.add(c); db.commit(); db.refresh(c)
    return c


def _make_expense(db, user, category, *, on_date, with_receipt=True):
    """Add an Expense row. with_receipt=True attaches a fake receipt_photo
    so the OCR counter picks it up; False mimics a manually-entered
    expense (which the honesty contract says we DON'T credit)."""
    e = Expense(
        user_id=user.id,
        category_id=category.id,
        date=on_date,
        amount=Decimal("100.00"),
        description="Test expense",
        receipt_photo="https://example.com/receipt.jpg" if with_receipt else None,
        is_deleted=False,
    )
    db.add(e); db.commit(); db.refresh(e)
    return e


def _make_close(db, user, *, on_date, status="confirmed"):
    dc = DailyClose(
        user_id=user.id,
        date=on_date,
        revenue_total=Decimal("0"),
        payment_total=Decimal("0"),
        status=status,
        is_deleted=False,
    )
    db.add(dc); db.commit(); db.refresh(dc)
    return dc


def _make_moms_export_audit(db, user, *, when: datetime):
    """Simulate the audit row written by reports.vat_export_pdf when
    the owner downloads a MOMS PDF."""
    a = AuditLog(
        user_id=user.id,
        actor_id=user.id,
        actor_type="user",
        action="reports.vat_export_pdf_generated",
        entity_type="vat_export",
        before_state=None,
        after_state="{}",
        created_at=when,
    )
    db.add(a); db.commit(); db.refresh(a)
    return a


def _make_invoice(db, user, customer, *, sent_at: datetime, fakturanummer: int):
    inv = Invoice(
        user_id=user.id,
        customer_id=customer.id,
        fakturanummer=fakturanummer,
        issue_date=sent_at.date(),
        due_date=sent_at.date() + timedelta(days=14),
        status="sent",
        sent_at=sent_at,
        subtotal_net=Decimal("100"),
        moms_total=Decimal("25"),
        total_gross=Decimal("125"),
        currency="DKK",
        customer_lang="da",
        locked=True,
    )
    db.add(inv); db.commit(); db.refresh(inv)
    return inv


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


# ═════════════════════════════════════════════════════════════════════
# PLAN_FEATURES drift — both new keys present on every tier.
# ═════════════════════════════════════════════════════════════════════


def test_plan_features_has_accountant_keys_on_every_tier():
    """Drift trap: every plan dict must contain BOTH new keys so a future
    refactor can't silently make Starter fall through to Free's False."""
    expected = {"accountant_hours_widget", "accountant_month_end_bundle"}
    for plan in ("free", "starter", "pro", "trial"):
        keys = set(PLAN_FEATURES[plan].keys())
        assert expected.issubset(keys), (
            f"Plan {plan!r} missing one of {expected}: got {keys & expected}"
        )


def test_accountant_hours_widget_tier_matrix():
    """Manoj's confirmed matrix:
        Free=False, Starter=True, Pro=True, Trial=True."""
    assert PLAN_FEATURES["free"]["accountant_hours_widget"] is False
    assert PLAN_FEATURES["starter"]["accountant_hours_widget"] is True
    assert PLAN_FEATURES["pro"]["accountant_hours_widget"] is True
    assert PLAN_FEATURES["trial"]["accountant_hours_widget"] is True


def test_accountant_month_end_bundle_paid_tiers():
    """2026-07-12 doctrine: positioned month-end bundle is ON for Starter +
    Pro + Trial; only Free is gated."""
    assert PLAN_FEATURES["free"]["accountant_month_end_bundle"] is False
    assert PLAN_FEATURES["starter"]["accountant_month_end_bundle"] is True
    assert PLAN_FEATURES["pro"]["accountant_month_end_bundle"] is True
    assert PLAN_FEATURES["trial"]["accountant_month_end_bundle"] is True


# ═════════════════════════════════════════════════════════════════════
# Service — zero state on a clean account
# ═════════════════════════════════════════════════════════════════════


def test_zero_state_returns_zero_hours_and_empty_breakdown(db_session):
    """No expenses, no closes, no MOMS exports, no invoices →
    hours_saved=0, breakdown=[]. The widget renders the empty-state
    upsell copy from this shape."""
    user = _make_user(db_session, plan="starter")
    today = date.today()
    start = today.replace(day=1)
    result = compute_hours_saved(db_session, user, start, today)
    assert result["hours_saved"] == 0.0
    assert result["money_saved_dkk"] == 0.0
    assert result["breakdown"] == []
    assert result["tier"] == "starter"
    assert result["currency"] == "DKK"


# ═════════════════════════════════════════════════════════════════════
# Service — Free tier ALWAYS zero, regardless of action count
# ═════════════════════════════════════════════════════════════════════


def test_free_tier_always_zero_even_with_real_actions(db_session):
    """Free user with real receipts + closes + invoices STILL sees
    hours_saved=0. The widget then renders the upsell, not "0 hours" — but
    the contract is enforced at the service level so a frontend bug can't
    leak time-saved numbers to a Free user via the API.

    THIS IS THE L10 HONESTY MOAT: Free can't be tricked into seeing
    a Starter-grade number, even by direct API call."""
    user = _make_user(db_session, plan="free")
    cat = _make_category(db_session, user)
    cust = _make_customer(db_session, user)

    today = date.today()
    start = today.replace(day=1)

    # Real actions across every source
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    _make_close(db_session, user, on_date=today, status="confirmed")
    _make_moms_export_audit(db_session, user, when=datetime.combine(today, datetime.min.time()) + timedelta(hours=10))
    _make_invoice(db_session, user, cust, sent_at=datetime.combine(today, datetime.min.time()) + timedelta(hours=12), fakturanummer=1)

    result = compute_hours_saved(db_session, user, start, today)
    assert result["hours_saved"] == 0.0
    assert result["money_saved_dkk"] == 0.0
    assert result["breakdown"] == []
    assert result["tier"] == "free"


# ═════════════════════════════════════════════════════════════════════
# Service — mixed sources sum correctly, breakdown items match counts
# ═════════════════════════════════════════════════════════════════════


def test_mixed_sources_sum_and_per_source_counts(db_session):
    """All four sources contribute. Verify:
      • Each source row has the correct items count
      • hours = items * rate_min_each / 60 (round DOWN)
      • Total hours_saved = sum of source hours
      • money_saved_dkk = hours_saved * 850 (default DK rate)
    """
    user = _make_user(db_session, plan="starter", currency="DKK")
    cat = _make_category(db_session, user)
    cust = _make_customer(db_session, user)

    today = date.today()
    start = today.replace(day=1)

    # 4 OCR receipts in window
    for _ in range(4):
        _make_expense(db_session, user, cat, on_date=today, with_receipt=True)

    # 2 confirmed daily-closes in window
    _make_close(db_session, user, on_date=today, status="confirmed")
    _make_close(db_session, user, on_date=today - timedelta(days=1), status="confirmed")

    # 1 MOMS export
    _make_moms_export_audit(
        db_session, user,
        when=datetime.combine(today, datetime.min.time()) + timedelta(hours=9),
    )

    # 3 sent invoices
    for n in range(1, 4):
        _make_invoice(
            db_session, user, cust,
            sent_at=datetime.combine(today, datetime.min.time()) + timedelta(hours=n),
            fakturanummer=n,
        )

    result = compute_hours_saved(db_session, user, start, today)

    by_source = {row["source"]: row for row in result["breakdown"]}
    assert set(by_source.keys()) == {
        "receipt_ocr", "daily_close_autopilot", "moms_export", "faktura_pdf",
    }

    # Per-source counts
    assert by_source["receipt_ocr"]["items"] == 4
    assert by_source["daily_close_autopilot"]["items"] == 2
    assert by_source["moms_export"]["items"] == 1
    assert by_source["faktura_pdf"]["items"] == 3

    # Hours match the defaults: 1.5, 12, 45, 4 min each
    # 4 receipts * 1.5min = 6 min = 0.1 h
    # 2 closes  * 12min  = 24 min = 0.4 h
    # 1 moms    * 45min  = 45 min = 0.75 h
    # 3 fakt    * 4min   = 12 min = 0.2 h
    # Total = 1.45 h
    assert by_source["receipt_ocr"]["hours"] == pytest.approx(0.1)
    assert by_source["daily_close_autopilot"]["hours"] == pytest.approx(0.4)
    assert by_source["moms_export"]["hours"] == pytest.approx(0.75)
    assert by_source["faktura_pdf"]["hours"] == pytest.approx(0.2)

    assert result["hours_saved"] == pytest.approx(1.45)

    # 1.45 * 850 = 1232.5 → round DOWN to 1232.50
    assert result["money_saved_dkk"] == pytest.approx(1232.5)
    assert result["accountant_hourly_rate"] == pytest.approx(850.0)


# ═════════════════════════════════════════════════════════════════════
# Service — period-boundary inclusion: items right at edges
# ═════════════════════════════════════════════════════════════════════


def test_period_boundary_inclusive_on_both_ends(db_session):
    """An action whose date == period_start OR period_end must be INCLUDED.
    An action one day outside on either side must be EXCLUDED.

    This is the "you said it counted; the accountant looks at the
    spreadsheet and the row IS in there" verification — the boundary
    behavior is what makes the number defensible."""
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)

    start = date(2026, 5, 1)
    end = date(2026, 5, 31)

    # Receipts at every boundary position
    _make_expense(db_session, user, cat, on_date=date(2026, 4, 30), with_receipt=True)  # OUT
    _make_expense(db_session, user, cat, on_date=start, with_receipt=True)              # IN (start edge)
    _make_expense(db_session, user, cat, on_date=date(2026, 5, 15), with_receipt=True)  # IN
    _make_expense(db_session, user, cat, on_date=end, with_receipt=True)                # IN (end edge)
    _make_expense(db_session, user, cat, on_date=date(2026, 6, 1), with_receipt=True)   # OUT

    result = compute_hours_saved(db_session, user, start, end)
    receipt = next(r for r in result["breakdown"] if r["source"] == "receipt_ocr")
    # 3 of 5 receipts are in the [start, end] inclusive window
    assert receipt["items"] == 3


def test_moms_export_boundary_uses_audit_log_timestamp(db_session):
    """MOMS exports are timed by audit_logs.created_at (a DateTime, not a
    date). Verify the boundary works for both the start-of-day and the
    end-of-day edge: a row at 23:59:59 on the end date must still count."""
    user = _make_user(db_session, plan="starter")
    start = date(2026, 5, 1)
    end = date(2026, 5, 31)

    # 00:00:00 on start day → IN
    _make_moms_export_audit(
        db_session, user,
        when=datetime(2026, 5, 1, 0, 0, 0),
    )
    # 23:59:00 on end day → IN
    _make_moms_export_audit(
        db_session, user,
        when=datetime(2026, 5, 31, 23, 59, 0),
    )
    # Right after end → OUT
    _make_moms_export_audit(
        db_session, user,
        when=datetime(2026, 6, 1, 0, 0, 1),
    )

    result = compute_hours_saved(db_session, user, start, end)
    moms = next(r for r in result["breakdown"] if r["source"] == "moms_export")
    assert moms["items"] == 2


# ═════════════════════════════════════════════════════════════════════
# Service — only LOCKED closes count (draft is honest-not-yet)
# ═════════════════════════════════════════════════════════════════════


def test_only_confirmed_closes_count_drafts_excluded(db_session):
    """A draft close hasn't been committed yet — the owner can still
    edit it, so the accountant-hour saving hasn't crystallised. Only
    'confirmed' (locked) closes count."""
    user = _make_user(db_session, plan="starter")
    today = date.today()

    _make_close(db_session, user, on_date=today, status="confirmed")
    _make_close(db_session, user, on_date=today - timedelta(days=1), status="draft")

    result = compute_hours_saved(db_session, user, today - timedelta(days=7), today)
    close = next((r for r in result["breakdown"] if r["source"] == "daily_close_autopilot"), None)
    assert close is not None
    assert close["items"] == 1


# ═════════════════════════════════════════════════════════════════════
# Service — invoices: only sent_at IS NOT NULL counts (drift note)
# ═════════════════════════════════════════════════════════════════════


def test_only_sent_invoices_count(db_session):
    """Drift discovered: Invoice has no `pdf_generated_at` column. We
    use sent_at IS NOT NULL as the closest semantically-correct signal
    for "this faktura PDF was generated and used"."""
    user = _make_user(db_session, plan="starter")
    cust = _make_customer(db_session, user)
    today = date.today()
    start = today.replace(day=1)

    # Sent invoice → counted
    _make_invoice(
        db_session, user, cust,
        sent_at=datetime.combine(today, datetime.min.time()) + timedelta(hours=10),
        fakturanummer=1,
    )
    # Draft invoice (sent_at NULL) → NOT counted
    draft = Invoice(
        user_id=user.id,
        customer_id=cust.id,
        fakturanummer=2,
        issue_date=today,
        due_date=today + timedelta(days=14),
        status="draft",
        sent_at=None,
        subtotal_net=Decimal("100"),
        moms_total=Decimal("25"),
        total_gross=Decimal("125"),
        currency="DKK",
        customer_lang="da",
        locked=False,
    )
    db_session.add(draft); db_session.commit()

    result = compute_hours_saved(db_session, user, start, today)
    fakt = next(r for r in result["breakdown"] if r["source"] == "faktura_pdf")
    assert fakt["items"] == 1


# ═════════════════════════════════════════════════════════════════════
# Service — receipts without OCR photo aren't credited
# ═════════════════════════════════════════════════════════════════════


def test_expenses_without_receipt_photo_not_credited(db_session):
    """Honesty contract: the value we claim is "we saved you the time of
    chasing/categorising the paper receipt." A manually-entered expense
    with no photo attached doesn't make that claim defensible."""
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    start = today.replace(day=1)

    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    _make_expense(db_session, user, cat, on_date=today, with_receipt=False)  # NO photo

    result = compute_hours_saved(db_session, user, start, today)
    rec = next(r for r in result["breakdown"] if r["source"] == "receipt_ocr")
    assert rec["items"] == 1


def test_soft_deleted_expenses_excluded(db_session):
    """A receipt that was scanned then deleted doesn't count — the
    accountant doesn't owe the owner for work the owner threw away."""
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    start = today.replace(day=1)

    e_kept = _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    e_del = _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    e_del.is_deleted = True
    e_del.deleted_at = utc_now()
    db_session.commit()

    result = compute_hours_saved(db_session, user, start, today)
    rec = next((r for r in result["breakdown"] if r["source"] == "receipt_ocr"), None)
    assert rec is not None
    assert rec["items"] == 1  # the deleted one excluded
    _ = e_kept  # silence unused-var


# ═════════════════════════════════════════════════════════════════════
# Service — negative period (end < start) → zero payload
# ═════════════════════════════════════════════════════════════════════


def test_negative_period_returns_zero_payload(db_session):
    """end < start → zero payload (service-level L4 fallback). The
    router returns 422 from the same input shape (covered below)."""
    user = _make_user(db_session, plan="starter")
    today = date.today()

    result = compute_hours_saved(db_session, user, today, today - timedelta(days=10))
    assert result["hours_saved"] == 0.0
    assert result["money_saved_dkk"] == 0.0
    assert result["breakdown"] == []


# ═════════════════════════════════════════════════════════════════════
# Service — env override on per-source minute rates
# ═════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "env_var,minutes,expected_hours",
    [
        # 10 receipts * 3 min = 30 min = 0.5 h
        ("ACCT_SAVINGS_RECEIPT_MIN", "3.0", 0.5),
        # Override too small? Still honoured (Manoj might recalibrate down)
        ("ACCT_SAVINGS_RECEIPT_MIN", "0.5", 0.08),  # 10*0.5/60 = 0.083 → trunc 0.08
    ],
)
def test_env_override_changes_receipt_rate(
    db_session, monkeypatch, env_var, minutes, expected_hours,
):
    """Env override flows through: setting ACCT_SAVINGS_RECEIPT_MIN
    changes the receipt source's hours computation without redeploy."""
    monkeypatch.setenv(env_var, minutes)
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    for _ in range(10):
        _make_expense(db_session, user, cat, on_date=today, with_receipt=True)

    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    rec = next(r for r in result["breakdown"] if r["source"] == "receipt_ocr")
    assert rec["items"] == 10
    assert rec["hours"] == pytest.approx(expected_hours, abs=0.01)
    assert rec["rate_min_each"] == float(minutes)


def test_env_override_hourly_rate(db_session, monkeypatch):
    """DK_ACCOUNTANT_HOURLY_DKK override changes money_saved_dkk for a
    DKK user without changing the hour math itself."""
    monkeypatch.setenv("DK_ACCOUNTANT_HOURLY_DKK", "1000")
    user = _make_user(db_session, plan="starter", currency="DKK")
    cat = _make_category(db_session, user)
    today = date.today()
    # 10 receipts @ default 1.5 min = 15 min = 0.25 h
    for _ in range(10):
        _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    assert result["accountant_hourly_rate"] == 1000.0
    # 0.25 * 1000 = 250 (round down)
    assert result["money_saved_dkk"] == pytest.approx(250.0)


def test_invalid_env_override_falls_back_to_default(db_session, monkeypatch):
    """A garbage env value must NOT crash the service — it falls back
    to the default minute rate. L4 defense."""
    monkeypatch.setenv("ACCT_SAVINGS_RECEIPT_MIN", "not-a-number")
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    rec = next(r for r in result["breakdown"] if r["source"] == "receipt_ocr")
    # Default 1.5 min restored
    assert rec["rate_min_each"] == 1.5


def test_zero_or_negative_env_override_falls_back_to_default(db_session, monkeypatch):
    """An owner-fingertip override of "0" or negative shouldn't zero out
    the math — those are clearly mistakes, fall back to the default."""
    monkeypatch.setenv("ACCT_SAVINGS_CLOSE_MIN", "0")
    user = _make_user(db_session, plan="starter")
    today = date.today()
    _make_close(db_session, user, on_date=today, status="confirmed")
    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    close = next(r for r in result["breakdown"] if r["source"] == "daily_close_autopilot")
    assert close["rate_min_each"] == 12.0  # default


# ═════════════════════════════════════════════════════════════════════
# Service — currency-specific hourly rate lookup
# ═════════════════════════════════════════════════════════════════════


def test_eur_user_gets_eur_hourly_rate(db_session):
    """A non-DKK user gets a non-DKK hourly rate so the money number
    isn't nonsense. Currency stays in the user's own."""
    user = _make_user(db_session, plan="starter", currency="EUR")
    cat = _make_category(db_session, user)
    today = date.today()
    for _ in range(8):
        _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    assert result["currency"] == "EUR"
    assert result["accountant_hourly_rate"] == 115.0


def test_unknown_currency_falls_back_to_dk_rate(db_session):
    """Unknown currency code = use the DK rate as a safe default rather
    than zero. The number is shown labelled with the owner's currency
    so it's clearly an approximation."""
    user = _make_user(db_session, plan="starter", currency="XYZ")
    cat = _make_category(db_session, user)
    today = date.today()
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    result = compute_hours_saved(db_session, user, today.replace(day=1), today)
    assert result["accountant_hourly_rate"] == 850.0


# ═════════════════════════════════════════════════════════════════════
# Service — tenant scoping: never see another user's data
# ═════════════════════════════════════════════════════════════════════


def test_other_users_actions_never_counted(db_session):
    """L5 — the service filters by user_id on every source. Another
    user's data MUST NOT bleed into the requesting user's totals."""
    alice = _make_user(db_session, plan="starter", email="alice@x.com")
    bob = _make_user(db_session, plan="starter", email="bob@x.com")
    cat_a = _make_category(db_session, alice)
    cat_b = _make_category(db_session, bob)

    today = date.today()
    # Bob has 100 receipts, Alice has 1
    for _ in range(100):
        _make_expense(db_session, bob, cat_b, on_date=today, with_receipt=True)
    _make_expense(db_session, alice, cat_a, on_date=today, with_receipt=True)

    alice_result = compute_hours_saved(db_session, alice, today.replace(day=1), today)
    rec = next(r for r in alice_result["breakdown"] if r["source"] == "receipt_ocr")
    assert rec["items"] == 1  # Bob's 100 invisible


# ═════════════════════════════════════════════════════════════════════
# Router — endpoint plumbing
# ═════════════════════════════════════════════════════════════════════


def test_router_current_month_starter_returns_payload(db_session, client):
    """End-to-end: Starter user calls /current-month, gets the canonical
    payload with this calendar month's data."""
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)

    r = client.get("/api/accountant-savings/current-month", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    payload = r.json()
    assert "hours_saved" in payload
    assert "breakdown" in payload
    assert payload["tier"] == "starter"
    rec = next(b for b in payload["breakdown"] if b["source"] == "receipt_ocr")
    assert rec["items"] == 1


def test_router_current_month_free_returns_zero_payload(db_session, client):
    """Free user hits the endpoint directly → still gets the zero
    payload, never leaks hour numbers. L1 multi-barrier in the service."""
    user = _make_user(db_session, plan="free")
    cat = _make_category(db_session, user)
    today = date.today()
    for _ in range(50):
        _make_expense(db_session, user, cat, on_date=today, with_receipt=True)

    r = client.get("/api/accountant-savings/current-month", headers=_auth_headers(user))
    assert r.status_code == 200
    payload = r.json()
    assert payload["hours_saved"] == 0.0
    assert payload["money_saved_dkk"] == 0.0
    assert payload["breakdown"] == []
    assert payload["tier"] == "free"


def test_router_unauthenticated_rejected(client):
    """No Authorization header → 401. Aggregate metric or not, this is
    tenant-scoped data and must require auth."""
    r = client.get("/api/accountant-savings/current-month")
    assert r.status_code == 401


def test_router_range_reversed_returns_422(db_session, client):
    """end < start → 422 with structured error detail (defense in depth
    against the service's zero-payload fallback)."""
    user = _make_user(db_session, plan="starter")
    r = client.get(
        "/api/accountant-savings/range",
        params={"start": "2026-05-31", "end": "2026-05-01"},
        headers=_auth_headers(user),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_range"


def test_router_range_too_large_returns_422(db_session, client):
    """Range > 1 year → 422. Prevents a /range call from asking the DB
    for arbitrary history."""
    user = _make_user(db_session, plan="starter")
    r = client.get(
        "/api/accountant-savings/range",
        params={"start": "2020-01-01", "end": "2026-05-01"},
        headers=_auth_headers(user),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "range_too_large"


def test_router_range_valid_returns_payload(db_session, client):
    """A valid bounded range returns the same shape as /current-month."""
    user = _make_user(db_session, plan="starter")
    cat = _make_category(db_session, user)
    today = date.today()
    _make_expense(db_session, user, cat, on_date=today, with_receipt=True)
    _make_close(db_session, user, on_date=today, status="confirmed")

    start = (today - timedelta(days=30)).isoformat()
    end = today.isoformat()
    r = client.get(
        "/api/accountant-savings/range",
        params={"start": start, "end": end},
        headers=_auth_headers(user),
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["hours_saved"] > 0
    sources = {b["source"] for b in payload["breakdown"]}
    assert "receipt_ocr" in sources
    assert "daily_close_autopilot" in sources
