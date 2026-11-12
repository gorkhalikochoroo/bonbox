"""Shift swap orchestration — peer-to-peer trading with owner approval.

State machine (status field on ShiftSwapRequest):

    proposed ──(to_staff accepts)──> done   (schedules atomically swapped)
        │
        ├──(to_staff declines)──> declined
        │
        ├──(from_staff withdraws)──> withdrawn
        │
        └──(shift date passes)──> expired

    NOTE (2026-06): a mutual accept now EXECUTES the swap immediately
    (status `done`) instead of parking at `accepted` for an owner step
    that had no UI. See respond_to_swap for the full rationale. The
    legacy `accepted`→`approved`/`denied` owner path (decide_swap) is
    retained for a future owner-approval UI but is no longer on the
    portal's critical path.

All transitions are one-way; terminal states never re-enter the flow.
A new swap requires a new ShiftSwapRequest row.

Multi-layer defense (each function pinned by tests):

  L1 — TENANT BOUNDARY
       Both staff + both shifts MUST share the same owner.
       Service rejects on any cross-owner mix.

  L2 — OWNERSHIP
       propose:  caller (token's staff) MUST own from_shift
       respond:  caller MUST be the to_staff
       decide:   caller MUST be the owner of the request

  L3 — DOMAIN VALIDATION
       • Neither shift may have STARTED (venue local time): start datetime
         <= now, overnight shifts included, or the staffer is already clocked
         in on it (ShiftSwapStarted -> 422 {"code": "shift_started"}). The
         old rule compared only the date with the server's date, so a shift
         that began at 09:00 could still be swapped or given away at 15:00.
       • from_staff != to_staff (no self-swap)
       • from_shift != to_shift (no swapping with itself)
       • Nobody ends up on two shifts at once — BOTH people are checked
         as they would be after the trade, at propose AND again at
         accept (ShiftSwapOverlap → 409)
       • Reason / owner_note bounded to 500 chars; control chars
         scrubbed (defense in depth — these eventually appear in
         email/push payloads)

  L4 — IDEMPOTENCY
       proposing the same (from_shift, to_staff, to_shift) twice
       returns the existing pending request instead of creating a
       duplicate. Stops the "tap → poor signal → tap again" double-
       trigger from spamming the responder's inbox.

  L5 — ATOMIC SCHEDULE FLIP
       On `approved`, both Schedule.staff_id values are updated in
       the SAME DB transaction. Either both flip or neither. No
       partial-flip state is reachable. Pinned by
       test_approve_atomically_swaps_schedules.

Future expansion (Phase 2 v2 / 3):
  • Give-away mode: to_staff_id + to_shift_id NULLABLE; first-claim
    wins via SELECT ... FOR UPDATE row lock
  • Auto-approve heuristic: same role + similar net hours + similar
    rate → bypass owner step
  • Cost-delta calculation: refuse swap that puts either staff > max_hours_week
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, time as time_cls, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import HoursLogged, Schedule, StaffMember
from app.utils.time import utc_now

log = logging.getLogger(__name__)


MAX_REASON_LEN = 500


class ShiftSwapError(ValueError):
    """Service-layer rejection. Routers map these to 4xx responses;
    they're never raised on a happy path."""


class ShiftSwapOverlap(ShiftSwapError):
    """The trade would put someone on two shifts at once.

    `who` is relative to the CALLER — "self" (the person asking) or
    "colleague" (the other party) — so the portal can say which of them
    is double-booked in the staffer's own language. Routers answer 409.
    Nothing about the colleague's roster beyond "they already work then"
    is revealed: no time, no other shift."""

    def __init__(self, message: str, *, who: str):
        super().__init__(message)
        self.who = who


class ShiftSwapStarted(ShiftSwapError):
    """The shift has already started in the venue's local time (overnight
    shifts included), or its staffer is already clocked in on it. Its own
    type so routers answer 422 {"code": "shift_started", "message": …}: the
    portal and the owner app say it in the staffer's language, and an older
    bundle shows the English `message` through errText. The message keeps the
    word "past" the old refusal used."""

    code = "shift_started"


SHIFT_STARTED_MESSAGE = "That shift has already started or is in the past, so it can't be swapped or given away."


class ShiftSwapStale(ShiftSwapError):
    """One of the two shifts moved between propose and accept, so the
    request was declined on the spot. Its own type so the portal can say so
    in the staffer's language — the row turns 'declined' under their thumb,
    and without a reason that reads as if the app declined it for them."""


# Every shift on the roster counts, drafts included — the same rule as the
# owner's add-shift guard (_find_overlapping_shift) and claim_giveaway's
# Guard 1. A draft is not visible in the portal, but the owner's next
# Publish turns it into a real shift with no overlap check, so a swap that
# ignored it double-booked someone one tap later. The 409 still says only
# "already has a shift then" — no time, no status.


def _abs_span(sched: Schedule) -> tuple[int, int]:
    """Minutes on one absolute timeline (date ordinal × 1440), overnight-aware
    via _spans — so a 22:00–02:00 shift collides with a 01:00 start next day."""
    s, e = _spans(sched)
    base = sched.date.toordinal() * 24 * 60
    return base + s, base + e


# ── Has the shift started? (venue local time) ─────────────────────────────

# The clock-in window can open at most 240 minutes before a shift
# (routers/staff.set_clock_geofence clamps it). Used when the owner has no
# window switched on: clock-in is then open any time.
_MAX_EARLY_CLOCK_IN_MIN = 240


def _venue_now(db: Session, owner_id: uuid.UUID) -> datetime:
    """Now in the venue's timezone (the owner's User.timezone), naive — the
    same wall clock Schedule.date + start_time are written in. `fold` is kept
    (1 on the second pass of the hour the clocks go back)."""
    from app.models.user import User
    from app.services.tz_utils import now_local
    owner = db.query(User).filter(User.id == owner_id).first()
    return now_local(owner).replace(tzinfo=None)


def _shift_start(sched: Schedule) -> Optional[datetime]:
    try:
        hh, mm = (int(x) for x in (sched.start_time or "").split(":")[:2])
        return datetime.combine(sched.date, time_cls(hh, mm))
    except (ValueError, TypeError):
        return None


def _early_clock_in_minutes(db: Session, owner_id: uuid.UUID) -> int:
    from app.models.business_profile import BusinessProfile
    try:
        prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner_id).first()
        d = json.loads(prof.clock_settings_json) if prof and prof.clock_settings_json else {}
        minutes = int(d.get("window_minutes") or 0)
        if d.get("window_enabled") and minutes > 0:
            return min(minutes, _MAX_EARLY_CLOCK_IN_MIN)
    except (ValueError, TypeError, AttributeError):
        pass
    return _MAX_EARLY_CLOCK_IN_MIN


def _venue_zone(db: Session, owner_id: uuid.UUID):
    from app.models.user import User
    from app.services.tz_utils import _user_zone
    return _user_zone(db.query(User).filter(User.id == owner_id).first())


def _punch_began(db: Session, punch: HoursLogged, now: datetime) -> Optional[datetime]:
    """When the open punch began, on the venue's wall clock. created_at is the
    exact clock-in instant (naive UTC; the portal's live counter reads it the
    same way). Without it, start_time on the latest day not after now."""
    if punch.created_at is not None:
        return (punch.created_at.replace(tzinfo=timezone.utc)
                .astimezone(_venue_zone(db, punch.user_id)).replace(tzinfo=None))
    try:
        hh, mm = (int(x) for x in (punch.start_time or "").split(":")[:2])
        began = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    except (ValueError, TypeError):
        return None
    return began - timedelta(days=1) if began > now else began


def _clocked_in_on(db: Session, sched: Schedule, start: datetime, now: datetime,
                   window: timedelta) -> bool:
    """Is the staffer's open clock punch the one for THIS shift? Only when it
    began inside this shift's clock-in window and no earlier shift of theirs
    was still running when they clocked in. A split shift's lunch punch
    (lunch 11–14, dinner 17–22) or a punch left open days ago is not the
    dinner shift's: dinner can still be swapped until it starts."""
    punch = (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == sched.user_id,
            HoursLogged.staff_id == sched.staff_id,
            HoursLogged.end_time.is_(None),
            HoursLogged.entry_method == "clock",
        )
        .order_by(HoursLogged.created_at.desc())
        .first()
    )
    if punch is None:
        return False
    began = _punch_began(db, punch, now)
    if began is None or began < start - window:
        return False
    # An earlier shift of theirs that had not ended when they clocked in owns
    # the punch (shifts the staffer can see: published or confirmed).
    began_min = began.date().toordinal() * 24 * 60 + began.hour * 60 + began.minute
    start_min = _abs_span(sched)[0]
    earlier = db.query(Schedule).filter(
        Schedule.user_id == sched.user_id,
        Schedule.staff_id == sched.staff_id,
        Schedule.id != sched.id,
        Schedule.status.in_(("published", "confirmed")),
        Schedule.date >= began.date() - timedelta(days=1),
        Schedule.date <= sched.date,
    ).all()
    for other in earlier:
        o_start, o_end = _abs_span(other)
        if o_start < start_min and o_end > began_min:
            return False
    return True


def shift_has_started(db: Session, sched: Schedule, *, now: Optional[datetime] = None) -> bool:
    """True when the shift's start (its date + start_time, venue local time)
    is now or earlier — an overnight shift that began yesterday evening
    counts, it began — or when its staffer is clocked in on it already (their
    open clock punch began inside this shift's clock-in window, and not
    during an earlier shift of theirs)."""
    now = now or _venue_now(db, sched.user_id)
    start = _shift_start(sched)
    if start is None:                    # malformed time: fall back to the date
        return sched.date < now.date()
    if start <= now:
        return True
    if getattr(now, "fold", 0) == 1:
        # The repeated hour when the clocks go back (02:00–03:00 runs twice).
        # On its second pass the wall clock reads earlier than a start it
        # already passed on the first: compare the instants. fold=0 = the
        # start's first occurrence.
        zone = _venue_zone(db, sched.user_id)
        if (start.replace(tzinfo=zone, fold=0).astimezone(timezone.utc)
                <= now.replace(tzinfo=zone).astimezone(timezone.utc)):
            return True
    window = timedelta(minutes=_early_clock_in_minutes(db, sched.user_id))
    if start - now <= window and _clocked_in_on(db, sched, start, now, window):
        return True
    return False


def _refuse_started(db: Session, *scheds: Schedule) -> None:
    if not scheds:
        return
    now = _venue_now(db, scheds[0].user_id)
    if any(shift_has_started(db, s, now=now) for s in scheds):
        raise ShiftSwapStarted(SHIFT_STARTED_MESSAGE)


def _lock_staff(db: Session, *staff_ids: uuid.UUID) -> None:
    """Row-lock these StaffMember rows (SELECT … FOR UPDATE, ascending id)
    until the transaction ends, so a roster read-check-write for them is not
    interleaved with another. A no-op on SQLite, which serialises writers."""
    ids = sorted({sid for sid in staff_ids if sid is not None}, key=str)
    if not ids:
        return
    db.query(StaffMember.id).filter(StaffMember.id.in_(ids)).order_by(
        StaffMember.id
    ).with_for_update().all()


def _double_booked(
    db: Session,
    *,
    owner_id: uuid.UUID,
    staff_id: uuid.UUID,
    incoming: Schedule,
    leaving_id: uuid.UUID,
) -> bool:
    """Would `staff_id` work two shifts at once after taking `incoming` and
    handing over `leaving_id`? Looks at the day before and after too, so an
    overnight shift on either side counts. Back-to-back (end == start) is
    allowed, same strict-< rule as claim_giveaway's overlap guard."""
    from datetime import timedelta

    rows = db.query(Schedule).filter(
        Schedule.user_id == owner_id,
        Schedule.staff_id == staff_id,
        Schedule.date >= incoming.date - timedelta(days=1),
        Schedule.date <= incoming.date + timedelta(days=1),
        Schedule.id != leaving_id,
        Schedule.id != incoming.id,
    ).all()
    a0, a1 = _abs_span(incoming)
    if a1 <= a0:
        return False
    for other in rows:
        b0, b1 = _abs_span(other)
        if a0 < b1 and b0 < a1:
            return True
    return False


def _refuse_double_booking(
    db: Session,
    *,
    owner_id: uuid.UUID,
    caller_staff_id: uuid.UUID,
    from_staff_id: uuid.UUID,
    from_sched: Schedule,
    to_staff_id: uuid.UUID,
    to_sched: Schedule,
) -> None:
    """Check BOTH people as they would be after the trade. The proposer takes
    to_sched and gives up from_sched; the colleague takes from_sched and gives
    up to_sched. Raises ShiftSwapOverlap naming who, relative to the caller."""
    def _who(staff_id):
        return "self" if staff_id == caller_staff_id else "colleague"

    if _double_booked(
        db, owner_id=owner_id, staff_id=from_staff_id,
        incoming=to_sched, leaving_id=from_sched.id,
    ):
        raise ShiftSwapOverlap(
            "This swap would put the person giving up the shift on two "
            "shifts at the same time.", who=_who(from_staff_id),
        )
    if _double_booked(
        db, owner_id=owner_id, staff_id=to_staff_id,
        incoming=from_sched, leaving_id=to_sched.id,
    ):
        raise ShiftSwapOverlap(
            "This swap would put the person taking the shift on two "
            "shifts at the same time.", who=_who(to_staff_id),
        )


def _scrub(text: Optional[str]) -> Optional[str]:
    """Strip ASCII control chars (except newline + tab) and bound length.
    Empty / whitespace-only collapses to None so column ends up cleanly
    NULL rather than empty-string.
    """
    if not text:
        return None
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
    if not cleaned:
        return None
    return cleaned[:MAX_REASON_LEN]


def _shift_belongs_to(
    db: Session, *, shift_id: uuid.UUID, owner_id: uuid.UUID, staff_id: uuid.UUID,
) -> Schedule:
    """Fetch a Schedule row and assert it belongs to BOTH the given
    owner AND the given staff. Raises ShiftSwapError on any mismatch.

    Why both? An owner-only check would let one staff propose a swap
    using another staff's shift_id (the proposer's owner happens to
    own that shift via the other staff). Adding the staff_id check
    closes that hole.
    """
    sched = db.query(Schedule).filter(
        Schedule.id == shift_id,
        Schedule.user_id == owner_id,
        Schedule.staff_id == staff_id,
    ).first()
    if not sched:
        # Same shape regardless of which check failed — no enumeration.
        raise ShiftSwapError("That shift doesn't belong to you.")
    return sched


def propose_swap(
    db: Session,
    *,
    owner_id: uuid.UUID,
    from_staff_id: uuid.UUID,
    from_shift_id: uuid.UUID,
    to_staff_id: uuid.UUID,
    to_shift_id: uuid.UUID,
    reason: Optional[str] = None,
) -> ShiftSwapRequest:
    """Sara proposes to swap her `from_shift_id` for Lars's `to_shift_id`.

    Caller (router) MUST already have validated that the magic-link
    token resolves to from_staff_id — this service trusts the staff
    identity passed in. It does NOT trust the shift_ids; both are
    re-validated here.
    """
    # L3: same-staff guard. Self-swap makes no semantic sense + would
    # hit the no-op branch later when we try to flip Schedule.staff_id
    # from X to X.
    if from_staff_id == to_staff_id:
        raise ShiftSwapError("You can't swap with yourself.")
    if from_shift_id == to_shift_id:
        raise ShiftSwapError("Pick a different shift to swap.")

    # L1 + L2: validate from_shift belongs to (owner, from_staff).
    from_sched = _shift_belongs_to(
        db, shift_id=from_shift_id, owner_id=owner_id, staff_id=from_staff_id,
    )

    # L1: validate to_staff is under the same owner.
    to_staff = db.query(StaffMember).filter(
        StaffMember.id == to_staff_id,
        StaffMember.user_id == owner_id,
        StaffMember.is_deleted.isnot(True),
        StaffMember.active.is_(True),
    ).first()
    if not to_staff:
        raise ShiftSwapError("Target staff not found.")

    # L1 + L2: validate to_shift belongs to (owner, to_staff).
    to_sched = _shift_belongs_to(
        db, shift_id=to_shift_id, owner_id=owner_id, staff_id=to_staff_id,
    )

    # L3: neither shift may have started (venue local time, overnight
    # included, or the staffer clocked in on it). Past shifts are history;
    # a started one is being worked. The old date-only check let a shift
    # that began at 09:00 be traded at 15:00 the same day.
    _refuse_started(db, from_sched, to_sched)

    # L3: neither person may end up on two shifts at once. An accept executes
    # the trade on the spot (no owner step), so this is the only check
    # standing between a picker mistake and a silent double booking.
    _refuse_double_booking(
        db, owner_id=owner_id, caller_staff_id=from_staff_id,
        from_staff_id=from_staff_id, from_sched=from_sched,
        to_staff_id=to_staff_id, to_sched=to_sched,
    )

    # L4: idempotency. If there's already a pending swap from this
    # staff with this exact (from_shift, to_staff, to_shift) tuple,
    # return it instead of creating a duplicate.
    existing = db.query(ShiftSwapRequest).filter(
        ShiftSwapRequest.user_id == owner_id,
        ShiftSwapRequest.from_staff_id == from_staff_id,
        ShiftSwapRequest.from_shift_id == from_shift_id,
        ShiftSwapRequest.to_staff_id == to_staff_id,
        ShiftSwapRequest.to_shift_id == to_shift_id,
        ShiftSwapRequest.status.in_(("proposed", "accepted")),
    ).first()
    if existing:
        # If proposer is updating reason on retry, accept the new info.
        new_reason = _scrub(reason)
        if new_reason and existing.reason != new_reason:
            existing.reason = new_reason
            db.commit()
            db.refresh(existing)
        return existing

    swap = ShiftSwapRequest(
        user_id=owner_id,
        from_staff_id=from_staff_id,
        from_shift_id=from_shift_id,
        to_staff_id=to_staff_id,
        to_shift_id=to_shift_id,
        status="proposed",
        reason=_scrub(reason),
    )
    db.add(swap)
    db.commit()
    db.refresh(swap)
    log.info(
        "[shift_swap] propose owner=%s from=%s shift=%s to=%s shift=%s",
        owner_id, from_staff_id, from_shift_id, to_staff_id, to_shift_id,
    )
    return swap


def respond_to_swap(
    db: Session,
    *,
    swap_id: uuid.UUID,
    responder_staff_id: uuid.UUID,
    accept: bool,
) -> ShiftSwapRequest:
    """to_staff accepts or declines the swap.

    Caller (router) MUST have validated that the magic-link token
    resolves to responder_staff_id; this service refuses if the swap's
    to_staff_id doesn't match the caller.

    Lifecycle (AUTO-EXECUTE on mutual accept — see note below):
      proposed + accept=True  → done   (schedules atomically swapped)
      proposed + accept=False → declined (terminal)
    Any other current status raises (re-responding to a settled swap
    is a logic error in the client).

    ─────────────────────────────────────────────────────────────────
    SWAP MODEL DECISION (2026-06): auto-execute-on-mutual-accept.

    The original design routed accepted swaps through an owner-approval
    step (`accepted` → owner calls decide_swap → `approved` flips the
    schedules). But the STAFF PORTAL is the only surface staff have, and
    there is NO owner-facing approval UI wired anywhere — so every
    accepted swap *stalled* at `accepted` forever and the two shifts were
    never reassigned. The portal even told staff "awaiting owner
    approval", which was a promise nothing could fulfil.

    Both staff explicitly agreeing (proposer offered + target accepted)
    is a genuine mutual handshake. We therefore EXECUTE the swap the
    moment the target accepts: flip Schedule.staff_id on both shifts in
    one transaction (same atomic guarantee decide_swap had), mark the
    request `done`, and let the router notify the owner (awareness, not a
    gate). This is what Planday/Deputy call "auto-approve" for P2P swaps.

    A richer owner-approval workflow (owner can veto before execution,
    cost-delta / max-hours checks) remains a sensible FOLLOW-UP — but it
    needs an owner UI that doesn't exist yet. Until then, auto-execute is
    the only way swaps actually work. `decide_swap` is kept intact for
    that future owner path. Idempotent + tenant-safe (re-accepting a
    `done`/terminal swap raises; the flip re-validates ownership).
    """
    # FOR UPDATE: a second accept of the SAME request (a double tap, or the
    # portal's automatic retry while the first is still running) waits here
    # and then reads 'done', instead of passing the status check too.
    swap = (
        db.query(ShiftSwapRequest)
        .filter(ShiftSwapRequest.id == swap_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if not swap:
        raise ShiftSwapError("Swap request not found.")
    # L2: only the to_staff can respond.
    if swap.to_staff_id != responder_staff_id:
        # Same shape as not-found — don't reveal whether the swap exists
        # for someone else.
        raise ShiftSwapError("Swap request not found.")
    if swap.status != "proposed":
        raise ShiftSwapError(
            f"This swap is already {swap.status}; can't change it."
        )

    now = utc_now()

    # A shift in the trade has started (or someone is clocked in on it): the
    # trade can no longer happen, so the request ends as "expired" (its
    # terminal state for "the shift came round") instead of hanging in both
    # inboxes with Accept / Decline buttons that cannot work. Refused either
    # way, so the staffer reads why.
    started = [
        sch for sch in (
            db.query(Schedule).filter(Schedule.id == swap.from_shift_id).first(),
            db.query(Schedule).filter(Schedule.id == swap.to_shift_id).first(),
        ) if sch is not None
    ]
    try:
        _refuse_started(db, *started)
    except ShiftSwapStarted:
        swap.status = "expired"
        swap.responded_at = now
        db.commit()
        log.info("[shift_swap] respond swap=%s refused: a shift has started (expired)", swap_id)
        raise

    if not accept:
        swap.status = "declined"
        swap.responded_at = now
        db.commit()
        db.refresh(swap)
        log.info("[shift_swap] respond swap=%s accept=False (declined)", swap_id)
        return swap

    # accept=True → execute the swap atomically.
    # Lock both people before reading their rosters. The double-booking check
    # below is read-then-write: without the lock, two accepts touching the
    # same person (two incoming swaps for overlapping shifts, or an accept
    # racing a colleague's give-away claim) could both pass it before either
    # commits. claim_giveaway takes the same lock on its claimer; ascending
    # id order on both paths, after the swap row, so they cannot deadlock.
    _lock_staff(db, swap.from_staff_id, swap.to_staff_id)
    swap.responded_at = now

    # L5: re-validate BOTH shifts still belong to their pre-swap staff
    # under the same owner (defense against a race where a shift was
    # deleted/reassigned between propose and accept). Same check
    # decide_swap performs before flipping.
    from_sched = db.query(Schedule).filter(
        Schedule.id == swap.from_shift_id,
        Schedule.user_id == swap.user_id,
        Schedule.staff_id == swap.from_staff_id,
    ).first()
    to_sched = db.query(Schedule).filter(
        Schedule.id == swap.to_shift_id,
        Schedule.user_id == swap.user_id,
        Schedule.staff_id == swap.to_staff_id,
    ).first()
    if not from_sched or not to_sched:
        # Don't leave the request stuck at proposed — mark it declined so
        # the proposer knows to re-offer against the current schedule.
        swap.status = "declined"
        db.commit()
        raise ShiftSwapStale(
            "One of the shifts has changed since this swap was proposed; "
            "ask the other person to re-offer."
        )

    # Rosters move between propose and accept (the owner adds a shift, a
    # give-away is claimed), so the double-booking check runs again here,
    # right before the flip. Refused WITHOUT touching the request: nobody
    # declined it, and if the clash goes away it can still be accepted —
    # the responder can also decline it themselves.
    try:
        _refuse_double_booking(
            db, owner_id=swap.user_id, caller_staff_id=responder_staff_id,
            from_staff_id=swap.from_staff_id, from_sched=from_sched,
            to_staff_id=swap.to_staff_id, to_sched=to_sched,
        )
    except ShiftSwapOverlap:
        db.rollback()   # drop the buffered responded_at — no write on refusal
        raise

    # Atomic flip — SQLAlchemy buffers both; the single commit below is
    # the atomic boundary. Either both reassign or neither.
    from_sched.staff_id = swap.to_staff_id
    to_sched.staff_id = swap.from_staff_id
    swap.status = "done"
    swap.decided_at = now

    try:
        db.commit()
    except Exception:
        # FK violation / race → abort the whole transaction. No partial
        # state on either schedule or the swap row.
        db.rollback()
        raise
    db.refresh(swap)
    log.info(
        "[shift_swap] respond swap=%s accept=True EXECUTED (done) "
        "from_shift=%s↔to_shift=%s", swap_id, swap.from_shift_id, swap.to_shift_id,
    )
    return swap


def withdraw_swap(
    db: Session,
    *,
    swap_id: uuid.UUID,
    proposer_staff_id: uuid.UUID,
) -> ShiftSwapRequest:
    """Proposer cancels their offer before to_staff has responded.

    Allowed only from `proposed` (you can't pull back an already-
    accepted swap because the responder might have made other plans;
    the owner is the only one who can stop an accepted swap, via deny).
    """
    swap = db.query(ShiftSwapRequest).filter(ShiftSwapRequest.id == swap_id).first()
    if not swap:
        raise ShiftSwapError("Swap request not found.")
    if swap.from_staff_id != proposer_staff_id:
        raise ShiftSwapError("Swap request not found.")
    if swap.status != "proposed":
        raise ShiftSwapError(
            "Can't withdraw — the other staff has already responded."
        )
    swap.status = "withdrawn"
    db.commit()
    db.refresh(swap)
    return swap


def decide_swap(
    db: Session,
    *,
    owner_id: uuid.UUID,
    swap_id: uuid.UUID,
    approve: bool,
    note: Optional[str] = None,
) -> ShiftSwapRequest:
    """Owner approves or denies an accepted swap.

    On `approve`, atomically flips Schedule.staff_id on BOTH shifts in
    the same DB transaction — either both flip or neither (commit
    happens once at the end). No partial-flip state is reachable.

    Pre-flip check: re-validate that both shifts STILL belong to their
    pre-swap staff (defense against a race where someone deleted /
    reassigned a shift between accept and approve).
    """
    swap = db.query(ShiftSwapRequest).filter(
        ShiftSwapRequest.id == swap_id,
        ShiftSwapRequest.user_id == owner_id,  # L2: owner gate
    ).first()
    if not swap:
        raise ShiftSwapError("Swap request not found.")
    if swap.status != "accepted":
        raise ShiftSwapError(
            f"Swap is {swap.status}; only accepted swaps can be approved."
        )

    if approve:
        # Re-validate the shifts haven't drifted since accept.
        from_sched = db.query(Schedule).filter(
            Schedule.id == swap.from_shift_id,
            Schedule.user_id == owner_id,
            Schedule.staff_id == swap.from_staff_id,
        ).first()
        to_sched = db.query(Schedule).filter(
            Schedule.id == swap.to_shift_id,
            Schedule.user_id == owner_id,
            Schedule.staff_id == swap.to_staff_id,
        ).first()
        if not from_sched or not to_sched:
            raise ShiftSwapError(
                "One of the shifts has changed since this swap was accepted; "
                "ask the staff to re-propose."
            )
        # A started shift is never handed over (same rule as propose/accept).
        _refuse_started(db, from_sched, to_sched)
        # L5: atomic flip. SQLAlchemy buffers these; the single commit
        # at the end is the atomic boundary.
        from_sched.staff_id = swap.to_staff_id
        to_sched.staff_id = swap.from_staff_id

    swap.status = "approved" if approve else "denied"
    swap.decided_at = utc_now()
    swap.owner_note = _scrub(note)

    try:
        db.commit()
    except Exception:
        # If the flip fails (FK violation, race), abort the whole
        # transaction — no partial state on either schedule or swap.
        db.rollback()
        raise
    db.refresh(swap)
    log.info("[shift_swap] decide swap=%s approve=%s", swap_id, approve)
    return swap


def list_for_staff(
    db: Session,
    *,
    staff_id: uuid.UUID,
    include_resolved: bool = False,
) -> list[ShiftSwapRequest]:
    """Staff portal inbox — returns swaps where this staff is either
    the proposer (outgoing) or the target (incoming).

    Resolved (terminal-state) swaps are excluded by default to keep
    the inbox tidy; pass include_resolved=True to see history.
    """
    q = db.query(ShiftSwapRequest).filter(
        (ShiftSwapRequest.from_staff_id == staff_id)
        | (ShiftSwapRequest.to_staff_id == staff_id)
    )
    if not include_resolved:
        # `done` is terminal but we keep it in the default inbox so a
        # just-executed swap shows its "Byttet/Done" confirmation to both
        # staff (the schedule tab already reflects the reassignment).
        # `accepted` is retained for the legacy owner-approval path.
        # `expired` = it ended because a shift in it started (the swap
        # guard): kept in view, like `done`, so both people read WHY it is
        # gone instead of watching it vanish.
        q = q.filter(
            ShiftSwapRequest.status.in_(("proposed", "accepted", "done", "expired"))
        )
    return q.order_by(ShiftSwapRequest.created_at.desc()).all()


def list_pending_for_owner(
    db: Session, *, owner_id: uuid.UUID,
) -> list[ShiftSwapRequest]:
    """Owner card — swaps awaiting approval (status='accepted')."""
    return (
        db.query(ShiftSwapRequest)
        .filter(
            ShiftSwapRequest.user_id == owner_id,
            ShiftSwapRequest.status == "accepted",
        )
        .order_by(ShiftSwapRequest.responded_at.desc())
        .all()
    )


# ═══════════════════════════════════════════════════════════════════════════
#  GIVE-AWAY ("Sæt vagt til salg") — Phase 2 v2, the mode the model was
#  built for (to_staff_id / to_shift_id nullable).
#
#  Flow: offerer posts their shift to the pool (status `proposed`,
#  to_staff NULL) → any eligible colleague claims → EXECUTES immediately
#  (Schedule.staff_id reassigns, status `done`) per the same
#  auto-execute-on-mutual-handshake doctrine as respond_to_swap — the
#  offerer offered, the claimer claimed; the owner is notified, not a
#  gate. withdraw_swap already covers pulling an unclaimed offer.
#
#  Claims get two guards trades don't need (a claim ADDS hours):
#    • overlap  — refuse if the claimer already works overlapping times
#                 that day (overnight-aware, same math as the schedule
#                 overlap barrier)
#    • hour cap — refuse if the claim pushes the claimer past their
#                 contract max_hours_week (else the DK 48h ceiling).
#                 Respects the staffer's hour_limit_warn toggle — an
#                 owner who switched warnings off accepted overload for
#                 that person. Refusal, not warning: the pool must never
#                 silently create the exact breach the Shield exists to
#                 surface; the owner can always assign manually.
# ═══════════════════════════════════════════════════════════════════════════


def _hhmm_min(v: str) -> int:
    try:
        h, m = (v or "0:0").split(":")
        return int(h) * 60 + int(m)
    except Exception:  # noqa: BLE001 — malformed time reads as midnight
        return 0


def _spans(sched: Schedule) -> tuple[int, int]:
    """Minutes-from-day-start span; overnight end rolls past 24h (strict <,
    mirrors autopilot _shift_hours)."""
    s = _hhmm_min(sched.start_time)
    e = _hhmm_min(sched.end_time)
    if e < s:
        e += 24 * 60
    return s, e


def offer_giveaway(
    db: Session,
    *,
    owner_id: uuid.UUID,
    from_staff_id: uuid.UUID,
    from_shift_id: uuid.UUID,
    reason: Optional[str] = None,
) -> ShiftSwapRequest:
    """Staffer puts their own future shift up for grabs."""
    sched = _shift_belongs_to(
        db, shift_id=from_shift_id, owner_id=owner_id, staff_id=from_staff_id,
    )
    # Not once it has started (venue local time, overnight included, or the
    # staffer is clocked in on it).
    _refuse_started(db, sched)

    # Idempotency — one open offer per shift.
    existing = db.query(ShiftSwapRequest).filter(
        ShiftSwapRequest.user_id == owner_id,
        ShiftSwapRequest.from_shift_id == from_shift_id,
        ShiftSwapRequest.to_shift_id.is_(None),
        ShiftSwapRequest.status == "proposed",
    ).first()
    if existing:
        return existing

    swap = ShiftSwapRequest(
        user_id=owner_id,
        from_staff_id=from_staff_id,
        from_shift_id=from_shift_id,
        to_staff_id=None,
        to_shift_id=None,
        status="proposed",
        reason=_scrub(reason),
    )
    db.add(swap)
    db.commit()
    db.refresh(swap)
    log.info("[give_away] offered shift=%s by staff=%s", from_shift_id, from_staff_id)
    return swap


def list_open_giveaways(
    db: Session,
    *,
    owner_id: uuid.UUID,
    exclude_staff_id: Optional[uuid.UUID] = None,
) -> list[ShiftSwapRequest]:
    """Open (unclaimed, not yet started) give-away offers — colleagues' pool
    view. A shift that has started (venue local time, overnight included, or
    its staffer is clocked in on it) is left out: it can no longer be taken.
    Every shift dated before today has started, so SQL narrows to today and
    later; the start time (and an early clock-in) decides the rest."""
    now = _venue_now(db, owner_id)
    q = (
        db.query(ShiftSwapRequest, Schedule)
        .join(Schedule, Schedule.id == ShiftSwapRequest.from_shift_id)
        .filter(
            ShiftSwapRequest.user_id == owner_id,
            ShiftSwapRequest.to_shift_id.is_(None),
            ShiftSwapRequest.status == "proposed",
            Schedule.date >= now.date(),
        )
        .order_by(Schedule.date, Schedule.start_time)
    )
    if exclude_staff_id is not None:
        q = q.filter(ShiftSwapRequest.from_staff_id != exclude_staff_id)
    return [swap for swap, sched in q.all() if not shift_has_started(db, sched, now=now)]


def claim_giveaway(
    db: Session,
    *,
    owner_id: uuid.UUID,
    swap_id: uuid.UUID,
    claimer_staff_id: uuid.UUID,
) -> ShiftSwapRequest:
    """Colleague takes an open give-away — executes immediately (atomic)."""
    from app.services.schedule_autopilot import (
        _shift_hours,
        DK_MAX_HOURS_PER_WEEK,
    )
    from datetime import timedelta

    # FOR UPDATE on the give-away first (two colleagues tapping "Tag vagten"
    # at once: the second waits, then reads 'done'), then the claimer — the
    # same lock respond_to_swap takes, so an accept and a claim that would
    # hand one person two overlapping shifts run one after the other.
    swap = (
        db.query(ShiftSwapRequest)
        .filter(
            ShiftSwapRequest.id == swap_id,
            ShiftSwapRequest.user_id == owner_id,
        )
        .with_for_update()
        .populate_existing()
        .first()
    )
    if not swap or swap.to_shift_id is not None:
        raise ShiftSwapError("Give-away not found.")
    if swap.status != "proposed":
        raise ShiftSwapError("This shift has already been taken.")
    if swap.from_staff_id == claimer_staff_id:
        raise ShiftSwapError("You can't take your own shift — withdraw it instead.")
    _lock_staff(db, claimer_staff_id)

    claimer = db.query(StaffMember).filter(
        StaffMember.id == claimer_staff_id,
        StaffMember.user_id == owner_id,
        StaffMember.is_deleted.isnot(True),
        StaffMember.active.is_(True),
    ).first()
    if not claimer:
        raise ShiftSwapError("Staff not found.")

    # Re-validate the shift still belongs to the offerer + is future.
    sched = db.query(Schedule).filter(
        Schedule.id == swap.from_shift_id,
        Schedule.user_id == owner_id,
        Schedule.staff_id == swap.from_staff_id,
    ).first()
    if not sched:
        swap.status = "withdrawn"
        db.commit()
        raise ShiftSwapError(
            "The shift has changed since it was offered; ask them to re-offer."
        )
    # Not once it has started (venue local time, overnight included, or the
    # offerer is clocked in on it): the claim is refused and the offer ends
    # as "expired", so the offerer's own list says "Shift started" instead
    # of "Up for grabs".
    try:
        _refuse_started(db, sched)
    except ShiftSwapStarted:
        swap.status = "expired"
        db.commit()
        raise

    # Guard 1 — overlap with the claimer's existing shifts that day.
    day_shifts = db.query(Schedule).filter(
        Schedule.user_id == owner_id,
        Schedule.staff_id == claimer_staff_id,
        Schedule.date == sched.date,
    ).all()
    cs, ce = _spans(sched)
    for other in day_shifts:
        os_, oe = _spans(other)
        if cs < oe and os_ < ce:
            raise ShiftSwapError(
                "You already work an overlapping shift that day."
            )

    # Guard 2 — hour cap (contract max_hours_week, else DK 48h), unless the
    # owner switched hour-limit warnings off for this staffer.
    if claimer.hour_limit_warn is not False:
        monday = sched.date - timedelta(days=sched.date.weekday())
        week_shifts = db.query(Schedule).filter(
            Schedule.user_id == owner_id,
            Schedule.staff_id == claimer_staff_id,
            Schedule.date >= monday,
            Schedule.date <= monday + timedelta(days=6),
        ).all()
        week_hours = sum(
            _shift_hours(s.start_time, s.end_time, s.break_minutes or 0)
            for s in week_shifts
        ) + _shift_hours(sched.start_time, sched.end_time, sched.break_minutes or 0)
        cap = float(claimer.max_hours_week) if claimer.max_hours_week else DK_MAX_HOURS_PER_WEEK
        if week_hours > cap + 0.01:
            raise ShiftSwapError(
                f"Taking this shift would put you over your weekly limit "
                f"({week_hours:.1f} of {cap:.0f} hours)."
            )

    # Execute — atomic reassignment.
    now = utc_now()
    sched.staff_id = claimer_staff_id
    swap.to_staff_id = claimer_staff_id
    swap.status = "done"
    swap.responded_at = now
    swap.decided_at = now
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(swap)
    log.info(
        "[give_away] CLAIMED swap=%s shift=%s %s→%s",
        swap_id, swap.from_shift_id, swap.from_staff_id, claimer_staff_id,
    )
    return swap
