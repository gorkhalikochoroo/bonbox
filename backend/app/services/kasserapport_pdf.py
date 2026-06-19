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
from app.utils.time import utc_now
from app.utils.document_hash import (
    compute_document_hash,
    get_software_identifier,
    make_numbered_canvas,
    short_hash,
)
from app.services.bonbox_pdf_kit import money_dk

logger = logging.getLogger("bonbox.kasserapport_pdf")


# Day names in Danish for the header — reportlab can't invoke locale,
# so we provide them inline.
_DK_DAYS = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"]


def _money(value: Any, currency: str = "DKK") -> str:
    """Render an amount via the shared kit formatter — '1.234,56 kr.' for DKK,
    matching the gold MOMS-angivelse. Delegates to bonbox_pdf_kit.money_dk so
    every export speaks one money format (was '… DKK' here before). None /
    non-numeric → "—"."""
    return money_dk(value, currency)


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
        d = utc_now()
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
    user: Any = None,
    generated_by_email: str | None = None,
    is_locked_signed: bool = False,
    logo_bytes: bytes | None = None,
) -> bytes:
    """Build the kasserapport PDF. Returns raw bytes; never raises.

    L4 defense-in-depth (multi_terminal_close): when `user` is supplied,
    re-checks the entitlement before rendering. Router gate is the
    primary; this is the backup so a refactor dropping the router gate
    can't open the door. PermissionError on refusal — router converts
    to 402. Unit tests omit `user` to test rendering math without a
    billing context.

    Audit-grade footers (May 2026 upgrade):
      • generated_by_email — rendered in the footer; falls back to
        user.email when not explicitly supplied.
      • is_locked_signed — when True, the footer shows "Låst + signeret"
        so a revisor can see at a glance that the close was confirmed
        rather than a draft preview.
      • logo_bytes — pre-fetched logo. When set, rendered at the top
        of the header. Caller fetches via storage to keep this module
        pure (no S3 calls inside the renderer).
    The document is hashed at the end and the short hash is appended
    to the footer for tamper-evidence; the caller is responsible for
    persisting the full hash to audit_logs.
    """
    # L4 — defensive feature check. Router enforce_feature should have
    # caught this; we re-verify so multi-barrier defense holds even if
    # that gate is ever bypassed.
    if user is not None:
        from app.services.billing import has_feature
        if not has_feature(user, "multi_terminal_close"):
            raise PermissionError("multi_terminal_close required")

    # Resolve generator email — explicit param wins, then user.email,
    # then "system" sentinel so the footer never says blank.
    effective_email = (generated_by_email or "").strip()
    if not effective_email and user is not None:
        effective_email = (getattr(user, "email", None) or "").strip()
    if not effective_email:
        effective_email = "system"

    try:
        return _render_close_pdf(
            aggregated=aggregated or {},
            business_name=business_name or "",
            date_label=date_label or "",
            currency=currency or "DKK",
            business_profile=business_profile or {},
            bilagsnummer=bilagsnummer,
            generated_by_email=effective_email,
            is_locked_signed=bool(is_locked_signed),
            logo_bytes=logo_bytes,
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
    generated_by_email: str = "system",
    is_locked_signed: bool = False,
    logo_bytes: bytes | None = None,
) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable,
        Image as RLImage,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buf = io.BytesIO()

    # Capture the generation timestamp once so footer + header agree.
    generated_at = utc_now()
    generated_at_str = generated_at.strftime("%Y-%m-%d %H:%M UTC")
    software_id = get_software_identifier()

    # NumberedCanvas defers per-page footer rendering until after build
    # is complete, so we know the total page count and can render an
    # accurate "Side X af Y" on every page in a single build. Sidesteps
    # the 2-pass flowable-mutation trap.
    def _draw_audit_footer(canv, page_num, total_pages):
        canv.saveState()
        canv.setFont("Helvetica", 7)
        canv.setFillColor(colors.grey)
        # Line 1 (left): compliance + software id
        canv.drawString(
            18 * mm, 14 * mm,
            "Opbevares i 5 år iht. Bogføringsloven §10  ·  "
            f"{software_id}  ·  bonbox.dk",
        )
        # Line 1 (right): page X of Y
        canv.drawRightString(
            A4[0] - 18 * mm, 14 * mm,
            f"Side {page_num} af {total_pages}",
        )
        # Line 2 (centered): generator email + timestamp
        canv.drawCentredString(
            A4[0] / 2, 10 * mm,
            f"Genereret {generated_at_str} af {generated_by_email}",
        )
        canv.restoreState()

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=24 * mm,  # extra space for 2-line footer
        title=f"Kasserapport · {business_name or 'BonBox'}",
        author="BonBox",
        subject=f"Kasserapport {date_label}",
        creator=software_id,
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

    # ─── Logo (optional) ─────────────────────────────────────────
    # When the BusinessProfile has a logo and the caller pre-fetched the
    # bytes, render it inline at the top of the document. Capped at 18mm
    # tall so the header stays Copenhagen-clean. Aspect-ratio preserved.
    if logo_bytes:
        try:
            from PIL import Image as PILImage  # noqa: F401 — used by reportlab
            img = RLImage(io.BytesIO(logo_bytes))
            iw, ih = img.imageWidth, img.imageHeight
            target_h = 18 * mm
            scale = target_h / ih if ih else 1
            target_w = min(iw * scale, 50 * mm)
            target_h = target_w * (ih / iw) if iw else target_h
            img.drawHeight = target_h
            img.drawWidth = target_w
            story.append(img)
            story.append(Spacer(1, 4))
        except Exception:
            # Logo rendering failure must NEVER block the close PDF.
            logger.exception("kasserapport logo render failed — continuing without")

    # ─── Document type pill ───────────────────────────────────────
    story.append(Paragraph("KASSERAPPORT", h_doc))

    # ─── Business name ────────────────────────────────────────────
    story.append(Paragraph(business_name or "BonBox", h_business))

    # ─── CVR + VAT + address line ────────────────────────────────
    cvr = (business_profile.get("org_number") or "").strip()
    vat_no = (business_profile.get("vat_number") or "").strip()
    addr = _format_dk_address(business_profile)
    meta_parts = []
    if cvr:
        meta_parts.append(f"CVR {cvr}")
    # Show VAT number only when distinct from CVR. In Denmark the two are
    # typically identical (CVR = VAT), but EU-cross-border filers have
    # separate numbers and a revisor expects both surfaced.
    if vat_no and vat_no != cvr:
        meta_parts.append(f"VAT {vat_no}")
    elif vat_no and not cvr:
        meta_parts.append(f"VAT {vat_no}")
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
        ["Kasse ved lukning",          _money(aggregated.get("cash_closing"), currency)],
        ["Indsat i bank",                    _money(aggregated.get("money_to_bank"), currency)],
        ["Paid out - change/byttep",         _money(aggregated.get("paid_out"), currency)],
        ["Paid in",                          _money(aggregated.get("paid_in"), currency)],
        ["Kasse ved åbning",           _money(aggregated.get("cash_opening"), currency)],
        ["Kontant i alt",                       _money(aggregated.get("cash_total"), currency)],
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
        ["Kassedifference (+/-)",  _money(cash_diff, currency)],
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

    # ─── Locked + signed indication (placeholder hash, patched after) ──
    # The hash is computed AFTER the first build (we need the rendered
    # bytes to hash them). For deterministic content we build twice:
    # pass 1 with "pending" hash → captures the byte signature; pass 2
    # with the real hash. ReportLab consumes flowables in-place, so we
    # rebuild the flowables for pass 2 via _kasserapport_body_story.
    lock_label = (
        "Låst + signeret" if is_locked_signed else "Forhåndsvisning (ikke låst)"
    )

    def _hash_block(hash_text: str) -> list:
        """Build the fresh tamper-evidence block (Spacer/HR/Paragraph)."""
        return [
            Spacer(1, 14),
            HRFlowable(
                width="100%",
                color=colors.HexColor("#e5e7eb"),
                thickness=0.4,
                spaceBefore=2,
                spaceAfter=4,
            ),
            Paragraph(
                f"<font color='#6b7280' size='7'>"
                f"<b>{lock_label}</b>  ·  Dokument-hash (SHA-256): "
                f"<font face='Courier'>{hash_text}</font>"
                f"</font>",
                styles["Normal"],
            ),
        ]

    # Pass 1: build with placeholder hash to capture page count + hash.
    canvas_maker = make_numbered_canvas(_draw_audit_footer)
    pass1_story = list(story) + _hash_block("pending")
    doc.build(pass1_story, canvasmaker=canvas_maker)
    pass1_bytes = buf.getvalue()
    real_hash = short_hash(pass1_bytes, length=16)

    # Pass 2: fresh doc + fresh flowables, real hash in the footer.
    buf2 = io.BytesIO()
    doc2 = SimpleDocTemplate(
        buf2,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=24 * mm,
        title=doc.title,
        author=doc.author,
        subject=doc.subject,
        creator=software_id,
    )
    story2 = _build_kasserapport_story(
        aggregated=aggregated,
        business_name=business_name,
        date_label=date_label,
        currency=currency,
        business_profile=business_profile,
        bilagsnummer=bilagsnummer,
        logo_bytes=logo_bytes,
    ) + _hash_block(real_hash)
    doc2.build(story2, canvasmaker=canvas_maker)
    return buf2.getvalue()


def _build_kasserapport_story(
    *,
    aggregated: dict,
    business_name: str,
    date_label: str,
    currency: str,
    business_profile: dict,
    bilagsnummer: str | None,
    logo_bytes: bytes | None = None,
) -> list:
    """Recreate the kasserapport story as fresh flowables.

    ReportLab mutates Paragraph/Table/Spacer objects during build (sets
    `_postponed`, splitter state, etc.). For our 2-pass render — pass 1
    captures the document hash, pass 2 embeds it in the footer — pass 2
    needs a clean second set of flowables. Inlining the build logic
    here keeps it next to the main renderer for easy auditing without
    exposing it as a public API.
    """
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable, Image as RLImage, Paragraph, Spacer, Table, TableStyle,
    )

    styles = getSampleStyleSheet()
    h_doc = ParagraphStyle(
        "DocType", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#6b7280"), spaceAfter=2, alignment=TA_LEFT,
    )
    h_business = ParagraphStyle(
        "Business", parent=styles["Title"], fontSize=18, spaceAfter=2,
        alignment=TA_LEFT, leading=22,
    )
    h_meta = ParagraphStyle(
        "Meta", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#374151"), spaceAfter=2, leading=12,
    )
    h_meta_dim = ParagraphStyle(
        "MetaDim", parent=styles["Normal"], fontSize=8.5,
        textColor=colors.HexColor("#6b7280"), spaceAfter=2, leading=11,
    )
    section = ParagraphStyle(
        "Section", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#15803d"), spaceBefore=10, spaceAfter=4,
        leading=12, fontName="Helvetica-Bold",
    )

    story: list = []

    # Logo
    if logo_bytes:
        try:
            img = RLImage(io.BytesIO(logo_bytes))
            iw, ih = img.imageWidth, img.imageHeight
            target_h = 18 * mm
            scale = target_h / ih if ih else 1
            target_w = min(iw * scale, 50 * mm)
            target_h = target_w * (ih / iw) if iw else target_h
            img.drawHeight = target_h; img.drawWidth = target_w
            story.append(img); story.append(Spacer(1, 4))
        except Exception:
            pass

    story.append(Paragraph("KASSERAPPORT", h_doc))
    story.append(Paragraph(business_name or "BonBox", h_business))

    cvr = (business_profile.get("org_number") or "").strip()
    vat_no = (business_profile.get("vat_number") or "").strip()
    addr = _format_dk_address(business_profile)
    meta_parts = []
    if cvr:
        meta_parts.append(f"CVR {cvr}")
    if vat_no and vat_no != cvr:
        meta_parts.append(f"VAT {vat_no}")
    elif vat_no and not cvr:
        meta_parts.append(f"VAT {vat_no}")
    if addr:
        meta_parts.append(addr)
    if meta_parts:
        story.append(Paragraph(" &nbsp;·&nbsp; ".join(meta_parts), h_meta_dim))

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
        width="100%", color=colors.HexColor("#e5e7eb"),
        thickness=0.6, spaceBefore=8, spaceAfter=4,
    ))

    story.append(Paragraph("KONTANT", section))
    cash_rows = [
        ["Kasse ved lukning",  _money(aggregated.get("cash_closing"), currency)],
        ["Indsat i bank",            _money(aggregated.get("money_to_bank"), currency)],
        ["Paid out - change/byttep", _money(aggregated.get("paid_out"), currency)],
        ["Paid in",                  _money(aggregated.get("paid_in"), currency)],
        ["Kasse ved åbning",   _money(aggregated.get("cash_opening"), currency)],
        ["Kontant i alt",               _money(aggregated.get("cash_total"), currency)],
    ]
    story.append(_kv_table(cash_rows, last_row_bold=True))

    story.append(Paragraph("ANDRE", section))
    other_rows = [
        ["Gift cards accepted (total)", _money(aggregated.get("gift_cards_total"), currency)],
        ["Mobile Pay",                  _money(aggregated.get("mobilepay_total"), currency)],
    ]
    story.append(_kv_table(other_rows))

    terminals = aggregated.get("terminals") or []
    if terminals:
        story.append(Paragraph("KORTBETALINGER PR. TERMINAL", section))
        for i, t in enumerate(terminals, start=1):
            t_name = t.get("terminal_name") or f"Terminal {i}"
            story.append(Spacer(1, 3))
            story.append(Paragraph(f"<b>{i}. {t_name}</b>", styles["Normal"]))
            term_rows = [
                ["Dankort",             _money(t.get("dankort"), currency)],
                ["Teller",              _money(t.get("teller"), currency)],
                ["Amex",                _money(t.get("amex"), currency)],
                [f"Total terminal {i}", _money(t.get("total"), currency)],
            ]
            story.append(_kv_table(term_rows, last_row_bold=True, indent=1))

    story.append(Paragraph("OPSUMMERING", section))
    agg_rows = [
        ["Cards total",     _money(aggregated.get("cards_total"), currency)],
        ["Payments total",  _money(aggregated.get("payments_total"), currency)],
    ]
    story.append(_kv_table(agg_rows, all_bold=True))

    # MOMS section
    payments_total = aggregated.get("payments_total")
    revenue = aggregated.get("revenue") or {}
    moms_subtotal = revenue.get("subtotal_excl_moms")
    moms_amount = revenue.get("moms_amount")
    moms_total = revenue.get("total_incl_moms")
    if moms_total is None and payments_total is not None:
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
        ["Subtotal ekskl. moms",  _money(moms_subtotal, currency)],
        ["Moms 25%",              _money(moms_amount, currency)],
        ["Total inkl. moms",      _money(moms_total, currency)],
    ]
    story.append(_kv_table(moms_rows, last_row_bold=True))

    # Afstemning
    story.append(Paragraph("AFSTEMNING", section))
    cash_diff = aggregated.get("cash_difference") or 0
    diff_flagged = bool(aggregated.get("cash_diff_flagged"))
    flagged_reason = aggregated.get("flagged_reason") or ""
    rec_rows = [
        ["Sales POS (incl. tax)", _money(aggregated.get("sales_pos"), currency)],
        ["Kassedifference (+/-)", _money(cash_diff, currency)],
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

    # Signature
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
    return story


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


# Public alias used by tests + external callers — matches the naming
# convention in the audit checklist ("render_kasserapport_pdf").
def render_kasserapport_pdf(*args, **kwargs) -> bytes:
    """Alias for render_close_pdf() — audit-grade kasserapport renderer."""
    return render_close_pdf(*args, **kwargs)


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
