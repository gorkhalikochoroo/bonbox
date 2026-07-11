"""Gavekort (gift card) PDF renderer — a printable, owner-branded card.

A pure, DB-free renderer: give it a `card` (a GiftCard row or any object with
the same attribute names), the owner's `BusinessProfile`, a `template` id, and
a `redeem_url` (what the QR encodes), and it returns finished PDF bytes.

The output is ONE credit-card-shaped card (aspect 1.586 : 1) centred in the
upper-middle of an A4 portrait page, wrapped in a faint dashed cut-guide with a
"Klip ud langs kanten" caption — the owner prints it, cuts it out, and hands it
over. Two premium templates share ONE exact layout so the on-screen React
preview and this print can look identical:

  • "minimal" (light) — paper #fbfaf7, ink, a 5px owner-accent bar down the
    left edge, QR dark-on-white.
  • "foil" (dark) — near-black #14120f, warm text, ONE gold accent (#c9a96a),
    a thin gold hairline above the amount, QR dark-on-#f4f1ea.

DK terminology lock — these labels NEVER translate: "Gavekort", "Til", "Fra",
"Indløs i butik", "Gyldig til", "CVR". Danish dates render like "12. jul 2028".

DESIGN DOCTRINE — premium via restraint: generous margins, refined type, ONE
accent per card, no gradients (bar the flat foil background), no clutter.

GRACEFUL DEGRADATION is a hard rule (money surface, printed by non-technical
owners): this module NEVER raises over missing branding. No logo bytes → draw
the monogram. No profile → sensible blanks. No expiry → omit "Gyldig til …".
No CVR → omit it. Unknown template → treat as "minimal". Logo + QR rendering are
each wrapped in try/except and degrade silently.

Money is INTEGER ØRE on the card model; the printed amount is the card's FACE
VALUE (`face_value_minor`), converted øre→currency via
`money_dk(face_value_minor / 100)` — the canonical Danish formatter shared with
every other BonBox export (see bonbox_pdf_kit).
"""
import io
import logging
from datetime import date, datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.services.bonbox_pdf_kit import money_dk

logger = logging.getLogger("bonbox.gavekort_pdf")


# ─── Danish month abbreviations (for "12. jul 2028") ─────────────────────
_DK_MONTHS_ABBR = [
    "jan", "feb", "mar", "apr", "maj", "jun",
    "jul", "aug", "sep", "okt", "nov", "dec",
]


def _fmt_date_dk(value) -> str | None:
    """Format a date/datetime as Danish '12. jul 2028'. None → None."""
    if value is None:
        return None
    d = value.date() if isinstance(value, datetime) else value
    if not isinstance(d, date):
        return None
    return f"{d.day}. {_DK_MONTHS_ABBR[d.month - 1]} {d.year}"


# ─── Template tokens ─────────────────────────────────────────────────────
# One accent per card. `minimal` accent is owner-set (falls back to a calm
# BonBox green); `foil` accent is ALWAYS the gold — the template IS its accent.
_TEMPLATES = {
    "minimal": {
        "paper": "#fbfaf7",
        "ink": "#14120f",
        "muted": "#8a857c",
        "hairline": "#e8e5df",
        "default_accent": "#166b4f",
        "chip": "#ffffff",
        "qr_dark": "#14120f",
        "qr_light": "#ffffff",
        "monogram_fill": True,     # filled accent square, paper-coloured text
        "accent_bar": True,        # 5px accent bar down the left edge
        "amount_hairline": False,
        "border": True,            # subtle hairline border around the card
    },
    "foil": {
        "paper": "#14120f",
        "ink": "#f4f1ea",
        "muted": "#a49a86",
        "hairline": "#c9a96a",
        "default_accent": "#c9a96a",
        "chip": "#f4f1ea",
        "qr_dark": "#14120f",
        "qr_light": "#f4f1ea",
        "monogram_fill": False,    # gold-outline square, gold text
        "accent_bar": False,
        "amount_hairline": True,   # thin gold hairline above the amount
        "border": False,
    },
}


def _valid_hex(value) -> str | None:
    """Return a '#RRGGBB' hex if `value` is exactly that, else None."""
    if isinstance(value, str) and value.startswith("#") and len(value) == 7:
        try:
            colors.HexColor(value)
            return value
        except Exception:  # noqa: BLE001
            return None
    return None


def _initials(name: str) -> str:
    """Monogram glyph: first letters of the business name (max 2 chars).

    'BonBox Café' → 'BC'; 'BonBox' → 'BO'; '' → 'GK' (gavekort fallback).
    """
    words = [w for w in (name or "").split() if w]
    if not words:
        return "GK"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def _fit(c: canvas.Canvas, text: str, font: str, size: float, max_w: float) -> str:
    """Truncate `text` with an ellipsis so it fits within `max_w` points."""
    if not text:
        return ""
    if c.stringWidth(text, font, size) <= max_w:
        return text
    ell = "…"
    out = text
    while out and c.stringWidth(out + ell, font, size) > max_w:
        out = out[:-1]
    return (out + ell) if out else ell


def _draw_tracked(
    c: canvas.Canvas, x: float, y: float, text: str, font: str, size: float,
    tracking: float, color, *, right_edge: float | None = None,
) -> None:
    """Draw letter-spaced text glyph-by-glyph (Canvas has no setCharSpace).

    If `right_edge` is given, the run is right-aligned to it; otherwise it
    starts at `x`. Tracking is added between glyphs (not after the last).
    """
    if not text:
        return
    c.setFont(font, size)
    c.setFillColor(color)
    total = (
        sum(c.stringWidth(ch, font, size) for ch in text)
        + tracking * max(len(text) - 1, 0)
    )
    cur = (right_edge - total) if right_edge is not None else x
    for ch in text:
        c.drawString(cur, y, ch)
        cur += c.stringWidth(ch, font, size) + tracking


# ─── Branding extraction (SAME attribute names invoice_pdf relies on) ────
def _read_profile(profile):
    """Pull the branding fields off a BusinessProfile (or None), using the
    exact attribute names invoice_pdf.py reads (proven to exist).

    Returns a plain dict so the renderer never trips over a missing attr.
    """
    def g(attr):
        return getattr(profile, attr, None) if profile is not None else None

    business_name = (g("company_name") or "").strip()
    cvr = (g("vat_number") or g("org_number") or "")
    cvr = cvr.strip() if isinstance(cvr, str) else ""
    address = (g("address") or "").strip()
    zipcode = (g("zipcode") or "").strip()
    city = (g("city") or "").strip()
    accent_color = _valid_hex(g("accent_color"))
    logo_url = g("logo_url")
    logo_position = g("logo_position")

    # A single compact muted address line: "Nørregade 12 · 1165 København".
    zc = " ".join(p for p in (zipcode, city) if p)
    addr_line = " · ".join(p for p in (address, zc) if p)

    return {
        "business_name": business_name,
        "cvr": cvr,
        "addr_line": addr_line,
        "accent_color": accent_color,
        "logo_url": logo_url,
        "logo_position": logo_position,
    }


def _fetch_logo_bytes(logo_url) -> bytes | None:
    """Fetch the owner's logo bytes via the storage service — the EXACT
    pattern invoice_pdf uses. Any failure degrades to None (draw the monogram).
    """
    if not logo_url:
        return None
    try:
        from app.services.storage import get_storage
        storage = get_storage()
        if hasattr(storage, "get"):
            return storage.get(logo_url)
    except Exception:  # noqa: BLE001
        logger.warning("gavekort_pdf: logo fetch failed for key=%s", logo_url)
    return None


def _qr_png_bytes(data: str, dark: str, light: str) -> bytes | None:
    """Render `data` as a QR PNG (dark modules on a `light` chip). None on any
    failure — the card still prints, just without the QR."""
    try:
        import qrcode
        qr = qrcode.QRCode(
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8, border=2,
        )
        qr.add_data(data or "")
        qr.make(fit=True)
        img = qr.make_image(fill_color=dark, back_color=light).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        logger.warning("gavekort_pdf: QR render failed — skipping")
        return None


def build_gavekort_pdf(
    *,
    card,
    profile,
    template: str = "minimal",
    redeem_url: str | None = None,
    currency: str = "DKK",
) -> bytes:
    """Render a single owner-branded gavekort as PDF bytes.

    Args:
        card:       a GiftCard row (or any object exposing `short_code`,
                    `face_value_minor`, `recipient_name`, `note`, `expires_at`).
        profile:    the owner's BusinessProfile (or None → blank branding).
        template:   "minimal" (light) or "foil" (dark); anything else → minimal.
        redeem_url: the string the QR encodes (the short_code, or a deep link).
        currency:   ISO code for money formatting (default "DKK").

    Returns:
        Finished PDF bytes (starts with b"%PDF"). Never raises over missing
        branding — logo/QR are wrapped and degrade to monogram / no-QR.
    """
    tpl_key = template if template in _TEMPLATES else "minimal"
    T = _TEMPLATES[tpl_key]

    ink = colors.HexColor(T["ink"])
    muted = colors.HexColor(T["muted"])
    paper = colors.HexColor(T["paper"])
    hairline = colors.HexColor(T["hairline"])
    # ONE accent per card. Foil is always gold; minimal honours the owner accent.
    b = _read_profile(profile)
    if tpl_key == "foil":
        accent = colors.HexColor(T["default_accent"])
    else:
        accent = colors.HexColor(b["accent_color"] or T["default_accent"])

    # ── Card geometry (credit-card 1.586 : 1), centred, upper-middle ─────
    page_w, page_h = A4
    card_w = 360.0
    card_h = card_w / 1.586
    card_x = (page_w - card_w) / 2.0
    card_top = 700.0
    card_y = card_top - card_h
    radius = 14.0

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    short_code = str(getattr(card, "short_code", "") or "")
    c.setTitle(f"Gavekort {short_code}".strip())
    c.setAuthor("BonBox")
    c.setSubject("Gavekort")

    # ── Cut guide (faint dashed rectangle) + caption ─────────────────────
    guide = 14.0
    c.saveState()
    c.setStrokeColor(colors.HexColor("#c9c6bf"))
    c.setLineWidth(0.6)
    c.setDash(3, 3)
    c.roundRect(
        card_x - guide, card_y - guide,
        card_w + 2 * guide, card_h + 2 * guide, radius + 4, stroke=1, fill=0,
    )
    c.restoreState()
    c.setFont("Helvetica", 7.5)
    c.setFillColor(colors.HexColor("#9a968d"))
    c.drawCentredString(page_w / 2.0, card_y - guide - 16, "Klip ud langs kanten")

    # ── Card body ────────────────────────────────────────────────────────
    c.setFillColor(paper)
    c.roundRect(card_x, card_y, card_w, card_h, radius, stroke=0, fill=1)
    if T["border"]:
        c.setStrokeColor(hairline)
        c.setLineWidth(0.8)
        c.roundRect(card_x, card_y, card_w, card_h, radius, stroke=1, fill=0)

    # 5px accent bar down the left edge — clipped to the rounded corners.
    if T["accent_bar"]:
        c.saveState()
        clip = c.beginPath()
        clip.roundRect(card_x, card_y, card_w, card_h, radius)
        c.clipPath(clip, stroke=0, fill=0)
        c.setFillColor(accent)
        c.rect(card_x, card_y, 5, card_h, stroke=0, fill=1)
        c.restoreState()

    # Content frame (generous margins).
    pad_x = 26.0
    pad_top = 22.0
    content_left = card_x + pad_x
    content_right = card_x + card_w - pad_x
    content_width = content_right - content_left
    top_y = card_y + card_h - pad_top

    # ── TOP ROW ──────────────────────────────────────────────────────────
    # Left glyph: owner logo (if any) else a rounded-square monogram.
    logo_bytes = _fetch_logo_bytes(b["logo_url"])
    glyph_right = content_left  # x where the name text begins
    if logo_bytes:
        try:
            reader = ImageReader(io.BytesIO(logo_bytes))
            iw, ih = reader.getSize()
            target_h = 26.0
            scale = target_h / ih if ih else 1.0
            target_w = min(iw * scale, 96.0)
            c.drawImage(
                reader, content_left, top_y - target_h,
                width=target_w, height=target_h,
                mask="auto", preserveAspectRatio=True,
            )
            glyph_right = content_left + target_w + 10
        except Exception:  # noqa: BLE001
            logger.warning("gavekort_pdf: logo draw failed — using monogram")
            logo_bytes = None
    if not logo_bytes:
        ms = 30.0
        mono_y = top_y - ms
        if T["monogram_fill"]:
            c.setFillColor(accent)
            c.roundRect(content_left, mono_y, ms, ms, 7, stroke=0, fill=1)
            c.setFillColor(paper)
        else:
            c.setStrokeColor(accent)
            c.setLineWidth(1.2)
            c.roundRect(content_left, mono_y, ms, ms, 7, stroke=1, fill=0)
            c.setFillColor(accent)
        initials = _initials(b["business_name"])
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(content_left + ms / 2.0, mono_y + ms / 2.0 - 4, initials)
        glyph_right = content_left + ms + 10

    # Business name + muted address line (right of the glyph). Leave room for
    # the eyebrow on the right so a long name never collides with it.
    name_max = content_right - glyph_right - 78
    if b["business_name"]:
        c.setFillColor(ink)
        c.setFont("Helvetica-Bold", 12)
        c.drawString(
            glyph_right, top_y - 12,
            _fit(c, b["business_name"], "Helvetica-Bold", 12, name_max),
        )
    if b["addr_line"]:
        c.setFillColor(muted)
        c.setFont("Helvetica", 7.5)
        c.drawString(
            glyph_right, top_y - 24,
            _fit(c, b["addr_line"], "Helvetica", 7.5, name_max),
        )

    # Right eyebrow — "GAVEKORT", letter-spaced, in the accent.
    _draw_tracked(
        c, 0, top_y - 9, "GAVEKORT", "Helvetica-Bold", 8.5, 2.0, accent,
        right_edge=content_right,
    )

    # ── MID — the amount hero ────────────────────────────────────────────
    amount_base = card_y + 120.0
    minor = getattr(card, "face_value_minor", None)
    try:
        amount_value = int(minor) / 100.0 if minor is not None else None
    except (TypeError, ValueError):
        amount_value = None
    # Whole kroner when integral (gift cards almost always are) so the hero
    # reads "500 kr." not "500,00 kr." — and MATCHES the on-screen preview,
    # which formats the same way. money_dk (2 decimals) only for øre amounts.
    if amount_value is not None and currency == "DKK" and float(amount_value).is_integer():
        amount_str = f"{int(amount_value):,d}".replace(",", ".") + " kr."
    else:
        amount_str = money_dk(amount_value, currency)
    parts = amount_str.rsplit(" ", 1)
    number = parts[0]
    unit = parts[1] if len(parts) == 2 else ""

    if T["amount_hairline"]:
        c.setStrokeColor(accent)
        c.setLineWidth(0.8)
        c.line(content_left, amount_base + 34, content_left + 58, amount_base + 34)

    c.setFillColor(ink)
    c.setFont("Helvetica-Bold", 34)
    c.drawString(content_left, amount_base, number)
    if unit:
        num_w = c.stringWidth(number, "Helvetica-Bold", 34)
        c.setFillColor(muted)
        c.setFont("Helvetica", 14)  # ~0.42em of the 34pt hero — a whisper
        c.drawString(content_left + num_w + 4, amount_base, " " + unit)

    # "Til <recipient>" (omitted when the card has no recipient). GiftCard has
    # no sender field, so there is no honest "Fra" to print — don't imply one.
    recipient = (getattr(card, "recipient_name", None) or "").strip()
    parties = []
    if recipient:
        parties.append(f"Til {recipient}")
    line_y = amount_base - 18
    if parties:
        c.setFillColor(muted)
        c.setFont("Helvetica", 9)
        c.drawString(
            content_left, line_y,
            _fit(c, " · ".join(parties), "Helvetica", 9, content_width),
        )
        line_y -= 15

    # Personal note, italic (omit if absent).
    note = (getattr(card, "note", None) or "").strip()
    if note:
        c.setFillColor(muted)
        c.setFont("Helvetica-Oblique", 9)
        c.drawString(
            content_left, line_y,
            _fit(c, note, "Helvetica-Oblique", 9, content_width),
        )

    # ── BOTTOM ROW ───────────────────────────────────────────────────────
    # Right: QR chip (drawn first so we know the code column's right bound).
    chip_s = 56.0
    chip_x = content_right - chip_s
    chip_y = card_y + 14.0
    qr_png = _qr_png_bytes(redeem_url, T["qr_dark"], T["qr_light"]) if redeem_url else None
    if qr_png:
        try:
            c.setFillColor(colors.HexColor(T["chip"]))
            c.roundRect(chip_x, chip_y, chip_s, chip_s, 6, stroke=0, fill=1)
            c.drawImage(
                ImageReader(io.BytesIO(qr_png)),
                chip_x + 3, chip_y + 3, width=chip_s - 6, height=chip_s - 6,
                preserveAspectRatio=True, mask="auto",
            )
        except Exception:  # noqa: BLE001
            logger.warning("gavekort_pdf: QR draw failed — skipping chip")
            qr_png = None
    code_max = (chip_x - 12) - content_left if qr_png else content_width

    # Left column: tiny label → code (monospace) → fine print.
    _draw_tracked(
        c, content_left, card_y + 46, "INDLØS I BUTIK",
        "Helvetica", 6.5, 1.4, muted,
    )
    c.setFillColor(ink)
    c.setFont("Courier-Bold", 12)
    c.drawString(content_left, card_y + 30, short_code)

    # Fine print: "Gyldig til <date> · CVR <cvr>" (each clause conditional).
    fine_bits = []
    exp_str = _fmt_date_dk(getattr(card, "expires_at", None))
    if exp_str:
        fine_bits.append(f"Gyldig til {exp_str}")
    if b["cvr"]:
        fine_bits.append(f"CVR {b['cvr']}")
    if fine_bits:
        c.setFillColor(muted)
        c.setFont("Helvetica", 7)
        c.drawString(
            content_left, card_y + 16,
            _fit(c, " · ".join(fine_bits), "Helvetica", 7, code_max),
        )

    c.showPage()
    c.save()
    return buf.getvalue()
