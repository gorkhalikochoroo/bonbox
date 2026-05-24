"""Smart Scan — auto-router orchestrator.

This is the "snap anything" service that sits on top of the existing
doc-type classifier (claude_vision_ocr.classify_document_type, shipped
in #145) and the three specialized extractors (receipt OCR chain,
Z-report extractor, inventory invoice OCR). The owner takes one photo;
we figure out what it is, run the right extractor, and tell the frontend
which page to navigate to.

Design notes
============

L4 — Service defense — fail SOFT, never raise:
  • Broken upload is worse than degraded UX. Every error path returns a
    valid response with `route_to == "manual_picker"` so the frontend
    can always render *something*.
  • The classifier is the cheap pass (Haiku, ~$0.0001). The expensive
    extractor only runs when the classifier is confident.

L6 — Fail-closed defaults:
  • Unknown classifier output → manual picker (3-button).
  • Missing API key → manual picker (no silent failure / no fake data).
  • Classifier exception → manual picker.
  • Extractor failure → still route to the right page, but with no
    prefill — the frontend handles the "no prefill" case gracefully.

L8 — Multi-source fallback (lives mostly in `route_and_extract`):
  • Primary:   Claude Haiku classifier
  • Fallback 1: heuristic (filename / dimensions / content-type hints)
  • Fallback 2: manual picker

L5 — Data scoping is enforced at the router layer (image path lives
  under `user_id/` in Supabase); this service never persists state, only
  reads bytes + delegates.

Returns a plain dict (NOT a Pydantic model) so the router layer can
augment with audit row IDs etc. before serializing.
"""
from __future__ import annotations

import logging
import os
import tempfile
from typing import Any

logger = logging.getLogger(__name__)


# ─── Module constants ────────────────────────────────────────────────

# Confidence threshold above which we trust the classifier and run the
# extractor. Below this we still navigate to the chosen page but skip
# the (more expensive) extractor call — the frontend shows the bare form.
CONFIDENT_THRESHOLD: float = 0.85

# Per-call image size cap (defense-in-depth — router also enforces).
MAX_IMAGE_BYTES: int = 12_000_000  # 12 MB

# Map classifier output to a frontend route. Single source of truth.
ROUTE_MAP: dict[str, str] = {
    "receipt": "/expenses",
    "z_report": "/daily-close",
    "invoice": "/inventory",
    "unknown": "manual_picker",
}

# Frontend-friendly destination labels (kept in EN here — frontend
# i18n adds DA/NP). The router includes these so the toast can say
# "📸 Receipt detected — opening Expenses in 2 sec".
ROUTE_LABEL: dict[str, str] = {
    "receipt": "Expenses",
    "z_report": "Today / Daily Close",
    "invoice": "Inventory Smart Import",
    "unknown": "manual_picker",
}


# ─── Defensive fallback heuristic (L8 fallback 1) ────────────────────

def _heuristic_classify(
    *, filename: str | None, content_type: str | None, size_bytes: int,
    width: int | None = None, height: int | None = None,
) -> str:
    """Coarse heuristic for when the classifier returned `unknown` or
    failed entirely. Returns one of the standard four values.

    Rules (in order — first match wins):
      • PDF content-type / filename → invoice (suppliers ship PDFs).
      • Very tall narrow image (aspect > 2.5) → z_report (kasserapport
        rolls are typically 80-mm wide × very long).
      • Standard photo aspect → receipt (most common — fail towards
        the most common type, since receipt → /expenses is the path
        owners forgive most easily if wrong).

    Heuristic never returns `unknown` itself — that's reserved for when
    even the safe default doesn't apply (e.g. caller passed no signals).
    """
    name = (filename or "").lower()
    ct = (content_type or "").lower()

    if "pdf" in ct or name.endswith(".pdf"):
        return "invoice"

    if width and height and width > 0:
        aspect = height / width
        if aspect >= 2.5:
            return "z_report"

    # Fall through — assume receipt (the most common type).
    return "receipt"


# ─── Bytes → temp path helper (extractors expect file paths) ─────────

def _bytes_to_tmpfile(image_bytes: bytes, suffix: str = ".jpg") -> str:
    """Write bytes to a NamedTemporaryFile and return the path. Caller
    is responsible for unlinking (we don't use `delete=True` because
    classify_document_type runs sync and we need the path after the
    `with` block would have closed)."""
    f = tempfile.NamedTemporaryFile(prefix="smart_scan_", suffix=suffix, delete=False)
    try:
        f.write(image_bytes)
        f.flush()
    finally:
        f.close()
    return f.name


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


# ─── Confidence — classifier-call returns a string, not a score ──────
#
# `classify_document_type` returns "receipt" | "z_report" | "invoice" |
# "unknown" — it does NOT return a numeric confidence today. We derive
# one from the result:
#   • If the result is a concrete doc type → confidence = 0.92 (above
#     threshold; we trust Haiku for the four-way classification it's
#     been tuned for).
#   • If the result is "unknown" → confidence = 0.0.
#
# This contract lets future improvements (e.g. expose Haiku's logprobs
# or add a second-pass verifier) tighten the number without touching
# any caller code.

def _confidence_for(doc_type: str) -> float:
    if doc_type in ("receipt", "z_report", "invoice"):
        return 0.92
    return 0.0


# ─── Extractor dispatch — runs the right thing per doc type ──────────
#
# Each extractor returns a JSON-friendly dict (or None on failure).
# We catch every exception so a Mindee outage / Claude rate-limit /
# ImportError can NEVER bubble up to the router (L4: never raise).

def _extract_for(doc_type: str, image_bytes: bytes, tmp_path: str) -> dict | None:
    """Dispatch to the right extractor. Returns the structured payload
    or None on any failure. Logs but does not raise."""
    if doc_type == "receipt":
        # Canonical supplier/expense-receipt extractor (Mindee → Claude →
        # Google Vision → OCR.space chain). Earlier draft of this service
        # tried to import a non-existent `parse_receipt_image` and silently
        # fell back to `parse_z_report` — which is the WRONG parser
        # (Z-reports have different shape) and would have leaked Z-report
        # fields into the /expenses prefill. L4: never raise; return None
        # on failure and let the destination page render the bare form.
        try:
            from app.services.receipt_ocr import parse_expense_receipt
            return parse_expense_receipt(tmp_path) or None
        except Exception as e:  # noqa: BLE001
            logger.warning("[SmartScan] receipt extract failed: %s", e)
            return None

    if doc_type == "z_report":
        try:
            from app.services.receipt_ocr import parse_z_report
            return parse_z_report(tmp_path) or None
        except Exception as e:  # noqa: BLE001
            logger.warning("[SmartScan] z_report extract failed: %s", e)
            return None

    if doc_type == "invoice":
        try:
            from app.services.inventory_ocr import extract_inventory_data
            return extract_inventory_data(image_bytes) or None
        except Exception as e:  # noqa: BLE001
            logger.warning("[SmartScan] invoice extract failed: %s", e)
            return None

    return None


# ─── Public surface ──────────────────────────────────────────────────

def classify_only(image_bytes: bytes) -> str:
    """Run JUST the classifier (no extractor). Returns one of
    'receipt' | 'z_report' | 'invoice' | 'unknown'. Never raises."""
    if not image_bytes:
        return "unknown"
    if len(image_bytes) > MAX_IMAGE_BYTES:
        logger.warning(
            "[SmartScan] image %d bytes exceeds cap %d — refusing classify",
            len(image_bytes), MAX_IMAGE_BYTES,
        )
        return "unknown"

    tmp = _bytes_to_tmpfile(image_bytes)
    try:
        from app.services import claude_vision_ocr
        try:
            return claude_vision_ocr.classify_document_type(tmp)
        except Exception as e:  # noqa: BLE001
            logger.warning("[SmartScan] classifier raised, defaulting unknown: %s", e)
            return "unknown"
    finally:
        _unlink_quietly(tmp)


def route_and_extract(
    image_bytes: bytes,
    *,
    filename: str | None = None,
    content_type: str | None = None,
    image_width: int | None = None,
    image_height: int | None = None,
    batch_mode: bool = False,
) -> dict[str, Any]:
    """Single entry point used by the router.

    Returns a dict shaped like::

        {
          "doc_type": "receipt" | "z_report" | "invoice" | "unknown",
          "confidence": 0.0..1.0,
          "route_to": "/expenses" | "/daily-close" | "/inventory" | "manual_picker",
          "route_label": "Expenses" | ...,
          "extracted_data": dict | None,   # None on low confidence / failure
          "fallback_used": str | None,     # "heuristic" | None — observability
          "file_size_kb": int,
          "verify_hints": [str, ...],      # field names with conf < 0.85
        }

    Never raises. Always returns a usable shape — `manual_picker` is the
    catch-all when we can't be sure.
    """
    size_bytes = len(image_bytes or b"")

    # ── L2 — defensive bounds ────────────────────────────────────────
    if not image_bytes:
        return _build_response(
            doc_type="unknown",
            confidence=0.0,
            extracted=None,
            fallback_used=None,
            size_bytes=0,
            reason="empty_upload",
        )
    if size_bytes > MAX_IMAGE_BYTES:
        return _build_response(
            doc_type="unknown",
            confidence=0.0,
            extracted=None,
            fallback_used=None,
            size_bytes=size_bytes,
            reason="too_large",
        )

    # ── L8 — primary classifier (Claude Haiku) ──────────────────────
    tmp_path = _bytes_to_tmpfile(image_bytes)
    try:
        try:
            from app.services import claude_vision_ocr
            doc_type = claude_vision_ocr.classify_document_type(tmp_path)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[SmartScan] classifier raised %s; falling back to heuristic", e,
            )
            doc_type = "unknown"

        fallback_used: str | None = None

        # ── L8 — fallback 1: heuristic when primary unclear ─────────
        if doc_type == "unknown":
            heuristic = _heuristic_classify(
                filename=filename,
                content_type=content_type,
                size_bytes=size_bytes,
                width=image_width,
                height=image_height,
            )
            # The heuristic ALWAYS returns a concrete doc type, but we
            # only use it when the upload has at least one signal worth
            # acting on. Without filename / content-type / dimensions
            # the heuristic is pure guess → we keep "unknown" and let
            # the user pick manually.
            has_signal = bool(
                (filename and "." in filename)
                or content_type
                or (image_width and image_height)
            )
            if has_signal:
                doc_type = heuristic
                fallback_used = "heuristic"

        confidence = _confidence_for(doc_type)

        # ── L6 — fail closed on unknown ─────────────────────────────
        if doc_type == "unknown":
            return _build_response(
                doc_type="unknown",
                confidence=0.0,
                extracted=None,
                fallback_used=fallback_used,
                size_bytes=size_bytes,
                reason="classifier_unknown",
            )

        # ── Extractor (only when above threshold) ───────────────────
        extracted: dict | None = None
        if confidence >= CONFIDENT_THRESHOLD:
            extracted = _extract_for(doc_type, image_bytes, tmp_path)

        return _build_response(
            doc_type=doc_type,
            confidence=confidence,
            extracted=extracted,
            fallback_used=fallback_used,
            size_bytes=size_bytes,
            reason=None,
        )
    finally:
        _unlink_quietly(tmp_path)


# ─── Response shaping ────────────────────────────────────────────────

def _verify_hints_from_extraction(extracted: dict | None) -> list[str]:
    """Pull out the names of fields with confidence below CONFIDENT_THRESHOLD
    so the destination page can highlight them. Defensive — if the
    extractor returned no per-field confidences, returns empty.
    """
    if not extracted or not isinstance(extracted, dict):
        return []
    conf = extracted.get("confidence_per_field") or extracted.get("confidence") or {}
    if not isinstance(conf, dict):
        return []
    hints: list[str] = []
    for field, score in conf.items():
        if field == "overall":
            continue
        try:
            if float(score) < CONFIDENT_THRESHOLD:
                hints.append(str(field))
        except (TypeError, ValueError):
            continue
    return hints


def _build_response(
    *,
    doc_type: str,
    confidence: float,
    extracted: dict | None,
    fallback_used: str | None,
    size_bytes: int,
    reason: str | None,
) -> dict[str, Any]:
    """Compose the dict the router returns to the frontend. Centralized
    so the shape can't drift between code paths."""
    route_to = ROUTE_MAP.get(doc_type, "manual_picker")
    if doc_type == "unknown":
        route_to = "manual_picker"
    return {
        "doc_type": doc_type,
        "confidence": float(round(confidence, 3)),
        "route_to": route_to,
        "route_label": ROUTE_LABEL.get(doc_type, "manual_picker"),
        "extracted_data": extracted,
        "fallback_used": fallback_used,
        "file_size_kb": int(size_bytes / 1024),
        "verify_hints": _verify_hints_from_extraction(extracted),
        "reason": reason,
    }
