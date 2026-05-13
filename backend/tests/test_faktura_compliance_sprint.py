"""
End-to-end integration test for the Faktura Compliance + Safety Sprint
(Days 1-6 of the build).

Covers:
  1. State machine: draft → sent → paid → unmark → sent (with audit entries
     at every step).
  2. Auto-match HIGH confidence: customer name in bank text auto-flips
     invoice to paid + links Sale.invoice_id + writes audit.
  3. Auto-match MEDIUM confidence: amount matches but no text signal —
     creates suggestion, invoice stays 'sent'.
  4. Auto-match LOW confidence: multiple amount candidates — creates one
     suggestion per candidate, invoice unchanged.
  5. Owner accepts a MEDIUM suggestion → mark_paid wrapper runs, sibling
     suggestions auto-reject.
  6. Tax Autopilot dedup: bank-matched Sale must NOT double-count when
     the invoice is also in the revenue stream.
  7. Logo upload security: SVG/GIF rejected, palette validates, position
     enum validates.
  8. Retention sweep: ancient drafts hard-deleted, paid invoices
     preserved, suggestion garbage-collected after resolution+1y.

Run: cd backend && pytest tests/test_faktura_compliance_sprint.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.models.sale import Sale
from app.models.user import User
from app.services import payment_match_service
from app.services.invoice_service import InvoiceService
from app.services.logo_service import (
    ACCENT_COLOR_PALETTE,
    validate_accent_color,
    validate_logo_position,
)


# ─── Fixtures ────────────────────────────────────────────────────


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def user(db):
    u = User(
        email="owner@bonbox.test",
        password_hash="x",
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def other_user(db):
    """Second tenant to prove cross-tenant isolation."""
    u = User(
        email="evil@bonbox.test",
        password_hash="x",
        business_name="Evil Cafe",
        business_type="cafe",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def customer(db, user):
    c = Customer(
        user_id=user.id,
        name="Lyngby Storkunde ApS",
        is_company=True,
        email="finance@lyngby.test",
        country="DK",
        payment_terms_days=14,
        default_lang="da",
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _make_invoice(db, user, customer, total_kr: Decimal = Decimal("1250.00")) -> Invoice:
    """Helper: create a draft + send it so we have a status='sent' faktura."""
    # Line totals: net + 25% moms = total_kr
    net = (total_kr / Decimal("1.25")).quantize(Decimal("0.01"))
    inv = InvoiceService.create_draft(
        db, user, customer.id,
        lines=[{
            "description": "Konsulentydelse maj",
            "quantity": Decimal("1"),
            "unit_price_net": net,
            "moms_rate": Decimal("0.250"),
        }],
    )
    InvoiceService.mark_sent(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    return inv


def _make_bank_sale(
    db, user, amount: Decimal, notes: str, sale_date: date | None = None,
) -> Sale:
    s = Sale(
        user_id=user.id,
        date=sale_date or date.today(),
        amount=amount,
        payment_method="bank_transfer",
        notes=notes,
        order_channel="dine_in",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


# ─── Test 1: state machine + audit ───────────────────────────────


def test_state_machine_and_audit_trail(db, user, customer):
    """draft → sent → paid → unmark → sent, audit log at every step."""
    inv = InvoiceService.create_draft(
        db, user, customer.id,
        lines=[{
            "description": "Konsulentydelse",
            "quantity": Decimal("1"),
            "unit_price_net": Decimal("1000.00"),
            "moms_rate": Decimal("0.250"),
        }],
    )
    db.commit()
    assert inv.status == "draft"
    assert inv.locked is False

    InvoiceService.mark_sent(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    assert inv.status == "sent"
    assert inv.locked is True
    assert inv.sent_at is not None

    # Can't double-send
    with pytest.raises(Exception):
        InvoiceService.mark_sent(db, user, inv.id, ip_address="10.0.0.1")

    InvoiceService.mark_paid(
        db, user, inv.id, Decimal("1250.00"),
        source="manual", ip_address="10.0.0.1",
    )
    db.commit()
    db.refresh(inv)
    assert inv.status == "paid"
    assert inv.paid_via == "manual"
    assert inv.auto_match_reversible is False  # manual not flagged

    # Manual marks are always reversible
    InvoiceService.unmark_paid(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    assert inv.status in ("sent", "overdue")
    assert inv.paid_at is None
    assert inv.paid_via is None

    # Audit trail
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.entity_type == "invoice", AuditLog.entity_id == inv.id)
        .order_by(AuditLog.created_at.asc())
        .all()
    )
    actions = [r.action for r in rows]
    assert "invoice.send" in actions
    assert "invoice.mark_paid" in actions
    assert "invoice.unmark_paid" in actions
    # Every entry must carry IP for production traceability
    for r in rows:
        assert r.ip_address == "10.0.0.1", f"audit row {r.action} missing IP"
        assert r.user_id == user.id


def test_paid_reference_pii_sanitization(db, user, customer):
    """Bank tx descriptions can carry PII (payer name, account fragment,
    free-text memo). When persisted onto Invoice.paid_reference we must
    truncate to 80 chars + drop control characters. The raw text stays
    on Sale.notes for bank-import audit trail; the Invoice copy is
    sanitized for GDPR data-minimization."""
    from app.services.invoice_service import _sanitize_paid_reference

    # Truncation
    long_text = "OVF FRA " + ("X" * 200)
    out = _sanitize_paid_reference(long_text)
    assert out is not None
    assert len(out) <= 80
    assert out.endswith("…")

    # Control chars dropped (log-injection defense)
    out = _sanitize_paid_reference("OVF\x00\x07\x1bDROP TABLE invoices\nNORMAL")
    assert out is not None
    assert "\x00" not in out
    assert "\x07" not in out
    assert "\x1b" not in out
    # Newline (a control char) gets dropped too, then whitespace collapsed
    assert "  " not in out

    # Empty / None passthrough
    assert _sanitize_paid_reference(None) is None
    assert _sanitize_paid_reference("") is None
    assert _sanitize_paid_reference("   ") is None

    # End-to-end: mark_paid stores the sanitized version
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))
    InvoiceService.mark_paid(
        db, user, inv.id, Decimal("1250.00"),
        source="manual",
        paid_reference="OVF FRA " + ("X" * 200),
    )
    db.commit()
    db.refresh(inv)
    assert inv.paid_reference is not None
    assert len(inv.paid_reference) <= 80


def test_idempotent_mark_paid(db, user, customer):
    """Re-marking already-paid invoice from any source is a no-op (no
    double audit entries)."""
    inv = _make_invoice(db, user, customer)
    InvoiceService.mark_paid(db, user, inv.id, Decimal("1250.00"), source="manual")
    db.commit()
    InvoiceService.mark_paid(db, user, inv.id, Decimal("1250.00"), source="manual")
    db.commit()

    n_paid_audits = (
        db.query(AuditLog)
        .filter(
            AuditLog.entity_id == inv.id,
            AuditLog.action == "invoice.mark_paid",
        )
        .count()
    )
    assert n_paid_audits == 1, "Idempotent mark_paid must not double-audit"


# ─── Test 2: HIGH-confidence auto-match ──────────────────────────


def test_high_confidence_automatch(db, user, customer):
    """Bank deposit + matching amount + customer name in description →
    auto-flip to paid, Sale.invoice_id linked, audit written, no
    suggestion row."""
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))

    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE APS REF 2026-001",
    )

    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    db.refresh(inv)
    db.refresh(sale)

    assert inv.status == "paid"
    assert inv.paid_via == "auto_match"
    assert inv.auto_match_reversible is True
    assert sale.invoice_id == inv.id

    # No suggestion row created (auto-flipped, not suggested)
    n_sugg = db.query(PaymentMatchSuggestion).count()
    assert n_sugg == 0


def test_diacritic_normalization_match(db, user):
    """'Café Lyngby' on faktura should match 'CAFE LYNGBY' on bank line.
    Danish banks strip diacritics — without NFKD normalization we'd
    miss legitimate auto-matches for any business with æøå/é/è."""
    cust = Customer(
        user_id=user.id, name="Café Lyngby Test", is_company=True,
        country="DK", payment_terms_days=14, default_lang="da",
    )
    db.add(cust)
    db.commit()
    db.refresh(cust)

    inv = _make_invoice(db, user, cust, Decimal("500.00"))
    sale = _make_bank_sale(
        db, user, Decimal("500.00"),
        notes="PAYMENT FROM CAFE LYNGBY TEST",
    )

    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    db.refresh(inv)
    assert inv.status == "paid", "Diacritic-stripped match should auto-flip"


def test_auto_match_undo_within_window(db, user, customer):
    """Auto-match is reversible within 7 days. Manual marks always
    reversible."""
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))
    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF LYNGBY STORKUNDE",
    )
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()

    # Within window — undo works
    InvoiceService.unmark_paid(db, user, inv.id, ip_address="10.0.0.1")
    db.commit()
    db.refresh(inv)
    assert inv.status in ("sent", "overdue")

    # Detached the sale linkage too — critical for revenue dedup
    db.refresh(sale)
    assert sale.invoice_id is None


# ─── Test 3: MEDIUM-confidence suggestion ────────────────────────


def test_medium_confidence_suggestion(db, user, customer):
    """Amount matches, NO text signal → MEDIUM suggestion created,
    invoice untouched."""
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))

    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF REF UNKNOWN PARTY",
    )
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    db.refresh(inv)

    assert inv.status == "sent", "Invoice should NOT auto-flip without text signal"
    sugg = (
        db.query(PaymentMatchSuggestion)
        .filter(PaymentMatchSuggestion.invoice_id == inv.id)
        .first()
    )
    assert sugg is not None
    assert sugg.confidence == "medium"
    assert sugg.status == "pending"


def test_accept_suggestion_rejects_siblings(db, user, customer):
    """Accepting a suggestion runs mark_paid AND auto-rejects all other
    pending suggestions for the same Sale — only one invoice can be
    paid by one bank line."""
    inv1 = _make_invoice(db, user, customer, Decimal("1250.00"))
    inv2 = _make_invoice(db, user, customer, Decimal("1250.00"))

    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF REF UNKNOWN",
    )
    # try_match: 2 candidates @ same amount → LOW confidence x2
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    suggs = (
        db.query(PaymentMatchSuggestion)
        .filter(PaymentMatchSuggestion.sale_id == sale.id)
        .all()
    )
    assert len(suggs) == 2
    assert all(s.confidence == "low" for s in suggs)

    # Owner accepts the first one
    target = suggs[0]
    payment_match_service.accept_suggestion(
        db, user.id, target.id, ip_address="10.0.0.1",
    )
    db.commit()

    db.refresh(target)
    sibling = next(s for s in suggs if s.id != target.id)
    db.refresh(sibling)
    assert target.status == "accepted"
    assert sibling.status == "rejected"


# ─── Test 4: Tax Autopilot dedup ─────────────────────────────────


def test_tax_autopilot_dedup_bank_matched_sale(db, user, customer):
    """A Sale.invoice_id != NULL must be EXCLUDED from POS revenue so
    we don't double-count: once as a cash sale, again as an invoice
    payment. This was the bug Day 5 fixed."""
    from app.services.tax_service import _calc_vat

    _make_invoice(db, user, customer, Decimal("1250.00"))

    # Bank deposit gets linked to invoice (HIGH-confidence auto-match path)
    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF FRA LYNGBY STORKUNDE",
    )
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()

    today = date.today()
    period_start = today.replace(day=1) - timedelta(days=60)
    # End date is exclusive in _calc_vat — include today
    period_end = today + timedelta(days=1)

    result = _calc_vat(
        db, user.id, period_start, period_end,
        vat_rate=0.25, prices_include_moms=True,
    )
    pos_rev = Decimal(str(result.get("pos_revenue", 0)))
    invoice_rev = Decimal(str(result.get("invoice_revenue", 0)))
    # The matched Sale must NOT show up as POS revenue (invoice_id is set)
    assert pos_rev == Decimal("0"), (
        f"POS revenue should be 0 (sale linked to invoice), got {pos_rev}"
    )
    # The invoice IS the revenue
    assert invoice_rev > 0, "Invoice revenue must be positive"


def test_tax_autopilot_unlinked_sale_still_counts(db, user, customer):
    """A regular POS Sale (no invoice_id) must still contribute to
    pos_revenue — only invoice-linked Sales are excluded."""
    from app.services.tax_service import _calc_vat

    # A pure cash sale, no faktura involvement
    _make_bank_sale(db, user, Decimal("500.00"), notes="WALK-IN")
    db.commit()

    today = date.today()
    period_start = today.replace(day=1) - timedelta(days=60)
    period_end = today + timedelta(days=1)
    result = _calc_vat(
        db, user.id, period_start, period_end,
        vat_rate=0.25, prices_include_moms=True,
    )
    assert Decimal(str(result["pos_revenue"])) >= Decimal("500.00")


# ─── Test 5: Logo + brand validation ─────────────────────────────


def test_logo_palette_has_six_colors():
    """6-color preset palette — security/consistency constraint."""
    assert len(ACCENT_COLOR_PALETTE) == 6
    for name, hex_code in ACCENT_COLOR_PALETTE.items():
        assert hex_code.startswith("#")
        assert len(hex_code) == 7


def test_accent_color_validator_rejects_arbitrary_hex():
    """Only the 6 preset hex codes are valid. Arbitrary user-supplied
    hex (e.g. '#FF00FF') must be rejected — keeps brand recognizable
    across the user's invoices."""
    # Whitelist allows palette hex
    assert validate_accent_color("#10B981") == "#10B981"
    # Whitelist allows palette name → canonicalized hex
    assert validate_accent_color("emerald") == "#10B981"
    # Empty string is a 'cleared field' signal, not an attack — returns None
    assert validate_accent_color("") is None
    assert validate_accent_color(None) is None
    # Arbitrary hex must be rejected
    with pytest.raises(Exception):
        validate_accent_color("#FF00FF")
    # XSS-style payloads must be rejected
    with pytest.raises(Exception):
        validate_accent_color("javascript:alert(1)")
    # SQL-injection-style payloads must be rejected
    with pytest.raises(Exception):
        validate_accent_color("'; DROP TABLE business_profiles; --")


def test_logo_position_validator():
    assert validate_logo_position("left") == "left"
    assert validate_logo_position("center") == "center"
    with pytest.raises(Exception):
        validate_logo_position("right")
    with pytest.raises(Exception):
        validate_logo_position("../../etc/passwd")


def test_logo_service_rejects_svg_and_gif():
    """SVG can carry inline JS (XSS) — must be rejected at magic-byte
    check. GIF is allowed by PIL but rejected by our magic-byte
    allowlist (PNG/JPEG only)."""
    from app.services import logo_service

    svg_bytes = b"<svg onload=alert(1)></svg>"
    with pytest.raises(Exception):
        logo_service.upload_logo(uuid.uuid4(), svg_bytes)

    gif_bytes = b"GIF89a" + b"\x00" * 100
    with pytest.raises(Exception):
        logo_service.upload_logo(uuid.uuid4(), gif_bytes)

    empty = b""
    with pytest.raises(Exception):
        logo_service.upload_logo(uuid.uuid4(), empty)


# ─── Test 6: Retention sweep ─────────────────────────────────────


def test_retention_sweep_purges_ancient_drafts(db, user, customer):
    """Drafts older than data_retention_years should be hard-deleted.
    Paid/sent invoices stay (Bogføringsloven §12 — they ARE the books)."""
    from app.services.accounting_retention import run_retention_sweep_for_user

    # Give user a profile with 5y retention
    profile = BusinessProfile(
        user_id=user.id,
        data_retention_years=5,
    )
    db.add(profile)
    db.commit()

    # Ancient draft (7 years old) — should be purged
    ancient_draft = Invoice(
        user_id=user.id,
        customer_id=customer.id,
        fakturanummer=999001,
        issue_date=date.today() - timedelta(days=7 * 366),
        due_date=date.today() - timedelta(days=7 * 366 - 14),
        status="draft",
        subtotal_net=Decimal("100.00"),
        moms_total=Decimal("25.00"),
        total_gross=Decimal("125.00"),
        currency="DKK",
        customer_lang="da",
    )
    # Ancient paid invoice — must stay (it's accounting record)
    ancient_paid = Invoice(
        user_id=user.id,
        customer_id=customer.id,
        fakturanummer=999002,
        issue_date=date.today() - timedelta(days=7 * 366),
        due_date=date.today() - timedelta(days=7 * 366 - 14),
        status="paid",
        paid_at=datetime.now(timezone.utc) - timedelta(days=7 * 366),
        paid_amount=Decimal("125.00"),
        paid_via="manual",
        subtotal_net=Decimal("100.00"),
        moms_total=Decimal("25.00"),
        total_gross=Decimal("125.00"),
        currency="DKK",
        customer_lang="da",
    )
    db.add_all([ancient_draft, ancient_paid])
    db.commit()
    draft_id = ancient_draft.id
    paid_id = ancient_paid.id

    counts = run_retention_sweep_for_user(db, user)
    db.commit()

    assert counts["invoices_drafts_purged"] == 1
    assert db.query(Invoice).filter(Invoice.id == draft_id).first() is None
    assert db.query(Invoice).filter(Invoice.id == paid_id).first() is not None


def test_retention_sweep_clamps_to_legal_min(db, user):
    """User can't set retention < 5y (Bogføringsloven §12 floor) or
    > 10y (Skatteforvaltningsloven §31 ceiling). The clamp protects
    the user from accidentally (or maliciously) self-shooting."""
    from app.services.accounting_retention import _user_retention_years

    profile = BusinessProfile(user_id=user.id, data_retention_years=1)
    assert _user_retention_years(profile) == 5  # clamped up

    profile.data_retention_years = 99
    assert _user_retention_years(profile) == 10  # clamped down

    profile.data_retention_years = 7
    assert _user_retention_years(profile) == 7  # passthrough

    assert _user_retention_years(None) == 6  # default


# ─── Test 7: Tenant isolation ────────────────────────────────────


def test_cross_tenant_unmark_paid_rejected(db, user, other_user, customer):
    """Other_user must NOT be able to unmark paid one of user's
    invoices via spoofed invoice_id."""
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))
    InvoiceService.mark_paid(db, user, inv.id, Decimal("1250.00"), source="manual")
    db.commit()

    with pytest.raises(Exception):
        InvoiceService.unmark_paid(db, other_user, inv.id, ip_address="10.0.0.2")


def test_cross_tenant_accept_suggestion_rejected(db, user, other_user, customer):
    """Other_user must NOT be able to accept user's payment suggestion."""
    inv = _make_invoice(db, user, customer, Decimal("1250.00"))
    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF UNKNOWN",
    )
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    sugg = db.query(PaymentMatchSuggestion).first()
    assert sugg is not None

    with pytest.raises(Exception):
        payment_match_service.accept_suggestion(
            db, other_user.id, sugg.id, ip_address="10.0.0.2",
        )


# ─── Test 8: Tier gating — Pro must have everything in the sprint ──


def test_white_label_pdf_gate_per_tier(db, user):
    """Pro tier has white_label_pdf=True → invoice PDF must omit the
    'bonbox.dk' footer. Starter / Free see the attribution.

    Without this, paying customers (Pro) still get BonBox-branded
    invoices going out to their own customers, which is the exact thing
    they paid extra to avoid.

    Tests the gate function directly (PDF bytes are flate-compressed so
    grepping the rendered output is brittle)."""
    from app.services.invoice_pdf import _is_white_label

    user.plan = "free"
    db.commit()
    assert _is_white_label(user) is False, "Free must NOT be white-label"

    user.plan = "starter"
    db.commit()
    assert _is_white_label(user) is False, "Starter must NOT be white-label"

    user.plan = "pro"
    db.commit()
    assert _is_white_label(user) is True, "Pro MUST be white-label"

    # None defaults to non-white-label (safer to keep attribution than
    # silently strip on missing-user paths)
    assert _is_white_label(None) is False


def test_white_label_pdf_produces_smaller_output_for_pro(db, user, customer):
    """Quick end-to-end smoke: Pro-rendered invoice should be smaller
    than Free-rendered (one fewer Paragraph + Spacer). Doesn't depend
    on text extraction, but proves the gate actually changes output."""
    from app.services.invoice_pdf import render_invoice_pdf

    inv = _make_invoice(db, user, customer, Decimal("1250.00"))

    user.plan = "free"
    db.commit()
    pdf_free = render_invoice_pdf(db, inv)

    user.plan = "pro"
    db.commit()
    pdf_pro = render_invoice_pdf(db, inv)

    # Pro PDF removes one Paragraph flowable + its content. Should be
    # smaller — even with PDF metadata overhead, the difference is
    # detectable (typically 30-200 bytes).
    assert len(pdf_pro) < len(pdf_free), (
        f"Pro PDF ({len(pdf_pro)} bytes) should be smaller than "
        f"Free ({len(pdf_free)} bytes) — footer attribution stripped"
    )


def test_pro_has_every_sprint_feature_flag():
    """Locks the entitlements contract: every feature flag this sprint
    relies on must be True on Pro. If a future PLAN_FEATURES refactor
    flips one to False, this test fails loudly."""
    from app.services.billing import PLAN_FEATURES

    sprint_pro_features = [
        "white_label_pdf",       # clean invoice PDF
        "ai_anomaly_detection",  # used by Tax Autopilot dedup signals
        "custom_export_templates",  # revisor CSV bundles incl. faktura
        "ai_predictive_staffing",   # smart_drift hooks faktura revenue
        "advanced_benchmarks",
        "multi_branch_dashboard",
    ]
    for f in sprint_pro_features:
        assert PLAN_FEATURES["pro"].get(f) is True, (
            f"Pro must have {f}=True (sprint feature contract)"
        )
        # Trial inherits Pro
        assert PLAN_FEATURES["trial"].get(f) is True, (
            f"Trial must have {f}=True (mirrors Pro)"
        )


def test_starter_can_use_invoicing_features():
    """Sanity check — Starter tier is the entry to invoicing. They must
    have access to mark_paid, brand customization, payment suggestions.
    Free is excluded. Verifies _require_invoicing_plan's whitelist."""
    from app.routers.customers import _STARTER_AND_ABOVE
    assert "starter" in _STARTER_AND_ABOVE
    assert "pro" in _STARTER_AND_ABOVE
    assert "trial" in _STARTER_AND_ABOVE
    assert "free" not in _STARTER_AND_ABOVE


# ─── Test 9: MobilePay QR deep-link ──────────────────────────────


def test_mobilepay_deep_link_payload():
    """Verify the MobilePay deep-link URL has the right shape — phone
    digits only, amount with 2 decimals, comment URL-encoded."""
    from app.services.invoice_pdf import _build_mobilepay_qr_payload

    out = _build_mobilepay_qr_payload(
        mobilepay_number="+45 12 34 56 78",
        amount=Decimal("1250.00"),
        faktura_ref="Faktura 2026-0042",
    )
    # Phone normalized (digits only, no '+' or spaces)
    assert "phone=4512345678" in out
    # Amount has 2 decimals
    assert "amount=1250.00" in out
    # Comment URL-encoded (space → '+', preserves faktura tracking)
    assert "comment=Faktura+2026-0042" in out
    # Scheme correct
    assert out.startswith("mobilepay://send?")


def test_mobilepay_qr_flowable_renders_for_valid_invoice():
    """Returns an RLImage flowable for the happy path."""
    from app.services.invoice_pdf import _make_mobilepay_qr_flowable

    flow = _make_mobilepay_qr_flowable("12345678", Decimal("100.00"), "2026-0001")
    assert flow is not None


def test_invoice_pdf_renders_with_and_without_mobilepay(db, user, customer):
    """End-to-end: PDF builds successfully both with and without
    MobilePay configured. No crashes from the QR integration path."""
    from app.models.business_profile import BusinessProfile
    from app.services.invoice_pdf import render_invoice_pdf

    profile = BusinessProfile(
        user_id=user.id,
        bank_reg_number="1234",
        bank_account_number="5678901234",
        mobilepay_number="12345678",
    )
    db.add(profile)
    db.commit()

    inv = _make_invoice(db, user, customer, Decimal("1250.00"))

    # With MobilePay configured — 2-column layout, QR rendered
    pdf_with_qr = render_invoice_pdf(db, inv)
    assert pdf_with_qr.startswith(b"%PDF")
    assert len(pdf_with_qr) > 1000  # sanity — not an empty stub

    # Without MobilePay — falls back to single-column layout, no QR
    profile.mobilepay_number = None
    db.commit()
    pdf_without_qr = render_invoice_pdf(db, inv)
    assert pdf_without_qr.startswith(b"%PDF")
    # PDF should be smaller without the QR image embedded
    assert len(pdf_without_qr) < len(pdf_with_qr), (
        "PDF without MobilePay QR should be smaller than with QR"
    )


def test_credit_note_omits_mobilepay_qr(db, user, customer):
    """Kreditnotaer have negative totals — nothing to collect. Must NOT
    render a QR (would confuse the customer into 'paying' a refund)."""
    from app.models.business_profile import BusinessProfile
    from app.services.invoice_pdf import render_invoice_pdf

    profile = BusinessProfile(
        user_id=user.id,
        mobilepay_number="12345678",
    )
    db.add(profile)
    db.commit()

    # Build the invoice normally, then flip the kreditnota flag — we
    # only care that the renderer skips the QR for credit notes.
    inv = _make_invoice(db, user, customer, Decimal("500.00"))
    inv.is_credit_note = True
    db.commit()

    pdf = render_invoice_pdf(db, inv)
    assert pdf.startswith(b"%PDF")  # still renders fine
    # Compare against same-amount non-credit invoice — credit should be
    # smaller because the QR image is omitted.
    inv2 = _make_invoice(db, user, customer, Decimal("500.00"))
    pdf2 = render_invoice_pdf(db, inv2)
    assert len(pdf) < len(pdf2), (
        "Credit note must NOT embed a MobilePay QR (no money to collect)"
    )


# ─── Test 10: AI Daily Brief faktura section ─────────────────────


def test_daily_brief_precompute_includes_faktura_intel(db, user, customer):
    """Precompute pulls faktura counts/amounts so the LLM (or fallback)
    can phrase them. Verifies the 5 new fields are populated correctly."""
    from app.services.daily_brief import compute_precompute

    # Two overdue invoices (1500 + 2500 = 4000 kr overdue)
    inv1 = _make_invoice(db, user, customer, Decimal("1500.00"))
    inv2 = _make_invoice(db, user, customer, Decimal("2500.00"))
    # Force them past due
    inv1.due_date = date.today() - timedelta(days=10)
    inv2.due_date = date.today() - timedelta(days=20)
    # One paid this month
    inv3 = _make_invoice(db, user, customer, Decimal("750.00"))
    InvoiceService.mark_paid(db, user, inv3.id, Decimal("750.00"), source="manual")
    db.commit()

    # One pending payment suggestion
    sale = _make_bank_sale(db, user, Decimal("1500.00"), notes="UNKNOWN")
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()

    p = compute_precompute(user, db)
    assert p.overdue_invoice_count == 2
    assert p.overdue_invoice_total == 4000.00
    assert p.payment_suggestions_pending >= 1
    assert p.invoices_paid_this_month >= 1
    assert p.invoices_sent_this_month >= 3  # all 3 invoices counted as sent


def test_daily_brief_candidates_surface_overdue_action(db, user, customer):
    """When fakturaer are overdue, the candidate list MUST include an
    'action' card with the total kr + count. This is the morning reminder
    that earns the Brief its keep."""
    from app.services.daily_brief import compute_precompute, generate_candidates

    inv = _make_invoice(db, user, customer, Decimal("3000.00"))
    inv.due_date = date.today() - timedelta(days=5)
    db.commit()

    p = compute_precompute(user, db)
    candidates = generate_candidates(p)

    overdue_card = next(
        (c for c in candidates if "overdue" in c.text.lower()), None,
    )
    assert overdue_card is not None, "Overdue invoice must produce a candidate"
    assert overdue_card.type == "action"
    # The Brief must mention the count so the owner knows the scope
    assert "1" in overdue_card.text
    # Each candidate's facts list must include figures that the LLM
    # output is later validated against — no hallucinations allowed
    assert any("3" in f for f in overdue_card.facts)


def test_daily_brief_candidates_surface_review_inbox(db, user, customer):
    """Pending review suggestions must surface as a candidate so the
    Brief drives traffic to /faktura/review."""
    from app.services.daily_brief import compute_precompute, generate_candidates

    _make_invoice(db, user, customer, Decimal("1250.00"))
    sale = _make_bank_sale(db, user, Decimal("1250.00"), notes="UNKNOWN")
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()

    p = compute_precompute(user, db)
    candidates = generate_candidates(p)

    review_card = next(
        (c for c in candidates if "review" in c.text.lower()), None,
    )
    assert review_card is not None
    assert review_card.type == "action"


def test_daily_brief_silent_when_no_faktura_activity(db, user, customer):
    """Zero overdue + zero pending suggestions = NO faktura candidates.
    The Brief stays clean rather than emitting filler. Critical for the
    'do not generate noise' rule that makes the Brief trustworthy."""
    from app.services.daily_brief import compute_precompute, generate_candidates

    p = compute_precompute(user, db)
    assert p.overdue_invoice_count == 0
    assert p.payment_suggestions_pending == 0

    candidates = generate_candidates(p)
    # None of the candidates should mention overdue/review when there
    # are no real numbers to report
    for c in candidates:
        assert "overdue" not in c.text.lower(), (
            f"Brief produced filler 'overdue' card with no overdue: {c.text}"
        )
        assert "review" not in c.text.lower(), (
            f"Brief produced filler 'review' card with no suggestions: {c.text}"
        )


# ─── Test 11: Auto-match guards ──────────────────────────────────


def test_outgoing_payments_never_match(db, user, customer):
    """A negative-amount Sale (outgoing) must NEVER trigger any match
    logic. The matcher returned None and created no suggestions."""
    _make_invoice(db, user, customer, Decimal("1250.00"))
    out = _make_bank_sale(
        db, user, Decimal("-1250.00"),
        notes="REFUND TO CUSTOMER",
    )
    result = payment_match_service.try_match_sale_to_invoice(db, out)
    db.commit()
    assert result is None
    assert db.query(PaymentMatchSuggestion).count() == 0


def test_draft_invoice_never_matches(db, user, customer):
    """Auto-match must only consider sent/overdue invoices. A draft
    must never auto-flip to paid (state machine violation)."""
    inv = InvoiceService.create_draft(
        db, user, customer.id,
        lines=[{
            "description": "Test",
            "quantity": Decimal("1"),
            "unit_price_net": Decimal("1000.00"),
            "moms_rate": Decimal("0.250"),
        }],
    )
    db.commit()
    assert inv.status == "draft"

    sale = _make_bank_sale(
        db, user, Decimal("1250.00"),
        notes="OVF LYNGBY STORKUNDE",
    )
    payment_match_service.try_match_sale_to_invoice(db, sale)
    db.commit()
    db.refresh(inv)
    assert inv.status == "draft", "Draft must NOT be auto-flipped"
    assert db.query(PaymentMatchSuggestion).count() == 0
