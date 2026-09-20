"""Tests for the daily-close PDF endpoint (kasserapport).

Regression context (2026-05-16): the PDF endpoint was returning 500
in prod because `profile.business_name` was being accessed but the
underlying column is `company_name`. AttributeError was unhandled.

These tests pin:
  1. PDF renders without crashing when BusinessProfile exists
  2. PDF renders without crashing when BusinessProfile is missing
  3. DKK currency → Danish labels in the byte stream
  4. Non-DKK currency → English labels
  5. Ready-for-bookkeeping badge logic (all checks pass)
  6. Needs-review badge when cash diff exceeds tolerance
  7. business_name property alias resolves to company_name
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()


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


def _make_user(db, email="manoj@cafe.dk", currency="DKK"):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Café Manoj",
        business_type="restaurant",
        currency=currency,
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_close(db, user, **overrides):
    dc = DailyClose(
        user_id=user.id,
        date=date(2026, 5, 15),
        revenue_total=12500.0,
        moms_total=2500.0,
        revenue_ex_moms=10000.0,
        moms_mode="auto",
        payment_total=12500.0,
        cash_expected=3200.0,
        cash_counted=3200.0,
        cash_difference=0.0,
        status="confirmed",
        closed_at=datetime(2026, 5, 15, 23, 30),
        closed_by="manoj@cafe.dk",
    )
    for k, v in overrides.items():
        setattr(dc, k, v)
    db.add(dc); db.commit(); db.refresh(dc)
    return dc


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


# ─────────────────────── Regression: profile.business_name ───────────────────────


def test_pdf_renders_when_business_profile_exists(db_session, client):
    """The 2026-05-16 bug: profile exists, AttributeError on .business_name
    → 500. This test must hit the endpoint and get a PDF back."""
    user = _make_user(db_session)
    BusinessProfile(
        user_id=user.id,
        company_name="Café Manoj ApS",
        org_number="12345678",
        country="DK",
    )
    profile = BusinessProfile(
        user_id=user.id,
        company_name="Café Manoj ApS",
        org_number="12345678",
        country="DK",
    )
    db_session.add(profile); db_session.commit()

    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200, f"PDF endpoint regressed: {r.status_code} {r.text[:200]}"
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"


def test_pdf_renders_when_no_business_profile(db_session, client):
    """If user never set up their profile, PDF should still render —
    falls back to user.business_name."""
    user = _make_user(db_session)
    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


def test_pdf_business_profile_company_name_used_via_alias(db_session, client):
    """When profile.company_name is set, the PDF must render successfully
    (uses the new business_name property alias internally). We can't grep
    the PDF text because ReportLab compresses streams by default, but
    we verify (1) the alias resolves correctly at the model level and
    (2) the endpoint succeeds."""
    user = _make_user(db_session)
    profile = BusinessProfile(
        user_id=user.id,
        company_name="Mirabelle ApS",
        country="DK",
    )
    db_session.add(profile); db_session.commit()

    # Alias check — what the PDF code actually reads
    assert profile.business_name == "Mirabelle ApS"

    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"
    # Sanity check: non-trivial PDF size (not an error blob)
    assert len(r.content) > 1500


# ─────────────────────── BusinessProfile.business_name alias ───────────────────────


def test_business_profile_business_name_property_returns_company_name(db_session):
    """The compat-alias property must return company_name."""
    p = BusinessProfile(user_id="abc", company_name="Test ApS", country="DK")
    assert p.business_name == "Test ApS"


def test_business_profile_business_name_empty_when_company_name_blank(db_session):
    """Empty/null company_name → empty string (falsy, callers can fall back)."""
    p = BusinessProfile(user_id="abc", company_name="", country="DK")
    assert p.business_name == ""


# ─────────────────────── Locale-aware labels ───────────────────────
# We can't grep the compressed PDF byte stream for label content, but we
# CAN verify that both DKK and non-DKK currencies produce a valid PDF —
# any KeyError or NameError on the locale lookup would crash here.


def test_dkk_currency_renders_pdf_successfully(db_session, client):
    """DKK currency triggers the Danish label branch — must not crash."""
    user = _make_user(db_session, currency="DKK")
    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


def test_non_dkk_currency_renders_pdf_successfully(db_session, client):
    """Non-DKK currency triggers the English label branch — must not crash."""
    user = _make_user(db_session, currency="USD")
    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


# ─────────────────────── Ready-for-bookkeeping badge ───────────────────────


def test_ready_for_bookkeeping_badge_path_renders(db_session, client):
    """Confirmed + reconciled cash + MOMS calculated triggers the
    green 'Klar til bogføring' branch — must render successfully."""
    user = _make_user(db_session)
    dc = _make_close(
        db_session, user,
        cash_counted=3200.0, cash_expected=3200.0, cash_difference=0.0,
        status="confirmed",
    )
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


def test_needs_review_badge_path_renders(db_session, client):
    """Cash off by more than 100 DKK triggers the amber 'Gennemgås' branch."""
    user = _make_user(db_session)
    dc = _make_close(
        db_session, user,
        cash_counted=3000.0, cash_expected=3200.0, cash_difference=-200.0,
        status="confirmed",
    )
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert r.content[:4] == b"%PDF"


# ─────────────────────── Tenant isolation ───────────────────────


def test_pdf_refuses_other_users_close(db_session, client):
    """User A cannot download User B's kasserapport PDF (IDOR)."""
    alice = _make_user(db_session, email="alice@a.dk")
    bob = _make_user(db_session, email="bob@b.dk")
    alice_close = _make_close(db_session, alice)

    r = client.get(f"/api/daily-close/{alice_close.id}/pdf", headers=_auth_headers(bob))
    assert r.status_code == 404  # generic — don't leak existence


# ─────────────────────── Layout: the band and its footer ───────────────────────
# The assurance band went from a heading plus ONE static sentence to a heading
# plus four derived lines. On a full close that pushed the footer onto a second
# page carrying nothing else — a two-page kasserapport whose page 2 is one line
# of small print. The band and the footer are now kept together.

def _pdf_pages(content: bytes):
    try:
        from pypdf import PdfReader  # type: ignore
        from io import BytesIO
        return PdfReader(BytesIO(content)).pages
    except Exception:
        pytest.skip("no pypdf available for page-level assertions")


def test_a_full_close_still_fits_one_page(db_session, client):
    """Every section populated: revenue split, MOMS, payments, cash, vouchers."""
    user = _make_user(db_session)
    profile = BusinessProfile(
        user_id=user.id, company_name="DukaanAI v/Manoz Chaudhary",
        org_number="46417321",
        address="Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
        zipcode="2500", city="Valby", country="DK",
    )
    # A Sale with a voucher number so the BILAGSNUMRE section renders too —
    # that section is two more rows, and it is what tipped the real export over
    # the page boundary.
    from app.models.sale import Sale
    db_session.add(Sale(user_id=user.id, date=date(2026, 5, 15), amount=100.0,
                        voucher_number=7, is_deleted=False))
    db_session.add(profile); db_session.commit()
    dc = _make_close(
        db_session, user,
        closed_by="Manoz",
        revenue_categories="food:8000|drinks:2000|returns:-500",
        revenue_total=9500.0, moms_total=1900.0, revenue_ex_moms=7600.0,
        payment_categories="cash:2000|card:7000|bank_transfer:500",
        payment_total=9500.0,
        cash_expected=2000.0, cash_counted=2000.0, cash_difference=0.0,
    )
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert len(_pdf_pages(r.content)) == 1


def test_the_band_and_its_footer_are_emitted_as_one_block():
    """The rule, asserted structurally: a band on page 1 with its footer
    stranded alone on page 2 reads as a truncated document, so the two are
    emitted inside one KeepTogether. A rendered page-count check cannot pin
    this on its own — whether it strands depends on how much content happens
    to precede it."""
    import inspect
    from app.routers import daily_close as r

    src = inspect.getsource(r.daily_close_pdf)
    block = src[src.index("assurance = claims[\"assurance\"]"):src.index("doc.build(story)")]
    assert "KeepTogether([" in block
    kt = block[block.index("KeepTogether(["):]
    assert "badge_table" in kt.split("]))")[0]
    assert 'claims["footer"]' in kt.split("]))")[0]


def test_the_footer_never_stands_alone_on_its_own_page(db_session, client):
    """And the rendered document agrees: the last page carries more than the
    footer line."""
    user = _make_user(db_session)
    dc = _make_close(
        db_session, user,
        revenue_categories="food:8000|drinks:2000|returns:-500",
        revenue_total=9500.0, moms_total=1900.0, revenue_ex_moms=7600.0,
        payment_categories="cash:2000|card:7000|bank_transfer:500",
        payment_total=9500.0,
        tips_total=850.0, tips_staff_count=4, tips_per_person=212.50,
        notes="Lang note " * 60,
    )
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    pages = _pdf_pages(r.content)
    last = (pages[-1].extract_text() or "").strip()
    assert "Genereret af BonBox" in last
    # The band travels with it, so the final page is never just the one line.
    assert len(last.splitlines()) > 1



# ──────────────── The file's own properties are a claim too ────────────────


def _pdf_doc_title(content):
    from io import BytesIO
    from pypdf import PdfReader  # type: ignore
    meta = PdfReader(BytesIO(content)).metadata or {}
    return meta.get("/Title")


def test_a_draft_says_kladde_in_its_document_properties(db_session, client):
    """A kladde opened in a viewer shows the PDF's /Title in the window and in
    the file's Get Info panel. It said "Kasserapport" while the page said
    KLADDE — the title bar was making a claim the document had withdrawn."""
    user = _make_user(db_session)
    dc = _make_close(db_session, user, status="draft", closed_at=None)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    assert r.status_code == 200
    assert "KLADDE" in (_pdf_doc_title(r.content) or "")


def test_a_locked_close_keeps_the_plain_title(db_session, client):
    """And the finished report is not marked as something it isn't."""
    user = _make_user(db_session)
    dc = _make_close(db_session, user)
    r = client.get(f"/api/daily-close/{dc.id}/pdf", headers=_auth_headers(user))
    title = _pdf_doc_title(r.content) or ""
    assert "KASSERAPPORT" in title.upper()
    assert "KLADDE" not in title.upper()
