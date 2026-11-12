"""
Egenkontrol R1b — documents and photos (/api/egenkontrol/documents…,
/api/egenkontrol/photos/…, POST /api/egenkontrol/entries/{id}/photo).

NO `from __future__ import annotations` in this file: it uses slowapi
@limiter decorators, and string annotations make FastAPI read request bodies
(here: multipart File/Form) as query parameters — a silent 422.

WHO MAY DO WHAT (same helpers as routers/egenkontrol.py):
  • accountant view — 403 accountant_no_access everywhere (_ek_user).
  • owner only: upload / review / delete a document, remove a photo, add a
    photo from the owner app.
  • owner + manager: list documents, download a document, view a photo.
  • a curtained shared tablet: the photo UPLOAD stays open (it hangs off
    /entries — counter work, like the reading itself); listing, downloading
    and every other write here need the reveal PIN (main.py's
    shared_device_pin_gate, prefixes /documents and /photos).

Bytes only through these proxies — never a signed or public URL.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.routers.egenkontrol import (
    _actor_id, _ek_user, _require_folder_reader, _require_owner, _via,
)
from app.services import egenkontrol_files as F
from app.utils.client_ip import client_ip

router = APIRouter(prefix="/egenkontrol", tags=["Egenkontrol"])
limiter = Limiter(key_func=client_ip, key_style="endpoint")


# ── Documents ────────────────────────────────────────────────────────────

@router.get("/documents")
def ek_documents(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_folder_reader(user)
    return F.list_documents(db, user)


@router.post("/documents", status_code=201)
@limiter.limit("10/minute")
def ek_add_document(
    request: Request,
    file: UploadFile = File(...),
    title: Optional[str] = Form(default=None),
    doc_type: Optional[str] = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(_ek_user),
):
    _require_owner(user)
    return F.add_document(db, user, file, title=title, doc_type=doc_type,
                          actor_user_id=_actor_id(user))


@router.post("/documents/{doc_id}/reviewed")
@limiter.limit("20/minute")
def ek_document_reviewed(doc_id: UUID, request: Request, db: Session = Depends(get_db),
                         user: User = Depends(_ek_user)):
    _require_owner(user)
    return F.mark_document_reviewed(db, user, doc_id, actor_user_id=_actor_id(user))


@router.delete("/documents/{doc_id}")
@limiter.limit("20/minute")
def ek_delete_document(doc_id: UUID, request: Request, db: Session = Depends(get_db),
                       user: User = Depends(_ek_user)):
    _require_owner(user)
    return F.delete_document(db, user, doc_id, actor_user_id=_actor_id(user))


@router.get("/documents/{doc_id}/file")
@limiter.limit("60/minute")
def ek_document_file(doc_id: UUID, request: Request, db: Session = Depends(get_db),
                     user: User = Depends(_ek_user)):
    _require_folder_reader(user)
    return F.serve_document(db, user, doc_id)


# ── Photos ───────────────────────────────────────────────────────────────

@router.post("/entries/{entry_id}/photo", status_code=201)
@limiter.limit("30/minute")
def ek_add_photo(entry_id: UUID, request: Request, file: UploadFile = File(...),
                 db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    return F.attach_photo(db, user, entry_id, file, via=_via(user),
                          actor_user_id=_actor_id(user))


@router.get("/photos/{photo_id}")
@limiter.limit("120/minute")
def ek_photo(photo_id: UUID, request: Request, db: Session = Depends(get_db),
             user: User = Depends(_ek_user)):
    _require_folder_reader(user)
    return F.serve_photo(db, user, photo_id)


@router.delete("/photos/{photo_id}")
@limiter.limit("20/minute")
def ek_remove_photo(photo_id: UUID, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(_ek_user)):
    _require_owner(user)
    return F.remove_photo(db, user, photo_id, actor_user_id=_actor_id(user))
