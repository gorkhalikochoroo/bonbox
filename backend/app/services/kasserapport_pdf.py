"""Multi-terminal close → Bogføringsloven 2024-compliant PDF.

Produces a formal Danish kasserapport that satisfies Bogføringsloven
§10 (digital storage requirements) and the typical formatting any
Danish revisor expects:

  Header
    • Document type: "Kasserapport" (formal Danish term)
    • Bilagsnummer (if assigned)
    • Restaurant name + CVR + full Danish address
    • Date in DD.MM.YYYY + day name in Danish
    • Closer's full name

  Body — Mirabelle / Oasis row order:
    KONTANT     cash flow (closing → bank → paid out → paid in
                 → opening → cash total)
    ANDRE       gift cards / MobilePay
    KORTBETALINGER PR. TERMINAL
                Per terminal: Dankort / Teller / Amex / Total
    OPSUMMERING cards total / payments total
    MOMS        subtotal excl moms / moms 25% / total incl moms
                (mandatory under SKAT rules)
    AFSTEMNING  sales POS / cash difference (highlighted if flagged)

  Footer
    • Signature line (closer + countersign)
    • Compliance note: "Opbevares i 5 år iht. Bogføringsloven §10"
    • Generated-by + timestamp + page X of Y

A4 portrait, single page typically. Falls back to multi-page only when
8+ terminals (rare). Uses bundled Helvetica — no external font fetches.
"""
from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger("bonbox.kasserapport_pdf")


# Day names in Danish for the header — reportlab can't invoke locale,
# so we provide them inline.
_DK_DAYS = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"]


def _money(value: Any, currency: str = "DKK") -> str:
    """Render a numeric amount in 'da-DK' format with currency suffix.
    None / non-numeric → "—"."""
    if value is None:
        return "—"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    sign = "-" if n < 0 else ""
    abs_n = abs(n)
    whole = int(abs_n)
    fractional = round((abs_n - whole) * 100)
    if fractional == 100:
        whole += 1
        fractional = 0
    whole_str = f"{whole:,}".replace(",", ".")
    return f"{sign}{whole_str},{fractional:02d} {currency}"


def _format_dk_address(profile: dict | None) -> str:
    """Format a Danish address as one line: 'Nørregade 12, 1165 København K'."""
    if not profile:
        return ""
    parts = []
    addr = (profile.get("address") or "").strip()
    if addr:
        parts.append(addr)
    z = (profile.get("zipcode") or "").strip()
    c = (profile.get("city") or "").strip()
    if z and c:
        parts.append(f"{z} {c}")
    elif c:
        parts.append(c)
    return ", ".join(parts)


def _danish_date_label(date_label: str) -> tuple[str, str]:
    """Parse our ISO/DK date label and return (DD.MM.YYYY, Mandag).
    Falls back gracefully if the input is unparseable."""
    if not date_label:
        d = datetime.utcnow()
        return (d.strftime("%d.%m.%Y"), _DK_DAYS[d.weekday()])

    # Already DK-formatted? "9.3.2026 (Mandag)" — extract both halves
    if "(" in date_label and ")" in date_label:
        date_part = date_label.split("(")[0].strip()
        day_part = date_label.split("(")[1].split(")")[0].strip()
        return (date_part, day_part)

    # Try parsing variants
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d-%m-%Y"):
        try:
            d = datetime.strptime(date_label.strip(), fmt)
            return (d.strftime("%d.%m.%Y"), _DK_DAYS[d.weekday()])
        except ValueError:
            continue
    return (date_label, "")


def render_close_pdf(
    *,
    aggregated: dict,
    business_name: str = "",
    date_label: str = "",
    currency: str = "DKK",
    business_profile: dict | None = None,
    bilagsnummer: str | None = None,
) -> bytes:
    """Build the kasserapport PDF. Returns raw bytes; never raises."""
    try:
        return _render_close_pdf(
            aggregated=aggregated or {},
            business_name=business_name or "",
            date_label=date_label or "",
            currency=currency or "DKK",
            business_profile=business_profile or {},
            bilagsnummer=bilagsnummer,
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
    business_profile: dict,
    bilagsnummer: str | None,
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

    # Page numbering callback — drawn on each page after layout
    def _draw_footer(canv, doc):
        canv.saveState()
        canv.setFont("Helvetica", 7.5)
        canv.setFillColor(colors.grey)
        # Compliance note (left)
        canv.drawString(
            18 * mm,
            12 * mm,
            "Opbevares i 5 år iht. Bogføringsloven §10  ·  Genereret af BonBox  ·  bonbox.dk",
        )
        # Page X of Y (right)
        canv.drawRightString(
            doc.pagesize[0] - 18 * mm,
            12 * mm,
            f"Side {canv.getPageNumber()}",
        )
        # Timestamp (centred)
        canv.drawCentredString(
            doc.pagesize[0] / 2,
            12 * mm,
            datetime.utcnow().strftime("%d.%m.%Y %H:%M UTC"),
        )
        canv.restoreState()

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=22 * mm,  # extra space for footer
        title=f"Kasserapport · {business_name or 'BonBox'}",
        author="BonBox",
        subject=f"Kasserapport {date_label}",
    )

    styles = getSampleStyleSheet()

    h_doc = ParagraphStyle(
        "DocType",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#6b7280"),
        spaceAfter=2,
        alignment=TA_LEFT,
    )
    h_business = ParagraphStyle(
        "Business",
        parent=styles["Title"],
        fontSize=18,
        spaceAfter=2,
        alignment=TA_LEFT,
        leading=22,
    )
    h_meta = ParagraphStyle(
        "Meta",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#374151"),
        spaceAfter=2,
        leading=12,
    )
    h_meta_dim = ParagraphStyle(
        "MetaDim",
        parent=styles["Normal"],
        fontSize=8.5,
        textColor=colors.HexColor("#6b7280"),
        spaceAfter=2,
        leading=11,
    )
    section = ParagraphStyle(
        "Section",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#15803d"),
        spaceBefore=10,
        spaceAfter=4,
        leading=12,
        fontName="Helvetica-Bold",
    )

    story = []

    # ─── Document type pill ───────────────────────────────────────
    story.append(Paragraph("KASSERAPPORT", h_doc))

    # ─── Business name ────────────────────────────────────────────
    story.append(Paragraph(business_name or "BonBox", h_business))

    # ─── CVR + address line ───────────────────────────────────────
    cvr = (business_profile.get("org_number") or "").strip()
    addr = _format_dk_address(business_profile)
    meta_parts = []
    if cvr:
        meta_parts.append(f"CVR {cvr}")
    if addr:
        meta_parts.append(addr)
    if meta_parts:
        story.append(Paragraph(
            " &nbsp;·&nbsp; ".join(meta_parts),
            h_meta_dim,
        ))

    # ─── Date / closer / bilagsnummer line ────────────────────────
    date_short, day_name = _danish_date_label(date_label)
    closer = (aggregated.get("closed_by") or "—").strip()
    line_parts = [f"<b>{date_short}</b>"]
    if day_name:
        line_parts.append(day_name)
    line_parts.append(f"Lukket af: <b>{closer}</b>")
    if bilagsnummer:
        line_parts.append(f"Bilag: <b>{bilagsnummer}</b>")
    story.append(Paragraph(" &nbsp;·&nbsp; ".join(line_parts), h_meta))

    story.append(HRFlowable(
        width="100%",
        color=colors.HexColor("#e5e7eb"),
        thickness=0.6,
        spaceBefore=8,
        spaceAfter=4,
    ))

    # ─── KONTANT block ────────────────────────────────────────────
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

    # ─── ANDRE block ──────────────────────────────────────────────
    story.append(Paragraph("ANDRE", section))
    other_rows = [
        ["Gift cards accepted (total)",      _money(aggregated.get("gift_cards_total"), currency)],
        ["Mobile Pay",                       _money(aggregated.get("mobilepay_total"), currency)],
    ]
    story.append(_kv_table(other_rows))

    # ─── Per-terminal block ──────────────────────────────────────
    terminals = aggregated.get("terminals") or []
    if terminals:
        story.append(Paragraph("KORTBETALINGER PR. TERMINAL", section))
        for i, t in enumerate(terminals, start=1):
            t_name = t.get("terminal_name") or f"Terminal {i}"
            story.append(Spacer(1, 3))
            story.append(Paragraph(f"<b>{i}. {t_name}</b>", styles["Normal"]))
            term_rows = [
                ["Dankort",                _money(t.get("dankort"), currency)],
                ["Teller",                 _money(t.get("teller"), currency)],
                ["Amex",                   _money(t.get("amex"), currency)],
                [f"Total terminal {i}",    _money(t.get("total"), currency)],
            ]
            story.append(_kv_table(term_rows, last_row_bold=True, indent=1))

    # ─── OPSUMMERING ──────────────────────────────────────────────
    story.append(Paragraph("OPSUMMERING", section))
    agg_rows = [
        ["Cards total",     _money(aggregated.get("cards_total"), currency)],
        ["Payments total",  _money(aggregated.get("payments_total"), currency)],
    ]
    story.append(_kv_table(agg_rows, all_bold=True))

    # ─── MOMS — required by SKAT for any kasserapport ────────────
    # If revenue.* fields aren't supplied (older closes), back-derive from
    # payments_total assuming Danish 25% rate. Marked "(estimat)" in that
    # case so the revisor knows it wasn't extracted directly.
    payments_total = aggregated.get("payments_total")
    revenue = aggregated.get("revenue") or {}
    moms_subtotal = revenue.get("subtotal_excl_moms")
    moms_amount = revenue.get("moms_amount")
    moms_total = revenue.get("total_incl_moms")

    if moms_total is None and payments_total is not None:
        # Back-derive from payments_total at 25% rate (DK standard)
        moms_total = payments_total
        moms_subtotal = payments_total / 1.25
        moms_amount = payments_total - moms_subtotal
        moms_estimate = True
    else:
        moms_estimate = False

    story.append(Paragraph(
        "MOMS  " + ("<font color='#6b7280' size='7'>(estimat fra payments_total ved 25%)</font>"
                    if moms_estimate else ""),
        section,
    ))
    moms_rows = [
        ["Subtotal ekskl. moms",     _money(moms_subtotal, currency)],
        ["Moms 25%",                 _money(moms_amount, currency)],
        ["Total inkl. moms",         _money(moms_total, currency)],
    ]
    story.append(_kv_table(moms_rows, last_row_bold=True))

    # ─── AFSTEMNING ──────────────────────────────────────────────
    story.append(Paragraph("AFSTEMNING", section))
    cash_diff = aggregated.get("cash_difference") or 0
    diff_flagged = bool(aggregated.get("cash_diff_flagged"))
    flagged_reason = aggregated.get("flagged_reason") or ""

    rec_rows = [
        ["Sales POS (incl. tax)",  _money(aggregated.get("sales_pos"), currency)],
        ["Cash difference (+/-)",  _money(cash_diff, currency)],
    ]
    rec_table = _kv_table(rec_rows, all_bold=True)
    diff_row_idx = len(rec_rows) - 1
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

    # ─── Signature lines ─────────────────────────────────────────
    story.append(Spacer(1, 24))
    sig_table = Table(
        [
            ["", ""],
            [
                Paragraph("<b>Lukket af</b>", h_meta),
                Paragraph("<b>Godkendt (ejer / leder)</b>", h_meta),
            ],
            [
                Paragraph(
                    f"<font color='#9ca3af' size='8'>{closer}</font>",
                    h_meta,
                ),
                Paragraph("<font color='#9ca3af' size='8'>____________________</font>", h_meta),
            ],
        ],
        colWidths=[80 * mm, 80 * mm],
    )
    sig_table.setStyle(TableStyle([
        ("LINEABOVE", (0, 1), (-1, 1), 0.4, colors.HexColor("#9ca3af")),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_table)

    doc.build(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
    return buf.getvalue()


def _kv_table(rows, *, all_bold: bool = False, last_row_bold: bool = False, indent: int = 0):
    """Helper — render a key/value 2-col table with consistent BonBox styling."""
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Table, TableStyle

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
    """Minimal fallback PDF when the main render fails."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import Paragraph, SimpleDocTemplate
        from reportlab.lib.styles import getSampleStyleSheet

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4)
        styles = getSampleStyleSheet()
        doc.build([
            Paragraph(
                f"<b>BonBox PDF generation failed.</b><br/><br/>"
                f"Reason: {reason[:200]}<br/><br/>"
                f"Please try again or send the close as text from the share sheet.",
                styles["Normal"],
            ),
        ])
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return (
            b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n"
            b"trailer<</Root 1 0 R>>\n%%EOF"
        )
