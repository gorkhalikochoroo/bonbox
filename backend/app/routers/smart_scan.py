"""Smart Scan router — `POST /api/smart-scan/classify`.

The owner uploads any document (receipt / Z-report / supplier invoice
PDF) via the new Smart Scan UI. The router:

  L1 — auth: get_current_user. Anonymous bounces.
  L2 — bounds: file size + content-type allowlist.
  L3 — rate limit: per-IP via slowapi.
  L4 — service: smart_scan_service.route_and_extract — fail-soft,
        never raises.
  L5 — tenant: every audit row stamped with user.id; no cross-tenant
        data ever returned (the service is stateless).
  L6 — fail closed: unknown / low-confidence routes to manual picker.
  L7 — audit: every classify call AND every manual override writes
        an audit_logs row.
  L8 — fallback: handled inside the service (Haiku → heuristic →
        manual picker).
  L9 — graceful: HTTP-413 on oversized; 415 on wrong content-type;
        200 with manual_picker route on any other failure.
  L10 — copy: the service returns route + label so the frontend can
        render localized DK-first toasts without re-derivation.

Endpoint contract
=================
POST /api/smart-scan/classify       (multipart/form-data)
  file: UploadFile (required, image/* or application/pdf)
  → 200 {doc_type, confidence, route_to, extracted_data, ...}

POST /api/smart-scan/override       (application/json)
  body: {original_doc_type, chosen_doc_type, file_size_kb}
  → 204 — logs the audit row for "classifier wrong X% of the time"

Note: NO `from __future__ import annotations` — FastAPI's dependency
resolver needs the real UploadFile type (not a ForwardRef) to wire up
multipart bodies. This module-level annotation discipline mirrors
inventory_smart_import.py and the other multipart-receiving routers.
"""
import logging

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import enforce_cap, has_feature
from app.services.smart_scan_service import (
    MAX_IMAGE_BYTES, route_and_extract,
)
from app.services.tz_utils import business_day_window
from app.services.ai_limits import counted_use, vision_slot
from app.services.image_guard import sniff_image_format
from sqlalchemy import func as sa_func

logger = logging.getLogger(__name__)
router = APIRouter()

# Per-IP rate limit on this surface. The classifier is cheap (~$0.0001)
# but each call burns Anthropic tokens — 20/min comfortably covers any
# realistic batch-upload workflow while capping abuse.
_limiter = Limiter(key_func=client_ip)


# ─── Schemas ──────────────────────────────────────────────────────────

class ManualOverrideRequest(BaseModel):
    """Body for the override endpoint. Tells us the classifier got
    something wrong — used to compute "classifier accuracy" trends.
    Bounded so a malicious client can't write huge strings into audit
    rows."""
    original_doc_type: str = Field(..., max_length=20)
    chosen_doc_type: str = Field(..., max_length=20)
    file_size_kb: int = Field(0, ge=0, le=20_000)


# ─── Helpers ──────────────────────────────────────────────────────────

def _client_ip(request: Request) -> str | None:
    """Best-effort client IP — copies the pattern used across the
    codebase (recurring_expenses.py et al)."""
    try:
        return request.client.host if request.client else None
    except Exception:  # noqa: BLE001
        return None


def _today_classify_count(db: Session, user: User) -> int:
    """How many Smart Scan classify calls this user has already triggered
    in their current LOCAL business day (DK 06:00 cutoff).

    Counted via audit_logs `smart_scan.classified` rows — the same audit
    row `_log_classify_audit` writes per call IS the usage counter, so the
    cap can never disagree with the audit trail. Uses
    `business_day_window(user)` (not `date.today()`) so a 02:00 CEST scan
    still belongs to the shift's business date — mirrors the
    z_report_scans_per_day / ai_chat_messages_per_day counters.
    """
    start_utc, end_utc = business_day_window(user)
    return int(
        db.query(sa_func.count(AuditLog.id))
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "smart_scan.classified",
            AuditLog.created_at >= start_utc,
            AuditLog.created_at < end_utc,
        )
        .scalar()
        or 0
    )


# Content-type allowlist. PDF is accepted at the HTTP layer (so the
# upload doesn't 415 for Pro users) but the service treats it as a
# heuristic-only path today — full PDF parsing is the
# smart_scan_pdf_direct feature, gated separately.
_ALLOWED_PREFIXES = ("image/",)
_ALLOWED_EXACT = {"application/pdf"}


def _content_type_ok(ct: str | None) -> bool:
    if not ct:
        # Some mobile uploads omit Content-Type — accept and let the
        # classifier sort it out. The bytes check below is the real gate.
        return True
    ct_lower = ct.lower()
    if ct_lower in _ALLOWED_EXACT:
        return True
    return any(ct_lower.startswith(p) for p in _ALLOWED_PREFIXES)


# ─── Endpoints ────────────────────────────────────────────────────────

@router.post("/classify")
@_limiter.limit("20/minute")
def classify_endpoint(
    request: Request,
    file: UploadFile = File(...),
    batch_size: int = Form(1),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Classify an uploaded document and (when confident) extract
    structured data. Always returns 200 with a usable route — even on
    failure, the response routes to "manual_picker" so the UI never
    soft-locks.

    Batch uploads (batch_size > 1) require the smart_scan_batch
    feature — enforced server-side as defense-in-depth even though the
    frontend gates the UI. We return 403 with a clear plan-upgrade
    payload so the client can render the upsell modal.
    """
    # ── L2 — content-type ────────────────────────────────────────────
    if not _content_type_ok(file.content_type):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported content type {file.content_type!r}; expected image/* or application/pdf",
        )

    # ── L4-bis — batch gate (defense-in-depth) ──────────────────────
    if batch_size > 1 and not has_feature(user, "smart_scan_batch"):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "upgrade_required",
                "feature": "smart_scan_batch",
                "message": "Batch upload requires Starter or Pro.",
            },
        )

    # ── L9 — read bytes; bounded size check ─────────────────────────
    # A plain `def` (OPS-02 / P0-3): FastAPI runs it in the threadpool, so
    # the paid vision calls below never freeze the event loop.
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(raw)} bytes > {MAX_IMAGE_BYTES} cap)",
        )

    # ── PDF direct gate ─────────────────────────────────────────────
    # If the upload is application/pdf and the user doesn't have the
    # smart_scan_pdf_direct feature, we explicitly route to manual
    # picker rather than running the (Pro-only) PDF extractor. The
    # user still gets a working flow — they just don't get the magic.
    is_pdf = (file.content_type or "").lower() == "application/pdf"
    if is_pdf and not has_feature(user, "smart_scan_pdf_direct"):
        result = {
            "doc_type": "unknown",
            "confidence": 0.0,
            "route_to": "manual_picker",
            "route_label": "manual_picker",
            "extracted_data": None,
            "fallback_used": None,
            "file_size_kb": int(len(raw) / 1024),
            "verify_hints": [],
            "reason": "pdf_direct_feature_locked",
            "upgrade_hint": {
                "feature": "smart_scan_pdf_direct",
                "min_plan": "pro",
            },
        }
        _log_classify_audit(db, user, request, result, batch_size)
        return result

    # ── L5 — per-user daily cap (PRIMARY cost control) ──────────────
    # The classifier + extractor are BOTH paid Claude-vision calls on
    # every request. Auth + the 20/min per-IP slowapi cap are only a
    # coarse second barrier — without a per-user daily cap a single Free
    # account could drive unlimited paid OCR through this surface (unlike
    # the dedicated OCR paths, which are already cap-gated). Count this
    # user's classify calls in their local business day and 402 with the
    # canonical upgrade payload once over. Checked AFTER the cheap bounds
    # checks and the PDF-direct early-return (which runs no paid OCR), and
    # BEFORE the paid service call below.
    #
    # The audit row that counts is written AFTER the read, so parallel
    # requests (this route runs in the threadpool) would all pass a plain
    # count. counted_use checks under a per-account lock and counts the
    # reads still in flight; the row's commit hands the reservation back.
    def _check(in_flight: int) -> None:
        used_today = _today_classify_count(db, user) + in_flight
        enforce_cap(user, "smart_scan_classify_per_day", used_today)

    with counted_use(user, "smart_scan_classify_per_day", _check) as use:
        # ── INFRA-03 — only a PDF or an allow-listed image goes on to the
        # classifier. Anything else (a PSD renamed .jpg, a zip) is never
        # decoded or sent to a paid model; the owner lands in the manual
        # picker exactly like any other unreadable upload.
        if not (is_pdf or raw.startswith(b"%PDF-")) and sniff_image_format(raw) is None:
            result = {
                "doc_type": "unknown",
                "confidence": 0.0,
                "route_to": "manual_picker",
                "route_label": "manual_picker",
                "extracted_data": None,
                "fallback_used": None,
                "file_size_kb": int(len(raw) / 1024),
                "verify_hints": [],
                "reason": "unsupported_format",
            }
            with use.recording():
                _log_classify_audit(db, user, request, result, batch_size)
                try:
                    db.commit()
                except Exception as e:  # noqa: BLE001
                    logger.warning("[SmartScan] audit commit failed (non-fatal): %s", e)
                    db.rollback()
            return result

        # ── L4 — service orchestration ──────────────────────────────
        # One vision slot (at most 3 photo reads at once, 2 per account; a
        # further read waits briefly, then 503 "busy, try again" — before
        # the audit row that counts toward the daily cap, so the automatic
        # retry is not double-counted). db=: the pooled connection goes
        # back to the pool while this request waits and reads.
        with vision_slot(user, db=db):
            result = route_and_extract(
                raw,
                filename=file.filename,
                content_type=file.content_type,
                batch_mode=batch_size > 1,
            )

        # ── L7 — audit row per call ─────────────────────────────────
        with use.recording():
            _log_classify_audit(db, user, request, result, batch_size)
            try:
                db.commit()
            except Exception as e:  # noqa: BLE001
                # Don't let an audit-write hiccup take down a user-visible
                # response. audit_service.record itself is already best-effort,
                # but the commit() here is what makes it durable.
                logger.warning("[SmartScan] audit commit failed (non-fatal): %s", e)
                db.rollback()

    return result


@router.post("/override", status_code=204)
@_limiter.limit("30/minute")
def manual_override_endpoint(
    request: Request,
    body: ManualOverrideRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Record that the user picked a different doc type than what the
    classifier suggested. Pure observability — no business-state change.
    Returns 204 No Content."""
    audit_service.record(
        db,
        user=user,
        action="smart_scan.manual_override",
        entity_type="smart_scan",
        entity_id=None,
        after={
            "original_doc_type": body.original_doc_type,
            "chosen_doc_type": body.chosen_doc_type,
            "file_size_kb": body.file_size_kb,
        },
        ip_address=_client_ip(request),
    )
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("[SmartScan override] audit commit failed: %s", e)
        db.rollback()
    return None


# ─── Audit helper (kept small + reusable) ─────────────────────────────

def _log_classify_audit(
    db: Session, user: User, request: Request, result: dict, batch_size: int,
) -> None:
    """Single audit-row write per classify call. Detail block is the
    `detail={doc_type, confidence, route_to, batch_size, file_size_kb}`
    the spec calls for."""
    audit_service.record(
        db,
        user=user,
        action="smart_scan.classified",
        entity_type="smart_scan",
        entity_id=None,
        after={
            "doc_type": result.get("doc_type"),
            "confidence": result.get("confidence"),
            "route_to": result.get("route_to"),
            "batch_size": batch_size,
            "file_size_kb": result.get("file_size_kb"),
            "fallback_used": result.get("fallback_used"),
            "reason": result.get("reason"),
        },
        ip_address=_client_ip(request),
    )
