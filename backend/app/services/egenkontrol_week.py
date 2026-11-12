"""
Egenkontrol R1b — "Ugens egenkontrol": the weekly look back.

GET /api/egenkontrol/week summarises ONE business week (Monday–Sunday, the
venue's zone and cutoff) with the very same code path as the Kontrolmappe
(egenkontrol_service.folder_data), so the card and the PDF can never
disagree. The owner marks a finished week as reviewed (food_check_reviews:
one row per ISO week, never edited; the second press returns the first row).

The review is ONE part of the business's own control — the card says so —
and it is a record of the registrations, never a claim that the kitchen is
safe. No push and no NeedsYou item: only the card on the Egenkontrol page.
"""

import uuid
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.food_check import FoodCheck, FoodCheckEntry, FoodCheckReview
from app.services import audit_service
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S


def review_out(r: FoodCheckReview, tz) -> dict:
    loc = R.to_local(r.reviewed_at, tz)
    return {
        "iso_week": r.iso_week,
        "week_start": r.week_start.isoformat(),
        "week_end": (r.week_start + timedelta(days=6)).isoformat(),
        "reviewed_at": S.iso_z(r.reviewed_at),
        "reviewed_local_date": loc.date().isoformat(),
        "reviewed_local": loc.strftime("%H:%M"),
        "actor_name": r.actor_name,
        "note": r.note,
    }


def reviews_between(db: Session, owner, date_from: date, date_to: date) -> list:
    """Reviews whose week overlaps [date_from, date_to], oldest first."""
    return (
        db.query(FoodCheckReview)
        .filter(
            FoodCheckReview.user_id == owner.id,
            FoodCheckReview.week_start <= date_to,
            FoodCheckReview.week_start >= date_from - timedelta(days=6),
        )
        .order_by(FoodCheckReview.week_start)
        .all()
    )


def _review_for(db: Session, owner, iso_week: str) -> Optional[FoodCheckReview]:
    return (
        db.query(FoodCheckReview)
        .filter(FoodCheckReview.user_id == owner.id, FoodCheckReview.iso_week == iso_week)
        .first()
    )


def _open_deviations(db: Session, owner, tz) -> list:
    rows = (
        db.query(FoodCheckEntry)
        .filter(
            FoodCheckEntry.user_id == owner.id,
            FoodCheckEntry.deviation_state == "open",
            FoodCheckEntry.voided_at.is_(None),
        )
        .order_by(FoodCheckEntry.recorded_at)
        .all()
    )
    if not rows:
        return []
    names = {
        str(c.id): c.name
        for c in db.query(FoodCheck).filter(
            FoodCheck.user_id == owner.id,
            FoodCheck.id.in_([e.check_id for e in rows]),
        ).all()
    }
    out = []
    for e in rows:
        loc = R.to_local(R.effective_at(e), tz)
        out.append({
            "entry_id": str(e.id),
            "check_name": names.get(str(e.check_id), ""),
            "value_c": None if e.value_c is None else float(e.value_c),
            "recorded_local_date": loc.date().isoformat(),
            "recorded_local": loc.strftime("%H:%M"),
        })
    return out


def build_week(db: Session, owner, start: Optional[date], *, role: str) -> dict:
    from app.services import egenkontrol_files as F
    from app.services import egenkontrol_records as REC

    now = S.now_utc()
    tz, cutoff, _ = S.zone_and_cutoff(db, owner)
    today = R.business_date_of(now, tz, cutoff)
    current_monday = R.iso_week_monday(today)
    if start is None:
        # The ISO week BEFORE the week that holds today's business date:
        # Monday 05:00 with a 06:00 cutoff is still Sunday's business day, so
        # "last week" is then the week before that.
        start = current_monday - timedelta(days=7)
    elif start.weekday() != 0 or start > current_monday:
        raise S.rule_http(R.RuleError("bad_week"))
    end = start + timedelta(days=6)
    over = end < today
    try:
        fd = S.folder_data(db, owner, start, min(end, today), None, max_days=7)
    except R.RuleError as e:
        raise S.rule_http(e)
    iso_week = R.iso_week_label(start)
    review = _review_for(db, owner, iso_week)
    today_local = R.to_local(now, tz).date()
    docs_due = [
        F.document_out(d, tz, today_local)
        for d in F.load_documents(db, owner, branch_scope=None)
    ]
    return {
        "iso_week": iso_week,
        "week_number": start.isocalendar()[1],
        "start": start.isoformat(),
        "end": end.isoformat(),
        "over": over,
        "has_activity": bool(fd.slot_results or fd.entries),
        "summary": fd.summary,
        "open_deviations": _open_deviations(db, owner, tz),
        "repeat_hints": REC.repeat_out(fd),
        "documents_review_due": [d for d in docs_due if d["review_state"] in ("soon", "overdue")],
        "review": review_out(review, tz) if review is not None else None,
        "can_review": bool(over and role == "owner" and review is None),
    }


def _text_field(v, max_len: int, code: str) -> Optional[str]:
    if v is None or not isinstance(v, str) or not v.strip():
        return None
    if len(v) > max_len:
        raise S.rule_http(R.RuleError(code, {"max_length": max_len}))
    return v


def mark_reviewed(db: Session, owner, iso_week: str, body, *, actor_user_id) -> tuple[dict, bool]:
    """→ (ReviewOut, replayed). A week is reviewed once; the second press
    gets the FIRST row back unchanged (its body is ignored)."""
    now = S.now_utc()
    tz, cutoff, _ = S.zone_and_cutoff(db, owner)
    try:
        monday = R.parse_iso_week(iso_week)
    except R.RuleError as e:
        raise S.rule_http(e)
    today = R.business_date_of(now, tz, cutoff)
    if not monday + timedelta(days=6) < today:
        raise S.conflict("week_not_over")
    existing = _review_for(db, owner, iso_week)
    if existing is not None:
        return review_out(existing, tz), True
    name = _text_field(getattr(body, "name", None), R.REVIEW_NAME_MAX, "name_too_long")
    note = _text_field(getattr(body, "note", None), R.REVIEW_NOTE_MAX, "note_too_long")
    row = FoodCheckReview(
        id=uuid.uuid4(),
        user_id=owner.id,
        iso_week=iso_week,
        week_start=monday,
        reviewed_at=now,
        actor_user_id=actor_user_id,
        actor_name=name,
        note=note,
        created_at=now,
    )
    db.add(row)
    db.flush()
    audit_service.record(db, owner, "egenkontrol.week_reviewed", "food_check_review", row.id,
                         after={"iso_week": iso_week}, actor_id=actor_user_id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        again = _review_for(db, owner, iso_week)
        if again is None:
            raise
        return review_out(again, tz), True
    db.refresh(row)
    return review_out(row, tz), False
