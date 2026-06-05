"""Inventory export — PDF stock-list report + CSV export.

Two formats, same data:
  • PDF: 'Stock List' report grouped by category, totals per category,
    expiry highlighting for perishables. Designed for the
    Bogføringsloven §10 retention paper trail + accountant handoff.
  • CSV: tabular dump of all items, suitable for spreadsheet import
    or auditor review.

Both endpoints are authed + tenant-scoped (filter by user.id) — same
6-layer pattern as the rest of the codebase.

Why PDF separate from CSV: accountants want a polished printed/PDF'd
record they can attach to MOMS reports; bookkeepers want a CSV they
can dump into Excel. We support both natively rather than asking the
owner to convert.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta
from collections import defaultdict

from app.models.inventory import InventoryItem
from app.utils.csv_safe import csv_safe


# ─── CSV export ────────────────────────────────────────────────────────

_CSV_COLUMNS = [
    "id", "name", "category", "quantity", "unit",
    "cost_per_unit", "min_threshold", "sell_price",
    "is_perishable", "expiry_date", "barcode", "branch_id",
    "created_at", "updated_at",
]


def items_to_csv_bytes(items: list[InventoryItem]) -> bytes:
    """Serialize a list of InventoryItem to CSV. UTF-8 BOM included so
    Excel on Danish locale opens it without garbling Æ/Ø/Å."""
    buf = io.StringIO()
    # Excel + Danish locale → BOM lets it auto-detect UTF-8 encoding.
    buf.write("﻿")
    writer = csv.writer(buf, delimiter=";")  # Danish Excel uses ; as default
    writer.writerow(_CSV_COLUMNS)
    for it in items:
        writer.writerow([
            str(it.id) if it.id else "",
            csv_safe(it.name or ""),
            csv_safe(it.category or ""),
            float(it.quantity or 0),
            csv_safe(it.unit or ""),
            float(it.cost_per_unit or 0),
            float(it.min_threshold or 0),
            float(it.sell_price) if it.sell_price is not None else "",
            "Yes" if it.is_perishable else "No",
            it.expiry_date.isoformat() if it.expiry_date else "",
            csv_safe(it.barcode or ""),
            str(it.branch_id) if it.branch_id else "",
            it.created_at.isoformat() if it.created_at else "",
            it.updated_at.isoformat() if it.updated_at else "",
        ])
    return buf.getvalue().encode("utf-8")


# ─── PDF export ────────────────────────────────────────────────────────

def build_stock_list_pdf(
    items: list[InventoryItem],
    *,
    business_name: str = "Stock List",
    currency: str = "DKK",
    today: date | None = None,
) -> bytes:
    """Build a 'Stock List' PDF grouped by category.

    Layout principles (match kasserapport_pdf.py style):
      • Generous whitespace (22mm margins)
      • Helvetica throughout
      • Right-aligned numbers, Danish format
      • Expiry highlighted: red if past, amber if within 7 days
      • Category subtotals — owner can spot-check stock value at a glance
    """
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether,
    )

    today = today or date.today()
    today_plus7 = today + timedelta(days=7)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=22*mm, rightMargin=22*mm,
        topMargin=22*mm, bottomMargin=18*mm,
        title=f"Stock List — {business_name}",
        author="BonBox",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title", parent=styles["Heading1"], fontName="Helvetica-Bold",
        fontSize=18, leading=22, spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        "Subtitle", parent=styles["Normal"], fontName="Helvetica",
        fontSize=10, textColor=colors.grey, leading=14, spaceAfter=10,
    )
    cat_header = ParagraphStyle(
        "CategoryHeader", parent=styles["Heading2"], fontName="Helvetica-Bold",
        fontSize=12, leading=16, spaceAfter=4, spaceBefore=8,
        textColor=colors.HexColor("#1f6f43"),
    )
    note_style = ParagraphStyle(
        "Note", parent=styles["Normal"], fontName="Helvetica",
        fontSize=9, textColor=colors.grey, leading=12,
    )

    story = []

    # ─── Header ──────────────────────────────────────────────────────
    story.append(Paragraph(f"📋 Stock List — {business_name}", title_style))
    story.append(Paragraph(
        f"Generated {today.strftime('%A, %d %B %Y')}  ·  "
        f"{len(items)} item{'s' if len(items) != 1 else ''}  ·  "
        f"All amounts in {currency}",
        subtitle_style,
    ))

    # ─── Group by category ───────────────────────────────────────────
    by_cat: dict[str, list[InventoryItem]] = defaultdict(list)
    for it in items:
        by_cat[it.category or "Uncategorized"].append(it)

    grand_value = 0.0
    grand_count = 0

    for category in sorted(by_cat.keys()):
        cat_items = sorted(by_cat[category], key=lambda x: (x.name or "").lower())
        cat_value = sum(
            float(it.cost_per_unit or 0) * float(it.quantity or 0)
            for it in cat_items
        )
        cat_count = len(cat_items)
        grand_value += cat_value
        grand_count += cat_count

        story.append(Paragraph(
            f"{category} — {cat_count} item{'s' if cat_count != 1 else ''} · "
            f"Value: {cat_value:,.2f} {currency}".replace(",", " "),
            cat_header,
        ))

        # Build the table rows for this category
        table_data = [[
            "Name", "Qty", "Unit", "Cost", "Total", "Expiry"
        ]]
        row_styles = []  # for expiry highlighting

        for idx, it in enumerate(cat_items, start=1):
            qty = float(it.quantity or 0)
            cost = float(it.cost_per_unit or 0)
            line_total = qty * cost
            expiry_str = ""
            expiry_color = None
            if it.expiry_date:
                exp = it.expiry_date
                expiry_str = exp.isoformat()
                if exp < today:
                    expiry_color = colors.HexColor("#c0392b")  # past
                    expiry_str = f"⚠ {expiry_str}"
                elif exp <= today_plus7:
                    expiry_color = colors.HexColor("#d68910")  # within 7 days
                    expiry_str = f"! {expiry_str}"
            elif it.is_perishable:
                expiry_str = "—"
                expiry_color = colors.HexColor("#7f8c8d")

            table_data.append([
                it.name or "",
                f"{qty:g}",
                it.unit or "",
                f"{cost:,.2f}".replace(",", " "),
                f"{line_total:,.2f}".replace(",", " "),
                expiry_str,
            ])
            if expiry_color:
                # idx+1 because header is row 0
                row_styles.append(("TEXTCOLOR", (5, idx), (5, idx), expiry_color))

        col_widths = [70*mm, 16*mm, 16*mm, 22*mm, 26*mm, 28*mm]
        table = Table(table_data, colWidths=col_widths, repeatRows=1)
        base_style = TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
            ("ALIGN", (1, 0), (4, -1), "RIGHT"),
            ("ALIGN", (5, 0), (5, -1), "LEFT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
            ("TOPPADDING", (0, 0), (-1, 0), 6),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#888")),
            ("LINEBELOW", (0, -1), (-1, -1), 0.25, colors.HexColor("#ccc")),
        ])
        for s in row_styles:
            base_style.add(*s)
        table.setStyle(base_style)
        story.append(KeepTogether([table, Spacer(1, 6)]))

    # ─── Footer / grand total ────────────────────────────────────────
    story.append(Spacer(1, 8))
    grand_table = Table(
        [[
            f"Total stock value across {grand_count} item{'s' if grand_count != 1 else ''}",
            f"{grand_value:,.2f} {currency}".replace(",", " "),
        ]],
        colWidths=[120*mm, 50*mm],
    )
    grand_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 11),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LINEABOVE", (0, 0), (-1, 0), 1, colors.HexColor("#1f6f43")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(grand_table)

    story.append(Spacer(1, 12))
    story.append(Paragraph(
        f"⚠ = past expiry · ! = expires within 7 days · "
        "Generated by BonBox · Bogføringsloven §10 retention",
        note_style,
    ))

    doc.build(story)
    return buf.getvalue()
