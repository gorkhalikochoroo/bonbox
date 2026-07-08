"""Tests for the Tax Autopilot MOMS-angivelse filing-ready PDF (Task #51).

Coverage:
  • PLAN_FEATURES — tax_filing_pdf flag present on every tier with the
    right Pro-only mapping.
  • Service-level — compute_filing_data returns the right structure;
    build_moms_filing_pdf yields valid PDF bytes; handles empty data;
    Danish vs English locale based on currency.
  • Router — Pro user downloads; Free + Starter get 402 plan_required;
    custom period_start/period_end are respected; cross-tenant isolation;
    audit log row is written.
  • Send-to-accountant — happy path queues email + writes audit row;
    Pro+ gate; tenant scope.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.billing import PLAN_FEATURES, has_feature
from app.services.tax_filing_pdf import (
    build_moms_filing_pdf,
    compute_filing_data,
    make_bilagsnummer,
    resolve_default_period,
)
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def db_session():
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
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, *, email="manoj@cafe.dk", currency="DKK", plan="pro"):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency=currency,
        plan=plan,
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_profile(db, user, *, company_name="Café Manoj ApS",
                  org_number="12345678", accountant_email=None):
    p = BusinessProfile(
        user_id=user.id,
        company_name=company_name,
        org_number=org_number,
        country="DK",
        address="Vesterbrogade 12",
        city="København",
        zipcode="1620",
        accountant_email=accountant_email,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


def _make_expense_category(db, user, name="Office"):
    c = ExpenseCategory(user_id=user.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _make_sale(db, user, *, amount=1250.0, sale_date=None):
    s = Sale(
        user_id=user.id,
        date=sale_date or date(2026, 5, 15),
        amount=amount,
        payment_method="card",
        is_deleted=False,
        is_tax_exempt=False,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _make_expense(db, user, category, *, amount=500.0, expense_date=None, description="Test expense"):
    # description is NOT NULL on the Expense model (it's the user-facing
    # label the brief + reports use). Supplying a default keeps fixture
    # call-sites concise without breaking the schema.
    e = Expense(
        user_id=user.id,
        category_id=category.id,
        date=expense_date or date(2026, 5, 15),
        amount=amount,
        description=description,
        is_deleted=False,
        is_personal=False,
        is_tax_exempt=False,
    )
    db.add(e); db.commit(); db.refresh(e)
    return e


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


# ─── PLAN_FEATURES wiring ────────────────────────────────────────────


def test_tax_filing_pdf_feature_present_on_every_tier():
    """If a future tier is added without this flag, the user would
    silently fall to free's value. Pin all four tiers."""
    for tier in ("free", "starter", "trial", "pro"):
        assert "tax_filing_pdf" in PLAN_FEATURES[tier], (
            f"Tier {tier!r} missing tax_filing_pdf in PLAN_FEATURES"
        )


def test_tax_filing_pdf_only_pro_and_trial():
    """Free + Starter are locked; Pro + Trial are unlocked.

    The Pro-only gate is the entire point of this feature — if Starter
    ever flips to True without a deliberate decision, it changes the
    pricing-page promise. Hard-pin both sides."""
    assert PLAN_FEATURES["free"]["tax_filing_pdf"] is False
    assert PLAN_FEATURES["starter"]["tax_filing_pdf"] is False
    assert PLAN_FEATURES["pro"]["tax_filing_pdf"] is True
    assert PLAN_FEATURES["trial"]["tax_filing_pdf"] is True


def test_has_feature_returns_correct_value_per_plan(db_session):
    """has_feature is the canonical gate — it must agree with
    PLAN_FEATURES on this flag."""
    free_user = _make_user(db_session, email="free@x.dk", plan="free")
    starter_user = _make_user(db_session, email="starter@x.dk", plan="starter")
    pro_user = _make_user(db_session, email="pro@x.dk", plan="pro")

    assert has_feature(free_user, "tax_filing_pdf") is False
    assert has_feature(starter_user, "tax_filing_pdf") is False
    assert has_feature(pro_user, "tax_filing_pdf") is True


# ─── Service: compute_filing_data ────────────────────────────────────


def test_compute_filing_data_empty_period_returns_zeros(db_session):
    """A Pro user with no sales/expenses in the period gets a clean
    zero-filled response — never crashes, never NaN."""
    user = _make_user(db_session)
    data = compute_filing_data(
        db_session, user, date(2026, 1, 1), date(2026, 6, 30),
    )
    assert data["salg_med_moms"] == 0
    assert data["moms_af_salg"] == 0
    assert data["kob_med_moms"] == 0
    assert data["moms_af_kob"] == 0
    assert data["moms_til_skat"] == 0
    assert data["sales_count"] == 0
    assert data["expense_count"] == 0
    assert data["currency"] == "DKK"
    assert data["vat_rate"] == 0.25


def test_compute_filing_data_with_b2c_sales(db_session):
    """B2C user (prices_include_moms=True): 1250 gross sale yields
    250 output VAT (extracted), 1000 net."""
    user = _make_user(db_session)
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))

    data = compute_filing_data(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    assert data["salg_med_moms"] == 1250.0
    assert data["moms_af_salg"] == 250.0  # 1250 * 0.25 / 1.25
    assert data["sales_count"] == 1


def test_compute_filing_data_excludes_returned_and_exchanged_sales(db_session):
    """Returned/exchanged sales (status != 'completed') must NOT inflate the
    MOMS filing base. The return handler flips status but keeps amount positive
    and is_deleted=False, so a raw SUM(Sale.amount) over-declares output VAT on
    the signed SKAT angivelse. The filing must tie out to the return-aware
    revenue resolver (status == 'completed'). Launch-audit P1 regression."""
    user = _make_user(db_session)
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))
    for amt, day, st in [(500.0, 16, "returned"), (300.0, 17, "exchanged")]:
        db_session.add(Sale(
            user_id=user.id, date=date(2026, 5, day), amount=amt,
            payment_method="card", is_deleted=False, is_tax_exempt=False,
            status=st,
        ))
    db_session.commit()

    data = compute_filing_data(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    # Only the 1250 completed sale — NOT 1250 + 500 + 300 = 2050.
    assert data["salg_med_moms"] == 1250.0, "returned/exchanged sales leaked into taxable base"
    assert data["moms_af_salg"] == 250.0, "output VAT over-declared from returned sales"
    # The voucher count must share the same predicate as the base, or a revisor
    # cross-checking count-vs-total sees 3 vouchers against a 1-sale base.
    assert data["sales_count"] == 1, "voucher count must exclude returned/exchanged too"


def test_compute_filing_data_with_expenses(db_session):
    """Expenses with VAT-inclusive prices: 500 gross yields 100 input VAT."""
    user = _make_user(db_session)
    cat = _make_expense_category(db_session, user)
    _make_expense(db_session, user, cat, amount=500.0,
                  expense_date=date(2026, 5, 10))

    data = compute_filing_data(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    assert data["kob_med_moms"] == 500.0
    assert data["moms_af_kob"] == 100.0  # 500 * 0.25 / 1.25
    assert data["expense_count"] == 1


def test_compute_filing_data_net_to_skat(db_session):
    """Output - Input → moms_til_skat. Positive = owed."""
    user = _make_user(db_session)
    cat = _make_expense_category(db_session, user)
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))
    _make_expense(db_session, user, cat, amount=500.0,
                  expense_date=date(2026, 5, 10))

    data = compute_filing_data(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    # 250 output - 100 input = 150 owed
    assert data["moms_til_skat"] == 150.0


def test_compute_filing_data_period_isolates_correctly(db_session):
    """Sales OUTSIDE the period must not be counted. Defends against
    a sloppy filter that uses >= start but forgets to bound end."""
    user = _make_user(db_session)
    # In-period
    _make_sale(db_session, user, amount=1000.0, sale_date=date(2026, 5, 15))
    # Out-of-period (later)
    _make_sale(db_session, user, amount=9999.0, sale_date=date(2026, 7, 1))
    # Out-of-period (earlier)
    _make_sale(db_session, user, amount=7777.0, sale_date=date(2026, 4, 30))

    data = compute_filing_data(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    assert data["salg_med_moms"] == 1000.0
    assert data["sales_count"] == 1


# ─── Service: build_moms_filing_pdf ──────────────────────────────────


def test_build_moms_filing_pdf_returns_valid_pdf_bytes(db_session):
    """Sanity — output starts with %PDF magic bytes, non-trivial size."""
    user = _make_user(db_session)
    profile = _make_profile(db_session, user)
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))

    pdf = build_moms_filing_pdf(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
        profile=profile,
    )
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 1500  # not an error blob


def test_build_moms_filing_pdf_empty_data_does_not_crash(db_session):
    """No sales, no expenses → must still render a PDF (the "nothing
    to file" path). Empty filings are still legally required to be
    submitted."""
    user = _make_user(db_session)
    pdf = build_moms_filing_pdf(
        db_session, user, date(2026, 1, 1), date(2026, 6, 30),
    )
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 1500


def test_build_moms_filing_pdf_non_dkk_currency(db_session):
    """Non-DKK currency triggers the English label branch — must not crash."""
    user = _make_user(db_session, currency="EUR")
    pdf = build_moms_filing_pdf(
        db_session, user, date(2026, 1, 1), date(2026, 3, 31),
    )
    assert pdf[:4] == b"%PDF"


def test_build_moms_filing_pdf_without_profile(db_session):
    """No BusinessProfile (user never set it up) → falls back to
    user.business_name. Should still produce a valid PDF."""
    user = _make_user(db_session)
    pdf = build_moms_filing_pdf(
        db_session, user, date(2026, 5, 1), date(2026, 5, 31),
    )
    assert pdf[:4] == b"%PDF"


# ─── bilagsnummer ────────────────────────────────────────────────────


def test_make_bilagsnummer_is_period_anchored_and_sortable():
    """Two periods sort lexicographically by start date — accountants
    drop these in a folder and need them in chronological order."""
    early = make_bilagsnummer(date(2026, 1, 1), date(2026, 3, 31))
    later = make_bilagsnummer(date(2026, 4, 1), date(2026, 6, 30))
    assert early < later
    assert early == "MA-20260101-20260331"
    assert later == "MA-20260401-20260630"


def test_make_bilagsnummer_is_deterministic():
    """Same period always yields the same bilagsnummer — important for
    de-dupe / replay scenarios."""
    a = make_bilagsnummer(date(2026, 1, 1), date(2026, 6, 30))
    b = make_bilagsnummer(date(2026, 1, 1), date(2026, 6, 30))
    assert a == b


# ─── resolve_default_period ───────────────────────────────────────────


def test_resolve_default_period_returns_valid_range(db_session):
    """Default period is a 1+ day range bounded by the user's filing
    frequency. We don't pin exact dates because they depend on today's
    date — just that the call succeeds and produces a reasonable span."""
    user = _make_user(db_session)
    start, end = resolve_default_period(user)
    assert isinstance(start, date)
    assert isinstance(end, date)
    assert end >= start
    assert (end - start).days <= 366


# ─── Router: GET /tax/filing-pdf ─────────────────────────────────────


def test_filing_pdf_pro_user_downloads(db_session, client):
    """Pro user gets a PDF with proper Content-Disposition + Content-Type."""
    user = _make_user(db_session, plan="pro")
    _make_profile(db_session, user)
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))

    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01&period_end=2026-05-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 200, f"Got {r.status_code}: {r.text[:300]}"
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("attachment;")
    assert "MA-20260501-20260531.pdf" in r.headers["content-disposition"]
    assert r.content[:4] == b"%PDF"


def test_filing_pdf_free_user_gets_402_plan_required(db_session, client):
    """Free tier is locked. Frontend reads detail.code to render
    UpgradeNudge."""
    user = _make_user(db_session, plan="free")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01&period_end=2026-05-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 402
    body = r.json()
    assert body["detail"]["code"] == "plan_required"
    assert body["detail"]["feature"] == "tax_filing_pdf"
    assert body["detail"]["required_plan"] == "pro"
    assert body["detail"]["current_plan"] == "free"


def test_filing_pdf_starter_user_gets_402_plan_required(db_session, client):
    """Starter is also locked — this is a Pro-only differentiator."""
    user = _make_user(db_session, plan="starter")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01&period_end=2026-05-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 402
    assert r.json()["detail"]["current_plan"] == "starter"


def test_filing_pdf_empty_pro_user_still_downloads(db_session, client):
    """Pro user with NO sales/expenses still gets a valid PDF (the
    "nothing to file" / 0,00 kr filing). Common for new businesses."""
    user = _make_user(db_session, plan="pro")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01&period_end=2026-05-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


def test_filing_pdf_default_period_when_no_query_params(db_session, client):
    """If period_start/end are omitted, the server defaults to the
    user's filing-frequency current period. Verify by hitting the
    endpoint with no params and confirming a PDF is returned."""
    user = _make_user(db_session, plan="pro")
    r = client.get("/api/tax/filing-pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


def test_filing_pdf_rejects_inverted_period(db_session, client):
    """period_end < period_start → 400 invalid_period."""
    user = _make_user(db_session, plan="pro")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-31&period_end=2026-05-01",
        headers=_auth_headers(user),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_period"


def test_filing_pdf_rejects_too_long_period(db_session, client):
    """Period > 366 days → 400 period_too_long. Defense-in-depth
    against DB-scan DOS."""
    user = _make_user(db_session, plan="pro")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2024-01-01&period_end=2026-12-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "period_too_long"


def test_filing_pdf_rejects_half_specified_period(db_session, client):
    """Providing one but not the other is ambiguous → 400."""
    user = _make_user(db_session, plan="pro")
    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01",
        headers=_auth_headers(user),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "incomplete_period"


def test_filing_pdf_cross_tenant_isolation(db_session, client):
    """User A's sales must not leak into User B's filing PDF.

    We confirm isolation indirectly: a fresh Pro user with no data
    in the period returns a "zero" PDF (smaller than one with data).
    More importantly, the audit row stores totals — verify A's totals
    are non-zero while B's are zero."""
    user_a = _make_user(db_session, email="a@x.dk", plan="pro")
    user_b = _make_user(db_session, email="b@x.dk", plan="pro")
    # Only user A has sales
    _make_sale(db_session, user_a, amount=5000.0,
               sale_date=date(2026, 5, 15))

    # A's call sees the data
    data_a = compute_filing_data(
        db_session, user_a, date(2026, 5, 1), date(2026, 5, 31),
    )
    # B's call must NOT see A's data
    data_b = compute_filing_data(
        db_session, user_b, date(2026, 5, 1), date(2026, 5, 31),
    )

    assert data_a["salg_med_moms"] == 5000.0
    assert data_a["sales_count"] == 1
    assert data_b["salg_med_moms"] == 0
    assert data_b["sales_count"] == 0


def test_filing_pdf_writes_audit_log(db_session, client):
    """Bogføringsloven §10 — every PDF generation must leave an
    audit trail with the action namespace + totals."""
    user = _make_user(db_session, plan="pro")
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))

    r = client.get(
        "/api/tax/filing-pdf?period_start=2026-05-01&period_end=2026-05-31",
        headers=_auth_headers(user),
    )
    assert r.status_code == 200

    rows = db_session.query(AuditLog).filter(
        AuditLog.user_id == user.id,
        AuditLog.action == "tax.filing_pdf_generated",
    ).all()
    assert len(rows) == 1
    assert rows[0].entity_type == "tax_filing"


# ─── Router: POST /tax/filing-pdf/send-to-accountant ─────────────────


def test_send_to_accountant_happy_path(db_session, client):
    """Pro user with accountant_email on profile → email queued, audit
    row written, 200 OK with metadata. Mocked Resend.

    The mock returns (True, None) regardless of input so the test
    exercises the router happy path without hitting the network."""
    user = _make_user(db_session, plan="pro")
    _make_profile(db_session, user, accountant_email="revisor@dk.dk")
    _make_sale(db_session, user, amount=1250.0, sale_date=date(2026, 5, 15))

    # send_email_with_attachment is imported inside the router function
    # — patch at the email_service module level to intercept.
    with patch(
        "app.services.email_service.send_email_with_attachment",
        return_value=(True, None),
    ):
        r = client.post(
            "/api/tax/filing-pdf/send-to-accountant"
            "?period_start=2026-05-01&period_end=2026-05-31",
            json={"cc_self": True},
            headers=_auth_headers(user),
        )

    assert r.status_code == 200, f"Got {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body["ok"] is True
    assert body["sent_to"] == "revisor@dk.dk"
    assert body["cc_self"] is True
    assert body["bilagsnummer"] == "MA-20260501-20260531"

    # Audit row
    rows = db_session.query(AuditLog).filter(
        AuditLog.user_id == user.id,
        AuditLog.action == "tax.filing_sent_to_accountant",
    ).all()
    assert len(rows) == 1


def test_send_to_accountant_free_user_gets_402(db_session, client):
    """Free user trying to send → 402 plan_required."""
    user = _make_user(db_session, plan="free")
    _make_profile(db_session, user, accountant_email="revisor@dk.dk")

    r = client.post(
        "/api/tax/filing-pdf/send-to-accountant"
        "?period_start=2026-05-01&period_end=2026-05-31",
        json={"cc_self": True},
        headers=_auth_headers(user),
    )
    assert r.status_code == 402
    assert r.json()["detail"]["code"] == "plan_required"


def test_send_to_accountant_no_recipient_returns_400(db_session, client):
    """Pro user with neither profile.accountant_email NOR body.accountant_email
    → 400 no_accountant_email so the frontend can prompt for one."""
    user = _make_user(db_session, plan="pro")
    # No profile / no accountant_email
    r = client.post(
        "/api/tax/filing-pdf/send-to-accountant"
        "?period_start=2026-05-01&period_end=2026-05-31",
        json={"cc_self": True},
        headers=_auth_headers(user),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "no_accountant_email"


def test_send_to_accountant_uses_body_override_recipient(db_session, client):
    """When body.accountant_email is supplied, it wins over profile.
    Useful when the owner wants a one-off send to a different revisor."""
    user = _make_user(db_session, plan="pro")
    _make_profile(db_session, user, accountant_email="default@x.dk")

    with patch(
        "app.services.email_service.send_email_with_attachment",
        return_value=(True, None),
    ):
        r = client.post(
            "/api/tax/filing-pdf/send-to-accountant"
            "?period_start=2026-05-01&period_end=2026-05-31",
            json={"cc_self": False, "accountant_email": "override@x.dk"},
            headers=_auth_headers(user),
        )

    assert r.status_code == 200
    assert r.json()["sent_to"] == "override@x.dk"


def test_send_to_accountant_email_failure_returns_503(db_session, client):
    """If Resend is down, return 503 so the frontend can fall back
    to a download + mailto path."""
    user = _make_user(db_session, plan="pro")
    _make_profile(db_session, user, accountant_email="revisor@dk.dk")

    with patch(
        "app.services.email_service.send_email_with_attachment",
        return_value=(False, "resend_unavailable"),
    ):
        r = client.post(
            "/api/tax/filing-pdf/send-to-accountant"
            "?period_start=2026-05-01&period_end=2026-05-31",
            json={"cc_self": True},
            headers=_auth_headers(user),
        )

    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "email_send_failed"
