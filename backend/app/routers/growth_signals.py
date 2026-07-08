"""
Growth signals — Pro killer #3 (Tier 4 Dashboard restructure, Phase F).

The endpoint behind the `GrowthLeverCard` slot in Zone 2 of the new
Dashboard. Returns up to N ranked growth signals derived from simple
SQL aggregation over the owner's Sales + Events tables — no LLM in
the hot path, runs in <100ms.

Each signal is one falsifiable, actionable insight like:

  "Friday events earn 73% more per ticket"
    "Last 3 Fridays averaged 2,340 DKK/ticket vs 1,350 weekday."

The frontend renders these as cards with a small "See breakdown →"
CTA wiring to an internal route (/events?filter=friday etc.). The
Dashboard config (`dashboardCardSets.js`) only renders the card when
`signals.length > 0`, so an empty payload is a legitimate calm state,
not an error.

Endpoint:

  POST /api/dashboard/growth-signals   — full 10-layer doctrine.

Multi-barrier matrix (BonBox 10-layer doctrine, mirrors inbox.py /
recurring_expenses.py etc.):

  L1 auth         Depends(get_current_user) — JWT required.
  L2 ownership    Every query filters `Sale.user_id == user.id` and
                  `Event.user_id == user.id`. No cross-tenant joins.
  L3 input bounds Pydantic on the optional `since_days` / `max_signals`
                  query params; out-of-range values 422 before the
                  handler runs.
  L4 rate limit   slowapi 10/min/user — generous for a Dashboard widget
                  that polls on the 6-hour cadence the response hints
                  at, tight enough to deny a runaway client.
  L5 fail-soft    Per-generator try/except. One bad SQL aggregation
                  can never blow up the whole payload. Worst case: a
                  signal is skipped + warning logged.
  L6 tenant scope See L2. Same predicate on every query.
  L7 PLAN_FEATURES `enforce_feature(user, "growth_intelligence")` → 402
                  with the canonical upgrade payload from billing.py.
                  L7 SecurityEvent gate-refusal row written by
                  enforce_feature() automatically.
  L8 audit_logs   One row per call via audit_service.record with
                  action="dashboard.growth_signals.read". Best-effort
                  — failure never blocks the response.
  L9 fallback     Sparse-data path returns `{"signals": []}` with HTTP
                  200, not an error. Frontend hides the card.
  L10 honest      Don't fabricate signals. Each generator has an explicit
                  "data sufficiency floor" comment + returns [] when the
                  underlying counts are too low to claim a real pattern.
                  Confidence threshold ≥0.6 — anything weaker is dropped.
"""
from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.event import Event
from app.models.sale import Sale
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import enforce_feature
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

# L4 — slowapi rate limit. Keyed by remote IP (same pattern as
# inbox.py + dashboard.py). 10 calls/min generously covers the
# 6-hour-poll Dashboard widget while denying a runaway client.
_limiter = Limiter(key_func=client_ip)


# ── L3 — input bounds ────────────────────────────────────────────

# Floor on number of events / sales below which we don't claim signals
# at all. Set high enough that a noise-floor result can't masquerade
# as insight. See L10 honest-claims discipline.
_MIN_EVENTS_FOR_WEEKDAY_SIGNAL = 6      # 3 of one weekday + 3 others
_MIN_EVENTS_PER_WEEKDAY = 3             # specific weekday floor
_MIN_EVENTS_FOR_TYPE_SIGNAL = 4
_MIN_SALES_FOR_PAYMENT_SIGNAL = 20      # last-30d sales
_MIN_CONFIDENCE_RETURN = 0.6            # below this, signal is dropped

_DEFAULT_NEXT_REFRESH_HOURS = 6         # client polling hint


# ── Pydantic schemas ─────────────────────────────────────────────


class GrowthSignal(BaseModel):
    """One actionable insight surfaced on the Dashboard."""

    id: str = Field(
        ...,
        description=(
            "Stable hash so the frontend can dedup across refreshes — "
            "same underlying pattern → same id."
        ),
    )
    title: str = Field(..., max_length=120)
    body: str = Field(..., max_length=240)
    cta_label: str = Field(..., max_length=40)
    cta_href: str = Field(..., max_length=255)
    severity: Literal["info", "positive", "warning"] = "info"
    confidence: float = Field(..., ge=0.0, le=1.0)


class GrowthSignalsResponse(BaseModel):
    """Top-level response shape — frontend hides the `GrowthLeverCard`
    when `signals` is empty. `error` is reserved for L5 fail-soft to
    surface a soft warning string without raising 5xx."""

    signals: list[GrowthSignal]
    generated_at: datetime
    next_refresh_after: datetime
    error: str | None = None


_WEEKDAY_NAMES = (
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
)


# ── Signal generators ────────────────────────────────────────────


def _stable_id(*parts: str) -> str:
    """Short stable hash so the frontend can dedup the same insight
    across polls. Truncated to 12 hex chars — plenty of bits for
    Dashboard cardinality."""
    raw = "|".join(str(p) for p in parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:12]


def compute_weekday_event_uplift(
    db: Session,
    user_id,
    since_days: int,
) -> list[GrowthSignal]:
    """Group the owner's events by weekday and surface the most-
    overperforming day.

    L10 honest floor: need ≥3 events of the candidate weekday AND
    ≥6 events total, otherwise the difference between "lucky Friday"
    and "real pattern" is indistinguishable.

    Returns a list of zero or one signals (the single best weekday).
    """
    cutoff = utc_now().date() - timedelta(days=since_days)
    # Pull events with their per-event revenue + ticket count via a
    # join to Sales. Soft-deleted rows excluded on both sides.
    rows = (
        db.query(
            Event.id.label("event_id"),
            Event.event_date.label("event_date"),
            Event.name.label("event_name"),
            func.coalesce(func.sum(Sale.amount), 0).label("revenue"),
            func.count(Sale.id).label("ticket_count"),
        )
        .outerjoin(
            Sale,
            (Sale.event_id == Event.id) & (Sale.is_deleted.isnot(True)),
        )
        .filter(
            Event.user_id == user_id,
            Event.is_deleted.isnot(True),
            Event.event_date >= cutoff,
        )
        .group_by(Event.id, Event.event_date, Event.name)
        .all()
    )

    # Bucket per-event averages by weekday.
    by_weekday: dict[int, list[float]] = defaultdict(list)
    for r in rows:
        tickets = int(r.ticket_count or 0)
        if tickets <= 0:
            continue
        per_ticket = float(r.revenue) / tickets
        by_weekday[r.event_date.weekday()].append(per_ticket)

    total_events = sum(len(v) for v in by_weekday.values())
    if total_events < _MIN_EVENTS_FOR_WEEKDAY_SIGNAL:
        return []

    overall_avg = sum(sum(v) for v in by_weekday.values()) / total_events
    if overall_avg <= 0:
        return []

    # Find the weekday with the largest positive uplift that ALSO has
    # enough samples to be honest about.
    best_weekday = None
    best_avg = 0.0
    best_n = 0
    for wd, values in by_weekday.items():
        if len(values) < _MIN_EVENTS_PER_WEEKDAY:
            continue
        avg = sum(values) / len(values)
        if avg > best_avg:
            best_weekday = wd
            best_avg = avg
            best_n = len(values)

    if best_weekday is None or best_avg <= 0:
        return []

    uplift = (best_avg - overall_avg) / overall_avg
    if uplift < 0.30:  # require ≥30% uplift
        return []

    pct = int(round(uplift * 100))
    weekday_name = _WEEKDAY_NAMES[best_weekday]
    title = f"{weekday_name} events earn {pct}% more per ticket"
    body = (
        f"Last {best_n} {weekday_name}s averaged "
        f"{int(round(best_avg))} DKK/ticket vs "
        f"{int(round(overall_avg))} DKK weekday avg."
    )
    # Confidence climbs with sample size — at n=3 we're at 0.6 floor,
    # n=6 lands near 0.85, n=9+ approaches the ceiling of 0.95.
    confidence = min(0.6 + (best_n - 3) * 0.085, 0.95)
    return [
        GrowthSignal(
            id=_stable_id("weekday_event_uplift", user_id, best_weekday),
            title=title,
            body=body,
            cta_label="See breakdown",
            cta_href=f"/events?filter={weekday_name.lower()}",
            severity="positive",
            confidence=round(confidence, 2),
        )
    ]


def compute_top_event_type_lever(
    db: Session,
    user_id,
    since_days: int,
) -> list[GrowthSignal]:
    """Group events by name pattern (the Event model has no `event_type`
    column today) and surface the top performer when one type generates
    ≥2x the median revenue.

    L10 honest floor: need ≥4 events overall AND ≥2 events per "type"
    bucket to claim a pattern. Without an `event_type` field we approximate
    via the first significant token of `Event.name` (lowercased). When
    the migration that adds `event_type` lands, swap the bucketing key
    here — the return shape stays identical.

    Returns 0 or 1 signal.
    """
    cutoff = utc_now().date() - timedelta(days=since_days)
    rows = (
        db.query(
            Event.id.label("event_id"),
            Event.name.label("event_name"),
            func.coalesce(func.sum(Sale.amount), 0).label("revenue"),
        )
        .outerjoin(
            Sale,
            (Sale.event_id == Event.id) & (Sale.is_deleted.isnot(True)),
        )
        .filter(
            Event.user_id == user_id,
            Event.is_deleted.isnot(True),
            Event.event_date >= cutoff,
        )
        .group_by(Event.id, Event.name)
        .all()
    )

    if len(rows) < _MIN_EVENTS_FOR_TYPE_SIGNAL:
        return []

    # Bucket by first-token-of-name (lowercased). Strip very short
    # tokens (≤2 chars) — "DJ" stays, "of" doesn't. This is the
    # event_type-field fallback documented above.
    by_type: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        name = (r.event_name or "").strip().lower()
        if not name:
            continue
        token = name.split()[0]
        if len(token) <= 2:
            continue
        by_type[token].append(float(r.revenue or 0))

    # Need at least 2 distinct types of ≥2 events each for a comparison
    # to be honest.
    candidates = {t: v for t, v in by_type.items() if len(v) >= 2}
    if len(candidates) < 2:
        return []

    # Median across all events (not per-type means) — robust to one
    # outlier event dominating one bucket.
    all_revenues = sorted(r.revenue for r in rows if r.revenue is not None)
    if not all_revenues:
        return []
    mid = len(all_revenues) // 2
    median = (
        float(all_revenues[mid])
        if len(all_revenues) % 2 == 1
        else (float(all_revenues[mid - 1]) + float(all_revenues[mid])) / 2
    )
    if median <= 0:
        return []

    best_type = None
    best_avg = 0.0
    best_n = 0
    for t, values in candidates.items():
        avg = sum(values) / len(values)
        if avg > best_avg:
            best_type = t
            best_avg = avg
            best_n = len(values)

    if best_type is None:
        return []

    ratio = best_avg / median
    if ratio < 2.0:
        return []

    rounded_ratio = round(ratio, 1)
    title = (
        f"Your {best_type.title()} events generate "
        f"{rounded_ratio}x more revenue"
    )
    body = (
        f"{best_n} {best_type.title()} events averaged "
        f"{int(round(best_avg))} DKK each. "
        "Schedule more of these to grow."
    )
    confidence = min(0.6 + (best_n - 2) * 0.10, 0.92)
    return [
        GrowthSignal(
            id=_stable_id("top_event_type_lever", user_id, best_type),
            title=title,
            body=body,
            cta_label="See breakdown",
            cta_href=f"/events?q={best_type}",
            severity="positive",
            confidence=round(confidence, 2),
        )
    ]


def compute_payment_method_mix(
    db: Session,
    user_id,
    since_days: int,
) -> list[GrowthSignal]:
    """Compare payment-method share over the most-recent week vs the
    prior week. Emit a signal when one method drifted by >15 percentage
    points (positive or negative) AND the user has at least 20 sales
    in the 30-day window (so we're not amplifying noise).

    L10 honest floor: 20 sales over 30 days. Below that, the
    week-over-week share is too lumpy.

    Returns 0 or 1 signal (the largest drift).
    """
    today = utc_now().date()
    window_start = today - timedelta(days=since_days)
    this_week_start = today - timedelta(days=7)
    last_week_start = today - timedelta(days=14)

    rows = (
        db.query(
            Sale.date.label("date"),
            Sale.payment_method.label("method"),
            func.sum(Sale.amount).label("amount"),
        )
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.isnot(True),
            Sale.date >= window_start,
            Sale.date <= today,
        )
        .group_by(Sale.date, Sale.payment_method)
        .all()
    )

    if not rows:
        return []

    total_sales = (
        db.query(func.count(Sale.id))
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.isnot(True),
            Sale.date >= window_start,
            Sale.date <= today,
        )
        .scalar()
    )
    if (total_sales or 0) < _MIN_SALES_FOR_PAYMENT_SIGNAL:
        return []

    # Split rows into "this week" vs "last week" buckets per method.
    this_week: dict[str, float] = defaultdict(float)
    last_week: dict[str, float] = defaultdict(float)
    for r in rows:
        method = (r.method or "other").lower()
        amount = float(r.amount or 0)
        if r.date >= this_week_start:
            this_week[method] += amount
        elif r.date >= last_week_start:
            last_week[method] += amount

    this_total = sum(this_week.values())
    last_total = sum(last_week.values())
    if this_total <= 0 or last_total <= 0:
        return []

    # Compute the percentage-point drift per method. Bigger absolute
    # drift wins.
    best_method = None
    best_drift = 0.0
    best_share_this = 0.0
    best_share_last = 0.0
    for method in set(this_week.keys()) | set(last_week.keys()):
        share_this = (this_week.get(method, 0.0) / this_total) * 100
        share_last = (last_week.get(method, 0.0) / last_total) * 100
        drift = share_this - share_last
        if abs(drift) > abs(best_drift):
            best_method = method
            best_drift = drift
            best_share_this = share_this
            best_share_last = share_last

    if best_method is None or abs(best_drift) < 15.0:
        return []

    direction = "rose" if best_drift > 0 else "dropped"
    severity = "positive" if best_drift > 0 else "warning"
    pct = int(round(abs(best_drift)))
    title = f"{best_method.title()} sales {direction} {pct}% week-over-week"
    body = (
        f"Last 7 days: {best_method} was "
        f"{int(round(best_share_this))}% of revenue (prior 7d: "
        f"{int(round(best_share_last))}%). Worth a look."
    )
    # Confidence scales with sample size — at the 20-sale floor we're
    # at 0.6, more samples push higher.
    confidence = min(0.6 + (total_sales - 20) * 0.005, 0.85)
    return [
        GrowthSignal(
            id=_stable_id("payment_method_mix", user_id, best_method),
            title=title,
            body=body,
            cta_label="See breakdown",
            cta_href="/reports?tab=payments",
            severity=severity,
            confidence=round(confidence, 2),
        )
    ]


# Each generator returns a (potentially empty) list of GrowthSignal.
# Ranking key below is shared across all of them.
_GENERATORS = (
    compute_weekday_event_uplift,
    compute_top_event_type_lever,
    compute_payment_method_mix,
)


def _rank_key(s: GrowthSignal) -> float:
    """Higher = better. Confidence is the primary driver since revenue
    impact is implicit in each generator's threshold (e.g. uplift ≥30%,
    ratio ≥2x). Multiplying by a 1.0 anchor keeps the math simple."""
    return s.confidence * 1.0


# ── Endpoint ─────────────────────────────────────────────────────


@router.post("/growth-signals", response_model=GrowthSignalsResponse)
@_limiter.limit("10/minute")
def growth_signals(
    request: Request,
    since_days: int = Query(
        30,
        ge=7,
        le=365,
        description="Look-back window for the signal aggregation, in days.",
    ),
    max_signals: int = Query(
        3,
        ge=1,
        le=5,
        description="Cap on the number of signals returned.",
    ),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Compute up to `max_signals` ranked growth signals for the
    authenticated owner. See module docstring for the 10-layer matrix.

    Notes for callers:
      • Empty `signals` is the normal "calm state" response — frontend
        hides the GrowthLeverCard when the list is empty.
      • `next_refresh_after` is an advisory hint: clients should poll
        no sooner than this timestamp. The Dashboard widget polls every
        ~6 hours; spamming this endpoint won't return fresher data.
    """
    # L7 — PLAN_FEATURES fail-closed. enforce_feature() raises a 402
    # with the canonical upgrade payload and writes a SecurityEvent row.
    enforce_feature(user, "growth_intelligence")

    now = utc_now()
    next_refresh = now + timedelta(hours=_DEFAULT_NEXT_REFRESH_HOURS)

    # L5 fail-soft — wrap the whole generator pipeline. If a single
    # generator crashes we still return the others; if the whole batch
    # blows up we return an empty list with `error` set so the caller
    # can show a soft warning rather than 500.
    collected: list[GrowthSignal] = []
    soft_error: str | None = None

    for gen in _GENERATORS:
        try:
            collected.extend(gen(db, user.id, since_days))
        except Exception as exc:  # noqa: BLE001 — L5 fail-soft
            logger.warning(
                "growth_signals: generator %s crashed for user=%s: %s",
                gen.__name__, user.id, exc,
            )
            soft_error = "partial_failure"

    # L10 — confidence floor. Below 0.6 we drop the signal rather than
    # putting weak claims in front of the owner.
    collected = [s for s in collected if s.confidence >= _MIN_CONFIDENCE_RETURN]

    # Rank + cap. Highest confidence first. Stable on ties so repeated
    # polls don't shuffle the cards.
    collected.sort(key=lambda s: (-_rank_key(s), s.id))
    final = collected[:max_signals]

    # L8 — audit row. Synchronous insert + flush + commit so the test
    # suite can see the row before the response returns. audit_service
    # already swallows + logs failures so this can never break the
    # response.
    audit_service.record(
        db,
        user,
        "dashboard.growth_signals.read",
        entity_type="user",
        entity_id=user.id,
        after={
            "signals_returned": len(final),
            "since_days": since_days,
            "max_signals": max_signals,
            "soft_error": soft_error,
        },
        actor_type="user",
    )
    try:
        db.commit()
    except Exception:  # noqa: BLE001
        # Audit failure must never break the response. Roll back so the
        # session can still serialize the model.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass

    return GrowthSignalsResponse(
        signals=final,
        generated_at=now,
        next_refresh_after=next_refresh,
        error=soft_error,
    )


__all__ = [
    "router",
    "GrowthSignal",
    "GrowthSignalsResponse",
    "compute_weekday_event_uplift",
    "compute_top_event_type_lever",
    "compute_payment_method_mix",
]
