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
from app.services.billing import effective_plan, get_cap
from app.services.kasserapport_extractor import (
    extract_kasserapport_full,
    image_sha256,
    validate_image_bytes,
)
from app.services.kasserapport_learning import (
    auto_promote_to_examples,
    fetch_few_shot_examples,
)

logger = logging.getLogger("bonbox.kasserapport_router")

router = APIRouter()
_limiter = Limiter(key_func=get_remote_address)


# Per-tier daily caps live in PLAN_CAPS ("kasse_extracts_per_day") —
# see services/billing.py for the source of truth. Local dict removed
# (May 2026 consolidation). Kasserapport extraction costs ~2-3 øre per
# scan (Sonnet for the heavy extractor); even Pro at 100/day = ~3 kr/day
# in inference cost. Free tier at 5/day is enough for the trial demo.

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
    terminal_id: str | None = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Run the 4-layer kasserapport pipeline on an uploaded image.

    The owner taps "Snap kasserapport" in the daily-close flow, which sends
    the photo here as multipart/form-data. We return the structured fields
    + a `manual_review_needed` flag the UI uses to highlight what to verify.

    Multi-terminal: pass `terminal_id` for venues like Mirabelle that close
    from 4 separate kasserapports per night. Each scan is tagged with its
    terminal so the aggregator can sum cards/payments correctly. Owners
    with a single terminal can omit `terminal_id`.
    """
    # Validate terminal_id (if provided) — defense layer against forged
    # IDs trying to access other users' terminals.
    validated_terminal_id = None
    if terminal_id:
        from app.models.terminal import Terminal
        term = (
            db.query(Terminal)
            .filter(
                Terminal.id == terminal_id,
                Terminal.user_id == user.id,
                Terminal.is_deleted.isnot(True),
            )
            .first()
        )
        if not term:
            raise HTTPException(status_code=404, detail="Terminal not found")
        validated_terminal_id = term.id
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

    # Defense-3: per-tier daily cap (PLAN_CAPS["kasse_extracts_per_day"]).
    plan = effective_plan(user) or "free"
    cap = get_cap(user, "kasse_extracts_per_day")
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

    # Build the few-shot examples fetcher closure. Called by the
    # extractor AFTER Layer 2 detects the POS system, so the fetched
    # examples match the actual detected format. Closes over `db` and
    # `user.id` for tenant scoping.
    def _examples_fetcher(detected_pos: str) -> list:
        try:
            return fetch_few_shot_examples(db, user.id, detected_pos)
        except Exception as e:  # noqa: BLE001
            logger.warning("kasserapport: few-shot fetch failed (non-fatal): %s", e)
            return []

    # Write to a temp file for the extractor (Pillow needs a path)
    tmp = NamedTemporaryFile(delete=False, suffix=Path(file.filename or "").suffix or ".jpg")
    try:
        tmp.write(body)
        tmp.flush()
        tmp.close()

        # Run the pipeline. examples_fetcher is invoked after Layer 2
        # detects the POS system, so this owner's past good extractions
        # of THE SAME format get injected as worked examples.
        result = extract_kasserapport_full(
            tmp.name,
            skip_classifier=skip_classifier,
            examples_fetcher=_examples_fetcher,
        )
    finally:
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass  # best-effort cleanup

    # Persist the receipt photo to durable storage so the owner can
    # re-view it later (Bogføringsloven §10 source-document retention,
    # plus debugging extraction errors). Best-effort — a storage
    # failure must NOT block the extraction response. We log the
    # storage path only after a successful upload so a failed upload
    # doesn't leave a dangling reference in the DB.
    storage_key: str | None = None
    try:
        from app.services.storage import compose_key, get_storage
        # Pick extension from sniffed format if available, else jpg.
        sniffed_ext = (fmt_or_reason or "jpg").lower().split("/")[-1]
        if sniffed_ext == "jpeg":
            sniffed_ext = "jpg"
        if sniffed_ext not in {"jpg", "png", "webp", "heic"}:
            sniffed_ext = "jpg"
        storage_key = compose_key(
            user.id, "kasserapport",
            (result.image_sha256 or img_hash), sniffed_ext,
        )
        get_storage().put(storage_key, body, content_type=file.content_type or "image/jpeg")
    except Exception as e:  # noqa: BLE001
        logger.warning("kasserapport: storage upload failed: %s", e)
        storage_key = None  # don't write a path we couldn't actually upload

    # Always log the attempt — even failures, so the admin review can spot
    # patterns in what's going wrong. Log row carries the audit trail
    # (image_sha256, prompt_version) so post-hoc analysis can correlate
    # prompt revisions with failure modes.
    try:
        log_row = KasserapportExtraction(
            id=uuid.uuid4(),
            user_id=user.id,
            terminal_id=validated_terminal_id,
            image_url=storage_key,                       # storage path (not public URL)
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


@router.get("/{extraction_id}/image")
@_limiter.limit("60/minute")
def get_extraction_image(
    request: Request,
    extraction_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return the original receipt photo for review.

    Multi-layer defense:
      L1 — auth (get_current_user dep).
      L2 — tenant scope: row.user_id MUST equal user.id (enforced via
           the .filter() below).
      L3 — storage path is itself prefixed with the owner's user_id
           (compose_key invariant), so even a misrouted storage call
           can't leak across tenants.
      L4 — generic 404 on any miss so an attacker can't probe whether
           an extraction_id exists or who owns it.
    """
    from fastapi.responses import Response as _Response
    from app.services.storage import get_storage

    row = (
        db.query(KasserapportExtraction)
        .filter(
            KasserapportExtraction.id == extraction_id,
            KasserapportExtraction.user_id == user.id,
        )
        .first()
    )
    if not row or not row.image_url:
        raise HTTPException(status_code=404, detail="Receipt image not found")

    # Belt-and-braces: storage key must start with this user's id.
    # Defends against any future code path that writes a wrong key.
    if not row.image_url.startswith(f"{user.id}/"):
        logger.error(
            "kasserapport: image_url path mismatch for extraction %s (user %s, key %s)",
            extraction_id, user.id, row.image_url,
        )
        raise HTTPException(status_code=404, detail="Receipt image not found")

    data = get_storage().get(row.image_url)
    if not data:
        raise HTTPException(status_code=404, detail="Receipt image not found")

    # Pick MIME from extension on the storage path.
    ext = row.image_url.rsplit(".", 1)[-1].lower() if "." in row.image_url else "jpg"
    media_type = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp", "heic": "image/heic",
    }.get(ext, "image/jpeg")
    return _Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )


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

    # Auto-promote to examples library if the extraction was clean.
    # This is the back-half of the learning loop: high-confidence
    # uncorrected extractions become few-shot examples for the same
    # owner's NEXT scan. Wrapped in try so a learning-loop failure
    # NEVER affects the commit response.
    promoted_id: str | None = None
    try:
        promoted = auto_promote_to_examples(db, row.id)
        promoted_id = str(promoted.id) if promoted else None
    except Exception as e:  # noqa: BLE001
        logger.warning("commit: auto-promote failed (non-fatal): %s", e)

    return {
        "extraction_id": str(row.id),
        "user_corrected": row.user_corrected,
        "committed_at": row.committed_at.isoformat() if row.committed_at else None,
        "promoted_to_example_id": promoted_id,
    }


# ────────────────────────────────────────────────────────────────────────
# Multi-terminal aggregation — the Mirabelle-format consolidated close
# ────────────────────────────────────────────────────────────────────────

@router.post("/aggregate")
def aggregate(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Consolidate multiple per-terminal kasserapport extractions into
    one daily close payload.

    Body shape:
      {
        "extraction_ids": ["uuid1", "uuid2", ...],
        "manual": {
          "cash_closing": 18799,
          "mobilepay_total": 0,
          "gift_cards_total": 0,
          "sales_pos": 100292.54,
          "closed_by": "Caro",
          "money_to_bank": 0,
          "paid_out": 0,
          "paid_in": 0,
          "cash_opening": 0
        },
        "threshold": 100  // optional, default 100 kr
      }

    Returns the AggregatedClose payload + the Excel-mirror rows so the
    UI can render the Mirabelle-format review screen directly without
    further computation.

    Defense:
      • Each extraction_id verified to belong to this user (no cross-
        tenant leak via forged IDs)
      • Aggregator is pure-Python; no LLM cost
    """
    from app.services.kasserapport_aggregator import (
        DEFAULT_CASH_DIFF_THRESHOLD,
        aggregate_terminals,
        to_excel_rows,
    )
    from app.models.terminal import Terminal

    extraction_ids = body.get("extraction_ids") or []
    if not isinstance(extraction_ids, list):
        raise HTTPException(status_code=400, detail="extraction_ids must be a list")

    manual = body.get("manual") or {}
    threshold = body.get("threshold")
    try:
        threshold_f = float(threshold) if threshold is not None else DEFAULT_CASH_DIFF_THRESHOLD
    except (TypeError, ValueError):
        threshold_f = DEFAULT_CASH_DIFF_THRESHOLD

    # Fetch every requested extraction with strict tenant scoping.
    rows = (
        db.query(KasserapportExtraction)
        .filter(
            KasserapportExtraction.id.in_(extraction_ids),
            KasserapportExtraction.user_id == user.id,
        )
        .all()
    )
    found_ids = {str(r.id) for r in rows}
    missing = [eid for eid in extraction_ids if str(eid) not in found_ids]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Extractions not found or not yours: {missing}",
        )

    # Build the per-terminal extraction dicts the aggregator expects
    extractions = []
    terminal_ids = []
    for r in rows:
        data = dict(r.extracted_json or {})
        data["terminal_id"] = str(r.terminal_id) if r.terminal_id else None
        data["extraction_confidence"] = (
            float(r.extraction_confidence) if r.extraction_confidence is not None else None
        )
        data["_extraction_id"] = str(r.id)
        extractions.append(data)
        if r.terminal_id:
            terminal_ids.append(r.terminal_id)

    # Pull terminal names for human-readable rows
    terminals_meta = []
    if terminal_ids:
        terms = (
            db.query(Terminal)
            .filter(Terminal.id.in_(terminal_ids), Terminal.user_id == user.id)
            .all()
        )
        terminals_meta = [{"id": str(t.id), "name": t.name} for t in terms]

    close = aggregate_terminals(
        extractions,
        terminals_meta=terminals_meta,
        manual=manual,
        threshold=threshold_f,
    )

    return {
        "aggregated": {
            "cash_closing": close.cash_closing,
            "money_to_bank": close.money_to_bank,
            "paid_out": close.paid_out,
            "paid_in": close.paid_in,
            "cash_opening": close.cash_opening,
            "cash_total": close.cash_total,
            "gift_cards_total": close.gift_cards_total,
            "mobilepay_total": close.mobilepay_total,
            "cards_total": close.cards_total,
            "payments_total": close.payments_total,
            "sales_pos": close.sales_pos,
            "cash_difference": close.cash_difference,
            "cash_diff_flagged": close.cash_diff_flagged,
            "flagged_reason": close.flagged_reason,
            "closed_by": close.closed_by,
            "terminals": [
                {
                    "terminal_id": t.terminal_id,
                    "terminal_name": t.terminal_name,
                    "dankort": t.dankort,
                    "teller": t.teller,
                    "amex": t.amex,
                    "total": t.total,
                    "extraction_id": t.extraction_id,
                    "extraction_confidence": t.extraction_confidence,
                }
                for t in close.terminals
            ],
        },
        "excel_rows": to_excel_rows(close),
        "threshold_used": threshold_f,
    }


# ────────────────────────────────────────────────────────────────────────
# PDF rendering — Mirabelle-format clean attachment
# ────────────────────────────────────────────────────────────────────────

@router.post("/close-pdf")
def close_pdf(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Render the aggregated multi-terminal close as a PDF.

    Body shape: same as /aggregate output (the frontend already has it
    in memory after the close completes), so we don't re-aggregate
    server-side. Caller passes:
      {
        "aggregated":  { ...AggregatedClose dict... },
        "date_label":  "9.3.2026 (Mandag)",   # display string
        "currency":    "DKK"                   # optional, defaults DKK
      }

    Returns PDF as application/pdf with a sensible filename. ~50KB
    typical, fits on a single A4 portrait page even with 6 terminals.

    Defense:
      • Auth gate (per-user — no public PDF surface)
      • Pure render — no DB writes, no LLM, no external network
      • render_close_pdf() never raises; falls back to a minimal
        error PDF so caller's UX flow continues
    """
    from fastapi.responses import Response
    from app.services.kasserapport_pdf import render_close_pdf

    aggregated = body.get("aggregated") or {}
    if not isinstance(aggregated, dict):
        raise HTTPException(status_code=400, detail="aggregated must be an object")

    date_label = (body.get("date_label") or "").strip()
    currency = (body.get("currency") or user.currency or "DKK").strip()
    business_name = (user.business_name or "").strip()
    bilagsnummer = (body.get("bilagsnummer") or "").strip() or None

    # Pull the user's BusinessProfile so the PDF header can include CVR
    # + full Danish address — required for any close that goes to a
    # revisor or has to satisfy Bogføringsloven §10. Optional: if the
    # owner hasn't filled in their profile yet, the PDF still renders
    # with just the business_name.
    from app.models.business_profile import BusinessProfile
    bp_row = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    business_profile_dict: dict = {}
    if bp_row is not None:
        business_profile_dict = {
            "company_name": bp_row.company_name or "",
            "org_number": bp_row.org_number or "",
            "vat_number": bp_row.vat_number or "",
            "country": bp_row.country or "DK",
            "address": bp_row.address or "",
            "city": bp_row.city or "",
            "zipcode": bp_row.zipcode or "",
        }
        # Prefer the formal company_name from BusinessProfile over
        # the user-set display business_name (typically more complete:
        # "Restaurant Mirabelle ApS" vs just "Mirabelle").
        if bp_row.company_name and not business_name:
            business_name = bp_row.company_name

    pdf_bytes = render_close_pdf(
        aggregated=aggregated,
        business_name=business_name,
        date_label=date_label,
        currency=currency,
        business_profile=business_profile_dict,
        bilagsnummer=bilagsnummer,
    )

    # Filename: lukning_<businessSlug>_<isoDate>.pdf — predictable, no
    # special chars (closer's email client / WhatsApp don't choke).
    iso_date = (date_label.split(" ")[0] if date_label else "today").replace(".", "-")
    biz_slug = "".join(c if c.isalnum() else "_" for c in (business_name or "bonbox").lower())[:32]
    filename = f"lukning_{biz_slug}_{iso_date}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )


# ────────────────────────────────────────────────────────────────────────
# Excel rendering — Mirabelle-format .xlsx alongside the PDF
# ────────────────────────────────────────────────────────────────────────

@router.post("/close-excel")
def close_excel(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Render the aggregated multi-terminal close as an .xlsx workbook.

    Same body shape as /close-pdf — frontend already has aggregated in
    memory, so no re-aggregate. Caller passes:
      {
        "aggregated":    { ...AggregatedClose dict... },
        "date_label":    "9.3.2026 (Mandag)",
        "currency":      "DKK",          # optional
        "bilagsnummer":  "B-2026-0042"   # optional
      }

    Returns .xlsx (~10KB) with the same Mirabelle layout as the PDF, but
    cells are real numbers (number_format applied) so the customer can
    SUM, pivot, paste into their weekly workbook, etc.

    Why this matters:
      • Mirabelle's old workflow = weekly Excel built from daily photos
        emailed to Caro. Owner replaces that flow without learning anything.
      • Investor / revisor exports prefer .xlsx over PDF for spreadsheet
        downstream work (per Manoj's interview with his old boss).

    Defense:
      • Auth gate (per-user — no public Excel surface)
      • Pure render — no DB writes, no LLM, no external network
      • render_close_xlsx() never raises; falls back to a minimal error
        workbook so the caller's UX flow continues
    """
    from fastapi.responses import Response
    from app.services.kasserapport_excel import render_close_xlsx

    aggregated = body.get("aggregated") or {}
    if not isinstance(aggregated, dict):
        raise HTTPException(status_code=400, detail="aggregated must be an object")

    date_label = (body.get("date_label") or "").strip()
    currency = (body.get("currency") or user.currency or "DKK").strip()
    business_name = (user.business_name or "").strip()
    bilagsnummer = (body.get("bilagsnummer") or "").strip() or None

    # Pull BusinessProfile for the workbook header (CVR, address) — same
    # rule as the PDF endpoint. Optional: if absent, the workbook still
    # renders with just the business_name.
    from app.models.business_profile import BusinessProfile
    bp_row = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    business_profile_dict: dict = {}
    if bp_row is not None:
        business_profile_dict = {
            "company_name": bp_row.company_name or "",
            "org_number": bp_row.org_number or "",
            "vat_number": bp_row.vat_number or "",
            "country": bp_row.country or "DK",
            "address": bp_row.address or "",
            "city": bp_row.city or "",
            "zipcode": bp_row.zipcode or "",
        }
        if bp_row.company_name and not business_name:
            business_name = bp_row.company_name

    xlsx_bytes = render_close_xlsx(
        aggregated=aggregated,
        business_name=business_name,
        date_label=date_label,
        currency=currency,
        business_profile=business_profile_dict,
        bilagsnummer=bilagsnummer,
    )

    # Filename: lukning_<businessSlug>_<isoDate>.xlsx — same scheme as PDF.
    iso_date = (date_label.split(" ")[0] if date_label else "today").replace(".", "-")
    biz_slug = "".join(c if c.isalnum() else "_" for c in (business_name or "bonbox").lower())[:32]
    filename = f"lukning_{biz_slug}_{iso_date}.xlsx"

    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(xlsx_bytes)),
        },
    )
