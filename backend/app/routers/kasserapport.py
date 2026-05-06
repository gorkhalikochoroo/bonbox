"""Kasserapport extraction endpoint — owner uploads photo, gets back
structured JSON the frontend can confirm + commit in 3-4 taps.

Defense layers (per the multi-barrier doctrine):

  1. Auth gate — get_current_user, no public surface
  2. SlowAPI rate limit — 30 req / hour per IP (one busy night = ~5)
  3. Per-tier daily cap — Free 5, Trial 100, Pro 100, Business 500
  4. Image size cap — 12 MB max (phone HEIC up to ~5 MB usually)
  5. Image content-type whitelist
  6. The 4-layer pipeline itself fails-closed at every stage
  7. Every extraction logged to kasserapport_extractions table for the
     weekly admin review loop
"""
import logging
import uuid
from datetime import date, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.kasserapport import KasserapportExtraction
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import effective_plan
from app.services.kasserapport_extractor import (
    extract_kasserapport_full,
    image_sha256,
    validate_image_bytes,
)

logger = logging.getLogger("bonbox.kasserapport_router")

router = APIRouter()
_limiter = Limiter(key_func=get_remote_address)


# Per-tier daily caps. Kasserapport extraction costs ~2-3 øre per scan
# (Sonnet for the heavy extractor); even Pro at 100/day = ~3 kr/day in
# inference cost. Free tier at 5/day is enough for the trial demo.
_KASSE_CAP_BY_PLAN = {
    "free": 5,
    "trial": 100,
    "pro": 100,
    "business": 500,
}

# Allowed image MIME types — Capacitor camera + browser file picker both
# produce one of these. We re-encode to JPEG before sending to Anthropic
# anyway, but reject obvious non-images at the ingest boundary.
_ALLOWED_MIME = {
    "image/jpeg", "image/jpg", "image/png", "image/heic",
    "image/heif", "image/webp", "image/bmp",
}

_MAX_BYTES = 12 * 1024 * 1024  # 12 MB


def _today_count(db: Session, user_id) -> int:
    """How many extractions has this user run today? Used for tier cap."""
    today = date.today()
    return (
        db.query(sa_func.count(KasserapportExtraction.id))
        .filter(
            KasserapportExtraction.user_id == user_id,
            sa_func.date(KasserapportExtraction.created_at) == today,
        )
        .scalar()
        or 0
    )


@router.post("/extract")
@_limiter.limit("30/hour")
async def extract(
    request: Request,
    file: UploadFile = File(...),
    skip_classifier: bool = Form(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Run the 4-layer kasserapport pipeline on an uploaded image.

    The owner taps "Snap kasserapport" in the daily-close flow, which sends
    the photo here as multipart/form-data. We return the structured fields
    + a `manual_review_needed` flag the UI uses to highlight what to verify.
    """
    # Defense-1: content-type whitelist
    if (file.content_type or "").lower() not in _ALLOWED_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type!r}. Use JPEG, PNG, HEIC, or WebP.",
        )

    # Defense-2: size cap (read body in chunks to avoid loading 50MB into RAM)
    body = await file.read(_MAX_BYTES + 1)
    if len(body) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 12 MB)")

    # Defense-2b: magic-byte sniff (router-level second wall before the
    # service even sees the bytes). The service does the same check —
    # double-checking is cheap and means a forged Content-Type can't get
    # past the perimeter.
    ok, fmt_or_reason = validate_image_bytes(body)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail=f"Image content doesn't match a known format: {fmt_or_reason}",
        )

    # Defense-3: per-tier daily cap
    plan = effective_plan(user) or "free"
    cap = _KASSE_CAP_BY_PLAN.get(plan, 5)
    used = _today_count(db, user.id)
    if used >= cap:
        raise HTTPException(
            status_code=429,
            detail=f"Daily kasserapport scan limit reached ({used}/{cap}). Upgrade or try again tomorrow.",
        )

    # Defense-4: idempotency. Compute image hash; if this exact image has
    # been scanned by this user in the last 30 minutes, return the cached
    # extraction instead of charging the LLM again. Stops double-tap and
    # accidental retry from doubling cost.
    img_hash = image_sha256(body)
    from datetime import timedelta as _td
    recent_cutoff = datetime.utcnow() - _td(minutes=30)
    cached = (
        db.query(KasserapportExtraction)
        .filter(
            KasserapportExtraction.user_id == user.id,
            KasserapportExtraction.image_sha256 == img_hash,
            KasserapportExtraction.created_at >= recent_cutoff,
            KasserapportExtraction.error.is_(None),
        )
        .order_by(KasserapportExtraction.created_at.desc())
        .first()
    )
    if cached is not None:
        return {
            "extraction_id": str(cached.id),
            "document_type": cached.document_type,
            "pos_system": cached.pos_system,
            "confidences": {
                "classifier": float(cached.classifier_confidence) if cached.classifier_confidence is not None else None,
                "format": float(cached.format_confidence) if cached.format_confidence is not None else None,
                "extraction": float(cached.extraction_confidence) if cached.extraction_confidence is not None else None,
            },
            "data": cached.extracted_json,
            "validator_failures": cached.validator_failures,
            "manual_review_needed": cached.manual_review_needed,
            "error": cached.error,
            "timing_ms": cached.timing_ms,
            "tokens_used": {"input": cached.input_tokens, "output": cached.output_tokens},
            "models_used": {},
            "usage": {"used_today": used, "daily_cap": cap, "plan": plan},
            "cached": True,
            "image_sha256": cached.image_sha256,
            "prompt_version": cached.prompt_version,
        }

    # Write to a temp file for the extractor (Pillow needs a path)
    tmp = NamedTemporaryFile(delete=False, suffix=Path(file.filename or "").suffix or ".jpg")
    try:
        tmp.write(body)
        tmp.flush()
        tmp.close()

        # Run the pipeline
        result = extract_kasserapport_full(tmp.name, skip_classifier=skip_classifier)
    finally:
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass  # best-effort cleanup

    # Always log the attempt — even failures, so the admin review can spot
    # patterns in what's going wrong. Log row carries the audit trail
    # (image_sha256, prompt_version) so post-hoc analysis can correlate
    # prompt revisions with failure modes.
    try:
        log_row = KasserapportExtraction(
            id=uuid.uuid4(),
            user_id=user.id,
            document_type=result.document_type,
            pos_system=result.pos_system,
            classifier_confidence=result.classifier_confidence,
            format_confidence=result.format_confidence,
            extraction_confidence=result.extraction_confidence,
            extracted_json=result.data or None,
            validator_failures=result.validator_failures or None,
            manual_review_needed=result.manual_review_needed,
            input_tokens=result.tokens_used.get("input"),
            output_tokens=result.tokens_used.get("output"),
            timing_ms=result.timing_ms or None,
            error=result.error,
            image_sha256=result.image_sha256 or img_hash,
            prompt_version=result.prompt_version,
        )
        db.add(log_row)
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("kasserapport: extraction logging failed: %s", e)
        db.rollback()
        log_row = None

    return {
        "extraction_id": str(log_row.id) if log_row else None,
        "document_type": result.document_type,
        "pos_system": result.pos_system,
        "confidences": {
            "classifier": result.classifier_confidence,
            "format": result.format_confidence,
            "extraction": result.extraction_confidence,
        },
        "data": result.data,
        "validator_failures": result.validator_failures,
        "manual_review_needed": result.manual_review_needed,
        "error": result.error,
        "timing_ms": result.timing_ms,
        "tokens_used": result.tokens_used,
        "models_used": result.models_used,
        "usage": {"used_today": used + 1, "daily_cap": cap, "plan": plan},
        "cached": False,
        "image_sha256": result.image_sha256,
        "prompt_version": result.prompt_version,
    }


@router.post("/{extraction_id}/commit")
def commit_corrections(
    extraction_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner reviewed the extracted JSON, made any edits, and tapped commit.
    We persist the final JSON + flag whether they corrected anything so the
    admin training review can spot patterns. Body shape: {"final_json": {...}}.
    """
    final_json = body.get("final_json")
    if not isinstance(final_json, dict):
        raise HTTPException(status_code=400, detail="final_json must be an object")

    row = (
        db.query(KasserapportExtraction)
        .filter(
            KasserapportExtraction.id == extraction_id,
            KasserapportExtraction.user_id == user.id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Extraction not found")

    # Did the owner change anything? Compare top-level keys; for our use
    # case any diff = "corrected" is enough signal for the training loop.
    extracted = row.extracted_json or {}
    row.user_corrected = (extracted != final_json)
    row.final_json = final_json
    row.committed_at = datetime.utcnow()
    db.commit()

    return {
        "extraction_id": str(row.id),
        "user_corrected": row.user_corrected,
        "committed_at": row.committed_at.isoformat() if row.committed_at else None,
    }
