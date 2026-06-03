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
       • Both shifts must be in the future (date >= today)
       • from_staff != to_staff (no self-swap)
       • from_shift != to_shift (no swapping with itself)
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

import logging
import re
import uuid
from datetime import date as date_cls
from typing import Optional

from sqlalchemy.orm import Session

from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import Schedule, StaffMember
from app.utils.time import utc_now

log = logging.getLogger(__name__)


MAX_REASON_LEN = 500


class ShiftSwapError(ValueError):
    """Service-layer rejection. Routers map these to 4xx responses;
    they're never raised on a happy path."""


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

    # L3: both shifts must be in the future. Past shifts can't be
    # swapped (history is immutable for record-keeping).
    today = date_cls.today()
    if from_sched.date < today or to_sched.date < today:
        raise ShiftSwapError("Can't swap a shift that's already in the past.")

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
    swap = db.query(ShiftSwapRequest).filter(ShiftSwapRequest.id == swap_id).first()
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

    if not accept:
        swap.status = "declined"
        swap.responded_at = now
        db.commit()
        db.refresh(swap)
        log.info("[shift_swap] respond swap=%s accept=False (declined)", swap_id)
        return swap

    # accept=True → execute the swap atomically.
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
        raise ShiftSwapError(
            "One of the shifts has changed since this swap was proposed; "
            "ask the other person to re-offer."
        )

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
        q = q.filter(
            ShiftSwapRequest.status.in_(("proposed", "accepted", "done"))
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
