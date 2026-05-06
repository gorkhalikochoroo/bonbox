"""Multi-terminal close → Mirabelle-format PDF.

Renders an aggregated daily close as a clean A4 PDF using reportlab.
Owner can attach this to an email when an investor wants to forward
to their accountant — more professional than copy-pasted text.

Format mirrors the Mirabelle weekly Excel:
  • Header: BonBox brand mark + restaurant name + date + closer
  • Cash flow block (closing, money to bank, paid out, paid in,
    opening, total)
  • Other payments (gift cards, MobilePay)
  • Per-terminal rows (Dankort, Teller, Amex, Total per terminal)
  • Aggregates (Cards total, Payments total)
  • Reconciliation (Sales POS, Cash difference + flag if exceeded)
  • Footer: BonBox attribution + timestamp

Designed to render with NO network access — all the styles are
declared inline, no external fonts loaded, no images fetched.
This means the endpoint can run on Render's free tier without
egress concerns.

Defense layers:
  • Pure function — takes a dict, returns bytes; no DB / LLM access
  • Validates input shape but tolerates missing fields gracefully
    (renders "—" for absent values rather than crashing)
  • A4 portrait, fits on a single page even with 6 terminals
  • Currency formatting safe for None / strings / negatives
"""
from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger("bonbox.kasserapport_pdf")


def _money(value: Any, currency: str = "DKK") -> str:
    """Render a numeric amount in 'da-DK' format with currency suffix.
    None / non-numeric → "—" (graceful for missing fields)."""
    if value is None:
        return "—"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    sign = "-" if n < 0 else ""
    abs_n = abs(n)
    # Danish: comma decimal, dot thousand separator. reportlab can't
    # invoke locale, so we format manually.
    whole = int(abs_n)
    fractional = round((abs_n - whole) * 100)
    if fractional == 100:
        whole += 1
        fractional = 0
    whole_str = f"{whole:,}".replace(",", ".")
    return f"{sign}{whole_str},{fractional:02d} {currency}"


def render_close_pdf(
    *,
    aggregated: dict,
    business_name: str = "",
    date_label: str = "",
    currency: str = "DKK",
) -> bytes:
    """Build the close PDF. Returns raw bytes ready for HTTP response or
    for attaching to an email. Never raises — falls back to a minimal
    error PDF if something goes wrong, so the caller's flow continues."""
    try:
        return _render_close_pdf(
            aggregated=aggregated or {},
            business_name=business_name or "",
            date_label=date_label or "",
            currency=currency or "DKK",
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("render_close_pdf failed: %s", e)
        return _render_error_pdf(str(e))


def _render_close_pdf(
    *,
    aggregated: dict,
    business_name: str,
    date_label: str,
    currency: str,
) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"Kasserapport · {business_name or 'BonBox'}",
        author="BonBox",
    )
    styles = getSampleStyleSheet()

    h1 = ParagraphStyle(
        "H1",
        parent=styles["Title"],
        fontSize=16,
        spaceAfter=2,
        alignment=TA_LEFT,
    )
    sub = ParagraphStyle(
        "Sub",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.grey,
        spaceAfter=12,
    )
    section = ParagraphStyle(
        "Section",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.HexColor("#22c55e"),
        spaceBefore=10,
        spaceAfter=4,
        leading=12,
    )
    footer = ParagraphStyle(
        "Footer",
        parent=styles["Normal"],
        fontSize=8,
        textColor=colors.grey,
        spaceBefore=14,
    )

    story = []

    # ─── Header ──────────────────────────────────────────────────────
    story.append(Paragraph(f"💰 Lukning · {business_name or 'BonBox'}", h1))

    closer = aggregated.get("closed_by") or "—"
    story.append(Paragraph(
        f"{date_label or datetime.utcnow().strftime('%d.%m.%Y')} &nbsp;·&nbsp; "
        f"Lukket af: <b>{closer}</b>",
        sub,
    ))
    story.append(HRFlowable(width="100%", color=colors.HexColor("#e5e7eb"), thickness=0.6, spaceAfter=6))

    # ─── Cash flow block ────────────────────────────────────────────
    story.append(Paragraph("KONTANT", section))
    cash_rows = [
        ["Cash closing - till out",          _money(aggregated.get("cash_closing"), currency)],
        ["Money to bank",                    _money(aggregated.get("money_to_bank"), currency)],
        ["Paid out - change/byttep",         _money(aggregated.get("paid_out"), currency)],
        ["Paid in",                          _money(aggregated.get("paid_in"), currency)],
        ["Cash opening - till in",           _money(aggregated.get("cash_opening"), currency)],
        ["Cash total",                       _money(aggregated.get("cash_total"), currency)],
    ]
    story.append(_kv_table(cash_rows, last_row_bold=True))

    # ─── Other payments ─────────────────────────────────────────────
    story.append(Paragraph("ANDRE", section))
    other_rows = [
        ["Gift cards accepted (total)",      _money(aggregated.get("gift_cards_total"), currency)],
        ["Mobile Pay",                       _money(aggregated.get("mobilepay_total"), currency)],
    ]
    story.append(_kv_table(other_rows))

    # ─── Per-terminal block ────────────────────────────────────────
    terminals = aggregated.get("terminals") or []
    if terminals:
        story.append(Paragraph("KORTBETALINGER PR. TERMINAL", section))
        for i, t in enumerate(terminals, start=1):
            t_name = t.get("terminal_name") or f"Terminal {i}"
            story.append(Spacer(1, 3))
            story.append(Paragraph(f"<b>{i}. {t_name}</b>", styles["Normal"]))
            term_rows = [
                ["Dankort",   _money(t.get("dankort"), currency)],
                ["Teller",    _money(t.get("teller"), currency)],
                ["Amex",      _money(t.get("amex"), currency)],
                [f"Total terminal {i}", _money(t.get("total"), currency)],
            ]
            story.append(_kv_table(term_rows, last_row_bold=True, indent=1))

    # ─── Aggregates ─────────────────────────────────────────────────
    story.append(Paragraph("OPSUMMERING", section))
    agg_rows = [
        ["Cards total",     _money(aggregated.get("cards_total"), currency)],
        ["Payments total",  _money(aggregated.get("payments_total"), currency)],
    ]
    story.append(_kv_table(agg_rows, all_bold=True))

    # ─── Reconciliation ─────────────────────────────────────────────
    story.append(Paragraph("AFSTEMNING", section))

    cash_diff = aggregated.get("cash_difference") or 0
    diff_flagged = bool(aggregated.get("cash_diff_flagged"))
    flagged_reason = aggregated.get("flagged_reason") or ""

    rec_rows = [
        ["Sales POS (incl. tax)",  _money(aggregated.get("sales_pos"), currency)],
        ["Cash difference (+/-)",  _money(cash_diff, currency)],
    ]
    rec_table = _kv_table(rec_rows, all_bold=True)
    # Highlight the diff row in red/green based on flag status
    diff_row_idx = len(rec_rows) - 1  # Cash difference is last
    rec_table.setStyle(TableStyle([
        ("BACKGROUND", (0, diff_row_idx), (-1, diff_row_idx),
         colors.HexColor("#fef3c7" if diff_flagged else "#f0fdf4")),
        ("TEXTCOLOR", (1, diff_row_idx), (1, diff_row_idx),
         colors.HexColor("#b45309" if diff_flagged else "#15803d")),
    ]))
    story.append(rec_table)

    if diff_flagged and flagged_reason:
        story.append(Spacer(1, 4))
        story.append(Paragraph(
            f"<font color='#b45309'>⚠ {flagged_reason}</font>",
            ParagraphStyle("Flag", parent=styles["Normal"], fontSize=8),
        ))

    # ─── Footer ─────────────────────────────────────────────────────
    story.append(HRFlowable(width="100%", color=colors.HexColor("#e5e7eb"), thickness=0.6, spaceBefore=14))
    story.append(Paragraph(
        f"Genereret af BonBox · {datetime.utcnow().strftime('%d.%m.%Y %H:%M UTC')} · "
        f"bonbox.dk",
        footer,
    ))

    doc.build(story)
    return buf.getvalue()


def _kv_table(rows, *, all_bold: bool = False, last_row_bold: bool = False, indent: int = 0):
    """Helper — render a key/value 2-col table with consistent BonBox styling."""
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Table, TableStyle

    # Column widths: label gets more space, value right-aligned
    col_widths = [110 * mm, 50 * mm] if not indent else [105 * mm, 50 * mm]

    table = Table(rows, colWidths=col_widths, hAlign="LEFT")
    style = [
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#e5e7eb")),
    ]
    if all_bold:
        style.append(("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"))
    elif last_row_bold and len(rows) > 0:
        last = len(rows) - 1
        style.append(("FONTNAME", (0, last), (-1, last), "Helvetica-Bold"))
    if indent:
        style.append(("LEFTPADDING", (0, 0), (0, -1), 8))
    table.setStyle(TableStyle(style))
    return table


def _render_error_pdf(reason: str) -> bytes:
    """Minimal fallback PDF when the main render fails. Better than 500
    error — caller can still hand a (sad-looking) PDF to the user."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import Paragraph, SimpleDocTemplate

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4)
        doc.build([
            Paragraph(
                f"<b>BonBox PDF generation failed.</b><br/><br/>"
                f"Reason: {reason[:200]}<br/><br/>"
                f"Please try again or send the close as text from the share sheet.",
                None,
            ),
        ])
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        # Genuinely catastrophic — return a minimal PDF skeleton
        return (
            b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n"
            b"trailer<</Root 1 0 R>>\n%%EOF"
        )
