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

import uuid
from datetime import datetime, timedelta
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.staff import (
    StaffMember,
    StaffLink,
    StaffChatThread,
    StaffChatMember,
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

_limiter = Limiter(key_func=client_ip)

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
            StaffChatThread.kind == "direct",
        )
        .first()
    )
    if thread:
        _ensure_member(db, thread, staff_id)      # backfills pre-group threads
        return thread
    thread = StaffChatThread(user_id=user_id, staff_id=staff_id, kind="direct")
    db.add(thread)
    try:
        db.commit()
        db.refresh(thread)
        _ensure_member(db, thread, staff_id)
        return thread
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
    _ensure_member(db, thread, staff_id)
    return thread


def _ensure_member(db: Session, thread: StaffChatThread, staff_id) -> None:
    """Idempotently record that `staff_id` is in `thread`.

    Direct threads get a member row too, so every reader downstream can use one
    membership query instead of branching on kind forever.
    """
    exists = (
        db.query(StaffChatMember.id)
        .filter(
            StaffChatMember.thread_id == thread.id,
            StaffChatMember.staff_id == staff_id,
        )
        .first()
    )
    if exists:
        return
    db.add(StaffChatMember(
        user_id=thread.user_id, thread_id=thread.id, staff_id=staff_id,
    ))
    try:
        db.commit()
    except IntegrityError:      # concurrent add — the unique index won, fine
        db.rollback()


def _is_member(db: Session, thread_id, staff_id) -> bool:
    """THE authorization primitive for group content.

    Every staff-side read of a thread — messages, photos, unread — must pass
    through this. The old code proved membership with `thread.staff_id == me`,
    which silently authorizes nobody once a thread has N members.
    """
    return db.query(StaffChatMember.id).filter(
        StaffChatMember.thread_id == thread_id,
        StaffChatMember.staff_id == staff_id,
    ).first() is not None


def _member_or_403(db: Session, thread: StaffChatThread, member) -> None:
    # Tenant first, then membership. Both, always — a thread id from another
    # business must never even reach the membership check.
    if thread.user_id != member.user_id or not _is_member(db, thread.id, member.id):
        raise HTTPException(status_code=403, detail="Not a member of this conversation")


def _enforce_send_cap(db: Session, thread_id, sender_type: str, sender_staff_id=None):
    """Per-thread, per-SENDER rolling-hour DB-counter cap. Backstops the per-IP
    slowapi limit against a leaked token or a single chatty actor.

    The bucket is the individual, not the role: counting by sender_type alone
    means one chatty colleague in a nine-person group silences the other eight,
    and a leaked token would be masked by everyone else's traffic rather than
    standing out.
    """
    cutoff = utc_now() - timedelta(hours=1)
    q = (
        db.query(func.count(StaffChatMessage.id))
        .filter(
            StaffChatMessage.thread_id == thread_id,
            StaffChatMessage.sender_type == sender_type,
            StaffChatMessage.created_at >= cutoff,
        )
    )
    if sender_staff_id is not None:
        q = q.filter(StaffChatMessage.sender_staff_id == sender_staff_id)
    recent = q.scalar() or 0
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


def _serialize(msg: StaffChatMessage, viewer: str, photo_url, photos=None,
               viewer_staff_id=None, names=None) -> dict:
    """viewer ∈ {'owner','staff'} → `mine` is whether the VIEWER sent it.

    In a group every member is sender_type='staff', so `sender_type == viewer`
    would mark every colleague's message as your own. When the caller knows who
    it is (viewer_staff_id), identity decides; sender_type only ever separates
    owner from staff.

    `names` maps staff_id → display name so a group can say who spoke. It is
    NOT sent for direct threads: there is one other party and naming them on
    every line is noise.
    """
    photos = photos or []
    if viewer == "staff" and viewer_staff_id is not None:
        mine = msg.sender_type == "staff" and str(msg.sender_staff_id or "") == str(viewer_staff_id)
    else:
        mine = msg.sender_type == viewer
    out = {
        "id": str(msg.id),
        "sender_type": msg.sender_type,
        "mine": mine,
        "body": msg.body,
        "photo_count": msg.photo_count or 0,
        "photos": [{"id": str(p.id), "url": photo_url(p.id)} for p in photos],
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
    }
    if names is not None and msg.sender_staff_id is not None:
        out["sender_name"] = names.get(msg.sender_staff_id)
    return out


def _insert_message(
    db: Session,
    thread: StaffChatThread,
    sender_type: str,
    payload: SendMessageRequest,
    sender_staff_id=None,
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

    _enforce_send_cap(db, thread.id, sender_type, sender_staff_id)

    msg = StaffChatMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        sender_type=sender_type,
        sender_staff_id=sender_staff_id,
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
    sender_staff_id=None,
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

    _enforce_send_cap(db, thread.id, sender_type, sender_staff_id)

    # Sanitize every photo up-front (raises before we write any row).
    sanitized = []
    for up in files:
        raw = up.file.read()
        sanitized.append(sanitize_chat_photo(raw))  # (bytes, content_type, sha)

    msg = StaffChatMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        sender_type=sender_type,
        sender_staff_id=sender_staff_id,
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

    _mark_staff_read(db, thread, member)

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
    """Cheap nav-badge count across EVERY conversation this staffer is in.

    It used to count only owner messages in the one direct thread, which after
    groups would leave a badge sitting at zero while colleagues were talking.
    """
    _link, member = _staff_from_token(token, db)
    total = 0
    for thread, row in _my_threads(db, member):
        total += _unread_for_staff(db, thread.id, member.id, _read_since(thread, row))
    return {"unread": total}


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
    msg = _insert_message(db, thread, "staff", payload, sender_staff_id=member.id)
    return _serialize(msg, "staff", _staff_photo_url(token), viewer_staff_id=member.id)


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
        db, thread, "staff", body, (client_msg_id or "").strip()[:64] or None, photos,
        sender_staff_id=member.id,
    )
    return _serialize(msg, "staff", _staff_photo_url(token), rows,
                      viewer_staff_id=member.id)


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
    # Confirm the photo hangs off a thread this staffer is a MEMBER of.
    #
    # This used to prove `thread.staff_id == member.id`, which is exactly wrong
    # for a group: staff_id is NULL there, so it would deny every legitimate
    # member. Membership is the real proof — and it stays ANDed with the tenant
    # filter above, never substituted for it, so a photo id from another
    # business cannot be reached even by a member of some thread.
    owns = (
        db.query(StaffChatMember.id)
        .join(StaffChatMessage, StaffChatMessage.thread_id == StaffChatMember.thread_id)
        .filter(
            StaffChatMessage.id == photo.message_id,
            StaffChatMember.staff_id == member.id,
            StaffChatMember.user_id == member.user_id,
        )
        .first()
    )
    if not owns:
        # 404, not 403 — do not confirm a photo id exists to someone who may
        # not see it.
        raise HTTPException(status_code=404, detail="Photo not found")
    return _serve_photo(db, photo)


# ════════════════════════════════════════════════════════════════════════════
#  GROUPS — shared plumbing
# ════════════════════════════════════════════════════════════════════════════

GROUP_MAX_MEMBERS = 50         # a shift team, not a mailing list
GROUP_TITLE_MAX = 60


class CreateGroupRequest(BaseModel):
    title: str
    staff_ids: list[str] = []


class UpdateGroupRequest(BaseModel):
    title: Optional[str] = None
    staff_ids: Optional[list[str]] = None


def _thread_in_tenant_or_404(db: Session, thread_id, user_id) -> StaffChatThread:
    """Resolve a thread id INSIDE one tenant.

    404 rather than 403 on a foreign id, deliberately: a 403 would confirm that
    some other business's thread exists, which is exactly what an id-guessing
    probe is looking for. An unparseable id takes the same path — a malformed
    UUID must not reach the driver and surface as a 500.
    """
    try:
        tid = uuid.UUID(str(thread_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=404, detail="Conversation not found")
    thread = (
        db.query(StaffChatThread)
        .filter(StaffChatThread.id == tid, StaffChatThread.user_id == user_id)
        .first()
    )
    if not thread:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return thread


def _my_threads(db: Session, member: StaffMember) -> list:
    """(thread, my member row) for every conversation this staffer belongs to.

    Driven by StaffChatMember, so a group appears here for its members and for
    nobody else. The tenant is asserted on BOTH sides of the join — membership
    alone must never be the only thing standing between businesses.
    """
    return (
        db.query(StaffChatThread, StaffChatMember)
        .join(StaffChatMember, StaffChatMember.thread_id == StaffChatThread.id)
        .filter(
            StaffChatMember.staff_id == member.id,
            StaffChatMember.user_id == member.user_id,
            StaffChatThread.user_id == member.user_id,
        )
        .all()
    )


def _read_since(thread: StaffChatThread, row: StaffChatMember):
    """This staffer's read position. A member row backfilled from a pre-group
    thread has no timestamp yet, so the direct thread's old column is the
    honest answer until they next open it."""
    if row is not None and row.last_read_at:
        return row.last_read_at
    return thread.staff_last_read_at if thread.kind == "direct" else None


def _unread_for_staff(db: Session, thread_id, staff_id, since) -> int:
    """Unread count for ONE staffer in ONE thread.

    Their own messages never count. `sender_type == 'staff'` is everybody in a
    group, so identity — not role — decides. Legacy staff rows carry no
    sender_staff_id; in a direct thread those are by definition the staffer's
    own, so a NULL sender is treated as self and stays uncounted.
    """
    q = db.query(func.count(StaffChatMessage.id)).filter(
        StaffChatMessage.thread_id == thread_id,
        StaffChatMessage.is_deleted.isnot(True),
        or_(
            StaffChatMessage.sender_type != "staff",
            and_(
                StaffChatMessage.sender_staff_id.isnot(None),
                StaffChatMessage.sender_staff_id != staff_id,
            ),
        ),
    )
    if since:
        q = q.filter(StaffChatMessage.created_at > since)
    return int(q.scalar() or 0)


def _mark_staff_read(db: Session, thread: StaffChatThread, member: StaffMember) -> None:
    db.query(StaffChatMember).filter(
        StaffChatMember.thread_id == thread.id,
        StaffChatMember.staff_id == member.id,
    ).update({"last_read_at": utc_now()}, synchronize_session=False)
    if thread.kind == "direct":
        # Keep the legacy column alive for bundles still reading it. In a GROUP
        # it must never be touched: one member opening the thread would zero
        # every other member's badge.
        thread.staff_last_read_at = utc_now()
    db.commit()


def _names_map(db: Session, user_id) -> dict:
    """staff_id → display name, so a group line can say who spoke. Deleted
    staff are included: their old messages still need an author."""
    return {
        m.id: _staff_label(m)
        for m in db.query(StaffMember).filter(StaffMember.user_id == user_id).all()
    }


def _member_ids(db: Session, thread_id) -> list:
    return [
        r.staff_id
        for r in db.query(StaffChatMember.staff_id)
        .filter(StaffChatMember.thread_id == thread_id)
        .all()
    ]


def _last_message(db: Session, thread_id):
    return (
        db.query(StaffChatMessage)
        .filter(
            StaffChatMessage.thread_id == thread_id,
            StaffChatMessage.is_deleted.isnot(True),
        )
        .order_by(StaffChatMessage.created_at.desc())
        .first()
    )


def _resolve_group_members(db: Session, user_id, staff_ids) -> list:
    """Requested ids → StaffMember rows, hard-filtered to THIS tenant.

    This is the entire security surface of "add people to a group": an id
    belonging to another business simply does not resolve, so no crafted list
    can pull a stranger into a conversation. Deleted and deactivated staff are
    dropped for the same reason a fired employee stops getting shift reminders.
    A malformed id is skipped rather than fatal — one bad entry in a list of
    twelve should not lose the other eleven.
    """
    wanted = set()
    for raw in (staff_ids or []):
        try:
            wanted.add(uuid.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not wanted:
        return []
    return (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user_id,
            StaffMember.id.in_(list(wanted)),
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .all()
    )


def _create_group(db: Session, user_id, title, member_rows, created_by, creator_id=None):
    clean = (title or "").strip()[:GROUP_TITLE_MAX]
    if not clean:
        raise HTTPException(status_code=400, detail="Gruppen skal have et navn")
    ids = {m.id for m in member_rows}
    if creator_id is not None:
        ids.add(creator_id)          # you are always in a group you started
    if len(ids) > GROUP_MAX_MEMBERS:
        raise HTTPException(status_code=400, detail="For mange deltagere")
    thread = StaffChatThread(
        user_id=user_id, staff_id=None, kind="group",
        title=clean, created_by=created_by,
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    for sid in ids:
        _ensure_member(db, thread, sid)
    return thread


def _group_summary(db: Session, thread: StaffChatThread) -> dict:
    return {
        "thread_id": str(thread.id),
        "kind": thread.kind,
        "title": thread.title,
        "created_by": thread.created_by,
        "member_ids": [str(s) for s in _member_ids(db, thread.id)],
    }


# ════════════════════════════════════════════════════════════════════════════
#  STAFF side — groups
# ════════════════════════════════════════════════════════════════════════════

@staff_router.get("/{token}/chat/threads")
@_limiter.limit("60/minute")
def portal_list_threads(token: str, request: Request, db: Session = Depends(get_db)):
    """Every conversation this staffer is in: their owner thread plus groups.

    The owner thread is materialized here so a staffer who has never messaged
    still sees somewhere to write, which is the whole point of the screen.
    """
    _link, member = _staff_from_token(token, db)
    _get_or_create_thread(db, member.user_id, member.id)     # owner thread exists

    owner = db.query(User).filter(User.id == member.user_id).first()
    business = (getattr(owner, "business_name", None) or "").strip() or "BonBox"
    names = _names_map(db, member.user_id)

    out = []
    for thread, row in _my_threads(db, member):
        last = _last_message(db, thread.id)
        preview = None
        if last:
            preview = last.body or ("📷" if (last.photo_count or 0) else None)
        is_group = thread.kind == "group"
        out.append({
            "thread_id": str(thread.id),
            "kind": thread.kind,
            "title": thread.title if is_group else business,
            "member_count": len(_member_ids(db, thread.id)) if is_group else 2,
            "last_body": preview,
            "last_sender": (
                names.get(last.sender_staff_id) if (last and is_group) else None
            ),
            "last_message_at": (
                last.created_at.isoformat() if (last and last.created_at) else None
            ),
            "unread": _unread_for_staff(
                db, thread.id, member.id, _read_since(thread, row)
            ),
        })
    # Two stable passes: most recent first, then the owner thread floated to
    # the top — it is the one that carries schedule news.
    out.sort(key=lambda r: (r["last_message_at"] or ""), reverse=True)
    out.sort(key=lambda r: r["kind"] != "direct")
    return {"threads": out}


@staff_router.get("/{token}/chat/threads/{thread_id}")
@_limiter.limit("60/minute")
def portal_get_thread(
    token: str, thread_id: str, request: Request, db: Session = Depends(get_db)
):
    """Messages in one conversation. Membership is proven before a single
    message body is read — never after."""
    _link, member = _staff_from_token(token, db)
    thread = _thread_in_tenant_or_404(db, thread_id, member.user_id)
    _member_or_403(db, thread, member)

    messages = _fetch_messages(db, thread.id)
    photos_by = _photos_for(db, [m.id for m in messages])
    url = _staff_photo_url(token)
    names = _names_map(db, member.user_id) if thread.kind == "group" else None
    _mark_staff_read(db, thread, member)

    payload = _group_summary(db, thread)
    payload["messages"] = [
        _serialize(m, "staff", url, photos_by.get(m.id, []),
                   viewer_staff_id=member.id, names=names)
        for m in messages
    ]
    return payload


@staff_router.post("/{token}/chat/threads/{thread_id}")
@_limiter.limit("30/minute")
def portal_send_to_thread(
    token: str,
    thread_id: str,
    payload: SendMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _link, member = _staff_from_token(token, db)
    thread = _thread_in_tenant_or_404(db, thread_id, member.user_id)
    _member_or_403(db, thread, member)
    names = _names_map(db, member.user_id) if thread.kind == "group" else None
    msg = _insert_message(db, thread, "staff", payload, sender_staff_id=member.id)
    return _serialize(msg, "staff", _staff_photo_url(token),
                      viewer_staff_id=member.id, names=names)


@staff_router.post("/{token}/chat/threads/{thread_id}/photos")
@_limiter.limit("12/minute")
def portal_send_thread_photos(
    token: str,
    thread_id: str,
    request: Request,
    body: str | None = Form(None),
    client_msg_id: str | None = Form(None),
    photos: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    _link, member = _staff_from_token(token, db)
    thread = _thread_in_tenant_or_404(db, thread_id, member.user_id)
    _member_or_403(db, thread, member)
    names = _names_map(db, member.user_id) if thread.kind == "group" else None
    msg, rows = _create_message_with_photos(
        db, thread, "staff", body, (client_msg_id or "").strip()[:64] or None, photos,
        sender_staff_id=member.id,
    )
    return _serialize(msg, "staff", _staff_photo_url(token), rows,
                      viewer_staff_id=member.id, names=names)


@staff_router.get("/{token}/chat/colleagues")
@_limiter.limit("30/minute")
def portal_list_colleagues(token: str, request: Request, db: Session = Depends(get_db)):
    """Who this staffer can put in a group — names and roles only.

    Deliberately NOT the staff record: no phone, no email, no hours, no pay.
    A picker needs a name, and anything more would turn a chat feature into a
    directory leak.
    """
    _link, member = _staff_from_token(token, db)
    rows = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == member.user_id,
            StaffMember.id != member.id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .order_by(StaffMember.name.asc())
        .all()
    )
    return {
        "colleagues": [
            {"staff_id": str(m.id), "name": _staff_label(m), "role": m.role}
            for m in rows
        ]
    }


@staff_router.post("/{token}/chat/groups")
@_limiter.limit("10/minute")
def portal_create_group(
    token: str,
    payload: CreateGroupRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """A staffer starts a group with colleagues. The creator is always a
    member — you cannot create a conversation you are not in, which would be a
    way to make people talk somewhere you can be told about but not seen in."""
    _link, member = _staff_from_token(token, db)
    rows = _resolve_group_members(db, member.user_id, payload.staff_ids)
    thread = _create_group(
        db, member.user_id, payload.title, rows, "staff", creator_id=member.id
    )
    return _group_summary(db, thread)


@staff_router.post("/{token}/chat/groups/{thread_id}/leave")
@_limiter.limit("10/minute")
def portal_leave_group(
    token: str, thread_id: str, request: Request, db: Session = Depends(get_db)
):
    """Leaving is membership-revoking, so every later read fails the same
    check. A DIRECT thread cannot be left — that is the owner channel."""
    _link, member = _staff_from_token(token, db)
    thread = _thread_in_tenant_or_404(db, thread_id, member.user_id)
    if thread.kind != "group":
        raise HTTPException(status_code=400, detail="Kan ikke forlade denne samtale")
    _member_or_403(db, thread, member)
    db.query(StaffChatMember).filter(
        StaffChatMember.thread_id == thread.id,
        StaffChatMember.staff_id == member.id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


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
    # kind='direct' is load-bearing: a group has staff_id NULL, so without it
    # every group collapses onto the single None key and shadows the rest.
    threads = {
        t.staff_id: t
        for t in db.query(StaffChatThread)
        .filter(
            StaffChatThread.user_id == user.id,
            StaffChatThread.kind == "direct",
        )
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


# ════════════════════════════════════════════════════════════════════════════
#  OWNER side — groups
# ════════════════════════════════════════════════════════════════════════════

@owner_router.get("/chat/groups")
@_limiter.limit("60/minute")
def owner_list_groups(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Group conversations in this business, newest activity first."""
    threads = (
        db.query(StaffChatThread)
        .filter(StaffChatThread.user_id == user.id, StaffChatThread.kind == "group")
        .all()
    )
    names = _names_map(db, user.id)
    out = []
    for t in threads:
        last = _last_message(db, t.id)
        uq = db.query(func.count(StaffChatMessage.id)).filter(
            StaffChatMessage.thread_id == t.id,
            StaffChatMessage.sender_type == "staff",
            StaffChatMessage.is_deleted.isnot(True),
        )
        if t.owner_last_read_at:
            uq = uq.filter(StaffChatMessage.created_at > t.owner_last_read_at)
        out.append({
            "thread_id": str(t.id),
            "kind": "group",
            "title": t.title,
            "created_by": t.created_by,
            "member_count": len(_member_ids(db, t.id)),
            "last_body": (last.body or ("📷" if (last.photo_count or 0) else None)) if last else None,
            # Who spoke — in a group the preview is ambiguous without it, and
            # the staff portal already names the speaker.
            "last_sender": names.get(last.sender_staff_id) if last else None,
            "last_message_at": (
                last.created_at.isoformat() if (last and last.created_at) else None
            ),
            "unread": int(uq.scalar() or 0),
        })
    out.sort(key=lambda r: (r["last_message_at"] or ""), reverse=True)
    return {"groups": out}


@owner_router.post("/chat/groups")
@_limiter.limit("10/minute")
def owner_create_group(
    payload: CreateGroupRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The owner starts a group. No creator_id: the owner is not a StaffMember,
    and their access to their own business's threads comes from the tenant
    scope, not from a membership row."""
    rows = _resolve_group_members(db, user.id, payload.staff_ids)
    thread = _create_group(db, user.id, payload.title, rows, "owner")
    return _group_summary(db, thread)


@owner_router.get("/chat/groups/{thread_id}")
@_limiter.limit("60/minute")
def owner_get_group(
    thread_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Messages in a group. Marks owner_last_read_at — there is exactly one
    owner, so the thread column is the right home for their read position."""
    thread = _thread_in_tenant_or_404(db, thread_id, user.id)
    messages = _fetch_messages(db, thread.id)
    photos_by = _photos_for(db, [m.id for m in messages])
    url = _owner_photo_url()
    names = _names_map(db, user.id)
    thread.owner_last_read_at = utc_now()
    db.commit()
    payload = _group_summary(db, thread)
    payload["messages"] = [
        _serialize(m, "owner", url, photos_by.get(m.id, []), names=names)
        for m in messages
    ]
    return payload


@owner_router.post("/chat/groups/{thread_id}")
@_limiter.limit("30/minute")
def owner_send_to_group(
    thread_id: str,
    payload: SendMessageRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = _thread_in_tenant_or_404(db, thread_id, user.id)
    msg = _insert_message(db, thread, "owner", payload)
    return _serialize(msg, "owner", _owner_photo_url(), names=_names_map(db, user.id))


@owner_router.post("/chat/groups/{thread_id}/photos")
@_limiter.limit("12/minute")
def owner_send_group_photos(
    thread_id: str,
    request: Request,
    body: str | None = Form(None),
    client_msg_id: str | None = Form(None),
    photos: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = _thread_in_tenant_or_404(db, thread_id, user.id)
    msg, rows = _create_message_with_photos(
        db, thread, "owner", body, (client_msg_id or "").strip()[:64] or None, photos
    )
    return _serialize(msg, "owner", _owner_photo_url(), rows,
                      names=_names_map(db, user.id))


@owner_router.patch("/chat/groups/{thread_id}")
@_limiter.limit("20/minute")
def owner_update_group(
    thread_id: str,
    payload: UpdateGroupRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Rename a group and/or set its membership.

    `staff_ids` is the FULL new roster, not a delta — removing someone is the
    security-relevant half of this endpoint, and a delta API makes a removal
    easy to lose. Ids are resolved through the same tenant filter as creation,
    so this can never reach across businesses either.

    Messages already sent stay: a removed member loses future access, not the
    record of what they said. Their own copy is gone the moment membership is,
    because every read goes through `_is_member`.
    """
    thread = _thread_in_tenant_or_404(db, thread_id, user.id)
    if thread.kind != "group":
        raise HTTPException(status_code=400, detail="Ikke en gruppe")

    if payload.title is not None:
        clean = payload.title.strip()[:GROUP_TITLE_MAX]
        if not clean:
            raise HTTPException(status_code=400, detail="Gruppen skal have et navn")
        thread.title = clean

    if payload.staff_ids is not None:
        rows = _resolve_group_members(db, user.id, payload.staff_ids)
        keep = {m.id for m in rows}
        if len(keep) > GROUP_MAX_MEMBERS:
            raise HTTPException(status_code=400, detail="For mange deltagere")
        existing = set(_member_ids(db, thread.id))
        for gone in existing - keep:
            db.query(StaffChatMember).filter(
                StaffChatMember.thread_id == thread.id,
                StaffChatMember.staff_id == gone,
            ).delete(synchronize_session=False)
        db.commit()
        for added in keep - existing:
            _ensure_member(db, thread, added)

    db.commit()
    return _group_summary(db, thread)


@owner_router.delete("/chat/groups/{thread_id}")
@_limiter.limit("10/minute")
def owner_delete_group(
    thread_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Close a group. Membership rows go, so every member's access ends at
    once; the messages are soft-deleted rather than dropped, because a staff
    conversation can be evidence in a labour dispute."""
    thread = _thread_in_tenant_or_404(db, thread_id, user.id)
    if thread.kind != "group":
        raise HTTPException(status_code=400, detail="Ikke en gruppe")
    db.query(StaffChatMember).filter(
        StaffChatMember.thread_id == thread.id
    ).delete(synchronize_session=False)
    db.query(StaffChatMessage).filter(
        StaffChatMessage.thread_id == thread.id
    ).update({"is_deleted": True}, synchronize_session=False)
    db.commit()
    return {"ok": True}
