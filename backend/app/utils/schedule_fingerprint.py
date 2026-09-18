"""The fingerprint that decides whether a staffer's "Jeg har set det" still applies.

WHY THIS EXISTS
---------------
The acknowledgement used to be a single nullable stamp (`Schedule.confirmed_at`),
and the owner PUT cleared it whenever who/when changed. That is the right
INTENT and the wrong MECHANISM, because the owner grid's drag-to-move ships a
6-second "Fortryd": the undo replays the same PUT with the ORIGINAL values. The
clear already happened on the way out and nothing put it back, so an accidental
drag permanently destroyed an acknowledgement and the portal re-asked the
staffer to confirm a byte-identical shift. Losing trust in the badge is worse
than the badge being briefly wrong.

A fingerprint inverts that. The server stamps WHAT was acknowledged
(`Schedule.confirmed_for`) next to WHEN, and "is this still current?" becomes a
comparison instead of a destructive edit. An undo restores the original values,
the fingerprint matches again, and the acknowledgement is simply true once more
— no repair step, no state to lose.

WHAT COUNTS
-----------
staff_id · date · start_time · end_time — the four facts a staffer would have to
re-read. Notes, break_minutes and role_on_shift are the owner annotating a shift
whose WHO and WHEN are unchanged; folding them in would fire the badge on every
keystroke of housekeeping and train everyone to ignore it.

NORMALISE BEFORE HASHING. "9:00" and "09:00" are the same shift to a human and
the same minute to the clock, so they must not produce two fingerprints — an
older client, a CSV import or a hand-written API call must not be able to retract
an acknowledgement by spelling the time differently.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import date as _date

# Bumping this invalidates every stored fingerprint on purpose (every staffer is
# asked once more). It is here so that IF the inputs ever change, the mismatch is
# a deliberate, greppable version bump rather than a silent mass re-ask nobody
# can explain afterwards.
_FINGERPRINT_VERSION = "v1"


def _norm_staff_id(value) -> str:
    """Canonical lowercase hyphenated UUID. A UUID object, an uppercase string
    and a hyphenless string are all the same staffer."""
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return str(value or "").strip().lower()


def _norm_date(value) -> str:
    """ISO date. Accepts a `date` (the ORM column) or "YYYY-MM-DD" (a payload)."""
    if isinstance(value, _date):
        return value.isoformat()
    raw = str(value or "").strip()
    try:
        return _date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        return raw


def _norm_hhmm(value) -> str:
    """Zero-padded HH:MM. "9:00" and "09:00" must hash identically.

    Anything unparseable falls back to the trimmed raw string rather than "" —
    two different broken values must still differ, or a malformed row would
    silently look "unchanged" against every other malformed row.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = raw.split(":")
    try:
        hh = int(parts[0])
        mm = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return raw.lower()
    return f"{hh:02d}:{mm:02d}"


def shift_fingerprint(*, staff_id, shift_date, start_time, end_time) -> str:
    """Short deterministic fingerprint of the four material facts.

    Stable across processes and deploys (sha256 of a normalised string, not
    Python's salted hash()), and short enough to eyeball in a DB row.
    """
    parts = "|".join((
        _norm_staff_id(staff_id),
        _norm_date(shift_date),
        _norm_hhmm(start_time),
        _norm_hhmm(end_time),
    ))
    digest = hashlib.sha256(parts.encode("utf-8")).hexdigest()[:32]
    return f"{_FINGERPRINT_VERSION}:{digest}"


def fingerprint_for_shift(shift) -> str:
    """The fingerprint of a Schedule row AS IT NOW STANDS."""
    return shift_fingerprint(
        staff_id=shift.staff_id,
        shift_date=shift.date,
        start_time=shift.start_time,
        end_time=shift.end_time,
    )


def confirmation_is_current(shift) -> bool:
    """Does the staffer's acknowledgement still describe this shift?

    confirmed_for IS NULL means a LEGACY row — acknowledged before the column
    existed. Those are treated as CURRENT: nobody moved them, and the honest
    failure direction is to not nag staff about shifts that never changed.
    """
    if getattr(shift, "confirmed_at", None) is None:
        return False
    stored = getattr(shift, "confirmed_for", None)
    if not stored:
        return True  # legacy acknowledgement — fail toward not re-asking
    return stored == fingerprint_for_shift(shift)
