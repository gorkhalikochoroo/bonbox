"""Which of the numbers on this receipt is actually the total?

The regex OCR path picks the LARGEST number that looks like a total.
On a Danish cash receipt that is frequently wrong, because the biggest
figures on the paper are usually not the total at all:

    AT BETALE      52,05     <- the total
    KONTANT       200,00     <- what the customer handed over
    BYTTEPENGE    146,00     <- the change

The labelled pattern normally rescues it. But thermal paper creases, and
a garbled "A7 BETA1E" drops the parser onto its max() fallback — which
then books 200,00 as the expense. Reproduced on the receipt this was
reported from: a 4x overstatement, with a bilag and a MOMS claim
attached to it.

No confidence score can catch that. The OCR is not unsure; it read the
digits correctly and picked the wrong line.

THE RECEIPT ALREADY CONTAINS THE ANSWER
It prints its own MOMS ("HERAF MOMS 10,41"), and MOMS only makes sense
against the real total:

    52,05 -> 10,41 / 41,64 = 25,00%   a legal DK rate
   200,00 -> 10,41 / 189,59 = 5,49%   impossible
   146,00 -> 10,41 / 135,59 = 7,68%   impossible

The line items sum to 52,05 too. So the paper disproves three of its own
four candidates without us guessing anything.

This module scores candidates against that evidence. It does NOT invent
a total: when the evidence cannot single one out, it says so and the
owner picks. Silently choosing the least-bad option is how a wrong
figure gets a voucher number.
"""

from __future__ import annotations

from dataclasses import dataclass

# Danish VAT rates a receipt can legitimately imply. 0.25 is the standard
# rate; 0 covers zero-rated and non-registered vendors.
_LEGAL_DK_RATES = (0.25, 0.0)

# How far an implied rate may sit from a legal one. Wide enough for
# øre-rounding on a small receipt, tight enough that 5,49% is rejected.
_RATE_TOLERANCE = 0.02

# Line-item sums are kroner-exact when they're right, but OCR drops the
# odd line, so this only ever CONFIRMS a candidate — never rejects one.
_SUM_TOLERANCE_KR = 0.05


@dataclass(frozen=True)
class AmountVerdict:
    amount: float | None       # None => we could not tell; ask the owner
    confident: bool
    reason: str                # plain-language, for the UI and the log
    alternates: list[float]    # what to offer when we can't decide


def _implied_rate(total: float, vat: float) -> float | None:
    net = total - vat
    if net <= 0:
        return None
    return vat / net


def _vat_supports(total: float, vat: float | None) -> bool | None:
    """True/False when the receipt's MOMS can judge this candidate,
    None when there is no MOMS figure to judge it with."""
    if vat is None or total <= 0:
        return None
    if vat == 0:
        # A zero-MOMS receipt tells us nothing about which total is right.
        return None
    rate = _implied_rate(total, vat)
    if rate is None:
        return False
    return any(abs(rate - legal) <= _RATE_TOLERANCE for legal in _LEGAL_DK_RATES)


def reconcile_amount(
    candidates: list[float],
    *,
    chosen: float | None = None,
    vat_amount: float | None = None,
    line_items: list[dict] | None = None,
) -> AmountVerdict:
    """Pick the total the receipt's own figures support.

    `chosen` is what the parser proposed. It wins whenever the evidence
    doesn't contradict it — this is a safety net, not a second opinion
    that overrides a provider which read the paper properly.
    """
    cands = sorted({round(float(c), 2) for c in (candidates or []) if c and float(c) > 0}, reverse=True)
    if chosen and round(float(chosen), 2) not in cands:
        cands.append(round(float(chosen), 2))
        cands.sort(reverse=True)
    if not cands:
        return AmountVerdict(None, False, "no_candidates", [])

    items_sum = None
    if line_items:
        amounts = [
            float(i.get("amount"))
            for i in line_items
            if isinstance(i, dict) and isinstance(i.get("amount"), (int, float))
        ]
        if amounts:
            items_sum = round(sum(amounts), 2)

    supported = [c for c in cands if _vat_supports(c, vat_amount) is True]
    contradicted = {c for c in cands if _vat_supports(c, vat_amount) is False}

    # 1. The receipt's own MOMS singles out exactly one candidate.
    if len(supported) == 1:
        return AmountVerdict(supported[0], True, "vat_confirms", [])

    # 2. MOMS narrows it and the line items agree with one of the
    #    survivors — two independent figures on the same paper.
    #
    # OCR routinely emits near-duplicates of the same figure (a real
    # receipt yields both 52,05 and 52,0), and the rate check passes
    # both. The line-item sum is exact when it is right, so the CLOSEST
    # candidate wins outright rather than the pair reading as ambiguous
    # — but only if it is unambiguously closest.
    if items_sum is not None:
        agree = sorted(
            (c for c in (supported or cands) if abs(c - items_sum) <= _SUM_TOLERANCE_KR),
            key=lambda c: abs(c - items_sum),
        )
        if len(agree) == 1 or (
            len(agree) > 1 and abs(agree[0] - items_sum) < abs(agree[1] - items_sum)
        ):
            return AmountVerdict(agree[0], True, "vat_and_lines_confirm" if supported else "lines_confirm", [])

    # 3. No MOMS to judge with — keep what the parser chose, but say the
    #    evidence is absent rather than implying it was checked.
    if not supported and not contradicted:
        if chosen:
            return AmountVerdict(round(float(chosen), 2), False, "unverified", cands[:5])
        return AmountVerdict(None, False, "unverified", cands[:5])

    # 4. The MOMS actively contradicts what the parser picked. This is the
    #    creased-receipt case: it chose the cash tendered. Never silently
    #    substitute — the owner is looking at the paper, we are not.
    if chosen and round(float(chosen), 2) in contradicted:
        return AmountVerdict(
            supported[0] if len(supported) == 1 else None,
            False,
            "vat_contradicts_choice",
            (supported or [c for c in cands if c not in contradicted])[:5],
        )

    return AmountVerdict(
        round(float(chosen), 2) if chosen else None,
        False,
        "ambiguous",
        (supported or cands)[:5],
    )
