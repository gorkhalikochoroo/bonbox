"""What the kasserapport CLAIMS — derived once, rendered once, testable.

This module holds every assertion the per-close kasserapport makes about a
DailyClose: whether it is final, what its lines add up to, whether its MOMS can
be stated, which pre-flight checks were actually passed, and what its footer and
filename may say. The PDF builder in ``routers/daily_close.py`` renders this
structure and adds nothing of its own.

Why it is a separate module
---------------------------
The document is read by a revisor and underpins a MOMS filing, so its claims are
the part that must be pinned by tests. ReportLab compresses its streams, so a
test cannot grep the produced PDF for "Lukket" or "0,00" — the existing tests say
so in their own docstrings and settle for asserting the bytes start with %PDF.
That leaves every claim on the page unpinned, which is how the shipped artifact
came to say "Lukket" for a close that was never locked, print a −57,00 line above
a 0,00 total, and assert three checks that had not been run.

Deriving the claims here makes each one an ordinary value a test can assert on,
with no PDF parser in the dependency list.

Doctrine encoded here
---------------------
* A draft never says "Lukket" and never carries an assurance banner.
* A label with no value is not rendered — no "Lukket —".
* Lines that do not sum to the total produce a visible discrepancy line.
* MOMS that is unknown or contradicts the page renders "—", never 0,00.
* Each assurance line appears only when its check actually passed.
* Money is kr. with øre, via the one shared formatter.
* Built-in categories render in Danish; owner-typed names pass through verbatim.
"""
from __future__ import annotations

from typing import Any

from app.models.daily_close import decode_breakdown
from app.services.bonbox_pdf_kit import compose_business_address, money_dk
from app.services.close_category_labels import (
    is_card_brand_key,
    payment_method_label,
    revenue_category_label,
)

# Half an øre. This document must tie out to a ledger, so the tolerance is a
# rounding artifact and nothing more.
TIE_TOL = 0.005

# The kassedifference an accountant will let pass without a note. Matches the
# tolerance the readiness badge has always used.
CASH_TOL = 100.0

# net + moms must reconstruct gross. 1 kr absorbs per-line øre rounding across a
# day's categories while still catching a real contradiction.
MOMS_RECON_TOL = 1.00

# Payments ↔ REVENUE. Every krone of revenue was collected by some method, so
# the methods must sum to the revenue. 50 øre absorbs rounding and still catches
# a real gap. This is the SAME comparison, at the same tolerance, that
# services/daily_close_range_export.py has always applied to the SAME stored
# row — restated here because the two artifacts disagreeing about one day is
# exactly the defect this constant closes.
#
# NOT MOMS_RECON_TOL: that governs ex_moms + moms == revenue_total, a different
# equation with a different tolerance.
PAY_RECON_TOL = 0.50

# Below this, no payment split was recorded at all. A revenue-only close — the
# Z-report bottom line typed in with no method breakdown — has nothing to
# reconcile, and saying it is "out by" the whole day's revenue is the same
# false accusation the `unallocated` wording exists to prevent for the revenue
# lines. See diagnostics_service._has_recorded_payments, same reasoning.
PAY_RECORDED_TOL = 0.005

# ── Marks the base font can actually draw ────────────────────────────────────
# The band's heading led with "⚠" (U+26A0). Helvetica is drawn in WinAnsi, which
# has no such glyph, and ReportLab's fallback for a character it cannot place is
# ZapfDingbats "n" — a FILLED BLACK SQUARE. That is precisely the "▪ GENNEMGÅS"
# the founder's exported PDF showed and the bug report quoted verbatim: not a
# warning sign, a tofu box.
#
# "×" is in WinAnsi outright; "✓" is not, but ReportLab has a real ZapfDingbats
# substitute for it, so it draws correctly. WinAnsi membership alone is
# therefore the WRONG test — it would reject a mark that renders fine. The only
# honest oracle is ReportLab's own resolution, which is what the check below
# asks. Named here so the choice is one testable fact rather than a literal
# buried in a renderer.
MARK_PASS = "✓"    # ✓ — via ZapfDingbats, verified renderable
MARK_FAIL = "×"    # × — WinAnsi
MARK_REVIEW = "!"       # what the range export's own badge already uses


def mark_is_renderable(mark: str, font_name: str = "Helvetica") -> bool:
    """True when ReportLab can place every character of `mark` as a real glyph.

    Asks ReportLab to resolve the string the way it will when drawing, and
    fails the mark if any character lands on the not-defined box.
    """
    if not mark:
        return False
    try:
        from reportlab.pdfbase import pdfmetrics
    except ImportError:  # pragma: no cover — reportlab is a hard dependency
        return True
    font = pdfmetrics.getFont(font_name)
    fonts = [font] + list(getattr(font, "substitutionFonts", []))
    notdef_font = getattr(pdfmetrics, "_notdefFont", None)
    notdef_char = getattr(pdfmetrics, "_notdefChar", None)
    for chunk_font, chunk in pdfmetrics.unicode2T1(mark, fonts):
        if notdef_font is not None and chunk_font is notdef_font and chunk == notdef_char:
            return False
    return True


def close_labels(currency: str) -> dict[str, str]:
    """Every string the kasserapport can print, in the document's language.

    Danish for DKK — that is what the revisor reads, and per Bogføringsloven §8
    the regnskabsmateriale must be in Danish or English. Other currencies fall
    back to English. kasserapport / revisor / MOMS / faktura / SKAT keep their
    Danish spelling in both by the locked-terminology rule.
    """
    DA = (currency or "").upper() == "DKK"
    return {
        "title":         "KASSERAPPORT",
        "revenue":       "OMSÆTNING" if DA else "REVENUE BREAKDOWN",
        "total_revenue": "Omsætning i alt" if DA else "Total revenue",
        "moms_title":    "MOMS — SALG" if DA else "VAT — SALES",
        "moms_incl":     "Omsætning (inkl. moms)" if DA else "Revenue (incl. VAT)",
        "moms_vat":      "Salgsmoms (25 %)" if DA else "Output VAT",
        "moms_excl":     "Omsætning (ekskl. moms)" if DA else "Revenue (excl. VAT)",
        "moms_manual":   "Moms angivet manuelt af kasseansvarlig." if DA
                         else "VAT entered manually by closer.",
        "moms_zbon":     "Salgsmoms aflæst fra Z-bon." if DA
                         else "Output VAT read off the Z-report.",
        "moms_typed":    "Salgsmoms indtastet af kasseansvarlig." if DA
                         else "Output VAT entered by the closer.",
        "moms_other_rate": (" Den svarer til {eff} af omsætningen ekskl. moms, ikke "
                            "standardsatsen {rate}.") if DA
                           else (" It is {eff} of revenue excl. VAT, not the standard "
                                 "rate {rate}."),
        "payments":      "BETALINGSMETODER" if DA else "PAYMENT METHODS",
        "total_pay":     "Betalinger i alt" if DA else "Total payments",
        "cash":          "KASSEBEHOLDNING" if DA else "CASH DRAWER",
        # The expected figure is the day's CASH SALES (the till's cash, or the
        # typed Kontant line) — never "fra bilag": the page said that beside
        # "× Ingen bilagsnumre på dagen".
        "cash_expected": "Forventet kontant (kontantsalg)" if DA else "Expected cash (cash sales)",
        # Same words as the app: the counted figure has the float taken off.
        "cash_counted":  "Optalt (uden byttepenge)" if DA else "Counted (float taken off)",
        "cash_drawer":   "Optalt i skuffen i alt" if DA else "Counted in the drawer",
        "cash_float":    "Byttepenge (bliver i skuffen)" if DA else "Float (stays in the drawer)",
        "cash_diff":     "Kassedifference" if DA else "Cash difference",
        "tips":          "DRIKKEPENGE" if DA else "TIPS",
        "tips_total":    "Drikkepenge i alt" if DA else "Total tips",
        "tips_staff":    "Antal medarbejdere" if DA else "Staff count",
        "tips_pp":       "Pr. medarbejder" if DA else "Per person",
        "tips_note":     ("Drikkepenge skal indberettes via eIndkomst. "
                          "Del med dit lønsystem.") if DA
                         else ("Tips must be reported via eIndkomst. "
                               "Share with your payroll system."),
        "vouchers":      "BILAGSNUMRE" if DA else "VOUCHER NUMBERS",
        "v_sales":       "Salgsbilag" if DA else "Sales vouchers",
        "v_exp":         "Udgiftsbilag" if DA else "Expense vouchers",
        "notes":         "BEMÆRKNINGER" if DA else "NOTES",
        "closed_by":     "Lukket af" if DA else "Closed by",
        # A draft was counted, not closed: "Lukket af" beside "Ikke låst" was
        # the page contradicting itself.
        "counted_by":    "Optalt af" if DA else "Counted by",
        "locked_at":     "Låst" if DA else "Locked",
        "bilag_no":      "Bilagsnr." if DA else "Voucher no.",
        "branch":        "Afdeling" if DA else "Branch",
        "source":        "Kilde" if DA else "Source",
        "history":       "HISTORIK" if DA else "HISTORY",
        "retention":     ("Opbevares i 5 år efter bogføringsloven." if DA
                          else "Keep for 5 years under the Danish Bookkeeping Act."),
        "ready":         "KLAR TIL BOGFØRING" if DA else "READY FOR BOOKKEEPING",
        "review":        "GENNEMGÅS" if DA else "NEEDS REVIEW",
        "footer_gen":    "Genereret af BonBox" if DA else "Generated by BonBox",
        "footer_use":    "Anvendes sammen med dit bogføringssystem." if DA
                         else "Use this report alongside your accounting software.",
        # ── Draft marking ──
        "draft_mark":    "KLADDE" if DA else "DRAFT",
        # "en kasserapport" is common gender — "den endelige", not "det".
        "draft_banner":  ("KLADDE — ikke låst. Tallene kan stadig ændres, og "
                          "dette er ikke den endelige kasserapport for dagen.") if DA
                         else ("DRAFT — not locked. The figures can still change; "
                               "this is not the final kasserapport for the day."),
        "not_locked":    "Ikke låst" if DA else "Not locked",
        "closed_label":  "Lukket" if DA else "Closed",
        # ── Arithmetic integrity ──
        "lines_sum":     "Linjer i alt" if DA else "Lines total",
        # The value IS (total − lines), so the label says exactly that. "÷" was
        # the division sign standing in for "versus" on an accounting document.
        "discrepancy":   "Difference (i alt − linjer)" if DA
                         else "Discrepancy (total − lines)",
        "discrepancy_note": (
            "Linjerne ovenfor summer ikke til Omsætning i alt. Differencen står "
            "som sin egen linje — den er ikke fordelt på en kategori."
        ) if DA else (
            "The lines above do not sum to the stated total. The difference is "
            "shown as its own line; it is not allocated to any category."
        ),
        "correction_tag": "korrektion" if DA else "correction",
        # TWO variants. The first asserts the correction is INSIDE the total —
        # true only when the lines tie out. On an out-of-balance close that
        # sentence would contradict the discrepancy line printed three rows
        # above it, so the second variant drops the claim and says only what
        # the line is.
        "correction_note": (
            "Negative linjer er korrektioner (f.eks. returnering eller "
            "annulleret salg) og indgår i Omsætning i alt."
        ) if DA else (
            "Negative lines are corrections (e.g. a refund or a voided sale) "
            "and are included in the total above."
        ),
        "correction_note_unbalanced": (
            "Negative linjer er korrektioner (f.eks. returnering eller "
            "annulleret salg). Se differencen ovenfor."
        ) if DA else (
            "Negative lines are corrections (e.g. a refund or a voided sale). "
            "See the discrepancy above."
        ),
        # An INCOMPLETE split is not a contradiction. When every line is
        # positive and they sum to LESS than the stated total, the total is not
        # in dispute — part of it simply has no category yet (the Z-report scan
        # flow saves the OCR'd bottom line and whatever categories it could
        # read). Calling that a "Difference" and telling the owner to "correct
        # the close" would flag the product's own documented behaviour as an
        # error, so it gets its own, accurate wording.
        "unallocated": "Ikke fordelt på kategori" if DA
                       else "Not allocated to a category",
        "unallocated_note": (
            "Omsætningsopdelingen er ufuldstændig: beløbet ovenfor er ikke "
            "fordelt på en kategori. Omsætning i alt er dagens samlede "
            "omsætning og er grundlaget for momsopgørelsen nedenfor."
        ) if DA else (
            "The revenue breakdown is incomplete: the amount above is not "
            "allocated to any category. The stated total is the day's full "
            "revenue and is the basis for the VAT figures below."
        ),
        "unsplit_note": (
            "Omsætningen er ikke fordelt på kategorier. Omsætning i alt er dagens "
            "samlede omsætning og er grundlaget for momsopgørelsen nedenfor."
        ) if DA else (
            "The revenue is not allocated to categories. The stated total is the "
            "day's full revenue and is the basis for the VAT figures below."
        ),
        "unallocated_mixed_note": (
            "Beløbet ovenfor er ikke fordelt på en kategori, og dagens salgsmoms er "
            "ikke standardsatsen — så det kan ikke ses, hvilken del af omsætningen "
            "der har hvilken momssats. Fordel omsætningen på kategorier, eller "
            "kontrollér salgsmomsen mod Z-bonnen."
        ) if DA else (
            "The amount above is not allocated to a category, and the day's output "
            "VAT is not the standard rate — so it cannot be seen which part of the "
            "revenue carries which rate. Allocate the revenue, or check the VAT "
            "against the Z-report."
        ),
        # ── Payment methods — same tie-out rule as the revenue lines ──
        "pay_lines_sum":  "Linjer i alt" if DA else "Lines total",
        "pay_discrepancy": "Difference (i alt − linjer)" if DA
                           else "Discrepancy (total − lines)",
        "pay_discrepancy_note": (
            "Betalingslinjerne summer ikke til Betalinger i alt. Differencen "
            "står som sin egen linje — den er ikke fordelt på en metode."
        ) if DA else (
            "The payment lines do not sum to the stated total. The difference "
            "is shown as its own line; it is not allocated to any method."
        ),
        "brand_note": (
            "Kortbrands er en opdeling af kortlinjen og lægges ikke oveni "
            "Betalinger i alt."
        ) if DA else (
            "Card brands are a split of the card line and are not added on "
            "top of the stated total."
        ),
        # ── MOMS honesty ──
        "moms_unknown_rev": (
            "Salgsmoms kan ikke opgøres: omsætningslinjerne stemmer ikke med "
            "Omsætning i alt. Ret lukningen, og hent kasserapporten igen."
        ) if DA else (
            "Output VAT cannot be stated: the revenue lines do not agree with "
            "the stated total. Correct the close and export again."
        ),
        "moms_unknown_val": (
            "Salgsmoms kan ikke opgøres for denne lukning: den gemte "
            "momsopgørelse stemmer ikke med omsætningen."
        ) if DA else (
            "Output VAT cannot be stated for this close: the stored VAT figures "
            "do not agree with the revenue."
        ),
        "moms_missing":  "Salgsmoms er ikke opgjort for denne lukning." if DA
                         else "Output VAT has not been calculated for this close.",
        # Stated, but with its basis named — the lines above do not itemise the
        # whole total, so the reader is told what the VAT was computed on.
        "moms_from_total": (
            "Salgsmoms er opgjort af Omsætning i alt. Omsætningsopdelingen "
            "ovenfor er ufuldstændig."
        ) if DA else (
            "Output VAT is calculated on the stated total. The revenue "
            "breakdown above is incomplete."
        ),
        # ── Assurance lines — each is EARNED ──
        "a_moms_auto":   "Salgsmoms beregnet af BonBox ud fra omsætningen." if DA
                         else "Output VAT calculated by BonBox from revenue.",
        "a_moms_manual": "Salgsmoms indtastet manuelt af kasseansvarlig." if DA
                         else "Output VAT entered manually by the closer.",
        # A figure the owner typed or read off the Z-bon is named by its
        # source, with the rate it actually works out to — never "25 %" over
        # a number that is not 25 % of the base.
        "a_moms_zbon_std":  ("Salgsmoms aflæst fra Z-bon — svarer til {rate} af "
                             "omsætningen ekskl. moms.") if DA
                            else ("Output VAT read off the Z-report — {rate} of revenue "
                                  "excl. VAT."),
        "a_moms_typed_std": ("Salgsmoms indtastet af kasseansvarlig — svarer til {rate} "
                             "af omsætningen ekskl. moms.") if DA
                            else ("Output VAT entered by the closer — {rate} of revenue "
                                  "excl. VAT."),
        "a_moms_zbon_other":  ("Salgsmoms aflæst fra Z-bon — svarer til {eff} af "
                               "omsætningen ekskl. moms, ikke {rate}.") if DA
                              else ("Output VAT read off the Z-report — {eff} of revenue "
                                    "excl. VAT, not {rate}."),
        "a_moms_typed_other": ("Salgsmoms indtastet af kasseansvarlig — svarer til {eff} "
                               "af omsætningen ekskl. moms, ikke {rate}.") if DA
                              else ("Output VAT entered by the closer — {eff} of revenue "
                                    "excl. VAT, not {rate}."),
        "a_moms_auto_other":  ("Salgsmoms svarer til {eff} af omsætningen ekskl. moms, "
                               "ikke {rate}.") if DA
                              else ("Output VAT is {eff} of revenue excl. VAT, not {rate}."),
        "a_moms_no":     "Salgsmoms ikke opgjort." if DA
                         else "Output VAT not calculated.",
        "a_cash_ok":     "Kontant optalt og afstemt." if DA
                         else "Cash counted and reconciled.",
        # Counted, and the difference is inside the tolerance — which is NOT
        # "afstemt": the page said "og afstemt ✓" beside a +25,00 difference.
        "a_cash_tol":    ("Kontant optalt — kassedifference {amount} er inden for "
                          "tolerancen på ±100 kr.") if DA
                         else ("Cash counted — the difference of {amount} is within "
                               "the ±100 kr. tolerance."),
        "a_cash_off":    "Kontant optalt — differencen er ikke afstemt." if DA
                         else "Cash counted — the difference is not reconciled.",
        "a_cash_none":   "Kontant IKKE optalt." if DA else "Cash NOT counted.",
        # Information, not a failed check: a day whose payments are recorded
        # and hold no cash has nothing in a drawer to count (a webshop, a
        # card-only day). "Kontant IKKE optalt" made every such day "skal
        # gennemgås" on the period export.
        "a_cash_na":     ("Ingen kontantsalg på dagen — intet at optælle.") if DA
                         else "No cash sales on the day — nothing to count.",
        # The THIRD outcome. A NULL cash_difference means the reconciliation
        # never ran — there was no expected figure to measure the drawer
        # against (no register cash for the date and no cash line in the
        # payment split, e.g. a card-only day on which the owner still counts
        # the float). Collapsing that into "difference = 0" would let the band
        # assert a reconciliation that was never performed.
        "a_cash_nobase": ("Kontant optalt — ikke afstemt (intet forventet "
                          "beløb at måle op imod).") if DA
                         else ("Cash counted — not reconciled (no expected "
                               "figure to measure it against)."),
        "a_bilag_ok":    "Bilagsnumre til stede." if DA else "Voucher numbers present.",
        "a_bilag_none":  "Ingen bilagsnumre på dagen." if DA
                         else "No voucher numbers for the day.",
        # Information, not a failed check: a café that books from the Z-bon has
        # no other vouchers in BonBox, and the kasserapport IS the day's bilag.
        # Failing it made "klar til bogføring" unreachable for exactly them.
        "a_bilag_self":  ("Ingen andre bilag i BonBox på dagen — kasserapporten er "
                          "selv dagens bilag ({bilag}).") if DA
                         else ("No other vouchers in BonBox for the day — this "
                               "kasserapport is the day's voucher ({bilag})."),
        "a_lines_ok":    "Omsætningslinjer stemmer med Omsætning i alt." if DA
                         else "Revenue lines agree with the stated total.",
        "a_lines_off":   "Omsætningslinjer stemmer IKKE med Omsætning i alt." if DA
                         else "Revenue lines do NOT agree with the stated total.",
        # ONE rule for revenue without a category, whether part of the day is
        # unsplit or all of it (a total-only Z-bon). On a single-rate day the
        # MOMS is taken from Omsætning i alt, so the unsplit amount is a NOTE
        # the revisor reads — it never gates the heading. On a mixed-rate day
        # (the MOMS is not the standard rate of the base) the unsplit part is
        # exactly where the other rate could be, so the MOMS cannot be
        # verified and the day is GENNEMGÅS. The verdict used to depend on how
        # much the owner typed: a partial split failed, no split at all passed.
        "a_lines_unsplit": ("Ikke fordelt på kategori: {amount} — salgsmomsen er "
                            "opgjort af Omsætning i alt (én momssats).") if DA
                           else ("Not allocated to a category: {amount} — output VAT "
                                 "is calculated on the stated total (one VAT rate)."),
        "a_lines_mixed":   ("Ikke fordelt på kategori: {amount} — salgsmomsen {rate}, "
                            "så dagen har mere end én momssats, og momsen kan ikke "
                            "efterprøves uden kategorier.") if DA
                           else ("Not allocated to a category: {amount} — output VAT "
                                 "{rate}, so the day has more than one VAT rate and "
                                 "the VAT cannot be verified without categories."),
        "a_pay_ok":      "Betalingslinjer stemmer med Betalinger i alt." if DA
                         else "Payment lines agree with the stated total.",
        "a_pay_off":     "Betalingslinjer stemmer IKKE med Betalinger i alt." if DA
                         else "Payment lines do NOT agree with the stated total.",
        # ── Payments ↔ REVENUE ────────────────────────────────────────────
        # Wording tracks the range export's own recon strings so a revisor
        # reading both documents for one day reads one sentence, not two.
        "a_rev_pay_ok":  "Betalinger stemmer med omsætningen." if DA
                         else "Payments agree with revenue.",
        "a_rev_pay_off": "Betalinger stemmer IKKE med omsætningen (afvigelse {amount})." if DA
                         else "Payments do NOT agree with revenue (difference {amount}).",
    }


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class RevenueBalance:
    """How a close's revenue LINES stand against its stated total.

    Three outcomes, not two — and the distinction is the whole point:

    ``ties_out``
        The lines sum to the total. Nothing to explain.
    ``partial_split``
        Every line is positive and they sum to LESS than the total. The total
        is not in dispute; part of it simply has no category yet. This is the
        Z-report scan flow, where the OCR'd bottom line is saved as the total
        and whatever categories could be read are saved beside it — documented,
        intended behaviour (``routers/daily_close.py``, the revenue_total_override
        branch). Treating it as a contradiction would dash the VAT on the
        product's flagship flow and tell the owner to "correct" a close that is
        not wrong.
    ``contradicts``
        Anything else: a negative line the total ignored (the live 17 Sep row,
        ``food:-57`` beside ``revenue_total`` 0.00), or lines summing PAST the
        total. Here the total itself is contradicted by the page, so nothing
        derived from it — the MOMS block above all — can be stated.
    """

    __slots__ = ("lines_sum", "discrepancy", "ties_out", "partial_split",
                 "contradicts", "has_lines", "has_negative")

    def __init__(self, rev: dict, revenue_total: float):
        self.has_lines = bool(rev)
        self.lines_sum = round(sum(rev.values()), 2) if rev else None
        self.discrepancy = (
            round(revenue_total - self.lines_sum, 2)
            if self.lines_sum is not None else 0.0
        )
        # With no breakdown at all there are no lines to disagree with the
        # total, so a categoryless close is not "out of balance".
        self.ties_out = abs(self.discrepancy) <= TIE_TOL
        self.has_negative = any(v < 0 for v in rev.values()) if rev else False
        self.partial_split = (
            self.has_lines and not self.ties_out
            and not self.has_negative and self.discrepancy > 0
        )
        self.contradicts = (
            self.has_lines and not self.ties_out and not self.partial_split
        )


def revenue_balance(dc: Any) -> RevenueBalance:
    """Read `dc`'s revenue lines against its stated total."""
    rev = decode_breakdown(getattr(dc, "revenue_categories", None))
    return RevenueBalance(rev, _f(getattr(dc, "revenue_total", None)) or 0.0)


def moms_unknown_key(dc: Any, balance: RevenueBalance | None = None) -> str | None:
    """Which label key explains why this close's MOMS cannot be stated, or None.

    The single predicate behind every artifact that makes a VAT claim about a
    DailyClose — the per-close kasserapport AND the range export, which builds
    the same kind of claim over many days and whose headline a revisor carries
    into a filing. They previously disagreed: the range export marked a period
    unknown only for a NULL ``moms_total``, so the identical stored row could
    render "—" on its own kasserapport and a confident number in the period
    total.
    """
    bal = balance if balance is not None else revenue_balance(dc)
    revenue_total = _f(getattr(dc, "revenue_total", None)) or 0.0
    moms = _f(getattr(dc, "moms_total", None))
    ex_moms = _f(getattr(dc, "revenue_ex_moms", None))
    moms_mode = (getattr(dc, "moms_mode", None) or "auto").lower()

    if bal.contradicts:
        # The base the VAT derives from is itself in dispute; anything stated
        # here would inherit that dispute without saying so.
        return "moms_unknown_rev"
    if moms is None:
        return "moms_missing"
    if ex_moms is not None and abs((ex_moms + moms) - revenue_total) > MOMS_RECON_TOL:
        # net + moms must reconstruct gross; when it doesn't, none of the three
        # stored figures can be trusted on its own.
        return "moms_unknown_val"
    if abs(revenue_total) > TIE_TOL and abs(moms) <= TIE_TOL and moms_mode != "manual":
        # Auto mode cannot produce zero VAT on non-zero revenue. A 0,00 here is
        # a leftover from a save path that zeroed it, not a calculation — which
        # is exactly what the live document printed.
        return "moms_unknown_val"
    return None


def moms_is_unknown(dc: Any) -> bool:
    """True when this close's salgsmoms cannot honestly be stated."""
    return moms_unknown_key(dc) is not None


# ── ONE MOMS-rate rule — every artifact that names a VAT rate reads it ──────
#
# "Salgsmoms (25 %)" was printed over any figure: a manual 2.500 on 15.000 kr.
# (20 % of the base) carried the 25 % label on the kasserapport and in the lock
# mail, while the period PDF quietly dropped the rate for the same day. One
# predicate now says whether a close's MOMS IS the standard rate of its base,
# and one label function words it — by its source when a person typed it or
# read it off the Z-bon, with the rate it actually works out to when that is
# not the standard rate. Compared in KRONER (a rate tolerance loose enough for
# øre rounding on a small day swallows a real 242 kr. deviation on a big one).

MOMS_RATE_KR_TOL = 1.00


def vat_rate_for(currency: str) -> float:
    """The statutory rate for the owner's currency (DKK → 0,25)."""
    try:
        from app.services.tax_service import _get_vat_rate
        return float(_get_vat_rate(currency or "DKK"))
    except Exception:  # noqa: BLE001
        return 0.25


def moms_source(dc: Any) -> str:
    """'auto' (BonBox calculated it), 'zbon' (read off the Z-bon) or 'typed'."""
    if (getattr(dc, "moms_mode", None) or "auto").lower() != "manual":
        return "auto"
    raw = getattr(dc, "source_meta", None)
    kind = None
    if raw:
        try:
            import json as _json
            meta = raw if isinstance(raw, dict) else _json.loads(raw)
            kind = meta.get("kind") if isinstance(meta, dict) else None
        except Exception:  # noqa: BLE001
            kind = None
    if kind == "zbon" or (kind is None and getattr(dc, "receipt_photo", None)):
        return "zbon"
    return "typed"


def moms_rate_info(dc: Any, currency: str = "DKK",
                   balance: RevenueBalance | None = None) -> dict:
    """How this close's MOMS stands against the statutory rate.

    {"known": bool, "standard": bool | None, "mixed": bool,
     "effective_pct": float | None, "rate_pct": float}

    ``standard`` — the stored MOMS is the standard rate of the stored base
    (net × rate, within 1 kr.). For a BonBox-calculated figure on a net-price
    account the base is the revenue itself (rate × revenue) — that is the same
    rate, computed the other way round. ``mixed`` — known and NOT the standard
    rate: part of the day carries another rate (momsfri sales, a scanned Z-bon
    with two rates), so an unsplit part of the revenue cannot be verified.
    """
    rate = vat_rate_for(currency)
    out = {"known": False, "standard": None, "mixed": False,
           "effective_pct": None, "rate_pct": round(rate * 100, 1)}
    if moms_unknown_key(dc, balance) is not None:
        return out
    moms = _f(getattr(dc, "moms_total", None)) or 0.0
    rev = _f(getattr(dc, "revenue_total", None)) or 0.0
    ex = _f(getattr(dc, "revenue_ex_moms", None))
    if ex is None:
        ex = rev - moms
    out["known"] = True
    if abs(ex) > 0.005:
        out["effective_pct"] = round(moms / ex * 100.0, 1)
    if abs(rev) <= TIE_TOL and abs(moms) <= TIE_TOL:
        out["standard"] = True
        return out
    standard = abs(moms - ex * rate) <= MOMS_RATE_KR_TOL
    if not standard and moms_source(dc) == "auto":
        standard = abs(moms - rev * rate) <= MOMS_RATE_KR_TOL
    out["standard"] = standard
    out["mixed"] = not standard
    return out


def pct_text(pct: float | None, danish: bool = True) -> str:
    """'25 %' / '16,7 %' — whole numbers without a decimal."""
    if pct is None:
        return ""
    v = round(float(pct), 1)
    s = f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"
    return (s.replace(".", ",") if danish else s) + " %"


def moms_label(dc: Any, currency: str = "DKK", info: dict | None = None) -> str:
    """THE label for this close's salgsmoms — the kasserapport, the lock mail,
    the period PDF, the Excel and the CSV print exactly this for the same day.

      BonBox-calculated, standard rate   → "Salgsmoms (25 %)"
      read off the Z-bon / typed, 25 %   → "Salgsmoms (fra Z-bon)" / "(indtastet)"
      not the standard rate              → "Salgsmoms (fra Z-bon, svarer til 16,7 %)"
      cannot be stated                   → "Salgsmoms"
    """
    DA = (currency or "").upper() == "DKK"
    info = info or moms_rate_info(dc, currency)
    base = "Salgsmoms" if DA else "Output VAT"
    if not info["known"]:
        return base
    src = moms_source(dc)
    parts = []
    if src == "zbon":
        parts.append("fra Z-bon" if DA else "from the Z-report")
    elif src == "typed":
        parts.append("indtastet" if DA else "entered")
    if info["standard"]:
        if src == "auto":
            parts.append(pct_text(info["rate_pct"], DA))
    elif info["effective_pct"] is not None:
        parts.append(("svarer til " if DA else "equals ") + pct_text(info["effective_pct"], DA))
    return f"{base} ({', '.join(parts)})" if parts else base


def standard_moms_label(currency: str = "DKK") -> str:
    """The label of a BonBox-calculated standard-rate day ('Salgsmoms (25 %)')."""
    DA = (currency or "").upper() == "DKK"
    return f"{'Salgsmoms' if DA else 'Output VAT'} ({pct_text(vat_rate_for(currency) * 100, DA)})"


# ── The cash difference in words — one sentence, one full stop ──────────────

def cash_diff_words(diff: Any, currency: str = "DKK") -> str:
    """'Kassen mangler 180,00 kr.' / 'Der er 25,00 kr. for meget i kassen' /
    'Kassen stemmer' — the app's own words. No sentence-final punctuation is
    added here: a money token already ends in 'kr.', and 'kr..' was printed on
    every short day and in every copy mailed to the revisor."""
    DA = (currency or "").upper() == "DKK"
    d = _f(diff)
    if d is None:
        return ""
    if abs(d) < 0.005:
        return "Kassen stemmer" if DA else "Cash matches"
    amt = money_dk(abs(d), currency)
    if d < 0:
        return f"Kassen mangler {amt}" if DA else f"Cash short by {amt}"
    return f"Der er {amt} for meget i kassen" if DA else f"Cash over by {amt}"


def as_sentence(text: str) -> str:
    """End `text` with exactly one full stop."""
    t = (text or "").rstrip()
    if not t:
        return ""
    return t if t.endswith(".") else t + "."


def local_dt(dt: Any, tz: Any = None):
    """A naive-UTC timestamp in the venue's zone (Europe/Copenhagen unless the
    owner's zone is passed). The PDF printed raw UTC — two hours, and after
    22:00 UTC a calendar day, away from the app and the e-mail."""
    if dt is None:
        return None
    try:
        from datetime import timezone as _tz
        from zoneinfo import ZoneInfo
        zone = tz or ZoneInfo("Europe/Copenhagen")
        aware = dt if getattr(dt, "tzinfo", None) else dt.replace(tzinfo=_tz.utc)
        return aware.astimezone(zone)
    except Exception:  # noqa: BLE001
        return dt


def build_close_claims(
    dc: Any,
    *,
    currency: str = "DKK",
    profile: Any = None,
    business_name: str = "",
    has_bilag: bool = False,
    bilagsnummer: str = "",
    tz: Any = None,
) -> dict:
    """Everything the kasserapport asserts about `dc`, already rendered.

    Money values come back as display strings via the one shared formatter
    (``1.234,56 kr.``), or ``"—"`` where a figure is not known. Nothing in the
    returned structure is a placeholder to be filled in by the renderer.
    """
    DA = (currency or "").upper() == "DKK"
    L = close_labels(currency)

    def fmt(v: Any) -> str:
        return money_dk(v, currency)

    # ── A. Draft vs locked ────────────────────────────────────────────────
    # An owner genuinely wants to read the kasserapport BEFORE locking it —
    # that is how you check the day against the Z-report — so refusing to
    # export a draft would remove a real use. What must never happen is a
    # draft that READS as final. So a draft exports, marked KLADDE everywhere
    # it could be mistaken for the finished document.
    is_locked = (getattr(dc, "status", None) or "confirmed") == "confirmed"
    closed_at = getattr(dc, "closed_at", None) if is_locked else None

    # ── B. Arithmetic integrity ───────────────────────────────────────────
    rev = decode_breakdown(getattr(dc, "revenue_categories", None))
    revenue_total = _f(getattr(dc, "revenue_total", None)) or 0.0
    bal = RevenueBalance(rev, revenue_total)
    lines_sum = bal.lines_sum
    discrepancy = bal.discrepancy
    ties_out = bal.ties_out

    revenue_lines = []
    for k, v in rev.items():
        revenue_lines.append({
            "key": k,
            # Built-in key → the app's own Danish word ("food" → "Mad").
            # Owner-typed key → the owner's own words, verbatim.
            "label": revenue_category_label(k, danish=DA),
            "amount": fmt(v),
            "value": v,
            # A negative line is a correction and is labelled as one. An
            # unexplained negative "Omsætning" line is not something a revisor
            # should have to interpret — and B1 keeps it INSIDE the total.
            "is_correction": v < 0,
            "correction_tag": L["correction_tag"],
        })
    has_correction = any(line["is_correction"] for line in revenue_lines)

    # Payment lines get the SAME tie-out treatment as the revenue lines. They
    # did not before, and the gap was reachable through the flagship flow: the
    # Z-report scan writes card-brand keys (dankort/visa/…) into
    # payment_breakdown, the save path deliberately EXCLUDES those from
    # payment_total because they are a split of the card line — and this block
    # then printed them as peer lines above that total, so a close carrying
    # brand splits showed lines summing to far more than the stated total, with
    # nothing on the page saying so. Exactly the defect B2 names, in the same
    # document.
    payment = decode_breakdown(getattr(dc, "payment_categories", None))
    method_items, brand_items = [], []
    for k, v in payment.items():
        (brand_items if is_card_brand_key(k) else method_items).append((k, v))

    def _pay_line(k, v, *, brand=False):
        return {
            "key": k,
            "label": payment_method_label(k, danish=DA),
            "amount": fmt(v),
            "value": v,
            # A brand line is drawn indented under the card line and is NOT
            # counted towards the total — it is already inside it.
            "is_brand": brand,
        }

    payment_lines = []
    for k, v in method_items:
        payment_lines.append(_pay_line(k, v))
        if (k or "").strip().lower() == "card":
            payment_lines.extend(_pay_line(bk, bv, brand=True) for bk, bv in brand_items)
            brand_items = []
    # No card line to nest them under (or brands only) — still show them, still
    # marked as a split so they are never read as additional money.
    payment_lines.extend(_pay_line(bk, bv, brand=True) for bk, bv in brand_items)

    payment_total = _f(getattr(dc, "payment_total", None)) or 0.0
    pay_lines_sum = (
        round(sum(v for _k, v in method_items), 2) if method_items else None
    )
    pay_discrepancy = (
        round(payment_total - pay_lines_sum, 2) if pay_lines_sum is not None else 0.0
    )
    payment_ties_out = abs(pay_discrepancy) <= TIE_TOL

    # ── B2. Payments ↔ REVENUE — the comparison this document never made ──
    # `payment_ties_out` above is lines-vs-SUBTOTAL, and the save path writes
    # payment_total as the sum of exactly those lines (routers/daily_close.py:
    # `payment_total = sum(v for k, v in payment_breakdown ...)`), so for any
    # close saved through the app it compares a number with itself and always
    # passes. It cannot catch a wrong day.
    #
    # The comparison that can is payments vs REVENUE, which
    # services/daily_close_range_export.py has always run and this document
    # never did. That is how one stored row came to print a green KLAR TIL
    # BOGFØRING here and an amber flag there — and the owner sends this one.
    #
    # THREE outcomes. "Recorded and they do not match" is an accusation;
    # "never recorded" is not, and must not be branded as a discrepancy of the
    # entire day's revenue.
    payments_recorded = abs(payment_total) > PAY_RECORDED_TOL
    rev_pay_discrepancy = round(payment_total - revenue_total, 2)
    if not payments_recorded:
        payments_vs_revenue = "not_recorded"
    elif abs(rev_pay_discrepancy) <= PAY_RECON_TOL:
        payments_vs_revenue = "ok"
    else:
        payments_vs_revenue = "off"

    # ── C. MOMS honesty ───────────────────────────────────────────────────
    moms = _f(getattr(dc, "moms_total", None))
    ex_moms = _f(getattr(dc, "revenue_ex_moms", None))
    moms_mode = (getattr(dc, "moms_mode", None) or "auto").lower()

    unknown_key = moms_unknown_key(dc, bal)
    moms_unknown_reason = L[unknown_key] if unknown_key else None
    rate_info = moms_rate_info(dc, currency, bal)
    src = moms_source(dc)
    rate_txt = pct_text(rate_info["rate_pct"], DA)
    eff_txt = pct_text(rate_info["effective_pct"], DA)

    # Revenue no category carries — part of the day (a partial split) or all
    # of it (a total-only Z-bon). The SAME fact in both cases, so the SAME
    # line and the same verdict (see a_lines_unsplit / a_lines_mixed).
    if bal.contradicts:
        unallocated = None
    elif bal.has_lines:
        unallocated = discrepancy if bal.partial_split else None
    else:
        unallocated = revenue_total if abs(revenue_total) > TIE_TOL else None

    if moms_unknown_reason:
        moms_block = {
            # The gross figure is only in dispute when the lines CONTRADICT it.
            # An incomplete split leaves the total itself perfectly knowable.
            "incl": "—" if bal.contradicts else fmt(revenue_total),
            "vat": "—",
            "excl": "—",
        }
    else:
        moms_block = {
            "incl": fmt(revenue_total),
            "vat": fmt(moms),
            "excl": fmt(ex_moms if ex_moms is not None else revenue_total - moms),
        }

    # ── D. The assurance banner must be EARNED ────────────────────────────
    # Each line is derived from the row. A failed check is stated plainly, not
    # omitted — the whole value of the banner to a revisor is seeing what was
    # NOT done. The heading follows the body, so GENNEMGÅS can never sit over
    # a list of passes.
    assurance = None
    if is_locked:
        checks: list[dict] = []

        if moms_unknown_reason:
            checks.append({"ok": False, "text": L["a_moms_no"], "check": "moms"})
        elif src in ("zbon", "typed"):
            # Computed by a person (or read off the bon), not by BonBox — said
            # as such, with the rate the figure actually works out to.
            key = f"a_moms_{src}_{'std' if rate_info['standard'] else 'other'}"
            checks.append({"ok": True, "check": "moms",
                           "text": L[key].format(rate=rate_txt, eff=eff_txt or "—")})
        elif rate_info["standard"] is False and eff_txt:
            checks.append({"ok": True, "check": "moms",
                           "text": L["a_moms_auto_other"].format(rate=rate_txt, eff=eff_txt)})
        else:
            checks.append({"ok": True, "text": L["a_moms_auto"], "check": "moms"})

        # THREE outcomes, never two. `_f(...) or 0.0` used to turn a NULL
        # cash_difference into 0.00, which then sailed through the tolerance
        # and printed "Kontant optalt og afstemt." — a reconciliation that had
        # never run, asserted three lines under the page's own em-dash in the
        # KASSEBEHOLDNING block. cash_difference is NULL whenever there was no
        # expected figure to compare against (routers/daily_close.py), so
        # "couldn't check" is a real state and gets its own line.
        cash_counted = _f(getattr(dc, "cash_counted", None))
        cash_diff = _f(getattr(dc, "cash_difference", None))
        # No cash to count = payment lines are recorded, none of them is cash,
        # and no expected cash figure exists. A revenue-only close (no lines)
        # does not qualify: there it is unknown whether cash was taken.
        _cash_line = sum(float(v or 0) for k, v in method_items
                         if (k or "").strip().lower() == "cash")
        _cash_exp = _f(getattr(dc, "cash_expected", None))
        no_cash_sales = bool(method_items) and abs(_cash_line) < 0.005 and (
            _cash_exp is None or abs(_cash_exp) < 0.005)
        if cash_counted is None and no_cash_sales:
            checks.append({"ok": True, "info": True, "text": L["a_cash_na"], "check": "cash"})
        elif cash_counted is None:
            checks.append({"ok": False, "text": L["a_cash_none"], "check": "cash"})
        elif cash_diff is None:
            checks.append({"ok": False, "text": L["a_cash_nobase"], "check": "cash"})
        elif abs(cash_diff) <= TIE_TOL:
            checks.append({"ok": True, "text": L["a_cash_ok"], "check": "cash"})
        elif abs(cash_diff) <= CASH_TOL:
            signed = ("+" if cash_diff > 0 else "") + fmt(cash_diff)
            checks.append({"ok": True, "text": L["a_cash_tol"].format(amount=signed),
                           "check": "cash"})
        else:
            checks.append({"ok": False, "text": L["a_cash_off"], "check": "cash"})

        if has_bilag:
            checks.append({"ok": True, "text": L["a_bilag_ok"], "check": "bilag"})
        else:
            # Stated, but not a gate (see a_bilag_self).
            checks.append({
                "ok": True, "info": True, "check": "bilag",
                "text": (L["a_bilag_self"].format(bilag=bilagsnummer) if bilagsnummer
                         else L["a_bilag_none"]),
            })

        # The lines check. "✓ Omsætningslinjer stemmer" only when there ARE
        # lines and they tie out — never a pass for a check with nothing to
        # check. Revenue without a category, whether part of the day or all
        # of it, follows ONE rule: a note on a single-rate day, a failure on
        # a mixed-rate day (its MOMS cannot be verified). Lines that
        # contradict the total always fail.
        if bal.contradicts:
            checks.append({"ok": False, "text": L["a_lines_off"], "check": "lines"})
        elif unallocated is not None:
            if rate_info["mixed"]:
                rate_words = (
                    (f"svarer til {eff_txt}, ikke {rate_txt}" if DA
                     else f"is {eff_txt}, not {rate_txt}") if eff_txt
                    else (f"er ikke {rate_txt}" if DA else f"is not {rate_txt}")
                )
                checks.append({
                    "ok": False, "check": "lines",
                    "text": L["a_lines_mixed"].format(amount=fmt(unallocated), rate=rate_words),
                })
            else:
                checks.append({
                    "ok": True, "info": True, "check": "lines",
                    "text": L["a_lines_unsplit"].format(amount=fmt(unallocated)),
                })
        elif bal.has_lines and ties_out:
            checks.append({"ok": True, "text": L["a_lines_ok"], "check": "lines"})

        if method_items:
            checks.append({
                "ok": payment_ties_out,
                "text": L["a_pay_ok"] if payment_ties_out else L["a_pay_off"],
                "check": "payments",
            })

        # THE SIXTH CHECK — payments against REVENUE, which the range export
        # has always run and this one never did.
        #
        # Only the RECORDED cases are asserted here. "not_recorded" is
        # deliberately left out of the band rather than failed: branding a
        # revenue-only close as out-by-17.030 kr would be the same false
        # accusation this whole change is removing from the dashboard, one
        # document over — and whether a Z-report-only close should be allowed
        # to read "klar til bogføring" at all is a call about what BonBox
        # certifies to a revisor, not a bug to decide inside a helper. It is
        # still reported as data below, so the decision has evidence when it
        # is made.
        if payments_vs_revenue == "ok":
            checks.append({
                "ok": True,
                "text": L["a_rev_pay_ok"],
                "check": "payments_vs_revenue",
            })
        elif payments_vs_revenue == "off":
            checks.append({
                "ok": False,
                "text": L["a_rev_pay_off"].format(amount=fmt(abs(rev_pay_discrepancy))),
                "check": "payments_vs_revenue",
            })

        all_ok = all(c["ok"] for c in checks if not c.get("info"))
        assurance = {
            "heading": L["ready"] if all_ok else L["review"],
            "all_ok": all_ok,
            "checks": checks,
            # The failing lines in order — what every other artifact (Excel,
            # CSV, the mail) prints after "Gennemgås", word for word.
            "failing": [c["text"] for c in checks if not c["ok"] and not c.get("info")],
            # Reported even when it does not gate the heading — "ok" / "off" /
            # "not_recorded". A caller (or a founder deciding whether a
            # revenue-only close may be certified book-ready) can see the third
            # state instead of inferring it from a missing check.
            "payments_vs_revenue": payments_vs_revenue,
            "payments_recorded": payments_recorded,
        }

    # ── E. Footer — a label with no value is not a claim ──────────────────
    footer_parts = [L["footer_gen"]]
    locked_local = local_dt(closed_at, tz) if closed_at is not None else None
    if locked_local is not None:
        footer_parts.append(
            f"{L['locked_at']} {locked_local.strftime('%d.%m.%Y kl. %H:%M') if DA else locked_local.strftime('%d %b %Y %H:%M')}"
        )
    elif not is_locked:
        footer_parts.append(L["not_locked"])
    footer_parts.append(L["footer_use"])
    if is_locked:
        # The retention duty, on the document a revisor files. Without a §
        # number: the 2022 act renumbered it, and a wrong citation is worse.
        footer_parts.append(L["retention"])

    close_date = getattr(dc, "date", None)
    iso = close_date.isoformat() if close_date else "ukendt"

    return {
        "labels": L,
        "danish": DA,
        "currency": currency,
        "is_locked": is_locked,
        "title": L["title"] if is_locked else f"{L['title']} — {L['draft_mark']}",
        "draft_banner": None if is_locked else L["draft_banner"],
        "draft_mark": None if is_locked else L["draft_mark"],
        "business_name": business_name or "—",
        # One shared composer — every artifact used to hand-roll this join and
        # print "…, 2500 Valby, 2500 Valby".
        "address_line": compose_business_address(profile) if profile else "",
        "revenue_lines": revenue_lines,
        "has_correction": has_correction,
        # The footnote that explains the negative lines — and which only claims
        # they are inside the total when the page actually adds up.
        "correction_note": (
            (L["correction_note"] if ties_out else L["correction_note_unbalanced"])
            if has_correction else None
        ),
        # Only rendered when it disagrees with the total — when the lines tie
        # out, repeating their sum above the total is noise. Everything in this
        # structure is what the page actually shows.
        "lines_sum": fmt(lines_sum) if (lines_sum is not None and not ties_out) else None,
        "revenue_ties_out": ties_out,
        "revenue_partial_split": bal.partial_split,
        "revenue_contradicts_total": bal.contradicts,
        "discrepancy": None if ties_out else fmt(discrepancy),
        "discrepancy_value": None if ties_out else discrepancy,
        # An incomplete split and a contradiction are different facts and the
        # page says so in different words — and in a different colour, which is
        # why the tone travels with the claim rather than being decided by the
        # renderer.
        "discrepancy_label": (
            None if ties_out
            else (L["unallocated"] if bal.partial_split else L["discrepancy"])
        ),
        "discrepancy_note": (
            None if ties_out
            else ((L["unallocated_mixed_note"] if rate_info["mixed"] else L["unallocated_note"])
                  if bal.partial_split else L["discrepancy_note"])
        ),
        # Muted for a note, amber when it gates: a contradiction, or revenue
        # without a category on a mixed-rate day.
        "discrepancy_tone": (
            None if ties_out
            else ("amber" if (bal.contradicts or rate_info["mixed"]) else "muted")
        ),
        # A total-only close (no lines at all) shows the same "Ikke fordelt på
        # kategori" line the partial split shows — the OMSÆTNING block used to
        # vanish, so the two looked like different kinds of day.
        "unsplit_total": (
            fmt(unallocated) if (unallocated is not None and not bal.has_lines) else None
        ),
        "unsplit_note": (
            (L["unallocated_mixed_note"] if rate_info["mixed"] else L["unsplit_note"])
            if (unallocated is not None and not bal.has_lines) else None
        ),
        "unsplit_tone": (
            ("amber" if rate_info["mixed"] else "muted")
            if (unallocated is not None and not bal.has_lines) else None
        ),
        "unallocated_value": unallocated,
        "total_revenue": fmt(revenue_total),
        "payment_lines": payment_lines,
        "payment_ties_out": payment_ties_out,
        "payment_lines_sum": (
            fmt(pay_lines_sum)
            if (pay_lines_sum is not None and not payment_ties_out) else None
        ),
        "payment_discrepancy": None if payment_ties_out else fmt(pay_discrepancy),
        "payment_discrepancy_note": (
            None if payment_ties_out else L["pay_discrepancy_note"]
        ),
        "has_card_brands": any(line["is_brand"] for line in payment_lines),
        "brand_note": (
            L["brand_note"] if any(line["is_brand"] for line in payment_lines)
            else None
        ),
        "total_payment": fmt(payment_total),
        "moms": moms_block,
        "moms_unknown_reason": moms_unknown_reason,
        # The ONE label rule (moms_label) — never "25 %" over a figure that is
        # not 25 % of the base.
        "moms_label": moms_label(dc, currency, rate_info),
        "moms_rate": rate_info,
        "moms_source": src,
        # Stated, but with its basis named. Not a warning — the figure is
        # sound; the reader is simply told the lines above do not itemise all
        # of what it was computed on.
        "moms_basis_note": (
            L["moms_from_total"]
            if (bal.partial_split and not moms_unknown_reason) else None
        ),
        "moms_manual_note": (
            (L["moms_zbon"] if src == "zbon" else L["moms_typed"])
            + (L["moms_other_rate"].format(eff=eff_txt, rate=rate_txt)
               if (rate_info["mixed"] and eff_txt) else "")
            if (src != "auto" and not moms_unknown_reason)
            else (L["moms_other_rate"].format(eff=eff_txt, rate=rate_txt).strip()
                  if (rate_info["mixed"] and eff_txt and not moms_unknown_reason) else None)
        ),
        "assurance": assurance,
        "locked_at_local": locked_local,
        "footer": " · ".join(footer_parts),
        # The filename must not imply finality either — a kladde downloaded,
        # mailed on and opened a week later is identified by its name alone.
        "filename": (
            f"kasserapport_{iso}.pdf" if is_locked
            else f"kasserapport_kladde_{iso}.pdf"
        ),
    }


# ── One readiness verdict for every artifact ─────────────────────────────────

def close_readiness(dc: Any, currency: str = "DKK", *, has_bilag: bool = False) -> dict:
    """The kasserapport's own verdict for `dc`, for the artifacts that print
    it without drawing the band — the period PDF badge, the Excel and CSV
    "Bogføring" column and the lock mail. Derived by build_close_claims, so a
    day can never read KLAR in one place and GENNEMGÅS in another.

    {"locked": bool, "ready": bool | None, "heading": str | None,
     "failing": [str]} — ready/heading are None for a draft (no verdict)."""
    c = build_close_claims(dc, currency=currency, has_bilag=has_bilag)
    a = c["assurance"]
    if not a:
        return {"locked": False, "ready": None, "heading": None, "failing": []}
    return {"locked": True, "ready": bool(a["all_ok"]), "heading": a["heading"],
            "failing": list(a.get("failing") or [])}


def readiness_text(dc: Any, currency: str = "DKK", *, verdict: dict | None = None) -> str:
    """'Klar til bogføring' / 'Gennemgås: Kontant optalt — …' / '' (a draft)
    — the cell the Excel and the CSV print, in the band's own words."""
    DA = (currency or "").upper() == "DKK"
    v = verdict or close_readiness(dc, currency)
    if not v["locked"]:
        return ""
    if v["ready"]:
        return "Klar til bogføring" if DA else "Ready for bookkeeping"
    reasons = "; ".join(t.rstrip(".") for t in v["failing"])
    lead = "Gennemgås" if DA else "Needs review"
    return f"{lead}: {reasons}" if reasons else lead
