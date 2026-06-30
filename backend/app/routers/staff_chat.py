"""
Owner ↔ staff 1:1 chat ("Beskeder").

Two routers share the same tables but live behind two different auth gates:

  • staff_router  → mounted at /api/portal, token-auth (the capability token in
    the magic link IS the scope). NO id params: a staffer can only ever reach
    their own thread, so there is nothing to tamper.
  • owner_router  → mounted at /api/staff, session-auth (get_current_user). The
    owner picks a staffer by id; every query re-checks StaffMember.user_id ==
    owner.id so a forged id can't read another tenant's thread.

Security posture (folded in from the adversarial review):
  • sender_type is SERVER-set from the auth path, never trusted from the body.
  • user_id is denormalized on every row and every query filters by it.
  • Thread is UNIQUE(user_id, staff_id) → duplicate/cross-tenant thread is
    structurally impossible; the race loser catches IntegrityError + re-SELECTs.
  • Per-thread DB-counter send cap (not just per-IP) blocks a leaked-token or
    malicious-staffer flood from bloating the DB / spamming the owner.
  • Idempotent send via client_msg_id (partial-unique index) → a retried POST
    returns the same message instead of duplicating it.
  • Photos are S3 (served via a tenant-re-checked proxy, never a signed URL);
    S1 is text-only, photo_count is always 0.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.staff import (
    StaffMember,
    StaffLink,
    StaffChatThread,
    StaffChatMessage,
    StaffChatPhoto,
)
from app.models.business_profile import BusinessProfile
from app.services.auth import get_current_user
from app.services.storage import compose_key, get_storage
from app.services.chat_image import sanitize_chat_photo
from app.utils.time import utc_now

# Two independent routers, mounted under two different prefixes in main.py.
staff_router = APIRouter()   # /api/portal  (token-auth)
owner_router = APIRouter()   # /api/staff   (session-auth)

_limiter = Limiter(key_func=get_remote_address)

# Limits ───────────────────────────────────────────────────────────────────
MAX_BODY_CHARS = 2000          # one message body
SEND_CAP_PER_HOUR = 80         # per-thread, per-sender — DB-counter backstop
RETURN_LIMIT = 200             # max messages returned per fetch
MAX_PHOTOS = 3                 # per message (DB CHECK enforces 0..3 too)


# ── Schemas ─────────────────────────────────────────────────────────────────

class SendMessageRequest(BaseModel):
    body: Optional[str] = None
    client_msg_id: Optional[str] = None

    @field_validator("body")
    @classmethod
    def _trim_body(cls, v):
        if v is None:
            return v
        v = v.strip()
        return v or None

    @field_validator("client_msg_id")
    @classmethod
    def _cap_cmid(cls, v):
        if v is None:
            return v
        v = v.strip()
        return v[:64] or None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _staff_from_token(token: str, db: Session):
    """Resolve (link, member) from a portal token — READ-ONLY (no last_accessed
    write, since chat polls frequently and we don't want write amplification)."""
    link = (
        db.query(StaffLink)
        .filter(StaffLink.token == token, StaffLink.active.is_(True))
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Link not found or inactive")
    member = (
        db.query(StaffMember)
        .filter(StaffMember.id == link.staff_id, StaffMember.is_deleted.isnot(True))
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")
    return link, member


def _get_or_create_thread(db: Session, user_id, staff_id) -> StaffChatThread:
    """Fetch the 1:1 thread, lazily creating it. UNIQUE(user_id, staff_id) makes
    the create race-safe: the loser catches IntegrityError and re-SELECTs."""
    thread = (
        db.query(StaffChatThread)
        .filter(
            StaffChatThread.user_id == user_id,
            StaffChatThread.staff_id == staff_id,
        )
        .first()
    )
    if thread:
        return thread
    thread = StaffChatThread(user_id=user_id, staff_id=staff_id)
    db.add(thread)
    try:
        db.commit()
        db.refresh(thread)
    except IntegrityError:
        db.rollback()
        thread = (
            db.query(StaffChatThread)
            .filter(
                StaffChatThread.user_id == user_id,
                StaffChatThread.staff_id == staff_id,
            )
            .first()
        )
        if not thread:  # pragma: no cover — IntegrityError with no row is impossible
            raise HTTPException(status_code=500, detail="Thread create failed")
    return thread


def _enforce_send_cap(db: Session, thread_id, sender_type: str):
    """Per-thread, per-sender rolling-hour DB-counter cap. Backstops the per-IP
    slowapi limit against a leaked token or a single chatty actor."""
    cutoff = utc_now() - timedelta(hours=1)
    recent = (
        db.query(func.count(StaffChatMessage.id))
        .filter(
            StaffChatMessage.thread_id == thread_id,
            StaffChatMessage.sender_type == sender_type,
            StaffChatMessage.created_at >= cutoff,
        )
        .scalar()
    ) or 0
    if recent >= SEND_CAP_PER_HOUR:
        raise HTTPException(
            status_code=429,
            detail="For mange beskeder lige nu — prøv igen om lidt.",
        )


def _photos_for(db: Session, message_ids: list) -> dict:
    """Batch-load photos for a set of messages → {message_id: [StaffChatPhoto]}.
    Avoids an N+1 when serializing a message list."""
    if not message_ids:
        return {}
    rows = (
        db.query(StaffChatPhoto)
        .filter(StaffChatPhoto.message_id.in_(message_ids))
        .order_by(StaffChatPhoto.ord.asc())
        .all()
    )
    out: dict = {}
    for p in rows:
        out.setdefault(p.message_id, []).append(p)
    return out


def _serialize(msg: StaffChatMessage, viewer: str, photo_url, photos=None) -> dict:
    """viewer ∈ {'owner','staff'} → `mine` is whether the viewer sent it.
    `photo_url(photo_id) -> str` builds the (proxy) URL for a photo id."""
    photos = photos or []
    return {
        "id": str(msg.id),
        "sender_type": msg.sender_type,
        "mine": msg.sender_type == viewer,
        "body": msg.body,
        "photo_count": msg.photo_count or 0,
        "photos": [{"id": str(p.id), "url": photo_url(p.id)} for p in photos],
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
    }


def _insert_message(
    db: Session,
    thread: StaffChatThread,
    sender_type: str,
    payload: SendMessageRequest,
) -> StaffChatMessage:
    """Shared send path for both routers. Handles validation, the per-thread
    cap, idempotency, and thread-timestamp bookkeeping."""
    body = payload.body
    if not body:
        # S1 is text-only; an empty body has nothing to persist.
        raise HTTPException(status_code=422, detail="Beskeden er tom.")
    if len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS]

    # Idempotency — a retried POST with the same client_msg_id returns the
    # already-stored message rather than creating a twin.
    if payload.client_msg_id:
        existing = (
            db.query(StaffChatMessage)
            .filter(
                StaffChatMessage.thread_id == thread.id,
                StaffChatMessage.client_msg_id == payload.client_msg_id,
            )
            .first()
        )
        if existing:
            return existing

    _enforce_send_cap(db, thread.id, sender_type)

    msg = StaffChatMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        sender_type=sender_type,
        body=body,
        photo_count=0,
        client_msg_id=payload.client_msg_id,
    )
    db.add(msg)
    now = utc_now()
    thread.last_message_at = now
    # The sender has, by definition, read up to their own message.
    if sender_type == "owner":
        thread.owner_last_read_at = now
    else:
        thread.staff_last_read_at = now
    try:
        db.commit()
    except IntegrityError:
        # Lost the idempotency race — re-SELECT the winner.
        db.rollback()
        if payload.client_msg_id:
            existing = (
                db.query(StaffChatMessage)
                .filter(
                    StaffChatMessage.thread_id == thread.id,
                    StaffChatMessage.client_msg_id == payload.client_msg_id,
                )
                .first()
            )
            if existing:
                return existing
        raise
    db.refresh(msg)
    return msg


def _staff_photo_url(token: str):
    # Relative to the API base (which already includes /api). The frontend
    # fetches these via the axios client as a blob, so auth headers ride along
    # and we never expose a signed/public URL.
    return lambda pid: f"/portal/{token}/chat/photo/{pid}"


def _owner_photo_url():
    return lambda pid: f"/staff/chat/photo/{pid}"


def _create_message_with_photos(
    db: Session,
    thread: StaffChatThread,
    sender_type: str,
    body: str | None,
    client_msg_id: str | None,
    files: list,
):
    """Create a message with 1..MAX_PHOTOS attached photos (optionally a body
    too). Photos are sanitized BEFORE any row is written, so a bad image fails
    cleanly. Returns (message, [photo_rows])."""
    files = [f for f in (files or []) if f is not None][:MAX_PHOTOS + 1]
    if len(files) > MAX_PHOTOS:
        raise HTTPException(status_code=422, detail=f"Maks {MAX_PHOTOS} billeder.")
    body = (body or "").strip() or None
    if not files and not body:
        raise HTTPException(status_code=422, detail="Beskeden er tom.")
    if body and len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS]

    # Idempotency — same client_msg_id returns the stored message (photos and
    # all) instead of re-uploading.
    if client_msg_id:
        existing = (
            db.query(StaffChatMessage)
            .filter(
                StaffChatMessage.thread_id == thread.id,
                StaffChatMessage.client_msg_id == client_msg_id,
            )
            .first()
        )
        if existing:
            return existing, _photos_for(db, [existing.id]).get(existing.id, [])

    _enforce_send_cap(db, thread.id, sender_type)

    # Sanitize every photo up-front (raises before we write any row).
    sanitized = []
    for up in files:
        raw = up.file.read()
        sanitized.append(sanitize_chat_photo(raw))  # (bytes, content_type, sha)

    msg = StaffChatMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        sender_type=sender_type,
        body=body,
        photo_count=len(sanitized),
        client_msg_id=client_msg_id,
    )
    db.add(msg)
    db.flush()  # assign msg.id without committing

    storage = get_storage()
    photo_rows = []
    for ord_, (data, content_type, sha) in enumerate(sanitized):
        key = compose_key(thread.user_id, "staff_chat", sha, ext="jpg")
        storage.put(key, data, content_type)
        row = StaffChatPhoto(
            message_id=msg.id,
            user_id=thread.user_id,
            storage_key=key,
            content_type=content_type,
            size_bytes=len(data),
            ord=ord_,
        )
        db.add(row)
        photo_rows.append(row)

    now = utc_now()
    thread.last_message_at = now
    if sender_type == "owner":
        thread.owner_last_read_at = now
    else:
        thread.staff_last_read_at = now

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if client_msg_id:
            existing = (
                db.query(StaffChatMessage)
                .filter(
                    StaffChatMessage.thread_id == thread.id,
                    StaffChatMessage.client_msg_id == client_msg_id,
                )
                .first()
            )
            if existing:
                return existing, _photos_for(db, [existing.id]).get(existing.id, [])
        raise
    db.refresh(msg)
    for r in photo_rows:
        db.refresh(r)
    return msg, photo_rows


def _serve_photo(db: Session, photo: StaffChatPhoto) -> Response:
    """Stream a photo's bytes from storage. Caller has already authorized."""
    storage = get_storage()
    data = storage.get(photo.storage_key)
    if data is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    return Response(
        content=data,
        media_type=photo.content_type or "image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


def _fetch_messages(db: Session, thread_id) -> list:
    return (
        db.query(StaffChatMessage)
        .filter(
            StaffChatMessage.thread_id == thread_id,
            StaffChatMessage.is_deleted.isnot(True),
        )
        .order_by(StaffChatMessage.created_at.asc())
        .limit(RETURN_LIMIT)
        .all()
    )


# ════════════════════════════════════════════════════════════════════════════
#  STAFF side — /api/portal/{token}/chat   (token-auth, no id params)
# ════════════════════════════════════════════════════════════════════════════

@staff_router.get("/{token}/chat")
@_limiter.limit("60/minute")
def portal_get_chat(token: str, request: Request, db: Session = Depends(get_db)):
    """The staffer's own thread. Marks staff_last_read_at = now."""
    _link, member = _staff_from_token(token, db)
    thread = _get_or_create_thread(db, member.user_id, member.id)
    messages = _fetch_messages(db, thread.id)
    photos_by = _photos_for(db, [m.id for m in messages])
    url = _staff_photo_url(token)

    # Mark read.
    thread.staff_last_read_at = utc_now()
    db.commit()

    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == member.user_id)
        .first()
    )
    owner = db.query(User).filter(User.id == member.user_id).first()
    restaurant_name = (
        (getattr(owner, "business_name", None) if owner else None)
        or (getattr(profile, "business_name", None) if profile else None)
        or (profile.company_name if profile else None)
        or "BonBox"
    )
    return {
        "thread_id": str(thread.id),
        "restaurant_name": restaurant_name,
        "messages": [
            _serialize(m, "staff", url, photos_by.get(m.id, [])) for m in messages
        ],
    }


@staff_router.get("/{token}/chat/unread")
@_limiter.limit("60/minute")
def portal_chat_unread(token: str, request: Request, db: Session = Depends(get_db)):
    """Cheap nav-badge count: owner messages newer than staff_last_read_at."""
    _link, member = _staff_from_token(token, db)
    thread = (
        db.query(StaffChatThread)
        .filter(
            StaffChatThread.user_id == member.user_id,
            StaffChatThread.staff_id == member.id,
        )
        .first()
    )
    if not thread:
        return {"unread": 0}
    q = db.query(func.count(StaffChatMessage.id)).filter(
        StaffChatMessage.thread_id == thread.id,
        StaffChatMessage.sender_type == "owner",
        StaffChatMessage.is_deleted.isnot(True),
    )
    if thread.staff_last_read_at:
        q = q.filter(StaffChatMessage.created_at > thread.staff_last_read_at)
    return {"unread": int(q.scalar() or 0)}


@staff_router.post("/{token}/chat")
@_limiter.limit("30/minute")
def portal_send_chat(
    token: str,
    payload: SendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Staffer sends a TEXT message. sender_type is server-set to 'staff'."""
    _link, member = _staff_from_token(token, db)
    thread = _get_or_create_thread(db, member.user_id, member.id)
    msg = _insert_message(db, thread, "staff", payload)
    return _serialize(msg, "staff", _staff_photo_url(token))


@staff_router.post("/{token}/chat/photos")
@_limiter.limit("12/minute")
def portal_send_chat_photos(
    token: str,
    request: Request,
    body: str | None = Form(None),
    client_msg_id: str | None = Form(None),
    photos: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """Staffer sends a message WITH 1..3 photos (optional body). Multipart."""
    _link, member = _staff_from_token(token, db)
    thread = _get_or_create_thread(db, member.user_id, member.id)
    msg, rows = _create_message_with_photos(
        db, thread, "staff", body, (client_msg_id or "").strip()[:64] or None, photos
    )
    return _serialize(msg, "staff", _staff_photo_url(token), rows)


@staff_router.get("/{token}/chat/photo/{photo_id}")
@_limiter.limit("120/minute")
def portal_get_chat_photo(
    token: str, photo_id: str, request: Request, db: Session = Depends(get_db)
):
    """Proxy-serve a photo — re-checks tenant AND that it belongs to THIS
    staffer's thread (so one staffer can't read another's photo). NEVER a
    signed/public URL."""
    _link, member = _staff_from_token(token, db)
    photo = (
        db.query(StaffChatPhoto)
        .filter(
            StaffChatPhoto.id == photo_id,
            StaffChatPhoto.user_id == member.user_id,
        )
        .first()
    )
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    # Confirm the photo's thread is THIS staffer's (not just same tenant).
    owns = (
        db.query(StaffChatThread.id)
        .join(StaffChatMessage, StaffChatMessage.thread_id == StaffChatThread.id)
        .filter(
            StaffChatMessage.id == photo.message_id,
            StaffChatThread.staff_id == member.id,
        )
        .first()
    )
    if not owns:
        raise HTTPException(status_code=404, detail="Photo not found")
    return _serve_photo(db, photo)


# ════════════════════════════════════════════════════════════════════════════
#  OWNER side — /api/staff/chat/...   (session-auth, tenant-scoped)
# ════════════════════════════════════════════════════════════════════════════

def _owner_staff_or_404(db: Session, owner: User, staff_id: str) -> StaffMember:
    member = (
        db.query(StaffMember)
        .filter(
            StaffMember.id == staff_id,
            StaffMember.user_id == owner.id,
            StaffMember.is_deleted.isnot(True),
        )
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Staff member not found")
    return member


def _staff_label(member: StaffMember) -> str:
    return (member.display_name or member.name or "").strip() or "Medarbejder"


@owner_router.get("/chat/unread")
@_limiter.limit("60/minute")
def owner_chat_unread(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Total unread staff→owner messages across all threads — drives the
    schedule-page chat launcher badge. Cheap aggregate, no message bodies."""
    threads = (
        db.query(StaffChatThread)
        .filter(StaffChatThread.user_id == user.id)
        .all()
    )
    total = 0
    for thr in threads:
        q = db.query(func.count(StaffChatMessage.id)).filter(
            StaffChatMessage.thread_id == thr.id,
            StaffChatMessage.sender_type == "staff",
            StaffChatMessage.is_deleted.isnot(True),
        )
        if thr.owner_last_read_at:
            q = q.filter(StaffChatMessage.created_at > thr.owner_last_read_at)
        total += int(q.scalar() or 0)
    return {"unread": total}


@owner_router.get("/chat/threads")
@_limiter.limit("60/minute")
def owner_list_threads(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One row per active staffer: last message preview + unread count for the
    owner (staff messages newer than owner_last_read_at). Threads are lazily
    created, so a staffer with no messages yet simply shows an empty preview."""
    members = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .order_by(StaffMember.name.asc())
        .all()
    )
    threads = {
        t.staff_id: t
        for t in db.query(StaffChatThread)
        .filter(StaffChatThread.user_id == user.id)
        .all()
    }

    out = []
    for m in members:
        t = threads.get(m.id)
        last_body = None
        last_at = None
        unread = 0
        if t:
            last = (
                db.query(StaffChatMessage)
                .filter(
                    StaffChatMessage.thread_id == t.id,
                    StaffChatMessage.is_deleted.isnot(True),
                )
                .order_by(StaffChatMessage.created_at.desc())
                .first()
            )
            if last:
                last_body = last.body
                last_at = last.created_at.isoformat() if last.created_at else None
            uq = db.query(func.count(StaffChatMessage.id)).filter(
                StaffChatMessage.thread_id == t.id,
                StaffChatMessage.sender_type == "staff",
                StaffChatMessage.is_deleted.isnot(True),
            )
            if t.owner_last_read_at:
                uq = uq.filter(StaffChatMessage.created_at > t.owner_last_read_at)
            unread = int(uq.scalar() or 0)
        out.append(
            {
                "staff_id": str(m.id),
                "name": _staff_label(m),
                "role": m.role,
                "last_body": last_body,
                "last_message_at": last_at,
                "unread": unread,
            }
        )
    # Most-recently-active threads first; never-messaged staff after.
    out.sort(key=lambda r: (r["last_message_at"] or ""), reverse=True)
    return {"threads": out}


@owner_router.get("/chat/threads/{staff_id}")
@_limiter.limit("60/minute")
def owner_get_thread(
    staff_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Messages for one staffer's thread. Marks owner_last_read_at = now."""
    member = _owner_staff_or_404(db, user, staff_id)
    thread = _get_or_create_thread(db, user.id, member.id)
    messages = _fetch_messages(db, thread.id)
    photos_by = _photos_for(db, [m.id for m in messages])
    url = _owner_photo_url()
    thread.owner_last_read_at = utc_now()
    db.commit()
    return {
        "thread_id": str(thread.id),
        "staff_id": str(member.id),
        "name": _staff_label(member),
        "messages": [
            _serialize(m, "owner", url, photos_by.get(m.id, [])) for m in messages
        ],
    }


@owner_router.post("/chat/threads/{staff_id}")
@_limiter.limit("30/minute")
def owner_send_message(
    staff_id: str,
    payload: SendMessageRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Owner sends a TEXT message. sender_type is server-set to 'owner'."""
    member = _owner_staff_or_404(db, user, staff_id)
    thread = _get_or_create_thread(db, user.id, member.id)
    msg = _insert_message(db, thread, "owner", payload)
    return _serialize(msg, "owner", _owner_photo_url())


@owner_router.post("/chat/threads/{staff_id}/photos")
@_limiter.limit("12/minute")
def owner_send_message_photos(
    staff_id: str,
    request: Request,
    body: str | None = Form(None),
    client_msg_id: str | None = Form(None),
    photos: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Owner sends a message WITH 1..3 photos (optional body). Multipart."""
    member = _owner_staff_or_404(db, user, staff_id)
    thread = _get_or_create_thread(db, user.id, member.id)
    msg, rows = _create_message_with_photos(
        db, thread, "owner", body, (client_msg_id or "").strip()[:64] or None, photos
    )
    return _serialize(msg, "owner", _owner_photo_url(), rows)


@owner_router.get("/chat/photo/{photo_id}")
@_limiter.limit("120/minute")
def owner_get_chat_photo(
    photo_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Proxy-serve a photo for the owner — tenant-scoped (owner sees all their
    own threads). NEVER a signed/public URL."""
    photo = (
        db.query(StaffChatPhoto)
        .filter(StaffChatPhoto.id == photo_id, StaffChatPhoto.user_id == user.id)
        .first()
    )
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    return _serve_photo(db, photo)
