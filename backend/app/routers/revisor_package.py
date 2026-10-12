"""Revisorpakke + Månedsafslutning — the period handoff to the revisor.

Owner-only (/api/revisor-package is in main._MEMBER_READ_DENY_PREFIXES; a
delegated seat's writes are default-denied by the member write guard; the
revisor's own read-only login can read, never send or change the schedule).

  GET  /checklist?start&end     the month-end checklist (open items + links)
  GET  /download?start&end      the package ZIP — EVERY tier (accountant-grade
                                artifacts are the same at any tier)
  GET  /summary.pdf?start&end   the package's summary PDF on its own
  POST /send                    e-mail it to the saved revisor now
                                (accountant_month_end_bundle; Starter+)
  GET  /settings · PUT /settings   the "Send revisorpakke" schedule
  GET  /sends                   what went, when, to whom — and what was skipped

The public, signed 14-day download link the revisor gets lives in
public_router (mounted at /api/public/revisor-package).
"""
# NO `from __future__ import annotations` here: with slowapi's @limit wrapper
# FastAPI cannot resolve the deferred annotations and every query parameter
# 422s (gotcha: future-annotations + slowapi).
import hashlib
import html as _html
import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, field_validator
from slowapi import Limiter
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.revisor_package import RevisorPackageSend
from app.models.user import User
from app.services import revisor_package as rp
from app.services.auth import get_current_user
from app.utils.client_ip import client_ip
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()
public_router = APIRouter()
_limiter = Limiter(key_func=client_ip)


def _period(start: date | None, end: date | None) -> tuple[date, date]:
    if start is None or end is None:
        raise HTTPException(status_code=422, detail="start and end are required")
    try:
        rp.validate_period(start, end)
    except ValueError as e:
        code = str(e)
        raise HTTPException(status_code=422, detail={
            "code": code,
            "message": (f"A package covers at most {rp.MAX_PERIOD_DAYS} days."
                        if code == "period_too_long" else "The period is not valid."),
            "message_da": (f"En pakke dækker højst {rp.MAX_PERIOD_DAYS} dage."
                           if code == "period_too_long" else "Perioden er ikke gyldig."),
        })
    return start, end


def _demo_fence(db: Session, user: User, profile, start: date, end: date) -> None:
    """No revisor document is made from sample rows under the owner's own
    name and CVR — the same refusal as the bookkeeping export."""
    from app.services.revisor_mail import demo_in_period_document_error, demo_rows_under_own_identity
    n = demo_rows_under_own_identity(db, user, profile, start, end)
    if n:
        raise demo_in_period_document_error(n)


@router.get("/checklist")
@_limiter.limit("30/minute")
def checklist(
    request: Request,
    start: date = Query(...),
    end: date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Månedsafslutning: what is still open for the period, each item with
    the screen that fixes it — plus whether the package can be sent now."""
    s, e = _period(start, end)
    profile = rp.profile_of(db, user)
    out = rp.build_checklist(db, user, s, e)
    from app.services import revisor_mail as rm
    from app.services.billing import has_feature
    sched = getattr(profile, "revisor_package_schedule", None) if profile else None
    out["send"] = {
        "entitled": has_feature(user, "accountant_month_end_bundle"),
        "blocker": rp.send_blocker(db, user, profile, s, e),
        "revisor_email": rm.saved_revisor_address(profile) or None,
        # The owner's "Send revisorpakke" choice, so the page says it is on.
        "schedule": sched if sched in rp.SCHEDULES else "never",
    }
    out["last_sends"] = [x for x in rp.last_sends(db, user, limit=10)
                         if x["period_start"] == s.isoformat() and x["period_end"] == e.isoformat()][:3]
    return out


@router.get("/download")
@_limiter.limit("6/minute;60/day")
def download(
    request: Request,
    start: date = Query(...),
    end: date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The whole package as a ZIP — for the owner's own mail, any tier."""
    from app.services.bonbox_pdf_kit import write_export_audit_row
    from app.services.revisor_mail import content_disposition
    s, e = _period(start, end)
    profile = rp.profile_of(db, user)
    _demo_fence(db, user, profile, s, e)
    build = rp.build_package(db, user, s, e)
    try:
        write_export_audit_row(
            db, user, doc_type="revisor_package_zip", bilagsnummer=build.doc_number,
            doc_hash=build.zip_sha256,
            period={"from": s.isoformat(), "to": e.isoformat(), "n_bilag": build.n_bilag,
                    "open_items": build.checklist["open_count"]},
            ip_address=client_ip(request),
        )
    except BaseException:
        build.close()
        raise
    # Streamed from the spooled file (memory holds one chunk, not the ZIP),
    # and the temp file is removed once the response is sent.
    return StreamingResponse(
        build.iter_zip(), media_type="application/zip",
        headers={"Content-Disposition": content_disposition(build.zip_filename),
                 "Content-Length": str(build.zip_size),
                 "Cache-Control": "private, no-store"},
        background=BackgroundTask(build.close),
    )


@router.get("/summary.pdf")
@_limiter.limit("10/minute")
def summary_pdf(
    request: Request,
    start: date = Query(...),
    end: date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.services.bonbox_pdf_kit import write_export_audit_row
    from app.services.revisor_mail import content_disposition
    s, e = _period(start, end)
    profile = rp.profile_of(db, user)
    _demo_fence(db, user, profile, s, e)
    build = rp.build_package(db, user, s, e, include_bilag=False)
    build.close()
    write_export_audit_row(
        db, user, doc_type="revisor_package_summary_pdf", bilagsnummer=build.doc_number,
        period={"from": s.isoformat(), "to": e.isoformat()},
        ip_address=client_ip(request),
    )
    return Response(
        content=build.summary_pdf, media_type="application/pdf",
        headers={"Content-Disposition": content_disposition(build.pdf_filename),
                 "Cache-Control": "private, no-store"},
    )


class SendRequest(BaseModel):
    start: date
    end: date
    # One tap = one send: the same key again answers with what happened.
    key: str | None = None

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        if v is None:
            return None
        v = str(v).strip()
        if not v:
            return None
        if len(v) > 64 or not all(c.isalnum() or c in "-_" for c in v):
            raise ValueError("invalid key")
        return v


def _send_view(row: RevisorPackageSend, user: User, *, replayed: bool = False) -> dict:
    return {
        "ok": row.status == "sent", "replayed": replayed, "status": row.status,
        "send_id": str(row.id), "sent_to": row.recipient,
        "sent_at": row.sent_at.isoformat() if row.sent_at else None,
        "open_items": row.open_items, "n_bilag": row.n_bilag,
        "link_expires_at": row.link_expires_at.isoformat() if row.link_expires_at else None,
        # The owner's local date the link works through — what the mail says.
        "link_expires_on": rp.link_local_date(user, row.link_expires_at),
        "period_start": row.period_start.isoformat(), "period_end": row.period_end.isoformat(),
    }


_UNCLEAR = {
    "code": "email_unclear",
    "message": ("Couldn't confirm that the mail reached your revisor. Ask them before you "
                "send it again — you can still download the package."),
    "message_da": ("Vi kunne ikke bekræfte, at mailen nåede frem til revisoren. Spørg "
                   "revisoren, før du sender igen — du kan stadig hente pakken."),
}


@router.post("/send")
@_limiter.limit("5/minute")
def send_now(
    request: Request,
    body: SendRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """E-mail the package to the saved revisor now. If items are open the
    mail lists them — it is never held back or dressed up as ready.

    Walls, in the order the other revisor sends use: plan (402) → the saved,
    real revisor address that has not opted out (400/409) → no sample rows
    in the period (422) → the owner's own e-mail confirmed (403) → the shared
    daily revisor-mail cap (429). The download works whatever happens here."""
    from app.services import revisor_mail as rm
    from app.services.billing import feature_locked_detail, has_feature
    s, e = _period(body.start, body.end)
    if not has_feature(user, "accountant_month_end_bundle"):
        raise HTTPException(status_code=402, detail=feature_locked_detail(user, "accountant_month_end_bundle"))
    dedup = f"manual:{body.key}" if body.key else None
    if dedup:
        prior = (db.query(RevisorPackageSend)
                 .filter(RevisorPackageSend.user_id == user.id, RevisorPackageSend.dedup_key == dedup)
                 .first())
        if prior is not None:
            if prior.period_start != s or prior.period_end != e:
                raise HTTPException(status_code=409, detail={
                    "code": "send_key_reused",
                    "message": "That send key belongs to another period. Nothing was sent — try again.",
                    "message_da": "Den nøgle hører til en anden periode. Intet er sendt — prøv igen.",
                })
            if prior.status == "sent":
                return _send_view(prior, user, replayed=True)
            if prior.status == "claimed":
                from app.jobs.revisor_package_job import STALE_CLAIM
                if utc_now() - (prior.updated_at or prior.created_at) > STALE_CLAIM:
                    # That attempt never finished — it may have gone out.
                    raise HTTPException(status_code=409, detail=_UNCLEAR)
                raise HTTPException(status_code=409, detail={
                    "code": "in_progress",
                    "message": "This package is being sent right now.",
                    "message_da": "Pakken er ved at blive sendt.",
                })
    profile = rp.profile_of(db, user)
    recipient = rm.resolve_revisor_recipient(profile, None, user=user)
    n_demo = rm.demo_rows_in_period(db, user.id, s, e)
    if n_demo:
        raise rm.demo_in_period_error(n_demo)
    rm.require_verified_revisor_sender(user)
    rm.enforce_revisor_daily_cap(db, user)

    now = utc_now()
    row = None
    if dedup:
        row = (db.query(RevisorPackageSend)
               .filter(RevisorPackageSend.user_id == user.id, RevisorPackageSend.dedup_key == dedup)
               .first())
    in_progress = HTTPException(status_code=409, detail={
        "code": "in_progress", "message": "This package is being sent right now.",
        "message_da": "Pakken er ved at blive sendt.",
    })
    if row is None:
        row = RevisorPackageSend(
            user_id=user.id, period_kind=rp.period_kind_of(s, e), period_start=s, period_end=e,
            send_trigger="manual", recipient=recipient,
            recipient_fp=rm.address_fingerprint(rm.mailbox_address(recipient)),
            dedup_key=dedup, status="claimed", attempts=1, created_at=now, updated_at=now,
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise in_progress
    else:
        # Re-using a failed key: compare-and-swap, so two concurrent taps
        # with the same key cannot both claim (and both mail).
        if row.status == "failed" and (row.error or "").startswith(("mail_unclear", "stale_claim")):
            raise HTTPException(status_code=409, detail=_UNCLEAR)
        seen_status, seen_attempts = row.status, row.attempts or 0
        won = (db.query(RevisorPackageSend)
               .filter(RevisorPackageSend.id == row.id,
                       RevisorPackageSend.status == seen_status,
                       RevisorPackageSend.attempts == seen_attempts)
               .update({"status": "claimed", "attempts": seen_attempts + 1, "updated_at": now},
                       synchronize_session=False))
        db.commit()
        if won != 1:
            raise in_progress
    db.refresh(row)
    try:
        rp.deliver(db, user, profile, row, now=now)
    except Exception as exc:  # noqa: BLE001 — nothing is KNOWN to have gone out
        code = exc.code if isinstance(exc, rp.PackageDeliveryError) else type(exc).__name__
        detail = getattr(exc, "detail", "") or ""
        if not isinstance(exc, rp.PackageDeliveryError):
            logger.exception("revisor package send failed for user=%s", user.id)
        db.rollback()
        row = db.query(RevisorPackageSend).filter(RevisorPackageSend.id == row.id).first()
        if row is not None:
            rp.mark_failed(row, exc, utc_now())
            db.commit()
        if code == "mail_unclear":
            logger.error("revisor package mail outcome unclear for user=%s: %s", user.id, detail)
            raise HTTPException(status_code=502, detail=_UNCLEAR)
        if code == "too_large":
            raise HTTPException(status_code=413, detail={
                "code": "package_too_large", "size": detail,
                "message": f"The package is too large to send as a link ({detail}). Download it and share it yourself.",
                "message_da": f"Pakken er for stor til et link ({detail}). Hent den og del den selv.",
            })
        not_configured = code == "mail" and detail == "email_not_configured"
        raise HTTPException(status_code=503 if (not_configured or code == "storage") else 502, detail={
            "code": "email_send_failed" if code == "mail" else "package_send_failed",
            "reason": detail or code,
            "message": "Couldn't send the package right now. You can still download it.",
            "message_da": "Pakken kunne ikke sendes lige nu. Du kan stadig hente den.",
        })
    db.commit()
    db.refresh(row)
    return _send_view(row, user)


class SettingsRequest(BaseModel):
    schedule: str

    @field_validator("schedule")
    @classmethod
    def _schedule(cls, v):
        v = (v or "").strip().lower()
        if v not in ("never", "weekly", "monthly"):
            raise ValueError("schedule must be never, weekly or monthly")
        return v


def _settings_view(db: Session, user: User, profile) -> dict:
    from app.services import revisor_mail as rm
    from app.services.billing import has_feature
    from app.services.gavekort_moms import _tz_user
    from app.services.tz_utils import _user_cutoff_hour, _user_zone
    from app.jobs.revisor_package_job import due_period, next_due_period, period_settled
    sched = (getattr(profile, "revisor_package_schedule", None) or "never") if profile else "never"
    if sched not in rp.SCHEDULES:
        sched = "never"
    nxt = None
    blocker = None
    if sched in rp.SCHEDULES:
        # The NEXT period this schedule sends: the current one if it fell due
        # after the owner switched it on and is not settled yet (sent — by
        # the schedule, or by hand after it ended — or given up), else the one
        # that falls due next. Same rules as the job.
        now = utc_now()
        tzu = _tz_user(db, user)
        zone, cutoff = _user_zone(tzu), _user_cutoff_hour(tzu)
        cur = due_period(sched, now, zone, cutoff)
        nxt_due = next_due_period(sched, now, zone, cutoff)
        if (cur and profile.revisor_package_schedule_at
                and profile.revisor_package_schedule_at <= cur[3]
                and not period_settled(db, user.id, cur[1], cur[2], zone, cutoff)):
            nxt_due = cur
        if nxt_due:
            nxt = {"kind": nxt_due[0], "start": nxt_due[1].isoformat(), "end": nxt_due[2].isoformat(),
                   "label": rp.period_label(nxt_due[1], nxt_due[2], nxt_due[0]),
                   "due_at": nxt_due[3].isoformat() + "Z"}
            blocker = rp.send_blocker(db, user, profile, nxt_due[1], nxt_due[2])
    return {
        "schedule": sched,
        "schedule_at": (profile.revisor_package_schedule_at.isoformat()
                        if profile and profile.revisor_package_schedule_at else None),
        "entitled": has_feature(user, "accountant_month_end_bundle"),
        "revisor_email": rm.saved_revisor_address(profile) or None,
        "revisor_name": getattr(profile, "accountant_name", None) if profile else None,
        "revisor_is_demo": bool(profile and rm.is_demo_revisor(profile)),
        "revisor_opted_out": bool(profile and rm.revisor_opted_out(profile)),
        "sender_held": rm.held_sender_reason(user),
        "next": nxt,
        "blocker": blocker,
        "last_sends": rp.last_sends(db, user, limit=5),
    }


@router.get("/settings")
def get_settings(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _settings_view(db, user, rp.profile_of(db, user))


@router.put("/settings")
@_limiter.limit("20/minute")
def put_settings(
    request: Request,
    body: SettingsRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Aldrig / Hver uge / Hver måned. Turning it on needs the plan that
    sends (402 otherwise — the owner can always download). The revisor's
    address is the one saved on Profile; the answer says what would stop the
    next send (no revisor, unconfirmed e-mail …) so the page can say so now."""
    from app.models.business_profile import BusinessProfile
    from app.services.audit_service import record as audit_record
    from app.services.billing import feature_locked_detail, has_feature
    if body.schedule != "never" and not has_feature(user, "accountant_month_end_bundle"):
        raise HTTPException(status_code=402, detail=feature_locked_detail(user, "accountant_month_end_bundle"))
    profile = rp.profile_of(db, user)
    if profile is None:
        profile = BusinessProfile(user_id=user.id)
        db.add(profile)
        db.flush()
    before = profile.revisor_package_schedule or "never"
    new = None if body.schedule == "never" else body.schedule
    if (profile.revisor_package_schedule or None) != new:
        profile.revisor_package_schedule = new
        profile.revisor_package_schedule_at = utc_now() if new else None
        audit_record(db, user, rp.SCHEDULE_ACTION, "business_profile", entity_id=profile.id,
                     before={"schedule": before}, after={"schedule": body.schedule},
                     ip_address=client_ip(request))
    db.commit()
    db.refresh(profile)
    return _settings_view(db, user, profile)


@router.get("/sends")
def list_sends(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return rp.last_sends(db, user, limit=limit)


# ─── The revisor's download link (public, signed, 14 days) ───────────────

def _page(title: str, text: str, status: int) -> HTMLResponse:
    body = (
        "<!doctype html><html lang='da'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<meta name='robots' content='noindex'>"
        f"<title>{_html.escape(title)}</title></head>"
        "<body style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;max-width:520px;margin:64px auto;padding:0 20px;line-height:1.5;'>"
        f"<h1 style='font-size:20px;'>{_html.escape(title)}</h1>"
        f"<p>{_html.escape(text)}</p>"
        "<p style='color:#6b7280;font-size:13px;'>BonBox</p></body></html>"
    )
    return HTMLResponse(content=body, status_code=status,
                        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


@public_router.get("/{token}")
@_limiter.limit("30/minute")
def public_download(token: str, request: Request, db: Session = Depends(get_db)):
    """The ZIP that was e-mailed — exactly those bytes (sha-checked), for 14
    days. The token is the only credential and names the send; the send names
    the stored file. Expired → 410 with how to get a new one."""
    from app.models.business_profile import BusinessProfile
    from app.services.audit_service import record as audit_record
    from app.services.revisor_mail import content_disposition
    from app.services.storage import get_storage
    payload = rp.parse_link_token(token, allow_expired=True)
    if not payload:
        return _page("Linket virker ikke", "Linket til revisorpakken er ugyldigt.", 404)
    try:
        sid = uuid.UUID(str(payload["s"]))
        uid = uuid.UUID(str(payload["u"]))
    except (ValueError, KeyError):
        return _page("Linket virker ikke", "Linket til revisorpakken er ugyldigt.", 404)
    row = (db.query(RevisorPackageSend)
           .filter(RevisorPackageSend.id == sid, RevisorPackageSend.user_id == uid).first())
    # "sent" — or a send whose mail may have arrived (mail_unclear keeps the
    # ZIP behind its link so a revisor who got it is not left with a dead link).
    linked = row is not None and (
        row.status == "sent"
        or (row.status == "failed" and (row.error or "").startswith("mail_unclear")))
    if not linked or not row.storage_key:
        return _page("Linket virker ikke", "Linket til revisorpakken er ugyldigt.", 404)
    user = db.query(User).filter(User.id == uid).first()
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == uid).first()
    biz = rp.business_name(profile, user)
    now = utc_now()
    if payload.get("expired") or row.purged_at or (row.link_expires_at and row.link_expires_at < now):
        return _page("Linket er udløbet",
                     f"Linket til revisorpakken fra {biz} virker ikke længere. "
                     f"Bed {biz} sende pakken igen fra BonBox.", 410)
    try:
        data = get_storage().get(row.storage_key)
    except Exception:  # noqa: BLE001
        data = None
    if not data or hashlib.sha256(data).hexdigest() != row.zip_sha256:
        logger.warning("revisor package %s: stored ZIP missing or changed", row.id)
        return _page("Pakken findes ikke længere",
                     f"Revisorpakken kan ikke hentes. Bed {biz} sende den igen fra BonBox.", 410)
    try:
        with db.begin_nested():
            audit_record(db, user, rp.DOWNLOAD_ACTION, "revisor_package", entity_id=row.id,
                         after={"send_id": str(row.id), "zip_sha256": row.zip_sha256},
                         ip_address=client_ip(request), actor_type="public.revisor_link")
        db.commit()
    except Exception:  # noqa: BLE001 — the download must not fail on its audit row
        db.rollback()
    filename = (f"Revisorpakke_{rp._safe_name(biz)}_"
                f"{rp.period_file_label(row.period_start, row.period_end, row.period_kind)}.zip")
    return Response(
        content=data, media_type="application/zip",
        headers={"Content-Disposition": content_disposition(filename),
                 "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex"},
    )
