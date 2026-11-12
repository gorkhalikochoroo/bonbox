"""
Egenkontrol R1b — files: the owner's documents and the photos on readings.

STORAGE. BonBox's private EU bucket (services/storage.py), kinds
"food_check_document" and "food_check_photo" — in ALLOWED_KINDS **and**
ERASURE_PURGE_KINDS (a kind in only one list would be kept ~6 years after an
erasure as if it were an accounting record). Keys are content-addressed
("<owner>/<kind>/<sha256 of the STORED bytes>.<ext>"), so two rows can share
one blob and a delete removes the blob only when no other row still uses it.

NEVER a signed or public URL: every byte goes through the tenant-re-checked
proxy routes (owner and kitchen). Documents are served as an ATTACHMENT with
nosniff; photos inline as image/jpeg with nosniff.

PIPELINES (validate everything BEFORE reading or decoding the file):
  • photo — at most 8 MB read; app.services.chat_image.sanitize_chat_photo:
    magic bytes (JPEG/PNG only), decompression-bomb ceilings, one of the
    process-wide decode slots, Pillow re-encode to JPEG ≤ 1600 px with
    EXIF/GPS/XMP stripped. The SANITIZED bytes are stored.
  • document — at most 10 MB read; sniffed from the bytes, never the file
    name or the client's Content-Type: "%PDF-" is stored as-is; JPEG/PNG go
    through the photo sanitizer (EXIF/GPS stripped); anything else is
    refused. The title is the owner's own words: refused when too long,
    never cut (staff_documents.inspect_upload truncates — not used here).

NO CONTENT IN LOGS: never a title, a key, a value or bytes.
"""

import hashlib
import logging
import re
import unicodedata
import uuid
from datetime import timedelta
from typing import Optional
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import Response
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.food_check import FoodCheck, FoodCheckDocument, FoodCheckEntry, FoodCheckPhoto
from app.services import audit_service
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S
from app.services.storage import StorageError, compose_key, get_storage

logger = logging.getLogger(__name__)

PHOTO_KIND = "food_check_photo"
DOCUMENT_KIND = "food_check_document"
DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
_PDF_MAGIC = b"%PDF-"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"


def _code(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _storage_unavailable() -> HTTPException:
    return _code(503, "storage_unavailable")


def _read(upload, limit: int) -> bytes:
    """At most limit + 1 bytes — enough to tell "too big" without reading a
    huge body into memory."""
    f = getattr(upload, "file", None)
    if f is None:
        return b""
    data = f.read(limit + 1)
    return data or b""


def _lang(owner) -> str:
    try:
        from app.services.owner_language import owner_lang
        return owner_lang(owner) or "da"
    except Exception:  # noqa: BLE001
        return "da"


def _release(db: Session) -> None:
    """Hand the pooled connection back before a decode-slot wait."""
    try:
        from app.services.ai_limits import release_db_connection
        release_db_connection(db)
    except Exception:  # noqa: BLE001 — only a pool courtesy
        pass


def _sanitize_image(raw: bytes, owner, *, too_large: str, unreadable: str,
                    unreadable_status: int = 422) -> bytes:
    """chat_image.sanitize_chat_photo with its errors mapped to our codes.
    AIBusyError (every decode slot busy) propagates: main.py answers it 503
    ai_busy with Retry-After."""
    from app.services.chat_image import sanitize_chat_photo
    try:
        data, _ct, _sha = sanitize_chat_photo(raw, lang=_lang(owner))
    except HTTPException as e:
        if e.status_code == 413:
            raise _code(413, too_large)
        if e.status_code >= 500:
            raise
        raise _code(unreadable_status, unreadable)
    return data


def _put(owner, kind: str, data: bytes, content_type: str, ext: str) -> str:
    sha = hashlib.sha256(data).hexdigest()
    key = compose_key(owner.id, kind, sha, ext=ext)
    try:
        get_storage().put(key, data, content_type)
    except (StorageError, OSError) as e:
        logger.warning("egenkontrol %s upload failed: %s", kind, type(e).__name__)
        raise _storage_unavailable()
    return key


def _get(key: str) -> bytes:
    try:
        data = get_storage().get(key)
    except (StorageError, OSError) as e:
        logger.warning("egenkontrol blob read failed: %s", type(e).__name__)
        raise _storage_unavailable()
    if data is None:
        raise S.not_found()
    return data


def _delete_blob_if_unused(db: Session, model, key: Optional[str], *, strict: bool) -> None:
    """Delete `key` only when no row of `model` still points at it. strict:
    a storage error propagates as 503 (the caller has not committed);
    otherwise it is logged and the erasure prefix purge is the backstop."""
    if not key:
        return
    still = db.query(model.id).filter(model.storage_key == key).first()
    if still is not None:
        return
    try:
        get_storage().delete(key)
    except Exception as e:  # noqa: BLE001
        logger.warning("egenkontrol blob delete failed: %s", type(e).__name__)
        if strict:
            raise _storage_unavailable()


# ── Documents ────────────────────────────────────────────────────────────

def load_documents(db: Session, owner, *, branch_scope=None) -> list:
    q = db.query(FoodCheckDocument).filter(FoodCheckDocument.user_id == owner.id)
    if branch_scope is not None:
        q = q.filter(or_(FoodCheckDocument.branch_id.is_(None),
                         FoodCheckDocument.branch_id == branch_scope))
    return q.order_by(FoodCheckDocument.uploaded_at).all()


def document_out(d: FoodCheckDocument, tz, today_local) -> dict:
    """DocumentOut. "Uploadet <dato> · gennemgås igen senest <dato>" — and
    NO state that means current/valid: BonBox stores the document, it never
    reads or approves it."""
    base = d.reviewed_at or d.uploaded_at
    due, state = R.document_review(R.to_local(base, tz).date(), today_local)
    return {
        "id": str(d.id),
        "doc_type": d.doc_type,
        "title": d.title,
        "content_type": d.content_type,
        "size_bytes": int(d.size_bytes or 0),
        "uploaded_at": S.iso_z(d.uploaded_at),
        "uploaded_local_date": R.to_local(d.uploaded_at, tz).date().isoformat(),
        "reviewed_at": S.iso_z(d.reviewed_at),
        "reviewed_local_date": (R.to_local(d.reviewed_at, tz).date().isoformat()
                                if d.reviewed_at is not None else None),
        "review_due": due.isoformat(),
        "review_state": state,
        "branch_id": S._sid(d.branch_id),
    }


def _today_local(db: Session, owner):
    tz, _, _ = S.zone_and_cutoff(db, owner)
    return tz, R.to_local(S.now_utc(), tz).date()


def list_documents(db: Session, owner) -> dict:
    tz, today = _today_local(db, owner)
    return {
        "documents": [document_out(d, tz, today) for d in load_documents(db, owner)],
        "max": R.DOCUMENTS_MAX,
    }


def inspect_document(raw: bytes, owner) -> tuple[bytes, str, str]:
    """→ (bytes to store, content_type, ext). Sniffs the BYTES only."""
    if not raw:
        raise _code(422, "empty")
    if len(raw) > DOCUMENT_MAX_BYTES:
        raise _code(413, "too_large")
    if raw.startswith(_PDF_MAGIC):
        return raw, "application/pdf", "pdf"
    if raw.startswith(_PNG_MAGIC) or raw.startswith(_JPEG_MAGIC):
        data = _sanitize_image(raw, owner, too_large="too_large", unreadable="unsupported_type")
        return data, "image/jpeg", "jpg"
    # Never echo what it looked like.
    raise _code(422, "unsupported_type")


def add_document(db: Session, owner, upload, *, title, doc_type, actor_user_id) -> dict:
    if title is None or not isinstance(title, str) or not title.strip():
        raise S.rule_http(R.RuleError("title_required"))
    if len(title) > R.DOCUMENT_TITLE_MAX:
        raise S.rule_http(R.RuleError("title_too_long", {"max_length": R.DOCUMENT_TITLE_MAX}))
    if doc_type not in R.DOC_TYPES:
        raise S.rule_http(R.RuleError("doc_type_unknown"))
    count = db.query(FoodCheckDocument.id).filter(FoodCheckDocument.user_id == owner.id).count()
    if count >= R.DOCUMENTS_MAX:
        raise S.conflict("too_many_documents", max=R.DOCUMENTS_MAX)
    raw = _read(upload, DOCUMENT_MAX_BYTES)
    if raw and not raw.startswith(_PDF_MAGIC):
        _release(db)
    data, content_type, ext = inspect_document(raw, owner)
    key = _put(owner, DOCUMENT_KIND, data, content_type, ext)
    now = S.now_utc()
    doc = FoodCheckDocument(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=None,
        doc_type=doc_type,
        title=title,                       # verbatim
        storage_key=key,
        content_type=content_type,
        size_bytes=len(data),
        uploaded_at=now,
        uploaded_by_user_id=actor_user_id,
        created_at=now,
    )
    db.add(doc)
    db.flush()
    # Never the title: it is the owner's free text (a hygiejnebevis often
    # carries an employee's name) and audit_logs outlive the delete and the
    # account erasure.
    audit_service.record(db, owner, "egenkontrol.document_added", "food_check_document", doc.id,
                         after={"doc_type": doc_type, "content_type": content_type,
                                "size_bytes": len(data)},
                         actor_id=actor_user_id)
    db.commit()
    db.refresh(doc)
    tz, today = _today_local(db, owner)
    return document_out(doc, tz, today)


def _owned_document(db: Session, owner, doc_id) -> FoodCheckDocument:
    d = (
        db.query(FoodCheckDocument)
        .filter(FoodCheckDocument.id == doc_id, FoodCheckDocument.user_id == owner.id)
        .first()
    )
    if d is None:
        raise S.not_found()
    return d


def mark_document_reviewed(db: Session, owner, doc_id, *, actor_user_id) -> dict:
    d = _owned_document(db, owner, doc_id)
    d.reviewed_at = S.now_utc()
    d.reviewed_by_user_id = actor_user_id
    db.flush()
    audit_service.record(db, owner, "egenkontrol.document_reviewed", "food_check_document", d.id,
                         after={"doc_type": d.doc_type}, actor_id=actor_user_id)
    db.commit()
    db.refresh(d)
    tz, today = _today_local(db, owner)
    return document_out(d, tz, today)


def delete_document(db: Session, owner, doc_id, *, actor_user_id) -> dict:
    d = _owned_document(db, owner, doc_id)
    key, doc_type = d.storage_key, d.doc_type
    db.delete(d)
    db.flush()
    audit_service.record(db, owner, "egenkontrol.document_removed", "food_check_document",
                         uuid.UUID(str(doc_id)), after={"doc_type": doc_type},
                         actor_id=actor_user_id)       # never the title (see add_document)
    db.commit()
    # After the commit: a storage failure never blocks the delete (the
    # erasure prefix purge is the backstop).
    _delete_blob_if_unused(db, FoodCheckDocument, key, strict=False)
    return {"ok": True}


_UNSAFE_NAME = re.compile(r'[/\\:*?"<>|\x00-\x1f\x7f]')
_TRANSLIT = str.maketrans({"æ": "ae", "Æ": "Ae", "ø": "oe", "Ø": "Oe", "å": "aa", "Å": "Aa"})


def safe_filename(title: Optional[str], ext: str) -> tuple[str, str]:
    """(ascii fallback, utf-8 name) for Content-Disposition: the title with
    /\\:*?"<>| and control characters removed, at most 80 characters,
    "dokument" when nothing is left."""
    base = _UNSAFE_NAME.sub("", title or "").strip()[:80].strip() or "dokument"
    ascii_name = unicodedata.normalize("NFKD", base.translate(_TRANSLIT))
    ascii_name = ascii_name.encode("ascii", "ignore").decode("ascii").strip() or "dokument"
    return f"{ascii_name}.{ext}", f"{base}.{ext}"


def _ext_for(content_type: str) -> str:
    return "pdf" if content_type == "application/pdf" else "jpg"


def document_response(d: FoodCheckDocument) -> Response:
    data = _get(d.storage_key)
    ascii_name, utf8_name = safe_filename(d.title, _ext_for(d.content_type))
    return Response(
        content=data,
        media_type=d.content_type,
        headers={
            "Content-Disposition":
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(utf8_name)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


def serve_document(db: Session, owner, doc_id, *, kitchen_link=None) -> Response:
    d = _owned_document(db, owner, doc_id)
    if kitchen_link is not None and kitchen_link.branch_id is not None:
        if d.branch_id is not None and str(d.branch_id) != str(kitchen_link.branch_id):
            raise S.not_found()
    return document_response(d)


# ── Photos ───────────────────────────────────────────────────────────────

def attach_photo(db: Session, owner, entry_id, upload, *, via: str, kitchen_link=None,
                 actor_user_id=None) -> dict:
    """One optional photo on a reading: a deviation (in_limit False) or a
    goods delivery, within 24 h of the reading, one per reading."""
    now = S.now_utc()
    e = (
        db.query(FoodCheckEntry)
        .filter(FoodCheckEntry.id == entry_id, FoodCheckEntry.user_id == owner.id)
        .first()
    )
    if e is None:
        raise S.not_found()
    if kitchen_link is not None:
        # Only a reading THIS iPad saved, inside its branch.
        if str(e.kitchen_link_id or "") != str(kitchen_link.id):
            raise S.not_found()
        if (kitchen_link.branch_id is not None and e.branch_id is not None
                and str(e.branch_id) != str(kitchen_link.branch_id)):
            raise S.not_found()
    if e.voided_at is not None:
        raise S.conflict("already_voided")
    check = db.query(FoodCheck).filter(FoodCheck.id == e.check_id).first()
    kind = check.kind if check is not None else None
    if not (e.in_limit is False or kind == "receiving"):
        raise S.rule_http(R.RuleError("photo_not_allowed"))
    if now > e.recorded_at + R.PHOTO_ATTACH_WINDOW:
        raise S.conflict("photo_window_passed")
    if db.query(FoodCheckPhoto.id).filter(FoodCheckPhoto.entry_id == e.id).first() is not None:
        raise S.conflict("photo_exists")

    from app.services.chat_image import MAX_CHAT_PHOTO_BYTES
    raw = _read(upload, MAX_CHAT_PHOTO_BYTES)
    if not raw:
        raise _code(422, "photo_unreadable")
    if len(raw) > MAX_CHAT_PHOTO_BYTES:
        raise _code(413, "photo_too_large")
    _release(db)
    data = _sanitize_image(raw, owner, too_large="photo_too_large", unreadable="photo_unreadable")
    key = _put(owner, PHOTO_KIND, data, "image/jpeg", "jpg")
    photo = FoodCheckPhoto(
        id=uuid.uuid4(),
        user_id=owner.id,
        entry_id=e.id,
        storage_key=key,
        content_type="image/jpeg",
        size_bytes=len(data),
        via=via,
        kitchen_link_id=kitchen_link.id if kitchen_link is not None else None,
        actor_user_id=actor_user_id,
        uploaded_at=now,
        created_at=now,
    )
    db.add(photo)
    db.flush()
    audit_service.record(db, owner, "egenkontrol.photo_added", "food_check_entry", e.id,
                         actor_id=actor_user_id,
                         actor_type="kitchen_device" if kitchen_link is not None else "user")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise S.conflict("photo_exists")
    db.refresh(photo)
    tz, _, _ = S.zone_and_cutoff(db, owner)
    return S.photo_out(photo, tz)


def _owned_photo(db: Session, owner, photo_id) -> FoodCheckPhoto:
    p = (
        db.query(FoodCheckPhoto)
        .filter(FoodCheckPhoto.id == photo_id, FoodCheckPhoto.user_id == owner.id)
        .first()
    )
    if p is None:
        raise S.not_found()
    return p


def serve_photo(db: Session, owner, photo_id, *, kitchen_link=None) -> Response:
    p = _owned_photo(db, owner, photo_id)
    if kitchen_link is not None:
        e = db.query(FoodCheckEntry).filter(FoodCheckEntry.id == p.entry_id).first()
        if e is None:
            raise S.not_found()
        if (kitchen_link.branch_id is not None and e.branch_id is not None
                and str(e.branch_id) != str(kitchen_link.branch_id)):
            raise S.not_found()
        tz, cutoff, _ = S.zone_and_cutoff(db, owner)
        today = R.business_date_of(S.now_utc(), tz, cutoff)
        if e.business_date < today - timedelta(days=R.KITCHEN_FOLDER_DAYS - 1):
            raise S.not_found()
    if p.removed_at is not None or not p.storage_key:
        raise _code(410, "photo_removed")
    data = _get(p.storage_key)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        },
    )


def remove_photo(db: Session, owner, photo_id, *, actor_user_id) -> dict:
    """Tombstone: the blob goes at once (before the commit — a storage error
    is a 503 and nothing changes), the row stays so the Kontrolmappe and the
    PDF can say "Foto fjernet af ejeren <dato>"."""
    p = _owned_photo(db, owner, photo_id)
    if p.removed_at is not None:
        raise S.conflict("already_removed")
    key = p.storage_key
    p.removed_at = S.now_utc()
    p.removed_by_user_id = actor_user_id
    p.storage_key = None
    db.flush()
    try:
        _delete_blob_if_unused(db, FoodCheckPhoto, key, strict=True)
    except HTTPException:
        db.rollback()
        raise
    audit_service.record(db, owner, "egenkontrol.photo_removed", "food_check_entry", p.entry_id,
                         actor_id=actor_user_id)
    db.commit()
    db.refresh(p)
    tz, _, _ = S.zone_and_cutoff(db, owner)
    return S.photo_out(p, tz)
