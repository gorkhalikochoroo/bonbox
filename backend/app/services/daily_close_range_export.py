"""Daily close range export — multi-day PDF + CSV + XLSX for accountant handoff.

Distinct from the per-close PDF (services/kasserapport_pdf.py) which
makes one polished receipt per closing day. This module aggregates a
DATE RANGE into a single document, with totals + averages so the
accountant can review a week / month / quarter at a glance.

Three formats:
  • PDF   — table with one row per close, totals + readiness badge.
            Danish labels for DKK tenants (matches the per-close PDF).
  • CSV   — same data tabular, semicolon-delimited + UTF-8 BOM so
            Danish-locale Excel opens it cleanly.
  • XLSX  — proper Excel workbook: typed columns (numbers as numbers,
            dates as dates), frozen header, auto-widths, Danish number
            format. The accountant can sort / filter / pivot directly.

Inputs are pre-filtered DailyClose ORM rows (date+user already
narrowed by the router); this service only formats.
"""
from __future__ import annotations

import csv
import io
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.daily_close import DailyClose, decode_breakdown
from app.utils.csv_safe import csv_safe


# ─── CSV ──────────────────────────────────────────────────────────────

_CSV_COLUMNS = [
    "date", "branch_id", "status",
    "revenue_total", "revenue_ex_moms", "moms_total", "moms_mode",
    "payment_total", "cash_expected", "cash_counted", "cash_difference",
    "tips_total", "tips_staff_count", "tips_per_person",
    "revenue_breakdown",   # encoded "food:12400|drinks:5800"
    "payment_breakdown",   # encoded "cash:4200|card:13500"
    "closed_by", "closed_at",
    "unlock_reason", "unlocked_by", "unlocked_at",
    "notes", "receipt_photo",
]


def _opt(v):
    """Format an optional float as fixed 2-decimal or empty string."""
    if v is None:
        return ""
    return f"{float(v):.2f}"


def closes_to_csv_bytes(closes: list[DailyClose]) -> bytes:
    """Serialize a list of DailyClose to CSV. UTF-8 BOM + semicolon
    delimiter so Danish Excel opens it cleanly with Æ/Ø/Å intact."""
    buf = io.StringIO()
    buf.write("﻿")
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(_CSV_COLUMNS)
    for c in closes:
        writer.writerow([
            c.date.isoformat() if c.date else "",
            str(c.branch_id) if c.branch_id else "",
            csv_safe(getattr(c, "status", "") or ""),
            _opt(c.revenue_total),
            _opt(c.revenue_ex_moms),
            _opt(c.moms_total),
            csv_safe(getattr(c, "moms_mode", "") or ""),
            _opt(c.payment_total),
            _opt(c.cash_expected),
            _opt(c.cash_counted),
            _opt(c.cash_difference),
            _opt(c.tips_total),
            c.tips_staff_count if c.tips_staff_count is not None else "",
            _opt(c.tips_per_person),
            csv_safe(c.revenue_categories or ""),
            csv_safe(c.payment_categories or ""),
            csv_safe(c.closed_by or ""),
            c.closed_at.isoformat() if c.closed_at else "",
            csv_safe(getattr(c, "unlock_reason", "") or ""),
            csv_safe(getattr(c, "unlocked_by", "") or ""),
            (c.unlocked_at.isoformat() if getattr(c, "unlocked_at", None) else ""),
            csv_safe(c.notes or ""),
            csv_safe(getattr(c, "receipt_photo", "") or ""),
        ])
    return buf.getvalue().encode("utf-8")


# ─── Helpers shared by PDF + XLSX ─────────────────────────────────────

# Payment-method buckets we surface as their own columns in PDF + XLSX.
# Anything unrecognized rolls into "other" so the totals still tie out.
_PAY_BUCKETS = ["cash", "card", "mobilepay", "gift_card", "bank_transfer"]


def _bucketed_payments(c: DailyClose) -> dict:
    """Decode encoded payment_categories into known buckets + 'other'."""
    out = {k: 0.0 for k in _PAY_BUCKETS}
    out["other"] = 0.0
    raw = decode_breakdown(c.payment_categories) or {}
    for k, v in raw.items():
        try:
            amt = float(v or 0)
        except (TypeError, ValueError):
            continue
        norm = (k or "").lower().replace(" ", "_").replace("-", "_")
        if norm in ("mobile_pay", "mobilepay_total"):
            norm = "mobilepay"
        if norm in ("giftcard", "gift_cards"):
            norm = "gift_card"
        if norm in _PAY_BUCKETS:
            out[norm] += amt
        else:
            out["other"] += amt
    return out


def _voucher_ranges(db: Session, user_id, dt: date) -> tuple[str, str]:
    """Return (sales_label, expense_label) bilagsnummer range for a day.

    Empty strings if no vouchers were recorded for that date. Used in
    both PDF and XLSX so the accountant can cross-check each row
    against the underlying voucher numbers."""
    if db is None or dt is None:
        return ("", "")
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense
        smin, smax = (
            db.query(func.min(Sale.voucher_number), func.max(Sale.voucher_number))
            .filter(
                Sale.user_id == user_id,
                Sale.date == dt,
                Sale.voucher_number.is_not(None),
                Sale.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
        emin, emax = (
            db.query(func.min(Expense.voucher_number), func.max(Expense.voucher_number))
            .filter(
                Expense.user_id == user_id,
                Expense.date == dt,
                Expense.voucher_number.is_not(None),
                Expense.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
    except Exception:
        return ("", "")

    def _fmt(prefix, lo, hi, year):
        if lo is None:
            return ""
        if lo == hi:
            return f"{prefix}-{year}-{lo:04d}"
        return f"{prefix}-{year}-{lo:04d} → {prefix}-{year}-{hi:04d}"

    return (
        _fmt("S", smin, smax, dt.year),
        _fmt("E", emin, emax, dt.year),
    )


# ─── PDF ──────────────────────────────────────────────────────────────

def build_daily_close_range_pdf(
    closes: list[DailyClose],
    *,
    from_date: date,
    to_date: date,
    business_name: str = "",
    currency: str = "DKK",
    profile=None,
    db: Session | None = None,
    user_id=None,
) -> bytes:
    """Build a multi-day daily-close PDF report — accountant-grade.

    What this PDF gives the accountant:
      • Business identity header (company_name, CVR, address, period)
      • One row per close: Date, Bilag, Revenue, MOMS (25%), Net,
                            Cash, Card, MobilePay, Cash diff, Status
      • Totals row (excludes Draft closes — only confirmed closes count)
      • Readiness badge: "X af Y closes klar til bogføring"
      • Footer cites Bogføringsloven §10 + Momsbekendtgørelsen §57

    Localized for DKK (Danish labels), else English.
    """
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
    )

    DA = (currency == "DKK")

    L = {
        "title":       "Kasserapport" if DA else "Daily Close",
        "period":      "Periode" if DA else "Period",
        "closes":      "lukninger" if DA else "closes",
        "across_days": "over" if DA else "across",
        "days":        "dage" if DA else "days",
        "amounts_in":  "Alle beløb i" if DA else "All amounts in",
        "no_closes":   "Ingen lukninger i denne periode." if DA else "No daily closes in this range.",
        # KPI band labels (kept short for the 4-up grid)
        "kpi_rev":     "Omsætning" if DA else "Revenue",
        "kpi_moms":    "Salgsmoms" if DA else "Output VAT",
        "kpi_net":     "Netto (uden moms)" if DA else "Net (excl. VAT)",
        "kpi_tips":    "Drikkepenge" if DA else "Tips",
        # Table headers
        "h_date":      "Dato" if DA else "Date",
        "h_bilag":     "Bilag" if DA else "Voucher",
        "h_rev":       "Omsætning" if DA else "Revenue",
        "h_moms":      "Moms 25%" if DA else "VAT 25%",
        "h_net":       "Netto" if DA else "Net",
        "h_cash":      "Kontant" if DA else "Cash",
        "h_card":      "Kort" if DA else "Card",
        "h_mobilepay": "MobilePay" if DA else "MobilePay",
        "h_diff":      "Diff" if DA else "Diff",
        "h_status":    "Status" if DA else "Status",
        # Status badges
        "locked":      "Lukket" if DA else "Confirmed",
        "draft":       "Kladde" if DA else "Draft",
        # Totals row
        "totals":      "I alt (bekræftede)" if DA else "Totals (confirmed)",
        "draft_excl":  "Kladder ikke medregnet" if DA else "Drafts not summed",
        # Readiness
        "ready":       "klar til bogføring" if DA else "ready for booking",
        "review":      "skal gennemgås" if DA else "need review",
        # Footer
        "footer_law":  (
            "Genereret af BonBox · Opbevares iht. Bogføringsloven §10 (5 år). "
            "Salgsmoms beregnet pr. Momsbekendtgørelsen §57."
        ) if DA else (
            "Generated by BonBox · Retention per Bogføringsloven §10 (5 years). "
            "VAT computed per Momsbekendtgørelsen §57."
        ),
    }

    # Sort ascending so the report reads chronologically.
    closes_sorted = sorted(closes, key=lambda c: c.date or date.min)

    # Danish-style date for header period
    if DA:
        _MM = ["jan", "feb", "mar", "apr", "maj", "jun",
               "jul", "aug", "sep", "okt", "nov", "dec"]
        def _date_short(d):
            return f"{d.day}. {_MM[d.month - 1]} {d.year}" if d else ""
    else:
        def _date_short(d):
            return d.strftime("%d %b %Y") if d else ""

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=14*mm, rightMargin=14*mm,
        topMargin=14*mm, bottomMargin=12*mm,
        title=f"{L['title']} — {business_name}",
        author="BonBox",
    )

    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    EMERALD = colors.HexColor("#065f46")
    AMBER = colors.HexColor("#92400e")
    EMERALD_BG = colors.HexColor("#d1fae5")
    AMBER_BG = colors.HexColor("#fef3c7")

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=15,
                        textColor=INK, fontName="Helvetica-Bold",
                        leading=18, spaceAfter=2)
    subtitle = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, leading=12, spaceAfter=6)
    section = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8,
                             textColor=MUTED, fontName="Helvetica-Bold",
                             leading=11, spaceBefore=8, spaceAfter=2)
    note = ParagraphStyle("Note", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique",
                          leading=11)

    story = []

    # ─── Business identity header ────────────────────────────────────
    biz_line = f"<font name='Helvetica-Bold' size='12'>{business_name or '—'}</font>"
    biz_meta = []
    if profile:
        if getattr(profile, "org_number", None):
            biz_meta.append(f"CVR {profile.org_number}")
        addr_parts = [p for p in [
            getattr(profile, "address", None),
            " ".join(p for p in [
                getattr(profile, "zipcode", None),
                getattr(profile, "city", None),
            ] if p),
        ] if p]
        if addr_parts:
            biz_meta.append(", ".join(addr_parts))
    head_left = biz_line
    if biz_meta:
        head_left += f"<br/><font color='#6b7280' size='9'>{' · '.join(biz_meta)}</font>"

    head_right = (
        f"<font name='Helvetica-Bold' size='11'>{L['title']}</font>"
        f"<br/><font color='#6b7280' size='9'>"
        f"{_date_short(from_date)} → {_date_short(to_date)}"
        f"</font>"
    )

    head_table = Table(
        [[Paragraph(head_left, subtitle), Paragraph(head_right, subtitle)]],
        colWidths=[160*mm, 110*mm],
    )
    head_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
    ]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=8))

    n_total = len(closes_sorted)
    confirmed = [c for c in closes_sorted if (getattr(c, "status", None) or "confirmed") == "confirmed"]
    drafts = [c for c in closes_sorted if (getattr(c, "status", None) or "confirmed") != "confirmed"]
    n_conf = len(confirmed)
    span_days = (to_date - from_date).days + 1 if to_date and from_date and to_date >= from_date else 1

    story.append(Paragraph(
        f"{n_total} {L['closes']} {L['across_days']} {span_days} {L['days']}  ·  {L['amounts_in']} {currency}",
        subtitle,
    ))

    if not closes_sorted:
        story.append(Spacer(1, 6))
        story.append(Paragraph(L["no_closes"], note))
        story.append(Spacer(1, 12))
        story.append(Paragraph(L["footer_law"], note))
        doc.build(story)
        return buf.getvalue()

    # ─── KPI band (only sums CONFIRMED — drafts excluded so totals are
    #   honest for the accountant) ────────────────────────────────────
    def _sum(attr):
        return sum(float(getattr(c, attr, 0) or 0) for c in confirmed)

    total_revenue = _sum("revenue_total")
    total_moms = _sum("moms_total")
    total_net = sum(
        float(c.revenue_ex_moms or 0) if c.revenue_ex_moms is not None
        else max(float(c.revenue_total or 0) - float(c.moms_total or 0), 0)
        for c in confirmed
    )
    total_tips = _sum("tips_total")

    def _fmt(v):
        if v is None or v == "":
            return "—"
        try:
            f = float(v)
        except (TypeError, ValueError):
            return "—"
        # Danish format: 1.234,56
        if DA:
            return f"{f:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        return f"{f:,.2f}"

    kpi_rows = [[
        Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_rev']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_revenue)}</font>", subtitle),
        Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_moms']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_moms)}</font>", subtitle),
        Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_net']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_net)}</font>", subtitle),
        Paragraph(f"<font color='#6b7280' size='8'>{L['kpi_tips']}</font><br/><font name='Helvetica-Bold' size='13'>{_fmt(total_tips)}</font>", subtitle),
    ]]
    kpi = Table(kpi_rows, colWidths=[68*mm, 68*mm, 68*mm, 66*mm])
    kpi.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f9fafb")),
        ("BOX", (0, 0), (-1, -1), 0.5, DIVIDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, DIVIDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(kpi)
    story.append(Spacer(1, 8))

    # ─── Per-close table — accountant columns ────────────────────────
    table_data = [[
        L["h_date"], L["h_bilag"], L["h_rev"], L["h_moms"], L["h_net"],
        L["h_cash"], L["h_card"], L["h_mobilepay"], L["h_diff"], L["h_status"],
    ]]

    for c in closes_sorted:
        pay = _bucketed_payments(c)
        vsales, _vexp = _voucher_ranges(db, user_id, c.date)
        revenue = float(c.revenue_total or 0)
        moms = float(c.moms_total or 0) if c.moms_total is not None else None
        net = (
            float(c.revenue_ex_moms or 0) if c.revenue_ex_moms is not None
            else (revenue - (moms or 0))
        )
        cash_diff = c.cash_difference
        cash_diff_str = ""
        if cash_diff is not None:
            sign = "+" if cash_diff > 0 else ""
            cash_diff_str = f"{sign}{_fmt(cash_diff)}"
        status = (getattr(c, "status", None) or "confirmed")
        table_data.append([
            _date_short(c.date),
            vsales or "—",
            _fmt(revenue),
            _fmt(moms) if moms is not None else "—",
            _fmt(net),
            _fmt(pay["cash"]) if pay["cash"] else "—",
            _fmt(pay["card"]) if pay["card"] else "—",
            _fmt(pay["mobilepay"]) if pay["mobilepay"] else "—",
            cash_diff_str or "—",
            L["locked"] if status == "confirmed" else L["draft"],
        ])

    # Totals (confirmed only)
    sum_cash = sum(_bucketed_payments(c)["cash"] for c in confirmed)
    sum_card = sum(_bucketed_payments(c)["card"] for c in confirmed)
    sum_mp = sum(_bucketed_payments(c)["mobilepay"] for c in confirmed)
    sum_diff = sum(
        float(c.cash_difference or 0) for c in confirmed
        if c.cash_difference is not None
    )

    table_data.append([
        f"{L['totals']} ({n_conf})", "",
        _fmt(total_revenue), _fmt(total_moms), _fmt(total_net),
        _fmt(sum_cash) if sum_cash else "—",
        _fmt(sum_card) if sum_card else "—",
        _fmt(sum_mp) if sum_mp else "—",
        _fmt(sum_diff) if any(c.cash_difference is not None for c in confirmed) else "—",
        "",
    ])

    col_widths = [26*mm, 26*mm, 24*mm, 22*mm, 24*mm, 22*mm, 22*mm, 24*mm, 18*mm, 22*mm]
    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("FONTSIZE", (0, 1), (-1, -1), 8.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
        ("ALIGN", (2, 0), (8, -1), "RIGHT"),
        ("ALIGN", (9, 0), (9, -1), "CENTER"),
        ("ALIGN", (1, 0), (1, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -2), 5),
        ("TOPPADDING", (0, 1), (-1, -2), 5),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, DIVIDER),
        ("LINEBELOW", (0, 1), (-1, -2), 0.25, DIVIDER),
        ("LINEABOVE", (0, -1), (-1, -1), 1, EMERALD),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), EMERALD_BG),
        ("TEXTCOLOR", (0, -1), (-1, -1), EMERALD),
    ]))
    story.append(table)

    # ─── Draft note (if any) ─────────────────────────────────────────
    if drafts:
        story.append(Spacer(1, 4))
        story.append(Paragraph(
            f"<font color='#92400e' size='8.5'>⚠ {len(drafts)} {L['draft'].lower()} — {L['draft_excl']}.</font>",
            note,
        ))

    # ─── Readiness badge ─────────────────────────────────────────────
    ready_count = sum(
        1 for c in confirmed
        if (c.moms_total is not None)
        and (c.cash_counted is None or abs(float(c.cash_difference or 0)) <= 100)
    )
    all_ready = (ready_count == n_conf and n_conf > 0)
    badge_text = L["ready"] if all_ready else L["review"]
    badge_color = EMERALD if all_ready else AMBER
    badge_bg = EMERALD_BG if all_ready else AMBER_BG
    icon = "✓" if all_ready else "⚠"

    story.append(Spacer(1, 8))
    badge = Table(
        [[Paragraph(
            f"<font name='Helvetica-Bold' color='{badge_color.hexval()}' size='10'>"
            f"{icon} {ready_count} / {n_conf} {badge_text}</font>",
            subtitle,
        )]],
        colWidths=[270*mm],
    )
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), badge_bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(badge)

    # ─── Footer ──────────────────────────────────────────────────────
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=4))
    story.append(Paragraph(L["footer_law"], note))

    doc.build(story)
    return buf.getvalue()


# ─── XLSX ─────────────────────────────────────────────────────────────

def build_daily_close_range_xlsx(
    closes: list[DailyClose],
    *,
    from_date: date,
    to_date: date,
    business_name: str = "",
    currency: str = "DKK",
    profile=None,
    db: Session | None = None,
    user_id=None,
) -> bytes:
    """Build an Excel workbook with two sheets:

      1. "Daily Close" — one row per close, typed columns (date as
         date, money as number with `# ##0,00` format). Frozen header,
         auto-widths, totals row using SUM() formulas so the accountant
         can edit rows and totals recompute live.
      2. "Summary" — KPI overview + business header.

    Accountants overwhelmingly prefer XLSX over PDF for end-of-period
    handoff because they can sort/filter/pivot. PDF stays available
    for the "send a one-pager to the bookkeeper" flow.
    """
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    DA = (currency == "DKK")

    # Localized headers — same vocabulary as the PDF for consistency
    H = (
        ["Dato", "Bilag (salg)", "Bilag (udgift)",
         "Omsætning", "Salgsmoms 25%", "Netto (uden moms)",
         "Kontant", "Kort", "MobilePay", "Gavekort", "Bank", "Andet",
         "Betalinger i alt", "Forventet kontant", "Optalt kontant", "Kasse-diff",
         "Drikkepenge", "Antal medarbejdere", "Pr. medarbejder",
         "Status", "Lukket af", "Lukket dato", "Bemærkninger"]
        if DA else
        ["Date", "Sales voucher", "Expense voucher",
         "Revenue", "Output VAT 25%", "Net (excl. VAT)",
         "Cash", "Card", "MobilePay", "Gift card", "Bank transfer", "Other",
         "Payments total", "Expected cash", "Counted cash", "Cash diff",
         "Tips", "Staff count", "Per person",
         "Status", "Closed by", "Closed at", "Notes"]
    )

    wb = Workbook()

    # ─── Sheet 1: Summary ─────────────────────────────────────────────
    s1 = wb.active
    s1.title = "Oversigt" if DA else "Summary"
    s1.column_dimensions["A"].width = 28
    s1.column_dimensions["B"].width = 40

    bold = Font(bold=True)
    big = Font(size=14, bold=True)

    s1["A1"] = business_name or "—"
    s1["A1"].font = big
    if profile:
        row = 2
        if getattr(profile, "org_number", None):
            s1.cell(row=row, column=1, value="CVR")
            s1.cell(row=row, column=2, value=str(profile.org_number))
            row += 1
        addr_parts = [p for p in [
            getattr(profile, "address", None),
            " ".join(p for p in [
                getattr(profile, "zipcode", None),
                getattr(profile, "city", None),
            ] if p),
        ] if p]
        if addr_parts:
            s1.cell(row=row, column=1, value="Adresse" if DA else "Address")
            s1.cell(row=row, column=2, value=", ".join(addr_parts))
            row += 1

    period_row = 6
    s1.cell(row=period_row, column=1, value="Periode" if DA else "Period").font = bold
    s1.cell(row=period_row, column=2, value=f"{from_date.isoformat()} → {to_date.isoformat()}")
    s1.cell(row=period_row + 1, column=1, value="Valuta" if DA else "Currency").font = bold
    s1.cell(row=period_row + 1, column=2, value=currency)
    s1.cell(row=period_row + 2, column=1, value="Antal lukninger" if DA else "Close count").font = bold
    s1.cell(row=period_row + 2, column=2, value=len(closes))

    confirmed = [c for c in closes if (getattr(c, "status", None) or "confirmed") == "confirmed"]

    total_revenue = sum(float(c.revenue_total or 0) for c in confirmed)
    total_moms = sum(float(c.moms_total or 0) for c in confirmed)
    total_net = sum(
        float(c.revenue_ex_moms or 0) if c.revenue_ex_moms is not None
        else max(float(c.revenue_total or 0) - float(c.moms_total or 0), 0)
        for c in confirmed
    )
    total_tips = sum(float(c.tips_total or 0) for c in confirmed)

    money_fmt = "# ##0,00" if DA else "#,##0.00"
    kpi_rows = [
        ("Omsætning i alt" if DA else "Total revenue", total_revenue),
        ("Salgsmoms i alt" if DA else "Total output VAT", total_moms),
        ("Netto (uden moms)" if DA else "Net (excl. VAT)", total_net),
        ("Drikkepenge i alt" if DA else "Total tips", total_tips),
    ]
    k_start = period_row + 4
    s1.cell(row=k_start, column=1, value="Totaler (kun bekræftede)" if DA else "Totals (confirmed only)").font = bold
    for i, (label, val) in enumerate(kpi_rows):
        r = k_start + 1 + i
        s1.cell(row=r, column=1, value=label)
        c = s1.cell(row=r, column=2, value=val)
        c.number_format = money_fmt
        c.alignment = Alignment(horizontal="right")

    # ─── Sheet 2: Daily Close detail ─────────────────────────────────
    s2 = wb.create_sheet("Kasserapport" if DA else "Daily Close")
    header_fill = PatternFill(start_color="F3F4F6", end_color="F3F4F6", fill_type="solid")
    thin = Side(border_style="thin", color="E5E7EB")
    border = Border(top=thin, bottom=thin, left=thin, right=thin)

    for col_idx, label in enumerate(H, start=1):
        cell = s2.cell(row=1, column=col_idx, value=label)
        cell.font = bold
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="left" if col_idx == 1 else "right", vertical="center")
        cell.border = border
    s2.freeze_panes = "A2"

    sorted_closes = sorted(closes, key=lambda c: c.date or date.min)
    for r, c in enumerate(sorted_closes, start=2):
        pay = _bucketed_payments(c)
        vsales, vexp = _voucher_ranges(db, user_id, c.date)
        revenue = float(c.revenue_total or 0) if c.revenue_total is not None else None
        moms = float(c.moms_total or 0) if c.moms_total is not None else None
        net = (
            float(c.revenue_ex_moms) if c.revenue_ex_moms is not None
            else (revenue - (moms or 0)) if revenue is not None else None
        )
        row_values = [
            c.date, vsales, vexp,
            revenue, moms, net,
            pay["cash"] or None, pay["card"] or None, pay["mobilepay"] or None,
            pay["gift_card"] or None, pay["bank_transfer"] or None, pay["other"] or None,
            float(c.payment_total) if c.payment_total is not None else None,
            float(c.cash_expected) if c.cash_expected is not None else None,
            float(c.cash_counted) if c.cash_counted is not None else None,
            float(c.cash_difference) if c.cash_difference is not None else None,
            float(c.tips_total) if c.tips_total is not None else None,
            c.tips_staff_count,
            float(c.tips_per_person) if c.tips_per_person is not None else None,
            ("Lukket" if DA else "Confirmed") if (getattr(c, "status", None) or "confirmed") == "confirmed"
                else ("Kladde" if DA else "Draft"),
            c.closed_by or "",
            c.closed_at.replace(tzinfo=None) if c.closed_at else None,
            c.notes or "",
        ]
        for col_idx, val in enumerate(row_values, start=1):
            cell = s2.cell(row=r, column=col_idx, value=val)
            cell.border = border
            if col_idx == 1 and val is not None:
                cell.number_format = "yyyy-mm-dd"
            elif col_idx >= 4 and col_idx <= 19 and isinstance(val, (int, float)):
                cell.number_format = money_fmt if col_idx != 18 else "0"  # staff count = integer
                cell.alignment = Alignment(horizontal="right")
            elif col_idx == 22 and val is not None:
                cell.number_format = "yyyy-mm-dd hh:mm"

    # Totals row with formulas (so the accountant can audit + edit)
    if sorted_closes:
        first = 2
        last = len(sorted_closes) + 1
        totals_row = last + 1
        s2.cell(row=totals_row, column=1, value=("I alt (bekræftede)" if DA else "Totals (confirmed)")).font = bold
        # Sum formulas for money columns (4..17)
        money_cols = list(range(4, 18))  # Revenue..Tips
        for col_idx in money_cols:
            letter = get_column_letter(col_idx)
            cell = s2.cell(row=totals_row, column=col_idx,
                           value=f"=SUM({letter}{first}:{letter}{last})")
            cell.font = bold
            cell.number_format = money_fmt
            cell.alignment = Alignment(horizontal="right")
            cell.fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
        for col_idx in [1, 2, 3, 18, 19, 20, 21, 22, 23]:
            cell = s2.cell(row=totals_row, column=col_idx)
            cell.fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")

    # Auto-ish column widths
    widths = [11, 16, 16, 13, 13, 14, 11, 11, 11, 11, 11, 11, 14, 13, 13, 12, 13, 11, 12, 12, 14, 18, 28]
    for i, w in enumerate(widths, start=1):
        s2.column_dimensions[get_column_letter(i)].width = w

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
