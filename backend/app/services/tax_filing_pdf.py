"""MOMS-angivelse filing-ready PDF — Pro-tier closing-the-loop artifact.

Task #51 — Tax Autopilot already estimates VAT and shows the countdown.
The Daily Brief nudges the owner to file. This module closes the loop
by producing the actual artifact the owner takes to SKAT.dk: a
pre-filled MOMS-angivelse PDF in the format the revisor expects.

Workflow:
  1. Owner sees "MOMS due in 7 days" on Tax Autopilot.
  2. Taps "Download filing-ready PDF" → this module renders.
  3. Owner reviews the numbers, signs the line, uploads to SKAT.dk
     (or forwards to revisor via "Email to my revisor").

Numbers are the SAME single source of truth as the Tax Autopilot UI —
we call `get_tax_overview()` and pull `current_month` / `ytd` /
`upcoming_deadlines` from there. This module NEVER reinvents the VAT
calc — that's the audit-disaster waiting to happen if the PDF showed
a different number than the screen.

Design philosophy — matches property_report_pdf.py:
  • Copenhagen-clean: 22mm margins, Helvetica, hairline dividers
  • Danish 1.234,56 kr. number format
  • Mode-aware: title in Danish for DKK, English otherwise
  • Bilagsnummer: MA-YYYYMMDD-YYYYMMDD (sortable, period-anchored)
  • Footer cites Bogføringsloven §10 (5-year retention)

The PDF is side-effect free. Audit logging happens in the router.
"""
from __future__ import annotations

from datetime import date, timedelta
from io import BytesIO
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.sale import Sale
from app.models.user import User
from app.services.tax_service import _calc_vat, _get_vat_rate, TAX_CONFIG
from app.utils.document_hash import (
    compute_document_hash,
    get_software_identifier,
    make_numbered_canvas,
    short_hash,
)
from app.utils.time import utc_now


# Danish month names for the period subtitle. Matches property_report_pdf.py.
_DA_MONTHS = [
    "januar", "februar", "marts", "april", "maj", "juni",
    "juli", "august", "september", "oktober", "november", "december",
]


def _money_dk(value: Any, currency: str = "DKK") -> str:
    """Danish-format currency: 1.234,56 kr. None / non-numeric → '—'.

    For DKK we use the Danish convention `12.345,67 kr.` (period as
    thousands separator, comma decimal, space + "kr." suffix). For
    non-DKK we use ISO-like `12,345.67 EUR`.
    """
    if value is None:
        return "—"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"

    # Snap sub-half-øre dust (including negative zero) to exactly 0 so a
    # rounding artifact like -0.001 renders "0,00 kr." and never "-0,00 kr.".
    if abs(n) < 0.005:
        n = 0.0

    is_dkk = (currency or "").upper() == "DKK"
    sign = "-" if n < 0 else ""
    abs_n = abs(n)
    whole = int(abs_n)
    fractional = round((abs_n - whole) * 100)
    if fractional == 100:
        whole += 1
        fractional = 0

    if is_dkk:
        whole_str = f"{whole:,}".replace(",", ".")
        return f"{sign}{whole_str},{fractional:02d} kr."
    else:
        whole_str = f"{whole:,}"
        return f"{sign}{whole_str}.{fractional:02d} {currency}"


def _format_period_dk(start: date, end: date) -> str:
    """Format a period range in Danish: "1. januar – 30. juni 2026".

    Compresses single-year ranges, expands cross-year ones.
    """
    if start.year == end.year:
        if start.month == end.month:
            return f"{start.day}.–{end.day}. {_DA_MONTHS[start.month - 1]} {start.year}"
        return (
            f"{start.day}. {_DA_MONTHS[start.month - 1]} – "
            f"{end.day}. {_DA_MONTHS[end.month - 1]} {end.year}"
        )
    return (
        f"{start.day}. {_DA_MONTHS[start.month - 1]} {start.year} – "
        f"{end.day}. {_DA_MONTHS[end.month - 1]} {end.year}"
    )


def _format_period_en(start: date, end: date) -> str:
    """Format a period range in English: 'Jan 1 – Jun 30, 2026'.

    Uses explicit integer formatting (start.day) rather than %-d because
    %-d is POSIX-only — Windows strftime crashes on it. Same A4 layout
    on every platform that runs the backend.
    """
    if start.year == end.year:
        return (
            f"{start.strftime('%b')} {start.day} – "
            f"{end.strftime('%b')} {end.day}, {end.year}"
        )
    return (
        f"{start.strftime('%b')} {start.day}, {start.year} – "
        f"{end.strftime('%b')} {end.day}, {end.year}"
    )


def _count_period_transactions(
    db: Session, user_id, period_start: date, period_end_exclusive: date,
) -> tuple[int, int]:
    """Count sales and expense transactions in the period for the
    reconciliation section. Mirrors the filters used in _calc_vat so
    the counts tie out with the totals.

    Returns (sales_count, expense_count).
    """
    # Sales = POS Sale rows (no invoice link) + Invoices (sent/paid/etc).
    pos_count = (
        db.query(func.count(Sale.id))
        .filter(
            Sale.user_id == user_id,
            Sale.date >= period_start,
            Sale.date < period_end_exclusive,
            Sale.is_deleted.isnot(True),
            Sale.is_tax_exempt.isnot(True),
            Sale.invoice_id.is_(None),
        )
        .scalar()
    ) or 0
    inv_count = (
        db.query(func.count(Invoice.id))
        .filter(
            Invoice.user_id == user_id,
            Invoice.issue_date >= period_start,
            Invoice.issue_date < period_end_exclusive,
            Invoice.status.in_(("sent", "paid", "overdue", "credited")),
        )
        .scalar()
    ) or 0
    exp_count = (
        db.query(func.count(Expense.id))
        .filter(
            Expense.user_id == user_id,
            Expense.date >= period_start,
            Expense.date < period_end_exclusive,
            Expense.is_personal.isnot(True),
            Expense.is_deleted.isnot(True),
            Expense.is_tax_exempt.isnot(True),
        )
        .scalar()
    ) or 0
    return int(pos_count + inv_count), int(exp_count)


def compute_filing_data(
    db: Session, user: User, period_start: date, period_end: date,
) -> dict:
    """Compute the MOMS-angivelse fields for a period.

    Single source of truth: routes through `_calc_vat()` from
    tax_service.py — the SAME function the Tax Autopilot overview
    uses. If you ever feel tempted to do the math here directly,
    STOP — the whole point is that screen + PDF + revisor email all
    show the same numbers.

    Args:
      db: active SQLAlchemy session.
      user: tenant user (defines currency, prices_include_moms, id).
      period_start: inclusive start date of the reporting period.
      period_end: inclusive end date.

    Returns:
      Dict with all the MOMS-angivelse fields the PDF renders.
    """
    currency = user.currency or "DKK"
    vat_rate = _get_vat_rate(currency)
    prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    # _calc_vat takes an EXCLUSIVE end (period_end_exclusive). We
    # accept inclusive end here for callers' clarity.
    period_end_exclusive = period_end + timedelta(days=1)
    vat = _calc_vat(db, user.id, period_start, period_end_exclusive,
                    vat_rate, prices_incl_moms)

    sales_count, expense_count = _count_period_transactions(
        db, user.id, period_start, period_end_exclusive,
    )

    # ── Section A — Salg (Sales) ─────────────────────────────
    # sales_total is gross when prices_include_moms (B2C), net otherwise (B2B).
    # output_vat is the MOMS portion of sales.
    # salg_med_moms = gross TAXABLE revenue (sales_total - exempt_sales)
    # salg_uden_moms = exempt/zero-rated revenue. Pulled from `_calc_vat`'s
    #   `exempt_sales` (added 2026-05-24): sum of Sale rows where
    #   `is_tax_exempt=true` PLUS Invoice rows where `moms_total=0`
    #   (EU reverse-charge, exports, §13 nr.17 events, gift cards, etc.).
    #   Before that fix, `salg_uden_moms` was hardcoded to 0.0 — any user
    #   with exempt sales had them SILENTLY DROPPED from the SKAT angivelse.
    #
    # 2026-05-28 — second fix (audit a26d37c R3): `salg_med_moms` was using
    # `sales_total` directly, which still INCLUDES `exempt_sales`. That
    # double-counted: e.g. 100k taxable + 20k exempt showed 120k on "Salg med
    # moms" AND 20k on "Salg uden moms" = 140k. Sum-doesn't-equal-parts.
    # Now uses the dedicated `taxable_sales` field (sales_total - exempt_sales).
    salg_med_moms = vat.get("taxable_sales", vat["sales_total"] - vat.get("exempt_sales", 0.0))
    salg_uden_moms = vat.get("exempt_sales", 0.0)
    moms_af_salg = vat["output_vat"]

    # ── Section B — Køb (Purchases) ──────────────────────────
    kob_med_moms = vat["expenses_total"]
    moms_af_kob = vat["input_vat"]

    # ── Section C — Netto ────────────────────────────────────
    # Positive = owed to SKAT, negative = refund due.
    moms_til_skat = vat["vat_payable"]

    return {
        "currency": currency,
        "vat_rate": vat_rate,
        "vat_rate_pct": round(vat_rate * 100, 1),
        "period_start": period_start,
        "period_end": period_end,
        "prices_include_moms": prices_incl_moms,
        # Section A
        "salg_med_moms": salg_med_moms,
        "salg_uden_moms": salg_uden_moms,
        "moms_af_salg": moms_af_salg,
        # Section B
        "kob_med_moms": kob_med_moms,
        "moms_af_kob": moms_af_kob,
        # Section C
        "moms_til_skat": moms_til_skat,
        # Section D
        "sales_count": sales_count,
        "expense_count": expense_count,
        # POS vs invoice split for transparency. Section D2 ("Kilder")
        # used to flatten the two POS sources into a single "POS-kassesalg
        # (Sale)" line, which silently included kasserapport revenue that
        # never touched the Sale table. Split them apart so a revisor
        # auditing the PDF can trace back to either the Sale rows or the
        # confirmed DailyClose rows that fed each number.
        "pos_revenue": vat["pos_revenue"],
        "pos_revenue_from_sales": vat.get("pos_revenue_from_sales", vat["pos_revenue"]),
        "pos_revenue_from_closes": vat.get("pos_revenue_from_closes", 0.0),
        "invoice_revenue": vat["invoice_revenue"],
        # Bogføringsloven §9 stk. 2 — per-date variance between close
        # and Sale rows on the same date. Empty list = clean; non-empty
        # = the revisor sees a "Bemærkninger" section before signature.
        "variance_warnings": vat.get("variance_warnings", []),
    }


def make_bilagsnummer(period_start: date, period_end: date) -> str:
    """Stable, sortable voucher number for the filing.

    Format: MA-YYYYMMDD-YYYYMMDD (start-end). MA = MOMS-Angivelse.

    Two periods that overlap produce different bilagsnumre — so an
    accountant viewing a folder of these can sort by name and see
    them in chronological order.
    """
    return f"MA-{period_start.strftime('%Y%m%d')}-{period_end.strftime('%Y%m%d')}"


def build_moms_filing_pdf(
    db: Session,
    user: User,
    period_start: date,
    period_end: date,
    *,
    profile: Any | None = None,
    business_name: str = "",
) -> bytes:
    """Render the MOMS-angivelse filing-ready PDF.

    Args:
      db: active session for the data fetches.
      user: tenant user; defines currency + prices_include_moms.
      period_start: inclusive period start date.
      period_end: inclusive period end date.
      profile: BusinessProfile row (optional — supplies CVR + address).
      business_name: fallback display name.

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

    data = compute_filing_data(db, user, period_start, period_end)
    currency = data["currency"]
    is_danish = (currency or "").upper() == "DKK"

    # Localized title — matches property_report_pdf.py convention.
    # "MOMS-ANGIVELSE" is the canonical Danish SKAT term.
    title_text = "MOMS-ANGIVELSE" if is_danish else "VAT RETURN"

    bilagsnummer = make_bilagsnummer(period_start, period_end)

    # Copenhagen-clean palette — exact match with property_report_pdf.py.
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    OK = colors.HexColor("#15803d")
    NET_OWED = colors.HexColor("#15803d")    # emerald when owed
    NET_REFUND = colors.HexColor("#6b7280")  # stone when refund

    biz_display = (
        (getattr(profile, "company_name", None) if profile else None)
        or business_name
        or (user.business_name if hasattr(user, "business_name") else "")
        or ("MOMS-angivelse" if is_danish else "VAT Return")
    )

    buf = BytesIO()
    software_id = get_software_identifier()
    generated_at = utc_now()
    generated_at_str = generated_at.strftime("%Y-%m-%d %H:%M UTC")
    generator_email = (getattr(user, "email", None) or "system")

    # Document hash is set after pass 1 (computing it requires the
    # rendered bytes). The audit footer carries this for tamper-
    # evidence — see _final_footer below.
    doc_hash_holder = {"value": "pending"}

    def _draw_audit_footer(canv, page_num, total_pages):
        """Footer drawn on every page by the NumberedCanvas.

        Layout (bottom of page):
          • Left:   Doc-hash: <16 hex chars>
          • Center: Generated YYYY-MM-DD HH:MM UTC by user@email · BonBox v…
          • Right:  Side X / Y
        """
        from reportlab.lib import colors as _c
        canv.saveState()
        canv.setFont("Helvetica", 6.8)
        canv.setFillColor(_c.HexColor("#94a3b8"))
        canv.drawRightString(
            A4[0] - 22 * mm, 10 * mm,
            ("Side " if is_danish else "Page ") + f"{page_num} / {total_pages}",
        )
        canv.drawCentredString(
            A4[0] / 2, 10 * mm,
            f"{('Genereret' if is_danish else 'Generated')} "
            f"{generated_at_str} {('af' if is_danish else 'by')} "
            f"{generator_email}  ·  {software_id}",
        )
        canv.drawString(
            22 * mm, 10 * mm,
            f"Doc-hash: {doc_hash_holder['value']}",
        )
        canv.restoreState()

    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=22 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title=f"MOMS-angivelse — {biz_display}",
        author="BonBox",
        creator=software_id,
        subject=f"MOMS {bilagsnummer}",
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

    # ─── Header ──────────────────────────────────────────────
    if is_danish:
        period_label = _format_period_dk(period_start, period_end)
        bilag_label = "Bilagsnr"
    else:
        period_label = _format_period_en(period_start, period_end)
        bilag_label = "Voucher"

    date_block = (
        f"{period_label}<br/>"
        f"<font size='8'>{bilag_label} {bilagsnummer}</font>"
    )
    head_table = Table(
        [[Paragraph(title_text, h1), Paragraph(date_block, sub)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=4, spaceAfter=12))

    # ─── Business block ──────────────────────────────────────
    biz_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_display}</font>"]
    if profile:
        addr_parts = []
        if getattr(profile, "address", None):
            addr_parts.append(profile.address)
        z = getattr(profile, "zipcode", None) or ""
        c = getattr(profile, "city", None) or ""
        if z or c:
            addr_parts.append(f"{z} {c}".strip())
        if addr_parts:
            biz_lines.append(f"<font color='#6b7280'>{', '.join(addr_parts)}</font>")
        # Surface CVR + VAT number (when distinct) — a SKAT-auditor
        # expects to see both. For DK the two are typically identical
        # but EU-cross-border filers carry separate numbers.
        cvr = getattr(profile, "org_number", None)
        vat_no = getattr(profile, "vat_number", None)
        if cvr:
            cvr_label = "CVR" if is_danish else "Org. nr."
            biz_lines.append(
                f"<font color='#6b7280'>{cvr_label} {cvr}</font>"
            )
        if vat_no and vat_no != cvr:
            biz_lines.append(
                f"<font color='#6b7280'>VAT {vat_no}</font>"
            )
    # MOMS-registered confirmation footer
    if is_danish:
        biz_lines.append(
            f"<font color='#6b7280' size='9'>"
            f"Momssats: {data['vat_rate_pct']}%</font>"
        )
    else:
        biz_lines.append(
            f"<font color='#6b7280' size='9'>"
            f"VAT rate: {data['vat_rate_pct']}%</font>"
        )
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * mm))

    # ─── Section A — Salg (Sales) ────────────────────────────
    if is_danish:
        story.append(Paragraph("A · SALG", section_title))
        labels = {
            "salg_med": "Salg med moms (omsætning inkl. moms)" if data["prices_include_moms"]
                        else "Salg med moms (omsætning ekskl. moms)",
            "salg_uden": "Salg uden moms (eksempt / nul-sats)",
            "moms_salg": "Moms af salg (udgående moms)",
        }
    else:
        story.append(Paragraph("A · SALES", section_title))
        labels = {
            "salg_med": "Taxable sales (gross)" if data["prices_include_moms"]
                        else "Taxable sales (net)",
            "salg_uden": "Zero-rated / exempt sales",
            "moms_salg": "Output VAT",
        }

    a_rows = [
        [Paragraph(labels["salg_med"], val),
         Paragraph(_money_dk(data["salg_med_moms"], currency), val_r)],
        [Paragraph(labels["salg_uden"], val),
         Paragraph(_money_dk(data["salg_uden_moms"], currency), val_r)],
        [Paragraph(labels["moms_salg"], val_b),
         Paragraph(_money_dk(data["moms_af_salg"], currency),
                   ParagraphStyle("acc", parent=val_br,
                                  textColor=colors.HexColor("#4338ca")))],
    ]
    ta = Table(a_rows, colWidths=[110 * mm, 56 * mm])
    ta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(ta)

    # ─── Section B — Køb (Purchases) ─────────────────────────
    if is_danish:
        story.append(Paragraph("B · KØB", section_title))
        labels_b = {
            "kob_med": "Køb med moms (varekøb inkl. moms)",
            "moms_kob": "Moms af køb (indgående moms)",
        }
    else:
        story.append(Paragraph("B · PURCHASES", section_title))
        labels_b = {
            "kob_med": "Taxable purchases (gross)",
            "moms_kob": "Input VAT",
        }

    b_rows = [
        [Paragraph(labels_b["kob_med"], val),
         Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
        [Paragraph(labels_b["moms_kob"], val_b),
         Paragraph(_money_dk(data["moms_af_kob"], currency),
                   ParagraphStyle("acc", parent=val_br,
                                  textColor=colors.HexColor("#1d4ed8")))],
    ]
    tb = Table(b_rows, colWidths=[110 * mm, 56 * mm])
    tb.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(tb)

    # ─── Section C — Netto (Net to SKAT) ─────────────────────
    moms_til_skat = data["moms_til_skat"]
    # Snap near-zero dust to exactly 0 so a 1-øre rounding artifact never
    # renders as a misleading "Tilgode hos SKAT / Refund due" on the filing.
    if abs(moms_til_skat) < 0.01:
        moms_til_skat = 0.0
    is_owed = moms_til_skat > 0
    if is_danish:
        story.append(Paragraph("C · TIL BETALING / TILGODE", section_title))
        c_label = "Moms til SKAT (positiv = skyldig, negativ = tilgode)"
        big_caption = "Skyldig moms" if is_owed else ("Tilgode hos SKAT"
                       if moms_til_skat < 0 else "Ingen moms at indberette")
    else:
        story.append(Paragraph("C · NET", section_title))
        c_label = "Net VAT (positive = owed, negative = refund)"
        big_caption = "Owed to tax authority" if is_owed else ("Refund due"
                       if moms_til_skat < 0 else "No VAT to report")

    big_color = NET_OWED if is_owed else NET_REFUND
    story.append(Paragraph(
        f"<font color='#6b7280' size='9'>{c_label}</font>",
        ParagraphStyle("clab", parent=val, leading=12),
    ))
    big_row = [[
        Paragraph(_money_dk(abs(moms_til_skat), currency),
                  ParagraphStyle("Big", parent=val_b, fontSize=22, leading=26,
                                 textColor=big_color)),
        Paragraph(f"<font color='#6b7280' size='9'>{big_caption}</font>",
                  ParagraphStyle("bcap", parent=val_r, leading=12)),
    ]]
    big_table = Table(big_row, colWidths=[110 * mm, 56 * mm])
    big_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(big_table)

    # ─── Section D — Sammenhæng (Reconciliation) ─────────────
    if is_danish:
        story.append(Paragraph("D · SAMMENHÆNG", section_title))
        d_rows = [
            [Paragraph("Antal salgsbilag", val),
             Paragraph(f"{data['sales_count']}", val_r)],
            [Paragraph("Antal udgiftsbilag", val),
             Paragraph(f"{data['expense_count']}", val_r)],
            [Paragraph("Periode", val),
             Paragraph(period_label, val_r)],
        ]
    else:
        story.append(Paragraph("D · RECONCILIATION", section_title))
        d_rows = [
            [Paragraph("Sales transactions", val),
             Paragraph(f"{data['sales_count']}", val_r)],
            [Paragraph("Expense transactions", val),
             Paragraph(f"{data['expense_count']}", val_r)],
            [Paragraph("Period", val),
             Paragraph(period_label, val_r)],
        ]
    td = Table(d_rows, colWidths=[110 * mm, 56 * mm])
    td.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(td)

    # ─── Section D2 — Source traceability ────────────────────
    # For each number on the angivelse, where did it come from? An
    # auditor expects to see the DB sources broken out: POS Sale rows,
    # Invoice rows, Expense rows. Aligns with Bogføringsloven §9
    # ("every entry traceable to its source").
    # D2 sources — split POS into Sale-rows + Kasserapport (DailyClose).
    # Pre-2026-05-28 this was a single line "POS-kassesalg (Sale)" using
    # vat["pos_revenue"], which after the DailyClose integration silently
    # included kasserapport revenue that never touched the Sale table.
    # Revisor traceability degraded — caught in audit a26d37c → A5.
    _pos_from_sales = data.get("pos_revenue_from_sales", data["pos_revenue"])
    _pos_from_closes = data.get("pos_revenue_from_closes", 0.0)
    if is_danish:
        story.append(Paragraph("D2 · KILDER", section_title))
        src_rows = [
            [Paragraph("POS-kassesalg (Sale)", val),
             Paragraph(_money_dk(_pos_from_sales, currency), val_r)],
            [Paragraph("Kasserapport (Dagsafslutning)", val),
             Paragraph(_money_dk(_pos_from_closes, currency), val_r)],
            [Paragraph("Fakturasalg (Invoice)", val),
             Paragraph(_money_dk(data["invoice_revenue"], currency), val_r)],
            [Paragraph("Sum (= Salg med moms)", val_b),
             Paragraph(_money_dk(data["salg_med_moms"], currency), val_br)],
            [Paragraph("Bogførte udgifter (Expense)", val),
             Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
            [Paragraph("Indgående moms heraf", val_b),
             Paragraph(_money_dk(data["moms_af_kob"], currency), val_br)],
        ]
    else:
        story.append(Paragraph("D2 · SOURCES", section_title))
        src_rows = [
            [Paragraph("POS sales (Sale)", val),
             Paragraph(_money_dk(_pos_from_sales, currency), val_r)],
            [Paragraph("Kasserapport (Daily Close)", val),
             Paragraph(_money_dk(_pos_from_closes, currency), val_r)],
            [Paragraph("Invoice sales (Invoice)", val),
             Paragraph(_money_dk(data["invoice_revenue"], currency), val_r)],
            [Paragraph("Sum (= taxable sales)", val_b),
             Paragraph(_money_dk(data["salg_med_moms"], currency), val_br)],
            [Paragraph("Logged expenses (Expense)", val),
             Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
            [Paragraph("Input VAT from above", val_b),
             Paragraph(_money_dk(data["moms_af_kob"], currency), val_br)],
        ]
    td2 = Table(src_rows, colWidths=[110 * mm, 56 * mm])
    td2.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("LINEABOVE", (0, 2), (-1, 2), 0.4, DIVIDER),
    ]))
    story.append(td2)

    # ─── Section D3 — Bemærkninger (Bogføringsloven §9 stk. 2) ───
    # Per-date variance between close.revenue_total and Sale-sum on
    # the same date. Only renders when non-empty — keeps the PDF
    # clean for clean books. When present, revisor MUST review before
    # signing. Amber styling (advisory, not error).
    _variance = data.get("variance_warnings") or []
    if _variance:
        AMBER = colors.HexColor("#b45309")  # amber-700
        AMBER_BG = colors.HexColor("#fffbeb")  # amber-50
        story.append(Spacer(1, 4 * mm))
        if is_danish:
            story.append(Paragraph(
                "D3 · BEMÆRKNINGER (Bogføringsloven §9 stk. 2)",
                ParagraphStyle("vt", parent=section_title, textColor=AMBER),
            ))
            story.append(Paragraph(
                "Kasserapport og POS-salg afviger på følgende datoer. "
                "Afstem før indberetning til SKAT.",
                ParagraphStyle("vd", parent=val, textColor=AMBER, leading=12),
            ))
            v_header = ["Dato", "Kasserapport", "POS-salg", "Forskel"]
        else:
            story.append(Paragraph(
                "D3 · NOTES (Record-keeping law §9 stk. 2)",
                ParagraphStyle("vt", parent=section_title, textColor=AMBER),
            ))
            story.append(Paragraph(
                "Daily Close and POS sales disagree on the following "
                "dates. Reconcile before filing with SKAT.",
                ParagraphStyle("vd", parent=val, textColor=AMBER, leading=12),
            ))
            v_header = ["Date", "Daily Close", "POS sales", "Delta"]
        v_rows = [[Paragraph(h, val_b) for h in v_header]]
        for w in _variance:
            sign = "+" if (w.get("delta") or 0) > 0 else ""
            v_rows.append([
                Paragraph(str(w.get("date", "")), val),
                Paragraph(_money_dk(w.get("close_revenue", 0), currency), val_r),
                Paragraph(_money_dk(w.get("sale_sum", 0), currency), val_r),
                Paragraph(
                    f"{sign}{_money_dk(w.get('delta', 0), currency)} "
                    f"({w.get('delta_pct', 0):.1f}%)",
                    ParagraphStyle("vr", parent=val_r, textColor=AMBER),
                ),
            ])
        tv = Table(v_rows, colWidths=[28 * mm, 46 * mm, 46 * mm, 46 * mm])
        tv.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BACKGROUND", (0, 0), (-1, 0), AMBER_BG),
            ("LINEBELOW", (0, 0), (-1, 0), 0.4, AMBER),
        ]))
        story.append(tv)

    # ─── Section E — Signering (Signature) ───────────────────
    story.append(Spacer(1, 8 * mm))
    if is_danish:
        story.append(Paragraph("E · SIGNERING", section_title))
        sign_label = "Underskrevet af"
        date_label = "Dato"
    else:
        story.append(Paragraph("E · SIGNATURE", section_title))
        sign_label = "Signed by"
        date_label = "Date"
    sign_rows = [
        [Paragraph(f"{sign_label}: ____________________________________", val),
         Paragraph(f"{date_label}: ___________________", val)],
    ]
    ts = Table(sign_rows, colWidths=[110 * mm, 56 * mm])
    ts.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(ts)

    # ─── Footer + disclaimer ─────────────────────────────────
    # Disclaimer: BonBox produces this PDF from the data the owner
    # entered. The owner — not BonBox — is responsible for submitting
    # to SKAT and verifying against their own records. SKAT regards
    # the registered MOMS-pligtige party as responsible regardless of
    # which software produced the angivelse.
    story.append(Spacer(1, 6 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=2, spaceAfter=4))
    generated = generated_at_str
    if is_danish:
        footer_text = (
            f"Genereret af {software_id} · {generated}<br/>"
            "Opbevares i 5 år iht. Bogføringsloven §10 · "
            "Indberettes på SKAT.dk eller sendes til revisor."
        )
        disclaimer_text = (
            f"Denne PDF afspejler BonBox's beregning pr. {generated}. "
            "Brugeren er ansvarlig for at indberette beløbene på SKAT.dk "
            "og afstemme dem med egne regnskabsbilag før indsendelse."
        )
    else:
        footer_text = (
            f"Generated by {software_id} · {generated}<br/>"
            "Retain for 5 years per record-keeping law · "
            "File with your tax authority or forward to your accountant."
        )
        disclaimer_text = (
            f"This PDF reflects BonBox's calculation as of {generated}. "
            "The user is responsible for uploading to SKAT.dk and "
            "verifying against their own records before submission."
        )
    story.append(Paragraph(footer_text, foot))
    story.append(Spacer(1, 1 * mm))
    story.append(Paragraph(
        f"<font color='#94a3b8' size='7'><i>{disclaimer_text}</i></font>",
        foot,
    ))

    # ─── Build with NumberedCanvas (accurate Page X of Y) ────
    # First build computes the document hash from the rendered bytes.
    # We then patch the hash holder + rebuild once more — only TWO doc
    # objects involved, never reusing flowables that ReportLab mutated.
    # NumberedCanvas defers per-page footer rendering until after build
    # so total page count is known, sidestepping reportlab's
    # canvas-level constraint that getPageNumber() inside build()
    # doesn't know the final total.
    canvas_maker = make_numbered_canvas(_draw_audit_footer)
    # Pass 1: hash placeholder is "pending".
    doc.build(list(story), canvasmaker=canvas_maker)
    pass1_bytes = buf.getvalue()
    doc_hash_holder["value"] = short_hash(pass1_bytes, length=16)

    # Pass 2: rebuild with the real hash. Fresh buf + fresh doc so
    # reportlab doesn't trip over previously-laid-out flowables.
    buf2 = BytesIO()
    doc2 = SimpleDocTemplate(
        buf2, pagesize=A4,
        topMargin=22 * mm, bottomMargin=22 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title=doc.title, author=doc.author,
        creator=software_id, subject=doc.subject,
    )
    # Rebuild the story flowables — calling the original function would
    # be cleanest, but cheaper here to just re-collect them since we
    # haven't moved the source data. ReportLab's `build` mutates
    # flowables in-place so a true second pass needs fresh objects.
    story2 = _rebuild_filing_story(
        data=data, profile=profile, biz_display=biz_display,
        period_start=period_start, period_end=period_end,
        bilagsnummer=bilagsnummer, software_id=software_id,
        generated_at_str=generated_at_str, currency=currency,
        is_danish=is_danish,
    )
    doc2.build(story2, canvasmaker=canvas_maker)
    return buf2.getvalue()


def _rebuild_filing_story(
    *, data: dict, profile: Any, biz_display: str,
    period_start: date, period_end: date, bilagsnummer: str,
    software_id: str, generated_at_str: str, currency: str,
    is_danish: bool,
) -> list:
    """Recreate the filing PDF story as fresh flowables.

    ReportLab mutates Paragraph/Table/Spacer objects during build (sets
    `_postponed`, splitter state, etc.). For our 2-pass render — where
    pass 1 captures the document hash and pass 2 re-renders with that
    hash visible in the footer — we need a clean second set of
    flowables. Inlining the build logic here keeps it next to the main
    renderer for easy auditing without exposing it as a public API.
    """
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4 as _A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm as _mm
    from reportlab.platypus import (
        HRFlowable, Paragraph, Spacer, Table, TableStyle,
    )

    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    NET_OWED = colors.HexColor("#15803d")
    NET_REFUND = colors.HexColor("#6b7280")

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

    title_text = "MOMS-ANGIVELSE" if is_danish else "VAT RETURN"
    story: list = []

    # Header
    if is_danish:
        period_label = _format_period_dk(period_start, period_end)
        bilag_label = "Bilagsnr"
    else:
        period_label = _format_period_en(period_start, period_end)
        bilag_label = "Voucher"
    date_block = (
        f"{period_label}<br/>"
        f"<font size='8'>{bilag_label} {bilagsnummer}</font>"
    )
    head_table = Table(
        [[Paragraph(title_text, h1), Paragraph(date_block, sub)]],
        colWidths=[100 * _mm, 66 * _mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=4, spaceAfter=12))

    # Business block
    biz_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_display}</font>"]
    if profile:
        addr_parts = []
        if getattr(profile, "address", None):
            addr_parts.append(profile.address)
        z = getattr(profile, "zipcode", None) or ""
        c = getattr(profile, "city", None) or ""
        if z or c:
            addr_parts.append(f"{z} {c}".strip())
        if addr_parts:
            biz_lines.append(f"<font color='#6b7280'>{', '.join(addr_parts)}</font>")
        cvr = getattr(profile, "org_number", None)
        vat_no = getattr(profile, "vat_number", None)
        if cvr:
            cvr_label = "CVR" if is_danish else "Org. nr."
            biz_lines.append(f"<font color='#6b7280'>{cvr_label} {cvr}</font>")
        if vat_no and vat_no != cvr:
            biz_lines.append(f"<font color='#6b7280'>VAT {vat_no}</font>")
    rate_label = ("Momssats" if is_danish else "VAT rate")
    biz_lines.append(
        f"<font color='#6b7280' size='9'>{rate_label}: {data['vat_rate_pct']}%</font>"
    )
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * _mm))

    # Sections A, B, C, D, D2, E — re-use the existing labels.
    # (Implementation deliberately mirrors the original story builder
    # in build_moms_filing_pdf; if you change one, change the other.)
    if is_danish:
        story.append(Paragraph("A · SALG", section_title))
        labels = {
            "salg_med": "Salg med moms (omsætning inkl. moms)" if data["prices_include_moms"]
                        else "Salg med moms (omsætning ekskl. moms)",
            "salg_uden": "Salg uden moms (eksempt / nul-sats)",
            "moms_salg": "Moms af salg (udgående moms)",
        }
    else:
        story.append(Paragraph("A · SALES", section_title))
        labels = {
            "salg_med": "Taxable sales (gross)" if data["prices_include_moms"]
                        else "Taxable sales (net)",
            "salg_uden": "Zero-rated / exempt sales",
            "moms_salg": "Output VAT",
        }
    a_rows = [
        [Paragraph(labels["salg_med"], val),
         Paragraph(_money_dk(data["salg_med_moms"], currency), val_r)],
        [Paragraph(labels["salg_uden"], val),
         Paragraph(_money_dk(data["salg_uden_moms"], currency), val_r)],
        [Paragraph(labels["moms_salg"], val_b),
         Paragraph(_money_dk(data["moms_af_salg"], currency),
                   ParagraphStyle("acc", parent=val_br,
                                  textColor=colors.HexColor("#4338ca")))],
    ]
    ta = Table(a_rows, colWidths=[110 * _mm, 56 * _mm])
    ta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(ta)

    if is_danish:
        story.append(Paragraph("B · KØB", section_title))
        labels_b = {
            "kob_med": "Køb med moms (varekøb inkl. moms)",
            "moms_kob": "Moms af køb (indgående moms)",
        }
    else:
        story.append(Paragraph("B · PURCHASES", section_title))
        labels_b = {
            "kob_med": "Taxable purchases (gross)",
            "moms_kob": "Input VAT",
        }
    b_rows = [
        [Paragraph(labels_b["kob_med"], val),
         Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
        [Paragraph(labels_b["moms_kob"], val_b),
         Paragraph(_money_dk(data["moms_af_kob"], currency),
                   ParagraphStyle("acc", parent=val_br,
                                  textColor=colors.HexColor("#1d4ed8")))],
    ]
    tb = Table(b_rows, colWidths=[110 * _mm, 56 * _mm])
    tb.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(tb)

    moms_til_skat = data["moms_til_skat"]
    # Snap near-zero dust to exactly 0 so a 1-øre rounding artifact never
    # renders as a misleading "Tilgode hos SKAT / Refund due" on the filing.
    if abs(moms_til_skat) < 0.01:
        moms_til_skat = 0.0
    is_owed = moms_til_skat > 0
    if is_danish:
        story.append(Paragraph("C · TIL BETALING / TILGODE", section_title))
        c_label = "Moms til SKAT (positiv = skyldig, negativ = tilgode)"
        big_caption = "Skyldig moms" if is_owed else ("Tilgode hos SKAT"
                       if moms_til_skat < 0 else "Ingen moms at indberette")
    else:
        story.append(Paragraph("C · NET", section_title))
        c_label = "Net VAT (positive = owed, negative = refund)"
        big_caption = "Owed to tax authority" if is_owed else ("Refund due"
                       if moms_til_skat < 0 else "No VAT to report")
    big_color = NET_OWED if is_owed else NET_REFUND
    story.append(Paragraph(
        f"<font color='#6b7280' size='9'>{c_label}</font>",
        ParagraphStyle("clab", parent=val, leading=12),
    ))
    big_row = [[
        Paragraph(_money_dk(abs(moms_til_skat), currency),
                  ParagraphStyle("Big", parent=val_b, fontSize=22, leading=26,
                                 textColor=big_color)),
        Paragraph(f"<font color='#6b7280' size='9'>{big_caption}</font>",
                  ParagraphStyle("bcap", parent=val_r, leading=12)),
    ]]
    big_table = Table(big_row, colWidths=[110 * _mm, 56 * _mm])
    big_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(big_table)

    # D — reconciliation
    if is_danish:
        story.append(Paragraph("D · SAMMENHÆNG", section_title))
        d_rows = [
            [Paragraph("Antal salgsbilag", val), Paragraph(f"{data['sales_count']}", val_r)],
            [Paragraph("Antal udgiftsbilag", val), Paragraph(f"{data['expense_count']}", val_r)],
            [Paragraph("Periode", val), Paragraph(period_label, val_r)],
        ]
    else:
        story.append(Paragraph("D · RECONCILIATION", section_title))
        d_rows = [
            [Paragraph("Sales transactions", val), Paragraph(f"{data['sales_count']}", val_r)],
            [Paragraph("Expense transactions", val), Paragraph(f"{data['expense_count']}", val_r)],
            [Paragraph("Period", val), Paragraph(period_label, val_r)],
        ]
    td = Table(d_rows, colWidths=[110 * _mm, 56 * _mm])
    td.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(td)

    # D2 — source traceability
    # D2 sources — split POS into Sale-rows + Kasserapport (DailyClose).
    # Pre-2026-05-28 this was a single line "POS-kassesalg (Sale)" using
    # vat["pos_revenue"], which after the DailyClose integration silently
    # included kasserapport revenue that never touched the Sale table.
    # Revisor traceability degraded — caught in audit a26d37c → A5.
    _pos_from_sales = data.get("pos_revenue_from_sales", data["pos_revenue"])
    _pos_from_closes = data.get("pos_revenue_from_closes", 0.0)
    if is_danish:
        story.append(Paragraph("D2 · KILDER", section_title))
        src_rows = [
            [Paragraph("POS-kassesalg (Sale)", val),
             Paragraph(_money_dk(_pos_from_sales, currency), val_r)],
            [Paragraph("Kasserapport (Dagsafslutning)", val),
             Paragraph(_money_dk(_pos_from_closes, currency), val_r)],
            [Paragraph("Fakturasalg (Invoice)", val),
             Paragraph(_money_dk(data["invoice_revenue"], currency), val_r)],
            [Paragraph("Sum (= Salg med moms)", val_b),
             Paragraph(_money_dk(data["salg_med_moms"], currency), val_br)],
            [Paragraph("Bogførte udgifter (Expense)", val),
             Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
            [Paragraph("Indgående moms heraf", val_b),
             Paragraph(_money_dk(data["moms_af_kob"], currency), val_br)],
        ]
    else:
        story.append(Paragraph("D2 · SOURCES", section_title))
        src_rows = [
            [Paragraph("POS sales (Sale)", val),
             Paragraph(_money_dk(_pos_from_sales, currency), val_r)],
            [Paragraph("Kasserapport (Daily Close)", val),
             Paragraph(_money_dk(_pos_from_closes, currency), val_r)],
            [Paragraph("Invoice sales (Invoice)", val),
             Paragraph(_money_dk(data["invoice_revenue"], currency), val_r)],
            [Paragraph("Sum (= taxable sales)", val_b),
             Paragraph(_money_dk(data["salg_med_moms"], currency), val_br)],
            [Paragraph("Logged expenses (Expense)", val),
             Paragraph(_money_dk(data["kob_med_moms"], currency), val_r)],
            [Paragraph("Input VAT from above", val_b),
             Paragraph(_money_dk(data["moms_af_kob"], currency), val_br)],
        ]
    td2 = Table(src_rows, colWidths=[110 * _mm, 56 * _mm])
    td2.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("LINEABOVE", (0, 2), (-1, 2), 0.4, DIVIDER),
    ]))
    story.append(td2)

    # D3 — Bemærkninger (Bogføringsloven §9 stk. 2) — variance footnote
    # Only renders when close.revenue_total and Sale-sum disagree on the
    # same date by > max(50 DKK, 10%). Keeps the PDF clean for clean
    # books and forces a revisor review when entries don't reconcile.
    _variance = data.get("variance_warnings") or []
    if _variance:
        _AMBER = colors.HexColor("#b45309")
        _AMBER_BG = colors.HexColor("#fffbeb")
        story.append(Spacer(1, 4 * _mm))
        if is_danish:
            story.append(Paragraph(
                "D3 · BEMÆRKNINGER (Bogføringsloven §9 stk. 2)",
                ParagraphStyle("vt2", parent=section_title, textColor=_AMBER),
            ))
            story.append(Paragraph(
                "Kasserapport og POS-salg afviger på følgende datoer. "
                "Afstem før indberetning til SKAT.",
                ParagraphStyle("vd2", parent=val, textColor=_AMBER, leading=12),
            ))
            _v_header = ["Dato", "Kasserapport", "POS-salg", "Forskel"]
        else:
            story.append(Paragraph(
                "D3 · NOTES (Record-keeping law §9 stk. 2)",
                ParagraphStyle("vt2", parent=section_title, textColor=_AMBER),
            ))
            story.append(Paragraph(
                "Daily Close and POS sales disagree on the following "
                "dates. Reconcile before filing with SKAT.",
                ParagraphStyle("vd2", parent=val, textColor=_AMBER, leading=12),
            ))
            _v_header = ["Date", "Daily Close", "POS sales", "Delta"]
        _v_rows = [[Paragraph(h, val_b) for h in _v_header]]
        for w in _variance:
            _sign = "+" if (w.get("delta") or 0) > 0 else ""
            _v_rows.append([
                Paragraph(str(w.get("date", "")), val),
                Paragraph(_money_dk(w.get("close_revenue", 0), currency), val_r),
                Paragraph(_money_dk(w.get("sale_sum", 0), currency), val_r),
                Paragraph(
                    f"{_sign}{_money_dk(w.get('delta', 0), currency)} "
                    f"({w.get('delta_pct', 0):.1f}%)",
                    ParagraphStyle("vr2", parent=val_r, textColor=_AMBER),
                ),
            ])
        tv2 = Table(_v_rows, colWidths=[28 * _mm, 46 * _mm, 46 * _mm, 46 * _mm])
        tv2.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BACKGROUND", (0, 0), (-1, 0), _AMBER_BG),
            ("LINEBELOW", (0, 0), (-1, 0), 0.4, _AMBER),
        ]))
        story.append(tv2)

    # E — signature
    story.append(Spacer(1, 8 * _mm))
    if is_danish:
        story.append(Paragraph("E · SIGNERING", section_title))
        sign_label = "Underskrevet af"; date_label_x = "Dato"
    else:
        story.append(Paragraph("E · SIGNATURE", section_title))
        sign_label = "Signed by"; date_label_x = "Date"
    sign_rows = [
        [Paragraph(f"{sign_label}: ____________________________________", val),
         Paragraph(f"{date_label_x}: ___________________", val)],
    ]
    ts = Table(sign_rows, colWidths=[110 * _mm, 56 * _mm])
    ts.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(ts)

    # Footer + disclaimer (inline body content, not the canvas footer)
    story.append(Spacer(1, 6 * _mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                             spaceBefore=2, spaceAfter=4))
    if is_danish:
        footer_text = (
            f"Genereret af {software_id} · {generated_at_str}<br/>"
            "Opbevares i 5 år iht. Bogføringsloven §10 · "
            "Indberettes på SKAT.dk eller sendes til revisor."
        )
        disclaimer_text = (
            f"Denne PDF afspejler BonBox's beregning pr. {generated_at_str}. "
            "Brugeren er ansvarlig for at indberette beløbene på SKAT.dk "
            "og afstemme dem med egne regnskabsbilag før indsendelse."
        )
    else:
        footer_text = (
            f"Generated by {software_id} · {generated_at_str}<br/>"
            "Retain for 5 years per record-keeping law · "
            "File with your tax authority or forward to your accountant."
        )
        disclaimer_text = (
            f"This PDF reflects BonBox's calculation as of {generated_at_str}. "
            "The user is responsible for uploading to SKAT.dk and "
            "verifying against their own records before submission."
        )
    story.append(Paragraph(footer_text, foot))
    story.append(Spacer(1, 1 * _mm))
    story.append(Paragraph(
        f"<font color='#94a3b8' size='7'><i>{disclaimer_text}</i></font>",
        foot,
    ))
    return story


def resolve_default_period(user: User) -> tuple[date, date]:
    """Pick the default reporting period for a user based on their filing
    frequency. Used when the router gets no period_start / period_end
    query params.

    For most DK SMBs (half_yearly default), this is the CURRENT half-year
    (Jan-Jun or Jul-Dec). For quarterly, the CURRENT quarter. For monthly,
    the CURRENT month. The owner can override via query params.

    Why current vs previous: the Tax Autopilot UI shows the next deadline
    with its associated period (which IS the previous-or-current period
    depending on the calendar). For the filing PDF, we default to whatever
    period the next deadline covers — that matches the user's mental model
    of "what am I about to file?".
    """
    today = date.today()
    currency = user.currency or "DKK"
    config = TAX_CONFIG.get(currency)

    frequency = "quarterly"  # generic default
    if config:
        explicit = getattr(user, "tax_filing_frequency", None)
        if explicit and explicit in (config.get("frequencies") or {}):
            frequency = explicit
        else:
            frequency = config.get("default_frequency", "quarterly")

    # Use the same period derivation as tax_service so periods match the UI.
    from app.services.tax_service import _get_next_deadlines
    deadlines = _get_next_deadlines(currency, frequency=frequency, count=1)
    if deadlines:
        dl = deadlines[0]
        return dl["period_start"], dl["period_end"]

    # Fallback — calendar quarter ending in the most recent boundary month.
    if frequency == "monthly":
        # Previous month
        if today.month == 1:
            return date(today.year - 1, 12, 1), date(today.year - 1, 12, 31)
        prev = today.month - 1
        last_day = (date(today.year, today.month, 1) - timedelta(days=1)).day
        return date(today.year, prev, 1), date(today.year, prev, last_day)

    if frequency == "half_yearly":
        if today.month <= 6:
            return date(today.year - 1, 7, 1), date(today.year - 1, 12, 31)
        return date(today.year, 1, 1), date(today.year, 6, 30)

    # Quarterly fallback
    q = (today.month - 1) // 3
    if q == 0:
        start = date(today.year - 1, 10, 1)
        end = date(today.year - 1, 12, 31)
    else:
        start_m = (q - 1) * 3 + 1
        end_m = start_m + 2
        start = date(today.year, start_m, 1)
        # Last day of end_m
        if end_m == 12:
            end = date(today.year, 12, 31)
        else:
            end = date(today.year, end_m + 1, 1) - timedelta(days=1)
    return start, end
