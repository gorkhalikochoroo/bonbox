"""bonbox_pdf_kit — shared accounting-grade export primitives.

Single source of truth so every BonBox export (PDF / CSV / XLSX) speaks the
same accounting language as the gold reference `build_moms_filing_pdf`
(services/tax_filing_pdf.py). Everything here is built to MATCH that reference
EXACTLY — `money_dk` mirrors `tax_filing_pdf._money_dk`, `PALETTE` mirrors its
tokens — so routing other builders through this kit produces an *identical*
look, never a near-miss.

Scope (slice 2 — the foundation): the standalone, unit-testable pieces every
builder needs:
  • money_dk(value, currency)        — the ONE Danish money formatter
  • PALETTE                          — Copenhagen-clean colour tokens (hex)
  • export_bilagsnummer(prefix, …)   — generalized voucher number
  • write_export_audit_row(…)        — the L7 §10 egress audit row

The reportlab story-builders (masthead, signature_block, retention_notice,
audit_footer_factory, render_with_doc_hash) are added as individual builders
are rerouted through the kit, so each can be byte-equivalence verified against
a real consumer rather than written in isolation.

NOTE: this module is intentionally reportlab-free so CSV/XLSX exporters can
import money_dk / write_export_audit_row without pulling in reportlab. PDF
builders convert PALETTE hex strings via colors.HexColor() themselves.
"""
import logging
import math
from datetime import date
from typing import Any

from app.services import audit_service

log = logging.getLogger(__name__)

# ── Palette ───────────────────────────────────────────────────────────────
# Exact tokens from the gold (tax_filing_pdf.py) + property_report_pdf.py.
# Stored as hex strings (not reportlab colors) so this module stays
# reportlab-free; PDF builders wrap with colors.HexColor(PALETTE["INK"]).
PALETTE = {
    "INK": "#171717",      # primary text
    "MUTED": "#6b7280",    # secondary / labels / refund-or-zero net
    "DIVIDER": "#e5e7eb",  # 0.5pt hairline rules
    "OK": "#15803d",       # emerald — money owed / positive net
    "REFUND": "#6b7280",   # stone — refund / zero net
    "ACCENT": "#4338ca",   # indigo accent
}


def money_dk(value: Any, currency: str = "DKK") -> str:
    """Canonical money formatter — the ONE every export must use.

    DKK → Danish convention `1.234,56 kr.` (period thousands, comma decimal,
    space + "kr."). Non-DKK → ISO-like `1,234.56 EUR`. None / non-numeric → "—".

    Mirrors tax_filing_pdf._money_dk EXACTLY (verified by parity test): snaps
    sub-half-øre dust (incl. negative zero) to 0 so a rounding artifact like
    -0.001 renders "0,00 kr." and never "-0,00 kr.", and carries when the
    fractional part rounds to 100.
    """
    if value is None:
        return "—"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    # Degenerate floats (NaN / ±inf) are never real money — render "—" rather
    # than crash on int(). (The gold raises here; the canonical formatter must
    # not. Parity with the gold holds for every finite value.)
    if not math.isfinite(n):
        return "—"

    # Snap sub-half-øre dust (including negative zero) to exactly 0.
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
    whole_str = f"{whole:,}"
    return f"{sign}{whole_str}.{fractional:02d} {currency}"


def export_bilagsnummer(prefix: str, period_start: date, period_end: date) -> str:
    """Stable per-document voucher number: '{PREFIX}-YYYYMMDD-YYYYMMDD'.

    Generalizes tax_filing_pdf.make_bilagsnummer (which hardcodes 'MA-').
    Conventional prefixes: MA (MOMS-angivelse), KR (kasserapport),
    DR (dagsrapport), LON (lønseddel), FAK (faktura), KN (kreditnota).
    """
    return f"{prefix}-{period_start.strftime('%Y%m%d')}-{period_end.strftime('%Y%m%d')}"


# Distinct action so these rows are NEVER miscounted against the MOMS-PDF
# monthly cap counter (_count_moms_pdf_exports_this_month, which keys on its
# own MOMS-specific action). doc_type lives in entity_type + the `after` blob.
EXPORT_AUDIT_ACTION = "export.artifact_generated"


def write_export_audit_row(
    db,
    user,
    *,
    doc_type: str,
    bilagsnummer: str = "",
    doc_hash: str = "",
    period: dict | None = None,
    ip_address: str | None = None,
) -> None:
    """Write the L7 audit_logs row on revisor-bound artifact generation —
    the Bogføringsloven §10 trail on financial-data egress.

    Fail-soft: an audit-log failure must NEVER block the artifact (the owner
    has a legitimate right to their own data; audit is a side channel). Mirrors
    the reports.py:1020 / tax.py pattern.
    """
    try:
        audit_service.record(
            db,
            user=user,
            action=EXPORT_AUDIT_ACTION,
            entity_type=doc_type,
            entity_id=None,
            before=None,
            after={
                "doc_type": doc_type,
                "bilagsnummer": bilagsnummer or None,
                "doc_hash": doc_hash or None,
                **(period or {}),
            },
            ip_address=ip_address,
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("export audit row failed for doc_type=%s: %s", doc_type, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ── Accountant-grade provenance footer (2-pass render) ──────────────────────
def render_with_doc_hash(
    story_builder,
    *,
    pagesize,
    margins_mm: float = 22,
    left_mm: float | None = None,
    right_mm: float | None = None,
    top_mm: float | None = None,
    bottom_mm: float | None = None,
    title: str = "",
    author: str = "BonBox",
    subject: str = "",
    software_id: str = "",
    generated_at_str: str = "",
    generator_email: str = "",
    is_danish: bool = True,
) -> bytes:
    """Render a reportlab story with the accountant-grade provenance footer —
    the SINGLE reusable 2-pass renderer that kills the copy-paste hazard.

    The footer, drawn on EVERY page (mirrors the gold `tax_filing_pdf.py`):
      • Left:   `Doc-hash: <16 hex chars>`
      • Center: `Genereret <ts> af <email>  ·  BonBox v…`  (DA) / `Generated … by …`
      • Right:  `Side X / Y`  (DA) / `Page X / Y`
    Font Helvetica 6.8, colour #94a3b8, at y = 10mm.

    Why 2-pass / why `story_builder` must return FRESH flowables:
      The doc-hash is the SHA-256 of the *rendered* bytes, so it can only be
      computed AFTER a first render. We therefore render twice:
        • Pass 1 — hash placeholder is "pending"; capture the bytes; hash them.
        • Pass 2 — re-render with the real hash visible in the footer; return.
      ReportLab MUTATES flowables in place during `build()` (sets layout
      state, `_postponed`, splitter cursors, …), so the pass-1 flowables are
      unusable for pass 2. `story_builder` MUST be a zero-arg callable that
      returns a BRAND-NEW list of flowables each time — we call it once per
      pass to get clean objects. (This is exactly the trap the gold avoids by
      hand with `_rebuild_filing_story`; routing through here means callers
      never re-implement it.)

    `pagesize[0]` is used for the page width so the footer positions correctly
    for BOTH portrait (A4) and landscape (landscape(A4)) documents.

    Margins: `margins_mm` is the symmetric default (back-compat). Pass any of
    `left_mm` / `right_mm` / `top_mm` / `bottom_mm` to override a single side;
    each falls back to `margins_mm` when None. This lets a caller with wide
    content (e.g. the 270mm landscape range tables) use a tighter, asymmetric
    frame so the tables fit and stay centred. The footer is drawn at the
    resolved CONTENT edges (left margin / page_width − right margin), so the
    `Doc-hash:` / `Side X / Y` anchors always line up with the body. The
    effective bottom margin is clamped to at least 18mm so the y=10mm footer
    never overlaps body content regardless of what the caller passes.

    reportlab is imported LAZILY inside this function so the module stays
    reportlab-free for the CSV/XLSX importers (see module docstring); the
    document_hash helpers are imported here too since they pull reportlab via
    make_numbered_canvas.
    """
    from io import BytesIO

    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    from app.utils.document_hash import make_numbered_canvas, short_hash

    page_width = pagesize[0]

    # Resolve per-side margins: each explicit override falls back to margins_mm
    # (symmetric back-compat). Convert mm → points for reportlab.
    left_margin = (left_mm if left_mm is not None else margins_mm) * mm
    right_margin = (right_mm if right_mm is not None else margins_mm) * mm
    top_margin = (top_mm if top_mm is not None else margins_mm) * mm
    bottom_margin = (bottom_mm if bottom_mm is not None else margins_mm) * mm
    # Footer sits at y=10mm — clamp ONLY the bottom so body content never
    # overlaps it, regardless of what the caller passes. Top/left/right are
    # used verbatim so callers control content alignment exactly.
    bottom_margin = max(bottom_margin, 18 * mm)

    # Hash is unknown until pass 1 renders; the footer closure reads it live so
    # pass 2 picks up the real value once we've patched the holder.
    doc_hash_holder = {"value": "pending"}

    def _draw_audit_footer(canv, page_num, total_pages):
        from reportlab.lib import colors as _c

        canv.saveState()
        canv.setFont("Helvetica", 6.8)
        canv.setFillColor(_c.HexColor("#94a3b8"))
        # Right edge of content = page_width − right margin (NOT a hardcoded
        # 22mm), so "Side X / Y" lines up with the table's right edge.
        canv.drawRightString(
            page_width - right_margin, 10 * mm,
            ("Side " if is_danish else "Page ") + f"{page_num} / {total_pages}",
        )
        # "af <email>" / "by <email>" is only meaningful when we actually have
        # a generator email. When it's blank/None, drop the "af"/"by" + email so
        # the footer reads "Genereret <ts>  ·  BonBox vX" instead of a dangling
        # "Genereret <ts> af   ·  BonBox vX". Populated-email output is unchanged.
        gen_prefix = "Genereret" if is_danish else "Generated"
        by_word = "af" if is_danish else "by"
        gen_email = (generator_email or "").strip()
        if gen_email:
            provenance = f"{gen_prefix} {generated_at_str} {by_word} {gen_email}  ·  {software_id}"
        else:
            provenance = f"{gen_prefix} {generated_at_str}  ·  {software_id}"
        canv.drawCentredString(
            page_width / 2, 10 * mm,
            provenance,
        )
        # Left edge of content = left margin, so "Doc-hash:" lines up with the
        # table's left edge.
        canv.drawString(
            left_margin, 10 * mm,
            f"Doc-hash: {doc_hash_holder['value']}",
        )
        canv.restoreState()

    canvas_maker = make_numbered_canvas(_draw_audit_footer)

    def _new_doc(target_buf):
        return SimpleDocTemplate(
            target_buf, pagesize=pagesize,
            topMargin=top_margin, bottomMargin=bottom_margin,
            leftMargin=left_margin, rightMargin=right_margin,
            title=title, author=author,
            creator=software_id or author, subject=subject,
        )

    # Pass 1 — placeholder hash; fresh flowables from the builder.
    buf1 = BytesIO()
    _new_doc(buf1).build(story_builder(), canvasmaker=canvas_maker)
    doc_hash_holder["value"] = short_hash(buf1.getvalue(), length=16)

    # Pass 2 — real hash; fresh doc + fresh flowables (reportlab mutated pass 1).
    buf2 = BytesIO()
    _new_doc(buf2).build(story_builder(), canvasmaker=canvas_maker)
    return buf2.getvalue()
