"""Smart inventory import — multi-layer hardened endpoint.

Mirrors the kasserapport pipeline both architecturally and defensively.
The owner uploads inventory in any of four formats (text paste, CSV,
Excel, photo) and we:
  1. Validate the upload (size + bounds — Layer 2 of multi-barrier)
  2. SHA256 the raw bytes for idempotency dedup
  3. Run the format-appropriate extractor → list of items
  4. Categorize via deterministic rules + AI fallback
  5. Audit-log the entire attempt to inventory_imports
  6. Return the items for review (NOT yet committed to InventoryItem)

A separate /commit endpoint takes the user-reviewed list and creates
real InventoryItem rows; this two-step is critical because:
  • The user gets to see + correct what the AI extracted before it
    becomes their stock-on-hand. Auto-commit would silently corrupt
    inventory if the AI misread.
  • The corrections feed the per-owner few-shot corpus later
    (Phase 5 / learning loop).

Defense layers (parity with /api/inventory/pour + /logs hardening):
  L1 — auth: get_current_user. Anonymous bounces here.
  L2 — input bounds: Pydantic schemas + per-format size caps from
       inventory_extractor (text 200KB, CSV 1MB, Excel 5MB, image 12MB).
  L3 — rate limit: @_limiter.limit("12/minute") per IP. 12 imports/min
       is well above any realistic owner workflow but tight enough to
       slow a script attempting to exhaust our AI spend.
  L4 — tenant scope: every InventoryImport row stamped with user.id.
       The /commit endpoint filters by user.id == imp.user_id.
  L5 — daily quota: PLAN_CAPS["smart_imports_per_day"] enforced from
       inventory_imports row count where created_at >= today.
  L6 — idempotency: source_sha256 dedup. Re-uploading the same bytes
       returns the existing draft instead of re-extracting (free for
       us, instant for the user).
  L7 — audit trail: every attempt logs to inventory_imports —
       extracted_json + final_json + tokens + timing + status —
       satisfies Bogføringsloven §10 retention.

Endpoint contract:
  POST /api/inventory/smart-import       → upload + extract + categorize
                                           returns InventoryImport draft
  POST /api/inventory/smart-import/{id}/commit
                                         → user-reviewed list → real InventoryItem rows
  GET  /api/inventory/smart-import/{id}  → fetch draft for review
"""
import logging
import uuid
from datetime import datetime, time as dtime
from typing import Annotated

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from pydantic import BaseModel, Field, StringConstraints
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import InventoryItem
from app.models.inventory_import import InventoryImport
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import get_cap, has_feature, record_feature_skip
from app.services.inventory_categorizer import (
    CATEGORIZER_PROMPT_VERSION, categorize_items, get_taxonomy,
)
from app.services.inventory_extractor import (
    EXTRACTOR_PROMPT_VERSION, MAX_CSV_BYTES, MAX_EXCEL_BYTES,
    MAX_IMAGE_BYTES, MAX_ITEMS_RETURNED, MAX_TEXT_BYTES,
    extract_csv, extract_excel, extract_image, extract_text, source_sha256,
    validate_size,
)
from app.services.inventory_learning import (
    build_examples_prompt_block, get_examples_for_user,
    promote_corrections, prune_stale_examples,
)
from app.services.inventory_ocr import (
    PROVIDER_TAG as INVENTORY_OCR_PROVIDER,
    enrich_with_supplier as _enrich_supplier,
    extract_inventory_data,
)
from app.services.inventory_perishable import mark_perishable_if_needed
from app.services.storage import compose_key, get_storage
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()

# Per-IP rate limit on the smart-import surface. Lower than /pour (60/min)
# because each call may spend Anthropic tokens — 12/min is plenty for
# real human workflows + caps the worst-case spend if a script tries to
# hammer the endpoint past the daily quota.
_limiter = Limiter(key_func=get_remote_address)


# ─── Schemas ───────────────────────────────────────────────────────────

class TextImportRequest(BaseModel):
    """Body for paste / voice transcript imports."""
    text: Annotated[str, StringConstraints(min_length=1, max_length=200_000)]


class CommitRequest(BaseModel):
    """Body for /commit — the user-reviewed items the owner clicked
    Save on. Bounds defend against payload bombs even after the
    extraction surfaced fewer items: a malicious client could try to
    POST 10,000 items at commit time."""
    items: list["CommitItem"] = Field(default_factory=list, max_length=MAX_ITEMS_RETURNED)


class CommitItem(BaseModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    qty: float | None = Field(None, ge=0, le=1_000_000)
    unit: Annotated[str, StringConstraints(max_length=20)] | None = None
    category: Annotated[str, StringConstraints(max_length=60)] | None = None
    cost_per_unit: float | None = Field(None, ge=0, le=1_000_000)


CommitRequest.model_rebuild()  # because CommitItem is referenced before defined


class ImportDraftResponse(BaseModel):
    """Returned by extract endpoints — the user reviews then calls /commit."""
    id: uuid.UUID
    source_kind: str
    item_count: int
    items: list[dict]
    extraction_confidence: float | None = None
    categorizer: dict
    status: str
    duplicate_of: uuid.UUID | None = None  # set when idempotency dedup hits
    # Supplier-OCR enrichment — populated when the inventory_ocr primary
    # successfully parsed a supplier header. None when the generic
    # extract_image fallback fired (no supplier extraction) OR when the
    # source_kind isn't 'image' (text/CSV/Excel have no header).
    supplier: dict | None = None        # {name, cvr, address, invoice_number, invoice_date}
    supplier_match: dict | None = None  # KNOWN_SUPPLIERS entry incl. 'canonical' — None = unknown
    invoice_totals: dict | None = None  # {subtotal, vat_total, grand_total, currency}
    ocr_provider: str | None = None     # 'claude_inventory' | 'claude_extract_image' | None
    notes: str | None = None            # free-text from the model — ambiguity flags


# ─── Helpers ───────────────────────────────────────────────────────────

def _today_midnight() -> datetime:
    return datetime.combine(utc_now().date(), dtime.min)


def _check_daily_quota(db: Session, user: User) -> None:
    """Layer 5 — daily quota gate. Refuse with 429 if user has hit
    their per-day smart-import cap. -1 = unlimited (Pro/Trial/Business).
    """
    cap = get_cap(user, "smart_imports_per_day")
    if cap < 0:
        return
    today_count = (
        db.query(func.count(InventoryImport.id))
        .filter(
            InventoryImport.user_id == user.id,
            InventoryImport.created_at >= _today_midnight(),
        )
        .scalar()
    ) or 0
    if today_count >= cap:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily smart-import limit reached: {today_count}/{cap}. "
                "Upgrade your plan or wait until tomorrow."
            ),
        )


def _check_idempotency(
    db: Session, user: User, sha: str
) -> InventoryImport | None:
    """Layer 6 — idempotency. If this exact upload already exists for
    this user in the last 24h and is still status='created', return it.
    Avoids re-spending AI tokens on a duplicate upload."""
    return (
        db.query(InventoryImport)
        .filter(
            InventoryImport.user_id == user.id,
            InventoryImport.source_sha256 == sha,
            InventoryImport.created_at >= _today_midnight(),
            InventoryImport.status == "created",
        )
        .order_by(InventoryImport.created_at.desc())
        .first()
    )


def _persist_import(
    db: Session,
    user: User,
    *,
    source_kind: str,
    source_filename: str | None,
    source_size_bytes: int,
    source_sha: str,
    extracted_items: list[dict],
    categorized_items: list[dict],
    extractor_meta: dict,
    categorizer_meta: dict,
    error: str | None = None,
) -> InventoryImport:
    """Persist an InventoryImport row capturing the full pipeline state.

    Status:
      'created' — extracted + categorized, awaiting commit.
      'failed'  — extractor or categorizer errored fatally; row exists
                  for analytics ("how often does Sonnet timeout on
                  Mirabelle's photo size?").
    """
    confidence = extractor_meta.get("confidence")
    timing = {
        "extract": extractor_meta.get("timing_ms", 0),
        "categorize": categorizer_meta.get("timing_ms", 0),
    }

    imp = InventoryImport(
        id=uuid.uuid4(),
        user_id=user.id,
        source_kind=source_kind,
        source_filename=source_filename,
        source_size_bytes=source_size_bytes,
        source_sha256=source_sha,
        storage_key=extractor_meta.get("storage_key") if isinstance(extractor_meta, dict) else None,
        extracted_json=extracted_items,
        categorized_json=categorized_items,
        item_count=len(extracted_items),
        manual_review_needed=True,
        extraction_confidence=confidence,
        input_tokens=(
            (extractor_meta.get("input_tokens", 0) or 0)
            + (categorizer_meta.get("input_tokens", 0) or 0)
        ),
        output_tokens=(
            (extractor_meta.get("output_tokens", 0) or 0)
            + (categorizer_meta.get("output_tokens", 0) or 0)
        ),
        model_used=extractor_meta.get("model_used") or categorizer_meta.get("model_used"),
        timing_ms=timing,
        prompt_version=f"{EXTRACTOR_PROMPT_VERSION};{CATEGORIZER_PROMPT_VERSION}",
        status="failed" if error else "created",
        error=error,
    )
    db.add(imp); db.commit(); db.refresh(imp)
    return imp


def _draft_response(imp: InventoryImport, *, duplicate: bool = False) -> ImportDraftResponse:
    items = imp.categorized_json or imp.extracted_json or []
    return ImportDraftResponse(
        id=imp.id,
        source_kind=imp.source_kind,
        item_count=imp.item_count,
        items=items,
        extraction_confidence=imp.extraction_confidence,
        categorizer={
            "model_used": imp.model_used,
            "input_tokens": imp.input_tokens,
            "output_tokens": imp.output_tokens,
        },
        status=imp.status,
        duplicate_of=imp.id if duplicate else None,
    )


# ─── Endpoints ─────────────────────────────────────────────────────────

@router.post("/text", response_model=ImportDraftResponse, status_code=201)
@_limiter.limit("12/minute")
def import_text(
    request: Request,
    body: TextImportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Smart-import from a pasted text block / voice transcript."""
    _check_daily_quota(db, user)
    raw = body.text.encode("utf-8")
    sha = source_sha256(raw)

    existing = _check_idempotency(db, user, sha)
    if existing:
        return _draft_response(existing, duplicate=True)

    items = extract_text(body.text)
    extractor_meta: dict = {}
    categorized, cat_meta = categorize_items(items, user.business_type)
    imp = _persist_import(
        db, user,
        source_kind="text",
        source_filename=None,
        source_size_bytes=len(raw),
        source_sha=sha,
        extracted_items=items,
        categorized_items=categorized,
        extractor_meta=extractor_meta,
        categorizer_meta=cat_meta,
    )
    return _draft_response(imp)


@router.post("/file", response_model=ImportDraftResponse, status_code=201)
@_limiter.limit("12/minute")
async def import_file(
    request: Request,
    file: UploadFile = File(...),
    source_kind: str = Form(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Smart-import from CSV / Excel / image upload.

    The client picks source_kind so we don't have to guess from the
    filename (which is user-controlled and forgeable). Strict allowlist
    enforced below.
    """
    _check_daily_quota(db, user)

    # Layer 2 — source_kind allowlist. Tighter than the extractor's
    # internal validate_size since we want HTTP-level rejection here.
    allowed_kinds = {"csv", "excel", "image"}
    if source_kind not in allowed_kinds:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid source_kind={source_kind!r}; must be one of {sorted(allowed_kinds)}",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")

    # Per-format size cap (defense-in-depth).
    ok, why = validate_size(raw, source_kind)
    if not ok:
        raise HTTPException(status_code=413, detail=why)

    sha = source_sha256(raw)
    existing = _check_idempotency(db, user, sha)
    if existing:
        return _draft_response(existing, duplicate=True)

    extractor_meta: dict = {}
    error_msg: str | None = None
    items: list[dict] = []
    media_type = (file.content_type or "image/jpeg").lower()

    # Supplier-OCR side channel — populated by the inventory_ocr primary
    # on the image path so we can surface header info to the review UI
    # without persisting columns we don't have yet.
    supplier_block: dict | None = None
    supplier_match_block: dict | None = None
    invoice_totals_block: dict | None = None
    ocr_provider_tag: str | None = None
    ocr_notes: str | None = None

    try:
        if source_kind == "csv":
            items = extract_csv(raw)
        elif source_kind == "excel":
            items = extract_excel(raw)
        elif source_kind == "image":
            # Reject non-image content_types early — defense against a
            # client uploading 12MB of arbitrary bytes claiming "image".
            if not media_type.startswith("image/"):
                raise HTTPException(
                    status_code=400,
                    detail=f"source_kind=image requires image/* content_type, got {media_type!r}",
                )
            # Few-shot enrichment: pull this owner's prior corrections
            # so the AI extracts in their preferred naming/style. NEVER
            # cross-owner — examples are strictly user-scoped.
            owner_examples = get_examples_for_user(
                db, user.id, kind="name_correction", limit=8,
            )
            few_shot = build_examples_prompt_block(owner_examples) or None

            # ── Primary: inventory_ocr (supplier-aware) ─────────────────
            # Pulls structured supplier header + totals + per-line VAT.
            # Returns None on any failure (no API key, network, parse,
            # refusal); the fallback below then runs.
            inv_result = extract_inventory_data(raw)
            if inv_result is not None:
                # L3 — tier gate on the supplier_auto_detection feature.
                # Free tier gets the raw Claude Vision extraction (line
                # items + extracted supplier name / CVR if present) but
                # NOT the supplier-dictionary match and NOT the per-line
                # auto-categorization. Starter+ unlocks both. We pass
                # `user=user` to _enrich_supplier as a defense-in-depth
                # belt-and-braces — the service-layer L4 gate inside
                # enrich_with_supplier re-checks the same flag so a
                # future caller that bypasses this router still can't
                # leak the feature.
                if has_feature(user, "supplier_auto_detection"):
                    inv_result = _enrich_supplier(inv_result, user=user)
                else:
                    # L7 — observability row so Manoj can see how often
                    # the supplier-detection upsell would have fired.
                    # Best-effort; never blocks the user-visible path.
                    try:
                        record_feature_skip(
                            user,
                            "supplier_auto_detection",
                            {
                                "source_kind": "image",
                                "supplier_name": (
                                    (inv_result.get("supplier") or {}).get("name")
                                ),
                                "line_items": len(inv_result.get("line_items") or []),
                            },
                        )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "smart-import: gate_skipped audit write failed (non-fatal)",
                            exc_info=True,
                        )

            if inv_result and inv_result.get("line_items"):
                # Adapt the inventory_ocr shape → the generic items shape
                # the categorizer + commit flow expects. We preserve the
                # supplier-derived category + EAN / VAT extras so the
                # downstream commit can use them.
                items = [
                    {
                        "name": li.get("name"),
                        # Keep qty / unit / cost so commit knows the unit
                        # cost (downstream uses cost_per_unit).
                        **({"qty": li["qty"]} if "qty" in li else {}),
                        **({"unit": li["unit"]} if "unit" in li else {}),
                        **({"cost_per_unit": li["unit_cost"]}
                           if "unit_cost" in li else {}),
                        # Pre-fill category from supplier match — the
                        # generic categorizer below will respect any
                        # already-set category (rule_matched path).
                        **({"category": li["category"]}
                           if li.get("category") and li["category"] != "uncategorized"
                           else {}),
                        # Pass through metadata the UI can render. The
                        # commit endpoint's Pydantic schema ignores
                        # unknown keys so this is back-compat.
                        **({"ean": li["ean"]} if "ean" in li else {}),
                        **({"sku": li["sku"]} if "sku" in li else {}),
                        **({"vat_rate": li["vat_rate"]} if "vat_rate" in li else {}),
                        **({"category_confidence": li["category_confidence"]}
                           if "category_confidence" in li else {}),
                    }
                    for li in inv_result["line_items"]
                    if li.get("name")
                ]
                supplier_block = inv_result.get("supplier")
                supplier_match_block = inv_result.get("supplier_match")
                invoice_totals_block = inv_result.get("invoice_totals")
                ocr_provider_tag = inv_result.get("_provider") or INVENTORY_OCR_PROVIDER
                ocr_notes = inv_result.get("notes")
                overall = (inv_result.get("confidence") or {}).get("overall")
                extractor_meta = {
                    "confidence": overall,
                    "model_used": "claude-sonnet-4-5",  # default; inv_ocr overrides via env
                }
            else:
                # ── Fallback: existing generic extract_image ─────────────
                # Runs when inventory_ocr couldn't extract supplier-shaped
                # data (no API key, refusal, totally illegible). Same
                # behaviour as before — keeps the owner unblocked.
                items, extractor_meta = extract_image(
                    raw, media_type=media_type, few_shot_block=few_shot,
                )
                ocr_provider_tag = "claude_extract_image"
                if extractor_meta.get("error"):
                    error_msg = f"extractor:{extractor_meta['error']}"

            # Persist the upload bytes to durable storage for review
            # screen + audit. Best-effort — a storage failure does NOT
            # block the extraction (owner gets their items regardless).
            try:
                ext = (media_type.split("/")[-1] or "jpg").lower()
                if ext == "jpeg":
                    ext = "jpg"
                if ext not in {"jpg", "png", "webp", "heic"}:
                    ext = "jpg"
                storage_key = compose_key(
                    user.id, "inventory_import", sha, ext,
                )
                get_storage().put(storage_key, raw, content_type=media_type)
                # Capture in extractor_meta so it gets persisted on the
                # InventoryImport row via timing/etc passthrough.
                extractor_meta = {**extractor_meta, "storage_key": storage_key}
            except Exception:  # noqa: BLE001
                logger.exception(
                    "smart-import: failed to persist image to storage (non-fatal)"
                )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("smart-import extractor crash")
        error_msg = f"crash:{type(e).__name__}"

    # Even on partial failure, we audit-log. If items is empty and
    # error is set, the row is status='failed'.
    if items:
        categorized, cat_meta = categorize_items(items, user.business_type)
    else:
        categorized, cat_meta = [], {}

    imp = _persist_import(
        db, user,
        source_kind=source_kind,
        source_filename=(file.filename or "")[:255] or None,
        source_size_bytes=len(raw),
        source_sha=sha,
        extracted_items=items,
        categorized_items=categorized,
        extractor_meta=extractor_meta,
        categorizer_meta=cat_meta,
        error=error_msg,
    )

    if not items and error_msg:
        # Surface the failure mode to the client — but we already logged
        # the row, so the founder can review failed extractions.
        raise HTTPException(
            status_code=502,
            detail=f"Extraction failed: {error_msg}. The attempt has been logged for review.",
        )

    resp = _draft_response(imp)
    # Attach supplier / totals / provider side-channel populated by the
    # inventory_ocr primary path. These are read-only response fields;
    # the commit endpoint still receives the standard items list.
    resp.supplier = supplier_block
    resp.supplier_match = supplier_match_block
    resp.invoice_totals = invoice_totals_block
    resp.ocr_provider = ocr_provider_tag
    resp.notes = ocr_notes
    return resp


@router.get("/{import_id}", response_model=ImportDraftResponse)
def get_draft(
    import_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch a draft for review. Strict tenant scope: only owner's drafts."""
    imp = (
        db.query(InventoryImport)
        .filter(InventoryImport.id == import_id, InventoryImport.user_id == user.id)
        .first()
    )
    if not imp:
        raise HTTPException(status_code=404, detail="Import draft not found")
    return _draft_response(imp)


@router.get("/{import_id}/image")
@_limiter.limit("60/minute")
def get_import_image(
    request: Request,
    import_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return the original uploaded image for review.

    Multi-layer defense (mirrors /api/kasserapport/{id}/image):
      L1 — auth.
      L2 — tenant scope: row.user_id == user.id (filter below).
      L3 — storage path prefix check (compose_key invariant).
      L4 — generic 404 on every miss.
    Only image-kind imports have a stored blob; text/CSV/Excel return 404.
    """
    from fastapi.responses import Response as _Response

    imp = (
        db.query(InventoryImport)
        .filter(InventoryImport.id == import_id, InventoryImport.user_id == user.id)
        .first()
    )
    if not imp or not imp.storage_key:
        raise HTTPException(status_code=404, detail="Image not found")

    if not imp.storage_key.startswith(f"{user.id}/"):
        logger.error(
            "smart-import: storage_key path mismatch for import %s (user %s, key %s)",
            import_id, user.id, imp.storage_key,
        )
        raise HTTPException(status_code=404, detail="Image not found")

    data = get_storage().get(imp.storage_key)
    if not data:
        raise HTTPException(status_code=404, detail="Image not found")

    ext = imp.storage_key.rsplit(".", 1)[-1].lower() if "." in imp.storage_key else "jpg"
    media_type = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp", "heic": "image/heic",
    }.get(ext, "image/jpeg")
    return _Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.post("/{import_id}/commit", status_code=201)
@_limiter.limit("12/minute")
def commit_draft(
    request: Request,
    import_id: uuid.UUID,
    body: CommitRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """User clicked Save → create real InventoryItem rows.

    The body's items list is the user-corrected version. Compare to
    extracted_json to flag user_corrected=True for the learning loop.
    """
    imp = (
        db.query(InventoryImport)
        .filter(InventoryImport.id == import_id, InventoryImport.user_id == user.id)
        .first()
    )
    if not imp:
        raise HTTPException(status_code=404, detail="Import draft not found")
    if imp.status not in ("created",):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot commit draft in status={imp.status!r}",
        )

    # Layer 4/5 — bounds on commit input (already enforced by Pydantic;
    # this is a sanity check on the row count post-validation).
    if len(body.items) > MAX_ITEMS_RETURNED:
        raise HTTPException(status_code=413, detail="Too many items in commit")

    # Layer 7 — audit: snapshot final_json BEFORE creating items so a
    # crash mid-loop still leaves a paper trail.
    final = [it.model_dump() for it in body.items]
    imp.final_json = final
    imp.committed_count = len(body.items)

    extracted_names = {
        (it.get("name") or "").strip().lower()
        for it in (imp.extracted_json or [])
    }
    final_names = {it["name"].strip().lower() for it in final}
    imp.user_corrected = extracted_names != final_names

    try:
        created: list[InventoryItem] = []
        today = utc_now().date()
        perishable_count = 0
        for entry in body.items:
            # Auto-fill is_perishable + expiry_date for known-perishable
            # categories. Single source of truth = inventory_perishable.
            # Owner can edit either field afterward to override defaults.
            is_per, expiry = mark_perishable_if_needed(
                category=entry.category,
                is_perishable=None,
                expiry_date=None,
                received_at=today,
            )
            if is_per:
                perishable_count += 1
            item = InventoryItem(
                id=uuid.uuid4(),
                user_id=user.id,
                name=entry.name,
                quantity=float(entry.qty or 0),
                unit=entry.unit or "pieces",
                cost_per_unit=float(entry.cost_per_unit or 0),
                category=entry.category or "General",
                is_perishable=is_per,
                expiry_date=expiry,
            )
            db.add(item)
            created.append(item)

        imp.status = "committed"
        imp.committed_at = utc_now()
        imp.manual_review_needed = False
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        # Re-mark status; failed commit shouldn't lose the draft.
        imp.status = "created"
        db.commit()
        logger.exception("commit_draft failed")
        raise HTTPException(
            status_code=500,
            detail=f"Commit failed: {type(e).__name__}",
        )

    # Learning loop — promote owner corrections to few-shot examples
    # so the NEXT extraction is more accurate.
    #
    # Super_admin (founder) commits → examples flagged is_global=True so
    # they benefit EVERY owner. This is the canonical training-data path:
    # Manoj uploads Hørkram / BC Catering / Fisketorvet patterns from
    # his admin account, corrects misreads once, and every BonBox owner
    # sees better extractions on the next supplier slip.
    #
    # Regular owner commits → examples are per-user-scoped (default).
    # Privacy is preserved either way: examples carry only the
    # {extracted_name → final_name, category} delta — no sale amounts,
    # no PII.
    #
    # Best-effort: a learning failure must NOT break the user-visible
    # commit (their items already exist).
    examples_promoted = 0
    if imp.user_corrected:
        try:
            is_super_admin = (getattr(user, "role", None) == "super_admin")
            examples_promoted = promote_corrections(
                db,
                user_id=user.id,
                import_id=imp.id,
                extracted=imp.extracted_json or [],
                final=final,
                is_global=is_super_admin,
            )
            prune_stale_examples(db, user.id)
        except Exception:  # noqa: BLE001
            logger.exception("promote_corrections failed (non-fatal)")

    return {
        "import_id": str(imp.id),
        "items_created": len(created),
        "perishable_auto_flagged": perishable_count,
        "user_corrected": imp.user_corrected,
        "examples_learned": examples_promoted,
        "status": imp.status,
    }


# ─── Listing endpoint (for the /imports admin tab) ─────────────────────

@router.get("")
@_limiter.limit("60/minute")
def list_drafts(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List the user's recent imports — for the review-list UI screen."""
    rows = (
        db.query(InventoryImport)
        .filter(InventoryImport.user_id == user.id)
        .order_by(InventoryImport.created_at.desc())
        .limit(50)
        .all()
    )
    return [
        {
            "id": str(r.id),
            "source_kind": r.source_kind,
            "source_filename": r.source_filename,
            "item_count": r.item_count,
            "committed_count": r.committed_count,
            "status": r.status,
            "user_corrected": r.user_corrected,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "committed_at": r.committed_at.isoformat() if r.committed_at else None,
            "error": r.error,
        }
        for r in rows
    ]
