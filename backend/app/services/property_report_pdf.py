"""Daily Property Report → Copenhagen-clean PDF for accountant handoff.

Renders the same data the /daily-report screen shows, but as a clean
A4 PDF instead of a screenshot of the web page (which is what
window.print() produced before this module).

Design philosophy — matches kasserapport_pdf.py and the daily-close
range PDF: Helvetica, hairline dividers, Danish 1.234,56 number
format, mode-aware MOMS section (B2C extract vs B2B add-on-top vs
no-VAT flat).

Inputs are the dict returned by the /property-report endpoint plus
the BusinessProfile for the header. Side-effect free.
"""
from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from typing import Any
from app.utils.time import utc_now


_DK_DAYS = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"]


def _money(value: Any, currency: str = "DKK") -> str:
    """Danish-format currency: 1.234,56 DKK. None / non-numeric → '—'."""
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


def _format_dk_date(d: date | str) -> str:
    """'Onsdag, 7. maj 2026' — Danish day name + DD. month YYYY."""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d)
        except ValueError:
            return d
    months_da = [
        "januar", "februar", "marts", "april", "maj", "juni",
        "juli", "august", "september", "oktober", "november", "december",
    ]
    day_name = _DK_DAYS[d.weekday()]
    return f"{day_name}, {d.day}. {months_da[d.month - 1]} {d.year}"


def build_property_report_pdf(
    report: dict,
    *,
    profile: dict | None = None,
    business_name: str = "",
    closer_name: str | None = None,
) -> bytes:
    """Render the daily property report as a Copenhagen-clean PDF.

    Args:
      report   — dict from /api/property-report
      profile  — BusinessProfile dict for the header (CVR + address)
      business_name — fallback display name when profile.company_name is empty
      closer_name — display under the header if known (e.g. session user)

    Returns:
      PDF bytes (application/pdf).
    """
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    totals = report.get("totals") or {}
    channels = report.get("order_channels") or []
    tenders = report.get("tender_media") or []
    currency = report.get("currency") or "DKK"
    report_date = report.get("report_date") or ""

    # Copenhagen-clean palette (matches kasserapport_pdf.py)
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    DANGER = colors.HexColor("#b91c1c")
    OK = colors.HexColor("#15803d")

    biz_display = (profile or {}).get("company_name") or business_name or "Daily Report"

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title=f"Daily Report — {biz_display}",
        author="BonBox",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=2,
                        textColor=INK, fontName="Helvetica-Bold")
    sub = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=9,
                         textColor=MUTED, alignment=TA_RIGHT)
    section_title = ParagraphStyle(
        "Sect", parent=styles["Normal"], fontSize=8.5, textColor=MUTED,
        fontName="Helvetica-Bold", leading=12, spaceBefore=10, spaceAfter=4,
    )
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=10.5,
                         textColor=INK, fontName="Helvetica", leading=14)
    val_r = ParagraphStyle("ValR", parent=val, alignment=TA_RIGHT)
    val_b = ParagraphStyle("ValB", parent=val, fontName="Helvetica-Bold")
    val_br = ParagraphStyle("ValBR", parent=val_b, alignment=TA_RIGHT)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    story = []

    # ─── Header: title + date ─────────────────────────────────────
    head_table = Table(
        [[Paragraph("DAILY REPORT", h1), Paragraph(_format_dk_date(report_date), sub)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=4, spaceAfter=12))

    # ─── Business block ───────────────────────────────────────────
    biz_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_display}</font>"]
    if profile:
        addr_parts = []
        if profile.get("address"):
            addr_parts.append(profile["address"])
        z = profile.get("zipcode") or ""
        c = profile.get("city") or ""
        if z or c:
            addr_parts.append(f"{z} {c}".strip())
        if addr_parts:
            biz_lines.append(f"<font color='#6b7280'>{', '.join(addr_parts)}</font>")
        if profile.get("org_number"):
            biz_lines.append(f"<font color='#6b7280'>CVR {profile['org_number']}</font>")
    if closer_name:
        biz_lines.append(f"<font color='#6b7280'>Closed by: {closer_name}</font>")
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * mm))

    # ─── Headline: total revenue ──────────────────────────────────
    total_revenue = float(totals.get("total_revenue") or 0)
    story.append(Paragraph("TOTAL REVENUE", section_title))
    revenue_row = [[
        Paragraph(_money(total_revenue, currency),
                  ParagraphStyle("Big", parent=val_b, fontSize=20, leading=24)),
    ]]
    revenue_table = Table(revenue_row, colWidths=[166 * mm])
    revenue_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(revenue_table)
    if totals.get("voids_count") or totals.get("returns_count"):
        meta = []
        if totals.get("voids_count"):
            meta.append(f"{totals['voids_count']} voids")
        if totals.get("returns_count"):
            meta.append(f"{totals['returns_count']} returns")
        story.append(Paragraph(" · ".join(meta), foot))

    # ─── Order channels ───────────────────────────────────────────
    if channels:
        story.append(Paragraph("WHERE THE MONEY CAME FROM", section_title))
        rows = []
        for ch in channels:
            label = ch.get("label") or ch.get("channel") or "Channel"
            amount = ch.get("amount") or 0
            count = ch.get("count") or 0
            rows.append([
                Paragraph(label, val),
                Paragraph(f"{count} orders", ParagraphStyle("ct", parent=val, textColor=MUTED)),
                Paragraph(_money(amount, currency), val_r),
            ])
        t = Table(rows, colWidths=[80 * mm, 30 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)

    # ─── Payment methods ──────────────────────────────────────────
    if tenders:
        story.append(Paragraph("HOW CUSTOMERS PAID", section_title))
        rows = []
        for tm in tenders:
            label = tm.get("label") or tm.get("tender") or "Method"
            amount = tm.get("amount") or 0
            count = tm.get("count") or 0
            rows.append([
                Paragraph(label, val),
                Paragraph(f"×{count}", ParagraphStyle("ct", parent=val, textColor=MUTED)),
                Paragraph(_money(amount, currency), val_r),
            ])
        t = Table(rows, colWidths=[80 * mm, 30 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)

    # ─── Tax breakdown — mode-aware (incl / excl / none) ──────────
    moms_mode = (totals.get("moms_mode") or "incl").lower()
    rate_pct = totals.get("moms_rate_pct") or 25
    moms = float(totals.get("tax_collected") or 0)
    net = float(totals.get("all_sales_net") or 0)
    gross = float(totals.get("gross_sales") or totals.get("taxable_sales") or 0)

    if moms_mode != "none":
        story.append(Paragraph(f"TAX BREAKDOWN (MOMS {rate_pct}%)", section_title))
        if moms_mode == "incl":
            # B2C — extract Moms from gross
            tax_rows = [
                [Paragraph("Gross sales (incl. Moms)", val),
                 Paragraph(_money(gross, currency), val_r)],
                [Paragraph(f"Moms extracted ({rate_pct}%)", val),
                 Paragraph(f"−{_money(moms, currency)}",
                           ParagraphStyle("neg", parent=val_r, textColor=DANGER))],
                [Paragraph("Net sales (what you keep)", val_b),
                 Paragraph(_money(net, currency),
                           ParagraphStyle("ok", parent=val_br, textColor=OK))],
            ]
        else:  # excl — B2B
            tax_rows = [
                [Paragraph("Net sales (excl. Moms)", val),
                 Paragraph(_money(net, currency), val_r)],
                [Paragraph(f"Moms added on top ({rate_pct}%)", val),
                 Paragraph(f"+{_money(moms, currency)}",
                           ParagraphStyle("add", parent=val_r,
                                          textColor=colors.HexColor("#1d4ed8")))],
                [Paragraph("Total customer paid", val_b),
                 Paragraph(_money(gross, currency),
                           ParagraphStyle("ok", parent=val_br, textColor=OK))],
            ]
        tt = Table(tax_rows, colWidths=[110 * mm, 56 * mm])
        tt.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(tt)
        if moms_mode == "excl":
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(
                "Prices are entered as net (B2B). Customers pay the gross "
                "amount; the seller owes Moms to Skat.",
                foot,
            ))
    else:
        story.append(Paragraph("TOTAL SALES", section_title))
        tt = Table([[
            Paragraph("Total sales", val_b),
            Paragraph(_money(net, currency), val_br),
        ]], colWidths=[110 * mm, 56 * mm])
        tt.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(tt)
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(
            "No VAT applied — either rate is 0% in your jurisdiction or "
            "all sales were tax-exempt.",
            foot,
        ))

    # ─── Footer ───────────────────────────────────────────────────
    story.append(Spacer(1, 14 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=2, spaceAfter=4))
    generated = utc_now().strftime("%d/%m/%Y %H:%M UTC")
    story.append(Paragraph(
        f"Generated by BonBox · {generated} · "
        "Use this report alongside your accounting software.",
        foot,
    ))

    doc.build(story)
    return buf.getvalue()
