"""Shift swap orchestration — peer-to-peer trading with owner approval.

State machine (status field on ShiftSwapRequest):

    proposed ──(to_staff accepts)──> accepted ──(owner approves)──> approved
        │                                │
        │                                └──(owner denies)──> denied
        │
        ├──(to_staff declines)──> declined
        │
        ├──(from_staff withdraws)──> withdrawn
        │
        └──(shift date passes)──> expired

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

    Lifecycle:
      proposed + accept=True  → accepted (awaits owner)
      proposed + accept=False → declined (terminal)
    Any other current status raises (re-responding to a settled swap
    is a logic error in the client).
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

    swap.status = "accepted" if accept else "declined"
    swap.responded_at = utc_now()
    db.commit()
    db.refresh(swap)
    log.info("[shift_swap] respond swap=%s accept=%s", swap_id, accept)
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
        q = q.filter(ShiftSwapRequest.status.in_(("proposed", "accepted")))
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
