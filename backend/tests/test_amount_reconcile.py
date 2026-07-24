"""Which number on the receipt is the total?

The regex OCR path picks the LARGEST total-looking number. On a Danish
cash receipt the biggest figures are usually NOT the total:

    AT BETALE      52,05     <- the total
    KONTANT       200,00     <- what the customer handed over
    BYTTEPENGE    146,00     <- the change

The labelled pattern normally saves it. Thermal paper creases, though,
and a garbled "A7 BETA1E" drops the parser onto max() — which books
200,00. Reproduced end to end below on the receipt this was reported
from: a 4x overstatement carrying a voucher number and a MOMS claim.

No confidence score catches it. The OCR isn't unsure; it read the digits
correctly and picked the wrong line. But the paper disproves itself —
its printed MOMS only implies a legal DK rate against the true total.

Run:
  cd backend && python3 -m pytest tests/test_amount_reconcile.py -q
"""
from __future__ import annotations

import pytest

from app.services.amount_reconcile import reconcile_amount
from app.services.receipt_ocr import _extract_amounts_from_text

# The reported MENY receipt, as OCR text.
MENY = """MENY
NORDENS PLADS 8B
LEMONAID PASSIONSFRUGT 25,00
PANT A, 1 STK 1,00
FYRFADSLIGHTER ZAPP TURBO 26,05
AT BETALE 52,05
KONTANT 200,00
BYTTEPENGE 146,00
HERAF MOMS 10,41"""

# The same receipt with the total label creased — what a real photo of
# folded thermal paper gives you.
MENY_CREASED = MENY.replace("AT BETALE", "A7 BETA1E")

MENY_LINES = [{"amount": 25.00}, {"amount": 1.00}, {"amount": 26.05}]


# ── the bug, reproduced ──────────────────────────────────────────────

def test_the_regex_picks_the_cash_tendered_when_the_label_is_creased():
    """Documents WHY this module exists. If this ever stops being true,
    the reconciler can be reconsidered — deliberately, not by accident."""
    assert _extract_amounts_from_text(MENY)["suggested_amount"] == 52.05
    assert _extract_amounts_from_text(MENY_CREASED)["suggested_amount"] == 200.00


def test_the_receipts_own_moms_recovers_the_real_total():
    block = _extract_amounts_from_text(MENY_CREASED)
    v = reconcile_amount(
        block["all_amounts_found"],
        chosen=block["suggested_amount"],      # 200.00 — wrong
        vat_amount=10.41,
        line_items=MENY_LINES,
    )
    assert v.amount == 52.05
    assert v.confident is True
    assert v.reason == "vat_confirms"


@pytest.mark.parametrize("wrong", [200.00, 146.00, 26.05])
def test_every_wrong_candidate_implies_an_illegal_rate(wrong):
    """10,41 MOMS against 200,00 is 5,49% — not a rate that exists in
    Denmark. That is what makes the rejection evidence, not a guess."""
    v = reconcile_amount([wrong, 52.05], chosen=wrong, vat_amount=10.41)
    assert v.amount == 52.05 and v.confident is True


# ── never invent, never silently substitute ─────────────────────────

def test_no_moms_means_unverified_not_confident():
    """A receipt with no printed MOMS gives us nothing to check against.
    Keep the parser's pick, but do not claim it was verified."""
    v = reconcile_amount([200.00, 52.05], chosen=52.05, vat_amount=None)
    assert v.amount == 52.05
    assert v.confident is False
    assert v.reason == "unverified"
    assert 200.00 in v.alternates


def test_zero_moms_cannot_adjudicate():
    """A zero-rated receipt is consistent with every total, so it must
    not be treated as confirmation of one."""
    v = reconcile_amount([200.00, 52.05], chosen=52.05, vat_amount=0.0)
    assert v.confident is False


def test_a_contradicted_choice_becomes_a_question_not_a_swap():
    """When MOMS rules out the parser's pick but can't single out a
    replacement, we ask. Quietly substituting our own preference is how
    a wrong figure gets a voucher number."""
    # MOMS pins the total tightly (only ~5x the VAT survives), so the
    # realistic failure is that NOTHING on the list fits — the true
    # total was never extracted. Then we must not fall back to the
    # largest number and call it done.
    v = reconcile_amount([500.00, 400.00], chosen=500.00, vat_amount=25.00)
    assert v.confident is False
    assert v.reason == "vat_contradicts_choice"
    assert v.amount is None, "never book a total the receipt disproves"


def test_moms_singling_out_one_candidate_is_used_even_if_not_chosen():
    """When the paper's own MOMS leaves exactly one possibility, that IS
    the answer — no need to ask."""
    v = reconcile_amount([125.00, 100.00, 500.00], chosen=500.00, vat_amount=25.00)
    assert v.amount == 125.00 and v.confident is True


def test_line_items_alone_can_confirm():
    """No MOMS on the paper, but the lines add up to exactly one
    candidate."""
    v = reconcile_amount(
        [200.00, 52.05], chosen=200.00, vat_amount=None, line_items=MENY_LINES,
    )
    assert v.amount == 52.05 and v.confident is True
    assert v.reason == "lines_confirm"


def test_line_items_never_reject_on_their_own():
    """OCR drops lines. A sum that doesn't match must not veto a total
    the MOMS already confirmed."""
    v = reconcile_amount(
        [52.05], chosen=52.05, vat_amount=10.41,
        line_items=[{"amount": 25.00}],        # a dropped line
    )
    assert v.amount == 52.05 and v.confident is True


# ── it must not fight a provider that read the paper properly ───────

def test_a_clean_receipt_is_left_alone():
    block = _extract_amounts_from_text(MENY)
    v = reconcile_amount(
        block["all_amounts_found"], chosen=52.05,
        vat_amount=10.41, line_items=MENY_LINES,
    )
    assert v.amount == 52.05 and v.confident is True


def test_a_zero_rated_vendor_total_is_accepted():
    """0% is a legal DK rate — a non-registered vendor's receipt must not
    be treated as impossible."""
    v = reconcile_amount([500.00], chosen=500.00, vat_amount=0.0)
    assert v.amount == 500.00


# ── degenerate input ─────────────────────────────────────────────────

@pytest.mark.parametrize("cands,chosen", [([], None), ([0], None), ([-5], None)])
def test_nothing_to_go_on_returns_no_amount(cands, chosen):
    v = reconcile_amount(cands, chosen=chosen, vat_amount=10.41)
    assert v.amount is None and v.confident is False


def test_vat_larger_than_the_total_is_impossible():
    v = reconcile_amount([5.00], chosen=5.00, vat_amount=10.41)
    assert v.confident is False
