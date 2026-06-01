"""Deterministic cross-checks on an extracted kasserapport (Z-report).

A vision model can misread a dense Danish POS day-close: grab a recurring
varegruppe/department code (e.g. "1012 - Hvidvin") as the day total, read a
cumulative "siden start" counter, or transpose digits. These checks are the
bookkeeper's eye in code — they do NOT trust the model's self-reported
confidence, they verify the numbers are *internally consistent*:

  • MOMS can never exceed revenue            (HARD — impossible; blanks totals)
  • Revenue categories can't exceed the total (SOFT — flag)
  • No single payment line exceeds the total  (SOFT — flag; catches the
                                               "tiny total under a big payment
                                               line" misread independently)

Failed checks lower a derived consistency score, optionally blank the
implausible field(s) so the money form never prefills a known-wrong number,
and are recorded in `validator_failures` so the admin training review can
see *which* reports fail and *why* — the signal that drives prompt / format
improvements as real reports flow in.

Pure + deterministic: no I/O, no model calls, no DB. Trivially unit-testable
and cheap to run on every scan.

Deliberately conservative in v1 — only checks with a very low false-positive
rate are active. MOMS-rate consistency, cash-denomination↔counted, and
per-clerk↔total reconciliation are DEFERRED to v2: their correct tolerances
are POS-format-specific, and we'd rather calibrate them against the real
persisted extractions (Layer 2) than ship a check that cries wolf. A check
that fires on a correct report erodes trust as fast as a missed misread.
"""

# Tolerances ───────────────────────────────────────────────────────────────
# MOMS strictly cannot exceed revenue (whether revenue is net → moms = 25% of
# it, or gross → moms = 20% of it; moms is always a fraction). The 1.02 epsilon
# only guards against pathological rounding when both are near zero.
_MOMS_OVER_REVENUE_EPS = 1.02
# Revenue categories (food + drinks + other) summing past the total means a
# category was misread. 10% headroom + an absolute floor avoid tripping on
# rounding / a tips line accidentally folded in.
_BREAKDOWN_OVER_REVENUE_FACTOR = 1.10
_ABS_FLOOR_KR = 5.0
# A single payment line can't exceed the day total (plus a little tip /
# rounding headroom). Comparing the MAX single method — never a SUM — sidesteps
# the softpay / betalingskort / card-sub-brand double-counting that differs per
# POS, so it won't false-positive on a normal multi-method report. It still
# catches the "tiny total (a varegruppe code) under a real payment line"
# misread — e.g. revenue 1.012 under a softpay line of 14.249.
_PAYMENT_OVER_REVENUE_FACTOR = 1.5

# Severity penalties feeding the derived consistency score.
_PENALTY_HARD = 0.45
_PENALTY_SOFT = 0.15


def _num(v):
    """Coerce to float, or None if not a finite number."""
    if isinstance(v, bool):  # bool is an int subclass — exclude it
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def reconcile_z_report(ext: dict) -> dict:
    """Run the cross-checks on a validated Z-report extraction dict.

    Args:
      ext: the in-progress validated dict (revenue_total, moms_total,
           revenue_breakdown, payment_breakdown, ...).

    Returns dict:
      validator_failures: list[str]  — human-readable "code: detail" lines
      failure_codes:      list[str]  — just the codes (programmatic checks)
      consistency_score:  float      — 0..1 derived from the checks
      fields_to_blank:    list[str]  — fields the caller should null out
      manual_review_needed: bool
      note:               str        — concise owner-facing "verify this" line
    """
    failures: list[str] = []
    codes: list[str] = []
    fields_to_blank: list[str] = []
    n_hard = 0
    n_soft = 0

    rt = _num(ext.get("revenue_total"))
    mt = _num(ext.get("moms_total"))
    rb = ext.get("revenue_breakdown") or {}
    pb = ext.get("payment_breakdown") or {}

    # 1 ─ HARD: MOMS must not exceed revenue. Impossible for any VAT rate;
    #     the classic cause is a recurring varegruppe code read as the total.
    #     We can't tell which figure is the misread one, so blank BOTH and
    #     ask the owner — never prefill a confident-but-impossible number.
    if rt is not None and mt is not None and mt > rt * _MOMS_OVER_REVENUE_EPS:
        n_hard += 1
        codes.append("moms_exceeds_revenue")
        failures.append(
            f"moms_exceeds_revenue: MOMS {mt:.2f} > revenue {rt:.2f} "
            "(impossible — likely a varegruppe code read as the day total)"
        )
        fields_to_blank.extend(["revenue_total", "moms_total"])

    # 2 ─ SOFT: revenue categories can't sum past the day total.
    if rt is not None and rt > 0:
        cat_sum = sum(
            _num(rb.get(k)) or 0.0 for k in ("food", "drinks", "other")
        )
        if cat_sum > rt * _BREAKDOWN_OVER_REVENUE_FACTOR and (cat_sum - rt) > _ABS_FLOOR_KR:
            n_soft += 1
            codes.append("breakdown_exceeds_revenue")
            failures.append(
                f"breakdown_exceeds_revenue: categories sum {cat_sum:.2f} > "
                f"revenue {rt:.2f} — a category was likely misread"
            )

    # 3 ─ SOFT: no single payment line can exceed the day total (+ a little
    #     tip / rounding headroom). Uses the MAX single method — never a SUM —
    #     to sidestep the softpay / betalingskort / sub-brand double-counting
    #     that differs per POS, so it won't false-positive on a normal multi-
    #     method report. Flag-only (never auto-blank): which figure is wrong
    #     is ambiguous, but it independently catches the "tiny total (a
    #     varegruppe code) under a real payment line" misread.
    if rt is not None and rt > 0:
        pay_vals = [
            _num(pb.get(k))
            for k in ("cash", "card", "softpay", "visa", "mastercard", "dankort", "mobilepay", "faktura")
        ]
        pay_vals = [v for v in pay_vals if v is not None and v > 0]
        if pay_vals:
            biggest = max(pay_vals)
            if biggest > rt * _PAYMENT_OVER_REVENUE_FACTOR:
                n_soft += 1
                codes.append("payment_exceeds_revenue")
                failures.append(
                    f"payment_exceeds_revenue: a payment line {biggest:.2f} "
                    f"exceeds revenue {rt:.2f} — verify the day total"
                )

    consistency_score = max(
        0.0, 1.0 - _PENALTY_HARD * n_hard - _PENALTY_SOFT * n_soft
    )
    manual_review_needed = (n_hard > 0) or (n_soft > 0) or consistency_score < 0.6

    if "moms_exceeds_revenue" in codes:
        note = (
            "Day total and MOMS were inconsistent (MOMS exceeded revenue) — "
            "totals left blank to avoid a wrong figure; please enter the "
            "day's Total and MOMS from the report manually."
        )
    elif failures:
        note = (
            "Some figures looked inconsistent — please double-check the "
            "highlighted values before saving."
        )
    else:
        note = ""

    return {
        "validator_failures": failures,
        "failure_codes": codes,
        "consistency_score": round(consistency_score, 3),
        "fields_to_blank": fields_to_blank,
        "manual_review_needed": manual_review_needed,
        "note": note,
    }
