"""Document hashing + software identification helpers.

Used by every BonBox-generated audit artifact (kasserapport PDF, faktura
PDF, MOMS-angivelse PDF, bookkeeping export ZIP). The hash is rendered
in the document footer AND persisted to an audit_logs row whenever the
artifact is generated. If a downloaded PDF/CSV is modified after the
fact, the footer hash won't match the byte content — the revisor can
re-hash the file and compare to the stored audit row to spot tampering.

Why SHA-256:
  • Universally available in stdlib (no extra dep)
  • Strong collision resistance (2^128 work)
  • Footprint friendly — 8-char short hash in the visible footer plus
    full hash in the audit log row

Software identifier:
  • SKAT requires bookkeeping software to identify itself on every
    artifact ("Bogføringssystem: <navn> <version>"). Read from the
    BONBOX_VERSION env var with a hard-coded fallback so the field is
    never empty.
"""
from __future__ import annotations

import hashlib
import os


# Hard-coded fallback. Production sets BONBOX_VERSION at deploy time so
# we can correlate a downloaded PDF with the exact release that produced
# it. Local dev defaults to the tag below.
_DEFAULT_VERSION = "1.0.0"


def compute_document_hash(content_bytes: bytes) -> str:
    """SHA-256 of the document content as a lowercase hex string.

    Pass the FINAL byte representation of the artifact:
      • PDF  → the rendered PDF bytes (after doc.build)
      • CSV  → the encoded UTF-8 bytes (after BOM)
      • ZIP  → the .zip bytes (after closing the archive)

    The same input always produces the same output, so the hash is a
    deterministic fingerprint we can store in audit_logs and display
    in the footer.
    """
    if content_bytes is None:
        return hashlib.sha256(b"").hexdigest()
    return hashlib.sha256(content_bytes).hexdigest()


def short_hash(content_bytes: bytes, length: int = 16) -> str:
    """First `length` characters of the SHA-256 hex — what the footer
    renders so it fits visually. The audit log row keeps the full hash.

    16 chars (64 bits) is overwhelmingly collision-resistant for the
    population of audit artifacts we generate (one tenant produces a few
    hundred PDFs per year — collision probability is essentially zero).
    """
    return compute_document_hash(content_bytes)[:length]


def get_software_identifier() -> str:
    """The identifier rendered in audit footers: 'BonBox vX.Y.Z'.

    SKAT 'Krav til standardsystemer' guidance §3.2 — a bookkeeping
    artifact must identify the producing software by name + version so
    an auditor can trace back to a known code release. We emit this
    on every PDF/CSV/ZIP footer.
    """
    version = os.environ.get("BONBOX_VERSION", _DEFAULT_VERSION).strip() or _DEFAULT_VERSION
    return f"BonBox v{version}"


def get_software_version() -> str:
    """Just the version string, e.g. '1.0.0'. Used when callers need
    to log the version separately from the brand name."""
    return os.environ.get("BONBOX_VERSION", _DEFAULT_VERSION).strip() or _DEFAULT_VERSION


# ─── Reportlab "Page X of Y" canvas ──────────────────────────────────
#
# The canonical reportlab idiom for accurate "Page X of Y" footers:
# capture each page's state during build, then in `save()` know the
# total and render the footer per page. Avoids the 2-pass-build trap
# (which mutates flowables and breaks layout when re-used).


def make_numbered_canvas(draw_footer):
    """Return a reportlab Canvas subclass that draws an audit footer
    on every page with the correct "Page X of Y" count.

    Args:
      draw_footer: a callable invoked as draw_footer(canvas, page_num,
        total_pages). Caller controls what the footer says — page
        number / generation timestamp / hash / software id / etc.

    Returned class is passed as `canvasmaker=` to doc.build().
    """
    from reportlab.pdfgen import canvas as _canvas

    class _NumberedCanvas(_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_states: list[dict] = []

        def showPage(self):
            self._saved_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_states)
            for state in self._saved_states:
                self.__dict__.update(state)
                draw_footer(self, self._pageNumber, total)
                super().showPage()
            super().save()

    return _NumberedCanvas
