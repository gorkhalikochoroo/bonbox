"""The data half of Migration 074 — stamping confirmed_for on legacy rows.

WHY THIS IS NOT AN `UPDATE ... SET` IN _run_migrations
------------------------------------------------------
Migration 074 added `schedules.confirmed_for`, and its note in main.py says
"no backfill: a computed fingerprint would assert the shift is unchanged since
acknowledgement, which is exactly what we cannot know for historical rows."

That reading was wrong, and in the unsafe direction. The CLEARING behaviour it
worried about never reached production — the fingerprint and the retraction
shipped together — so the owner's PUT has never moved a legacy row *after* the
server started caring. NULL therefore does not mean "we can't know"; it means
"acknowledged, and not moved since", which is precisely what the fingerprint of
the row's CURRENT values says.

WITH ONE KNOWN EXCEPTION, AND IT IS NOT THE PUT. A shift also changes hands
through an approved swap and through an open-shift claim, and those paths
(services/shift_swap_service.py) write `Schedule.staff_id` directly and have
never touched `confirmed_at` — before Migration 074 or after. So a legacy
confirmed row CAN be sitting under a different name than the one who
acknowledged it. Fingerprinting those from current values would write down, as
a fact, that the person now on the shift said yes to it; and because the
portal's pending list is `not confirmed_current`, they could never be asked.
Those rows get `confirmed_at = NULL` instead — no acknowledgement, which is the
truth — so the new holder is asked once, normally. Nothing is lost that was
ever true: the old holder's yes described a shift that is no longer theirs.

Leaving them NULL is what actually asserts a fiction. `confirmation_is_current`
reads NULL as "still current" unconditionally, so for every pre-074 row the
retraction can never fire: the owner drags a confirmed shift two hours later,
the badge still says the staffer has seen it, and the staffer's portal shows a
shift nobody re-confirmed. The badge would be wrong exactly where it is most
load-bearing — on the oldest, most-trusted acknowledgements.

WHY PYTHON, NOT SQL
-------------------
The fingerprint is sha256 over a NORMALISED string ("9:00" and "09:00" must
hash alike). Re-expressing that normalisation in both a Postgres statement and
a SQLite mirror would be a third and fourth implementation of a rule that only
has to hold once, and a drift between any two of them silently retracts every
acknowledgement it touches. One implementation, called from both.

OPERATIONAL SHAPE
-----------------
  • IDEMPOTENT — the filter is `confirmed_at IS NOT NULL AND confirmed_for IS
    NULL`, so a second run finds nothing. Re-running is a no-op, never a
    re-stamp (which would silently un-retract a shift moved in between).
  • BATCHED + committed per batch, so a large table never holds one long
    transaction and an interruption keeps the batches it finished.
  • NON-BLOCKING — the caller runs it AFTER the readiness gate opens. Until it
    finishes, untouched rows behave exactly as they do today (NULL reads as
    current), so a partial run is never worse than not running.
  • FAIL-SOFT — raises nothing at the caller; a stamp that did not happen costs
    an un-fired retraction, and taking the worker down over it would cost the
    whole app.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.staff import Schedule
from app.utils.schedule_fingerprint import fingerprint_for_shift

log = logging.getLogger(__name__)

# One batch = one transaction. 500 keeps the write small enough that a busy
# Postgres never waits on it, and large enough that a real roster (a few
# thousand confirmed shifts) drains in a handful of round-trips.
_BATCH_SIZE = 500

# A batch that changes nothing would otherwise re-select the same rows forever
# (the filter is on the column we are writing). The no-progress check below is
# the real guard; this is the belt to its braces, and it is logged when hit so
# a stuck backfill is visible instead of silent.
_MAX_BATCHES = 400


def _swap_reassigned_shift_ids(db: Session) -> set:
    """Shift ids a COMPLETED swap moved to a different staffer.

    Read once, up front, rather than joined per batch: the set is small (swaps
    are rare next to shifts), and one query beats N. Both terminal states count
    — `done` is the staff-to-staff accept and the open-shift claim, `approved`
    is the owner's decision path — because both write Schedule.staff_id.

    Fail-soft to the EMPTY set on any error, which degrades to the previous
    behaviour (stamp everything) rather than taking the boot path down. That is
    the right direction: an un-retracted acknowledgement is the bug we are
    already living with, a failed startup is a new outage.
    """
    try:
        from app.models.shift_swap import ShiftSwapRequest
        out: set = set()
        for from_id, to_id in db.query(
            ShiftSwapRequest.from_shift_id, ShiftSwapRequest.to_shift_id
        ).filter(ShiftSwapRequest.status.in_(("done", "approved"))).all():
            if from_id is not None:
                out.add(from_id)
            if to_id is not None:  # None on a give-away (no counter-shift)
                out.add(to_id)
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("confirmed_for backfill: swap lookup failed (%s); "
                    "stamping without the swap exclusion", e)
        return set()


def backfill_confirmed_for(db: Session, *, batch_size: int = _BATCH_SIZE) -> dict:
    """Stamp confirmed_for on acknowledged shifts that predate Migration 074.

    Returns {"updated": int, "retracted": int, "batches": int,
    "stalled": bool} — `retracted` counts rows whose acknowledgement was
    cleared because a swap handed the shift to someone else (see the module
    docstring); `stalled` is True only if rows still match after the loop
    stopped, which means the write is not sticking and the caller should look
    at the log rather than trust the count.
    """
    reassigned = _swap_reassigned_shift_ids(db)
    updated = 0
    retracted = 0
    batches = 0
    stalled = False
    prev_ids: set = set()

    while batches < _MAX_BATCHES:
        rows = (
            db.query(Schedule)
            .filter(
                Schedule.confirmed_at.isnot(None),
                Schedule.confirmed_for.is_(None),
            )
            .order_by(Schedule.created_at, Schedule.id)
            .limit(batch_size)
            .all()
        )
        if not rows:
            break

        # The filter is on the column we are writing, so a stamp that does not
        # persist re-selects the SAME batch next time round — an infinite loop
        # that would look like progress in the logs. Identical batch twice ⇒
        # stop and say so, rather than spin.
        ids = {r.id for r in rows}
        if ids == prev_ids:
            stalled = True
            break
        prev_ids = ids
        batches += 1

        stamped_in_batch = 0
        for shift in rows:
            if shift.id in reassigned:
                # A swap moved this shift to someone else and never cleared the
                # stamp. Stamping it would assert the CURRENT holder confirmed
                # it. Clear instead — and clearing also drops the row out of
                # this function's own filter, so a re-run cannot revisit it.
                shift.confirmed_at = None
                shift.confirmed_for = None
                retracted += 1
                continue
            # A row with an unparseable time still gets a fingerprint (the
            # normaliser falls back to the raw string), which is correct: two
            # differently-broken rows must not look "unchanged" against each
            # other. What we must never do is skip it and leave a NULL that
            # claims to be current forever.
            shift.confirmed_for = fingerprint_for_shift(shift)
            stamped_in_batch += 1
        db.commit()
        updated += stamped_in_batch

        if len(rows) < batch_size:
            break  # last partial batch — the table is drained

    # Cap-stall ONLY when rows genuinely still match. Hitting _MAX_BATCHES on a
    # batch that happened to drain the table is a COMPLETED run, and flagging it
    # would print "stopped early" about the one log line the next deploy is
    # meant to read for reassurance.
    if batches >= _MAX_BATCHES and not stalled:
        stalled = (
            db.query(Schedule)
            .filter(
                Schedule.confirmed_at.isnot(None),
                Schedule.confirmed_for.is_(None),
            )
            .first()
            is not None
        )

    if stalled:
        log.warning(
            "confirmed_for backfill stopped early after %s rows in %s batches — "
            "rows still match the legacy filter. Re-run is safe.",
            updated, batches,
        )
    return {
        "updated": updated,
        "retracted": retracted,
        "batches": batches,
        "stalled": stalled,
    }
