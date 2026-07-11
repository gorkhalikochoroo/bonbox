"""Unit tests for the gavekort PDF renderer.

Pure renderer tests — no DB, no FastAPI. We feed lightweight SimpleNamespace
fakes (a GiftCard-shaped `card` + a BusinessProfile-shaped `profile`) and assert
`build_gavekort_pdf` returns real PDF bytes across both templates and every
graceful-degradation branch (no profile, no branding, no expiry, no CVR, note +
recipient present, unknown template). The renderer must NEVER raise over missing
branding, so these tests double as its degradation contract.
"""
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.services.gavekort_pdf import build_gavekort_pdf


def _fake_card(**overrides):
    """A GiftCard-shaped fake with sensible defaults."""
    base = dict(
        short_code="GK-7K2M-9QX4",
        face_value_minor=50000,       # 500,00 kr.
        balance_minor=50000,
        recipient_name=None,
        note=None,
        expires_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _fake_profile(**overrides):
    """A BusinessProfile-shaped fake (same attribute names invoice_pdf reads)."""
    base = dict(
        company_name="BonBox Café",
        vat_number="12345678",
        org_number=None,
        address="Nørregade 12",
        zipcode="1165",
        city="København",
        accent_color="#166b4f",
        logo_url=None,          # no logo bytes → monogram path
        logo_position="left",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.mark.parametrize("template", ["minimal", "foil"])
def test_returns_pdf_bytes_for_both_templates(template):
    pdf = build_gavekort_pdf(
        card=_fake_card(),
        profile=_fake_profile(),
        template=template,
        redeem_url="GK-7K2M-9QX4",
    )
    assert isinstance(pdf, (bytes, bytearray))
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 500          # a real one-card page, not an empty stub


def test_no_profile_renders_blank_branding():
    """profile=None must degrade to sensible blanks, never raise."""
    pdf = build_gavekort_pdf(
        card=_fake_card(),
        profile=None,
        template="minimal",
        redeem_url="GK-7K2M-9QX4",
    )
    assert pdf[:4] == b"%PDF"


def test_note_and_recipient_present():
    """A card with a recipient + personal note renders (mid block populated)."""
    pdf = build_gavekort_pdf(
        card=_fake_card(
            recipient_name="Freja",
            note="Tillykke med fødselsdagen — nyd en kop kaffe!",
        ),
        profile=_fake_profile(),
        template="foil",
        redeem_url="GK-7K2M-9QX4",
    )
    assert pdf[:4] == b"%PDF"


def test_with_expiry_and_cvr():
    """Expiry (→ 'Gyldig til …') + CVR fine-print branch renders."""
    pdf = build_gavekort_pdf(
        card=_fake_card(expires_at=datetime(2028, 7, 12, 10, 0, 0)),
        profile=_fake_profile(vat_number="87654321"),
        template="minimal",
        redeem_url="GK-7K2M-9QX4",
    )
    assert pdf[:4] == b"%PDF"


def test_unknown_template_coerces_to_minimal():
    """An unknown template id must not raise — it falls back to minimal."""
    pdf = build_gavekort_pdf(
        card=_fake_card(),
        profile=_fake_profile(),
        template="holographic-unicorn",
        redeem_url="GK-7K2M-9QX4",
    )
    assert pdf[:4] == b"%PDF"


def test_missing_optional_fields_on_card():
    """A minimal card object (only the fields the renderer reads) still works,
    and a None face value degrades to the em-dash amount without raising."""
    bare = SimpleNamespace(
        short_code="GK-0000-0000",
        face_value_minor=None,
        recipient_name=None,
        note=None,
        expires_at=None,
    )
    pdf = build_gavekort_pdf(
        card=bare, profile=None, template="minimal", redeem_url="GK-0000-0000",
    )
    assert pdf[:4] == b"%PDF"


def test_blank_business_name_uses_gk_monogram():
    """No company name → the monogram falls back to 'GK', still renders."""
    pdf = build_gavekort_pdf(
        card=_fake_card(),
        profile=_fake_profile(company_name=""),
        template="minimal",
        redeem_url="GK-7K2M-9QX4",
    )
    assert pdf[:4] == b"%PDF"


def test_non_dkk_currency_formats_and_renders():
    """A non-DKK currency uses the ISO-style amount and still renders."""
    pdf = build_gavekort_pdf(
        card=_fake_card(face_value_minor=25000),
        profile=_fake_profile(),
        template="foil",
        redeem_url="GK-7K2M-9QX4",
        currency="EUR",
    )
    assert pdf[:4] == b"%PDF"
