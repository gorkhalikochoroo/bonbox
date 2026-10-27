"""The owner's spam clean-up for online bookings (R2, 27 Oct 2026).

Booking needs no account. When junk gets into the book anyway, the owner
cleans it up from the booking's drawer, and nothing reaches the address a
stranger typed:

  POST   /reservations/{id}/spam        mark ONE online booking as spam: it is
                                        cancelled with no mail to the guest,
                                        it stops counting towards the month's
                                        bookings, and its contact is marked
                                        (the next online booking from it is
                                        held quietly) — or, with block: true,
                                        blocked (refused online).
  POST   /reservations/{id}/spam/undo   the toast's "Fortryd" (30 minutes)
  GET    /spam-wave/{id}                the wave this open online request is
                                        part of: every open online request made
                                        within BOOKING_SPAM_WAVE_MINUTES of it
  POST   /spam-wave/{id}                decline that wave in one go, no mail
  GET    /contact-blocks                the blocked and marked contacts
                                        (masked: never the number or address)
  POST   /contact-blocks                block a phone or an e-mail — typed in,
                                        or a booking's own
  DELETE /contact-blocks/{entry_id}     unblock (?keep_mark=1: a block back to
                                        a spam mark — the undo of an upgrade)
  POST   /contact-blocks/erase          GDPR: remove every entry stored for a
                                        phone or an address

Storage, hashing, retention and the erase path: services/contact_marks.py.
"The month's quota back" needs no bookkeeping: the monthly cap counts only
bookings that exist (public_reservations._month_reservations_used counts
confirmed, seated, completed and no-show) — a booking marked as spam is
cancelled, so it stops counting the moment it is marked, and a Free venue's
page that a burst closed opens again.

Mounted at /api/reservations beside the reservations router (like
reservation_insights: kept out of that 3,800-line file).

Multi-barrier: L1 auth (get_current_user) · L2 tenant scope (every query on
user.id; another venue's booking is a 404) · L3 Pydantic bounds · L7
enforce_feature("reservations") · L8 audit rows — ids, statuses and counts,
never a name, an address or a number.

NOTE: no `from __future__ import annotations` (FastAPI's body resolver; see
tests/test_route_body_contract.py).
"""
import json
import logging
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services import audit_service, contact_marks
from app.services import reservation_occupancy_service as occ_service
from app.services import reservation_service as rsvc
from app.services.auth import get_current_user
from app.services.billing import enforce_feature, get_cap
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()

# The cancel_reason of a booking the owner marked as spam. The guest's
# receipt reads it as "cancelled by the venue" (public_reservations
# booking_outcome); the live alerts never chime for it (an owner's cancel);
# the monthly counts and the insights leave it out — it never was a booking
# (reservation_monthly.NOT_A_BOOKING).
SPAM_REASON = "owner_spam"
SPAM_ACTION = "reservation.marked_spam"
UNDO_ACTION = "reservation.spam_undone"
# Statuses a booking can be marked as spam from. A seated or finished party
# is a person in the room; a cancelled booking keeps its status (only its
# contact is marked).
SPAM_FROM = ("requested", "confirmed", "no_show")
UNDO_WINDOW = timedelta(minutes=30)
WAVE_MAX = 500


def _today():
    """The guest page's calendar day (Europe/Copenhagen) — the same day the
    public door reads the marks with."""
    from app.routers.public_reservations import _now_local
    return _now_local().date()


def _wave_minutes() -> int:
    try:
        n = int(app_config.BOOKING_SPAM_WAVE_MINUTES)
    except Exception:  # noqa: BLE001
        n = 10
    return max(1, min(n, 120))


def _owned(db: Session, user: User, reservation_id: UUID) -> Reservation:
    r = (
        db.query(Reservation)
        .filter(Reservation.id == reservation_id, Reservation.user_id == user.id,
                Reservation.is_deleted.is_(False))
        .first()
    )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return r


def _profile(db: Session, user: User) -> BusinessProfile:
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    if profile is None:
        profile = BusinessProfile(user_id=user.id)
        db.add(profile)
        db.flush()
    return profile


def _entries(profile: BusinessProfile) -> list:
    return rsvc.load_settings(profile).get(contact_marks.KEY) or []


def _save_entries(profile: BusinessProfile, entries: list) -> None:
    merged = rsvc.load_settings(profile)
    merged[contact_marks.KEY] = entries
    profile.reservation_settings_json = json.dumps(merged)


def _month_cap(db: Session, user: User) -> dict:
    """The plan's monthly numbers as GET /settings gives them, so the book's
    plan-cap banner updates the moment spam gives the quota back."""
    try:
        from app.routers.reservations import _month_cap_mode, _month_usage
        return {
            "reservations_used_this_month": _month_usage(db, user),
            "reservations_cap": get_cap(user, "reservations_per_month"),
            "month_cap_mode": _month_cap_mode(),
        }
    except Exception:  # noqa: BLE001 — context for a banner, never a 500
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return {}


# ── One booking ──────────────────────────────────────────────────────────

class SpamMark(BaseModel):
    # Block the contact as well (refused online from now on), instead of only
    # marking it (its next online booking is held quietly for a look).
    block: bool = False


@router.post("/reservations/{reservation_id}/spam")
def mark_spam(reservation_id: UUID, payload: SpamMark | None = Body(default=None),
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Mark an online booking as spam: cancelled with no mail to the guest,
    out of the month's count, its contact marked — or blocked."""
    enforce_feature(user, "reservations")
    r = _owned(db, user, reservation_id)
    if r.source != "public":
        # The owner typed it, or it is a drop-in: nobody to mark.
        raise HTTPException(status_code=409, detail={"error": "not_online"})
    if r.status not in SPAM_FROM and r.status != "cancelled":
        raise HTTPException(status_code=409, detail={"error": "not_spam_state", "status": r.status})
    block = bool(payload.block) if payload is not None else False
    prev = r.status
    if prev != "cancelled":
        # Silently: no guest mail is queued here — this is not the status
        # endpoint and it sends nothing. The table or chair is freed.
        r.status = "cancelled"
        r.cancelled_at = utc_now()
        r.cancel_reason = SPAM_REASON
        occ_service.release_occupancy(db, r.id)
    profile = _profile(db, user)
    today = _today()
    entries, created, upgraded = contact_marks.add(
        _entries(profile), user.id, email=r.guest_email, phone=r.guest_phone,
        mode="block" if block else "spam", today=today)
    _save_entries(profile, entries)
    audit_service.record(db, user, SPAM_ACTION, "reservation", r.id,
                         after={"prev_status": prev, "block": block,
                                "created": created, "upgraded": upgraded})
    db.commit()

    from app.routers.reservations import _reservation_dict
    out = _reservation_dict(r)
    out["contact"] = {
        "mode": "block" if block else "spam",
        "entries": contact_marks.entries_for(entries, user.id, email=r.guest_email,
                                             phone=r.guest_phone),
        "created": created,
        "upgraded": upgraded,
    }
    out.update(_month_cap(db, user))
    # A table freed for real: the waiting parties that fit, as a cancel
    # shows them (read only — nobody is messaged).
    if prev == "confirmed":
        try:
            from app.routers.reservations import _local_date_of, _waitlist_matches
            out["waitlist_matches"] = _waitlist_matches(
                db, user, waitlist_date=_local_date_of(r.starts_at, user),
                capacity=int(r.party_size or 0))
        except Exception:  # noqa: BLE001
            out["waitlist_matches"] = []
    return out


@router.post("/reservations/{reservation_id}/spam/undo")
def undo_spam(reservation_id: UUID, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """The toast's "Fortryd": the booking gets its status back (a confirmed
    one its table, if still free) and the marks this spam made go again.
    Within UNDO_WINDOW of the mark."""
    enforce_feature(user, "reservations")
    r = _owned(db, user, reservation_id)
    # The newest spam mark or undo of this booking: an undo already made is
    # nothing to undo (audit rows are append-only, so the undo is a row too).
    row = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id, AuditLog.entity_type == "reservation",
                AuditLog.entity_id == r.id, AuditLog.action.in_((SPAM_ACTION, UNDO_ACTION)))
        .order_by(AuditLog.created_at.desc())
        .first()
    )
    if row is None or row.action != SPAM_ACTION:
        raise HTTPException(status_code=409, detail={"error": "not_spam"})
    if row.created_at is None or utc_now() - row.created_at > UNDO_WINDOW:
        raise HTTPException(status_code=409, detail={"error": "undo_expired"})
    try:
        after = json.loads(row.after_state or "{}")
    except (TypeError, ValueError):
        after = {}
    prev = after.get("prev_status")
    if r.status == "cancelled" and r.cancel_reason == SPAM_REASON and prev in SPAM_FROM:
        if prev == "confirmed":
            ids = [x for x in (r.combined_resource_ids or ([r.resource_id] if r.resource_id else [])) if x]
            if ids:
                from app.routers.reservations import _held_pick_free
                if not _held_pick_free(db, user, ids, r.starts_at, r.ends_at, r.id):
                    raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        r.status = prev
        r.cancelled_at = None
        r.cancel_reason = None
        if prev == "confirmed":
            occ_service.sync_occupancy_for_status(db, r)
    profile = _profile(db, user)
    today = _today()
    entries = _entries(profile)
    for eid in after.get("created") or []:
        entries, _ = contact_marks.remove(entries, str(eid), today=today)
    for eid in after.get("upgraded") or []:
        entries, _ = contact_marks.remove(entries, str(eid), today=today, keep_mark=True)
    _save_entries(profile, contact_marks.clean(entries, today))
    audit_service.record(db, user, UNDO_ACTION, "reservation", r.id,
                         after={"status": r.status})
    try:
        db.commit()
    except IntegrityError:
        # Postgres: the table was taken meanwhile (the exclusion constraint).
        db.rollback()
        raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
    from app.routers.reservations import _reservation_dict
    out = _reservation_dict(r)
    out.update(_month_cap(db, user))
    return out


# ── A wave ───────────────────────────────────────────────────────────────

def _wave(db: Session, user: User, anchor: Reservation, *, limit: int = WAVE_MAX + 1):
    """The open online requests made within the wave window of `anchor`
    (either side, the anchor included), oldest first. One query on the
    venue's own rows."""
    if anchor.source != "public" or anchor.status != "requested" or anchor.created_at is None:
        return []
    span = timedelta(minutes=_wave_minutes())
    return (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user.id,
            Reservation.source == "public",
            Reservation.status == "requested",
            Reservation.is_deleted.is_(False),
            Reservation.created_at >= anchor.created_at - span,
            Reservation.created_at <= anchor.created_at + span,
        )
        .order_by(Reservation.created_at)
        .limit(limit)
        .all()
    )


def _utc(ts) -> str | None:
    return ts.isoformat() + "Z" if ts else None


@router.get("/spam-wave/{reservation_id}")
def spam_wave(reservation_id: UUID, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """How big the wave around this open online request is — the drawer
    offers "Afvis alle" only from 2."""
    enforce_feature(user, "reservations")
    anchor = _owned(db, user, reservation_id)
    rows = _wave(db, user, anchor)
    capped = len(rows) > WAVE_MAX
    rows = rows[:WAVE_MAX]
    return {
        "count": len(rows),
        "ids": [str(x.id) for x in rows],
        "first_at": _utc(rows[0].created_at) if rows else None,
        "last_at": _utc(rows[-1].created_at) if rows else None,
        "minutes": _wave_minutes(),
        "capped": capped,
    }


class WaveReject(BaseModel):
    # The ids the owner was shown (GET /spam-wave): only these go, and only
    # while they are still open requests in the wave — a request that came
    # in after the owner looked is never declined unseen.
    ids: list[UUID] = Field(default_factory=list, max_length=WAVE_MAX)


@router.post("/spam-wave/{reservation_id}")
def reject_spam_wave(reservation_id: UUID, payload: WaveReject = Body(...),
                     db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Decline the wave in one go: every request cancelled as spam, no mail
    to any address it carries. Contacts are not marked (one by one only)."""
    enforce_feature(user, "reservations")
    anchor = _owned(db, user, reservation_id)
    wanted = {str(x) for x in payload.ids}
    rows = [x for x in _wave(db, user, anchor) if str(x.id) in wanted]
    if not rows:
        return {"rejected": 0, "ids": []}
    now = utc_now()
    audit_rows = []
    for x in rows:
        x.status = "cancelled"
        x.cancelled_at = now
        x.cancel_reason = SPAM_REASON
        occ_service.release_occupancy(db, x.id)
        audit_rows.append({"action": SPAM_ACTION, "entity_type": "reservation",
                           "entity_id": x.id,
                           "after": {"prev_status": "requested", "wave": True}})
    audit_service.record_many(db, user, audit_rows)
    db.commit()
    return {"rejected": len(rows), "ids": [str(x.id) for x in rows]}


# ── The block list ───────────────────────────────────────────────────────

def _listing(entries: list) -> dict:
    return {"blocks": contact_marks.public_list(entries),
            "max": contact_marks.max_entries(),
            "days": contact_marks.retention_days()}


def _fresh_entries(db: Session, profile: BusinessProfile) -> list:
    """The stored list, cleaned; an expired entry found here is dropped from
    the store too (the retention)."""
    raw = _entries(profile)
    cleaned = contact_marks.clean(raw, _today())
    if len(cleaned) != len(raw if isinstance(raw, list) else []):
        _save_entries(profile, cleaned)
        db.commit()
    return cleaned


@router.get("/contact-blocks")
def list_contact_blocks(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    return _listing(_fresh_entries(db, _profile(db, user)))


class ContactBlockCreate(BaseModel):
    reservation_id: UUID | None = None
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=255)


@router.post("/contact-blocks", status_code=201)
def add_contact_block(payload: ContactBlockCreate, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    """Block a phone or an e-mail: typed in, or a booking's own (its phone
    and its address both). 422 {error: "no_contact"} when nothing usable."""
    enforce_feature(user, "reservations")
    email, phone = payload.email, payload.phone
    if payload.reservation_id is not None:
        r = _owned(db, user, payload.reservation_id)
        email, phone = r.guest_email, r.guest_phone
    if not contact_marks.norm_email(email) and not contact_marks.norm_phone(phone):
        raise HTTPException(status_code=422, detail={"error": "no_contact"})
    profile = _profile(db, user)
    entries, created, upgraded = contact_marks.add(
        _entries(profile), user.id, email=email, phone=phone, mode="block", today=_today())
    _save_entries(profile, entries)
    audit_service.record(db, user, "reservation.contact_blocked", "business_profile", profile.id,
                         after={"created": created, "upgraded": upgraded,
                                "from_booking": payload.reservation_id is not None})
    db.commit()
    out = _listing(entries)
    out.update({"created": created, "upgraded": upgraded,
                "entries": contact_marks.entries_for(entries, user.id, email=email, phone=phone)})
    return out


@router.delete("/contact-blocks/{entry_id}")
def remove_contact_block(entry_id: str, keep_mark: bool = Query(default=False),
                         db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    entries, changed = contact_marks.remove(_entries(profile), entry_id[:16], today=_today(),
                                            keep_mark=keep_mark)
    if not changed:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    _save_entries(profile, entries)
    audit_service.record(db, user, "reservation.contact_unblocked", "business_profile", profile.id,
                         after={"id": entry_id[:16], "keep_mark": bool(keep_mark)})
    db.commit()
    return _listing(entries)


class ContactErase(BaseModel):
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=255)


@router.post("/contact-blocks/erase")
def erase_contact_block(payload: ContactErase, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """A guest asks to be forgotten (GDPR art. 17): every entry stored for
    that phone or address goes, whichever it was. The owner types what the
    guest gave them; nothing is shown back but the count."""
    enforce_feature(user, "reservations")
    if not contact_marks.norm_email(payload.email) and not contact_marks.norm_phone(payload.phone):
        raise HTTPException(status_code=422, detail={"error": "no_contact"})
    profile = _profile(db, user)
    entries, removed = contact_marks.erase_contact(
        _entries(profile), user.id, email=payload.email, phone=payload.phone, today=_today())
    if removed:
        _save_entries(profile, entries)
        audit_service.record(db, user, "reservation.contact_erased", "business_profile",
                             profile.id, after={"removed": removed})
        db.commit()
    out = _listing(entries)
    out["removed"] = removed
    return out
