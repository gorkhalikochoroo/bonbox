"""Multi-terminal kasserapport aggregator.

Real-world Danish restaurant flow (verified against Mirabelle's Excel):
  • 1 close per day = N kasserapports (one per terminal)
  • Each kasserapport has its own Dankort / Teller / Amex breakdown
  • Owner manually counts cash + reads MobilePay terminal + gift cards
  • Daily close = sum across all terminals + manual fields

This service takes the structured outputs of N kasserapport extractions
and produces a single consolidated daily close payload that mirrors the
exact row-order of the Mirabelle weekly Excel:

    Cash flow:
      cash_closing, money_to_bank, paid_out, paid_in,
      cash_opening, cash_total
    Other:
      gift_cards_total, mobilepay_total
    Per terminal (1..N):
      dankort, teller, amex, total
    Aggregate:
      cards_total, payments_total
    Reconciliation:
      sales_pos, cash_difference, closed_by

This is the format we'll later auto-fill into the customer's Excel
template. Same row order means a one-to-one cell mapping.

Design rules:
  • Pure functions — no DB writes here. Caller persists the result to
    `daily_closes` if they want.
  • Defensive math — every sum is wrapped, missing fields default to 0,
    no chance of None+float crashes.
  • The flagged `cash_difference` is the value-prop of the entire app:
    auto-flagged when |difference| > threshold (default 100 kr) so the
    owner never goes home without knowing about a -685 kr Friday.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# Default threshold for "flag this close, the till didn't reconcile".
# Mirabelle's Excel showed nightly differences of 0,00 / 0,00 / 0,00 /
# -685 / 124,11 / 0,02 — anything above ~100 kr is worth a manager
# eyeball before signing off.
DEFAULT_CASH_DIFF_THRESHOLD = 100.0


@dataclass
class TerminalRow:
    """One terminal's contribution to the close. Mirrors the Excel rows
    for `Dankort from term. N / Teller from term. N / Amex from term. N`."""
    terminal_id: str | None = None
    terminal_name: str = ""
    dankort: float = 0.0
    teller: float = 0.0
    amex: float = 0.0
    total: float = 0.0
    extraction_id: str | None = None  # link back to source scan
    extraction_confidence: float | None = None


@dataclass
class AggregatedClose:
    """The Mirabelle-format consolidated daily close. Field names match
    the Excel row labels 1:1 so future Excel-template auto-fill can
    just iterate fields and write to the matching cell."""
    # Cash flow
    cash_closing: float = 0.0       # Cash closing - till out
    money_to_bank: float = 0.0
    paid_out: float = 0.0           # Paid out - change/byttep
    paid_in: float = 0.0
    cash_opening: float = 0.0       # Cash opening - till in
    cash_total: float = 0.0

    # Other payment lines
    gift_cards_total: float = 0.0
    mobilepay_total: float = 0.0

    # Per-terminal rows (1..N)
    terminals: list[TerminalRow] = field(default_factory=list)

    # Aggregates
    cards_total: float = 0.0      # sum of all terminals' total
    payments_total: float = 0.0   # cards + cash + mobilepay + gift cards

    # Reconciliation
    sales_pos: float = 0.0          # Sales POS (incl tax) — owner-entered
    cash_difference: float = 0.0    # sales_pos - payments_total
    cash_diff_flagged: bool = False # |cash_difference| > threshold

    # Audit
    closed_by: str | None = None
    flagged_reason: str | None = None


def _safe_float(v: Any, default: float = 0.0) -> float:
    """Defensive float coercion — None / strings / negatives that shouldn't
    be (we trust the validator caught those upstream) all default to 0."""
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def aggregate_terminals(
    extractions: list[dict],
    *,
    terminals_meta: list[dict] | None = None,
    manual: dict | None = None,
    threshold: float = DEFAULT_CASH_DIFF_THRESHOLD,
) -> AggregatedClose:
    """Sum N per-terminal kasserapport extractions into one consolidated close.

    Args:
      extractions:
        List of dicts in the shape returned by `extract_kasserapport_full`'s
        `data` field (i.e. the extracted_json column on
        kasserapport_extractions). Each must include a `terminal_id` key
        the caller resolved before calling us; we don't validate FKs here.
      terminals_meta:
        Optional list of {id, name} dicts so the output `TerminalRow.name`
        is human-readable. Falls back to "Terminal {id}" when not given.
      manual:
        Owner-supplied fields not on any kasserapport — cash counted, gift
        cards, mobilepay, sales_pos, cash flow lines, closer name. Keys
        match `AggregatedClose` field names. All optional.
      threshold:
        Cash-difference threshold in kr. Above this, the close is flagged
        for manager review. Default 100 kr.

    Returns:
      A populated `AggregatedClose`. Even if `extractions` is empty, the
      function returns a valid zero-filled object (never raises).
    """
    out = AggregatedClose()
    manual = manual or {}
    name_by_id: dict[str, str] = {}
    if terminals_meta:
        for t in terminals_meta:
            tid = t.get("id")
            if tid:
                name_by_id[str(tid)] = str(t.get("name") or f"Terminal {tid[:6]}")

    # Per-terminal rows — sum each extraction's Dankort/Teller/Amex into
    # one row per terminal_id. If two scans share a terminal_id (re-snap)
    # the LATEST one wins by replacing the row, not by adding (otherwise
    # double-counting on retry). Caller is expected to pass deduped data
    # but we defend against accidents.
    rows_by_term: dict[str, TerminalRow] = {}
    for ext in extractions:
        if not isinstance(ext, dict):
            continue
        tid = ext.get("terminal_id")
        tid_key = str(tid) if tid else f"_unknown_{len(rows_by_term)}"

        payments = ext.get("payments") or {}
        # Receipt vocabulary varies by POS; we accept several spellings:
        #   • Dankort / dankort
        #   • Teller / card_softpay (Oasis terminals)
        #   • Amex / amex
        # If the upstream extractor returned `card_betalingskort` we
        # map it to Dankort (in DK these are typically the same physical
        # card but different terminal labels — Vipps Betalingskort vs Dankort).
        dankort = _safe_float(
            payments.get("dankort")
            if "dankort" in payments
            else payments.get("card_betalingskort"),
            0.0,
        )
        teller = _safe_float(
            payments.get("teller")
            if "teller" in payments
            else payments.get("card_softpay"),
            0.0,
        )
        amex = _safe_float(payments.get("amex"), 0.0)
        total = round(dankort + teller + amex, 2)

        row = TerminalRow(
            terminal_id=str(tid) if tid else None,
            terminal_name=name_by_id.get(str(tid), f"Terminal {tid_key[-6:]}" if tid else "Unassigned"),
            dankort=dankort,
            teller=teller,
            amex=amex,
            total=total,
            extraction_id=ext.get("_extraction_id"),
            extraction_confidence=_safe_float(ext.get("extraction_confidence"), 0.0) or None,
        )
        rows_by_term[tid_key] = row

    # Sort by terminal_name for stable output (matches Excel column order)
    out.terminals = sorted(rows_by_term.values(), key=lambda r: r.terminal_name)

    # Cards total = sum across terminals
    out.cards_total = round(sum(r.total for r in out.terminals), 2)

    # Manual / owner-entered fields
    out.cash_closing      = _safe_float(manual.get("cash_closing"))
    out.money_to_bank     = _safe_float(manual.get("money_to_bank"))
    out.paid_out          = _safe_float(manual.get("paid_out"))
    out.paid_in           = _safe_float(manual.get("paid_in"))
    out.cash_opening      = _safe_float(manual.get("cash_opening"))
    out.gift_cards_total  = _safe_float(manual.get("gift_cards_total"))
    out.mobilepay_total   = _safe_float(manual.get("mobilepay_total"))
    out.sales_pos         = _safe_float(manual.get("sales_pos"))
    out.closed_by         = manual.get("closed_by") or None

    # Cash total — Excel formula: closing + money_to_bank + paid_out
    # - paid_in - opening (sign convention varies; we use Mirabelle's:
    # cash retained = closing - opening + paid_in - paid_out - bank).
    # Most owners just enter `cash_closing` and zero everything else,
    # in which case cash_total ≈ cash_closing. We expose both.
    out.cash_total = round(
        out.cash_closing
        - out.cash_opening
        + out.paid_in
        - out.paid_out
        - out.money_to_bank,
        2,
    )

    # Payments total — what the till + terminals received in actual money
    # (cards across terminals + cash counted + mobilepay + gift cards).
    out.payments_total = round(
        out.cards_total + out.cash_closing + out.mobilepay_total + out.gift_cards_total,
        2,
    )

    # The reconciliation. This is the line that justifies the entire app.
    out.cash_difference = round(out.sales_pos - out.payments_total, 2)
    out.cash_diff_flagged = abs(out.cash_difference) > threshold
    if out.cash_diff_flagged:
        sign = "short" if out.cash_difference < 0 else "over"
        out.flagged_reason = (
            f"Cash difference {out.cash_difference:+,.2f} kr "
            f"({sign} by {abs(out.cash_difference):.2f}, threshold ±{threshold:.0f})"
        )

    return out


def to_excel_rows(close: AggregatedClose) -> list[dict[str, Any]]:
    """Render the aggregated close as the row-by-row structure that
    matches the Mirabelle Excel sheet. Each row is one printable line
    in the same order the customer's existing template uses.

    Used by the future Excel-template auto-fill feature: the row labels
    here line up 1:1 with the cells in the customer's sheet, so the
    Excel-write code is a simple iteration."""
    rows: list[dict[str, Any]] = [
        {"label": "Cash closing - till out",          "value": close.cash_closing},
        {"label": "Money to bank",                    "value": close.money_to_bank},
        {"label": "Paid out - change/byttep",         "value": close.paid_out},
        {"label": "Paid in",                          "value": close.paid_in},
        {"label": "Cash opening - till in",           "value": close.cash_opening},
        {"label": "Cash total",                       "value": close.cash_total},
        {"label": "Gift cards accepted (total)",      "value": close.gift_cards_total},
        {"label": "Mobile Pay",                       "value": close.mobilepay_total},
    ]
    for i, t in enumerate(close.terminals, start=1):
        rows.extend([
            {"label": f"Dankort from term. {i} ({t.terminal_name})", "value": t.dankort},
            {"label": f"Teller from term. {i}",                      "value": t.teller},
            {"label": f"Amex from term. {i}",                        "value": t.amex},
            {"label": f"Total term. {i}",                            "value": t.total},
        ])
    rows.extend([
        {"label": "Cards total",          "value": close.cards_total},
        {"label": "Payments total",       "value": close.payments_total},
        {"label": "Sales POS (incl tax)", "value": close.sales_pos},
        {"label": "Cash difference (+/-)", "value": close.cash_difference,
         "flagged": close.cash_diff_flagged},
        {"label": "Closed by",            "value": close.closed_by or ""},
    ])
    return rows
