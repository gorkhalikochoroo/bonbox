"""
Egenkontrol R1a + R1b — owner routes (/api/egenkontrol/*). Documents and
photos (multipart uploads + byte proxies) live in routers/egenkontrol_files.py
under the same prefix.

NO `from __future__ import annotations` in this file: it uses slowapi
@limiter decorators, and string annotations make FastAPI read request bodies
as query parameters (a silent 422). Bodies live in app/schemas/egenkontrol.py.

WHO MAY DO WHAT (plan C2/C3):
  • accountant view — 403 {"code":"accountant_no_access"} on EVERY route,
    reads included.
  • writes (setup, checks, entries, undo, devices) — the owner only. Invited
    members are already refused by the accountant_write_guard middleware
    (read_only); _require_owner is the belt-and-braces second layer.
  • the Kontrolmappe and its PDF — owner and manager (role checked HERE: the
    member/manager read deny tuples are one shared set and stay untouched).
  • today / status / templates — every seat.
  • a shared ("Delt enhed") tablet logged in as the owner: the folder, PDF,
    device list and every config write need the reveal PIN — enforced by
    main.py's shared_device_pin_gate through its OWN tuples. Readings and undo
    stay open there (it is the counter device) and are marked via="shared".

R1b:
  • owner only: settings PUT, "Fra papir" (/paper-entries), corrections
    (/corrections), marking a week reviewed. Their own path roots, so the
    shared-device gate can prefix-match them (PIN on a curtained tablet).
  • owner + manager: settings GET, the week card (GET /week).
  • the folder and PDF take up to 92 days (default the last 30).
"""

import secrets
from datetime import date, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.kitchen_link import KitchenLink
from app.models.stand_link import StandLink
from app.models.user import User
from app.routers import stand_link as stand_link_router
from app.schemas.egenkontrol import (
    CheckIn, CheckPatchIn, CorrectionIn, DeviceIn, EntryIn, PaperEntryIn, ReviewIn,
    SettingsIn, SetupIn,
)
from app.services import audit_service
from app.services import egenkontrol_records as REC
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S
from app.services import egenkontrol_settings as SET
from app.services import egenkontrol_week as W
from app.services.auth import get_current_user, is_accountant_view
from app.services.billing import enforce_feature
from app.utils.client_ip import client_ip
from app.utils.time import utc_now

router = APIRouter(prefix="/egenkontrol", tags=["Egenkontrol"])
limiter = Limiter(key_func=client_ip, key_style="endpoint")

_KITCHEN_CODE_TTL_MIN = 20


# ── Auth helpers ─────────────────────────────────────────────────────────

def _ek_user(user: User = Depends(get_current_user)) -> User:
    if is_accountant_view(user):
        raise HTTPException(status_code=403, detail={"code": "accountant_no_access"})
    enforce_feature(user, S.FEATURE)
    return user


def _role(user) -> str:
    return (getattr(user, "_actor_role", None) or "owner").lower()


def _require_owner(user) -> None:
    if _role(user) != "owner":
        raise HTTPException(status_code=403, detail={"code": "owner_only"})


def _require_folder_reader(user) -> None:
    if _role(user) not in ("owner", "manager"):
        raise HTTPException(status_code=403, detail={"code": "read_forbidden"})


def _actor_id(user):
    return getattr(user, "_real_actor_id", None) or user.id


def _via(user) -> str:
    return "shared" if getattr(user, "_shared_device", False) else "owner_app"


def _ip(request: Request) -> Optional[str]:
    return getattr(getattr(request, "client", None), "host", None)


def _range(db: Session, user, date_from: Optional[date], date_to: Optional[date]):
    """Default: the last FOLDER_DEFAULT_DAYS (30) business days. An explicit
    range may be up to FOLDER_MAX_DAYS (92); validate_range refuses more."""
    if date_to is None:
        _, date_to = S.default_range(db, user)
    if date_from is None:
        date_from = date_to - timedelta(days=R.FOLDER_DEFAULT_DAYS - 1)
    return date_from, date_to


# ── Reads (every seat) ───────────────────────────────────────────────────

@router.get("/status")
def ek_status(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    return S.build_status(db, user)


@router.get("/today")
def ek_today(
    branch_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(_ek_user),
):
    branch = S.resolve_branch(db, user, branch_id)
    return S.build_today(db, user, branch_scope=branch.id if branch else None)


@router.get("/templates")
def ek_templates(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    return S.templates_out(db, user)


# ── Configuration (owner) ────────────────────────────────────────────────

@router.post("/setup", status_code=201)
@limiter.limit("10/minute")
def ek_setup(payload: SetupIn, request: Request, db: Session = Depends(get_db),
             user: User = Depends(_ek_user)):
    _require_owner(user)
    return {"checks": S.setup(db, user, payload, actor_id=_actor_id(user))}


@router.get("/checks")
def ek_checks(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_folder_reader(user)
    return S.checks_list(db, user)


@router.post("/checks", status_code=201)
@limiter.limit("30/minute")
def ek_create_check(payload: CheckIn, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(_ek_user)):
    _require_owner(user)
    return S.create_check(db, user, payload, actor_id=_actor_id(user))


@router.patch("/checks/{check_id}")
@limiter.limit("60/minute")
def ek_patch_check(check_id: UUID, payload: CheckPatchIn, request: Request,
                   db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    return S.patch_check(db, user, check_id, payload, actor_id=_actor_id(user))


@router.post("/checks/{check_id}/archive")
@limiter.limit("30/minute")
def ek_archive_check(check_id: UUID, request: Request, db: Session = Depends(get_db),
                     user: User = Depends(_ek_user)):
    _require_owner(user)
    return S.archive_check(db, user, check_id, actor_id=_actor_id(user))


# ── Recording (owner, incl. a curtained shared tablet) ───────────────────

@router.get("/staff")
def ek_staff(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    return S.staff_choices(db, user)


@router.post("/entries", status_code=201)
@limiter.limit("60/minute")
def ek_save_entry(payload: EntryIn, request: Request, response: Response,
                  db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    out, replayed = S.save_entry(db, user, payload, via=_via(user),
                                 actor_user_id=_actor_id(user))
    if replayed:
        response.status_code = 200
        out = {**out, "replayed": True}
    return out


@router.post("/entries/{entry_id}/undo")
@limiter.limit("30/minute")
def ek_undo_entry(entry_id: UUID, request: Request, db: Session = Depends(get_db),
                  user: User = Depends(_ek_user)):
    _require_owner(user)
    return S.undo_entry(db, user, entry_id, actor_user_id=_actor_id(user))


# ── Kontrolmappe (owner + manager; shared tablet needs the reveal PIN) ───

@router.get("/folder")
def ek_folder(
    date_from: Optional[date] = Query(default=None, alias="from"),
    date_to: Optional[date] = Query(default=None, alias="to"),
    branch_id: Optional[UUID] = Query(default=None),
    include_readings: int = Query(default=0, ge=0, le=1),
    db: Session = Depends(get_db),
    user: User = Depends(_ek_user),
):
    _require_folder_reader(user)
    f, t = _range(db, user, date_from, date_to)
    return S.build_folder(db, user, f, t, branch_id, include_readings=bool(include_readings))


@router.get("/folder.pdf")
@limiter.limit("10/minute")
def ek_folder_pdf(
    request: Request,
    date_from: Optional[date] = Query(default=None, alias="from"),
    date_to: Optional[date] = Query(default=None, alias="to"),
    branch_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(_ek_user),
):
    from app.services.bonbox_pdf_kit import write_export_audit_row
    from app.services.egenkontrol_pdf import build_folder_pdf

    _require_folder_reader(user)
    f, t = _range(db, user, date_from, date_to)
    try:
        # Who made the file: a manager seat is named, never the owner.
        pdf, bilag, doc_hash = build_folder_pdf(
            db, user, f, t, branch_id,
            generator_email=getattr(user, "_real_actor_email", None) or user.email,
        )
    except R.RuleError as e:
        raise S.rule_http(e)
    write_export_audit_row(
        db, user, doc_type="egenkontrol_registreringer", bilagsnummer=bilag,
        doc_hash=doc_hash,
        period={"period_start": f.isoformat(), "period_end": t.isoformat()},
        ip_address=_ip(request),
        actor_id=_actor_id(user),
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition":
                f'attachment; filename="Kontrolmappe_{f.isoformat()}_{t.isoformat()}.pdf"',
        },
    )


# ── R1b: settings (findsmiley.dk link, retail opt-in) ────────────────────

@router.get("/settings")
def ek_settings(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_folder_reader(user)
    return SET.settings_out(db, user)


@router.put("/settings")
@limiter.limit("20/minute")
def ek_put_settings(payload: SettingsIn, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(_ek_user)):
    _require_owner(user)
    return SET.update_settings(db, user, payload, actor_user_id=_actor_id(user))


# ── R1b: "Fra papir" and corrections (owner only) ────────────────────────

@router.post("/paper-entries", status_code=201)
@limiter.limit("30/minute")
def ek_paper_entry(payload: PaperEntryIn, request: Request, response: Response,
                   db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    out, replayed = REC.save_paper_entry(db, user, payload, via=_via(user),
                                         actor_user_id=_actor_id(user))
    if replayed:
        response.status_code = 200
        out = {**out, "replayed": True}
    return out


@router.post("/corrections", status_code=201)
@limiter.limit("30/minute")
def ek_correct(payload: CorrectionIn, request: Request, response: Response,
               db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    out, replayed = REC.correct_entry(db, user, payload, actor_user_id=_actor_id(user))
    if replayed:
        response.status_code = 200
        out = {**out, "replayed": True}
    return out


# ── R1b: "Ugens egenkontrol" ─────────────────────────────────────────────

@router.get("/week")
def ek_week(
    start: Optional[date] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(_ek_user),
):
    _require_folder_reader(user)
    return W.build_week(db, user, start, role=_role(user))


@router.post("/week/{iso_week}/reviewed", status_code=201)
@limiter.limit("10/minute")
def ek_week_reviewed(iso_week: str, request: Request, response: Response,
                     payload: Optional[ReviewIn] = None,
                     db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    """The body is optional (name + note); an empty POST marks the week."""
    _require_owner(user)
    out, replayed = W.mark_reviewed(db, user, iso_week, payload or ReviewIn(),
                                    actor_user_id=_actor_id(user))
    if replayed:
        response.status_code = 200
        out = {**out, "replayed": True}
    return out


# ── Kitchen iPads (owner only) ───────────────────────────────────────────

def _code_in_use(db: Session, code: str) -> bool:
    return (
        db.query(KitchenLink.id).filter(KitchenLink.join_code == code).first() is not None
        or db.query(StandLink.id).filter(StandLink.join_code == code).first() is not None
    )


def _new_code(db: Session) -> str:
    """6 chars from the stand's 32-char alphabet, unique across BOTH device
    tables (both redeem at POST /api/stand/join); 8 tries, then 8 chars."""
    for _ in range(8):
        candidate = stand_link_router._gen_code()
        if not _code_in_use(db, candidate):
            return candidate
    return stand_link_router._gen_code(8)


@router.get("/devices")
def ek_devices(db: Session = Depends(get_db), user: User = Depends(_ek_user)):
    _require_owner(user)
    rows = (
        db.query(KitchenLink)
        .filter(KitchenLink.user_id == user.id)
        .order_by(KitchenLink.created_at.desc())
        .all()
    )
    now = utc_now()
    return {
        "devices": [
            {
                "id": str(r.id),
                "label": r.label,
                "branch_id": S._sid(r.branch_id),
                "active": bool(r.active),
                "paired": r.code_used_at is not None,
                "code": (
                    r.join_code
                    if (r.active and r.code_used_at is None
                        and r.code_expires_at and r.code_expires_at > now)
                    else None
                ),
                "created_at": S.iso_z(r.created_at),
                "last_seen_at": S.iso_z(r.last_seen_at),
                "revoked_at": S.iso_z(r.revoked_at),
            }
            for r in rows
        ]
    }


@router.post("/devices", status_code=201)
@limiter.limit("20/minute")
def ek_create_device(payload: DeviceIn, request: Request, db: Session = Depends(get_db),
                     user: User = Depends(_ek_user)):
    _require_owner(user)
    branch = S.resolve_branch(db, user, payload.branch_id)
    link = KitchenLink(
        user_id=user.id,
        branch_id=branch.id if branch else None,
        token=secrets.token_urlsafe(24),
        join_code=_new_code(db),
        code_expires_at=utc_now() + timedelta(minutes=_KITCHEN_CODE_TTL_MIN),
        label=(payload.label or None),
        active=True,
    )
    db.add(link)
    db.flush()
    audit_service.record(db, user, "kitchen.link_created", "kitchen_link", link.id,
                         after={"label": link.label, "branch_id": S._sid(link.branch_id)},
                         actor_id=_actor_id(user))
    db.commit()
    db.refresh(link)
    return {
        "id": str(link.id),
        "code": link.join_code,
        "expires_at": S.iso_z(link.code_expires_at),
        "expires_in_minutes": _KITCHEN_CODE_TTL_MIN,
        "label": link.label,
        "branch_id": S._sid(link.branch_id),
    }


@router.delete("/devices/{device_id}")
@limiter.limit("30/minute")
def ek_revoke_device(device_id: UUID, request: Request, db: Session = Depends(get_db),
                     user: User = Depends(_ek_user)):
    _require_owner(user)
    link = (
        db.query(KitchenLink)
        .filter(KitchenLink.id == device_id, KitchenLink.user_id == user.id)
        .first()
    )
    if link is None:
        raise S.not_found()
    link.active = False
    link.revoked_at = utc_now()
    audit_service.record(db, user, "kitchen.link_revoked", "kitchen_link", link.id,
                         before={"active": True}, after={"active": False},
                         actor_id=_actor_id(user))
    db.commit()
    return {"ok": True}
