"""
Employment documents the owner shares with one staff member.

The blob path is deliberately narrow. Images already have a sanitiser
(`chat_image.sanitize_profile_photo`) that re-encodes and strips EXIF; PDFs have
no equivalent and cannot be meaningfully re-encoded here, so the defence is
containment rather than cleaning:

  • MAGIC BYTES, not the filename or the client's Content-Type. A browser will
    happily send "contract.pdf" with any bytes inside; only the header tells the
    truth. An HTML file renamed .pdf is the attack this blocks.
  • ONE TYPE PER EXTENSION. The stored extension is derived from the sniffed
    type, never from what the client sent, so the download endpoint can set a
    Content-Type it actually verified.
  • SERVED AS AN ATTACHMENT with nosniff, never inline. A PDF rendered inline on
    the same origin can run script; as a download it cannot.
  • SIZE CAP before anything else — an employment contract is not 40 MB, and
    reading an unbounded upload into memory is its own problem.

Everything here is about what we will ACCEPT. Who may read it is the routers'
job (owner-only on one side, PIN-gated token on the other).
"""

from __future__ import annotations

import hashlib

# An employment contract is a few pages. Anything larger is a mistake or abuse.
MAX_BYTES = 10 * 1024 * 1024  # 10 MB

# Sniffed type → (canonical content-type, stored extension). The extension is
# what compose_key stores, so it must stay inside storage's ext allow-list.
_SIGNATURES = (
    (b"%PDF-", "application/pdf", "pdf"),
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
)


class DocumentRejected(ValueError):
    """Upload refused. `code` is stable and translatable; the message is a
    developer aid and must not be shown to a user verbatim."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def inspect_upload(raw: bytes, label: str | None) -> tuple[str, str, str, str]:
    """Validate an uploaded document.

    Returns (content_type, ext, sha256_hex, clean_label).
    Raises DocumentRejected with a stable code.
    """
    if not raw:
        raise DocumentRejected("empty", "Empty file.")
    if len(raw) > MAX_BYTES:
        raise DocumentRejected("too_large", f"File must be under {MAX_BYTES // (1024 * 1024)} MB.")

    content_type = ext = None
    for magic, ctype, e in _SIGNATURES:
        if raw.startswith(magic):
            content_type, ext = ctype, e
            break
    if content_type is None:
        # Deliberately does not name the sniffed type back to the caller —
        # that only helps someone probing what gets through.
        raise DocumentRejected("unsupported_type", "Only PDF, JPEG and PNG files are accepted.")

    clean = (label or "").strip()
    if not clean:
        raise DocumentRejected("label_missing", "Give the document a name.")
    if len(clean) > 120:
        clean = clean[:120]

    return content_type, ext, hashlib.sha256(raw).hexdigest(), clean
