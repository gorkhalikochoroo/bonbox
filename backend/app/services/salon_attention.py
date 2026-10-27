"""What a salon owner has to act on before a week goes wrong (R6, 27 Oct 2026).

Two facts the Aftaler tab shows, both read-only and owner-only:

  * next_week_shifts — a salon's employed stylists are bookable only on
    PUBLISHED Vagtplan shifts (reservation_service.provider_windows). A next
    week with none of them published has no online time at all, and nothing
    said so (rubric S7, "0 times next week, no warning"). The answer carries
    what the one-tap fix needs: are there drafts waiting for Udgiv, or a week
    to copy from (POST /staff/schedules/copy-week copies as Kladde).

  * absence_conflicts — R1 took a stylist on Ferie / Syg off the guest page,
    but appointments booked before the absence stayed in the book; the book
    flags them only on the day itself. This lists every upcoming one, so the
    owner can move it or call the customer (rubric S6).

  * salon_capacity (R7) — per day, who customers can book online and how
    many at the same time ("2 kan bookes samtidig (dig og Mia)", rubric S5).
    The engine always booked one customer per chair in parallel; nothing
    told the owner. Read from the SAME windows the booking engine books on
    (reservation_service._batched_provider_windows), so the line can never
    promise a chair the guest page would not offer.

Nothing here writes, and every reader is tenant-scoped on user_id.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.absence import StaffAbsence
from app.models.bookable_resource import BookableResource
from app.models.reservation import Reservation
from app.models.staff import Schedule, StaffMember
from app.services import reservation_service as rsvc
from app.services.reservation_service import ABSENCE_BLOCKING_STATUSES

logger = logging.getLogger(__name__)

# How far ahead the absence list looks: the venue's booking window, at least
# 60 days and never more than 180.
HORIZON_MIN_DAYS = 60
HORIZON_MAX_DAYS = 180
# The card shows the first few; the count is the whole truth.
CONFLICTS_MAX = 50
# A booking that still holds a chair (a cancelled or finished one does not).
_OPEN_STATUSES = ("requested", "confirmed")


def week_monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _bookable_stylists(db: Session, user_id) -> list:
    """Staff ids behind ACTIVE chairs that follow Vagtplan shifts (not the
    owner's self-chair, and not a stylist who follows the opening hours —
    R7 — neither needs a shift to be booked)."""
    rows = (
        db.query(BookableResource.staff_id)
        .filter(
            BookableResource.user_id == user_id,
            BookableResource.kind == "provider",
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
            BookableResource.staff_id.isnot(None),
            BookableResource.follows_opening_hours.is_(False),
        )
        .all()
    )
    seen: list = []
    for (sid,) in rows:
        if sid is not None and sid not in seen:
            seen.append(sid)
    return seen


def next_week_shifts(db: Session, user_id, today: date) -> dict | None:
    """Next week's shifts for the bookable stylists, or None when the salon
    has no stylist on shifts (a self-chair salon needs no Vagtplan).

        {"week_start": "YYYY-MM-DD" (next Monday), "stylists": n,
         "published": n, "drafts": n,
         "this_week": n}   # every shift this week — what copy-week copies
    """
    staff_ids = _bookable_stylists(db, user_id)
    if not staff_ids:
        return None
    this_monday = week_monday(today)
    next_monday = this_monday + timedelta(days=7)
    counts = dict(
        db.query(Schedule.status, func.count(Schedule.id))
        .filter(
            Schedule.user_id == user_id,
            Schedule.staff_id.in_(staff_ids),
            Schedule.date >= next_monday,
            Schedule.date <= next_monday + timedelta(days=6),
        )
        .group_by(Schedule.status)
        .all()
    )
    # copy-week copies EVERY shift of the source week (any staff, any
    # status), so this counts the same rows it would copy.
    this_week = (
        db.query(func.count(Schedule.id))
        .filter(
            Schedule.user_id == user_id,
            Schedule.date >= this_monday,
            Schedule.date <= this_monday + timedelta(days=6),
        )
        .scalar()
    ) or 0
    return {
        "week_start": next_monday.isoformat(),
        "this_week_start": this_monday.isoformat(),
        "stylists": len(staff_ids),
        "published": int(counts.get("published", 0) or 0),
        "drafts": int(counts.get("draft", 0) or 0),
        "this_week": int(this_week),
    }


def absence_conflicts(db: Session, user_id, *, now_local: datetime,
                      horizon_days: int) -> dict:
    """Upcoming appointments that sit on their stylist's absence day.

        {"count": n, "items": [{"id", "day", "time", "guest_name",
                                "service_name", "stylist", "kind"}, …]}

    `now_local` is the venue's wall clock (naive, like starts_at). Items are
    sorted by start and capped at CONFLICTS_MAX; `count` is all of them.
    The guest's name goes back as stored — the screen defangs it."""
    horizon = max(HORIZON_MIN_DAYS, min(HORIZON_MAX_DAYS, int(horizon_days or 0)))
    today = now_local.date()
    last = today + timedelta(days=horizon)
    chairs = (
        db.query(BookableResource.id, BookableResource.staff_id, BookableResource.label)
        .filter(
            BookableResource.user_id == user_id,
            BookableResource.kind == "provider",
            BookableResource.staff_id.isnot(None),
        )
        .all()
    )
    if not chairs:
        return {"count": 0, "items": []}
    staff_by_chair = {str(rid): sid for rid, sid, _ in chairs}
    label_by_chair = {str(rid): label for rid, _, label in chairs}
    staff_ids = list({sid for _, sid, _ in chairs})
    away = {}
    for sid, day, kind in (
        db.query(StaffAbsence.staff_id, StaffAbsence.date, StaffAbsence.kind)
        .filter(
            StaffAbsence.user_id == user_id,
            StaffAbsence.staff_id.in_(staff_ids),
            StaffAbsence.date >= today,
            StaffAbsence.date <= last,
            StaffAbsence.status.in_(ABSENCE_BLOCKING_STATUSES),
        )
        .all()
    ):
        away.setdefault((str(sid), day), kind)
    if not away:
        return {"count": 0, "items": []}
    rows = (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user_id,
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_OPEN_STATUSES),
            Reservation.resource_id.in_([rid for rid, _, _ in chairs]),
            Reservation.starts_at >= now_local.replace(tzinfo=None),
            Reservation.starts_at < datetime.combine(last + timedelta(days=1), time(0, 0)),
        )
        .order_by(Reservation.starts_at)
        .all()
    )
    hits = []
    for r in rows:
        sid = staff_by_chair.get(str(r.resource_id))
        kind = away.get((str(sid), r.starts_at.date())) if sid is not None else None
        if kind:
            hits.append((r, sid, kind))
    if not hits:
        return {"count": 0, "items": []}
    names = {
        m_id: name
        for m_id, name in (
            db.query(StaffMember.id, StaffMember.name)
            .filter(StaffMember.user_id == user_id,
                    StaffMember.id.in_(list({sid for _, sid, _ in hits})))
            .all()
        )
    }
    items = []
    for r, sid, kind in hits[:CONFLICTS_MAX]:
        items.append({
            "id": str(r.id),
            "day": r.starts_at.date().isoformat(),
            "time": r.starts_at.strftime("%H:%M"),
            "guest_name": r.guest_name,
            "service_name": r.service_name,
            "stylist": names.get(sid) or label_by_chair.get(str(r.resource_id)) or None,
            "kind": kind,
            "status": r.status,
        })
    return {"count": len(hits), "items": items}


# ── R7: who can be booked, per day ──────────────────────────────────────
CAPACITY_MAX_DAYS = 14


def max_overlap(spans) -> int:
    """The most [start, end) spans that cover one instant. Half-open, like
    the engine: a span that ends at 12:00 and one that starts at 12:00 are
    never at the same time."""
    events = []
    for a, b in spans:
        if b > a:
            events.append((a, 1))
            events.append((b, -1))
    events.sort(key=lambda e: (e[0], e[1]))   # an end (-1) before a start at the same instant
    now = best = 0
    for _, step in events:
        now += step
        best = max(best, now)
    return best


def salon_capacity(db: Session, user_id, profile, *, start: date, days: int) -> list[dict]:
    """Per day in [start, start + days): who customers can book online.

        [{"date": "YYYY-MM-DD",
          "count": n,                 # the most chairs open at one time
          "people": [{"id", "name", "self", "windows": [["09:00", "17:00"]]}],
          "away": [{"id", "name", "kind"}],   # a stylist on Ferie / Syg / …
          "hours_closed": bool,       # the hours card says closed that weekday
          "closed": None | "closed_date" | "paused", "note": str | None}, …]

    `self` is the owner's own chair (follows the opening hours, no staff
    member). A date the owner closed for online booking counts 0 — she can
    still write a customer in herself (decision 3). Names are the ones the
    guest page shows: the stylist's name, else the chair's label."""
    days = max(1, min(CAPACITY_MAX_DAYS, int(days or 1)))
    end = start + timedelta(days=days - 1)
    settings = rsvc.load_settings(profile)
    providers = [r for r in rsvc.active_resources(db, user_id) if r.kind == "provider"]
    windows_for = rsvc._batched_provider_windows(db, user_id, providers, start, end, settings)
    staff_ids = list({p.staff_id for p in providers if p.staff_id})
    names: dict = {}
    away_kind: dict = {}
    if staff_ids:
        names = {
            sid: name
            for sid, name in (
                db.query(StaffMember.id, StaffMember.name)
                .filter(StaffMember.user_id == user_id, StaffMember.id.in_(staff_ids))
                .all()
            )
        }
        for sid, d, kind in (
            db.query(StaffAbsence.staff_id, StaffAbsence.date, StaffAbsence.kind)
            .filter(
                StaffAbsence.user_id == user_id,
                StaffAbsence.staff_id.in_(staff_ids),
                StaffAbsence.date >= start,
                StaffAbsence.date <= end,
                StaffAbsence.status.in_(ABSENCE_BLOCKING_STATUSES),
            )
            .all()
        ):
            away_kind.setdefault((str(sid), d), kind)
    bh = settings.get("booking_hours")
    out: list[dict] = []
    for i in range(days):
        d = start + timedelta(days=i)
        people: list[dict] = []
        away: list[dict] = []
        spans: list = []
        for p in providers:
            sid = p.staff_id
            name = ((names.get(sid) if sid else None) or p.label or "Behandler").strip()
            kind = away_kind.get((str(sid), d)) if sid else None
            if kind:
                away.append({"id": str(p.id), "name": name, "kind": kind})
                continue
            ws = windows_for(p, d)
            if not ws:
                continue
            people.append({
                "id": str(p.id), "name": name,
                "self": bool(getattr(p, "follows_opening_hours", False)) and not sid,
                "windows": rsvc._hhmm_pairs(ws),
            })
            spans.extend((w.start, w.end) for w in ws)
        closure = rsvc.closure_on(settings, d)
        out.append({
            "date": d.isoformat(),
            "count": 0 if closure is not None else max_overlap(spans),
            "people": people,
            "away": away,
            "hours_closed": isinstance(bh, dict) and bh.get(rsvc._WEEKDAY_KEYS[d.weekday()]) == "closed",
            # A closed date, or a pause of online booking (R1 B5).
            "closed": (None if closure is None
                       else "paused" if closure.get("kind") == "pause" else "closed_date"),
            "note": closure.get("note") if closure is not None else None,
        })
    return out
