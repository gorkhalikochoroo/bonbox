"""Occupancy lifecycle + insert-and-catch — the integrity backbone glue.

This is the *only* place that writes / flips `reservation_occupancy` rows,
so the "no double-booking, ever" guarantee (docs/reservations-architecture.md
§2) has a single, well-tested chokepoint shared by every create path
(public, owner-manual, walk-in, request-approval).

Two responsibilities:

1. `create_reservation_with_occupancy(...)` — the *insert-and-catch* flow.
   Assigns a candidate resource (app-level fast path), INSERTs the
   reservation + its occupancy row in one transaction, and on the Postgres
   exclusion violation (someone won the race) rolls back, re-runs
   availability to pick *another* candidate, and retries up to N times before
   surfacing the existing `409 slot_unavailable`. On SQLite there is no
   exclusion constraint, so the catch never fires and the app-level recheck
   is the only guard (expected — see the model docstring).

2. Lifecycle flips — `release_occupancy(...)` / `activate_occupancy_row(...)`:
   when a reservation leaves the holding states (cancelled / no_show /
   completed / GDPR purge) its occupancy rows go `active = FALSE` so the
   slot frees and the partial exclusion index stops blocking it.

Half-open `[starts_at, ends_at)` is used everywhere, matching the engine's
`_overlaps` and the migration's `tsrange`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.services import reservation_service as rsvc

logger = logging.getLogger(__name__)

# Statuses whose occupancy row is active (holds the slot). Mirrors
# reservation_service.ACTIVE_STATUSES. A requested row does NOT hold a table
# (see §4 invariant) — but if one is ever created WITH a resource it still
# occupies, which is why ACTIVE_STATUSES (and the backfill) include it.
HOLDING_STATUSES = ("requested", "confirmed", "seated")

# How many times insert-and-catch re-picks a candidate before giving up.
# 3 covers realistic contention (a handful of simultaneous bookers on one
# popular slot) without unbounded retry under a thundering herd.
_MAX_ASSIGN_ATTEMPTS = 3


def add_occupancy_row(
    db: Session, reservation: Reservation, *, active: bool = True
) -> ReservationOccupancy | None:
    """Stage (add to the session, no commit) a single occupancy row for a
    reservation's primary resource. Returns the row, or None when the
    reservation holds no resource (nothing to protect). Half-open range
    taken straight from the reservation's starts_at/ends_at."""
    if reservation.resource_id is None:
        return None
    row = ReservationOccupancy(
        id=uuid.uuid4(),
        reservation_id=reservation.id,
        resource_id=reservation.resource_id,
        user_id=reservation.user_id,
        starts_at=reservation.starts_at,
        ends_at=reservation.ends_at,
        active=active,
    )
    db.add(row)
    return row


def create_reservation_with_occupancy(
    db: Session,
    *,
    profile: BusinessProfile | None,
    reservation: Reservation,
    initial_resource_id,
    party_size: int,
    start: datetime,
    duration_min: int,
    now: datetime | None = None,
    reassign: bool = True,
) -> Reservation:
    """Insert the reservation + an active occupancy row in one transaction,
    retrying on the exclusion violation.

    `reservation` is a fully-built (but not-yet-added) Reservation whose
    `resource_id` is `initial_resource_id` (the fast-path pick). On the
    Postgres ExclusionViolation (someone won the race) we rollback, free the
    session, and retry:

      • reassign=True  (public auto-assign / walk-in): re-run
        `recheck_and_assign` to pick a *DIFFERENT* free resource and retry up
        to `_MAX_ASSIGN_ATTEMPTS`. The guest doesn't care which table.
      • reassign=False (owner picked THIS specific table): do not re-pick —
        the owner's deliberate choice is occupied, so surface `SlotUnavailable`
        immediately (→ 409).

    After exhausting attempts (or on the first conflict when reassign=False)
    we raise `SlotUnavailable`. Caller owns post-commit side-effects (email,
    push, audit); this function commits the reservation + occupancy atomically.

    On SQLite the exclusion constraint can't exist, so the IntegrityError
    never fires and this is a single insert + commit.
    """
    resource_id = initial_resource_id
    last_error: IntegrityError | None = None

    for attempt in range(_MAX_ASSIGN_ATTEMPTS):
        reservation.resource_id = resource_id
        # Re-add each attempt: a failed flush/commit on PG aborts the
        # transaction and expires/detaches the pending INSERTs, so we re-stage.
        db.add(reservation)
        try:
            # Flush the reservation FIRST so its PK is populated, then stage
            # the occupancy row pointing at it (the occupancy FK is NOT NULL —
            # building the row before the reservation has an id leaves
            # reservation_id NULL). Both INSERTs still commit atomically.
            db.flush()
            add_occupancy_row(db, reservation, active=True)
            db.flush()
            db.commit()
            return reservation
        except IntegrityError as exc:
            # Someone won the race for this resource (the exclusion
            # constraint, or — defensively — any integrity violation on this
            # insert). Roll back and free the session.
            last_error = exc
            db.rollback()
            if not reassign:
                # Owner's explicit table is taken — don't second-guess them.
                raise SlotUnavailable() from exc
            if attempt == 0:
                logger.info(
                    "occupancy race on resource=%s start=%s — re-assigning (attempt %d)",
                    resource_id, start, attempt + 1,
                )
            # Re-run availability against the now-updated busy set to pick a
            # different free resource. recheck_and_assign reads committed
            # occupancy via busy_for_day, so the winner's row is now visible.
            resource_id = rsvc.recheck_and_assign(
                db, profile=profile, user_id=reservation.user_id, start=start,
                party_size=party_size, now=now, duration_min=duration_min,
            )
            if resource_id is None:
                raise SlotUnavailable() from exc
            continue

    # Exhausted attempts — every candidate we tried lost its race.
    logger.warning(
        "occupancy insert-and-catch exhausted %d attempts for start=%s party=%d",
        _MAX_ASSIGN_ATTEMPTS, start, party_size,
    )
    raise SlotUnavailable() from last_error


def release_occupancy(db: Session, reservation_id, *, resource_id=None) -> int:
    """Flip a reservation's occupancy row(s) to `active = FALSE` so the slot
    frees and the exclusion constraint stops blocking it. Called when a
    reservation goes to cancelled / no_show / completed, or on GDPR purge.

    Idempotent: a row already inactive stays inactive. Optionally scope to a
    single `resource_id`. Does NOT commit — the caller owns the transaction
    (matches audit_service.record's contract). Returns the count flipped."""
    q = db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == reservation_id,
        ReservationOccupancy.active.is_(True),
    )
    if resource_id is not None:
        q = q.filter(ReservationOccupancy.resource_id == resource_id)
    rows = q.all()
    for row in rows:
        row.active = False
    return len(rows)


def sync_occupancy_for_status(db: Session, reservation: Reservation) -> None:
    """Reconcile occupancy `active` flags to the reservation's CURRENT status
    (no resource assignment — that's the create/approve path's job). Used by
    the owner status PATCH, which can move a reservation to any state.

    - holding state (confirmed/seated/requested) + has resource + no active
      row → stage one active row (e.g. owner sets resource_id on a row that
      never had occupancy).
    - terminal state (cancelled/no_show/completed) → release all rows.

    Does NOT commit. The owner PATCH owns the transaction (and on PG the
    INSERT here may raise IntegrityError if it collides — the caller catches
    it and maps to 409)."""
    status = reservation.status
    if status in ("cancelled", "no_show", "completed"):
        release_occupancy(db, reservation.id)
        return
    if status in HOLDING_STATUSES and reservation.resource_id is not None:
        existing = (
            db.query(ReservationOccupancy)
            .filter(
                ReservationOccupancy.reservation_id == reservation.id,
                ReservationOccupancy.resource_id == reservation.resource_id,
                ReservationOccupancy.active.is_(True),
            )
            .first()
        )
        if existing is None:
            # Re-point any stale inactive rows on other resources off, then
            # add the active row for the current resource.
            release_occupancy(db, reservation.id)
            add_occupancy_row(db, reservation, active=True)


class SlotUnavailable(Exception):
    """Raised when insert-and-catch can't seat the party on any candidate —
    every free resource it tried lost its race. The router maps this to the
    existing `409 slot_unavailable`."""
