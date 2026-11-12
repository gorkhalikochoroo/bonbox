"""GET /api/today — the owner's "I dag" page in ONE owner-only read.

The page (frontend pages/TodayPage.jsx) answers "how is today going, and what
needs me" for a restaurant / café / bar / salon owner. Everything on it is a
fact the database already holds; this router only gathers those facts on the
venue's clock so the page never re-derives "today" from a browser clock in
another zone. Nothing here writes.

Every figure comes from an existing source of truth (see
bonbox-lab-state/design-departments-2026-11-11/today-notes/mapping.md):

  • the business day — tz_utils.business_today_local / business_day_window_local
    (venue zone, the owner's day cutoff, 06:00 by default);
  • revenue — revenue_resolver (a confirmed close wins over Sale rows);
  • lønprocent — wage cost of the SETTLED days (the same numbers as
    /staff/schedules/week-cost) over revenue EXCLUDING moms
    (revenue_resolver.effective_revenue_ex_moms_by_date; Manoj, 20 Oct 2026);
  • shifts — staff.shifts_payload_for_day, the /staff/today rows;
  • "needs you" badges — diagnostics_service detectors.

Honesty rules the payload is shaped around:
  • unknown is null, never 0 (no opening hours → `hours: null`, no settled day
    → `labor_pct_ex_moms: null`, no seats → `seats: null`);
  • the sales trend is a WORD and only exists like-for-like — both days closed
    with a confirmed kasserapport (a part day is never compared with a whole
    day);
  • a count of things that need the owner only counts things they can act on.

Multi-barrier: L1 auth (get_current_user) · L2 owner-only (a member view is
refused here AND by main.py's _MEMBER_READ_DENY_PREFIXES, which also covers a
locked shared device) · L3 tenant scope (user.id on every query) · L4 rate
limit · L5 fail-soft per block (one failing block returns null, never a 500).

NO `from __future__ import annotations` in this module: slowapi + postponed
annotations turns the Request parameter into a silent 422.
"""
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.sale import Sale
from app.models.staff import HoursLogged, Schedule
from app.models.user import User
from app.services.auth import get_current_user
from app.services.revenue_resolver import (
    effective_revenue_by_date,
    effective_revenue_ex_moms_by_date,
)
from app.services.tz_utils import (
    _user_cutoff_hour,
    _user_zone,
    business_day_window_local,
    business_today_local,
    now_local,
)
from app.utils.client_ip import client_ip

log = logging.getLogger(__name__)

router = APIRouter()
_limiter = Limiter(key_func=client_ip)

# Bookings that hold a seat tonight. `requested` waits for the OWNER's answer
# and is counted apart (it is the actionable badge), cancelled / no_show never
# count.
_SEATED_STATUSES = ("confirmed", "seated", "completed")
_LISTED_STATUSES = ("requested", "confirmed", "seated", "completed")

# The like-for-like trend word: within ±3 % reads "same", and a last-week day
# under 1.000 kr. is too thin a baseline to call a direction on.
_TREND_SAME_BAND = 0.03
_TREND_MIN_BASELINE = 1000.0

_DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HHMM = re.compile(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})")


def _hhmm(h: int, m: int) -> str:
    return f"{h:02d}:{m:02d}"


def _minutes(hhmm: Optional[str]) -> Optional[int]:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        return None
    try:
        h, m = hhmm.split(":", 1)
        return int(h) * 60 + int(m[:2])
    except (TypeError, ValueError):
        return None


def parse_day_hours(raw) -> Optional[dict]:
    """One day's opening hours from operating_hours_json → {open, close} or
    {closed: True}; None when not configured or unreadable. Several windows
    ("11:00-14:00, 17:00-22:00") collapse to first open / last close."""
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    if text == "closed" or text == "lukket":
        return {"closed": True}
    spans = _HHMM.findall(text)
    if not spans:
        return None
    first, last = spans[0], spans[-1]
    return {
        "open": _hhmm(int(first[0]), int(first[1])),
        "close": _hhmm(int(last[2]), int(last[3])),
    }


def _hours_for(profile, d: date) -> Optional[dict]:
    if profile is None:
        return None
    try:
        from app.services.business_operating_service import parse_operating_hours
        data = parse_operating_hours(profile) or {}
    except Exception:  # noqa: BLE001 — unreadable hours are "unknown", never an error
        return None
    return parse_day_hours(data.get(_DAY_KEYS[d.weekday()]))


def day_state_for(hours: Optional[dict], now_min: int, cutoff_hour: int, has_activity: bool) -> str:
    """before_open | open | after_close | closed_today | unknown.

    `now_min` is the venue wall clock in minutes since midnight. Wall-clock
    minutes before the cutoff belong to the previous business day's night, so
    they are shifted +24h before comparing (an 01:30 now on a 17:00–02:00 bar
    is still "open"). Activity (a sale or a close already on the books) means
    the day has started, whatever the hours say."""
    if hours is None:
        return "open" if has_activity else "unknown"
    if hours.get("closed"):
        return "open" if has_activity else "closed_today"
    o = _minutes(hours.get("open"))
    c = _minutes(hours.get("close"))
    if o is None or c is None:
        return "open" if has_activity else "unknown"
    cut = cutoff_hour * 60
    n = now_min + 1440 if now_min < cut else now_min
    if c <= o:
        c += 1440
    if c <= cut:  # a close at e.g. 01:00 written after a 06:00 cutoff
        c += 1440
    if n < o:
        return "open" if has_activity else "before_open"
    if n >= c:
        return "after_close"
    return "open"


def trend_word(today_amount: float, baseline: float) -> Optional[str]:
    """higher | lower | same — or None when the baseline is too thin."""
    if baseline is None or baseline < _TREND_MIN_BASELINE:
        return None
    ratio = (today_amount or 0.0) / baseline
    if ratio > 1 + _TREND_SAME_BAND:
        return "higher"
    if ratio < 1 - _TREND_SAME_BAND:
        return "lower"
    return "same"


def labor_pct_ex_moms(daily: list, ex_moms_by_date: dict) -> Optional[float]:
    """Wage cost ÷ revenue ex moms over the SETTLED days of the week.

    `daily` is week-cost's per-day list (date, cost_gross, settled). Unknown
    is contagious, exactly as week-cost has it: one settled day with an
    unpriced shift makes the week unknown. No settled day → None."""
    cost = 0.0
    rev = 0.0
    any_day = False
    for d in daily or []:
        if not d.get("settled"):
            continue
        if d.get("cost_gross") is None:
            return None
        any_day = True
        cost += float(d["cost_gross"])
        try:
            key = date.fromisoformat(d["date"])
        except (KeyError, TypeError, ValueError):
            return None
        rev += float(ex_moms_by_date.get(key, 0.0) or 0.0)
    if not any_day or rev <= 0:
        return None
    return round(cost / rev, 4)


def _local_hhmm(user, dt: Optional[datetime]) -> Optional[str]:
    """A naive-UTC stamp (utils.time.utc_now) on the venue's wall clock."""
    if dt is None:
        return None
    try:
        aware = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        loc = aware.astimezone(_user_zone(user))
        return _hhmm(loc.hour, loc.minute)
    except Exception:  # noqa: BLE001
        return None


def _safe(block_name: str, fn):
    try:
        return fn()
    except Exception:  # noqa: BLE001 — one failing block must not blank the page
        log.exception("today: block %s failed", block_name)
        return None


# ── blocks ──────────────────────────────────────────────────────────────


def _sales_block(db: Session, user: User, day: date) -> dict:
    lw = day - timedelta(days=7)
    rev = effective_revenue_by_date(db, user.id, lw, day)
    today_amt = float(rev.get(day, 0.0) or 0.0)
    yesterday_amt = float(rev.get(day - timedelta(days=1), 0.0) or 0.0)
    lw_amt = float(rev.get(lw, 0.0) or 0.0)

    closed = {
        d for (d,) in db.query(DailyClose.date).filter(
            DailyClose.user_id == user.id,
            DailyClose.date.in_([day, lw]),
            DailyClose.is_deleted.isnot(True),
            DailyClose.status == "confirmed",
        ).all()
    }
    sale_count = (
        db.query(func.count(Sale.id)).filter(
            Sale.user_id == user.id,
            Sale.date == day,
            Sale.is_deleted.isnot(True),
            Sale.status == "completed",
        ).scalar()
    ) or 0
    closes_30d = (
        db.query(func.count(DailyClose.id)).filter(
            DailyClose.user_id == user.id,
            DailyClose.date >= day - timedelta(days=30),
            DailyClose.date < day,
            DailyClose.is_deleted.isnot(True),
            DailyClose.status == "confirmed",
        ).scalar()
    ) or 0

    both_closed = day in closed and lw in closed
    return {
        "today": round(today_amt, 2),
        "today_closed": day in closed,
        "today_sale_count": int(sale_count),
        "yesterday": round(yesterday_amt, 2) if yesterday_amt > 0 else None,
        "last_week_same_day": round(lw_amt, 2) if lw_amt > 0 else None,
        # Only like-for-like: two whole, locked days.
        "trend": trend_word(today_amt, lw_amt) if both_closed else None,
        "uses_daily_close": closes_30d > 0,
        "confirmed_closes_30d": int(closes_30d),
    }


def _reservations_block(db: Session, user: User, day: date, hours: Optional[dict]) -> dict:
    lo, hi = business_day_window_local(user, day)
    rows = (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user.id,
            Reservation.starts_at >= lo,
            Reservation.starts_at < hi,
            Reservation.is_deleted.isnot(True),
            Reservation.deleted_at.is_(None),
            Reservation.status.in_(_LISTED_STATUSES),
        )
        .order_by(Reservation.starts_at)
        .all()
    )
    resources = (
        db.query(BookableResource)
        .filter(
            BookableResource.user_id == user.id,
            BookableResource.is_deleted.isnot(True),
        )
        .all()
    )
    label_by_id = {str(r.id): r.label for r in resources}
    table_seats = [
        int(r.capacity_seats or 0) for r in resources
        if r.is_active and (r.kind or "table") == "table"
    ]
    seats = sum(table_seats) or None

    items = []
    covers = 0
    requested = 0
    for r in rows:
        ids = []
        if r.resource_id:
            ids.append(str(r.resource_id))
        for extra in (r.combined_resource_ids or []):
            if str(extra) not in ids:
                ids.append(str(extra))
        labels = [label_by_id[i] for i in ids if i in label_by_id]
        if r.status in _SEATED_STATUSES:
            covers += int(r.party_size or 0)
        if r.status == "requested":
            requested += 1
        items.append({
            "id": str(r.id),
            "time": _hhmm(r.starts_at.hour, r.starts_at.minute),
            "ends": _hhmm(r.ends_at.hour, r.ends_at.minute) if r.ends_at else None,
            "name": r.guest_name or None,
            "party": int(r.party_size or 0),
            "tables": labels,
            "status": r.status,
            "service": r.service_name or None,
            # Never the guest's own words — a yes/no the page turns into the
            # word "Allergi" (Art. 9 data stays on the reservation page).
            "allergy": bool(r.allergen_tags) or bool((r.allergy_note or "").strip()),
            "occasion": (r.occasion or "").strip()[:40] or None,
        })

    # Booked covers per 30-minute slot across the service, for the chart.
    slots = []
    seated_rows = [r for r in rows if r.status in _SEATED_STATUSES]
    if seated_rows:
        # Minutes since the business day's own midnight, so a 00:30 booking
        # (tonight's service, after midnight) sits at 24:30, not at 00:30.
        day_start = datetime.combine(lo.date(), datetime.min.time())
        start_min = min(int((r.starts_at - day_start).total_seconds() // 60) for r in seated_rows)
        end_dt = max((r.ends_at or r.starts_at) for r in seated_rows)
        end_min = int((end_dt - day_start).total_seconds() // 60)
        if hours and not hours.get("closed"):
            o = _minutes(hours.get("open"))
            if o is not None:
                start_min = min(start_min, o)
        start_min -= start_min % 30
        t = start_min
        guard = 0
        while t < end_min and guard < 96:
            s_lo = day_start + timedelta(minutes=t)
            s_hi = s_lo + timedelta(minutes=30)
            c = sum(
                int(r.party_size or 0) for r in seated_rows
                if r.starts_at < s_hi and (r.ends_at or r.starts_at + timedelta(minutes=r.duration_min or 90)) > s_lo
            )
            slots.append({"t": _hhmm((t // 60) % 24, t % 60), "m": t, "covers": c})
            t += 30
            guard += 1
    peak = None
    if slots:
        best = max(slots, key=lambda s: s["covers"])
        if best["covers"] > 0:
            peak = {"time": best["t"], "covers": best["covers"], "full": bool(seats and best["covers"] >= seats)}

    waitlist = (
        db.query(func.count(ReservationWaitlistEntry.id)).filter(
            ReservationWaitlistEntry.user_id == user.id,
            ReservationWaitlistEntry.waitlist_date == day,
            ReservationWaitlistEntry.status == "waiting",
        ).scalar()
    ) or 0

    has_book = bool(resources) or bool(rows) or (
        db.query(Reservation.id).filter(Reservation.user_id == user.id).limit(1).first() is not None
    )
    return {
        "has_book": has_book,
        "seats": seats,
        "count": sum(1 for r in rows if r.status in _SEATED_STATUSES),
        "covers": covers,
        "requested": requested,
        "waitlist": int(waitlist),
        "peak": peak,
        "slots": slots,
        "items": items,
    }


def _staff_block(db: Session, user: User, day: date) -> dict:
    from app.routers.staff import shifts_payload_for_day
    shifts = shifts_payload_for_day(db, user, day)
    since = day - timedelta(days=14)
    uses_clock = db.query(HoursLogged.id).filter(
        HoursLogged.user_id == user.id,
        HoursLogged.entry_method == "clock",
        HoursLogged.date >= since,
    ).limit(1).first() is not None
    clocked_in = None
    if uses_clock:
        clocked_in = (
            db.query(func.count(HoursLogged.id)).filter(
                HoursLogged.user_id == user.id,
                HoursLogged.entry_method == "clock",
                HoursLogged.end_time.is_(None),
                HoursLogged.date >= day - timedelta(days=1),
                HoursLogged.date <= day,
            ).scalar()
        ) or 0
    return {"shifts": shifts, "uses_clock": uses_clock, "clocked_in_now": clocked_in}


def _close_block(db: Session, user: User, day: date, profile) -> dict:
    # Four Monday-aligned weeks ending with this one (the heatmap's rows):
    # the three full weeks before + this week up to today. The page pads the
    # rest of this week as "kommende".
    start = day - timedelta(days=day.weekday()) - timedelta(days=21)
    rows = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date >= start,
            DailyClose.date <= day,
            DailyClose.is_deleted.isnot(True),
        )
        .all()
    )
    by_day: dict[date, list] = {}
    for r in rows:
        by_day.setdefault(r.date, []).append(r)

    def summary(d: date) -> dict:
        rs = by_day.get(d) or []
        confirmed = [r for r in rs if (r.status or "confirmed") == "confirmed"]
        if confirmed:
            status = "confirmed"
        elif rs:
            status = "draft"
        else:
            status = "none"
        lead = (confirmed or rs or [None])[0]
        closed_at = max((r.closed_at for r in confirmed if r.closed_at), default=None)
        return {
            "date": d.isoformat(),
            "status": status,
            "revenue": round(sum(float(r.revenue_total or 0) for r in confirmed), 2) if confirmed else None,
            "closed_at": _local_hhmm(user, closed_at),
            "steps": {
                "photo": bool(lead is not None and (lead.receipt_photo or "").strip()),
                "sales": bool(lead is not None and float(lead.revenue_total or 0) > 0),
                "payments": bool(lead is not None and float(lead.payment_total or 0) > 0),
                "locked": status == "confirmed",
            },
        }

    days = []
    for i in range((day - start).days + 1):
        d = start + timedelta(days=i)
        s = summary(d)
        h = _hours_for(profile, d)
        s["venue_closed"] = bool(h and h.get("closed"))
        days.append({k: s[k] for k in ("date", "status", "revenue", "venue_closed")})
    return {
        "today": summary(day),
        "yesterday": summary(day - timedelta(days=1)),
        "days": days,
    }


def _schedule_block(db: Session, user: User, day: date) -> dict:
    week_start = day - timedelta(days=day.weekday())
    week_end = week_start + timedelta(days=6)
    drafts = (
        db.query(func.count(Schedule.id)).filter(
            Schedule.user_id == user.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "draft",
        ).scalar()
    ) or 0
    return {
        "week_start": week_start.isoformat(),
        "week_number": day.isocalendar()[1],
        "drafts": int(drafts),
    }


def _labor_block(db: Session, user: User, day: date) -> dict:
    from app.routers.staff import schedule_week_cost
    from app.services.tax_service import _get_vat_rate

    week_start = day - timedelta(days=day.weekday())
    week_end = week_start + timedelta(days=6)
    wc = schedule_week_cost(week_start=week_start, db=db, user=user)
    daily = wc.get("daily") or []

    logged = (
        db.query(HoursLogged.date, func.coalesce(func.sum(HoursLogged.total_hours), 0))
        .filter(
            HoursLogged.user_id == user.id,
            HoursLogged.date >= week_start,
            HoursLogged.date <= week_end,
            HoursLogged.end_time.isnot(None),
        )
        .group_by(HoursLogged.date)
        .all()
    )
    logged_by = {d: float(h or 0) for d, h in logged}

    rate = _get_vat_rate(getattr(user, "currency", None) or "DKK")
    incl = getattr(user, "prices_include_moms", True)
    incl = True if incl is None else bool(incl)
    ex_moms = effective_revenue_ex_moms_by_date(db, user.id, week_start, week_end, rate, incl)

    planned = [round(float(d.get("hours") or 0), 2) for d in daily]
    done = [round(logged_by.get(week_start + timedelta(days=i), 0.0), 2) for i in range(7)]
    settled_days = sum(1 for d in daily if d.get("settled"))
    return {
        "week_start": week_start.isoformat(),
        "week_number": day.isocalendar()[1],
        "planned_by_day": planned,
        "logged_by_day": done,
        "planned_total": round(sum(planned), 2),
        "logged_total": round(sum(done), 2),
        "labor_pct_ex_moms": labor_pct_ex_moms(daily, ex_moms),
        "settled_days": settled_days,
        "target_pct": wc.get("target_labor_pct"),
        "missing_wage": len(wc.get("missing_wage") or []),
    }


def _badges(db: Session, user: User, day: date) -> dict:
    """Only actionable counts: bookings waiting for the owner's answer, draft
    shifts this week nobody can see yet, and a missing kasserapport."""
    from app.services.diagnostics_service import (
        _detect_close_missing,
        _detect_unconfirmed_reservations,
    )
    from app.utils.time import utc_now

    now = utc_now()
    out = {"reservations": 0, "schedule": 0, "daily_close": 0}
    f = _safe("badge_rsvp", lambda: _detect_unconfirmed_reservations(db, user, now))
    if f:
        out["reservations"] = int((f.get("meta") or {}).get("count") or 0)
    sch = _safe("badge_schedule", lambda: _schedule_block(db, user, day))
    if sch:
        out["schedule"] = int(sch.get("drafts") or 0)
    cm = _safe("badge_close", lambda: _detect_close_missing(db, user, now))
    if cm:
        out["daily_close"] = 1
    return out


@router.get("")
@_limiter.limit("60/minute")
def get_today(
    request: Request,
    part: Optional[str] = Query(None, pattern="^(badges)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # L2 — owner-only. main.py's member read guard refuses this prefix for
    # invited seats and a locked shared device first; this is the second wall.
    if getattr(user, "_is_member_view", False) or getattr(user, "_shared_device_locked", False):
        raise HTTPException(status_code=403, detail="owner_only")

    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    if profile is not None and profile.day_cutoff_hour is not None:
        user.day_cutoff_hour = profile.day_cutoff_hour
    day = business_today_local(user)

    if part == "badges":
        return {"business_day": day.isoformat(), "badges": _badges(db, user, day)}

    now = now_local(user)
    now_min = now.hour * 60 + now.minute
    hours = _hours_for(profile, day)
    cutoff = _user_cutoff_hour(user)

    sales = _safe("sales", lambda: _sales_block(db, user, day))
    has_activity = bool(sales and (sales["today"] > 0 or sales["today_sale_count"] > 0 or sales["today_closed"]))
    close = _safe("close", lambda: _close_block(db, user, day, profile))
    if close and close["today"]["status"] != "none":
        has_activity = True

    return {
        "business_day": day.isoformat(),
        "weekday": day.weekday(),
        "now": _hhmm(now.hour, now.minute),
        "now_minutes": now_min,
        "cutoff_hour": cutoff,
        "hours": hours,
        "day_state": day_state_for(hours, now_min, cutoff, has_activity),
        "sales": sales,
        "reservations": _safe("reservations", lambda: _reservations_block(db, user, day, hours)),
        "staff": _safe("staff", lambda: _staff_block(db, user, day)),
        "close": close,
        "schedule": _safe("schedule", lambda: _schedule_block(db, user, day)),
        "labor": _safe("labor", lambda: _labor_block(db, user, day)),
        "revisor": {
            "has_accountant_email": bool(profile is not None and (profile.accountant_email or "").strip()),
            "schedule": getattr(profile, "revisor_package_schedule", None) if profile is not None else None,
        },
        "badges": _badges(db, user, day),
    }
