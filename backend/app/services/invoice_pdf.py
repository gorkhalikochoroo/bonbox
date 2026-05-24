"""
Faktura PDF renderer.

Built to match Danish business norms — what a revisor expects to see when
the customer forwards it for bookkeeping. Standard A4 portrait, header
block with both parties' CVR + address, single-currency line table, moms
breakdown, payment info, footer with payment-terms reminder.

Compliance anchors (Bogføringsloven + Momsloven):
  • Issuer's full legal name + CVR + address — required
  • Customer's full name + CVR (if B2B) + address — required for >3.000 kr
  • Date of issue + due date — required
  • Sequential fakturanummer — required (gap-less)
  • Line items with qty + unit price + moms rate — required
  • Net subtotal, moms total, gross total — required
  • Currency code — DKK (or whatever was set on the invoice)
  • "Faktura" or "Kreditnota" header — explicit

Audit-grade upgrade (May 2026 SKAT-auditor pass):
  • Audit footer on every page — Page X of Y, generation timestamp,
    generator email, software identifier (BonBox vX.Y.Z), and the
    SHA-256 hash of the rendered document for tamper-evidence.
  • SAF-T accounting timestamps surface at the bottom of every page
    so an importer can map the voucher into the correct period.
  • White-label suppresses the software identifier line (per the Pro
    feature flag) but page numbers + hash always render — those are
    required for an audit-grade Danish faktura regardless of branding.

Localization: customer_lang on the invoice picks DA vs EN labels. Tax
content (Moms, SKAT references) ALWAYS in Danish per existing memory rule.
"""
from __future__ import annotations

import io
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, KeepTogether, Image as RLImage,
)
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.user import User
from app.services.voucher_service import format_voucher_number
from app.utils.document_hash import (
    compute_document_hash,
    get_software_identifier,
    make_numbered_canvas,
    short_hash,
)
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.invoice_pdf")


# ─── Bilingual labels (DA + EN; tax terms stay Danish either way) ────

_LABELS = {
    "da": {
        "title_invoice": "Faktura",
        "title_credit": "Kreditnota",
        "from": "Fra",
        "to": "Til",
        "invoice_no": "Faktura nr.",
        "credit_no": "Kreditnota nr.",
        "issue_date": "Fakturadato",
        "due_date": "Betalingsfrist",
        "cvr": "CVR",
        "description": "Beskrivelse",
        "qty": "Antal",
        "unit": "Enhed",
        "unit_price": "Pris pr. enhed",
        "moms_rate": "Moms",
        "line_total": "Total ekskl. moms",
        "subtotal": "Subtotal ekskl. moms",
        "moms_total": "Moms i alt",
        "total": "I alt at betale",
        "payment_info": "Betalingsoplysninger",
        "bank": "Bankoverførsel",
        "mobilepay": "MobilePay",
        "terms_label": "Betalingsfrist:",
        "terms_days": "{n} dage fra fakturadato",
        "notes": "Bemærkninger",
        "footer_attr": "bonbox.dk",
        "kreditering_note": "Denne kreditnota annullerer faktura nr. {orig}.",
    },
    "en": {
        "title_invoice": "Invoice",
        "title_credit": "Credit Note",
        "from": "From",
        "to": "To",
        "invoice_no": "Invoice no.",
        "credit_no": "Credit note no.",
        "issue_date": "Invoice date",
        "due_date": "Payment due",
        "cvr": "CVR",
        "description": "Description",
        "qty": "Qty",
        "unit": "Unit",
        "unit_price": "Unit price",
        "moms_rate": "Moms",  # tax term stays DA
        "line_total": "Line total (excl. Moms)",
        "subtotal": "Subtotal (excl. Moms)",
        "moms_total": "Moms total",
        "total": "Total to pay",
        "payment_info": "Payment information",
        "bank": "Bank transfer",
        "mobilepay": "MobilePay",
        "terms_label": "Payment due:",
        "terms_days": "{n} days from invoice date",
        "notes": "Notes",
        "footer_attr": "bonbox.dk",
        "kreditering_note": "This credit note voids invoice no. {orig}.",
    },
}


def _money(value: Decimal | float | int | None, currency: str = "DKK") -> str:
    """Format as '1.234,56 kr' (Danish style)."""
    if value is None:
        return ""
    d = Decimal(str(value)).quantize(Decimal("0.01"))
    # Danish format: thousands sep "." and decimal ","
    sign = "-" if d < 0 else ""
    abs_str = f"{abs(d):,.2f}"
    abs_str = abs_str.replace(",", "X").replace(".", ",").replace("X", ".")
    suffix = " kr" if currency == "DKK" else f" {currency}"
    return f"{sign}{abs_str}{suffix}"


def _fmt_pct(rate: Decimal | float) -> str:
    """0.250 → '25%'"""
    pct = Decimal(str(rate)) * 100
    pct = pct.quantize(Decimal("1") if pct == pct.to_integral_value() else Decimal("0.01"))
    return f"{pct}%"


def _fmt_date(d: date) -> str:
    """'14. maj 2026'-style Danish date."""
    months = [
        "januar", "februar", "marts", "april", "maj", "juni",
        "juli", "august", "september", "oktober", "november", "december",
    ]
    return f"{d.day}. {months[d.month - 1]} {d.year}"


# ─── White-label gate ────────────────────────────────────────────────


def _is_white_label(user: User | None) -> bool:
    """Should the rendered PDF omit the BonBox attribution footer?

    True only if `user` has the `white_label_pdf` feature enabled in
    PLAN_FEATURES (currently Pro + trial). Defaults to False on any
    error — safer to leave the attribution in than to silently strip it.
    """
    if user is None:
        return False
    try:
        from app.services.billing import has_feature
        return bool(has_feature(user, "white_label_pdf"))
    except Exception:
        return False


# ─── MobilePay QR helper ────────────────────────────────────────────


def _build_mobilepay_qr_payload(
    mobilepay_number: str, amount: Decimal, faktura_ref: str,
) -> str:
    """Build the MobilePay deep-link URL embedded into the QR code.

    The URL format is the published MobilePay scheme:
      mobilepay://send?phone=XXXXXXXX&amount=NN.NN&comment=REFERENCE

    Notes:
      • phone — strip non-digit chars from mobilepay_number (users
        sometimes paste '+45 12 34 56 78', the scheme wants raw digits).
      • amount — decimal with dot separator, 2 places. MobilePay app
        opens with this pre-filled but the payer can still edit it
        (we can't enforce exact amount via deep-link; that's a paid-
        MobilePay-API-only feature).
      • comment — the fakturanummer string, so the payment lands in
        the owner's MobilePay with the right reference and our auto-
        matcher can later confirm it via _text_signal_matches.
    """
    digits = "".join(c for c in (mobilepay_number or "") if c.isdigit())
    amount_str = f"{amount:.2f}"
    # URL-encode the comment so weird customer-typed faktura refs don't
    # break the deep link. quote_plus uses + for space which MobilePay
    # accepts fine.
    from urllib.parse import quote_plus
    return (
        f"mobilepay://send?phone={digits}"
        f"&amount={amount_str}"
        f"&comment={quote_plus(faktura_ref)}"
    )


def _make_mobilepay_qr_flowable(
    mobilepay_number: str, amount: Decimal, faktura_ref: str,
    size_mm: float = 26.0,
) -> RLImage | None:
    """Render the MobilePay deep-link as a QR code, returned as a
    ReportLab Image flowable ready to drop into a Table cell.

    Returns None on any error — the PDF still ships, the customer just
    has to type the MobilePay number manually. Never break the PDF
    over a QR rendering glitch.
    """
    try:
        import qrcode
        payload = _build_mobilepay_qr_payload(
            mobilepay_number, amount, faktura_ref,
        )
        qr = qrcode.QRCode(
            version=None,
            # M-level error correction — 15% redundancy survives a small
            # smudge or fold on a printed faktura, doesn't bloat the
            # code so much that a phone camera struggles.
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=2,
        )
        qr.add_data(payload)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return RLImage(buf, width=size_mm * mm, height=size_mm * mm)
    except Exception as e:
        logger.warning("mobilepay QR render failed: %s — skipping", e)
        return None


# ─── Renderer ────────────────────────────────────────────────────────


def render_invoice_pdf(db: Session, invoice: Invoice) -> bytes:
    """
    Return PDF bytes for the invoice. A4 portrait, typically 1 page.

    Caller is responsible for tenant scoping — pass an Invoice owned by
    the calling user (the router already filters by user_id).

    Two-pass build (May 2026 audit upgrade):
      Pass 1 — render with the hash placeholder ("pending") so we can
        compute the deterministic SHA-256 fingerprint of the rendered
        bytes.
      Pass 2 — re-render with the real hash visible in the footer.
        Fresh flowables on each pass avoid ReportLab's in-place
        mutation trap.
    Both passes share _render_invoice_pdf_with_hash so the body
    construction lives in one place (_build_invoice_story).
    """
    user = (
        db.query(User).filter(User.id == invoice.user_id).first()
    )
    is_wl = _is_white_label(user)

    # Pass 1: placeholder hash.
    pass1 = _render_invoice_pdf_with_hash(
        db, invoice, doc_hash="pending", is_wl_override=is_wl,
    )
    # Pass 2: real hash stamped into the audit footer.
    final_pdf = _render_invoice_pdf_with_hash(
        db, invoice, doc_hash=short_hash(pass1, length=16),
        is_wl_override=is_wl,
    )
    logger.info(
        "invoice_pdf rendered user=%s fakturanummer=%s bytes=%d sha=%s",
        invoice.user_id, invoice.fakturanummer, len(final_pdf),
        compute_document_hash(final_pdf)[:16],
    )
    return final_pdf


def _render_invoice_pdf_with_hash(
    db: Session, invoice: Invoice, doc_hash: str, is_wl_override: bool,
) -> bytes:
    """Build a single invoice PDF with a known hash value baked into
    the audit footer. Called twice by render_invoice_pdf (placeholder
    pass + real-hash pass)."""
    lang = invoice.customer_lang if invoice.customer_lang in ("da", "en") else "da"
    L = _LABELS[lang]

    customer = (
        db.query(Customer).filter(Customer.id == invoice.customer_id).first()
    )
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == invoice.user_id)
        .first()
    )
    user = (
        db.query(User).filter(User.id == invoice.user_id).first()
    )

    is_credit = invoice.is_credit_note
    title = L["title_credit"] if is_credit else L["title_invoice"]
    num_label = L["credit_no"] if is_credit else L["invoice_no"]
    fakturanr_display = format_voucher_number(
        "invoice", invoice.issue_date.year, invoice.fakturanummer,
    )

    generated_at_str = utc_now().strftime("%Y-%m-%d %H:%M UTC")
    generator_email = (user.email if user else None) or "system"
    software_id = get_software_identifier()

    def _draw_footer(canv, page_num, total_pages):
        """Audit footer drawn on every page by NumberedCanvas.

        Layout (bottom of page):
          • Left:   Doc-hash: <16 hex chars>
          • Center: Generated YYYY-MM-DD HH:MM UTC by user@email · BonBox v…
          • Right:  Page X of Y
        White-label suppresses the software identifier but never the
        page numbers or the document hash — those are part of the
        audit guarantee regardless of branding tier.
        """
        canv.saveState()
        canv.setFont("Helvetica", 6.8)
        canv.setFillColor(colors.HexColor("#94a3b8"))
        canv.drawRightString(
            A4[0] - 18 * mm, 10 * mm,
            f"Page {page_num} of {total_pages}",
        )
        center_line = f"Generated {generated_at_str} by {generator_email}"
        if not is_wl_override:
            center_line = f"{center_line}  ·  {software_id}"
        canv.drawCentredString(A4[0] / 2, 10 * mm, center_line)
        canv.drawString(18 * mm, 10 * mm, f"Doc-hash: {doc_hash}")
        canv.restoreState()

    story = _build_invoice_story(
        invoice=invoice, customer=customer, profile=profile,
        user=user, lang=lang, title=title, num_label=num_label,
        fakturanr_display=fakturanr_display, is_credit=is_credit,
        is_wl=is_wl_override,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=22 * mm,  # extra space for the audit footer
        title=f"{title} {fakturanr_display}",
        author="BonBox",
        creator=software_id,
        subject=f"{title} {fakturanr_display}",
    )
    doc.build(story, canvasmaker=make_numbered_canvas(_draw_footer))
    return buf.getvalue()


def _build_invoice_story(
    *, invoice, customer, profile, user, lang: str, title: str,
    num_label: str, fakturanr_display: str, is_credit: bool, is_wl: bool,
) -> list:
    """Build the invoice story as fresh flowables.

    ReportLab mutates Paragraph/Table/Spacer objects during build (sets
    `_postponed`, splitter state, etc.). For the 2-pass render — pass 1
    captures the document hash, pass 2 stamps it into the footer —
    pass 2 needs a clean second set of flowables. This helper produces
    those flowables fresh on every call.
    """
    L = _LABELS[lang]

    # ── Branding: logo + accent color (migration 034) ───────────────
    # Both come from BusinessProfile. Logo is an S3 key — we fetch the
    # raw bytes here (NOT a signed URL — ReportLab parses bytes locally).
    # Failures degrade gracefully: no logo = plain text business name,
    # no accent color = neutral slate.
    logo_image_bytes: bytes | None = None
    logo_position = "left"
    accent_hex = "#0F172A"
    if profile:
        if profile.logo_url:
            try:
                from app.services.storage import get_storage
                storage = get_storage()
                if hasattr(storage, "get"):
                    logo_image_bytes = storage.get(profile.logo_url)
            except Exception:
                logger.exception(
                    "logo fetch failed for user=%s key=%s",
                    invoice.user_id, profile.logo_url,
                )
                logo_image_bytes = None
        if profile.logo_position in ("left", "center"):
            logo_position = profile.logo_position
        if (profile.accent_color and profile.accent_color.startswith("#")
                and len(profile.accent_color) == 7):
            accent_hex = profile.accent_color

    def _make_logo_flowable():
        if not logo_image_bytes:
            return None
        try:
            img = RLImage(io.BytesIO(logo_image_bytes))
            iw, ih = img.imageWidth, img.imageHeight
            target_h = 22 * mm
            scale = target_h / ih if ih else 1
            target_w = min(iw * scale, 60 * mm)
            target_h = target_w * (ih / iw) if iw else target_h
            img.drawHeight = target_h; img.drawWidth = target_w
            return img
        except Exception:
            logger.exception(
                "logo flowable build failed user=%s", invoice.user_id,
            )
            return None

    # ── Issuer block ────────────────────────────────────────────────
    issuer_name = (
        (profile.company_name if profile and profile.company_name else None)
        or (user.business_name if user and user.business_name else None)
        or "BonBox"
    )
    issuer_cvr = (
        (profile.vat_number if profile and profile.vat_number else None)
        or (profile.org_number if profile and profile.org_number else None)
    )
    issuer_addr_lines = []
    if profile:
        if profile.address:
            issuer_addr_lines.append(profile.address)
        zc = " ".join(filter(None, [profile.zipcode, profile.city]))
        if zc.strip():
            issuer_addr_lines.append(zc)
    issuer_email = user.email if user else None

    # ── Customer block ──────────────────────────────────────────────
    cust_name = customer.name if customer else "—"
    cust_cvr = customer.cvr if customer else None
    # EAN-nummer rendered on its own line — required to invoice DK public
    # sector via NemHandel/OIOUBL. Optional otherwise; only renders when set.
    cust_ean = getattr(customer, "ean_nummer", None) if customer else None
    cust_addr_lines = []
    if customer:
        if customer.address:
            cust_addr_lines.append(customer.address)
        zc = " ".join(filter(None, [customer.zipcode, customer.city]))
        if zc.strip():
            cust_addr_lines.append(zc)
        if customer.email:
            cust_addr_lines.append(customer.email)

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=22, leading=26,
                        spaceAfter=2, textColor=colors.HexColor("#0F172A"))
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=10, leading=12,
                        spaceAfter=2, textColor=colors.HexColor("#64748B"))
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=10, leading=13,
                          textColor=colors.HexColor("#0F172A"))
    small = ParagraphStyle("small", parent=styles["BodyText"], fontSize=8.5, leading=10,
                           textColor=colors.HexColor("#475569"))
    right = ParagraphStyle("right", parent=body, alignment=TA_RIGHT)
    right_small = ParagraphStyle("right_small", parent=small, alignment=TA_RIGHT)

    story: list = []
    logo_flowable = _make_logo_flowable()

    if logo_flowable and logo_position == "center":
        center_logo_row = Table([[logo_flowable]], colWidths=[170 * mm])
        center_logo_row.setStyle(TableStyle([
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(center_logo_row)
        story.append(Spacer(1, 4 * mm))

    if logo_flowable and logo_position == "left":
        title_row = Table(
            [[
                logo_flowable,
                Paragraph(f"<b>{title}</b>", h1),
                Paragraph(
                    f"<b>{num_label}</b><br/><font size=14>{fakturanr_display}</font>",
                    right,
                ),
            ]],
            colWidths=[40 * mm, 70 * mm, 60 * mm],
        )
        title_row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
    else:
        title_row = Table(
            [[
                Paragraph(f"<b>{title}</b>", h1),
                Paragraph(
                    f"<b>{num_label}</b><br/><font size=14>{fakturanr_display}</font>",
                    right,
                ),
            ]],
            colWidths=[110 * mm, 60 * mm],
        )
        title_row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
    story.append(title_row)

    if accent_hex != "#0F172A":
        accent_bar = Table([[""]], colWidths=[174 * mm], rowHeights=[1.5 * mm])
        accent_bar.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(accent_hex)),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(Spacer(1, 2 * mm))
        story.append(accent_bar)
    story.append(Spacer(1, 8 * mm))

    # ── Party blocks ────────────────────────────────────────────────
    issuer_lines = [f"<b>{issuer_name}</b>"]
    if issuer_cvr:
        issuer_lines.append(f"{L['cvr']}: {issuer_cvr}")
    issuer_lines.extend(issuer_addr_lines)
    if issuer_email:
        issuer_lines.append(issuer_email)
    cust_lines = [f"<b>{cust_name}</b>"]
    if cust_cvr:
        cust_lines.append(f"{L['cvr']}: {cust_cvr}")
    if cust_ean:
        cust_lines.append(f"EAN: {cust_ean}")
    cust_lines.extend(cust_addr_lines)
    parties = Table(
        [
            [Paragraph(L["from"], h2), Paragraph(L["to"], h2)],
            [
                Paragraph("<br/>".join(issuer_lines), body),
                Paragraph("<br/>".join(cust_lines), body),
            ],
        ],
        colWidths=[85 * mm, 85 * mm],
    )
    parties.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, 0), (-1, 0), 0),
    ]))
    story.append(parties)
    story.append(Spacer(1, 8 * mm))

    # ── Dates + currency ────────────────────────────────────────────
    # Leveringsdato column appears only when set (Momsbekendtgørelsen §57
    # requires it on the faktura when delivery ≠ issue date).
    delivery = getattr(invoice, "delivery_date", None)
    delivery_label = "Leveringsdato" if lang == "da" else "Delivery date"
    if delivery:
        meta_data = [
            [
                Paragraph(L["issue_date"], h2),
                Paragraph(delivery_label, h2),
                Paragraph(L["due_date"], h2),
                Paragraph("Valuta" if lang == "da" else "Currency", h2),
            ],
            [
                Paragraph(f"<b>{_fmt_date(invoice.issue_date)}</b>", body),
                Paragraph(f"<b>{_fmt_date(delivery)}</b>", body),
                Paragraph(f"<b>{_fmt_date(invoice.due_date)}</b>", body),
                Paragraph(f"<b>{invoice.currency}</b>", body),
            ],
        ]
        meta = Table(meta_data, colWidths=[43 * mm, 43 * mm, 43 * mm, 42 * mm])
    else:
        meta_data = [
            [
                Paragraph(L["issue_date"], h2),
                Paragraph(L["due_date"], h2),
                Paragraph("Valuta" if lang == "da" else "Currency", h2),
            ],
            [
                Paragraph(f"<b>{_fmt_date(invoice.issue_date)}</b>", body),
                Paragraph(f"<b>{_fmt_date(invoice.due_date)}</b>", body),
                Paragraph(f"<b>{invoice.currency}</b>", body),
            ],
        ]
        meta = Table(meta_data, colWidths=[57 * mm, 57 * mm, 57 * mm])
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
    ]))
    story.append(meta)
    story.append(Spacer(1, 8 * mm))

    if is_credit and invoice.notes:
        story.append(Paragraph(f"<i>{invoice.notes}</i>", small))
        story.append(Spacer(1, 4 * mm))

    # ── Line items table ────────────────────────────────────────────
    line_header = [
        Paragraph(f"<b>{L['description']}</b>", small),
        Paragraph(f"<b>{L['qty']}</b>", right_small),
        Paragraph(f"<b>{L['unit_price']}</b>", right_small),
        Paragraph(f"<b>{L['moms_rate']}</b>", right_small),
        Paragraph(f"<b>{L['line_total']}</b>", right_small),
    ]
    line_rows = [line_header]
    for line in sorted(invoice.lines, key=lambda l: l.line_order):
        qty_str = str(line.quantity).rstrip("0").rstrip(".") or "1"
        if line.unit:
            qty_str = f"{qty_str} {line.unit}"
        line_rows.append([
            Paragraph(line.description, body),
            Paragraph(qty_str, right),
            Paragraph(_money(line.unit_price_net, invoice.currency), right),
            Paragraph(_fmt_pct(line.moms_rate), right),
            Paragraph(_money(line.line_net, invoice.currency), right),
        ])
    lines_table = Table(
        line_rows,
        colWidths=[78 * mm, 18 * mm, 28 * mm, 16 * mm, 32 * mm],
        repeatRows=1,
    )
    lines_table.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#0F172A")),
        ("LINEBELOW", (0, -1), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(lines_table)
    story.append(Spacer(1, 6 * mm))

    # ── Totals (right-aligned, 3 rows) ──────────────────────────────
    totals_data = [
        [Paragraph(L["subtotal"], right_small),
         Paragraph(_money(invoice.subtotal_net, invoice.currency), right)],
        [Paragraph(L["moms_total"], right_small),
         Paragraph(_money(invoice.moms_total, invoice.currency), right)],
        [
            Paragraph(f"<b>{L['total']}</b>",
                      ParagraphStyle("tlbl", parent=right, fontSize=11)),
            Paragraph(f"<b>{_money(invoice.total_gross, invoice.currency)}</b>",
                      ParagraphStyle("tval", parent=right, fontSize=13)),
        ],
    ]
    totals = Table(totals_data, colWidths=[100 * mm, 72 * mm], hAlign="RIGHT")
    totals.setStyle(TableStyle([
        ("ALIGN", (-1, 0), (-1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.6, colors.HexColor("#0F172A")),
        ("TOPPADDING", (0, -1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(totals)
    story.append(Spacer(1, 10 * mm))

    # ── Payment block ───────────────────────────────────────────────
    payment_lines = [f"<b>{L['payment_info']}</b>"]
    bank_reg = getattr(profile, "bank_reg_number", None) if profile else None
    bank_acct = getattr(profile, "bank_account_number", None) if profile else None
    mobilepay = getattr(profile, "mobilepay_number", None) if profile else None
    iban = getattr(profile, "iban", None) if profile else None
    bic = getattr(profile, "bic", None) if profile else None
    has_any_payment = bool(bank_reg or bank_acct or mobilepay or iban)
    if bank_reg or bank_acct:
        payment_lines.append(
            f"{L['bank']}: Reg. {bank_reg or '—'} · Konto {bank_acct or '—'}"
        )
    if mobilepay:
        payment_lines.append(f"{L['mobilepay']}: {mobilepay}")
    if iban:
        iban_line = f"IBAN: {iban}"
        if bic:
            iban_line += f"  ·  BIC/SWIFT: {bic}"
        payment_lines.append(iban_line)
    if not has_any_payment:
        warn = (
            "Manglende betalingsoplysninger — udfyld bank/MobilePay under Profil."
            if lang == "da"
            else "No payment details on file — add bank/MobilePay in Profile."
        )
        payment_lines.append(f"<font color='#B91C1C'>⚠️  {warn}</font>")
    days = (invoice.due_date - invoice.issue_date).days
    payment_lines.append(f"{L['terms_label']} {L['terms_days'].format(n=days)}")
    if invoice.notes and not is_credit:
        payment_lines.append("")
        payment_lines.append(f"<i>{L['notes']}: {invoice.notes}</i>")

    # MobilePay QR
    mp_qr = None
    if mobilepay and not is_credit and invoice.total_gross > 0:
        mp_qr = _make_mobilepay_qr_flowable(
            mobilepay_number=mobilepay,
            amount=Decimal(str(invoice.total_gross)),
            faktura_ref=fakturanr_display,
        )
    if mp_qr is not None:
        payment_text = Paragraph("<br/>".join(payment_lines), body)
        scan_label = (
            "Scan med MobilePay" if lang == "da" else "Scan with MobilePay"
        )
        qr_cell = [mp_qr, Paragraph(
            f"<font size='7' color='#475569'>{scan_label}</font>", small,
        )]
        pay_row = Table(
            [[payment_text, qr_cell]], colWidths=[125 * mm, 35 * mm],
        )
        pay_row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (1, 0), (1, 0), "CENTER"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(pay_row)
    else:
        story.append(Paragraph("<br/>".join(payment_lines), body))
    story.append(Spacer(1, 12 * mm))

    if not is_wl:
        story.append(Paragraph(L["footer_attr"], small))

    # ── SAF-T accounting timestamps (Bogføringsloven 2024 §10) ──────
    # SAF-T expects every accounting document to expose TaxPointDate,
    # AccountingDate, and GLPostingDate so an importer can map the
    # voucher into the correct period. For a Danish faktura:
    #   TaxPointDate   = invoice.issue_date (when the supply was made
    #     for VAT purposes; defaults to issue date when no separate
    #     delivery date is set)
    #   AccountingDate = invoice.issue_date (when the entry is booked)
    #   GLPostingDate  = invoice.delivery_date if set else issue_date
    # Rendered as tiny grey metadata at the very bottom — invisible
    # to the customer but lets an accountant grep the PDF or visually
    # confirm the SAF-T mapping when reviewing.
    tax_point = invoice.issue_date
    accounting_date = invoice.issue_date
    gl_posting = getattr(invoice, "delivery_date", None) or invoice.issue_date
    saft_label = (
        f"<font color='#cbd5e1' size='6'>"
        f"SAF-T · TaxPointDate {tax_point.isoformat()}  ·  "
        f"AccountingDate {accounting_date.isoformat()}  ·  "
        f"GLPostingDate {gl_posting.isoformat()}"
        f"</font>"
    )
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(saft_label, small))

    return story
