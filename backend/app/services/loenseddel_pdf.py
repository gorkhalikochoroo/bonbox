"""Lønseddel (Danish payslip) accountant-grade PDF — revisor-bound artifact.

Manoj's locked doctrine ("Accountant-grade artifacts", May 2026):
  Every revisor-bound PDF/CSV/ZIP ships at the SAME quality regardless of
  tier. Tier controls cap / period auto-resolution / send-access, NEVER
  artifact content. Required fields on EVERY revisor-bound document:
      • Bilagsnummer
      • Doc-hash (sha256 short)
      • Signature line
      • Bogføringsloven §10 notice
      • Provenance footer
      • Source reconciliation
      • L7 audit_logs row (added at router level)

This module mirrors the gold-standard pattern in `tax_filing_pdf.py`
(MOMS-angivelse PDF). If you change one, change the other.

DK terminology lock (Manoj's memory):
  • `lønseddel`, `medarbejder`, `bilagsnummer`, `Bogføringsloven`,
    `revisor`, `AM-bidrag`, `A-skat` stay Danish even when UI locale=en.
  • The lønseddel is a SKAT-bound artifact — content stays in Danish
    regardless of the owner's UI language. Only UI chrome translates.

The PDF is side-effect free. Audit logging happens in the router that
calls `build_loenseddel_pdf` so the request-scope (ip, actor) lives at
the router boundary, not in the renderer.
"""
from __future__ import annotations

from datetime import date
from io import BytesIO
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.payroll_service import calc_employee_period
from app.utils.document_hash import (
    get_software_identifier,
    make_numbered_canvas,
    short_hash,
)
from app.utils.time import utc_now


# Danish month names matching tax_filing_pdf.py — keep visual consistency.
_DA_MONTHS = [
    "januar", "februar", "marts", "april", "maj", "juni",
    "juli", "august", "september", "oktober", "november", "december",
]


def _money_dk(value: Any) -> str:
    """Danish-format currency: 1.234,56 kr. None / non-numeric → '—'.

    Lønseddel is a DK-only artifact (SKAT-bound) — always DKK. We don't
    accept a currency parameter because the lønseddel doesn't exist in
    any other jurisdiction's accounting universe.
    """
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
    return f"{sign}{whole_str},{fractional:02d} kr."


def _format_period_dk(start: date, end: date) -> str:
    """Format a period range in Danish: "1. maj – 31. maj 2026"."""
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


def make_bilagsnummer(
    employee_id: Any, period_start: date, period_end: date,
) -> str:
    """Stable, sortable voucher number for the lønseddel.

    Format: LON-{employee_id_short}-{YYYYMMDD}-{YYYYMMDD}
    (e.g. `LON-AB12-20260501-20260531`).

    The employee-id short is the first 4 chars of the UUID hex (uppercased).
    Stable per (employee, period) so the same input regenerates the same
    number — that's the invariant a revisor relies on when they ask the
    owner to "send me lønseddel LON-AB12-20260501-20260531 again".

    LON = Lønseddel (sortable prefix matches MA = MOMS-Angivelse pattern).
    """
    # Strip hyphens from UUID and take first 4 chars upper. Strings just
    # pass through as-is (defensive for tests that pass strings).
    raw = str(employee_id).replace("-", "")
    short = raw[:4].upper() if raw else "0000"
    return (
        f"LON-{short}-"
        f"{period_start.strftime('%Y%m%d')}-{period_end.strftime('%Y%m%d')}"
    )


def fetch_loenseddel_data(
    db: Session,
    owner: User,
    employee: StaffMember,
    period_start: date,
    period_end: date,
) -> dict:
    """Gather the data behind one lønseddel — single source of truth.

    Pulls every HoursLogged row for (employee, period) inside the owner's
    tenant, computes gross from `earned` (with base_rate fallback), then
    routes the totals through `calc_employee_period` so the wage math is
    identical to the per-employee deductions service. Two callers — the
    router AND the renderer — must see the same numbers.

    Returns a dict with `lines` (per HoursLogged row), `totals` (the
    summary), and `deductions` (from calc_employee_period).
    """
    hours_rows = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == owner.id,
            HoursLogged.staff_id == employee.id,
            HoursLogged.date >= period_start,
            HoursLogged.date <= period_end,
        )
        .order_by(HoursLogged.date.asc(), HoursLogged.start_time.asc())
        .all()
    )

    base_rate = float(getattr(employee, "base_rate", 0) or 0)
    lines: list[dict] = []
    total_hours = 0.0
    total_gross = 0.0
    for h in hours_rows:
        hrs = float(h.total_hours or 0)
        rate = float(h.rate_applied or 0) or base_rate
        earned = float(h.earned or 0)
        if earned <= 0:
            earned = hrs * rate
        lines.append({
            "date": h.date,
            "start_time": h.start_time or "",
            "end_time": h.end_time or "",
            "hours": hrs,
            "rate": rate,
            "line_total": earned,
        })
        total_hours += hrs
        total_gross += earned

    tax_card_type = getattr(employee, "tax_card_type", None)
    tax_card_rate = getattr(employee, "tax_card_rate", None)
    deductions = calc_employee_period(
        gross=total_gross,
        contract_type=str(getattr(employee, "contract_type", "full") or "full"),
        tax_card_type=tax_card_type,
        tax_card_rate=(float(tax_card_rate) if tax_card_rate is not None else None),
    )

    return {
        "lines": lines,
        "total_hours": round(total_hours, 2),
        "total_gross": round(total_gross, 2),
        "deductions": deductions,
        "tax_card_type": tax_card_type or "hovedkort",
        "base_rate": base_rate,
    }


def build_loenseddel_pdf(
    db: Session,
    owner: User,
    employee: StaffMember,
    period_start: date,
    period_end: date,
    *,
    profile: Any | None = None,
) -> tuple[bytes, dict]:
    """Render the accountant-grade lønseddel PDF for a single employee.

    Mirrors `build_moms_filing_pdf` end-to-end:
      - 22mm Copenhagen-clean margins, Helvetica, hairline dividers
      - Danish 1.234,56 kr. number format
      - Bilagsnummer in header (`LON-{employee}-{period_start}-{period_end}`)
      - Bogføringsloven §10 retention notice + provenance footer
      - Source reconciliation: every HoursLogged row that fed totals
      - Signature line for the medarbejder
      - 2-pass build so the doc-hash footer matches the rendered bytes

    Args:
      db:           active SQLAlchemy session.
      owner:        the tenant `User` who employs `employee`.
      employee:     `StaffMember` row whose lønseddel this is.
      period_start: inclusive start of the pay period.
      period_end:   inclusive end of the pay period.
      profile:      optional `BusinessProfile` row supplying CVR + address.

    Returns:
      Tuple of (pdf_bytes, summary). `summary` carries the doc-hash,
      bilagsnummer, total gross, total hours, deductions — handed back
      to the router so it can write the audit row + return JSON.
    """
    return build_loenseddel_pdf_multi(
        db, owner, [employee], period_start, period_end, profile=profile,
    )


def build_loenseddel_pdf_multi(
    db: Session,
    owner: User,
    employees: list[StaffMember],
    period_start: date,
    period_end: date,
    *,
    profile: Any | None = None,
) -> tuple[bytes, dict]:
    """Render one PDF containing N employee lønsedler (one page each).

    Avoids needing a PDF-merge dependency: reportlab's `PageBreak`
    between employees gives us a single multi-page document that the
    router can stream back. Each employee's page still carries its OWN
    bilagsnummer + per-employee source reconciliation. The doc-hash in
    the footer hashes the combined PDF so a revisor can verify the
    entire artifact in one check.

    Returns:
      (pdf_bytes, summary) where `summary["per_employee"]` lists each
      rendered employee's bilagsnummer / totals so the router can write
      one audit row per employee.
    """
    per_employee_data: list[dict] = []
    for emp in employees:
        data = fetch_loenseddel_data(db, owner, emp, period_start, period_end)
        bilagsnummer = make_bilagsnummer(emp.id, period_start, period_end)
        per_employee_data.append({
            "employee": emp,
            "data": data,
            "bilagsnummer": bilagsnummer,
        })

    pdf_bytes, doc_hash = _render_loenseddel_pdf(
        per_employee_data=per_employee_data,
        owner=owner,
        period_start=period_start,
        period_end=period_end,
        profile=profile,
    )

    summary = {
        "doc_hash": doc_hash,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "employee_count": len(per_employee_data),
        "per_employee": [
            {
                "employee_id": str(pe["employee"].id),
                "name": pe["employee"].name,
                "bilagsnummer": pe["bilagsnummer"],
                "total_hours": pe["data"]["total_hours"],
                "total_gross": pe["data"]["total_gross"],
                "net_pay": pe["data"]["deductions"]["net_pay"],
                "am_bidrag": pe["data"]["deductions"]["am_bidrag"],
                "a_skat": pe["data"]["deductions"]["a_skat"],
            }
            for pe in per_employee_data
        ],
    }

    # When called with a single employee, expose convenience top-level
    # keys so the original single-employee call signature still works.
    if len(per_employee_data) == 1:
        pe0 = summary["per_employee"][0]
        summary["bilagsnummer"] = pe0["bilagsnummer"]
        summary["total_hours"] = pe0["total_hours"]
        summary["total_gross"] = pe0["total_gross"]
        summary["net_pay"] = pe0["net_pay"]
        summary["am_bidrag"] = pe0["am_bidrag"]
        summary["a_skat"] = pe0["a_skat"]
    return pdf_bytes, summary


def _render_loenseddel_pdf(
    *,
    per_employee_data: list[dict],
    owner: User,
    period_start: date,
    period_end: date,
    profile: Any | None,
) -> tuple[bytes, str]:
    """The 2-pass render — same shape as `build_moms_filing_pdf`.

    Pass 1 renders with a `pending` doc-hash placeholder, then we hash
    the rendered bytes and rebuild with the real hash visible in the
    footer. Fresh `SimpleDocTemplate` + fresh flowables on pass 2 because
    ReportLab mutates flowables in-place during build.

    Returns (final_pdf_bytes, doc_hash). The hash IS the one rendered
    in the footer — the contract is "what the user sees in the footer
    == what we record in the audit row". A tamper-check later re-hashes
    the pass-1 representation by stripping the footer's hash and
    re-rendering deterministically.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    software_id = get_software_identifier()
    generated_at = utc_now()
    generated_at_str = generated_at.strftime("%Y-%m-%d %H:%M UTC")
    generator_email = getattr(owner, "email", None) or "system"

    doc_hash_holder = {"value": "pending"}

    def _draw_audit_footer(canv, page_num, total_pages):
        """Footer drawn on every page — same recipe as the MOMS PDF."""
        from reportlab.lib import colors as _c
        canv.saveState()
        canv.setFont("Helvetica", 6.8)
        canv.setFillColor(_c.HexColor("#94a3b8"))
        canv.drawRightString(
            A4[0] - 22 * mm, 10 * mm,
            f"Side {page_num} / {total_pages}",
        )
        canv.drawCentredString(
            A4[0] / 2, 10 * mm,
            f"Genereret af {software_id} · {generated_at_str} "
            f"af {generator_email}",
        )
        canv.drawString(
            22 * mm, 10 * mm,
            f"Doc-hash: {doc_hash_holder['value']}",
        )
        canv.restoreState()

    biz_display = (
        (getattr(profile, "company_name", None) if profile else None)
        or (getattr(profile, "business_name", None) if profile else None)
        or (getattr(owner, "business_name", None) or "")
        or "Lønseddel"
    )

    # Title shows first employee + period; the file might contain N
    # employees but the PDF metadata only carries one summary.
    if per_employee_data:
        first = per_employee_data[0]
        title_text = (
            f"Lønseddel — {first['employee'].name} — {first['bilagsnummer']}"
        )
        subject_text = f"Lønseddel {first['bilagsnummer']}"
    else:
        title_text = "Lønseddel"
        subject_text = "Lønseddel"

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=22 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title=title_text,
        author="BonBox",
        creator=software_id,
        subject=subject_text,
    )
    canvas_maker = make_numbered_canvas(_draw_audit_footer)
    story = _build_combined_story(
        per_employee_data=per_employee_data, owner=owner,
        period_start=period_start, period_end=period_end,
        profile=profile, biz_display=biz_display,
        software_id=software_id, generated_at_str=generated_at_str,
    )
    doc.build(story, canvasmaker=canvas_maker)
    pass1_bytes = buf.getvalue()
    doc_hash = short_hash(pass1_bytes, length=16)
    doc_hash_holder["value"] = doc_hash

    # Pass 2 — fresh objects, real hash visible in the footer.
    buf2 = BytesIO()
    doc2 = SimpleDocTemplate(
        buf2, pagesize=A4,
        topMargin=22 * mm, bottomMargin=22 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title=doc.title, author=doc.author,
        creator=software_id, subject=doc.subject,
    )
    story2 = _build_combined_story(
        per_employee_data=per_employee_data, owner=owner,
        period_start=period_start, period_end=period_end,
        profile=profile, biz_display=biz_display,
        software_id=software_id, generated_at_str=generated_at_str,
    )
    doc2.build(story2, canvasmaker=canvas_maker)
    return buf2.getvalue(), doc_hash


def _build_combined_story(
    *,
    per_employee_data: list[dict],
    owner: User,
    period_start: date,
    period_end: date,
    profile: Any | None,
    biz_display: str,
    software_id: str,
    generated_at_str: str,
) -> list:
    """Stitch per-employee stories together with PageBreaks between them.

    Each employee's section is its OWN accountant-grade lønseddel —
    same 6 fields, same labels, same Bogføringsloven §10 footer. The
    PageBreak ensures the revisor sees one employee per printed sheet.
    """
    from reportlab.platypus import PageBreak

    story: list = []
    for i, pe in enumerate(per_employee_data):
        if i > 0:
            story.append(PageBreak())
        story.extend(_build_story(
            data=pe["data"],
            owner=owner,
            employee=pe["employee"],
            period_start=period_start,
            period_end=period_end,
            profile=profile,
            biz_display=biz_display,
            bilagsnummer=pe["bilagsnummer"],
            software_id=software_id,
            generated_at_str=generated_at_str,
        ))
    return story


def _build_story(
    *,
    data: dict,
    owner: User,
    employee: StaffMember,
    period_start: date,
    period_end: date,
    profile: Any | None,
    biz_display: str,
    bilagsnummer: str,
    software_id: str,
    generated_at_str: str,
) -> list:
    """Build the ReportLab flowable list for ONE employee. Pure function,
    callable twice for the 2-pass render."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4 as _A4  # noqa: F401 — symmetry
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable, Paragraph, Spacer, Table, TableStyle,
    )

    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    NET_COLOR = colors.HexColor("#15803d")  # emerald for net pay (positive)

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
    val_small = ParagraphStyle("ValSm", parent=val, fontSize=9, leading=12)
    val_small_r = ParagraphStyle("ValSmR", parent=val_small, alignment=TA_RIGHT)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    story: list = []

    # ─── Header ───────────────────────────────────────────────────
    period_label = _format_period_dk(period_start, period_end)
    date_block = (
        f"{period_label}<br/>"
        f"<font size='8'>Bilagsnr {bilagsnummer}</font>"
    )
    head_table = Table(
        [[Paragraph("LØNSEDDEL", h1), Paragraph(date_block, sub)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                            spaceBefore=4, spaceAfter=12))

    # ─── Employer + Employee blocks (two columns) ─────────────────
    # Arbejdsgiver column
    employer_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_display}</font>"]
    if profile:
        addr_parts = []
        if getattr(profile, "address", None):
            addr_parts.append(profile.address)
        z = getattr(profile, "zipcode", None) or ""
        c = getattr(profile, "city", None) or ""
        if z or c:
            addr_parts.append(f"{z} {c}".strip())
        if addr_parts:
            employer_lines.append(
                f"<font color='#6b7280'>{', '.join(addr_parts)}</font>"
            )
        cvr = getattr(profile, "org_number", None)
        if cvr:
            employer_lines.append(f"<font color='#6b7280'>CVR {cvr}</font>")

    # Medarbejder column — Danish labels per DK terminology lock
    employee_lines = [
        f"<font name='Helvetica-Bold' size='10.5'>{employee.name}</font>",
    ]
    role = getattr(employee, "role", None)
    if role:
        employee_lines.append(f"<font color='#6b7280'>Rolle: {role}</font>")
    contract = getattr(employee, "contract_type", None)
    if contract:
        employee_lines.append(f"<font color='#6b7280'>Kontrakt: {contract}</font>")
    employee_lines.append(
        f"<font color='#6b7280'>Trækkort: {data['tax_card_type']}</font>"
    )

    info_table = Table(
        [
            [Paragraph("ARBEJDSGIVER", section_title),
             Paragraph("MEDARBEJDER", section_title)],
            [Paragraph("<br/>".join(employer_lines), val),
             Paragraph("<br/>".join(employee_lines), val)],
        ],
        colWidths=[83 * mm, 83 * mm],
    )
    info_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 6 * mm))

    # ─── Section A — Arbejdstimer (Source Reconciliation) ─────────
    # Every HoursLogged row that fed total_gross. This is the
    # source-reconciliation field required by the accountant-grade
    # doctrine — a revisor reading the lønseddel can trace every øre
    # back to the underlying time entries.
    story.append(Paragraph("A · ARBEJDSTIMER", section_title))
    if data["lines"]:
        header_row = [
            Paragraph("<font color='#6b7280'>Dato</font>", val_small),
            Paragraph("<font color='#6b7280'>Fra</font>", val_small),
            Paragraph("<font color='#6b7280'>Til</font>", val_small),
            Paragraph("<font color='#6b7280'>Timer</font>", val_small_r),
            Paragraph("<font color='#6b7280'>Sats</font>", val_small_r),
            Paragraph("<font color='#6b7280'>Beløb</font>", val_small_r),
        ]
        body_rows = [header_row]
        for ln in data["lines"]:
            body_rows.append([
                Paragraph(ln["date"].isoformat(), val_small),
                Paragraph(ln["start_time"] or "—", val_small),
                Paragraph(ln["end_time"] or "—", val_small),
                Paragraph(f"{ln['hours']:.2f}", val_small_r),
                Paragraph(_money_dk(ln["rate"]), val_small_r),
                Paragraph(_money_dk(ln["line_total"]), val_small_r),
            ])
        # Totals row
        body_rows.append([
            Paragraph("<b>Total</b>", val_small),
            Paragraph("", val_small),
            Paragraph("", val_small),
            Paragraph(f"<b>{data['total_hours']:.2f}</b>", val_small_r),
            Paragraph("", val_small_r),
            Paragraph(f"<b>{_money_dk(data['total_gross'])}</b>", val_small_r),
        ])
        ta = Table(
            body_rows,
            colWidths=[24 * mm, 16 * mm, 16 * mm, 22 * mm, 30 * mm, 58 * mm],
        )
        ta.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEBELOW", (0, 0), (-1, 0), 0.4, DIVIDER),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(ta)
    else:
        # No HoursLogged rows in this period — keep the section
        # present so the auditor sees we ran the query and got nothing
        # (rather than wondering whether the renderer skipped it).
        story.append(Paragraph(
            "<font color='#6b7280'>Ingen registrerede arbejdstimer i perioden.</font>",
            val,
        ))

    # ─── Section B — Bruttoløn / Fradrag / Nettoløn ───────────────
    story.append(Paragraph("B · BRUTTOLØN OG FRADRAG", section_title))
    ded = data["deductions"]
    wage_rows = [
        [Paragraph("Bruttoløn", val_b),
         Paragraph(f"<b>{_money_dk(data['total_gross'])}</b>", val_br)],
        [Paragraph(
            "<font color='#6b7280'>&nbsp;&nbsp;AM-bidrag (8%)</font>", val),
         Paragraph(f"<font color='#6b7280'>− {_money_dk(ded['am_bidrag'])}</font>",
                   val_r)],
        [Paragraph(
            f"<font color='#6b7280'>&nbsp;&nbsp;A-skat "
            f"(≈{int(round(ded['a_skat_rate']*100))}%, {data['tax_card_type']})</font>",
            val),
         Paragraph(f"<font color='#6b7280'>− {_money_dk(ded['a_skat'])}</font>",
                   val_r)],
        [Paragraph("<b>Nettoløn</b>", val),
         Paragraph(_money_dk(ded["net_pay"]),
                   ParagraphStyle("Net", parent=val_br, textColor=NET_COLOR,
                                  fontSize=12))],
    ]
    tb = Table(wage_rows, colWidths=[110 * mm, 56 * mm])
    tb.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(tb)

    # ─── Section C — Arbejdsgivers bidrag (Employer contributions) ─
    story.append(Paragraph("C · ARBEJDSGIVERS BIDRAG", section_title))
    emp_rows = [
        [Paragraph(
            "<font color='#6b7280'>&nbsp;&nbsp;ATP</font>", val),
         Paragraph(f"<font color='#6b7280'>{_money_dk(ded['atp'])}</font>", val_r)],
        [Paragraph(
            "<font color='#6b7280'>&nbsp;&nbsp;Feriepenge (12,5%)</font>", val),
         Paragraph(f"<font color='#6b7280'>{_money_dk(ded['feriepenge'])}</font>",
                   val_r)],
        [Paragraph("Samlede arbejdsgiveromkostninger", val_b),
         Paragraph(_money_dk(ded["employer_total_cost"]), val_br)],
    ]
    tc = Table(emp_rows, colWidths=[110 * mm, 56 * mm])
    tc.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
    ]))
    story.append(tc)

    # ─── Section D — Sammenhæng / Reconciliation summary ──────────
    # Cross-foot: total_hours × avg_rate = total_gross (approximately).
    # Lets the revisor confirm the line-level table on page 1 ties to
    # the bruttoløn used in section B without doing the sum themselves.
    story.append(Paragraph("D · SAMMENHÆNG", section_title))
    d_rows = [
        [Paragraph("Antal arbejdsdage", val),
         Paragraph(f"{len(data['lines'])}", val_r)],
        [Paragraph("Sum arbejdstimer", val),
         Paragraph(f"{data['total_hours']:.2f}", val_r)],
        [Paragraph("Sum bruttoløn (= Bruttoløn i sektion B)", val_b),
         Paragraph(_money_dk(data["total_gross"]), val_br)],
        [Paragraph("Periode", val),
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

    # ─── Section E — Signering (Signature line) ───────────────────
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("E · SIGNERING", section_title))
    sign_rows = [
        [Paragraph("Underskrift, medarbejder: ____________________________________",
                   val),
         Paragraph("Dato: ___________________", val)],
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

    # ─── Footer + Bogføringsloven §10 notice ──────────────────────
    story.append(Spacer(1, 6 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                            spaceBefore=2, spaceAfter=4))
    footer_text = (
        f"Genereret af {software_id} · {generated_at_str}<br/>"
        "Denne lønseddel opbevares i 5 år iht. Bogføringsloven §10."
    )
    disclaimer_text = (
        "A-skat er et estimat baseret på medarbejderens trækkort. Den endelige "
        "A-skat afregnes via virksomhedens lønsystem (DataLøn / Zenegy / Visma) "
        "og indberettes til SKAT via eIndkomst. Brugeren er ansvarlig for at "
        "afstemme med egne regnskabsbilag før indsendelse til revisor."
    )
    story.append(Paragraph(footer_text, foot))
    story.append(Spacer(1, 1 * mm))
    story.append(Paragraph(
        f"<font color='#94a3b8' size='7'><i>{disclaimer_text}</i></font>",
        foot,
    ))
    return story
