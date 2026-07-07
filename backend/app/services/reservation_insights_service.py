"""Reservations Insights — owner-facing analytics on the booking book.

Reads the reservation domain (Reservation + ReservationOccupancy +
BookableResource) and turns it into the handful of operator-grade signals a
restaurant owner actually acts on:

  • utilization   — seat-hour utilization (occupied seat-minutes ÷ available
                    seat-minutes) AND covers-vs-capacity. The seat-hour figure
                    reads ReservationOccupancy (the SAME source the DB
                    exclusion constraint enforces), so a combined seating
                    counts each held table and a cancelled/no-show row frees
                    its minutes automatically.
  • heatmap       — weekday (Mon-first, DK) × day-part matrix of booked covers
                    (sum party_size), business-day bucketed.
  • no_show_rate  — no_show ÷ (confirmed+seated+completed+no_show), plus a
                    by-lead-time-bucket breakdown (starts_at − created_at).
  • source_mix    — counts + covers by source (public / manual / walk_in).
  • party_size_fit— histogram of party_size vs the capacity_seats distribution
                    of the active resources (are tables sized for the parties?).
  • forecast      — (Pro-gated + only when CONFIDENT) a trailing-same-weekday
                    average of booked covers for the next 7 days. Heuristic
                    only — no ML — and it always carries its basis
                    ("based on last N same-weekdays"). Never emitted on
                    provisional data.

────────────────────────────────────────────────────────────────────────
Honest-claims doctrine (this whole module's reason to exist)
────────────────────────────────────────────────────────────────────────
Thin reservation data lies. A no-show rate off 3 bookings is noise; a
heatmap cell off 1 sample is a coin flip. So EVERY insight is tagged with a
shared confidence state — "hidden" | "provisional" | "confident" — via the
ONE gate `insight_confidence(n, weeks)`. The frontend renders hidden
insights as "not enough data yet", provisional with a caveat, confident
plainly. A forecast is the one thing that NEVER emits while provisional —
a confident-looking forecast on noise is the exact dishonesty we refuse.

Wherever a number has a denominator that could be one of two things
(covers from the POS `Sale.guest_count` vs booked covers = Σ party_size),
we LABEL which basis was used so the owner is never misled about what the
percentage is over.

Multi-barrier: this service is tenant-scoped by CONTRACT — every query
filters by `user.id`, and the router is the auth/tenant/tier barrier. The
service itself is fail-soft: it never raises into the request. Any internal
error degrades that one insight to an empty/hidden state and the rest still
render (a single bad sub-computation can't blank the whole page).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.bookable_resource import BookableResource
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.sale import Sale
from app.services import reservation_service as rsvc
from app.services import revenue_resolver
from app.services.tz_utils import business_day_window_local, business_today_local
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ─── Confidence thresholds (named so tests + UI read the SAME source) ──────
#
# These are deliberately conservative. A restaurant books a handful of covers
# a night; a week of real data is a few dozen reservations. "Confident" should
# mean "an operator can lean on this", not "we have 5 rows".
#
# Two dimensions gate confidence:
#   • N  — the raw sample count behind the insight (reservations / cells / etc.)
#   • weeks — how many distinct business-weeks the window spans (a forecast on
#     2 same-weekdays is noise no matter how many covers each had).
#
# The ladder:
#   N <  HIDDEN_MIN_N                       → "hidden"      (don't show a number)
#   HIDDEN_MIN_N <= N < CONFIDENT_MIN_N     → "provisional" (show, but caveat)
#   N >= CONFIDENT_MIN_N AND weeks enough   → "confident"
CONFIDENCE_HIDDEN_MIN_N: int = 5
CONFIDENCE_CONFIDENT_MIN_N: int = 30

# A confident verdict ALSO needs the window to span enough distinct weeks —
# 30 covers all on one freak Saturday isn't a confident weekly pattern.
CONFIDENCE_CONFIDENT_MIN_WEEKS: int = 2

# Heatmap cells are far sparser than the page-level aggregate (one weekday ×
# day-part cell only sees a fraction of bookings), so they get their own,
# lower "this cell has enough to trust" threshold. Below it the cell is
# flagged low-confidence rather than hidden — the matrix still renders.
HEATMAP_CELL_MIN_SAMPLES: int = 3

# Forecast: a trailing same-weekday average needs at least this many prior
# same-weekday observations to emit at all (e.g. ≥3 prior Fridays to forecast
# next Friday). Fewer → that day is omitted from the forecast series.
FORECAST_MIN_SAME_WEEKDAYS: int = 3

# Default analytics window and the parse table for the `range` query param.
DEFAULT_RANGE_DAYS: int = 28
RANGE_PRESETS: dict[str, int] = {
    "1w": 7,
    "2w": 14,
    "4w": 28,
    "8w": 56,
    "12w": 84,
}
# Hard clamp so a hand-crafted ?range can't ask the service to scan years.
MAX_RANGE_DAYS: int = 366
MIN_RANGE_DAYS: int = 1

# Statuses that represent a real, served-or-to-be-served booking — the
# denominator for the no-show rate (a cancelled booking isn't a no-show
# opportunity; a requested-but-never-approved group hold isn't either).
NO_SHOW_DENOMINATOR_STATUSES = ("confirmed", "seated", "completed", "no_show")

# Statuses that count toward "covers we booked / seated" for the heatmap,
# utilization covers-vs-capacity, and forecast. A cancelled / no_show party
# never sat, so it contributes no covers. `requested` is excluded — it's an
# un-approved hold, not a booking yet.
BOOKED_COVER_STATUSES = ("confirmed", "seated", "completed")

# Day-parts (local wall-clock hour of starts_at). Mon-first weekday handled
# separately. These bins match the restaurant operator's mental model and the
# spec: Lunch 11–14 / Afternoon 14–17 / Dinner 17–22 / Late 22+. Post-midnight
# hours before the business-day cutoff (e.g. 02:00 with a 06:00 cutoff) are
# late-night service → "Late" (see _day_part). A genuine early booking at/after
# the cutoff but before 11:00 folds into "Morning".
DAY_PARTS: list[str] = ["Morning", "Lunch", "Afternoon", "Dinner", "Late"]

# Mon-first weekday order (DK convention). Index aligns with Python's
# date.weekday() (Mon=0 … Sun=6) so no remap is needed.
WEEKDAYS: list[str] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Lead-time buckets for the no-show breakdown (minutes between created_at and
# starts_at). Walk-ins / same-moment bookings can't really "no-show"; longer
# lead times historically no-show more — surfacing that is the actionable bit.
# (lower_minutes_inclusive, label)
_LEAD_TIME_BUCKETS: list[tuple[int, str]] = [
    (0, "same_day"),         # < 1 day
    (24 * 60, "1_3_days"),   # 1–3 days
    (3 * 24 * 60, "4_7_days"),
    (7 * 24 * 60, "over_7_days"),
]

# Party-size histogram bins (inclusive lower bound, label).
_PARTY_SIZE_BINS: list[tuple[int, str]] = [
    (1, "1-2"),
    (3, "3-4"),
    (5, "5-6"),
    (7, "7+"),
]

# ─── Genvundet (recovered covers) honesty gates ───────────────────────────
# The recovered-covers card prices N recovered covers at the owner's OWN
# average cover, but ONLY when that average is honestly derivable. Three gates:
#   • the sample must be big enough (RECOVERED_MIN_COVERS) and spread across
#     enough days (RECOVERED_MIN_COVER_DAYS) — one freak Saturday isn't a rate.
#   • the days that HAVE cover data must account for a real share of the
#     period's revenue (RECOVERED_MIN_COVER_COVERAGE) — else the avg rests on a
#     sliver of the business and would misprice.
# If any gate fails we show N (count) only, kr=None — never a fabricated krone.
RECOVERED_MIN_COVER_COVERAGE: float = 0.6
RECOVERED_MIN_COVERS: int = 30
RECOVERED_MIN_COVER_DAYS: int = 3


# ─── The ONE confidence gate ───────────────────────────────────────────────
def insight_confidence(n: int, weeks: float) -> str:
    """Map a sample size + week-span to "hidden" | "provisional" | "confident".

    The single source of truth for "can the owner trust this number?" used by
    every insight (and by the forecast eligibility check). Keeping it one
    function means the service, the tests, and the frontend can never disagree
    about where the line is.

      • n      — raw observations behind the insight (reservations, covers,
                 cells, whatever the insight counts).
      • weeks  — how many distinct business-weeks the data spans. A big n
                 crammed into <2 weeks is still only "provisional" because it
                 hasn't proven a repeating weekly pattern.

    Returns:
      "hidden"      — too little to show a number at all.
      "provisional" — show it, but the UI must caveat ("early signal").
      "confident"   — an operator can lean on it.

    Never raises; coerces junk input to the safe "hidden" floor.
    """
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "hidden"
    try:
        weeks = float(weeks)
    except (TypeError, ValueError):
        weeks = 0.0

    if n < CONFIDENCE_HIDDEN_MIN_N:
        return "hidden"
    if n < CONFIDENCE_CONFIDENT_MIN_N or weeks < CONFIDENCE_CONFIDENT_MIN_WEEKS:
        return "provisional"
    return "confident"


# ─── small helpers ──────────────────────────────────────────────────────────
def resolve_range_days(range_token: str | int | None) -> int:
    """Turn the `range` query param into a clamped day count.

    Accepts a preset token ("4w"), a bare day integer/string ("30"), or None
    (→ default). Always returns an int in [MIN_RANGE_DAYS, MAX_RANGE_DAYS] so a
    crafted value can't widen the scan unboundedly (L3 bounds, defence in depth
    even though the router also validates)."""
    if range_token is None:
        return DEFAULT_RANGE_DAYS
    if isinstance(range_token, str):
        tok = range_token.strip().lower()
        if tok in RANGE_PRESETS:
            return RANGE_PRESETS[tok]
        # Allow "30" or "30d" → 30 days.
        digits = tok[:-1] if tok.endswith("d") else tok
        try:
            days = int(digits)
        except (TypeError, ValueError):
            return DEFAULT_RANGE_DAYS
    else:
        try:
            days = int(range_token)
        except (TypeError, ValueError):
            return DEFAULT_RANGE_DAYS
    return max(MIN_RANGE_DAYS, min(MAX_RANGE_DAYS, days))


def _day_part(hour: int, cutoff: int = 6) -> str:
    """Bin a local wall-clock hour into a day-part label.

    Post-midnight hours that are still BEFORE the business-day cutoff (e.g.
    a 02:00 booking when the cutoff is 06:00) are late-night service of the
    PRIOR business day — "Late", not "Morning". This keeps the day-part
    consistent with the business-day bucket: a 02:00 Saturday booking lands on
    Friday's business day AND in Friday's "Late" cell, matching the operator's
    mental model. Genuine early-morning bookings (>= cutoff, < 11:00) stay
    "Morning"."""
    if hour < cutoff:
        return "Late"
    if 11 <= hour < 14:
        return "Lunch"
    if 14 <= hour < 17:
        return "Afternoon"
    if 17 <= hour < 22:
        return "Dinner"
    if hour >= 22:
        return "Late"
    return "Morning"


def _lead_time_bucket(minutes: float) -> str:
    """Bin a lead time (minutes between created_at and starts_at) into a label.
    Negative / None lead times (data quirks) fold into the same-day bucket."""
    if minutes is None or minutes < 0:
        return "same_day"
    label = _LEAD_TIME_BUCKETS[0][1]
    for lower, lbl in _LEAD_TIME_BUCKETS:
        if minutes >= lower:
            label = lbl
        else:
            break
    return label


def _party_size_bin(size: int) -> str:
    label = _PARTY_SIZE_BINS[0][1]
    for lower, lbl in _PARTY_SIZE_BINS:
        if size >= lower:
            label = lbl
        else:
            break
    return label


def _local_dt(user, dt: datetime):
    """Return a stored Reservation datetime as the owner's local wall clock.

    Reservation.starts_at is stored NAIVE in business-LOCAL wall-clock
    (Europe/Copenhagen) — every write site (public strptime, owner/waitlist
    payload) stores naive-local, and the DB column is TIMESTAMP WITHOUT TIME
    ZONE. So a naive value is ALREADY the owner's wall clock; we must NOT
    attach UTC and astimezone() it (that would shift real data by the UTC
    offset and mis-bucket "Friday dinner" by 1-2h). We simply return the naive
    datetime as-is for hour/weekday bucketing. An aware value (shouldn't occur
    from this column, but defensive) is converted into the owner's zone so its
    wall-clock reads correctly. Falls back to the raw datetime on any oddity so
    a single bad row can't crash the loop (fail-soft)."""
    from app.services.tz_utils import _user_zone  # local import — internal helper
    try:
        if dt.tzinfo is None:
            # Already naive business-local — bucket on it directly.
            return dt
        # Aware (defensive) → project into the owner's wall clock.
        return dt.astimezone(_user_zone(user))
    except Exception:  # noqa: BLE001
        return dt


def _business_day_span_weeks(start_day: date, end_day: date) -> float:
    """Number of (fractional) weeks the inclusive business-day range spans."""
    days = (end_day - start_day).days + 1
    return max(0.0, days / 7.0)


def _empty_insights(range_days: int, zone: str, *, reason: str = "") -> dict:
    """The all-hidden skeleton returned when the service can't compute (no
    resources, fail-soft catch, etc.). Same shape as a real payload so the
    frontend renders empty states without special-casing."""
    return {
        "range_days": range_days,
        "zone": zone,
        "generated_at": utc_now().isoformat() + "Z",
        "covers_basis": "booked",
        "utilization": {
            "confidence": "hidden",
            "seat_hour_pct": None,
            "covers_vs_capacity_pct": None,
            "occupied_seat_minutes": 0,
            "available_seat_minutes": 0,
            "booked_covers": 0,
            "capacity_covers": 0,
            "basis": "occupancy_seat_minutes",
        },
        "heatmap": {
            "confidence": "hidden",
            "weekdays": list(WEEKDAYS),
            "day_parts": list(DAY_PARTS),
            "cells": [],
            "covers_basis": "booked",
        },
        "no_show_rate": {
            "confidence": "hidden",
            "rate": None,
            "no_shows": 0,
            "denominator": 0,
            "by_lead_time": [],
        },
        "source_mix": {
            "confidence": "hidden",
            "sources": [],
            "covers_basis": "booked",
        },
        "party_size_fit": {
            "confidence": "hidden",
            "party_histogram": [],
            "capacity_histogram": [],
        },
        "forecast": None,
        "forecast_locked": False,
        "recovered": {
            "confidence": "hidden",
            "recovered_bookings": 0,
            "recovered_covers": 0,
            "kr": None,
            "kr_basis": None,
            "avg_cover": None,
        },
        "meta": {"reason": reason} if reason else {},
    }


# ─── Genvundet — waitlist recovered covers (the money-honest one) ────────────
def _compute_recovered(
    db: Session,
    user,
    *,
    start_day: date,
    end_day: date,
    win_start: datetime,
    win_end: datetime,
    weeks: float,
) -> dict:
    """Recovered-covers card: "the Venteliste seated N guests this period,
    ≈ X kr". Fail-soft — any error degrades to the hidden skeleton.

    THE LOAD-BEARING HONESTY GUARDS:
      C-1  Count a converted waitlist row ONLY when its linked Reservation
           actually seated. Nothing reverse-syncs status="converted" when the
           booking is later cancelled/no-showed, so a bare status check would
           claim credit for covers we never recovered. We JOIN
           converted_reservation_id -> Reservation and require the reservation
           to be non-deleted and status NOT IN ('cancelled','no_show').
      C-2/3 kr is shown ONLY with real cover data: total_covers > 0 AND a
           sample floor (min covers + min cover-days) AND a revenue-share
           coverage gate. Otherwise N only, kr=None (saves close-only owners
           and the demo seeder, which writes zero guest_count).
      C-4  kr is GROSS (incl. moms) from the revenue resolver — labelled as
           recovered omsætning, never "sparet"/"tjent"/net.
      C-5  The count is bucketed on converted_at, never created_at/updated_at.
      C-9  Voided sales are excluded from the covers denominator.
    """
    skeleton = {
        "confidence": "hidden",
        "recovered_bookings": 0,
        "recovered_covers": 0,
        "kr": None,
        "kr_basis": None,
        "avg_cover": None,
    }
    try:
        # ── N + covers (C-1 JOIN + C-5 converted_at bucketing) ────────────
        rows = (
            db.query(
                ReservationWaitlistEntry.id,
                ReservationWaitlistEntry.party_size,
            )
            .join(
                Reservation,
                Reservation.id == ReservationWaitlistEntry.converted_reservation_id,
            )
            .filter(
                ReservationWaitlistEntry.user_id == user.id,
                ReservationWaitlistEntry.status == "converted",
                ReservationWaitlistEntry.converted_at.isnot(None),
                ReservationWaitlistEntry.converted_at >= win_start,
                ReservationWaitlistEntry.converted_at < win_end,
                # C-1: the linked reservation must be a real, seated booking.
                Reservation.is_deleted.is_(False),
                Reservation.status.notin_(("cancelled", "no_show")),
            )
            .all()
        )
        recovered_bookings = len(rows)
        recovered_covers = sum(int(r.party_size or 0) for r in rows)
        confidence = insight_confidence(recovered_bookings, weeks)

        if recovered_bookings <= 0:
            return {**skeleton, "confidence": confidence}

        result = {
            "confidence": confidence,
            "recovered_bookings": recovered_bookings,
            "recovered_covers": recovered_covers,
            "kr": None,
            "kr_basis": None,
            "avg_cover": None,
        }

        # ── avg cover from Sale covers (C-9 voids excluded) ───────────────
        cover_rows = (
            db.query(Sale.date, func.sum(Sale.guest_count))
            .filter(
                Sale.user_id == user.id,
                Sale.date >= start_day,
                Sale.date <= end_day,
                Sale.is_deleted.isnot(True),
                Sale.is_void.isnot(True),          # C-9
                Sale.is_manager_void.isnot(True),  # C-9
                Sale.status == "completed",
                Sale.guest_count.isnot(None),
                Sale.guest_count > 0,
            )
            .group_by(Sale.date)
            .all()
        )
        covered_dates = [d for (d, c) in cover_rows if (c or 0) > 0]
        total_covers = sum(int(c or 0) for (_d, c) in cover_rows)

        # C-2: no real cover data → N only, no krone.
        if total_covers <= 0:
            return result
        # C-3: sample floor — one freak day can't set a rate.
        if total_covers < RECOVERED_MIN_COVERS or len(covered_dates) < RECOVERED_MIN_COVER_DAYS:
            return result

        # ── basis-match: numerator restricted to the SAME covered_dates ───
        by_date = revenue_resolver.effective_revenue_by_date(
            db, user.id, start_day, end_day,
        )
        covered_set = set(covered_dates)
        covered_revenue = sum(
            float(v or 0) for (d, v) in by_date.items() if d in covered_set
        )
        period_revenue = sum(float(v or 0) for v in by_date.values())
        coverage = (covered_revenue / period_revenue) if period_revenue > 0 else 0.0

        if coverage >= RECOVERED_MIN_COVER_COVERAGE and covered_revenue > 0:
            avg_cover = covered_revenue / total_covers
            result["avg_cover"] = round(avg_cover, 2)
            # C-4: GROSS (incl. moms) recovered omsætning.
            result["kr"] = round(recovered_covers * avg_cover, 2)
            result["kr_basis"] = "own_avg_cover"
        return result
    except Exception as exc:  # noqa: BLE001 — fail-soft, never sink the page
        logger.warning("_compute_recovered failed for user=%s: %s",
                       getattr(user, "id", "?"), exc)
        return dict(skeleton)


# ─── main entry point ───────────────────────────────────────────────────────
def compute_insights(
    db: Session,
    user,
    *,
    range_days: int = DEFAULT_RANGE_DAYS,
    zone: str | None = None,
) -> dict:
    """Compute the full insights payload for `user` over the trailing
    `range_days` business days, optionally filtered to a single `zone`.

    Tenant-scoped by contract: EVERY query below filters by `user.id`. Never
    raises — on any internal error it logs and returns the all-hidden skeleton
    so the request still succeeds (fail-soft, multi-barrier L4).

    `zone`: None or "all" → every active resource; otherwise only resources in
    that zone feed utilization + the capacity histogram (reservations
    themselves carry no zone, so the heatmap / no-show / source-mix are
    floor-wide regardless — the zone filter scopes the seat-supply side).
    """
    zone_norm = (zone or "all").strip() or "all"
    try:
        range_days = max(MIN_RANGE_DAYS, min(MAX_RANGE_DAYS, int(range_days)))
    except (TypeError, ValueError):
        range_days = DEFAULT_RANGE_DAYS

    try:
        # Business-day window: end = current business day, start = (range_days-1)
        # business days earlier. We anchor on business_today_local so the 06:00
        # DK cutoff is honoured — a 02:00 booking belongs to the prior service.
        end_day = business_today_local(user)
        start_day = end_day - timedelta(days=range_days - 1)

        # One NAIVE-local half-open window covering the whole range, built from
        # the per-day business windows so late-night service is captured
        # correctly. Reservation.starts_at is stored naive business-local, so the
        # bounds MUST be naive-local too (business_day_window_local) — comparing
        # the naive column against aware-UTC bounds would be off by the UTC
        # offset and drop/duplicate the range's edge bookings.
        win_start, _ = business_day_window_local(user, start_day)
        _, win_end = business_day_window_local(user, end_day)

        # ── tenant-scoped pulls (L2) ──────────────────────────────────────
        reservations = (
            db.query(Reservation)
            .filter(
                Reservation.user_id == user.id,
                Reservation.is_deleted.is_(False),
                Reservation.starts_at >= win_start,
                Reservation.starts_at < win_end,
            )
            .all()
        )
        resources = (
            db.query(BookableResource)
            .filter(
                BookableResource.user_id == user.id,
                BookableResource.is_active.is_(True),
                BookableResource.is_deleted.is_(False),
            )
            .all()
        )
        zoned_resources = (
            resources
            if zone_norm == "all"
            else [r for r in resources if (r.zone or "") == zone_norm]
        )

        profile = rsvc_profile(db, user)
        settings = rsvc.load_settings(profile)

        # Assign each reservation a (business_day, weekday, day_part) once.
        # business_today_local-style bucketing: shift the local clock back by
        # the cutoff hour, then take the date — so a 02:00 Saturday booking
        # lands on Friday's business day (and Friday's heatmap row).
        cutoff = _resolve_cutoff_hour(user)
        bucketed: list[dict] = []
        for r in reservations:
            try:
                local = _local_dt(user, r.starts_at)
                shifted = local - timedelta(hours=cutoff)
                bucketed.append({
                    "r": r,
                    "biz_day": shifted.date(),
                    "weekday": shifted.weekday(),       # Mon=0 … Sun=6
                    "day_part": _day_part(local.hour, cutoff),  # cutoff-aware
                })
            except Exception:  # noqa: BLE001
                # One malformed row must not sink the batch.
                continue

        weeks = _business_day_span_weeks(start_day, end_day)

        utilization = _compute_utilization(
            db, user, bucketed, zoned_resources, profile, settings,
            start_day, end_day, weeks,
        )
        heatmap = _compute_heatmap(bucketed, weeks)
        no_show = _compute_no_show_rate(bucketed, weeks)
        source_mix = _compute_source_mix(bucketed, weeks)
        party_fit = _compute_party_size_fit(bucketed, zoned_resources, weeks)
        forecast, forecast_locked = _compute_forecast(
            user, bucketed, end_day, weeks,
        )
        recovered = _compute_recovered(
            db, user,
            start_day=start_day, end_day=end_day,
            win_start=win_start, win_end=win_end, weeks=weeks,
        )

        return {
            "range_days": range_days,
            "zone": zone_norm,
            "generated_at": utc_now().isoformat() + "Z",
            # Page-level note: every covers figure here is BOOKED covers
            # (Σ party_size). Where a POS guest_count basis is used instead,
            # the sub-insight overrides this with its own `covers_basis`.
            "covers_basis": "booked",
            "utilization": utilization,
            "heatmap": heatmap,
            "no_show_rate": no_show,
            "source_mix": source_mix,
            "party_size_fit": party_fit,
            "forecast": forecast,
            # True when a forecast WOULD be shown but the user's tier doesn't
            # include it → frontend renders an upgrade nudge in the slot.
            "forecast_locked": forecast_locked,
            # Venteliste recovered covers — N always; kr only when honestly
            # derivable from the owner's own cover data (see _compute_recovered).
            "recovered": recovered,
            "meta": {
                "start_business_day": start_day.isoformat(),
                "end_business_day": end_day.isoformat(),
                "weeks": round(weeks, 2),
                "reservation_count": len(bucketed),
            },
        }
    except Exception as exc:  # noqa: BLE001 — fail-soft: never break the request
        logger.warning("compute_insights failed for user=%s: %s",
                       getattr(user, "id", "?"), exc, exc_info=True)
        return _empty_insights(range_days, zone_norm, reason="error")


# ─── profile + cutoff helpers (kept tiny + defensive) ─────────────────────────
def rsvc_profile(db: Session, user):
    """The user's BusinessProfile (or None). Tenant-scoped. Local import of the
    model keeps this module importable from non-DB contexts."""
    try:
        from app.models.business_profile import BusinessProfile
        return (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
    except Exception:  # noqa: BLE001
        return None


def _resolve_cutoff_hour(user) -> int:
    """Business-day cutoff hour for the user, via the same private helper
    tz_utils uses (06:00 DK default), clamped. Defensive wrapper so a missing
    helper can't crash bucketing."""
    try:
        from app.services.tz_utils import _user_cutoff_hour
        return int(_user_cutoff_hour(user))
    except Exception:  # noqa: BLE001
        return 6


# ─── utilization ──────────────────────────────────────────────────────────
def _compute_utilization(
    db: Session, user, bucketed, zoned_resources, profile, settings,
    start_day: date, end_day: date, weeks: float,
) -> dict:
    """Seat-hour utilization + covers-vs-capacity.

    Seat-hour numerator: Σ over active occupancy rows (the real held tables,
    combo-aware) of (overlap_minutes_within_window × that table's
    capacity_seats). Denominator: Σ over each business day of (open-window
    minutes from restaurant_windows × Σ capacity_seats of the zoned active
    resources). Both clamp to the analytics window so a turn that straddles the
    edge contributes only its in-window minutes.

    covers-vs-capacity: booked covers (Σ party_size of booked statuses) ÷
    (capacity_covers = Σ capacity_seats of zoned resources, per service day,
    summed). A coarse "did we fill the seats we have" ratio that complements
    the precise seat-hour figure.
    """
    zoned_ids = {str(r.id) for r in zoned_resources}
    total_capacity = sum(int(r.capacity_seats or 0) for r in zoned_resources)
    cap_by_resource = {str(r.id): int(r.capacity_seats or 0) for r in zoned_resources}

    if not zoned_resources or total_capacity <= 0:
        return {
            "confidence": "hidden",
            "seat_hour_pct": None,
            "covers_vs_capacity_pct": None,
            "occupied_seat_minutes": 0,
            "available_seat_minutes": 0,
            "booked_covers": 0,
            "capacity_covers": 0,
            "basis": "occupancy_seat_minutes",
        }

    # ── available seat-minutes: per business day, open-window minutes × seats ─
    available_seat_minutes = 0.0
    open_service_days = 0
    d = start_day
    while d <= end_day:
        windows = []
        try:
            windows = rsvc.restaurant_windows(profile, d, settings)
        except Exception:  # noqa: BLE001
            windows = []
        day_open_min = sum(
            max(0.0, (w.end - w.start).total_seconds() / 60.0) for w in windows
        )
        if day_open_min > 0:
            open_service_days += 1
            available_seat_minutes += day_open_min * total_capacity
        d += timedelta(days=1)

    # ── occupied seat-minutes: active occupancy rows × capacity, in-window ──
    # ReservationOccupancy.starts_at/ends_at are copied from Reservation.starts_at
    # → naive business-local wall-clock. Use naive-local bounds so the overlap
    # subtraction is pure wall-clock (both sides naive, DST-safe, no round-trip).
    win_start, _ = business_day_window_local(user, start_day)
    _, win_end = business_day_window_local(user, end_day)
    occupied_seat_minutes = 0.0
    try:
        occ_rows = (
            db.query(ReservationOccupancy)
            .filter(
                ReservationOccupancy.user_id == user.id,
                ReservationOccupancy.active.is_(True),
                ReservationOccupancy.starts_at < win_end,
                ReservationOccupancy.ends_at > win_start,
            )
            .all()
        )
    except Exception:  # noqa: BLE001
        occ_rows = []
    for o in occ_rows:
        rid = str(o.resource_id)
        # Zone filter: only count held minutes on tables in the selected zone.
        if zoned_ids and rid not in zoned_ids:
            continue
        seats = cap_by_resource.get(rid, 0)
        if seats <= 0:
            continue
        try:
            # win_start/win_end are naive-local (business_day_window_local); the
            # occupancy rows are naive-local too, so no tz normalisation needed.
            # _strip_tz stays a defensive guard against an unexpectedly-aware row.
            seg_start = max(_strip_tz(o.starts_at), win_start)
            seg_end = min(_strip_tz(o.ends_at), win_end)
            overlap_min = max(0.0, (seg_end - seg_start).total_seconds() / 60.0)
        except Exception:  # noqa: BLE001
            continue
        occupied_seat_minutes += overlap_min * seats

    seat_hour_pct = (
        round(100.0 * occupied_seat_minutes / available_seat_minutes, 1)
        if available_seat_minutes > 0 else None
    )

    # ── covers vs capacity ──────────────────────────────────────────────────
    booked_covers = sum(
        int(b["r"].party_size or 0)
        for b in bucketed
        if b["r"].status in BOOKED_COVER_STATUSES
    )
    # capacity_covers = seats available per OPEN service day, summed. (Using
    # open_service_days, not raw range_days, so a 3-day-a-week place isn't
    # punished for its closed days.)
    capacity_covers = total_capacity * open_service_days
    covers_vs_capacity_pct = (
        round(100.0 * booked_covers / capacity_covers, 1)
        if capacity_covers > 0 else None
    )

    # Confidence keyed on the reservation sample behind the figure.
    n = len([b for b in bucketed if b["r"].status in BOOKED_COVER_STATUSES])
    confidence = insight_confidence(n, weeks)

    return {
        "confidence": confidence,
        "seat_hour_pct": seat_hour_pct,
        "covers_vs_capacity_pct": covers_vs_capacity_pct,
        "occupied_seat_minutes": int(round(occupied_seat_minutes)),
        "available_seat_minutes": int(round(available_seat_minutes)),
        "booked_covers": booked_covers,
        "capacity_covers": capacity_covers,
        "open_service_days": open_service_days,
        # The denominator basis is the occupancy seat-minutes model — labelled
        # so the owner knows the % is seat-hours, not booking counts.
        "basis": "occupancy_seat_minutes",
    }


def _strip_tz(dt: datetime) -> datetime:
    """Drop tzinfo so an unexpectedly-aware timestamp can still be subtracted
    against the naive-local window bounds. Both the occupancy rows and the
    window bounds are naive business-local wall-clock, so this is normally a
    no-op — kept only as a defensive guard against a stray aware row (which
    would otherwise raise "can't subtract offset-naive and offset-aware")."""
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


# ─── heatmap ────────────────────────────────────────────────────────────────
def _compute_heatmap(bucketed, weeks: float) -> dict:
    """Weekday (Mon-first) × day-part matrix of BOOKED covers (Σ party_size),
    business-day bucketed. Cells with < HEATMAP_CELL_MIN_SAMPLES bookings are
    flagged low_confidence (the matrix still renders them — an operator wants
    to see the sparse cells, just with a caveat)."""
    covers: dict[tuple[int, str], int] = defaultdict(int)
    samples: dict[tuple[int, str], int] = defaultdict(int)
    total_n = 0
    for b in bucketed:
        if b["r"].status not in BOOKED_COVER_STATUSES:
            continue
        key = (b["weekday"], b["day_part"])
        covers[key] += int(b["r"].party_size or 0)
        samples[key] += 1
        total_n += 1

    cells = []
    for wd_idx, wd in enumerate(WEEKDAYS):
        for dp in DAY_PARTS:
            key = (wd_idx, dp)
            s = samples.get(key, 0)
            if s == 0:
                continue  # don't emit empty cells — frontend renders the grid
            cells.append({
                "weekday": wd,
                "weekday_index": wd_idx,
                "day_part": dp,
                "covers": covers.get(key, 0),
                "samples": s,
                "low_confidence": s < HEATMAP_CELL_MIN_SAMPLES,
            })

    return {
        "confidence": insight_confidence(total_n, weeks),
        "weekdays": list(WEEKDAYS),
        "day_parts": list(DAY_PARTS),
        "cells": cells,
        "covers_basis": "booked",
    }


# ─── no-show rate ─────────────────────────────────────────────────────────
def _compute_no_show_rate(bucketed, weeks: float) -> dict:
    """no_show ÷ (confirmed+seated+completed+no_show), plus a by-lead-time
    breakdown. Lead time = starts_at − created_at (minutes)."""
    denom = 0
    no_shows = 0
    by_bucket_no_show: dict[str, int] = defaultdict(int)
    by_bucket_denom: dict[str, int] = defaultdict(int)

    for b in bucketed:
        r = b["r"]
        if r.status not in NO_SHOW_DENOMINATOR_STATUSES:
            continue
        denom += 1
        is_no_show = r.status == "no_show"
        if is_no_show:
            no_shows += 1
        # Lead-time bucket.
        lead_min = None
        try:
            if r.created_at and r.starts_at:
                lead_min = (r.starts_at - r.created_at).total_seconds() / 60.0
        except Exception:  # noqa: BLE001
            lead_min = None
        bucket = _lead_time_bucket(lead_min)
        by_bucket_denom[bucket] += 1
        if is_no_show:
            by_bucket_no_show[bucket] += 1

    rate = round(no_shows / denom, 4) if denom > 0 else None

    by_lead_time = []
    for _, label in _LEAD_TIME_BUCKETS:
        d = by_bucket_denom.get(label, 0)
        if d == 0:
            continue
        ns = by_bucket_no_show.get(label, 0)
        by_lead_time.append({
            "bucket": label,
            "no_shows": ns,
            "denominator": d,
            "rate": round(ns / d, 4) if d > 0 else None,
            # Per-bucket confidence so the UI can grey out a 2-sample bucket.
            "confidence": insight_confidence(d, weeks),
        })

    return {
        "confidence": insight_confidence(denom, weeks),
        "rate": rate,
        "no_shows": no_shows,
        "denominator": denom,
        "by_lead_time": by_lead_time,
    }


# ─── source mix ─────────────────────────────────────────────────────────────
def _compute_source_mix(bucketed, weeks: float) -> dict:
    """Counts + booked covers by source (public / manual / walk_in). Counts use
    ALL non-deleted reservations in range (a cancelled public booking still
    tells you the channel mix); covers use only booked statuses."""
    counts: dict[str, int] = defaultdict(int)
    covers: dict[str, int] = defaultdict(int)
    total = 0
    for b in bucketed:
        r = b["r"]
        src = (r.source or "public")
        counts[src] += 1
        total += 1
        if r.status in BOOKED_COVER_STATUSES:
            covers[src] += int(r.party_size or 0)

    sources = []
    for src in sorted(counts.keys()):
        c = counts[src]
        sources.append({
            "source": src,
            "count": c,
            "covers": covers.get(src, 0),
            "count_share": round(c / total, 4) if total > 0 else None,
        })

    return {
        "confidence": insight_confidence(total, weeks),
        "sources": sources,
        "total": total,
        "covers_basis": "booked",
    }


# ─── party-size fit ───────────────────────────────────────────────────────
def _compute_party_size_fit(bucketed, zoned_resources, weeks: float) -> dict:
    """Histogram of booked party_size vs the capacity_seats distribution of the
    active (zoned) resources — "are our tables sized for the parties we get?".

    party_histogram: count of booked reservations per party-size bin.
    capacity_histogram: count of active resources per capacity bin (same bins),
    so the frontend can overlay demand vs supply.
    """
    party_hist: dict[str, int] = defaultdict(int)
    n = 0
    for b in bucketed:
        r = b["r"]
        if r.status not in BOOKED_COVER_STATUSES:
            continue
        party_hist[_party_size_bin(int(r.party_size or 0))] += 1
        n += 1

    cap_hist: dict[str, int] = defaultdict(int)
    for res in zoned_resources:
        cap_hist[_party_size_bin(int(res.capacity_seats or 0))] += 1

    party_histogram = [
        {"bin": label, "count": party_hist.get(label, 0)}
        for _, label in _PARTY_SIZE_BINS
    ]
    capacity_histogram = [
        {"bin": label, "count": cap_hist.get(label, 0)}
        for _, label in _PARTY_SIZE_BINS
    ]

    return {
        "confidence": insight_confidence(n, weeks),
        "party_histogram": party_histogram,
        "capacity_histogram": capacity_histogram,
        "resource_count": len(zoned_resources),
    }


# ─── forecast (Pro-gated + confident-only) ─────────────────────────────────
def _compute_forecast(user, bucketed, end_day: date, weeks: float):
    """Trailing-same-weekday-average forecast of BOOKED covers for the next 7
    days. Heuristic only — for each upcoming weekday we average the booked
    covers of all in-window business days that share that weekday.

    Returns `(forecast_dict_or_None, forecast_locked_bool)`:
      • Pro tier (has_feature reservation_insights) AND the overall signal is
        CONFIDENT → returns the forecast dict, locked=False.
      • Pro tier but NOT confident → returns (None, False): we refuse to emit a
        confident-looking forecast on thin data (honest-claims doctrine). The
        forecast simply isn't available yet — not a tier issue.
      • Non-Pro tier → returns (None, True): the feature is gated, so the
        frontend shows an upgrade nudge in the forecast slot.

    A confident forecast NEVER emits on provisional data — that's the whole
    point of the gate.
    """
    # Tier gate first — local import to keep this module free of a hard
    # FastAPI/billing import cycle at module load.
    try:
        from app.services.billing import has_feature
        is_pro = has_feature(user, "reservation_insights")
    except Exception:  # noqa: BLE001
        is_pro = False

    if not is_pro:
        # Gated → tell the frontend to show the upgrade nudge.
        return None, True

    # Confidence gate — sum booked covers' sample size.
    booked = [b for b in bucketed if b["r"].status in BOOKED_COVER_STATUSES]
    overall_conf = insight_confidence(len(booked), weeks)
    if overall_conf != "confident":
        # Pro, but not enough data to be honest. Not locked (tier is fine) —
        # just no forecast yet.
        return None, False

    # Per-weekday covers across the window, by business day so we can count
    # DISTINCT same-weekdays (e.g. how many Fridays we actually observed).
    covers_by_day: dict[date, int] = defaultdict(int)
    for b in booked:
        covers_by_day[b["biz_day"]] += int(b["r"].party_size or 0)

    days_by_weekday: dict[int, list[int]] = defaultdict(list)
    for day, cov in covers_by_day.items():
        days_by_weekday[day.weekday()].append(cov)

    series = []
    for i in range(1, 8):
        target = end_day + timedelta(days=i)
        wd = target.weekday()
        observations = days_by_weekday.get(wd, [])
        if len(observations) < FORECAST_MIN_SAME_WEEKDAYS:
            # Not enough same-weekdays to forecast this day honestly — omit it.
            continue
        avg = sum(observations) / len(observations)
        series.append({
            "date": target.isoformat(),
            "weekday": WEEKDAYS[wd],
            "predicted_covers": int(round(avg)),
            "same_weekday_samples": len(observations),
        })

    if not series:
        # Confident overall, but no individual weekday cleared the same-weekday
        # minimum (e.g. a dense but short window). No honest day to emit.
        return None, False

    avg_samples = sum(s["same_weekday_samples"] for s in series) / len(series)
    return {
        "confidence": "confident",
        "method": "trailing_same_weekday_average",
        "horizon_days": 7,
        "covers_basis": "booked",
        # Carry the basis explicitly — never let the UI imply ML / certainty.
        "basis": f"based on last {int(round(avg_samples))} same-weekdays",
        "days": series,
    }, False
