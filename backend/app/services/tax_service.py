"""
Tax Autopilot Service — track deadlines, estimate amounts, generate reminders.

Uses country/currency to determine tax type, rates, and filing schedule.
Calculates estimated VAT/GST payable from actual sales & expense data.
"""

import logging
from datetime import date, datetime, time, timedelta
from dateutil.relativedelta import relativedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.daily_close import DailyClose, decode_breakdown
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.invoice import Invoice
from app.services.dk_fradrag import fradrag_factor
from app.services.expense_status import not_pending

logger = logging.getLogger(__name__)


# ─── Tax Calendar by Currency ───────────────────────────────────
# Each entry: { tax_type, name, rate, frequency, deadlines_func }

VAT_RATES = {
    "DKK": 0.25,       # Denmark Moms 25%
    "SEK": 0.25,       # Sweden Moms 25%
    "NOK": 0.25,       # Norway MVA 25%
    "EUR": 0.21,       # EU default (when country not specified)
    "EUR_PT": 0.23,    # Portugal IVA 23%
    "EUR_DE": 0.19,    # Germany MwSt 19%
    "EUR_FR": 0.20,    # France TVA 20%
    "EUR_ES": 0.21,    # Spain IVA 21%
    "EUR_IT": 0.22,    # Italy IVA 22%
    "EUR_NL": 0.21,    # Netherlands BTW 21%
    "GBP": 0.20,       # UK VAT 20%
    "USD": 0.0,        # US has no federal VAT (sales tax varies by state)
    "NPR": 0.13,       # Nepal VAT 13%
    "INR": 0.18,       # India GST 18% (default; varies 0/5/12/18/28%)
    "JPY": 0.10,       # Japan consumption tax 10%
    "AUD": 0.10,       # Australia GST 10%
    "CAD": 0.05,       # Canada GST 5% (provinces add HST/PST)
    "CHF": 0.081,      # Switzerland MWST 8.1%
}

# How many months a single filing period covers, by frequency.
# (DK monthly: needed for businesses with revenue > 50M kr — rare for our market
# but supported for completeness.)
PERIOD_MONTHS = {
    "monthly": 1,
    "bimonthly": 2,
    "quarterly": 3,
    "half_yearly": 6,
}

# Tax authority + filing config, per currency. Each entry can have multiple
# filing frequencies; the user (or default) picks one. Deadlines are
# (month, day) tuples in the year FOLLOWING the period — e.g. for DK
# half-yearly H1 (Jan–Jun) is reported by Sep 1 of the SAME year.
#
# Important: deadlines list a YEAR-AGNOSTIC pattern. The period that each
# deadline reports is derived dynamically from (deadline - period_months)
# in `_derive_period`, NOT from a separate quarter_map. The previous
# quarter_map approach silently mapped wrong periods to deadlines (e.g.
# Mar 1 → "Q1 of same year", which is impossible because Q1 isn't done by
# Mar 1). This was the root of "Tax Autopilot shows wrong amounts".
TAX_CONFIG = {
    "DKK": {
        # DK terminology lock: `MOMS` is the brand-style standalone term
        # that drives every DK-context label (Tax Autopilot tiles, alert
        # titles, "Next MOMS Filing", "Output MOMS" / "Input MOMS" table
        # headers, etc.). Sentence-case "Moms" stays only inside idiomatic
        # Danish noun phrases like "Salg inkl. moms" — those live in
        # `currency.js` VAT_TERMS as separate tokens. SEK keeps lowercase
        # "Moms" because Swedish convention is sentence-case there.
        "tax_name": "MOMS",
        "authority": "SKAT (skat.dk)",
        "rate": 0.25,
        # Default frequency for new DK signups. SMBs with rev < 5M kr are
        # required to file half-yearly; quarterly is the legal threshold band
        # 5M–50M kr. We default to half_yearly because BonBox targets SMBs.
        "default_frequency": "half_yearly",
        "frequencies": {
            # Half-yearly: H1 (Jan–Jun) due Sep 1, H2 (Jul–Dec) due Mar 1 next year.
            "half_yearly": [(3, 1), (9, 1)],
            # Quarterly: Q4 prev → Mar 1, Q1 → Jun 1, Q2 → Sep 1, Q3 → Dec 1.
            "quarterly":  [(3, 1), (6, 1), (9, 1), (12, 1)],
            # Monthly: 25th of following month (rare for DK; large enterprises only).
            "monthly":    "25th",
        },
    },
    "SEK": {
        "tax_name": "Moms",
        "authority": "Skatteverket",
        "rate": 0.25,
        "default_frequency": "quarterly",
        "frequencies": {
            "quarterly": [(2, 12), (5, 12), (8, 17), (11, 12)],
        },
    },
    "NOK": {
        "tax_name": "MVA",
        "authority": "Skatteetaten",
        "rate": 0.25,
        "default_frequency": "bimonthly",
        "frequencies": {
            "bimonthly": [(4, 10), (6, 10), (8, 31), (10, 10), (12, 10), (2, 10)],
        },
    },
    "NPR": {
        "tax_name": "VAT",
        "authority": "IRD Nepal",
        "rate": 0.13,
        "default_frequency": "monthly",
        "frequencies": {"monthly": "25th"},
    },
    "INR": {
        "tax_name": "GST",
        "authority": "GSTN",
        "rate": 0.18,
        "default_frequency": "monthly",
        "frequencies": {"monthly": "20th"},
    },
    "GBP": {
        "tax_name": "VAT",
        "authority": "HMRC",
        "rate": 0.20,
        "default_frequency": "quarterly",
        "frequencies": {
            "quarterly": [(5, 7), (8, 7), (11, 7), (2, 7)],
        },
    },
}


def _get_vat_rate(currency: str) -> float:
    return VAT_RATES.get(currency, 0.13)


def _last_day_of_month(yr: int, m: int) -> date:
    """Return the last calendar day of (year, month)."""
    first_of_next = date(yr, m, 1) + relativedelta(months=1)
    return first_of_next - timedelta(days=1)


def _is_period_boundary_month(month: int, frequency: str) -> bool:
    """True if `month` is the last month of a filing period for this frequency."""
    if frequency == "monthly":
        return True
    if frequency == "bimonthly":
        return month % 2 == 0  # Feb, Apr, Jun, Aug, Oct, Dec
    if frequency == "quarterly":
        return month in (3, 6, 9, 12)
    if frequency == "half_yearly":
        return month in (6, 12)
    return False


def _derive_period(deadline: date, frequency: str) -> tuple[date, date, str]:
    """
    Given a deadline date and the filing frequency, compute the (period_start,
    period_end, label) that the deadline reports.

    Rule: walk back month-by-month from the deadline and stop at the first
    period-boundary month. The period ends on the LAST day of that month,
    and starts (period_months - 1) months earlier. This handles every
    jurisdiction's buffer (DK ~2 months, NPR ~25 days, NOK ~40 days)
    without hardcoding offsets — boundaries are universal.

    Examples (DK):
      Mar 1 2026 quarterly  → period Q4 2025 (Oct 1 → Dec 31, 2025)
      Jun 1 2026 quarterly  → Q1 2026 (Jan 1 → Mar 31)
      Sep 1 2026 half_yearly → H1 2026 (Jan 1 → Jun 30)
      Mar 1 2026 half_yearly → H2 2025 (Jul 1 → Dec 31, 2025)
    """
    months = PERIOD_MONTHS.get(frequency, 3)
    # Walk back from deadline until we find a period boundary that's strictly
    # before the deadline. Cap at 14 months to avoid infinite loops on
    # malformed input.
    cur = date(deadline.year, deadline.month, 1)
    for _ in range(14):
        cur = cur - relativedelta(months=1)
        if not _is_period_boundary_month(cur.month, frequency):
            continue
        candidate_end = _last_day_of_month(cur.year, cur.month)
        if candidate_end < deadline:
            period_end = candidate_end
            period_start = date(cur.year, cur.month, 1) - relativedelta(months=months - 1)
            break
    else:
        # Shouldn't happen but degrade gracefully
        period_end = deadline - timedelta(days=1)
        period_start = period_end - relativedelta(months=months) + timedelta(days=1)

    # Label
    if months == 1:
        label = period_start.strftime("%B %Y")
    elif months == 6 and period_start.month in (1, 7):
        h = "H1" if period_start.month == 1 else "H2"
        label = f"{h} {period_start.year}"
    elif months == 3 and period_start.month in (1, 4, 7, 10):
        q = (period_start.month - 1) // 3 + 1
        label = f"Q{q} {period_start.year}"
    else:
        label = f"{period_start.strftime('%b')}–{period_end.strftime('%b %Y')}"
    return period_start, period_end, label


def _resolve_frequency(user, config: dict) -> str:
    """Pick filing frequency: explicit user override, else currency default."""
    explicit = getattr(user, "tax_filing_frequency", None)
    if explicit and explicit in (config.get("frequencies") or {}):
        return explicit
    return config.get("default_frequency", "quarterly")


def _calc_vat(db: Session, user_id, start_date: date, end_date: date,
              vat_rate: float, prices_include_moms: bool = True) -> dict:
    """
    Calculate VAT for a period — three revenue streams:

      1. POS sales (Sale table). Cash basis-ish at the data layer
         but treated as accrual for VAT (DK doesn't allow cash basis
         for Moms above 5M kr/yr — vanishingly few BonBox users).
         FILTER: invoice_id IS NULL — exclude sales that are payment
         receipts for fakturaer. The Invoice is the source of truth
         for that revenue; counting the Sale too would double-count.

      2. Daily Close (DailyClose table). End-of-shift kasserapport
         scan or manual close form. The kasserapport's revenue_total
         lands here and never reaches Sale rows. For owners without
         integrated POS (most DK cafés/retail), this IS the POS
         source-of-truth — Sale rows are 0 or sparse. Per-date
         precedence with stream 1: a confirmed close on date D wins
         over Sale rows on D (Sale rows are assumed already reflected
         in the close total — owner closes against the same till
         the sales rang up on). Only confirmed closes count; drafts
         are working-copy and excluded from filing.

      3. Faktura revenue (Invoice table). Accrual basis, recognized
         on issue_date per Bogføringsloven. Status >= 'sent', no
         drafts (drafts aren't real outgoing vouchers yet). Includes
         kreditnotaer with their already-negative totals so the period
         net is correct.

    Why three streams: BonBox supports POS-style businesses
    (café/restaurant — Sale OR DailyClose) and faktura-style
    businesses (event organizer, freelancer — Invoice). Most have a
    mix. Without the per-date dedup, an owner who logs Quick Sales
    AND closes the day with a Z-report would double-count their
    revenue (and MOMS) for that day.

    prices_include_moms determines the POS extraction formula
    (applied to both Sale rows AND close.revenue_total when
    close.moms_total is null — owners may not have keyed MOMS
    explicitly in the close form):
      - True  (B2C — café, retail; the customer's receipt amount):
              VAT = gross * rate / (1 + rate)
              Net = gross / (1 + rate)
      - False (B2B — net invoicing; price excludes VAT):
              VAT = net * rate
              Gross = net * (1 + rate)
    When DailyClose.moms_total IS set (owner keyed it OR OCR
    extracted it), that value is used directly instead of the
    formula — preserves owner intent / accountant override.
    Invoices always store net + moms separately, so they're rendered
    directly without the prices_include_moms toggle.
    """
    # ─── Stream 2 (DailyClose) — pull first so we can dedup Stream 1
    #
    # Pull ALL closes in the window (confirmed + drafts), partition in
    # Python: confirmed rows feed the headline math (Bogføringsloven §10
    # requires an immutable record, so only confirmed counts toward the
    # filing). Drafts + manual-mode counts surface separately for the
    # reconciliation card.
    #
    # Refactored 2026-05-28 to subsume the old _calc_daily_close_vat
    # helper — single query, single iteration, same numbers. Audit a26d37c
    # → A4: the standalone helper was producing the same totals by
    # construction, with drift risk if either filter changed.
    close_rows = (
        db.query(
            DailyClose.date,
            DailyClose.revenue_total,
            DailyClose.moms_total,
            DailyClose.revenue_ex_moms,
            DailyClose.status,
            DailyClose.moms_mode,
        )
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.date >= start_date,
            DailyClose.date < end_date,
            DailyClose.is_deleted.isnot(True),
        )
        .all()
    )

    close_dates: set[date] = set()  # confirmed only — for Stream-1 dedup
    close_pos_revenue = 0.0
    close_pos_moms = 0.0
    closes_confirmed_count = 0
    closes_draft_count = 0
    closes_manual_count = 0
    close_revenue_ex_moms_total = 0.0
    # Track close revenue per date for Bogføringsloven §9 stk. 2 variance
    # detection below — when a close exists AND Sale rows exist on the
    # same date with materially different totals, a revisor needs to see
    # that the entries don't reconcile to source.
    close_revenue_by_date: dict[date, float] = {}

    for d, rev, moms, rev_ex, status, mode in close_rows:
        status_norm = (status or "confirmed")
        if status_norm != "confirmed":
            closes_draft_count += 1
            continue
        closes_confirmed_count += 1
        if (mode or "") == "manual":
            closes_manual_count += 1
        rev_f = float(rev or 0)
        close_pos_revenue += rev_f
        close_dates.add(d)
        close_revenue_by_date[d] = close_revenue_by_date.get(d, 0.0) + rev_f
        if rev_ex is not None:
            close_revenue_ex_moms_total += float(rev_ex)
        if moms is not None:
            # Explicit value (incl. explicit 0 for VAT-exempt closes)
            # — preserve owner / OCR intent. Avoids the formula
            # over-counting when the owner has manually entered MOMS.
            close_pos_moms += float(moms)
        elif rev_f > 0 and vat_rate > 0:
            # No explicit MOMS — extract via the gross formula.
            #
            # NB: `DailyClose.revenue_total` is ALWAYS stored as gross
            # (the till's Z-report total, which the customer paid). Even
            # for B2B users with `prices_include_moms=False`, the close
            # form / OCR captures the gross till total — net pricing is
            # an Invoice/Faktura concept, not a kasserapport concept.
            #
            # So we extract MOMS using `gross * rate / (1+rate)`
            # regardless of `prices_include_moms`. Using the net formula
            # (`gross * rate`) here would over-extract by a factor of
            # (1+rate) — 25% bumped to ~31% for DK MOMS, an audit-grade
            # filing error.  Caught in audit a26d37c → R2.
            close_pos_moms += rev_f * vat_rate / (1 + vat_rate)

    # ─── Stream 1 (Sale) — POS revenue NOT linked to an invoice
    #
    # Exclude dates with a confirmed close (Stream 2 wins on those
    # dates). The Sale rows aren't lost — they're presumed already
    # reflected in close.revenue_total, which the till operator
    # tallies at end of shift.
    pos_sale_q = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user_id, Sale.date >= start_date, Sale.date < end_date,
                Sale.is_deleted.isnot(True), Sale.is_tax_exempt.isnot(True),
                Sale.invoice_id.is_(None))
    )
    if close_dates:
        pos_sale_q = pos_sale_q.filter(~Sale.date.in_(close_dates))
    pos_sale_total = float(pos_sale_q.scalar())

    # ─── Stream 3 (Faktura) — Invoice.total_gross for non-credit-notes
    # PLUS Invoice.total_gross for credit notes (already negative).
    # Drafts excluded — not yet legally recognized as outgoing.
    invoice_total_gross = float(
        db.query(func.coalesce(func.sum(Invoice.total_gross), 0))
        .filter(Invoice.user_id == user_id,
                Invoice.issue_date >= start_date, Invoice.issue_date < end_date,
                Invoice.status.in_(("sent", "paid", "overdue", "credited")))
        .scalar()
    )
    # And the exact moms portion from invoices — already stored separately
    invoice_moms = float(
        db.query(func.coalesce(func.sum(Invoice.moms_total), 0))
        .filter(Invoice.user_id == user_id,
                Invoice.issue_date >= start_date, Invoice.issue_date < end_date,
                Invoice.status.in_(("sent", "paid", "overdue", "credited")))
        .scalar()
    )

    expenses_total = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user_id, Expense.date >= start_date, Expense.date < end_date,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True),
                Expense.is_tax_exempt.isnot(True), not_pending())
        .scalar()
    )

    # Fradrag-weighted købsmoms base (Momsloven §42 — see dk_fradrag.py).
    # `expenses_total` above keeps the full GROSS for display; here we weight
    # each category's spend by its real DK MOMS-fradrag factor (repræsentation
    # 0%, restaurantbesøg/hotel 25%, normal 100%) so the deducted input-VAT is
    # what's legally claimable — not a blanket full deduction that over-claims
    # on §42-limited categories. Unknown categories stay 100% (never under-
    # claim a normal expense). Single source: this feeds `input_vat`, which
    # both the on-screen breakdown and build_moms_filing_pdf consume.
    _fradrag_cat_rows = (
        db.query(ExpenseCategory.name, func.coalesce(func.sum(Expense.amount), 0))
        .select_from(Expense)
        .outerjoin(ExpenseCategory, ExpenseCategory.id == Expense.category_id)
        .filter(Expense.user_id == user_id, Expense.date >= start_date, Expense.date < end_date,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True),
                Expense.is_tax_exempt.isnot(True), not_pending())
        .group_by(ExpenseCategory.name)
        .all()
    )
    deductible_expense_base = sum(
        float(total) * fradrag_factor(name) for name, total in _fradrag_cat_rows
    )

    # Exempt sales — explicitly marked `is_tax_exempt=true` Sales rows
    # PLUS invoices with zero MOMS (export to EU reverse-charge, 0%-rated
    # services, §13 nr. 17 charitable events, gift cards, etc.). These
    # belong on the SKAT MOMS-angivelse "Salg uden moms" line — NOT
    # silently dropped, which was the bug in tax_filing_pdf.py before
    # 2026-05-24 (salg_uden_moms was hardcoded to 0.0 regardless of
    # actual exempt revenue).
    #
    # Closes don't expose an is_tax_exempt flag — assume all close
    # revenue is taxable. Owners with material exempt revenue should
    # be using the Sale + faktura paths anyway (those carry the flag).
    pos_exempt_q = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user_id, Sale.date >= start_date, Sale.date < end_date,
                Sale.is_deleted.isnot(True), Sale.is_tax_exempt.is_(True),
                Sale.invoice_id.is_(None))
    )
    if close_dates:
        pos_exempt_q = pos_exempt_q.filter(~Sale.date.in_(close_dates))
    pos_exempt_total = float(pos_exempt_q.scalar())
    invoice_exempt_total = float(
        db.query(func.coalesce(func.sum(Invoice.total_gross), 0))
        .filter(Invoice.user_id == user_id,
                Invoice.issue_date >= start_date, Invoice.issue_date < end_date,
                Invoice.status.in_(("sent", "paid", "overdue", "credited")),
                Invoice.moms_total == 0)
        .scalar()
    )
    exempt_sales = round(pos_exempt_total + invoice_exempt_total, 2)

    # Exempt Sales that fall ON a confirmed-close date are EXCLUDED from both
    # pos_sale_total and pos_exempt_total above (close.revenue_total supersedes
    # Sale rows on those dates, and a close carries no exempt breakdown).
    # Consequence: exempt till activity on a close day is folded into that
    # close's fully-taxable total — overstating box A ("Salg med moms") and
    # understating "Salg uden moms" for the day. We can't safely re-split it
    # (the close total may or may not already include these Sales, and a blind
    # re-derive would risk a worse reconciliation bug), so we MEASURE it and
    # expose it; the filing PDF surfaces a review note when it's material so a
    # revisor can adjust. Honest > silently wrong. Typically 0 (cafés/
    # restaurants have no exempt revenue), so the common path is unaffected.
    exempt_on_close_dates = 0.0
    if close_dates:
        exempt_on_close_dates = round(float(
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(Sale.user_id == user_id,
                    Sale.date.in_(close_dates),
                    Sale.is_deleted.isnot(True),
                    Sale.is_tax_exempt.is_(True),
                    Sale.invoice_id.is_(None))
            .scalar()
        ), 2)

    # POS output VAT — extract from Sale rows + add close contribution.
    # The close contribution was already computed above (close.moms_total
    # when set, else extracted via the same formula). Keeping them
    # separate before summing means an explicit close.moms_total of e.g.
    # 26,950 isn't re-derived through the gross/(1+rate) formula.
    if vat_rate <= 0:
        pos_sale_vat = 0.0
        input_vat = 0.0
    elif prices_include_moms:
        pos_sale_vat = pos_sale_total * vat_rate / (1 + vat_rate)
        input_vat = round(deductible_expense_base * vat_rate / (1 + vat_rate), 2)
    else:
        pos_sale_vat = pos_sale_total * vat_rate
        input_vat = round(deductible_expense_base * vat_rate, 2)

    pos_output_vat = round(pos_sale_vat + close_pos_moms, 2)

    # Total POS revenue across both streams (Sale on non-close dates +
    # confirmed close.revenue_total on close dates — no overlap).
    pos_total = pos_sale_total + close_pos_revenue

    # Faktura output VAT comes straight from Invoice.moms_total (no
    # extraction needed — already separated at line-item level).
    output_vat = round(pos_output_vat + invoice_moms, 2)

    # Total revenue: POS gross + Invoice gross (which already includes moms).
    # NB: `sales_total` INCLUDES `exempt_sales` — these are the gross top-line
    # revenue across both taxable + exempt streams. Use `taxable_sales` below
    # (sales_total - exempt_sales) when the consumer wants the "Salg med moms"
    # number for the SKAT MOMS-angivelse "row A: taxable sales" line.
    sales_total = round(pos_total + invoice_total_gross, 2)

    # SKAT MOMS-angivelse box A ("Salg med moms") = taxable sales only.
    # Pre-existing bug caught in audit a26d37c → R3: tax_filing_pdf.py
    # used `sales_total` for `salg_med_moms` directly, which double-counted
    # exempt revenue (it appeared on both "Salg med moms" AND "Salg uden
    # moms" rows, breaking the sum). Surface a dedicated `taxable_sales`
    # field so the PDF + downstream callers can land the right number.
    taxable_sales = round(max(sales_total - exempt_sales, 0.0), 2)

    # ─── Bogføringsloven §9 stk. 2 — per-date variance detection
    #
    # When a confirmed close exists on date D AND Sale rows exist on D
    # with materially different totals, the revisor needs to see that —
    # not have it silently absorbed by the close-wins precedence above.
    # §9 stk. 2: "Hver registrering skal være underbygget af et bilag og
    # skal kunne følges til regnskabet." (Every entry must be backed by
    # a voucher and traceable to the books.) If close says 50k and POS
    # rang 100k for the same day, neither number is traceable on its own.
    #
    # Threshold = max(50 DKK, 10% of larger side). Catches material
    # variance while tolerating normal POS rounding (a few øre per txn
    # adds up to maybe 20-30 DKK over a busy day).
    #
    # Filter on Sale rows here matches the headline path: `invoice_id IS
    # NULL` (POS only, no invoice receipts), `is_deleted IS NOT TRUE`.
    # Tax-exempt Sale rows ARE included because the close's revenue_total
    # mixes exempt and taxable till activity — we want a like-for-like
    # comparison with what the till actually rang up.
    variance_warnings: list[dict] = []
    if close_dates:
        sale_sum_by_date_rows = (
            db.query(Sale.date, func.coalesce(func.sum(Sale.amount), 0).label("total"))
            .filter(
                Sale.user_id == user_id,
                Sale.date.in_(close_dates),
                Sale.is_deleted.isnot(True),
                Sale.invoice_id.is_(None),
            )
            .group_by(Sale.date)
            .all()
        )
        for d, total in sale_sum_by_date_rows:
            sale_sum = float(total or 0)
            close_rev = close_revenue_by_date.get(d, 0.0)
            if sale_sum <= 0 or close_rev <= 0:
                # No variance to flag — one side is empty, owner's
                # workflow is "close-only" or "sale-only" on that day.
                continue
            delta = close_rev - sale_sum
            max_side = max(close_rev, sale_sum)
            delta_pct = (abs(delta) / max_side) * 100.0
            if abs(delta) > 50.0 and delta_pct > 10.0:
                variance_warnings.append({
                    "date": d.isoformat(),
                    "close_revenue": round(close_rev, 2),
                    "sale_sum": round(sale_sum, 2),
                    "delta": round(delta, 2),
                    "delta_pct": round(delta_pct, 1),
                    # direction: "close_high" means close > sale (close
                    # over-reports, or sale rows are missing); "close_low"
                    # means close < sale (close under-reports, or sale
                    # has duplicate / phantom rows). Helps the revisor
                    # know which side to investigate.
                    "direction": "close_high" if delta > 0 else "close_low",
                })

    # ── Gavekort (gift card) redemption reconciliation ──────────────────
    # HONESTY INVARIANT: a gavekort is a TENDER, never a second sale. When a
    # gavekort-paid meal is rung up (a Sale tagged payment_method='gift_card')
    # or scanned into the close's Z-report, the MEAL is ALREADY in revenue_total
    # + the MOMS base above. So we NEVER add redemptions to revenue — that would
    # double-count and OVER-declare MOMS to SKAT. Instead, mirroring the §9 stk.2
    # variance block, we DETECT the one real gap and flag it for the revisor:
    # an MPV gavekort redeemed (door-scan) whose meal was captured NOWHERE, so
    # its output MOMS — due AT REDEMPTION under DK MPV rules — silently escapes
    # the base. This block MUTATES NOTHING: revenue_total, taxable_sales and
    # output_vat are untouched; it only appends to gavekort_warnings.
    # SPV (single-purpose) vouchers are EXCLUDED: their MOMS falls at issuance,
    # not redemption, so a redemption flag would be wrong for them.
    gavekort_warnings: list[dict] = []
    redeemed_by_date: dict[date, float] = {}
    redeem_rows = (
        db.query(GiftCardTransaction.business_day, GiftCardTransaction.amount_minor)
        .join(GiftCard, GiftCard.id == GiftCardTransaction.gift_card_id)
        .filter(
            GiftCardTransaction.user_id == user_id,
            GiftCardTransaction.kind == "redeem",
            GiftCardTransaction.business_day.isnot(None),
            GiftCardTransaction.business_day >= datetime.combine(start_date, time.min),
            GiftCardTransaction.business_day < datetime.combine(end_date, time.min),
            GiftCard.voucher_class == "mpv",
        )
        .all()
    )
    for bday, amt in redeem_rows:
        d = bday.date() if hasattr(bday, "date") else bday
        # redeem rows carry a NEGATIVE amount_minor (a debit) — negate to kr.
        redeemed_by_date[d] = redeemed_by_date.get(d, 0.0) + (-float(amt or 0)) / 100.0

    if redeemed_by_date:
        # Which redemption dates have ANY Sale row (the meal plausibly captured
        # among them — a gift_card-tagged Sale would be in this set).
        sale_dates_with_rows: set[date] = set()
        non_close_redeem_dates = [d for d in redeemed_by_date if d not in close_dates]
        if non_close_redeem_dates:
            for (sd,) in (
                db.query(Sale.date)
                .filter(
                    Sale.user_id == user_id,
                    Sale.date.in_(non_close_redeem_dates),
                    Sale.is_deleted.isnot(True),
                )
                .distinct()
                .all()
            ):
                sale_dates_with_rows.add(sd)

        # The gift_card tender line from each confirmed close's payment breakdown
        # (kr.), for the value-level check that catches a close whose revenue is
        # net-of-gavekort. Tender key varies by source: gift_card / gavekort / ….
        gc_tender_by_date: dict[date, float] = {}
        closed_redeem_dates = [d for d in redeemed_by_date if d in close_dates]
        if closed_redeem_dates:
            for cd, pc in (
                db.query(DailyClose.date, DailyClose.payment_categories)
                .filter(
                    DailyClose.user_id == user_id,
                    DailyClose.date.in_(closed_redeem_dates),
                    DailyClose.is_deleted.isnot(True),
                )
                .all()
            ):
                bd = decode_breakdown(pc) if pc else None
                if not isinstance(bd, dict):
                    continue
                gc = 0.0
                for k, v in bd.items():
                    if str(k).lower().replace("-", "_") in (
                        "gift_card", "gift_cards", "gavekort", "giftcard"
                    ):
                        try:
                            gc += float(v or 0)
                        except (TypeError, ValueError):
                            pass
                gc_tender_by_date[cd] = gc_tender_by_date.get(cd, 0.0) + gc

        for d, redeemed in sorted(redeemed_by_date.items()):
            if redeemed <= 0:
                continue
            has_close = d in close_dates
            has_sale = d in sale_dates_with_rows
            if not has_close and not has_sale:
                # Door-scan-only: the redeemed meal is in NO close and NO Sale —
                # its revenue + MOMS escapes the base entirely. The real hole.
                gavekort_warnings.append({
                    "date": d.isoformat(),
                    "redeemed": round(redeemed, 2),
                    "matched_close_tender": None,
                    "status": "unmatched_redemption",
                })
            elif has_close:
                gc = gc_tender_by_date.get(d)
                # Value-level check: a confirmed close exists AND it broke out a
                # gift_card tender, but that tender is materially SMALLER than
                # what was redeemed → some redeemed meals are likely missing from
                # revenue_total (the net-of-gavekort case). Same 50 kr / 10%
                # threshold as the §9 variance block. If the close didn't split
                # out a gift_card tender (Z-report scans often don't), we stay
                # quiet rather than nag.
                if gc is not None and gc > 0:
                    short = redeemed - gc
                    if short > 50.0 and (short / redeemed) * 100.0 > 10.0:
                        gavekort_warnings.append({
                            "date": d.isoformat(),
                            "redeemed": round(redeemed, 2),
                            "matched_close_tender": round(gc, 2),
                            "status": "tender_short",
                        })
            # has_sale (no close): Sale rows exist for the date — the meal is
            # plausibly captured among them; flagging would be a false positive.

    return {
        "sales_total": sales_total,
        "taxable_sales": taxable_sales,
        "pos_revenue": round(pos_total, 2),
        # Breakdown of the POS contribution so the reconciliation card
        # can show "Closes contributed X, Sales contributed Y" instead
        # of a misleading "mismatch" between two halves of the same
        # headline total. Both sum to pos_revenue.
        "pos_revenue_from_closes": round(close_pos_revenue, 2),
        "pos_revenue_from_sales": round(pos_sale_total, 2),
        "pos_output_vat_from_closes": round(close_pos_moms, 2),
        "pos_output_vat_from_sales": round(pos_sale_vat, 2),
        # Close population stats — subsumes the old _calc_daily_close_vat
        # helper (dropped 2026-05-28). Same source-of-truth as the
        # numbers above, single query, no drift risk.
        "closes_confirmed_count": closes_confirmed_count,
        "closes_draft_count": closes_draft_count,
        "closes_manual_count": closes_manual_count,
        "close_revenue_ex_moms": round(close_revenue_ex_moms_total, 2),
        "invoice_revenue": round(invoice_total_gross, 2),
        "expenses_total": round(expenses_total, 2),
        "exempt_sales": exempt_sales,
        # Exempt Sales on confirmed-close dates currently treated as taxable
        # (folded into close.revenue_total). >0 ⇒ box A may be overstated and
        # the filing PDF shows a review note. Usually 0.
        "exempt_on_close_dates": exempt_on_close_dates,
        "output_vat": output_vat,
        "input_vat": input_vat,
        "vat_payable": round(output_vat - input_vat, 2),
        # Bogføringsloven §9 stk. 2 — per-date variance warnings.
        # Empty list = no material variance to flag (or no overlap
        # between close + Sale on any date). Non-empty = the revisor
        # MUST see this before the SKAT angivelse is filed.
        "variance_warnings": variance_warnings,
        # Gavekort redemption reconciliation (detect-only — never added to
        # revenue/MOMS). Non-empty ⇒ MPV gavekort were redeemed whose meal may
        # not be in the MOMS base → revisor must verify the sale was bogført.
        "gavekort_warnings": gavekort_warnings,
    }


# `_calc_daily_close_vat` was removed 2026-05-28 — see commit log.
# The numbers it produced (confirmed_count, draft_count, manual_count,
# total_moms, total_revenue, total_revenue_ex_moms) are now emitted
# directly by `_calc_vat` under these keys:
#   closes_confirmed_count, closes_draft_count, closes_manual_count,
#   pos_output_vat_from_closes (= total_moms),
#   pos_revenue_from_closes  (= total_revenue),
#   close_revenue_ex_moms    (= total_revenue_ex_moms)
# Single query, single iteration, zero drift risk — both producers
# applied the same filters by construction so consolidating into one
# pass is a no-op for the math but removes the silent-drift surface
# that audit a26d37c → A4 flagged. Per the multi-barrier doctrine,
# fewer parallel computations of the same value = fewer places to lie.


def _get_next_deadlines(currency: str, frequency: str | None = None,
                        count: int = 4) -> list[dict]:
    """
    Get next N upcoming filing deadlines for this currency + frequency.

    Period derivation is via _derive_period (frequency-aware). The previous
    quarter_map approach miscomputed periods for DK quarterly — see the
    docstring on _derive_period for examples.
    """
    config = TAX_CONFIG.get(currency)
    if not config:
        return []

    freq = frequency or config.get("default_frequency", "quarterly")
    freq_data = (config.get("frequencies") or {}).get(freq)
    if freq_data is None:
        return []

    today = date.today()
    deadlines: list[dict] = []

    if freq == "monthly":
        # Monthly: Nth-of-month string like "25th"; period is the month BEFORE the deadline month
        day_num = int("".join(c for c in freq_data if c.isdigit()) or "25")
        for i in range(count + 2):
            d = today + relativedelta(months=i)
            try:
                deadline = d.replace(day=day_num)
            except ValueError:
                deadline = _last_day_of_month(d.year, d.month)
            if deadline > today:
                p_start, p_end, label = _derive_period(deadline, freq)
                deadlines.append({
                    "deadline": deadline,
                    "period_start": p_start,
                    "period_end": p_end,
                    "period_label": label,
                })
            if len(deadlines) >= count:
                break
    else:
        # List of fixed (month, day) deadlines repeating yearly
        for year_offset in range(3):  # check next 3 years to fill `count`
            for (m, d) in freq_data:
                yr = today.year + year_offset
                try:
                    deadline = date(yr, m, d)
                except ValueError:
                    deadline = _last_day_of_month(yr, m)
                if deadline <= today:
                    continue
                p_start, p_end, label = _derive_period(deadline, freq)
                deadlines.append({
                    "deadline": deadline,
                    "period_start": p_start,
                    "period_end": p_end,
                    "period_label": label,
                })
                if len(deadlines) >= count:
                    break
            if len(deadlines) >= count:
                break

    # Sort by deadline ascending (in case configs aren't strictly ordered)
    deadlines.sort(key=lambda x: x["deadline"])
    return deadlines[:count]


def _payroll_deadlines(count: int = 3) -> list[dict]:
    """
    A-skat + AM-bidrag deadlines for DK employers — both due 10th of the
    following month (or next business day). We don't compute amounts here
    (that needs payroll-module data — coming next pass); just surface the
    deadlines so users with employees aren't blindsided.
    """
    today = date.today()
    out = []
    for i in range(count + 1):
        d = today + relativedelta(months=i)
        try:
            deadline = d.replace(day=10)
        except ValueError:
            deadline = _last_day_of_month(d.year, d.month)
        if deadline <= today:
            continue
        period_anchor = date(deadline.year, deadline.month, 1) - relativedelta(months=1)
        period_start = date(period_anchor.year, period_anchor.month, 1)
        period_end = _last_day_of_month(period_anchor.year, period_anchor.month)
        out.append({
            "tax_name": "A-skat + AM-bidrag",
            "authority": "SKAT (skat.dk)",
            "deadline": deadline,
            "period_start": period_start,
            "period_end": period_end,
            "period_label": period_start.strftime("%B %Y"),
            "days_until": (deadline - today).days,
        })
        if len(out) >= count:
            break
    return out


def get_tax_overview(user: User, db: Session) -> dict:
    """
    Full tax autopilot overview:
    - Upcoming deadlines with estimated amounts (frequency = user.tax_filing_frequency
      or currency default — DK SMBs default to half_yearly)
    - Current period progress
    - Daily Close reconciliation
    - A-skat / AM-bidrag deadlines if user.has_employees (DK only for now)
    - Alerts and reminders
    """
    currency = user.currency or "DKK"
    config = TAX_CONFIG.get(currency)
    vat_rate = _get_vat_rate(currency)

    if not config:
        # Fallback for unsupported currencies
        config = {
            "tax_name": "VAT/Tax",
            "authority": "Tax Authority",
            "rate": vat_rate,
            "default_frequency": "quarterly",
            "frequencies": {},
        }

    today = date.today()
    frequency = _resolve_frequency(user, config)
    prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    # Get upcoming deadlines
    deadlines = _get_next_deadlines(currency, frequency=frequency, count=4)

    # Calculate estimated amounts for each deadline
    upcoming = []
    for dl in deadlines:
        vat_data = _calc_vat(db, user.id, dl["period_start"],
                             dl["period_end"] + timedelta(days=1), vat_rate, prices_incl_moms)
        days_until = (dl["deadline"] - today).days

        status = "upcoming"
        if days_until < 0:
            status = "overdue"
        elif days_until <= 3:
            status = "urgent"
        elif days_until <= 7:
            status = "soon"
        elif days_until <= 14:
            status = "approaching"

        upcoming.append({
            "deadline": str(dl["deadline"]),
            "period_label": dl["period_label"],
            "period_start": str(dl["period_start"]),
            "period_end": str(dl["period_end"]),
            "days_until": days_until,
            "status": status,
            "estimated_amount": vat_data["vat_payable"],
            "output_vat": vat_data["output_vat"],
            "input_vat": vat_data["input_vat"],
            "sales_total": vat_data["sales_total"],
            "expenses_total": vat_data["expenses_total"],
        })

    # Current period calc (this month)
    month_start = today.replace(day=1)
    month_end = month_start + relativedelta(months=1)
    current_period = _calc_vat(db, user.id, month_start, month_end, vat_rate, prices_incl_moms)

    # YTD calc
    year_start = date(today.year, 1, 1)
    ytd = _calc_vat(db, user.id, year_start, today + timedelta(days=1), vat_rate, prices_incl_moms)

    # ── Daily Close reconciliation ──
    #
    # Semantic change (2026-05-28): the headline (`current_period.output_vat`)
    # now INCLUDES close-derived MOMS via _calc_vat's per-date precedence —
    # closes and sales are no longer competing sources, they're additive
    # halves of the same total. The reconciliation card stops framing
    # close-vs-sale as a "mismatch" (always pulled close MOMS short of the
    # combined headline) and starts framing it as a contribution breakdown:
    #
    #   • moms_from_closes    — MOMS contributed by confirmed closes
    #   • moms_from_sales     — MOMS contributed by Sale rows on non-close dates
    #   • status="combined"   — headline is the sum, no discrepancy by design
    #
    # `discrepancy` retains its place in the response shape for frontend
    # back-compat but always reports 0 after this fix. Real per-date
    # variance detection (close.revenue_total vs SUM(Sale.amount) on the
    # same date) is a follow-up — flagged in CLAUDE.md.
    #
    # 2026-05-28 — dropped the parallel _calc_daily_close_vat pass; the
    # counts + totals now ride along with current_period / ytd via the
    # consolidated _calc_vat query. Same numbers, single source of truth
    # (audit a26d37c → A4).
    confirmed_count_m = int(current_period.get("closes_confirmed_count", 0))
    confirmed_count_y = int(ytd.get("closes_confirmed_count", 0))

    if confirmed_count_m > 0:
        recon_status = "combined"
    else:
        recon_status = "no_data"

    daily_close_recon = {
        "current_month": {
            # Close-contribution to the headline (matches what _calc_vat
            # used). Single source of truth — same query that fed the
            # headline output_vat above.
            "moms_from_closes": current_period.get("pos_output_vat_from_closes", 0.0),
            # Sale-only contribution to the headline (Sale rows on dates
            # WITHOUT a confirmed close — closes win on shared dates so
            # there's no double-count). Faktura MOMS isn't included here
            # because faktura is a separate stream from POS reconciliation.
            "moms_from_sales": current_period.get("pos_output_vat_from_sales", 0.0),
            "closes_count": confirmed_count_m,
            "drafts_count": int(current_period.get("closes_draft_count", 0)),
            "manual_count": int(current_period.get("closes_manual_count", 0)),
            "revenue_from_closes": current_period.get("pos_revenue_from_closes", 0.0),
            # Always 0 after the fix — kept for frontend back-compat.
            "discrepancy": 0.0,
            "discrepancy_pct": 0.0,
            "status": recon_status,
            # Bogføringsloven §9 stk. 2 — per-date variance warnings for
            # this filing period (matches `current_period` window).
            # Frontend renders as a yellow inline footnote in the
            # ReconCard, NOT a banner — keeps the headline clean while
            # ensuring revisor sees the per-date traceability issue.
            "variance_warnings": current_period.get("variance_warnings", []),
            # Gavekort redeemed (MPV) whose meal may be missing from the MOMS
            # base — revisor verifies the sale was bogført. Detect-only.
            "gavekort_warnings": current_period.get("gavekort_warnings", []),
        },
        "ytd": {
            "moms_from_closes": ytd.get("pos_output_vat_from_closes", 0.0),
            "moms_from_sales": ytd.get("pos_output_vat_from_sales", 0.0),
            "closes_count": confirmed_count_y,
            "revenue_from_closes": ytd.get("pos_revenue_from_closes", 0.0),
            # YTD variance warnings — typically more entries; recon card
            # collapses these behind a "see all" link if > 3.
            "variance_warnings": ytd.get("variance_warnings", []),
            "gavekort_warnings": ytd.get("gavekort_warnings", []),
        },
    }

    # Generate alerts (with reconciliation context)
    alerts = _generate_tax_alerts(upcoming, config, currency, ytd, daily_close_recon)

    # A-skat + AM-bidrag deadlines for DK employers (10th of next month).
    # Each deadline gets an estimated amount from the payroll service if hours
    # have been logged for the period. Multi-layer defense: payroll import is
    # local so that if the staff module is missing, tax overview still works.
    payroll = []
    if currency == "DKK" and bool(getattr(user, "has_employees", False)):
        try:
            from app.services.payroll_service import estimate_period_payroll
            for p in _payroll_deadlines(count=3):
                period_start_d = p["period_start"]
                period_end_d = p["period_end"]
                est = estimate_period_payroll(db, user.id, period_start_d, period_end_d)
                p["deadline"] = str(p["deadline"])
                p["period_start"] = str(period_start_d)
                p["period_end"] = str(period_end_d)
                p["estimated_amount"] = est["skat_remit"]["total"]
                p["am_bidrag"] = est["skat_remit"]["am_bidrag"]
                p["a_skat"] = est["skat_remit"]["a_skat"]
                p["staff_count"] = est["staff_count"]
                p["is_estimate"] = True
                payroll.append(p)
        except Exception as e:  # noqa: BLE001
            logger.warning("payroll estimate failed, falling back to deadline-only: %s", e)
            for p in _payroll_deadlines(count=3):
                p["deadline"] = str(p["deadline"])
                p["period_start"] = str(p["period_start"])
                p["period_end"] = str(p["period_end"])
                p["estimated_amount"] = None
                payroll.append(p)

    return {
        "tax_name": config["tax_name"],
        "authority": config["authority"],
        "rate": vat_rate,
        "rate_pct": round(vat_rate * 100, 1),
        "frequency": frequency,
        "available_frequencies": list((config.get("frequencies") or {}).keys()),
        "prices_include_moms": prices_incl_moms,
        "currency": currency,
        "upcoming_deadlines": upcoming,
        "payroll_deadlines": payroll,
        "current_month": {
            **current_period,
            "month": today.strftime("%B %Y"),
        },
        "ytd": {
            **ytd,
            "year": today.year,
        },
        "alerts": alerts,
        "daily_close_reconciliation": daily_close_recon,
    }


def _generate_tax_alerts(upcoming, config, currency, ytd, recon=None) -> list[dict]:
    """Generate tax-related alerts."""
    alerts = []
    tax_name = config["tax_name"]

    for dl in upcoming[:2]:  # Only alert for next 2 deadlines
        days = dl["days_until"]
        amt = dl["estimated_amount"]

        if dl["status"] == "overdue":
            alerts.append({
                "type": "overdue",
                "severity": "critical",
                "icon": "🚨",
                "title": f"{tax_name} filing OVERDUE! ({dl['period_label']})",
                "detail": f"Deadline was {dl['deadline']}. Estimated: {round(amt):,}. File immediately to avoid penalties.",
                "action": f"File your {tax_name} return with {config['authority']} today.",
            })
        elif dl["status"] == "urgent":
            alerts.append({
                "type": "urgent",
                "severity": "critical",
                "icon": "⏰",
                "title": f"{tax_name} due in {days} days! ({dl['period_label']})",
                "detail": f"Deadline: {dl['deadline']}. Estimated amount: {round(amt):,}.",
                "action": f"Prepare and file your {tax_name} return now.",
            })
        elif dl["status"] == "soon":
            alerts.append({
                "type": "soon",
                "severity": "warning",
                "icon": "📅",
                "title": f"{tax_name} due in {days} days ({dl['period_label']})",
                "detail": f"Deadline: {dl['deadline']}. Estimated: {round(amt):,}. Make sure your books are up to date.",
                "action": "Review and categorize any uncategorized expenses.",
            })
        elif dl["status"] == "approaching":
            alerts.append({
                "type": "approaching",
                "severity": "info",
                "icon": "📋",
                "title": f"{tax_name} filing in {days} days",
                "detail": f"For {dl['period_label']}. Current estimate: {round(amt):,}.",
                "action": None,
            })

    # YTD insight
    if ytd["vat_payable"] > 0:
        alerts.append({
            "type": "ytd_summary",
            "severity": "info",
            "icon": "📊",
            "title": f"Year-to-date {tax_name}: {round(ytd['vat_payable']):,}",
            "detail": f"Output: {round(ytd['output_vat']):,} on {round(ytd['sales_total']):,} sales. Input: {round(ytd['input_vat']):,} on {round(ytd['expenses_total']):,} expenses.",
            "action": None,
        })

    # Daily Close reconciliation alert
    #
    # 2026-05-28 \u2014 after the per-date precedence fix in _calc_vat,
    # closes and sales contribute additive halves of the same headline.
    # The "mismatch" framing no longer applies (status is "combined"
    # or "no_data"). The positive alert now confirms the two sources
    # are co-feeding the SKAT filing correctly.
    if recon:
        cm = recon.get("current_month", {})
        from_closes = float(cm.get("moms_from_closes") or 0)
        from_sales = float(cm.get("moms_from_sales") or 0)
        closes_count = int(cm.get("closes_count") or 0)
        if cm.get("status") == "combined" and closes_count >= 1:
            alerts.append({
                "type": "reconciliation_ok",
                "severity": "positive",
                "icon": "\u2705",
                "title": (
                    f"Daily Close and Sales together feed {tax_name} filing"
                ),
                "detail": (
                    f"{closes_count} confirmed close"
                    f"{'s' if closes_count != 1 else ''} this month "
                    f"contributed {round(from_closes):,} {tax_name}; "
                    f"Sale rows on the other days contributed {round(from_sales):,}. "
                    "Both feed the headline filing total."
                ),
                "action": None,
            })

        # Gavekort redemption reconciliation — MPV cards redeemed (door-scan)
        # whose meal may not be in the MOMS base. Detect-only: BonBox never adds
        # the redemption to revenue (that would double-count), it flags so the
        # owner/revisor confirms the meal was bogført. SKAT-correctness signal.
        gk_warn = (cm.get("gavekort_warnings") or []) if isinstance(cm, dict) else []
        if gk_warn:
            gk_total = round(sum(float(w.get("redeemed") or 0) for w in gk_warn))
            day_word = "day" if len(gk_warn) == 1 else "days"
            alerts.append({
                "type": "gavekort_reconciliation",
                "severity": "warning",
                "icon": "\U0001F381",  # 🎁
                "title": "Gavekort redeemed — check the sale is bogført",
                "detail": (
                    f"{len(gk_warn)} {day_word} with gavekort redemptions "
                    f"(~{gk_total:,} kr.) where the meal may be missing from revenue. "
                    "MOMS falls at redemption — record the sale in a dagsafslutning "
                    "or as a salg so it enters the MOMS base."
                ),
                "action": None,
            })

    if not alerts:
        alerts.append({
            "type": "all_clear",
            "severity": "positive",
            "icon": "\u2705",
            "title": f"No urgent {tax_name} deadlines",
            "detail": "Your tax filings are up to date.",
            "action": None,
        })

    return alerts
