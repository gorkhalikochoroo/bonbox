"""Tests for the Mirabelle-format close PDF.

The reportlab render is non-deterministic at byte level (timestamps,
internal object ordering) but the output STRUCTURE is testable:
  • Always returns valid PDF bytes (starts with %PDF)
  • Never raises on malformed/missing input — graceful fallback
  • Renders even with all None values
  • Honours the cash_diff_flagged toggle (different background)
"""
from __future__ import annotations

from app.services.kasserapport_pdf import _money, render_close_pdf


# ─── Money formatter — pure helper ─────────────────────────────────────
# Note: _money now delegates to bonbox_pdf_kit.money_dk, so DKK renders the
# gold "kr." suffix (was "… DKK") and non-DKK uses the gold ISO format
# (1,234.56 EUR). These assertions pin that single canonical format.

def test_money_basic():
    assert _money(14854) == "14.854,00 kr."
    assert _money(14854.50) == "14.854,50 kr."
    assert _money(14854.555) == "14.854,56 kr."  # rounds half-up


def test_money_handles_none():
    assert _money(None) == "—"


def test_money_handles_garbage():
    assert _money("not a number") == "—"
    assert _money([]) == "—"


def test_money_handles_negative():
    assert _money(-685.50) == "-685,50 kr."


def test_money_zero():
    assert _money(0) == "0,00 kr."


def test_money_currency_override():
    assert _money(100, currency="EUR") == "100.00 EUR"
    assert _money(100, currency="NOK") == "100.00 NOK"


def test_money_handles_99_99_round_trip():
    """Edge case: 99.995 rounds to 99.100 → 100.00, not 99.100.
    Make sure the fractional carry doesn't break."""
    result = _money(99.995)
    assert result == "100,00 kr."


# ─── Full PDF render ───────────────────────────────────────────────────

def _abigail_aggregated() -> dict:
    """Real Mirabelle Saturday 9.3 numbers from the photographed Excel."""
    return {
        "closed_by": "Caro",
        "cash_closing": 18799,
        "money_to_bank": 0,
        "paid_out": 0,
        "paid_in": 0,
        "cash_opening": 0,
        "cash_total": 18799,
        "gift_cards_total": 0,
        "mobilepay_total": 0,
        "cards_total": 92111.65,
        "payments_total": 110910.65,
        "sales_pos": 100292.54,
        "cash_difference": -10618.11,
        "cash_diff_flagged": True,
        "flagged_reason": "Cash difference -10,618.11 kr (short by 10,618.11, threshold 100)",
        "terminals": [
            {"terminal_name": "Front bar", "dankort": 24292.51, "teller": 31455.04, "amex": 0, "total": 55747.55},
            {"terminal_name": "Back bar",  "dankort": 17355.00, "teller": 19009.10, "amex": 0, "total": 36364.10},
            {"terminal_name": "Terrace",   "dankort": 0,        "teller": 0,        "amex": 0, "total": 0},
            {"terminal_name": "Takeaway",  "dankort": 0,        "teller": 0,        "amex": 0, "total": 0},
        ],
    }


def test_render_close_pdf_returns_valid_pdf_bytes():
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Mirabelle",
        date_label="9.3.2026 (Mandag)",
        currency="DKK",
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000  # substantive content, not just header


def test_render_close_pdf_handles_empty_aggregated():
    """Defense: an empty dict shouldn't crash. We render a mostly-blank
    PDF rather than 500'ing the endpoint."""
    pdf = render_close_pdf(
        aggregated={},
        business_name="",
        date_label="",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_handles_all_none_values():
    """Defense: every numeric field is None — render gracefully with
    em-dashes throughout."""
    pdf = render_close_pdf(
        aggregated={
            "cash_closing": None, "money_to_bank": None, "paid_out": None,
            "paid_in": None, "cash_opening": None, "cash_total": None,
            "gift_cards_total": None, "mobilepay_total": None,
            "cards_total": None, "payments_total": None,
            "sales_pos": None, "cash_difference": None,
            "cash_diff_flagged": False,
            "terminals": [],
        },
        business_name="Test",
        date_label="",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_with_flagged_cash_diff():
    """The flagged path should render — different background colour
    on the cash diff row."""
    agg = _abigail_aggregated()
    agg["cash_diff_flagged"] = True
    pdf_flagged = render_close_pdf(
        aggregated=agg,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    agg2 = dict(agg)
    agg2["cash_diff_flagged"] = False
    agg2["flagged_reason"] = ""
    pdf_clean = render_close_pdf(
        aggregated=agg2,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    # Both render; can't easily diff content but both should be valid PDFs
    assert pdf_flagged.startswith(b"%PDF")
    assert pdf_clean.startswith(b"%PDF")


def test_render_close_pdf_with_six_terminals():
    """Even with 6 terminals (the cap implied by the UI / business
    reality) the PDF should fit on one page. We can't directly count
    pages without parsing PDF, but rendering shouldn't error."""
    agg = _abigail_aggregated()
    agg["terminals"] = [
        {"terminal_name": f"T{i}", "dankort": 1000, "teller": 2000, "amex": 0, "total": 3000}
        for i in range(1, 7)
    ]
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Big Restaurant",
        date_label="9.3.2026",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_never_raises_on_malformed_input():
    """Defense layer — feed it deliberate garbage, expect a fallback
    error PDF, not a crash."""
    pdf = render_close_pdf(
        aggregated={"terminals": "not a list", "cash_closing": object()},  # type: ignore
        business_name="X",
        date_label="X",
        currency="DKK",
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")  # either main render or error fallback


def test_render_close_pdf_currency_passed_through():
    """If the user is on a non-DKK currency, the formatter respects it."""
    agg = _abigail_aggregated()
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Vietnamese cafe",
        date_label="9.3.2026",
        currency="VND",
    )
    # Can't easily search inside the PDF for "VND" without parsing,
    # but the call shouldn't crash and should produce a valid PDF.
    assert pdf.startswith(b"%PDF")


# ─── Copenhagen / Bogføringsloven 2024 standard fields ────────────────

def test_render_close_pdf_with_business_profile():
    """Smoke: BusinessProfile field passes through cleanly."""
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Restaurant Abigail ApS",
        date_label="9.3.2026 (Mandag)",
        currency="DKK",
        business_profile={
            "org_number": "44544891",
            "address": "Nørregade 12",
            "zipcode": "1165",
            "city": "København K",
            "country": "DK",
        },
    )
    assert pdf.startswith(b"%PDF")
    # PDF body is reportlab-compressed so byte-grep won't find specific
    # strings — what we CAN verify is that the render path executes
    # cleanly with the full BusinessProfile shape.


def test_render_close_pdf_with_bilagsnummer():
    """Bilagsnummer (Bogføringsloven §15 sequential numbering) doesn't
    crash the renderer."""
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
        bilagsnummer="K2026-0042",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_address_helper_handles_partial_profile():
    """The _format_dk_address helper degrades gracefully when only
    partial address fields are present."""
    from app.services.kasserapport_pdf import _format_dk_address
    # Full
    assert _format_dk_address({
        "address": "Nørregade 12",
        "zipcode": "1165",
        "city": "København K",
    }) == "Nørregade 12, 1165 København K"
    # No zipcode, only city
    assert _format_dk_address({
        "address": "Nørregade 12",
        "city": "København K",
    }) == "Nørregade 12, København K"
    # Only address
    assert _format_dk_address({"address": "Nørregade 12"}) == "Nørregade 12"
    # Empty
    assert _format_dk_address({}) == ""
    assert _format_dk_address(None) == ""


def test_render_close_pdf_moms_section_back_derived():
    """When revenue.* fields aren't supplied, MOMS section back-derives
    from payments_total at 25%."""
    agg = _abigail_aggregated()
    agg.pop("revenue", None)
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_moms_section_uses_supplied_revenue():
    """When revenue.* IS supplied, PDF uses the actual moms numbers."""
    agg = _abigail_aggregated()
    agg["revenue"] = {
        "subtotal_excl_moms": 80234.12,
        "moms_amount": 20058.53,
        "total_incl_moms": 100292.65,
    }
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_handles_minimal_business_profile():
    """Owner who only filled in CVR (no address yet) still gets a clean PDF."""
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
        business_profile={"org_number": "12345678"},
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_no_business_profile_still_renders():
    """Owner without any BusinessProfile row → profile=None → PDF
    still renders, just without CVR/address line."""
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
        business_profile=None,
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_danish_date_label_parsed():
    """The DK-style 'YYYY-MM-DD' label gets translated to 'DD.MM.YYYY (Day)'."""
    from app.services.kasserapport_pdf import _danish_date_label
    # ISO input
    date, day = _danish_date_label("2026-03-09")
    assert date == "09.03.2026"
    assert day == "Mandag"  # 9 March 2026 is a Monday
    # Already-formatted input (round-trip safe)
    date2, day2 = _danish_date_label("9.3.2026 (Tirsdag)")
    assert date2 == "9.3.2026"
    assert day2 == "Tirsdag"
    # Garbage in
    date3, day3 = _danish_date_label("not-a-date")
    assert date3 == "not-a-date"
    assert day3 == ""


# ─── The multi-terminal router's own lock claim ─────────────────────────
# `is_locked_signed` was hardcoded True in routers/kasserapport.py on the claim
# that "a multi-terminal-close render is always for a confirmed aggregate". But
# `aggregated` arrives in the REQUEST BODY, from the page's in-memory figures,
# and nothing on that path locks or signs anything — so every one of these
# documents told a revisor it was final. Same shape as the per-close PDF's
# "Lukket —": an assurance nothing earned. The caller must now SAY so, and the
# filename follows the claim.

def test_router_does_not_claim_locked_by_default():
    """A body with no lock claim must not produce a 'Låst + signeret' document
    or a 'lukning_' filename."""
    import inspect
    from app.routers import kasserapport as r

    src = inspect.getsource(r.close_pdf)
    assert "is_locked_signed = True" not in src, "the unconditional claim is back"
    assert "_lock_claim_from_server(" in src
    # The filename follows the claim rather than always saying "lukning".
    assert '_stem = "lukning" if is_locked_signed else "kladde"' in src


def test_router_excel_filename_follows_the_same_claim():
    import inspect
    from app.routers import kasserapport as r

    src = inspect.getsource(r.close_excel)
    assert 'f"lukning_{biz_slug}' not in src
    assert "_lock_claim_from_server(" in src


# The claim must not be assertable by the CALLER either. Reading `locked` off
# the request body replaced a hardcoded lie with a client-supplied one: the
# same untrusted dict the aggregate itself arrives in, with nothing server-side
# verifying that any close was ever locked.

class _FakeQuery:
    def __init__(self, row):
        self._row = row

    def filter(self, *a, **kw):
        return self

    def first(self):
        return self._row


class _FakeDB:
    def __init__(self, row=None):
        self._row = row
        self.queried = False

    def query(self, *a, **kw):
        self.queried = True
        return _FakeQuery(self._row)


class _FakeUser:
    id = "u1"


def test_a_bare_locked_flag_in_the_body_is_not_a_lock_claim():
    from app.routers.kasserapport import _lock_claim_from_server

    for body in ({"locked": True}, {"is_locked_signed": True},
                 {"locked": True, "is_locked_signed": True}):
        db = _FakeDB()
        assert _lock_claim_from_server(body, db=db, user=_FakeUser()) is False
        assert db.queried is False, "no row was consulted, so nothing was verified"


def test_the_lock_claim_comes_from_the_stored_close():
    from types import SimpleNamespace
    from app.routers.kasserapport import _lock_claim_from_server

    confirmed = SimpleNamespace(status="confirmed")
    draft = SimpleNamespace(status="draft")
    body = {"close_id": "c1"}
    assert _lock_claim_from_server(
        body, db=_FakeDB(confirmed), user=_FakeUser()) is True
    assert _lock_claim_from_server(
        body, db=_FakeDB(draft), user=_FakeUser()) is False
    # No such close (or someone else's) → no claim.
    assert _lock_claim_from_server(
        body, db=_FakeDB(None), user=_FakeUser()) is False


def test_preview_and_locked_documents_differ():
    """The renderer already supported both labels; the point is that the two
    are genuinely different documents, so the flag carries information."""
    agg = {"cash_total": 1000, "payments_total": 1000, "closed_by": "Lars"}
    preview = render_close_pdf(aggregated=agg, business_name="Cafe",
                               date_label="2026-09-17", is_locked_signed=False)
    locked = render_close_pdf(aggregated=agg, business_name="Cafe",
                              date_label="2026-09-17", is_locked_signed=True)
    assert preview.startswith(b"%PDF")
    assert locked.startswith(b"%PDF")
    assert preview != locked


def test_address_renders_its_town_once_on_the_multi_terminal_kasserapport():
    """The same E3 defect lived in this builder's own _format_dk_address."""
    from app.services.kasserapport_pdf import _format_dk_address

    line = _format_dk_address({
        "address": "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
        "zipcode": "2500",
        "city": "Valby",
    })
    assert line == "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby"
    assert line.count("Valby") == 1
    # And a street-only address still gets its postal town.
    assert _format_dk_address({
        "address": "Nørregade 12", "zipcode": "1165", "city": "København K",
    }) == "Nørregade 12, 1165 København K"



# ─────────── The preview must be unmissable, not a footnote ───────────
#
# A preview was marked ONLY by 7pt grey text beside the document hash, on the
# last page, while the title said plain "KASSERAPPORT". The per-close document
# marks a draft in five independent places precisely so that no single mark
# being missed restores the lie; this builder got one.


def test_a_preview_is_marked_in_its_title():
    from app.services.kasserapport_pdf import _doc_type_label

    assert _doc_type_label(False) == "KASSERAPPORT — KLADDE"
    assert _doc_type_label(True) == "KASSERAPPORT"


def test_a_preview_carries_a_band_and_a_locked_document_does_not():
    from app.services.kasserapport_pdf import _draft_band

    assert _draft_band(True) == []
    band = _draft_band(False)
    assert band, "a preview with no band is a preview a reader can miss"


def test_the_draft_banner_says_the_figures_are_not_final():
    from app.services.kasserapport_pdf import _DRAFT_BANNER_TEXT

    assert "KLADDE" in _DRAFT_BANNER_TEXT
    assert "ikke låst" in _DRAFT_BANNER_TEXT


# ─────────── A2: a label with no value is not a claim ───────────


def test_no_closer_means_no_lukket_af_label():
    from app.services.kasserapport_pdf import _closer_segment

    assert _closer_segment({"closed_by": None}) is None
    assert _closer_segment({"closed_by": "   "}) is None
    assert _closer_segment({}) is None
    assert _closer_segment({"closed_by": "Lars"}) == "Lukket af: <b>Lars</b>"


def test_an_unsigned_signature_cell_is_a_rule_not_an_em_dash():
    """"Lukket af / —" reads as "signed by nobody"; a blank rule reads as
    "to be signed", which is what it is."""
    from app.services.kasserapport_pdf import _closer_signature_cell

    assert _closer_signature_cell({"closed_by": None}) == "____________________"
    assert _closer_signature_cell({"closed_by": "Lars"}) == "Lars"


# ─────────── E2/D7: no English row labels on a Danish accounting document ────


def test_the_multi_terminal_rows_are_danish():
    import inspect
    from app.services import kasserapport_pdf as m

    src = inspect.getsource(m)
    for english in ("Paid out - change/byttep", "Paid in",
                    "Gift cards accepted (total)", "Mobile Pay",
                    "Cards total", "Payments total", "Sales POS (incl. tax)"):
        assert english not in src, english
    for danish in ("Udbetalt — byttepenge", "Indbetalt",
                   "Gavekort modtaget (i alt)", "MobilePay",
                   "Kortbetalinger i alt", "Betalinger i alt",
                   "Salg fra kassesystem (inkl. moms)"):
        assert danish in src, danish


def test_brand_names_are_not_translated():
    """Dankort / Teller / Amex are brands — the same word in both languages."""
    import inspect
    from app.services import kasserapport_pdf as m

    src = inspect.getsource(m)
    for brand in ('"Dankort"', '"Teller"', '"Amex"'):
        assert brand in src, brand


def test_a_preview_and_a_locked_document_render_without_raising():
    agg = {"cash_total": 1000, "payments_total": 1000, "closed_by": None}
    for locked in (True, False):
        out = render_close_pdf(aggregated=agg, business_name="Cafe",
                               date_label="2026-09-17", is_locked_signed=locked)
        assert out.startswith(b"%PDF")
