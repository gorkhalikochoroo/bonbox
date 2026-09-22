"""The kasserapport's CLAIMS — the part a revisor reads and a MOMS filing rests on.

These tests pin what the document ASSERTS, not how ReportLab draws it. Every one
of them fails if its fix is reverted (spot-checked by reverting each fix in turn;
see the task report).

The defects behind this file came off a real production export (17 Sep 2026),
where a close with status='draft', closed_at NULL, revenue_categories='food:-57'
and revenue_total 0.00 produced a document that:
  · said "Lukket —" for a close that was never locked;
  · printed a −57,00 line above a 0,00 total, silently;
  · rendered the negative line as ordinary omsætning;
  · asserted 0,00 salgsmoms while showing a non-zero line;
  · asserted three checks ("Salgsmoms beregnet, kontant afstemt, bilagsnumre i
    orden") that had not been run, under a heading saying GENNEMGÅS;
  · said "DKK" where every screen says "kr.";
  · said "Food" on a Danish accounting document;
  · printed "…, 2500 Valby, 2500 Valby".
"""
from __future__ import annotations

from datetime import date, datetime

import pytest

from app.services.bonbox_pdf_kit import compose_business_address, split_address_parts
from app.services.close_category_labels import (
    payment_method_label,
    revenue_category_label,
)
from app.services.kasserapport_claims import build_close_claims


class _Row:
    """A DailyClose-shaped stand-in. The claims builder reads attributes only,
    so this keeps the test at the claim level with no DB or HTTP in the way."""

    def __init__(self, **kw):
        self.date = date(2026, 9, 17)
        self.status = "confirmed"
        self.closed_at = datetime(2026, 9, 17, 23, 30)
        self.revenue_categories = None
        self.revenue_total = 0.0
        self.payment_categories = None
        self.payment_total = 0.0
        self.moms_total = None
        self.revenue_ex_moms = None
        self.moms_mode = "auto"
        self.cash_counted = None
        self.cash_expected = None
        self.cash_difference = None
        for k, v in kw.items():
            setattr(self, k, v)


def _good_close(**kw) -> _Row:
    """A close with nothing wrong with it: locked, lines tie out, MOMS coherent,
    cash counted and reconciled."""
    base = dict(
        status="confirmed",
        closed_at=datetime(2026, 9, 17, 23, 30),
        revenue_categories="food:8000|drinks:2000",
        revenue_total=10000.0,
        moms_total=2000.0,
        revenue_ex_moms=8000.0,
        moms_mode="auto",
        cash_counted=3200.0,
        cash_expected=3200.0,
        cash_difference=0.0,
    )
    base.update(kw)
    return _Row(**base)


def _claims(dc, **kw):
    kw.setdefault("currency", "DKK")
    return build_close_claims(dc, **kw)


# ─────────── A. Draft vs locked — the document must not lie about itself ──────


def test_draft_never_renders_lukket():
    """D1. A draft is not final and must never say it is. The exported document
    used to print 'Lukket' with status='draft' and closed_at NULL."""
    c = _claims(_Row(status="draft", closed_at=None))
    assert "Lukket" not in c["footer"]
    assert c["footer"].endswith("Anvendes sammen med dit bogføringssystem.")
    assert "Ikke låst" in c["footer"]
    assert c["is_locked"] is False


def test_draft_is_marked_kladde_in_title_and_banner():
    """A1. A draft exports (owners want to check before locking) but it is
    unmistakably marked — a KLADDE title and a banner saying so."""
    c = _claims(_Row(status="draft", closed_at=None))
    assert c["title"] == "KASSERAPPORT — KLADDE"
    assert c["draft_banner"] is not None
    assert "KLADDE" in c["draft_banner"]
    assert "ikke låst" in c["draft_banner"]


def test_draft_carries_no_assurance_banner():
    """D5/A1. An unlocked close has nothing to assure. The banner is absent
    entirely — not softened, absent."""
    dc = _good_close(status="draft", closed_at=None)
    assert _claims(dc, has_bilag=True)["assurance"] is None


def test_locked_close_renders_lukket_with_its_timestamp():
    c = _claims(_good_close())
    assert "Lukket 17/09/2026 23:30" in c["footer"]


def test_label_with_no_value_never_renders():
    """A2. 'Lukket —' is a label with nothing behind it. A close marked
    confirmed but carrying no closed_at (legacy rows do exist) must drop the
    segment, not print a dangling em-dash."""
    c = _claims(_good_close(closed_at=None))
    assert "Lukket" not in c["footer"]
    assert "—" not in c["footer"]


def test_draft_filename_does_not_imply_finality():
    """A3. A kladde mailed on and opened next week is identified by its name."""
    assert _claims(_Row(status="draft", closed_at=None))["filename"] == (
        "kasserapport_kladde_2026-09-17.pdf"
    )
    assert _claims(_good_close())["filename"] == "kasserapport_2026-09-17.pdf"


# ─────────── B. Arithmetic integrity ─────────────────────────────────────────


def test_lines_that_do_not_sum_to_the_total_produce_a_visible_discrepancy():
    """D2. The live document printed a −57,00 line above a 0,00 total with
    nothing between them. The page must add up or say that it does not."""
    dc = _Row(revenue_categories="food:-57", revenue_total=0.0)
    c = _claims(dc)
    assert c["revenue_ties_out"] is False
    assert c["discrepancy"] == "57,00 kr."
    assert c["lines_sum"] == "-57,00 kr."
    assert c["total_revenue"] == "0,00 kr."


def test_lines_that_sum_to_the_total_produce_no_discrepancy_line():
    """The discrepancy line is not noise — it appears only when it is true."""
    c = _claims(_good_close())
    assert c["revenue_ties_out"] is True
    assert c["discrepancy"] is None
    assert c["lines_sum"] is None


def test_a_close_with_no_categories_is_not_out_of_balance():
    """A scan-and-lock close has a bottom line and no category split. There are
    no lines to disagree with the total, so it must not be flagged."""
    c = _claims(_Row(revenue_total=17030.0, moms_total=3406.0, revenue_ex_moms=13624.0))
    assert c["revenue_ties_out"] is True
    assert c["discrepancy"] is None


def test_negative_line_is_labelled_a_correction():
    """D3. A correction is legitimate in DK bookkeeping; an unexplained negative
    'Omsætning' line is not."""
    c = _claims(_Row(revenue_categories="food:-57", revenue_total=-57.0,
                     moms_total=-11.4, revenue_ex_moms=-45.6))
    line = c["revenue_lines"][0]
    assert line["is_correction"] is True
    assert line["correction_tag"] == "korrektion"
    assert c["has_correction"] is True


def test_negative_line_is_inside_the_total():
    """B3. Whatever a negative line is called, it must be INSIDE the total —
    which is what the save-path fix guarantees and what the page then shows."""
    c = _claims(_Row(revenue_categories="food:1000|returns:-57", revenue_total=943.0,
                     moms_total=188.6, revenue_ex_moms=754.4))
    assert c["revenue_ties_out"] is True
    assert c["discrepancy"] is None
    assert c["total_revenue"] == "943,00 kr."
    assert "indgår i Omsætning i alt" in c["correction_note"]


def test_the_correction_note_does_not_claim_inclusion_when_the_page_does_not_add_up():
    """The note asserting 'og indgår i Omsætning i alt' would contradict the
    discrepancy line three rows above it. On an out-of-balance close it says
    only what the line IS, and points at the difference."""
    c = _claims(_Row(revenue_categories="food:-57", revenue_total=0.0))
    assert c["has_correction"] is True
    assert "indgår i Omsætning i alt" not in c["correction_note"]
    assert "Se differencen ovenfor" in c["correction_note"]


def test_no_correction_note_when_there_is_no_negative_line():
    assert _claims(_good_close())["correction_note"] is None


def test_the_discrepancy_label_names_the_arithmetic_it_shows():
    """The value is (total − lines). The label said '÷' — a division sign
    standing in for 'versus' on an accounting document."""
    c = _claims(_Row(revenue_categories="food:-57", revenue_total=0.0))
    assert c["labels"]["discrepancy"] == "Difference (i alt − linjer)"
    assert "÷" not in c["labels"]["discrepancy"]


def test_the_draft_banner_is_grammatical_danish():
    """'en kasserapport' is common gender — 'den endelige', not 'det'."""
    banner = _claims(_Row(status="draft", closed_at=None))["draft_banner"]
    assert "den endelige kasserapport" in banner
    assert "det endelige kasserapport" not in banner


def test_positive_line_is_not_labelled_a_correction():
    c = _claims(_good_close())
    assert all(not ln["is_correction"] for ln in c["revenue_lines"])
    assert c["has_correction"] is False


# ─────────── C. MOMS honesty ─────────────────────────────────────────────────


def test_contradictory_moms_renders_dash_never_zero():
    """D4/C1. The live document asserted 0,00 salgsmoms on a page showing a
    non-zero line. '—' is the doctrine's answer; 0,00 is a fabrication."""
    c = _claims(_Row(revenue_categories="food:-57", revenue_total=0.0,
                     moms_total=0.0, revenue_ex_moms=0.0, moms_mode="auto"))
    assert c["moms"]["vat"] == "—"
    assert c["moms"]["excl"] == "—"
    assert c["moms"]["incl"] == "—"
    assert "0,00" not in "".join(c["moms"].values())
    assert c["moms_unknown_reason"] is not None


def test_unknown_moms_renders_dash():
    """C1. moms_total NULL is not 0 — it is unknown, and says so."""
    c = _claims(_Row(revenue_categories="food:10000", revenue_total=10000.0,
                     moms_total=None, revenue_ex_moms=None))
    assert c["moms"]["vat"] == "—"
    assert c["moms_unknown_reason"] is not None


def test_auto_mode_zero_vat_on_nonzero_revenue_is_not_stated():
    """Auto mode cannot produce zero VAT on non-zero revenue. A 0,00 there is a
    leftover from a save path that zeroed it, not a calculation."""
    c = _claims(_Row(revenue_categories="food:10000", revenue_total=10000.0,
                     moms_total=0.0, revenue_ex_moms=10000.0, moms_mode="auto"))
    assert c["moms"]["vat"] == "—"


def test_net_plus_moms_must_reconstruct_gross():
    """The stored trio contradicting itself means none of the three can be
    stated on its own."""
    c = _claims(_Row(revenue_categories="food:10000", revenue_total=10000.0,
                     moms_total=2000.0, revenue_ex_moms=5000.0))
    assert c["moms"]["vat"] == "—"
    assert c["moms_unknown_reason"] is not None


def test_coherent_moms_is_stated_in_full():
    c = _claims(_good_close())
    assert c["moms_unknown_reason"] is None
    assert c["moms"] == {
        "incl": "10.000,00 kr.",
        "vat": "2.000,00 kr.",
        "excl": "8.000,00 kr.",
    }


def test_manual_moms_is_stated_but_attributed_to_the_closer():
    """A manually keyed figure is the owner's number, not BonBox's — true, and
    said as such, never presented as computed."""
    c = _claims(_good_close(moms_mode="manual"))
    assert c["moms"]["vat"] == "2.000,00 kr."
    assert c["moms_manual_note"] is not None
    moms_check = next(x for x in c["assurance"]["checks"] if x["check"] == "moms")
    assert moms_check["text"] == "Salgsmoms indtastet manuelt af kasseansvarlig."


def test_manual_mode_zero_vat_is_allowed():
    """The auto-mode zero guard must not fire on a deliberate manual 0 (a
    zero-rated or exempt day the owner keyed themselves)."""
    c = _claims(_Row(revenue_categories="food:10000", revenue_total=10000.0,
                     moms_total=0.0, revenue_ex_moms=10000.0, moms_mode="manual"))
    assert c["moms"]["vat"] == "0,00 kr."
    assert c["moms_unknown_reason"] is None


# ─────────── D. The assurance banner must be EARNED ──────────────────────────


def test_every_assurance_line_passes_only_when_its_check_passed():
    dc = _good_close()
    a = _claims(dc, has_bilag=True)["assurance"]
    assert a["all_ok"] is True
    assert a["heading"] == "KLAR TIL BOGFØRING"
    assert {c["check"] for c in a["checks"]} == {"moms", "cash", "bilag", "lines"}
    assert all(c["ok"] for c in a["checks"])


def test_cash_not_counted_says_so_and_fails_the_banner():
    """D5. The live banner claimed 'kontant afstemt' on a close with NULL
    payments and no count at all."""
    a = _claims(_good_close(cash_counted=None, cash_difference=None),
                has_bilag=True)["assurance"]
    cash = next(c for c in a["checks"] if c["check"] == "cash")
    assert cash["ok"] is False
    assert cash["text"] == "Kontant IKKE optalt."
    assert a["all_ok"] is False
    assert a["heading"] == "GENNEMGÅS"


def test_counted_but_unreconciled_cash_is_distinguished_from_not_counted():
    a = _claims(_good_close(cash_counted=3000.0, cash_difference=-200.0),
                has_bilag=True)["assurance"]
    cash = next(c for c in a["checks"] if c["check"] == "cash")
    assert cash["ok"] is False
    assert cash["text"] == "Kontant optalt — differencen er ikke afstemt."


def test_missing_bilagsnumre_says_so():
    a = _claims(_good_close(), has_bilag=False)["assurance"]
    bilag = next(c for c in a["checks"] if c["check"] == "bilag")
    assert bilag["ok"] is False
    assert bilag["text"] == "Ingen bilagsnumre på dagen."


def test_heading_agrees_with_the_body():
    """GENNEMGÅS over a list of passes is a document arguing with itself. The
    heading is DERIVED from the checks, so the two can never disagree."""
    for dc, bilag in [
        (_good_close(), True),
        (_good_close(cash_counted=None), True),
        (_good_close(), False),
        (_good_close(moms_total=None, revenue_ex_moms=None), True),
    ]:
        a = _claims(dc, has_bilag=bilag)["assurance"]
        passed = all(c["ok"] for c in a["checks"])
        assert a["all_ok"] is passed
        assert a["heading"] == ("KLAR TIL BOGFØRING" if passed else "GENNEMGÅS")


def test_out_of_balance_lines_fail_the_banner():
    dc = _good_close(revenue_categories="food:8000|drinks:2000", revenue_total=9000.0)
    a = _claims(dc, has_bilag=True)["assurance"]
    lines = next(c for c in a["checks"] if c["check"] == "lines")
    assert lines["ok"] is False
    assert a["all_ok"] is False


def test_no_assurance_line_is_a_static_sentence():
    """The old banner's exact string asserted three checks unconditionally. It
    must not survive anywhere in the claims."""
    c = _claims(_good_close(), has_bilag=True)
    flat = " ".join(
        [c["footer"], c["title"]]
        + [x["text"] for x in c["assurance"]["checks"]]
        + list(c["labels"].values())
    )
    assert "Salgsmoms beregnet, kontant afstemt, bilagsnumre i orden" not in flat


# ─────────── E. Presentation ─────────────────────────────────────────────────


def test_money_renders_as_kr_with_ore():
    """E1. Every screen in the app says 'kr.'; the artifact said 'DKK'. And this
    document ties out to a ledger, so it is øre-exact."""
    c = _claims(_Row(revenue_categories="food:1234.56", revenue_total=1234.56,
                     moms_total=246.91, revenue_ex_moms=987.65))
    assert c["revenue_lines"][0]["amount"] == "1.234,56 kr."
    assert c["total_revenue"] == "1.234,56 kr."
    assert "DKK" not in c["total_revenue"]
    assert c["moms"]["vat"] == "246,91 kr."


def test_non_dkk_currency_keeps_its_iso_code():
    c = _claims(_Row(revenue_categories="food:1234.56", revenue_total=1234.56),
                currency="EUR")
    assert c["revenue_lines"][0]["amount"] == "1,234.56 EUR"
    assert c["danish"] is False


def test_builtin_category_renders_in_danish():
    """E2. 'Food' on a Danish accounting document. The app already calls it
    'Mad' on the screen that produced the close."""
    c = _claims(_Row(revenue_categories="food:100|drinks:50", revenue_total=150.0,
                     moms_total=30.0, revenue_ex_moms=120.0))
    assert [ln["label"] for ln in c["revenue_lines"]] == ["Mad", "Drikkevarer"]


def test_owner_typed_category_passes_through_verbatim():
    """E2. An owner's own words are never translated and never title-cased —
    they must read back exactly as the owner typed them."""
    c = _claims(_Row(revenue_categories="catering til Bertos:500", revenue_total=500.0,
                     moms_total=100.0, revenue_ex_moms=400.0))
    assert c["revenue_lines"][0]["label"] == "catering til Bertos"


def test_builtin_payment_method_renders_in_danish_brands_untouched():
    c = _claims(_Row(payment_categories="cash:100|bank_transfer:50|mobilepay:25",
                     payment_total=175.0))
    assert [ln["label"] for ln in c["payment_lines"]] == [
        "Kontant", "Bankoverførsel", "MobilePay",
    ]


def test_category_label_helpers_directly():
    assert revenue_category_label("food") == "Mad"
    assert revenue_category_label("food", danish=False) == "Food"
    assert revenue_category_label("Min egen kategori") == "Min egen kategori"
    assert payment_method_label("bank_transfer") == "Bankoverførsel"
    assert payment_method_label("faktura") == "Faktura"
    assert payment_method_label("mit eget felt") == "mit eget felt"


# ─────────── E3. The address renders its town once ───────────────────────────


@pytest.mark.parametrize("profile,expected", [
    # The live defect: address already ends with the postal town.
    ({"address": "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
      "zipcode": "2500", "city": "Valby"},
     "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby"),
    # Street only → the tail is genuinely needed.
    ({"address": "Nørregade 12", "zipcode": "1165", "city": "København K"},
     "Nørregade 12, 1165 København K"),
    # City present without a zip, already in the address.
    ({"address": "Havnegade 3, Aarhus", "city": "Aarhus"}, "Havnegade 3, Aarhus"),
    # No street at all.
    ({"zipcode": "8000", "city": "Aarhus C"}, "8000 Aarhus C"),
    # Nothing set.
    ({}, ""),
])
def test_address_renders_its_town_once(profile, expected):
    assert compose_business_address(profile) == expected


def test_address_helper_accepts_an_orm_row_too():
    """Every artifact shares one composer; half of them pass ORM rows."""
    row = _Row()
    row.address = "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby"
    row.zipcode = "2500"
    row.city = "Valby"
    assert compose_business_address(row) == "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby"


def test_split_address_parts_lets_each_document_use_its_own_separator():
    """The gavekort joins with ' · ' and the faktura with a line break; both
    must get an EMPTY tail when the address already carries the town."""
    assert split_address_parts({
        "address": "Carl Th. Dreyers Vej 244, 2500 Valby",
        "zipcode": "2500", "city": "Valby",
    }) == ("Carl Th. Dreyers Vej 244, 2500 Valby", "")
    assert split_address_parts({
        "address": "Nørregade 12", "zipcode": "1165", "city": "København K",
    }) == ("Nørregade 12", "1165 København K")


def test_a_street_named_after_a_city_keeps_its_postal_town():
    """The de-duplication is conservative: 'Københavnsvej 4' in Roskilde must
    not lose its real postal town."""
    assert compose_business_address({
        "address": "Københavnsvej 4", "zipcode": "4000", "city": "Roskilde",
    }) == "Københavnsvej 4, 4000 Roskilde"


# ─────────── The exact production row, end to end ────────────────────────────


def test_the_production_row_makes_no_claim_it_cannot_support():
    """One test standing in for the whole artifact: the real 17 Sep 2026 row."""
    dc = _Row(
        status="draft", closed_at=None,
        revenue_categories="food:-57", revenue_total=0.0,
        payment_categories=None, payment_total=0.0,
        moms_total=0.0, revenue_ex_moms=0.0, moms_mode="auto",
    )
    c = _claims(dc, profile={
        "address": "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
        "zipcode": "2500", "city": "Valby",
    }, business_name="DukaanAI v/Manoz Chaudhary")

    assert c["title"] == "KASSERAPPORT — KLADDE"          # D1
    assert "Lukket" not in c["footer"]                     # D1
    assert "—" not in c["footer"]                          # A2
    assert c["discrepancy"] == "57,00 kr."                 # D2
    assert c["revenue_lines"][0]["is_correction"] is True  # D3
    assert c["moms"]["vat"] == "—"                         # D4
    assert c["assurance"] is None                          # D5
    assert c["revenue_lines"][0]["amount"] == "-57,00 kr."  # D6
    assert c["revenue_lines"][0]["label"] == "Mad"         # D7
    assert c["address_line"].count("Valby") == 1           # D8
    assert c["filename"] == "kasserapport_kladde_2026-09-17.pdf"


# ═══════════════════════════════════════════════════════════════════════════
# Round 2 — claims the first pass still could not support.
#
# Each block below names the defect it pins. They are ordinary assertions on
# derived values for the same reason as everything above: ReportLab compresses
# its streams, so a false claim that is only in the PDF is a false claim nobody
# can test.
# ═══════════════════════════════════════════════════════════════════════════


# ─────────── Cash: "couldn't check" is a THIRD outcome, not a pass ───────────
#
# `_f(cash_difference) or 0.0` turned a NULL into 0.00, which sailed through the
# tolerance and printed "Kontant optalt og afstemt." — a reconciliation that had
# never run. daily_close.py stores cash_difference NULL whenever cash_expected
# is None (no register cash for the date AND no cash line in the payment split),
# which is any card-only day on which the owner still counts the float. The band
# then asserted the reconciliation three lines under the page's own em-dash in
# the KASSEBEHOLDNING block.


def test_counted_cash_with_no_baseline_is_not_reported_as_reconciled():
    a = _claims(_good_close(cash_counted=1500.0, cash_expected=None,
                            cash_difference=None), has_bilag=True)["assurance"]
    cash = next(c for c in a["checks"] if c["check"] == "cash")
    assert cash["ok"] is False
    assert "afstemt" not in cash["text"].replace("ikke afstemt", "")
    assert cash["text"] == (
        "Kontant optalt — ikke afstemt (intet forventet beløb at måle op imod)."
    )


def test_counted_cash_with_no_baseline_cannot_head_the_band_ready():
    """Every other check passing must not carry a never-run reconciliation over
    the line into KLAR TIL BOGFØRING."""
    a = _claims(_good_close(cash_counted=1500.0, cash_expected=None,
                            cash_difference=None), has_bilag=True)["assurance"]
    assert a["all_ok"] is False
    assert a["heading"] == "GENNEMGÅS"


def test_the_three_cash_outcomes_are_three_distinct_lines():
    """Not counted / counted-with-no-baseline / counted-and-off must never
    collapse into each other."""
    texts = {
        name: next(
            c for c in _claims(_good_close(**kw), has_bilag=True)["assurance"]["checks"]
            if c["check"] == "cash"
        )["text"]
        for name, kw in {
            "none": dict(cash_counted=None, cash_difference=None),
            "nobase": dict(cash_counted=1500.0, cash_difference=None),
            "off": dict(cash_counted=3000.0, cash_difference=-200.0),
            "ok": dict(cash_counted=3200.0, cash_difference=0.0),
        }.items()
    }
    assert len(set(texts.values())) == 4, texts
    assert texts["ok"] == "Kontant optalt og afstemt."


# ─────────── Payments: the same tie-out rule as the revenue lines ───────────
#
# The payment block rendered every decoded key as a peer line above
# payment_total — while the save path deliberately EXCLUDES the card-brand keys
# from that total because they are a split of the card line. A close carrying
# brand splits therefore printed lines summing to far more than its stated
# total, in silence. Reachable through the flagship flow: the Z-report scan
# writes those keys and encode_breakdown persists them verbatim.


def _brand_close(**kw):
    return _good_close(
        payment_categories="cash:2000|card:8000|dankort:5000|visa:3000",
        payment_total=10000.0, revenue_total=10000.0,
        revenue_categories="food:10000", moms_total=2000.0,
        revenue_ex_moms=8000.0, **kw,
    )


def test_card_brands_are_marked_as_a_split_not_as_payment_methods():
    c = _claims(_brand_close())
    by_label = {line["label"]: line for line in c["payment_lines"]}
    assert by_label["Dankort"]["is_brand"] is True
    assert by_label["Visa"]["is_brand"] is True
    assert by_label["Kort"]["is_brand"] is False
    assert by_label["Kontant"]["is_brand"] is False


def test_card_brands_are_drawn_directly_under_the_card_line():
    labels = [line["label"] for line in _claims(_brand_close())["payment_lines"]]
    assert labels == ["Kontant", "Kort", "Dankort", "Visa"]


def test_card_brands_do_not_push_the_payment_lines_out_of_balance():
    """2.000 + 8.000 = the stated 10.000. Counting the brands on top would make
    it 18.000 and the page would disagree with itself."""
    c = _claims(_brand_close())
    assert c["payment_ties_out"] is True
    assert c["payment_discrepancy"] is None
    assert c["brand_note"] is not None


def test_payment_lines_that_do_not_sum_to_the_total_say_so():
    c = _claims(_good_close(payment_categories="cash:2000|card:5000",
                            payment_total=10000.0))
    assert c["payment_ties_out"] is False
    assert c["payment_lines_sum"] == "7.000,00 kr."
    assert c["payment_discrepancy"] == "3.000,00 kr."
    assert c["payment_discrepancy_note"] is not None


def test_a_payment_mismatch_fails_the_band():
    a = _claims(_good_close(payment_categories="cash:2000|card:5000",
                            payment_total=10000.0), has_bilag=True)["assurance"]
    pay = next(c for c in a["checks"] if c["check"] == "payments")
    assert pay["ok"] is False
    assert a["heading"] == "GENNEMGÅS"


def test_a_close_with_no_payment_split_makes_no_payment_claim():
    """A scan-and-lock close records no payment methods; there is nothing to
    check and the band must not report a check it did not run."""
    a = _claims(_good_close(payment_categories=None), has_bilag=True)["assurance"]
    assert "payments" not in {c["check"] for c in a["checks"]}


# ─────────── MOMS: an INCOMPLETE split is not a CONTRADICTION ───────────
#
# Dashing the VAT whenever the lines failed to sum to the total also dashed it
# on the product's own documented partial-OCR flow, where revenue_total is the
# OCR'd bottom line and the categories are whatever could be read. There the
# stored trio reconciles perfectly and the figure IS known — so "—" fabricated
# an unknown, which doctrine forbids just as firmly as fabricating a zero.


def _partial_ocr_close(**kw):
    """The documented scan row: revenue_total = max(breakdown_sum, override)."""
    return _good_close(
        revenue_categories="drinks:1.82", revenue_total=17030.0,
        moms_total=3406.0, revenue_ex_moms=13624.0, moms_mode="auto", **kw,
    )


def test_an_incomplete_category_split_still_states_its_moms():
    c = _claims(_partial_ocr_close())
    assert c["moms"]["vat"] == "3.406,00 kr."
    assert c["moms"]["incl"] == "17.030,00 kr."
    assert c["moms"]["excl"] == "13.624,00 kr."
    assert c["moms_unknown_reason"] is None


def test_a_stated_moms_over_an_incomplete_split_names_its_basis():
    c = _claims(_partial_ocr_close())
    assert c["moms_basis_note"] is not None
    assert "ufuldstændig" in c["moms_basis_note"]


def test_an_incomplete_split_is_not_called_a_discrepancy():
    """"Ret lukningen, og hent kasserapporten igen" over a close the product
    itself treats as correct is the document telling the owner to fix a
    non-error."""
    c = _claims(_partial_ocr_close())
    assert c["revenue_partial_split"] is True
    assert c["revenue_contradicts_total"] is False
    assert c["discrepancy_label"] == "Ikke fordelt på kategori"
    assert c["discrepancy"] == "17.028,18 kr."
    assert c["discrepancy_tone"] == "muted"
    assert "Ret lukningen" not in (c["discrepancy_note"] or "")


def test_an_incomplete_split_is_still_reported_in_the_band():
    """Not an error, but not a pass either — a revisor has to book the
    unallocated amount somewhere."""
    a = _claims(_partial_ocr_close(), has_bilag=True)["assurance"]
    lines = next(c for c in a["checks"] if c["check"] == "lines")
    assert lines["ok"] is False
    assert "17.028,18 kr." in lines["text"]


def test_lines_that_CONTRADICT_the_total_still_dash_the_moms():
    """The distinction has to cut both ways or it is just a loophole."""
    # A negative line the total ignored — the real 17 Sep row.
    c = _claims(_good_close(revenue_categories="food:-57", revenue_total=0.0,
                            moms_total=0.0, revenue_ex_moms=0.0))
    assert c["revenue_contradicts_total"] is True
    assert c["moms"]["vat"] == "—"
    assert c["moms"]["incl"] == "—"
    assert c["discrepancy_tone"] == "amber"


def test_lines_summing_PAST_the_total_contradict_it():
    c = _claims(_good_close(revenue_categories="food:8000|drinks:4000",
                            revenue_total=10000.0))
    assert c["revenue_partial_split"] is False
    assert c["revenue_contradicts_total"] is True
    assert c["moms"]["vat"] == "—"


# ─────────── The band reports only checks it actually ran ───────────


def test_a_close_with_no_categories_makes_no_tie_out_claim():
    """lines_sum is None with no breakdown, which used to read as a pass:
    "✓ Omsætningslinjer stemmer med Omsætning i alt" for a close with no
    revenue lines at all."""
    a = _claims(_good_close(revenue_categories=None, revenue_total=17030.0,
                            moms_total=3406.0, revenue_ex_moms=13624.0),
                has_bilag=True)["assurance"]
    assert "lines" not in {c["check"] for c in a["checks"]}
    assert not any("Omsætningslinjer" in c["text"] for c in a["checks"])


def test_a_close_with_no_categories_can_still_be_ready():
    """Omitting the check must not quietly fail the band either."""
    a = _claims(_good_close(revenue_categories=None, revenue_total=17030.0,
                            moms_total=3406.0, revenue_ex_moms=13624.0,
                            cash_counted=3200.0, cash_difference=0.0),
                has_bilag=True)["assurance"]
    assert a["all_ok"] is True
    assert a["heading"] == "KLAR TIL BOGFØRING"


# ─────────── One predicate for both artifacts ───────────
#
# The range export marked a period's MOMS unknown only for a NULL moms_total,
# so the identical stored row rendered "—" on its own kasserapport and a
# confident number in the period total a revisor files from.


@pytest.mark.parametrize("kw, unknown", [
    (dict(), False),
    (dict(moms_total=None, revenue_ex_moms=None), True),
    # auto mode cannot produce zero VAT on non-zero revenue
    (dict(moms_total=0.0, revenue_ex_moms=10000.0), True),
    # a deliberate manual zero for a zero-rated day is allowed
    (dict(moms_total=0.0, revenue_ex_moms=10000.0, moms_mode="manual"), False),
    # net + moms must reconstruct gross
    (dict(moms_total=2000.0, revenue_ex_moms=5000.0), True),
    # lines contradicting the total poison everything derived from it
    (dict(revenue_categories="food:-57", revenue_total=0.0,
          moms_total=0.0, revenue_ex_moms=0.0), True),
    # an incomplete split does not
    (dict(revenue_categories="drinks:1.82", revenue_total=17030.0,
          moms_total=3406.0, revenue_ex_moms=13624.0), False),
])
def test_moms_is_unknown_agrees_with_the_document(kw, unknown):
    from app.services.kasserapport_claims import moms_is_unknown
    dc = _good_close(**kw)
    assert moms_is_unknown(dc) is unknown
    # The shared predicate and the rendered block can never drift apart.
    assert (_claims(dc)["moms"]["vat"] == "—") is unknown


# ─────────── G. Payments ↔ revenue — the check this document never ran ───────
#
# THE DEFECT. The assurance band compared payment LINES to the payment
# SUBTOTAL. routers/daily_close.py computes payment_total as the sum of exactly
# those lines, so for any close saved through the app that check compares a
# number with itself and always passes. It could not catch a wrong day.
#
# Meanwhile services/daily_close_range_export.py compared payments to REVENUE
# and flagged the mismatch. So one stored row produced a green "KLAR TIL
# BOGFØRING" per-close PDF and an amber multi-day export — two revisor-bound
# documents contradicting each other about the same day, and the owner sends
# the flattering one.
#
# The third outcome is deliberately NOT an accusation: a revenue-only close
# (Z-report bottom line, no method split) has nothing to reconcile, and
# branding it "out by 17.030 kr" would be the same false claim being removed
# from the dashboard. It is reported as data instead.


def _band(dc):
    return _claims(dc)["assurance"]


def _check(dc, name):
    return next(
        (c for c in _band(dc)["checks"] if c.get("check") == name), None
    )


def test_payments_matching_revenue_pass_the_new_check():
    dc = _good_close(payment_categories="kontant:3200|kort:6800", payment_total=10000.0)
    c = _check(dc, "payments_vs_revenue")
    assert c is not None and c["ok"] is True
    assert _band(dc)["payments_vs_revenue"] == "ok"


def test_payments_that_do_not_match_revenue_block_book_ready():
    """The exact contradiction: lines agree with their own subtotal, so the old
    band said ready, while the day is 2.000 kr short of revenue."""
    dc = _good_close(payment_categories="kontant:3200|kort:4800", payment_total=8000.0)
    band = _band(dc)
    assert band["payments_vs_revenue"] == "off"
    assert band["all_ok"] is False, (
        "a close 2.000 kr out still claimed book-ready — the range export "
        "flags this same day"
    )
    c = _check(dc, "payments_vs_revenue")
    assert c["ok"] is False and "2.000" in c["text"].replace(" ", " ")


def test_the_old_check_alone_could_not_have_caught_it():
    """Proves the new check is not redundant: lines-vs-subtotal passes on the
    very close that is 2.000 kr short."""
    dc = _good_close(payment_categories="kontant:3200|kort:4800", payment_total=8000.0)
    assert _check(dc, "payments")["ok"] is True


def test_a_revenue_only_close_is_not_accused():
    """The ICP's normal close. Nothing was recorded, so there is nothing to
    reconcile — it must not be branded out by the whole day's revenue."""
    dc = _good_close(payment_categories=None, payment_total=0.0)
    band = _band(dc)
    assert band["payments_vs_revenue"] == "not_recorded"
    assert _check(dc, "payments_vs_revenue") is None, (
        "a close with no payment split was given a payments-vs-revenue verdict"
    )
    texts = " ".join(c["text"] for c in band["checks"])
    assert "10.000" not in texts.replace(" ", " "), (
        "the whole day's revenue was printed as a discrepancy"
    )


def test_the_third_outcome_is_still_reported_as_data():
    """It does not gate the heading, but a caller must be able to see it
    rather than infer it from a missing check."""
    dc = _good_close(payment_categories=None, payment_total=0.0)
    band = _band(dc)
    assert band["payments_recorded"] is False
    assert band["payments_vs_revenue"] == "not_recorded"


def test_ore_rounding_does_not_trip_the_check():
    dc = _good_close(payment_categories="kontant:3200|kort:6800.4", payment_total=10000.4)
    assert _band(dc)["payments_vs_revenue"] == "ok"
