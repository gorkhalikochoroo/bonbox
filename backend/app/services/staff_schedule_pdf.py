"""Staff schedule → printable wall PDF.

Owners print this and pin it on the back-of-house staff board, so
everyone can glance at the week without opening their phone. Especially
useful when WhatsApp/email isn't a fit — paper-on-the-wall is a real
hospitality habit.

Layout (A4 landscape, single page):

  Header
    • Restaurant name + week label "Week of 14 May 2026"
    • Generated-on timestamp + small "bonbox.dk" footer

  Body — Grid: 7 columns (Mon → Sun), 1 row per staff member
    Cell shows shift time + role (or "OFF" if no shift)

  Footer
    • Compliance line: "Confirmed shifts marked ✓ • Updated [date]"
    • Generated-by: BonBox

Multi-layer:
  • Tenant scope: caller passes user_id; all queries filter by it.
  • Read-only: never writes.
  • Staff names + emails treated as personal data; not embedded in
    filename. Filename: bonbox-schedule-{week_start}.pdf.
"""
from __future__ import annotations

import io
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
)
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.staff import Schedule, StaffMember

logger = logging.getLogger("bonbox.staff_schedule_pdf")


_DAY_LABELS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_DAY_LABELS_DA = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"]


def _fmt_shift(start: str, end: str) -> str:
    """'10:00 — 18:00' on the cell."""
    if not start or not end:
        return ""
    return f"{start}–{end}"


def render_schedule_pdf(
    db: Session,
    *,
    user_id,
    week_start: date,
    lang: str = "en",
) -> bytes:
    """Return PDF bytes for the printable schedule. Single-page A4 landscape."""
    week_end = week_start + timedelta(days=6)
    day_labels = _DAY_LABELS_DA if lang == "da" else _DAY_LABELS_EN

    # Restaurant name (nullable — fallback to "BonBox" if profile not set yet)
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user_id)
        .first()
    )
    venue_name = (profile.business_name if profile else None) or "BonBox"

    # Pull all PUBLISHED shifts for this user in the week, plus all
    # active staff (so OFF days render as empty cells, not skipped).
    staff_rows = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user_id,
            StaffMember.is_deleted.isnot(True),
        )
        .order_by(StaffMember.name.asc())
        .all()
    )
    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user_id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        )
        .all()
    )

    # Index shifts by (staff_id, date) for O(1) cell lookup
    shifts_by_cell: dict[tuple, Schedule] = {}
    for s in shifts:
        shifts_by_cell[(s.staff_id, s.date)] = s

    # Build the table data. Header: ["Staff", "Mon 14", "Tue 15", ...]
    week_label_short = f"Week of {week_start.strftime('%d %b %Y')}"
    header_row = ["Staff"] + [
        f"{day_labels[i]} {(week_start + timedelta(days=i)).strftime('%d')}"
        for i in range(7)
    ]
    data = [header_row]
    for staff in staff_rows:
        row = [staff.name or "—"]
        for i in range(7):
            d = week_start + timedelta(days=i)
            shift = shifts_by_cell.get((staff.id, d))
            if shift:
                cell = _fmt_shift(shift.start_time, shift.end_time)
                if shift.role_on_shift:
                    cell += f"\n{shift.role_on_shift}"
                if shift.confirmed_at:
                    cell += " ✓"
            else:
                cell = "OFF"
            row.append(cell)
        data.append(row)

    # ── Render ──────────────────────────────────────────────────────
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"BonBox Schedule — {week_label_short}",
        author="BonBox",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "title", parent=styles["Heading1"], fontSize=16, spaceAfter=2,
        textColor=colors.HexColor("#0f172a"),
    )
    subtitle_style = ParagraphStyle(
        "subtitle", parent=styles["Normal"], fontSize=10,
        textColor=colors.HexColor("#64748b"),
    )
    cell_style = ParagraphStyle(
        "cell", parent=styles["Normal"], fontSize=9, leading=11,
    )

    flow = []
    flow.append(Paragraph(f"<b>{venue_name}</b> — {week_label_short}", title_style))
    flow.append(Paragraph(
        f"Generated by BonBox · {datetime.utcnow().strftime('%d %b %Y, %H:%M')} UTC",
        subtitle_style,
    ))
    flow.append(Spacer(1, 6 * mm))

    if not staff_rows:
        flow.append(Paragraph(
            "No staff added yet — add staff in Profile → Team to populate this schedule.",
            cell_style,
        ))
    else:
        # Make every cell a Paragraph so wraps render correctly
        wrapped = [
            [Paragraph(str(c).replace("\n", "<br/>"), cell_style) for c in row]
            for row in data
        ]
        # Column widths: first col wide for staff name, 7 day-cols equal
        page_w = landscape(A4)[0] - 28 * mm  # both side margins
        first_w = 36 * mm
        day_w = (page_w - first_w) / 7
        col_widths = [first_w] + [day_w] * 7

        tbl = Table(wrapped, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(TableStyle([
            # Header row
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#10b981")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("ALIGN", (0, 0), (-1, 0), "CENTER"),
            ("VALIGN", (0, 0), (-1, 0), "MIDDLE"),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
            ("TOPPADDING", (0, 0), (-1, 0), 6),
            # Body cells
            ("BACKGROUND", (0, 1), (-1, -1), colors.white),
            ("VALIGN", (0, 1), (-1, -1), "MIDDLE"),
            ("ALIGN", (1, 1), (-1, -1), "CENTER"),
            ("ALIGN", (0, 1), (0, -1), "LEFT"),
            ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 1), (-1, -1), 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f8fafc")]),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
            ("TOPPADDING", (0, 1), (-1, -1), 4),
            # Borders
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
        ]))
        flow.append(tbl)

    flow.append(Spacer(1, 4 * mm))
    flow.append(Paragraph(
        "<font color='#94a3b8'>Confirmed shifts marked with ✓ · "
        "bonbox.dk</font>",
        subtitle_style,
    ))

    try:
        doc.build(flow)
    except Exception as exc:  # noqa: BLE001
        logger.exception("staff_schedule_pdf render failed: %s", exc)
        raise

    return buf.getvalue()
