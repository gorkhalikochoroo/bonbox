"""
Kitchen iPad — the egenkontrol device surface (/api/kitchen/{token}/*).

The credential is a KitchenLink token in the URL path, paired with a short
code at POST /api/stand/join (routers/stand_link.py). NO JWT or cookie is ever
read here: the owner is re-derived from the link ROW on every request, and a
revoked, unknown or unpaired token is the same 404 {"error":"not_found"}.

THE ALLOW-LIST IS STRUCTURAL, exactly like the host stand: a kitchen token
reaches the wrappers below and nothing else in the API. Today's list, staff
first names, save and undo a reading, the read-only Kontrolmappe, and letting
go of itself. No config, devices, settings, money, reservations or PDF.
Adding reach means adding a wrapper here, which is a visible diff.

NO `from __future__ import annotations` (slowapi limiter router).
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.branch import Branch
from app.models.kitchen_link import KitchenLink
from app.routers.stand_link import _owner, _touch
from app.schemas.egenkontrol import EntryIn
from app.services import audit_service
from app.services import egenkontrol_service as S
from app.services.billing import enforce_feature
from app.utils.client_ip import client_ip
from app.utils.time import utc_now

router = APIRouter(prefix="/kitchen", tags=["Kitchen device"])
# Per-TOKEN buckets: one busy kitchen must not share a bucket with every other
# venue behind the same NAT, and a stolen token is throttled on its own.
def _token_key(request: Request) -> str:
    # slowapi passes the request only to a key_func whose parameter is named
    # `request`.
    return "kt:" + (request.path_params.get("token") or client_ip(request))


limiter = Limiter(key_func=_token_key, key_style="endpoint")


def resolve_kitchen(db: Session, token: str) -> KitchenLink:
    """Token → live KitchenLink, or 404 for every failure (no oracle)."""
    if not token or len(token) > 128:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    link = (
        db.query(KitchenLink)
        .filter(KitchenLink.token == token, KitchenLink.active.is_(True))
        .first()
    )
    if link is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return link


def _bind(db: Session, token: str):
    link = resolve_kitchen(db, token)
    owner = _owner(db, link)
    _touch(db, link)
    enforce_feature(owner, S.FEATURE)
    return link, owner


def _branch_name(db: Session, link: KitchenLink) -> Optional[str]:
    if link.branch_id is None:
        return None
    b = db.query(Branch).filter(Branch.id == link.branch_id).first()
    return b.name if b is not None else None


@router.get("/{token}/today")
@limiter.limit("30/minute")
def kitchen_today(token: str, request: Request, db: Session = Depends(get_db)):
    link, owner = _bind(db, token)
    out = S.build_today(db, owner, branch_scope=link.branch_id)
    out.update({
        "venue_name": getattr(owner, "business_name", None),
        "device_label": link.label,
        "branch_name": _branch_name(db, link),
    })
    return out


@router.get("/{token}/staff")
@limiter.limit("30/minute")
def kitchen_staff(token: str, request: Request, db: Session = Depends(get_db)):
    _, owner = _bind(db, token)
    return S.staff_choices(db, owner)


@router.post("/{token}/entries", status_code=201)
@limiter.limit("60/minute")
def kitchen_save_entry(token: str, payload: EntryIn, request: Request, response: Response,
                       db: Session = Depends(get_db)):
    link, owner = _bind(db, token)
    out, replayed = S.save_entry(db, owner, payload, via="kitchen", kitchen_link=link,
                                 actor_user_id=None, branch_scope=link.branch_id)
    if replayed:
        response.status_code = 200
        out = {**out, "replayed": True}
    return out


@router.post("/{token}/entries/{entry_id}/undo")
@limiter.limit("30/minute")
def kitchen_undo_entry(token: str, entry_id: UUID, request: Request,
                       db: Session = Depends(get_db)):
    link, owner = _bind(db, token)
    return S.undo_entry(db, owner, entry_id, kitchen_link=link)


@router.get("/{token}/folder")
@limiter.limit("10/minute")
def kitchen_folder(token: str, request: Request,
                   days: int = Query(default=30, ge=1, le=30),
                   db: Session = Depends(get_db)):
    """The Kontrolmappe on site, read-only. No PDF route on this surface."""
    link, owner = _bind(db, token)
    date_from, date_to = S.default_range(db, owner, days=days)
    return S.build_folder(db, owner, date_from, date_to, link.branch_id)


@router.post("/{token}/unpair")
@limiter.limit("10/minute")
def kitchen_unpair(token: str, request: Request, db: Session = Depends(get_db)):
    """"Afbryd denne iPad" — the device switches off its own link. Only ever
    REDUCES reach; a second call 404s like any dead token."""
    link = resolve_kitchen(db, token)
    owner = _owner(db, link)
    link.active = False
    link.revoked_at = utc_now()
    audit_service.record(db, owner, "kitchen.link_unpaired", "kitchen_link", link.id,
                         before={"active": True}, after={"active": False},
                         actor_type="kitchen_device")
    db.commit()
    return {"ok": True}
