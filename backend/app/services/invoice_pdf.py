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


# ─── Renderer ────────────────────────────────────────────────────────

def render_invoice_pdf(db: Session, invoice: Invoice) -> bytes:
    """
    Return PDF bytes for the invoice. Single page A4 portrait.

    Caller is responsible for tenant scoping — pass an Invoice owned by
    the calling user (the router already filters by user_id).
    """
    lang = invoice.customer_lang if invoice.customer_lang in ("da", "en") else "da"
    L = _LABELS[lang]

    customer = (
        db.query(Customer)
        .filter(Customer.id == invoice.customer_id)
        .first()
    )
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == invoice.user_id)
        .first()
    )
    user = (
        db.query(User)
        .filter(User.id == invoice.user_id)
        .first()
    )

    is_credit = invoice.is_credit_note
    title = L["title_credit"] if is_credit else L["title_invoice"]
    num_label = L["credit_no"] if is_credit else L["invoice_no"]
    fakturanr_display = format_voucher_number("invoice", invoice.issue_date.year, invoice.fakturanummer)

    # ── Branding: logo + accent color (migration 034) ───────────────
    # Both come from BusinessProfile. Logo is an S3 key — we fetch the
    # raw bytes here (NOT a signed URL — ReportLab parses bytes locally).
    # Failures degrade gracefully: no logo = plain text business name,
    # no accent color = neutral slate.
    logo_image_bytes: bytes | None = None
    logo_position = "left"
    accent_hex = "#0F172A"  # neutral default (matches body text)

    if profile:
        if profile.logo_url:
            try:
                from app.services.storage import get_storage
                storage = get_storage()
                if hasattr(storage, "get"):
                    logo_image_bytes = storage.get(profile.logo_url)
            except Exception:
                # Logo fetch is best-effort. If storage is down or the
                # key is stale, we render without a logo rather than
                # breaking the PDF generation entirely.
                logger.exception("logo fetch failed for user=%s key=%s",
                                 invoice.user_id, profile.logo_url)
                logo_image_bytes = None
        if profile.logo_position in ("left", "center"):
            logo_position = profile.logo_position
        if profile.accent_color and profile.accent_color.startswith("#") and len(profile.accent_color) == 7:
            # Validated at schema layer to be a palette hex — extra
            # paranoia: only accept exactly 7-char hex starting with #.
            accent_hex = profile.accent_color

    def _make_logo_flowable() -> RLImage | None:
        """Build a sized ReportLab Image from the loaded bytes. Max 30mm
        tall to keep the header proportional. Aspect ratio preserved."""
        if not logo_image_bytes:
            return None
        try:
            img = RLImage(io.BytesIO(logo_image_bytes))
            # Cap height at 22mm — Copenhagen-standard faktura keeps
            # the logo restrained, not screaming. Width scales by
            # aspect ratio. ReportLab handles the math when only one
            # dimension is set.
            iw, ih = img.imageWidth, img.imageHeight
            target_h = 22 * mm
            scale = target_h / ih if ih else 1
            target_w = min(iw * scale, 60 * mm)  # cap width too
            target_h = target_w * (ih / iw) if iw else target_h
            img.drawHeight = target_h
            img.drawWidth = target_w
            return img
        except Exception:
            logger.exception("logo flowable build failed user=%s", invoice.user_id)
            return None

    # ── Issuer block ────────────────────────────────────────────────
    issuer_name = (profile.company_name if profile and profile.company_name else None) or (user.business_name if user and user.business_name else None) or "BonBox"
    issuer_cvr = (profile.vat_number if profile and profile.vat_number else None) or (profile.org_number if profile and profile.org_number else None)
    issuer_addr_lines = []
    if profile:
        if profile.address:
            issuer_addr_lines.append(profile.address)
        zc = " ".join(filter(None, [profile.zipcode, profile.city]))
        if zc.strip():
            issuer_addr_lines.append(zc)
    # Email fallback to user.email if profile has no contact field
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

    # ── Build the doc ───────────────────────────────────────────────
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{title} {fakturanr_display}",
        author="BonBox",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "h1", parent=styles["Heading1"], fontSize=22, leading=26,
        spaceAfter=2, textColor=colors.HexColor("#0F172A"),
    )
    h2 = ParagraphStyle(
        "h2", parent=styles["Heading2"], fontSize=10, leading=12,
        spaceAfter=2, textColor=colors.HexColor("#64748B"),
    )
    body = ParagraphStyle(
        "body", parent=styles["BodyText"], fontSize=10, leading=13,
        textColor=colors.HexColor("#0F172A"),
    )
    small = ParagraphStyle(
        "small", parent=styles["BodyText"], fontSize=8.5, leading=10,
        textColor=colors.HexColor("#475569"),
    )
    right = ParagraphStyle(
        "right", parent=body, alignment=TA_RIGHT,
    )
    right_small = ParagraphStyle(
        "right_small", parent=small, alignment=TA_RIGHT,
    )
    # Total style uses accent_hex when the owner picked a brand color,
    # otherwise the neutral charcoal that's been here from the start.
    # The migration-034 accent_hex variable lives in the outer function
    # scope (defined above when we read profile.accent_color).
    total_style = ParagraphStyle(
        "total", parent=body, fontSize=13, leading=16,
        textColor=colors.HexColor(accent_hex), fontName="Helvetica-Bold",
    )

    story = []

    # ── Logo (top, centered) — migration 034 ────────────────────────
    # 'center' position renders the logo on its own row above the title.
    # 'left' position embeds it next to the title in the same row.
    logo_flowable = _make_logo_flowable()

    if logo_flowable and logo_position == "center":
        center_logo_row = Table(
            [[logo_flowable]],
            colWidths=[170 * mm],
        )
        center_logo_row.setStyle(TableStyle([
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(center_logo_row)
        story.append(Spacer(1, 4 * mm))

    # ── Title + number top row ──────────────────────────────────────
    if logo_flowable and logo_position == "left":
        # 3-column row: logo | title | invoice nr
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

    # Accent color bar — 2mm tall line under the title row using the
    # business's accent color. Subtle "this is a branded faktura" cue
    # without overwhelming the content.
    if accent_hex != "#0F172A":
        accent_bar = Table(
            [[""]],
            colWidths=[174 * mm],
            rowHeights=[1.5 * mm],
        )
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

    # ── From / To party blocks ──────────────────────────────────────
    issuer_lines = [f"<b>{issuer_name}</b>"]
    if issuer_cvr:
        issuer_lines.append(f"{L['cvr']}: {issuer_cvr}")
    issuer_lines.extend(issuer_addr_lines)
    if issuer_email:
        issuer_lines.append(issuer_email)
    issuer_para = Paragraph("<br/>".join(issuer_lines), body)

    cust_lines = [f"<b>{cust_name}</b>"]
    if cust_cvr:
        cust_lines.append(f"{L['cvr']}: {cust_cvr}")
    if cust_ean:
        cust_lines.append(f"EAN: {cust_ean}")
    cust_lines.extend(cust_addr_lines)
    cust_para = Paragraph("<br/>".join(cust_lines), body)

    parties = Table(
        [
            [Paragraph(L["from"], h2), Paragraph(L["to"], h2)],
            [issuer_para, cust_para],
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
    # requires it on the faktura when delivery ≠ issue date). Keeping it
    # off the table for same-day jobs avoids visual noise.
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

    # ── Kreditnota cross-reference note ─────────────────────────────
    if is_credit and invoice.notes:
        story.append(Paragraph(
            f"<i>{invoice.notes}</i>",
            small,
        ))
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
        [Paragraph(L["subtotal"], right_small), Paragraph(_money(invoice.subtotal_net, invoice.currency), right)],
        [Paragraph(L["moms_total"], right_small), Paragraph(_money(invoice.moms_total, invoice.currency), right)],
        [
            Paragraph(f"<b>{L['total']}</b>", ParagraphStyle("tlbl", parent=right, fontSize=11)),
            Paragraph(f"<b>{_money(invoice.total_gross, invoice.currency)}</b>", ParagraphStyle("tval", parent=right, fontSize=13)),
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
    # Payment details now live on BusinessProfile (migration 033), not User.
    # Read from profile so the issuer's faktura actually tells the customer
    # how to pay. If neither bank nor MobilePay is on file, the PDF surfaces
    # a visible warning instead of going silent — Momsbekendtgørelsen §57
    # treats this section as required.
    payment_lines = [f"<b>{L['payment_info']}</b>"]
    bank_reg = getattr(profile, "bank_reg_number", None) if profile else None
    bank_acct = getattr(profile, "bank_account_number", None) if profile else None
    mobilepay = getattr(profile, "mobilepay_number", None) if profile else None
    iban = getattr(profile, "iban", None) if profile else None
    bic = getattr(profile, "bic", None) if profile else None
    has_any_payment = bool(bank_reg or bank_acct or mobilepay or iban)

    if bank_reg or bank_acct:
        payment_lines.append(
            f"{L['bank']}: Reg. {bank_reg or '—'} · "
            f"Konto {bank_acct or '—'}"
        )
    if mobilepay:
        payment_lines.append(f"{L['mobilepay']}: {mobilepay}")
    if iban:
        iban_line = f"IBAN: {iban}"
        if bic:
            iban_line += f"  ·  BIC/SWIFT: {bic}"
        payment_lines.append(iban_line)
    if not has_any_payment:
        # Loud warning — better visible than a silent compliance gap.
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
    story.append(Paragraph("<br/>".join(payment_lines), body))
    story.append(Spacer(1, 12 * mm))

    # ── Footer attribution ──────────────────────────────────────────
    story.append(Paragraph(L["footer_attr"], small))

    # Build
    doc.build(story)
    buf.seek(0)
    pdf_bytes = buf.getvalue()
    logger.info(
        "invoice_pdf rendered user=%s fakturanummer=%s bytes=%d lang=%s",
        invoice.user_id, fakturanr_display, len(pdf_bytes), lang,
    )
    return pdf_bytes
