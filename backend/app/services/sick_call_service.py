"""Sick-call orchestration — the operational state machine that turns
a staff portal "I'm sick today" tap into a graceful coverage outcome.

Multi-layer responsibilities:

    L1 — Tenant isolation
         Every query filters by owner_id (== user_id). Cross-owner
         leakage is impossible at the service layer; the router layer
         is a second wall.

    L2 — Authorization
         create_sick_call() requires the caller to prove they ARE the
         staff (via magic-link token at the router) AND that the
         provided staff_id matches the token's staff. The router
         passes that already-validated staff in; the service refuses
         to do its own auth (single source of truth at the boundary).

    L3 — Domain validation
         • Date can't be > 30 days in the past (no back-dating sick
           calls — that's a manager edit, not staff self-service)
         • Date can't be > 60 days in the future (advance call-ins
           are fine for known surgery / vacation, but anything
           further is almost certainly a typo)
         • If schedule_id is provided, it MUST belong to this staff
           AND match the date. Catches a portal client that sends a
           stale schedule_id from a cached page.
         • Reason text bounded to 500 chars; control characters
           stripped (defense in depth — the reason might end up in
           an SMS / push payload eventually).

    L4 — Idempotency
         Same staff calling sick twice for the same date+kind doesn't
         create two rows; the second call returns the existing one.
         Why this matters: staff tap "Call sick" → poor signal → tap
         again 5s later. Without idempotency the owner sees two
         notifications and the dashboard double-counts the absence.

    L5 — Side effects (kept minimal)
         create_sick_call() does NOT:
           • Cancel the underlying Schedule row (owner may want to
             record-keep "Sara was scheduled but called sick" rather
             than delete history)
           • Auto-text the cover candidates (that's an owner-side
             explicit step)
         It DOES suggest replacement candidates so the owner-side
         endpoint can show "Anna is available, tap to assign cover."

Future expansion (Phase 2 / 3):
    • _suggest_replacements() will consume StaffAvailability rows
      once that model exists; today it falls back to "any active
      staff with the same role who isn't already scheduled today."
    • acknowledge() will fire push notifications when push_service
      is wired (Phase 1.5).
    • assign_cover() will optionally create a new Schedule row OR
      reassign the existing one — currently just records the
      replacement_staff_id and lets the owner manually edit
      Schedule.staff_id.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional
import re
import uuid

from sqlalchemy.orm import Session

from app.models.absence import StaffAbsence
from app.models.staff import Schedule, StaffMember
from app.utils.time import utc_now

log = logging.getLogger(__name__)


# Domain bounds — values pinned by tests so a future loosening is a
# deliberate decision, not an accidental drift.
MAX_BACKDATE_DAYS = 30
MAX_FUTURE_DAYS = 60
MAX_REASON_LEN = 500


class SickCallError(ValueError):
    """Service-layer rejection. Routers map these to 4xx responses;
    they're never raised on a happy path."""


def _normalize_reason(reason: Optional[str]) -> Optional[str]:
    """Strip control characters and bound length. Returns None for
    empty / whitespace-only strings so the column ends up cleanly NULL
    rather than an empty string (matters for downstream `if
    absence.reason:` checks)."""
    if not reason:
        return None
    # Strip ASCII control chars except newlines + tabs. Keeps Danish
    # diacritics (æøå) intact — they're not in the C0 control range.
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", reason).strip()
    if not cleaned:
        return None
    return cleaned[:MAX_REASON_LEN]


def _validate_date_window(absence_date: date) -> None:
    """Reject dates outside the [today - 30, today + 60] window.

    Why these bounds:
      • today - 30: a sick call older than a month is record-keeping,
        not real-time — those should go through the owner's manual
        edit path, not the staff self-service portal.
      • today + 60: 60 days covers most known absences (planned
        surgery, planned vacation if no PTO module yet). Beyond
        that is almost certainly a typo on the date picker.
    """
    today = date.today()
    if absence_date < today - timedelta(days=MAX_BACKDATE_DAYS):
        raise SickCallError(
            f"Date is too far in the past (max {MAX_BACKDATE_DAYS} days back). "
            "Ask your manager to log this absence."
        )
    if absence_date > today + timedelta(days=MAX_FUTURE_DAYS):
        raise SickCallError(
            f"Date is too far in the future (max {MAX_FUTURE_DAYS} days ahead). "
            "Check the date you picked."
        )


def _resolve_schedule(
    db: Session,
    *,
    owner_id: uuid.UUID,
    staff_id: uuid.UUID,
    absence_date: date,
    schedule_id: Optional[uuid.UUID],
) -> Optional[Schedule]:
    """Find the Schedule row this absence is targeting, with belt-and-
    braces tenant + ownership checks.

    If `schedule_id` is provided, validate it belongs to this owner +
    staff + date — refuse on any mismatch (stale client cache, copy-
    paste of someone else's URL, etc.).

    If `schedule_id` is omitted, look for a published or draft schedule
    owned by this owner + staff for this date and use that. Return None
    if there isn't one (advance call-in for a date not yet scheduled is
    legitimate; the absence row is created without a schedule_id and
    the link can be made later).
    """
    if schedule_id is not None:
        sched = db.query(Schedule).filter(
            Schedule.id == schedule_id,
            Schedule.user_id == owner_id,
            Schedule.staff_id == staff_id,
        ).first()
        if not sched:
            # Don't reveal whether the schedule exists for someone
            # else — same shape as a not-found.
            raise SickCallError("That shift doesn't belong to you.")
        if sched.date != absence_date:
            raise SickCallError(
                "The shift you picked is on a different date than the "
                "absence date."
            )
        return sched

    # Auto-find — first matching Schedule for this staff on this date.
    return db.query(Schedule).filter(
        Schedule.user_id == owner_id,
        Schedule.staff_id == staff_id,
        Schedule.date == absence_date,
    ).first()


def create_sick_call(
    db: Session,
    *,
    owner_id: uuid.UUID,
    staff_id: uuid.UUID,
    absence_date: date,
    reason: Optional[str] = None,
    schedule_id: Optional[uuid.UUID] = None,
) -> StaffAbsence:
    """Create (or return existing) sick call for staff_id on absence_date.

    Idempotent: if a sick call already exists for (staff_id, date,
    kind="sick"), returns the existing row instead of creating a duplicate.
    Lets the staff tap the button twice without spamming the owner.

    Raises SickCallError on validation failure. Routers map to 422.
    """
    _validate_date_window(absence_date)

    # L1 / L2: confirm the staff belongs to this owner. Defense in
    # depth — the router already validated via the magic-link token,
    # but service-layer never trusts that alone.
    staff = db.query(StaffMember).filter(
        StaffMember.id == staff_id,
        StaffMember.user_id == owner_id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not staff:
        raise SickCallError("Staff member not found.")

    # L3: schedule check (if any).
    sched = _resolve_schedule(
        db,
        owner_id=owner_id,
        staff_id=staff_id,
        absence_date=absence_date,
        schedule_id=schedule_id,
    )

    # L4: idempotency. Look for an existing pending/acknowledged sick
    # call for this (staff, date, kind="sick") — return it instead of
    # inserting a new row.
    existing = db.query(StaffAbsence).filter(
        StaffAbsence.user_id == owner_id,
        StaffAbsence.staff_id == staff_id,
        StaffAbsence.date == absence_date,
        StaffAbsence.kind == "sick",
        StaffAbsence.status.in_(("pending", "acknowledged", "covered")),
    ).first()
    if existing:
        # If staff is updating reason / linking schedule on retry, accept
        # the new info on existing row. Strict idempotency would refuse
        # any change; that feels worse for the actual UX (staff often
        # adds detail in the second tap).
        new_reason = _normalize_reason(reason)
        if new_reason and existing.reason != new_reason:
            existing.reason = new_reason
        if sched and existing.schedule_id != sched.id:
            existing.schedule_id = sched.id
        db.commit()
        db.refresh(existing)
        return existing

    absence = StaffAbsence(
        user_id=owner_id,
        staff_id=staff_id,
        kind="sick",
        schedule_id=sched.id if sched else None,
        date=absence_date,
        reason=_normalize_reason(reason),
        status="pending",
        called_at=utc_now(),
    )
    db.add(absence)
    db.commit()
    db.refresh(absence)
    log.info(
        "[sick_call] staff=%s owner=%s date=%s schedule=%s",
        staff_id, owner_id, absence_date, absence.schedule_id,
    )
    return absence


def acknowledge_sick_call(
    db: Session,
    *,
    owner_id: uuid.UUID,
    absence_id: uuid.UUID,
) -> StaffAbsence:
    """Owner acknowledges they've seen the sick call. Updates status
    pending → acknowledged + records timestamp. No-op if already
    acknowledged or covered."""
    absence = db.query(StaffAbsence).filter(
        StaffAbsence.id == absence_id,
        StaffAbsence.user_id == owner_id,  # <-- tenant gate
    ).first()
    if not absence:
        raise SickCallError("Sick call not found.")
    if absence.status == "pending":
        absence.status = "acknowledged"
        absence.acknowledged_at = utc_now()
        db.commit()
        db.refresh(absence)
    return absence


def assign_cover(
    db: Session,
    *,
    owner_id: uuid.UUID,
    absence_id: uuid.UUID,
    replacement_staff_id: uuid.UUID,
) -> StaffAbsence:
    """Owner picks a replacement. Validates the replacement is a real
    staff under this owner. Records replacement_staff_id + bumps status
    to 'covered'. Does NOT mutate the underlying Schedule row — owner
    can do that as a separate edit if they want the schedule view to
    reflect who's actually working.
    """
    absence = db.query(StaffAbsence).filter(
        StaffAbsence.id == absence_id,
        StaffAbsence.user_id == owner_id,
    ).first()
    if not absence:
        raise SickCallError("Sick call not found.")

    replacement = db.query(StaffMember).filter(
        StaffMember.id == replacement_staff_id,
        StaffMember.user_id == owner_id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not replacement:
        raise SickCallError("Replacement staff not found.")
    if replacement.id == absence.staff_id:
        raise SickCallError(
            "Replacement must be different from the absent staff."
        )

    absence.replacement_staff_id = replacement.id
    absence.status = "covered"
    if absence.acknowledged_at is None:
        absence.acknowledged_at = utc_now()
    db.commit()
    db.refresh(absence)
    return absence


def suggest_replacements(
    db: Session,
    *,
    owner_id: uuid.UUID,
    absent_staff_id: uuid.UUID,
    absence_date: date,
    role_filter: Optional[str] = None,
    limit: int = 5,
) -> list[StaffMember]:
    """Return up to `limit` active staff who could cover the shift.

    Phase 1 heuristic (kept simple, hard rules only):
      • Active + not soft-deleted + same owner
      • Different staff member than the absent one
      • Not already scheduled on this date (avoid double-booking)
      • If role_filter is set, prefer same role (server / cook / barista)
        but include any role if the same-role pool is empty (better to
        show "Lars is available but he's a cook, not a server" than
        nothing — owner can decide)

    Phase 2 will consume StaffAvailability + recent-hours-worked +
    fairness rotation. Today's heuristic is the floor we can ship and
    test; smarter ranking goes in once availability data exists.
    """
    # Find staff already scheduled on this date — exclude them.
    busy_q = db.query(Schedule.staff_id).filter(
        Schedule.user_id == owner_id,
        Schedule.date == absence_date,
    )
    busy_ids = {row.staff_id for row in busy_q.all()}
    busy_ids.add(absent_staff_id)  # never suggest the absent staff

    candidates_q = db.query(StaffMember).filter(
        StaffMember.user_id == owner_id,
        StaffMember.active.is_(True),
        StaffMember.is_deleted.isnot(True),
    )
    candidates = [c for c in candidates_q.all() if c.id not in busy_ids]

    if role_filter:
        same_role = [c for c in candidates if c.role == role_filter]
        if same_role:
            candidates = same_role
        # else: keep the broader pool — better to show "available but
        # different role" than empty.

    return candidates[:limit]


# ─── Fravær (absence) registration — a DATE RANGE, any kind ──────────────

# Planday-style absence types. TRACKING only — no sygeløn/feriepenge/pay math
# is computed anywhere (that is payroll, out of BonBox's lane). We record who's
# off, when, and what type, so the roster + the owner's overview reflect it.
VALID_ABSENCE_KINDS = ("sick", "ferie", "barns_syg", "andet")
MAX_ABSENCE_RANGE_DAYS = 60


def register_absence(
    db: Session,
    *,
    owner_id: uuid.UUID,
    staff_id: uuid.UUID,
    kind: str,
    date_from: date,
    date_to: date,
    reason: Optional[str] = None,
) -> tuple[int, int]:
    """Register a Fravær over a date RANGE — materializes one StaffAbsence per
    day (status='pending'), so ferie next week or a sick period is one action.

    Idempotent per (staff, date, kind): a day that already has an active row
    for this kind is SKIPPED, so re-submitting an overlapping range never
    duplicates. Returns (created, skipped). Raises SickCallError on validation
    failure (routers map to 422).
    """
    if kind not in VALID_ABSENCE_KINDS:
        raise SickCallError("Ukendt fraværstype.")
    if date_to < date_from:
        raise SickCallError("Slutdato er før startdato.")
    span = (date_to - date_from).days + 1
    if span > MAX_ABSENCE_RANGE_DAYS:
        raise SickCallError(f"Perioden må højst være {MAX_ABSENCE_RANGE_DAYS} dage.")
    today = date.today()
    # Window: recent past (late sick registration) up to a year out (planned
    # ferie). Wide enough for real use, bounded against garbage input.
    if date_from < today - timedelta(days=31) or date_to > today + timedelta(days=365):
        raise SickCallError("Datoen er uden for det tilladte vindue.")

    # Tenant / ownership — defense in depth (router already token-checked).
    staff = db.query(StaffMember).filter(
        StaffMember.id == staff_id,
        StaffMember.user_id == owner_id,
        StaffMember.is_deleted.isnot(True),
    ).first()
    if not staff:
        raise SickCallError("Staff member not found.")

    norm_reason = _normalize_reason(reason)
    created = 0
    skipped = 0
    d = date_from
    while d <= date_to:
        existing = db.query(StaffAbsence).filter(
            StaffAbsence.user_id == owner_id,
            StaffAbsence.staff_id == staff_id,
            StaffAbsence.date == d,
            StaffAbsence.kind == kind,
            StaffAbsence.status.in_(("pending", "acknowledged", "covered")),
        ).first()
        if existing:
            skipped += 1
        else:
            db.add(StaffAbsence(
                user_id=owner_id, staff_id=staff_id, kind=kind,
                date=d, reason=norm_reason, status="pending",
            ))
            created += 1
        d += timedelta(days=1)
    db.commit()
    return created, skipped
