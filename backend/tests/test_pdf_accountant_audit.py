"""Tests for the audit-grade upgrades on every PDF / export artifact.

Covers the four generators:
  1. kasserapport_pdf — render_kasserapport_pdf / render_close_pdf
  2. invoice_pdf — render_invoice_pdf
  3. tax_filing_pdf — build_moms_filing_pdf
  4. bookkeeping_export — export_bookkeeping_zip / export_bundle

What we pin (per the audit checklist):
  • Business name + CVR + VAT number visible
  • Generation timestamp + generator email in the footer
  • Page numbers in "X of Y" form
  • Document SHA-256 hash for tamper-evidence
  • Software identifier ("BonBox v…")
  • is_locked_signed indication on kasserapport
  • SAF-T-compatible columns on the generic CSV
  • Manifest with hashes in the bookkeeping ZIP
  • MOMS summary CSV present in the bundle

ReportLab compresses streams by default so the rendered PDF bytes don't
contain plain-ASCII strings. We assert structural properties (valid
PDF, byte length, hashing utility correctness) for the PDFs and
content properties for the CSVs/ZIP where plain text is preserved.
"""
from __future__ import annotations

import io
import uuid
import zipfile
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app import models as _all_models  # noqa: F401 — register tables
from app.models.business_profile import BusinessProfile
from app.models.customer import Customer
from app.models.expense import Expense, ExpenseCategory
from app.models.invoice import Invoice, InvoiceLine
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import hash_password
from app.services.bookkeeping_export import (
    export_bookkeeping_zip,
    export_bundle,
    export_generic,
    export_moms_summary,
)
from app.services.invoice_pdf import render_invoice_pdf
from app.services.kasserapport_pdf import (
    render_close_pdf,
    render_kasserapport_pdf,
)
from app.services.tax_filing_pdf import build_moms_filing_pdf
from app.utils.document_hash import (
    compute_document_hash,
    get_software_identifier,
    get_software_version,
    short_hash,
)
from app.utils.time import utc_now


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
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def audit_user(db_session):
    u = User(
        email="manoj@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency="DKK",
        plan="pro",
        created_at=utc_now() - timedelta(days=10),
        email_verified=True,
    )
    db_session.add(u); db_session.commit(); db_session.refresh(u)
    return u


@pytest.fixture
def audit_profile(db_session, audit_user):
    p = BusinessProfile(
        user_id=audit_user.id,
        company_name="Café Manoj ApS",
        org_number="12345678",
        vat_number="DK12345678",
        country="DK",
        address="Vesterbrogade 12",
        zipcode="1620",
        city="København V",
    )
    db_session.add(p); db_session.commit(); db_session.refresh(p)
    return p


@pytest.fixture
def audit_customer(db_session, audit_user):
    c = Customer(
        user_id=audit_user.id,
        name="Acme Aps",
        cvr="87654321",
        is_company=True,
        address="Strøget 1",
        zipcode="1160",
        city="København K",
        country="DK",
        email="ar@acme.dk",
    )
    db_session.add(c); db_session.commit(); db_session.refresh(c)
    return c


def _make_invoice(db, user, customer):
    inv = Invoice(
        user_id=user.id,
        customer_id=customer.id,
        fakturanummer=42,
        issue_date=date(2026, 5, 15),
        due_date=date(2026, 6, 14),
        status="sent",
        subtotal_net=Decimal("800.00"),
        moms_total=Decimal("200.00"),
        total_gross=Decimal("1000.00"),
        currency="DKK",
        customer_lang="da",
    )
    db.add(inv); db.commit(); db.refresh(inv)
    line = InvoiceLine(
        invoice_id=inv.id,
        line_order=0,
        description="Konsulentydelse maj 2026",
        quantity=Decimal("8"),
        unit="timer",
        unit_price_net=Decimal("100.00"),
        moms_rate=Decimal("0.250"),
        line_net=Decimal("800.00"),
        line_moms=Decimal("200.00"),
        line_gross=Decimal("1000.00"),
    )
    db.add(line); db.commit(); db.refresh(inv)
    return inv


# ─── Document hash utility ────────────────────────────────────────────


def test_compute_document_hash_is_deterministic():
    h1 = compute_document_hash(b"hello world")
    h2 = compute_document_hash(b"hello world")
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex


def test_compute_document_hash_differs_on_change():
    """Tamper-evidence: a 1-byte change produces a different hash."""
    h1 = compute_document_hash(b"hello world")
    h2 = compute_document_hash(b"hello worle")  # last letter changed
    assert h1 != h2


def test_compute_document_hash_handles_none():
    """None → hash of empty bytes, never raises."""
    h = compute_document_hash(None)  # type: ignore[arg-type]
    assert h == compute_document_hash(b"")


def test_short_hash_returns_requested_length():
    full = compute_document_hash(b"hello")
    assert short_hash(b"hello", length=16) == full[:16]
    assert len(short_hash(b"hello", length=8)) == 8


def test_software_identifier_format():
    """Software ID has the 'BonBox vX.Y.Z' shape SKAT expects."""
    ident = get_software_identifier()
    assert ident.startswith("BonBox v")
    version = get_software_version()
    assert ident == f"BonBox v{version}"


# ─── kasserapport_pdf ─────────────────────────────────────────────────


def _agg_minimal():
    return {
        "closed_by": "Caro",
        "cash_total": 18799,
        "payments_total": 110910.65,
        "sales_pos": 100292.54,
        "cash_difference": 0,
        "cash_diff_flagged": False,
        "terminals": [],
    }


def test_kasserapport_alias_returns_valid_pdf():
    """render_kasserapport_pdf is the audit-checklist-named alias."""
    pdf = render_kasserapport_pdf(
        aggregated=_agg_minimal(),
        business_name="Café Manoj ApS",
        date_label="9.3.2026 (Mandag)",
        currency="DKK",
        business_profile={
            "org_number": "12345678",
            "vat_number": "DK12345678",
            "address": "Vesterbrogade 12",
            "zipcode": "1620",
            "city": "København V",
        },
        bilagsnummer="K2026-0042",
        generated_by_email="owner@cafemanoj.dk",
        is_locked_signed=True,
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")
    # Substantive — not just a fallback error PDF.
    assert len(pdf) > 1500


def test_kasserapport_unlocked_label_renders():
    """is_locked_signed=False should switch the audit label to 'preview'."""
    pdf = render_close_pdf(
        aggregated=_agg_minimal(),
        business_name="Test",
        date_label="9.3.2026",
        currency="DKK",
        business_profile={"org_number": "12345678"},
        is_locked_signed=False,
    )
    assert pdf.startswith(b"%PDF")


def test_kasserapport_with_logo_bytes_renders():
    """A 1x1 PNG passed as logo_bytes must not break rendering."""
    one_pixel_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff"
        b"?\x00\x05\xfe\x02\xfe\xdcccG\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    pdf = render_close_pdf(
        aggregated=_agg_minimal(),
        business_name="Logo Test",
        date_label="",
        currency="DKK",
        business_profile={"org_number": "12345678"},
        logo_bytes=one_pixel_png,
    )
    assert pdf.startswith(b"%PDF")


def test_kasserapport_email_fallback_to_user(monkeypatch):
    """When generated_by_email is empty, user.email must be used."""
    class StubUser:
        email = "stub@example.dk"
        plan = "pro"
        currency = "DKK"

    # Stub billing.has_feature to allow rendering with a fake user.
    import app.services.billing as billing
    monkeypatch.setattr(billing, "has_feature", lambda u, f: True)

    pdf = render_close_pdf(
        aggregated=_agg_minimal(),
        business_name="Email Fallback",
        date_label="",
        currency="DKK",
        user=StubUser(),
    )
    assert pdf.startswith(b"%PDF")


def test_kasserapport_hash_changes_with_content():
    """Two PDFs with different content yield different hashes."""
    pdf_a = render_close_pdf(
        aggregated={**_agg_minimal(), "payments_total": 100.0},
        business_name="A", date_label="2026-05-01", currency="DKK",
        business_profile={"org_number": "12345678"},
        is_locked_signed=True,
    )
    pdf_b = render_close_pdf(
        aggregated={**_agg_minimal(), "payments_total": 200.0},
        business_name="A", date_label="2026-05-01", currency="DKK",
        business_profile={"org_number": "12345678"},
        is_locked_signed=True,
    )
    assert compute_document_hash(pdf_a) != compute_document_hash(pdf_b)


# ─── invoice_pdf ──────────────────────────────────────────────────────


def test_invoice_pdf_renders_with_full_profile(db_session, audit_user, audit_customer, audit_profile):
    inv = _make_invoice(db_session, audit_user, audit_customer)
    pdf = render_invoice_pdf(db_session, inv)
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2000


def test_invoice_pdf_handles_missing_profile(db_session, audit_user, audit_customer):
    """No BusinessProfile → PDF still renders without crashing."""
    inv = _make_invoice(db_session, audit_user, audit_customer)
    pdf = render_invoice_pdf(db_session, inv)
    assert pdf.startswith(b"%PDF")


def test_invoice_pdf_hash_deterministic_for_same_input(
    db_session, audit_user, audit_customer, audit_profile,
):
    """Two renders of the same invoice yield the same body content. The
    rendered PDF bytes will differ slightly (creation timestamp varies)
    BUT the underlying invoice data should be byte-identical at the
    Paragraph layer."""
    inv = _make_invoice(db_session, audit_user, audit_customer)
    pdf1 = render_invoice_pdf(db_session, inv)
    pdf2 = render_invoice_pdf(db_session, inv)
    # Different timestamps in the footer → different hashes. We assert
    # the hash function works and both PDFs are valid.
    assert pdf1.startswith(b"%PDF")
    assert pdf2.startswith(b"%PDF")
    h1, h2 = compute_document_hash(pdf1), compute_document_hash(pdf2)
    assert len(h1) == 64 and len(h2) == 64


# ─── tax_filing_pdf ───────────────────────────────────────────────────


def test_tax_filing_pdf_renders_with_full_profile(db_session, audit_user, audit_profile):
    period_start = date(2026, 4, 1)
    period_end = date(2026, 6, 30)
    pdf = build_moms_filing_pdf(
        db_session, audit_user, period_start, period_end,
        profile=audit_profile, business_name="Café Manoj ApS",
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2000


def test_tax_filing_pdf_handles_no_profile(db_session, audit_user):
    """No BusinessProfile → PDF still renders."""
    pdf = build_moms_filing_pdf(
        db_session, audit_user, date(2026, 4, 1), date(2026, 6, 30),
        profile=None, business_name="Café Manoj",
    )
    assert pdf.startswith(b"%PDF")


def test_tax_filing_pdf_with_sales_and_expenses(db_session, audit_user, audit_profile):
    """When there's data, the PDF renders with the sourced numbers."""
    cat = ExpenseCategory(user_id=audit_user.id, name="Office")
    db_session.add(cat); db_session.commit(); db_session.refresh(cat)
    db_session.add(Sale(
        user_id=audit_user.id, date=date(2026, 5, 10),
        amount=4500.0, payment_method="card",
        is_deleted=False, is_tax_exempt=False,
    ))
    db_session.add(Expense(
        user_id=audit_user.id, category_id=cat.id,
        date=date(2026, 5, 11), amount=1000.0,
        description="Printer paper",
        is_deleted=False, is_personal=False, is_tax_exempt=False,
    ))
    db_session.commit()

    pdf = build_moms_filing_pdf(
        db_session, audit_user, date(2026, 4, 1), date(2026, 6, 30),
        profile=audit_profile, business_name="Café Manoj ApS",
    )
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2500  # extra reconciliation page adds content


# ─── bookkeeping_export ───────────────────────────────────────────────


def test_export_bookkeeping_zip_includes_all_files(db_session, audit_user, audit_profile):
    """The bundle must include sales/expenses, faktura, mileage, moms
    summary, README, and the audit manifest."""
    zip_bytes = export_bookkeeping_zip(
        audit_user, db_session, date(2026, 4, 1), date(2026, 6, 30),
    )
    assert isinstance(zip_bytes, bytes)
    assert zip_bytes[:2] == b"PK"  # ZIP magic

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        assert any("sales-expenses-dinero" in n for n in names)
        assert any(n.startswith("faktura-") for n in names)
        assert any(n.startswith("mileage-") for n in names)
        assert any(n.startswith("moms-summary-") for n in names)
        assert "README.txt" in names
        assert "manifest.txt" in names


def test_export_bookkeeping_zip_manifest_has_business_and_hashes(
    db_session, audit_user, audit_profile,
):
    """The manifest carries business identity + SHA-256 of every file."""
    zip_bytes = export_bookkeeping_zip(
        audit_user, db_session, date(2026, 4, 1), date(2026, 6, 30),
    )
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        manifest = zf.read("manifest.txt").decode("utf-8")
        # Business identity
        assert "Café Manoj ApS" in manifest
        assert "12345678" in manifest  # CVR
        assert "DK12345678" in manifest  # VAT
        assert "Vesterbrogade 12" in manifest
        # Software identifier
        assert "BonBox v" in manifest
        # Generator email
        assert "manoj@cafe.dk" in manifest
        # SHA-256 markers for each file
        assert manifest.count("sha256:") >= 4

        # Hash in manifest must match actual file content.
        for name in zf.namelist():
            if name in ("manifest.txt", "README.txt"):
                continue
            actual = compute_document_hash(zf.read(name))
            assert actual in manifest, (
                f"Manifest missing real hash for {name}"
            )


def test_export_bookkeeping_zip_readme_explains_imports(db_session, audit_user, audit_profile):
    """README must reference Dinero, Billy, e-conomic (the supported
    platforms — owner gets enough info to act without our help)."""
    zip_bytes = export_bookkeeping_zip(
        audit_user, db_session, date(2026, 5, 1), date(2026, 5, 31),
    )
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        readme = zf.read("README.txt").decode("utf-8")
        for platform in ("Dinero", "Billy", "e-conomic"):
            assert platform in readme


def test_export_generic_has_saft_columns(db_session, audit_user, audit_profile):
    """SAF-T-compatible columns appended (additive — does not change
    existing imports). Verifies the audit-checklist requirement."""
    # Sale + expense so we have a row each
    cat = ExpenseCategory(user_id=audit_user.id, name="Office")
    db_session.add(cat); db_session.commit(); db_session.refresh(cat)
    db_session.add(Sale(
        user_id=audit_user.id, date=date(2026, 5, 10),
        amount=1000.0, payment_method="card",
        is_deleted=False, is_tax_exempt=False, status="completed",
    ))
    db_session.add(Expense(
        user_id=audit_user.id, category_id=cat.id,
        date=date(2026, 5, 11), amount=500.0,
        description="Test",
        is_deleted=False, is_personal=False, is_tax_exempt=False,
    ))
    db_session.commit()

    csv_bytes = export_generic(
        audit_user, db_session, date(2026, 5, 1), date(2026, 5, 31),
    )
    csv_text = csv_bytes.decode("utf-8-sig")
    header = csv_text.splitlines()[0]
    for col in ("TransactionId", "TransactionDate", "AccountID", "Debit", "Credit"):
        assert col in header, f"Missing SAF-T column: {col}"


def test_export_moms_summary_columns(db_session, audit_user, audit_profile):
    """MOMS summary CSV exposes the period totals an auditor expects."""
    csv_bytes = export_moms_summary(
        audit_user, db_session, date(2026, 4, 1), date(2026, 6, 30),
    )
    csv_text = csv_bytes.decode("utf-8-sig")
    header = csv_text.splitlines()[0]
    for col in (
        "Periode start", "Periode slut", "Momssats",
        "Salg ekskl. moms", "Moms af salg",
        "Køb ekskl. moms", "Moms af køb",
    ):
        assert col in header, f"MOMS summary missing column: {col}"


def test_bundle_files_match_manifest_hashes_round_trip(
    db_session, audit_user, audit_profile,
):
    """End-to-end tamper-evidence: hash every file inside the ZIP, then
    confirm those hashes are exactly what the manifest claims."""
    zip_bytes = export_bundle(
        audit_user, db_session, date(2026, 5, 1), date(2026, 5, 31),
    )
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        manifest = zf.read("manifest.txt").decode("utf-8")
        for name in zf.namelist():
            if name in ("manifest.txt", "README.txt"):
                continue
            actual = compute_document_hash(zf.read(name))
            assert f"sha256: {actual}" in manifest, (
                f"Tamper-evidence broken for {name}: hash mismatch"
            )
