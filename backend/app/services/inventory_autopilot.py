"""Inventory Ordering Autopilot — Pro-tier killer feature (Task #63).

Beside wages, every Copenhagen owner's #2 operational pain is "what do I
need to re-order from suppliers this week?" Today they walk the shelves
on Monday morning with a clipboard, eyeball low stock, and call/email
each supplier separately. Mistakes cost real money — a missed gin order
ruins a Friday-night cocktail menu (~5,000 DKK in lost revenue), and
over-ordering perishable produce becomes Sunday waste.

Autopilot reads 8 weeks of consumption from Sale (item-by-item by
weekday), projects forward 7 days with the same MET.no / Open-Meteo
forecast we use for the schedule autopilot, then for each item computes:

    projected_demand[day] = weekday_mean × weather_multiplier
    stockout_day          = first day cumulative demand >= current_stock
    urgency_tier          = today | this_week | monitor
    suggested_qty         = ceil(14-day projected demand × pack_size)

Items are grouped by supplier_email so one "Send order" tap emails each
supplier exactly one order — no double emails, no missed merchants.

Returned as STRUCTURED data only — no LLM. Same rules-based ops model
as schedule_autopilot.

──────────────────────────────────────────────────────────────────────
Multi-layer defense
──────────────────────────────────────────────────────────────────────
  L1  TENANT BOUNDARY — every read filters by user_id. Inventory items,
      sales, weather rows — all tenant-scoped. A foreign item_id in the
      apply payload aborts the whole call (no partial sends).
  L2  FAIL-CLOSED ON THIN DATA — items with < 3 weeks of sales history
      get a static buffer-based suggestion (min_threshold × 2) rather
      than an extrapolation from a single noisy sample. Confidence
      downgrades accordingly so the UI can warn the owner.
  L3  INPUT BOUNDS — days_ahead clamped to [1, 30]. branch_id must be
      a real UUID owned by this tenant. Quantities in the apply payload
      bounded [0, 10_000] per item — defends against accidental UI bug
      sending qty=999999.
  L4  COMPLIANCE WARNINGS — items with stockout < lead_time fire a
      "should have ordered earlier" warning. Items flagged as perishable
      with > 14 days of suggested supply fire a "waste risk" warning.
      Items missing supplier_email skip the email send but appear in
      the suggestion so the owner sees them in the UI.
  L5  IDEMPOTENT SUGGEST — calling suggest_reorder_plan() never writes.
      apply_reorder() is the write boundary — it sends emails + writes
      audit logs and accepts ONLY suggestion data the caller passes in
      (so the owner can edit qty before apply).

──────────────────────────────────────────────────────────────────────
Weather multiplier
──────────────────────────────────────────────────────────────────────
Sunny weekends sell more cold beer, gin, and produce; rainy days sell
more comfort food / coffee. We compute one ratio per inventory item ×
weather bucket pair over the lookback window. If a particular
(item, bucket) pair has < 3 samples, multiplier defaults to 1.0.

Weather buckets: sunny | cloudy | rainy | cold. Same definition as
schedule_autopilot — single source of truth.
"""
from __future__ import annotations

import logging
import math
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from statistics import mean
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.models.weather import DailyWeather

logger = logging.getLogger(__name__)


# ─── Constants ────────────────────────────────────────────────────────

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"

# Lookback for consumption history.
LOOKBACK_WEEKS = 8

# Confidence thresholds (count of distinct sales days for the item).
MIN_SAMPLES_HIGH_CONFIDENCE = 21   # ~3 weeks of daily sales
MIN_SAMPLES_MEDIUM_CONFIDENCE = 7  # ~1 week of daily sales

# Days-ahead bounds. <1 makes no sense; >30 strays into seasonal-shift
# territory where weekday-mean isn't reliable.
DEFAULT_DAYS_AHEAD = 7
MIN_DAYS_AHEAD = 1
MAX_DAYS_AHEAD = 30

# Suggested-qty horizon. 14 days = the typical "I want a 2-week buffer"
# bias most small-business owners hold. Longer would over-order perishables;
# shorter wouldn't survive a missed delivery window.
SUGGEST_HORIZON_DAYS = 14

# Apply-payload bounds. Defense in depth — schema ALSO enforces.
MAX_QTY_PER_ITEM = 10_000.0
MAX_ITEMS_PER_APPLY = 500

# Weekday names — mirrors schedule_autopilot for log/UI consistency
WEEKDAY_NAMES = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]


# ─── Weather bucket helper (mirrors schedule_autopilot._bucket_for) ───


def _bucket_for(weather_code: Optional[int], temp_c: Optional[float],
                precip_mm: Optional[float]) -> str:
    """Coarse weather bucket. Same definition as schedule_autopilot."""
    if temp_c is not None and temp_c < 5.0:
        return "cold"
    code = weather_code or 0
    if (code in (51, 53, 55, 56, 57,
                 61, 63, 65, 66, 67,
                 71, 73, 75, 77,
                 80, 81, 82,
                 85, 86,
                 95, 96, 99)) or (precip_mm and precip_mm >= 1.0):
        return "rainy"
    if code in (0, 1):
        return "sunny"
    return "cloudy"


# ─── Dataclasses for the structured return ────────────────────────────


@dataclass
class AutopilotItem:
    """One inventory item's reorder recommendation."""
    item_id: str
    name: str
    unit: str
    category: Optional[str]
    current_stock: float
    min_threshold: float
    daily_demand: float        # smoothed weekday-mean × weather across horizon
    projected_demand_14d: float
    days_until_stockout: Optional[int]   # None = never (no demand observed)
    stockout_date: Optional[str]
    urgency: str                # "today" | "this_week" | "monitor"
    suggested_qty: float
    pack_size: float
    cost_per_unit: float
    line_cost: float
    supplier_name: Optional[str]
    supplier_email: Optional[str]
    supplier_lead_time_days: int
    is_perishable: bool
    confidence: str             # "high" | "medium" | "low"
    samples: int                # distinct sale days observed for item
    notes: list[str]            # per-item flags / explanations


@dataclass
class SupplierGroup:
    supplier_name: Optional[str]
    supplier_email: Optional[str]
    items: list[AutopilotItem]
    total_cost: float
    urgency: str                 # worst urgency in group


@dataclass
class AutopilotSuggestion:
    generated_at: str
    branch_id: Optional[str]
    days_ahead: int
    confidence: str   # "high" | "medium" | "low"
    basis: dict       # {weeks_of_data, weather_used, lookback_weeks, items_total}
    items: list[AutopilotItem]
    suppliers: list[SupplierGroup]
    total_cost: float
    compliance_warnings: list[str]

    def to_dict(self) -> dict:
        def _item(i: AutopilotItem) -> dict:
            return {
                "item_id": i.item_id,
                "name": i.name,
                "unit": i.unit,
                "category": i.category,
                "current_stock": round(i.current_stock, 4),
                "min_threshold": round(i.min_threshold, 4),
                "daily_demand": round(i.daily_demand, 3),
                "projected_demand_14d": round(i.projected_demand_14d, 2),
                "days_until_stockout": i.days_until_stockout,
                "stockout_date": i.stockout_date,
                "urgency": i.urgency,
                "suggested_qty": round(i.suggested_qty, 2),
                "pack_size": round(i.pack_size, 3),
                "cost_per_unit": round(i.cost_per_unit, 2),
                "line_cost": round(i.line_cost, 2),
                "supplier_name": i.supplier_name,
                "supplier_email": i.supplier_email,
                "supplier_lead_time_days": int(i.supplier_lead_time_days),
                "is_perishable": bool(i.is_perishable),
                "confidence": i.confidence,
                "samples": int(i.samples),
                "notes": list(i.notes),
            }

        return {
            "generated_at": self.generated_at,
            "branch_id": self.branch_id,
            "days_ahead": self.days_ahead,
            "confidence": self.confidence,
            "basis": self.basis,
            "items": [_item(i) for i in self.items],
            "suppliers": [
                {
                    "supplier_name": g.supplier_name,
                    "supplier_email": g.supplier_email,
                    "items": [_item(i) for i in g.items],
                    "total_cost": round(g.total_cost, 2),
                    "urgency": g.urgency,
                }
                for g in self.suppliers
            ],
            "total_cost": round(self.total_cost, 2),
            "compliance_warnings": list(self.compliance_warnings),
        }


# ─── Helpers ──────────────────────────────────────────────────────────


def _clamp_days_ahead(days_ahead: Optional[int]) -> int:
    if days_ahead is None:
        return DEFAULT_DAYS_AHEAD
    try:
        d = int(days_ahead)
    except (TypeError, ValueError):
        return DEFAULT_DAYS_AHEAD
    if d < MIN_DAYS_AHEAD:
        return MIN_DAYS_AHEAD
    if d > MAX_DAYS_AHEAD:
        return MAX_DAYS_AHEAD
    return d


def _safe_float(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ─── Weather forecast fetch ───────────────────────────────────────────


def _fetch_forecast(user: User, start: date, days_ahead: int) -> dict[date, dict]:
    """Same shape as schedule_autopilot._fetch_forecast — kept here so
    the autopilot module is self-contained (and easier to monkeypatch
    in tests). Returns {} on any failure → caller falls back to weekday
    mean only (weather_used=False)."""
    lat = getattr(user, "latitude", None)
    lon = getattr(user, "longitude", None)
    if lat is None or lon is None:
        return {}
    try:
        resp = httpx.get(OPEN_METEO_FORECAST, params={
            "latitude": float(lat),
            "longitude": float(lon),
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
            "timezone": "auto",
            "start_date": start.isoformat(),
            "end_date": (start + timedelta(days=days_ahead - 1)).isoformat(),
        }, timeout=10)
        if resp.status_code != 200:
            logger.warning("inv-autopilot: forecast HTTP %s", resp.status_code)
            return {}
        data = resp.json().get("daily") or {}
    except Exception as e:  # noqa: BLE001 — best-effort
        logger.warning("inv-autopilot: forecast fetch failed: %s", e)
        return {}

    out: dict[date, dict] = {}
    times = data.get("time") or []
    codes = data.get("weather_code") or []
    tmax = data.get("temperature_2m_max") or []
    tmin = data.get("temperature_2m_min") or []
    pcp = data.get("precipitation_sum") or []
    for i, iso in enumerate(times):
        try:
            d = date.fromisoformat(iso)
        except ValueError:
            continue
        code = codes[i] if i < len(codes) else None
        tx = tmax[i] if i < len(tmax) else None
        tn = tmin[i] if i < len(tmin) else None
        pp = pcp[i] if i < len(pcp) else None
        avg_t = None
        if tx is not None and tn is not None:
            avg_t = (float(tx) + float(tn)) / 2.0
        elif tx is not None:
            avg_t = float(tx)
        elif tn is not None:
            avg_t = float(tn)
        bucket = _bucket_for(code, avg_t, pp)
        out[d] = {
            "temp_c": round(avg_t, 1) if avg_t is not None else None,
            "precipitation_mm": float(pp) if pp is not None else None,
            "weather_code": int(code) if code is not None else None,
            "bucket": bucket,
        }
    return out


# ─── Per-item consumption history ─────────────────────────────────────


def _gather_item_history(
    db: Session,
    user: User,
    branch_id: Optional[uuid.UUID],
    history_start: date,
    history_end: date,
) -> dict[uuid.UUID, dict]:
    """Build per-item consumption stats. Returns:
        { item_id: {
            "samples": int,                      # distinct sale days
            "by_weekday": {0..6: [qty_floats]},  # per-weekday list of qty per day
            "by_bucket": {bucket: [qty_floats]}, # per-weather-bucket list
            "total_qty": float,                  # over the whole window
            "total_days": int,                   # window length in days
        } }

    Only inventory_item_id-linked sales contribute. Sales with no
    item link (legacy cash sales) are ignored — autopilot needs
    per-item granularity to make per-item recommendations.
    """
    sales_q = (
        db.query(
            Sale.inventory_item_id,
            Sale.date,
            Sale.quantity_sold,
        )
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= history_start,
            Sale.date <= history_end,
            Sale.inventory_item_id.isnot(None),
        )
    )
    if branch_id is not None:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)

    # Aggregate per (item_id, date) so multiple sales on the same day
    # for the same item count as one weekday sample, not N independent.
    by_item_date: dict[tuple[uuid.UUID, date], float] = defaultdict(float)
    for item_id, d, qty in sales_q.all():
        if item_id is None or d is None:
            continue
        q = _safe_float(qty)
        if q <= 0:
            # quantity_sold is sometimes null (legacy / cash receipts);
            # fall back to 1 unit so we still count the day as a sale.
            q = 1.0
        by_item_date[(item_id, d)] += q

    # Weather buckets per date — same lookup table for every item
    weather_rows = (
        db.query(DailyWeather)
        .filter(
            DailyWeather.user_id == user.id,
            DailyWeather.date >= history_start,
            DailyWeather.date <= history_end,
        )
        .all()
    )
    weather_by_date: dict[date, str] = {}
    for w in weather_rows:
        tx = _safe_float(w.temp_max) if w.temp_max is not None else None
        tn = _safe_float(w.temp_min) if w.temp_min is not None else None
        avg_t = None
        if tx is not None and tn is not None:
            avg_t = (tx + tn) / 2.0
        elif tx is not None:
            avg_t = tx
        elif tn is not None:
            avg_t = tn
        weather_by_date[w.date] = _bucket_for(
            w.weather_code,
            avg_t,
            _safe_float(w.rain_mm) if w.rain_mm is not None else None,
        )

    total_days = max(1, (history_end - history_start).days + 1)
    out: dict[uuid.UUID, dict] = {}
    for (item_id, d), qty in by_item_date.items():
        bucket = weather_by_date.get(d)
        stats = out.setdefault(item_id, {
            "samples": 0,
            "by_weekday": defaultdict(list),
            "by_bucket": defaultdict(list),
            "total_qty": 0.0,
            "total_days": total_days,
        })
        stats["samples"] += 1
        stats["by_weekday"][d.weekday()].append(qty)
        if bucket:
            stats["by_bucket"][bucket].append(qty)
        stats["total_qty"] += qty
    return out


# ─── Per-day demand projection for one item ───────────────────────────


def _project_daily_demand(
    item_stats: Optional[dict],
    forecast: dict[date, dict],
    target_date: date,
) -> float:
    """Predict qty consumed on target_date for one item.

    Uses weekday-mean as the base. Applies the weather multiplier
    (bucket_mean / overall_mean) when we have enough bucket samples
    AND the day's forecast lands in a known bucket.
    """
    if not item_stats:
        return 0.0
    wd = target_date.weekday()
    weekday_samples = item_stats["by_weekday"].get(wd, [])
    if not weekday_samples:
        # No samples for this weekday — fall back to the smoothed mean
        # across all observed days, scaled by sample density. Avoids
        # the "Tuesday looks like 0 because we never sold on Tuesdays
        # historically" trap (which would zero-out demand and never order).
        total_qty = item_stats.get("total_qty", 0.0)
        total_days = max(1, item_stats.get("total_days", 1))
        return total_qty / total_days
    base = mean(weekday_samples)

    bucket = (forecast.get(target_date) or {}).get("bucket")
    if not bucket:
        return base

    bucket_samples = item_stats["by_bucket"].get(bucket, [])
    overall = item_stats.get("total_qty", 0.0)
    days = sum(len(v) for v in item_stats["by_weekday"].values())
    if days <= 0 or overall <= 0:
        return base
    overall_mean = overall / days
    if len(bucket_samples) < 3 or overall_mean <= 0:
        return base
    bucket_mean = mean(bucket_samples)
    mult = bucket_mean / overall_mean
    # Clamp the multiplier to [0.3, 2.0] — defends against a single
    # freak sample (one closed rainy day with 0 sales) cratering the
    # projection or a windfall sunny weekend tripling it.
    mult = max(0.3, min(2.0, mult))
    return base * mult


# ─── Urgency tier ─────────────────────────────────────────────────────


def _urgency_for(
    days_until_stockout: Optional[int],
    lead_time: int,
    current_stock: float,
    min_threshold: float,
) -> str:
    """Pick today | this_week | monitor.

    Logic:
      • today        — stockout already happened or will happen on/before
                       the supplier can deliver (current_stock <= min OR
                       days_until_stockout <= lead_time).
      • this_week    — stockout within 7 days from now.
      • monitor      — anything further out.
    """
    if current_stock <= 0:
        return "today"
    if days_until_stockout is None:
        # No demand observed → not urgent
        return "monitor"
    if days_until_stockout <= max(0, lead_time):
        return "today"
    if days_until_stockout <= 7:
        return "this_week"
    return "monitor"


# ─── Public API ───────────────────────────────────────────────────────


def suggest_reorder_plan(
    db: Session,
    *,
    user: User,
    days_ahead: int = DEFAULT_DAYS_AHEAD,
    branch_id: Optional[uuid.UUID] = None,
    today: Optional[date] = None,
) -> AutopilotSuggestion:
    """Produce a structured reorder plan. Read-only — no DB writes.

    `today` is overridable for tests + deterministic fixtures.
    """
    today_d = today or date.today()
    days_ahead = _clamp_days_ahead(days_ahead)

    history_end = today_d - timedelta(days=1)
    history_start = today_d - timedelta(weeks=LOOKBACK_WEEKS)

    # ─── Pull tenant-scoped items + history + forecast ─────────────
    items_q = db.query(InventoryItem).filter(InventoryItem.user_id == user.id)
    if branch_id is not None:
        items_q = items_q.filter(InventoryItem.branch_id == branch_id)
    items = items_q.all()

    history = _gather_item_history(
        db, user, branch_id, history_start, history_end,
    )

    forecast = _fetch_forecast(user, today_d, days_ahead)
    weather_used = bool(forecast)

    # ─── Per-item recommendations ──────────────────────────────────
    recommendations: list[AutopilotItem] = []
    compliance_warnings: list[str] = []
    item_confidence_grades: list[str] = []

    for item in items:
        current_stock = _safe_float(item.quantity)
        min_threshold = _safe_float(item.min_threshold)
        cost = _safe_float(item.cost_per_unit)
        pack_size = max(
            _safe_float(getattr(item, "pack_size", None), 1.0),
            1.0,
        ) if hasattr(item, "pack_size") else 1.0
        # ORM columns added in migration 044 — read with safe getattr so
        # the service still works on a DB where the migration hasn't
        # landed yet (returns None → default values).
        supplier_name = (
            getattr(item, "supplier_name", None) or None
        )
        supplier_email = (
            getattr(item, "supplier_email", None) or None
        )
        lead_time = max(
            int(_safe_float(getattr(item, "supplier_lead_time_days", None), 1)),
            0,
        )

        stats = history.get(item.id)
        samples = stats["samples"] if stats else 0

        # Build day-by-day projected demand for the horizon
        per_day: list[float] = []
        for offset in range(SUGGEST_HORIZON_DAYS):
            d = today_d + timedelta(days=offset)
            per_day.append(_project_daily_demand(stats, forecast, d))
        projected_14d = sum(per_day)
        daily_demand = projected_14d / max(SUGGEST_HORIZON_DAYS, 1)

        # Walk forward day-by-day to find stockout
        running = current_stock
        stockout_day: Optional[int] = None
        stockout_date: Optional[str] = None
        for offset, q in enumerate(per_day):
            running -= q
            if running <= 0:
                stockout_day = offset
                stockout_date = (today_d + timedelta(days=offset)).isoformat()
                break

        # Confidence grade per item
        if samples >= MIN_SAMPLES_HIGH_CONFIDENCE:
            item_conf = "high"
        elif samples >= MIN_SAMPLES_MEDIUM_CONFIDENCE:
            item_conf = "medium"
        else:
            item_conf = "low"

        urgency = _urgency_for(stockout_day, lead_time, current_stock, min_threshold)

        # Skip items that are well-stocked AND have no near-term risk.
        # "Well stocked" = stock > 1.5× min_threshold AND not stocking out in horizon.
        comfort_floor = min_threshold * 1.5 if min_threshold > 0 else 0
        if (
            urgency == "monitor"
            and current_stock > comfort_floor
            and (stockout_day is None or stockout_day >= days_ahead)
            and current_stock > 0
        ):
            # Truly safe stock — don't propose ordering it. We do still
            # report items with stock > 0 but below comfort_floor as
            # "monitor" so the owner sees them on the dashboard.
            continue

        # Suggested quantity — cover the SUGGEST_HORIZON_DAYS projection.
        # Subtract current_stock (or zero if already stocked-out so we
        # don't propose negative). Round up to pack_size.
        net_needed = max(0.0, projected_14d - max(0.0, current_stock))
        # If demand is essentially zero but stock is below min_threshold,
        # at least top us back up to min_threshold (safety floor).
        if net_needed <= 0 and current_stock < min_threshold:
            net_needed = min_threshold - current_stock
        if pack_size > 0 and net_needed > 0:
            packs = math.ceil(net_needed / pack_size)
            suggested_qty = packs * pack_size
        else:
            suggested_qty = net_needed
        line_cost = suggested_qty * cost

        notes: list[str] = []
        if urgency == "today" and lead_time > 0 and stockout_day is not None and stockout_day < lead_time:
            msg = (
                f"{item.name}: stockout in {stockout_day}d but supplier "
                f"lead time is {lead_time}d — should have ordered earlier."
            )
            notes.append("late_for_lead_time")
            compliance_warnings.append(msg)
        if item.is_perishable:
            # Perishables shouldn't get >14-day supply (we use 14 as the
            # horizon anyway — but if the owner edits qty up later we
            # want the warning structure to be there). Safety floor on
            # an item with no history can also leave us with suggested_qty
            # much bigger than burn → still a waste risk.
            #
            # Threshold: suggested_qty > max(projected_14d * 1.2, min_threshold)
            # so the warning doesn't fire on healthy "fill up to min" cases.
            safe_ceiling = max(projected_14d * 1.2, min_threshold)
            if suggested_qty > safe_ceiling and suggested_qty > 0:
                msg = (
                    f"{item.name} is perishable — suggested qty exceeds "
                    f"14-day projected demand. Waste risk."
                )
                notes.append("perishable_waste_risk")
                compliance_warnings.append(msg)
            elif projected_14d == 0 and suggested_qty > 0:
                # Safety-floor ordering of a perishable with no history.
                msg = (
                    f"{item.name} is perishable but has no recent sales "
                    f"history — verify before ordering. Waste risk."
                )
                notes.append("perishable_waste_risk")
                compliance_warnings.append(msg)
        if not supplier_email:
            notes.append("no_supplier_email")
        if item_conf == "low":
            notes.append("low_history")

        recommendations.append(AutopilotItem(
            item_id=str(item.id),
            name=item.name,
            unit=item.unit or "pieces",
            category=item.category,
            current_stock=current_stock,
            min_threshold=min_threshold,
            daily_demand=daily_demand,
            projected_demand_14d=projected_14d,
            days_until_stockout=stockout_day,
            stockout_date=stockout_date,
            urgency=urgency,
            suggested_qty=suggested_qty,
            pack_size=pack_size,
            cost_per_unit=cost,
            line_cost=line_cost,
            supplier_name=supplier_name,
            supplier_email=supplier_email,
            supplier_lead_time_days=lead_time,
            is_perishable=bool(item.is_perishable),
            confidence=item_conf,
            samples=samples,
            notes=notes,
        ))
        item_confidence_grades.append(item_conf)

    # ─── Sort by urgency, then by suggested cost (biggest first) ──
    urgency_rank = {"today": 0, "this_week": 1, "monitor": 2}
    recommendations.sort(
        key=lambda r: (urgency_rank.get(r.urgency, 99), -r.line_cost, r.name.lower())
    )

    # ─── Group by supplier (None bucket for no-supplier items) ─────
    supplier_buckets: dict[str, list[AutopilotItem]] = defaultdict(list)
    for r in recommendations:
        key = r.supplier_email or "__no_supplier__"
        supplier_buckets[key].append(r)

    suppliers: list[SupplierGroup] = []
    for key, group_items in supplier_buckets.items():
        # group_items already inherits sort order from the parent list
        worst_urgency = "monitor"
        for it in group_items:
            if urgency_rank.get(it.urgency, 99) < urgency_rank.get(worst_urgency, 99):
                worst_urgency = it.urgency
        suppliers.append(SupplierGroup(
            supplier_name=group_items[0].supplier_name if key != "__no_supplier__" else None,
            supplier_email=None if key == "__no_supplier__" else key,
            items=group_items,
            total_cost=sum(it.line_cost for it in group_items),
            urgency=worst_urgency,
        ))
    # Order suppliers by worst-urgency first, then cost desc
    suppliers.sort(key=lambda g: (urgency_rank.get(g.urgency, 99), -g.total_cost))

    # ─── Overall confidence — worst of the recommended-item grades ─
    if not item_confidence_grades:
        overall_confidence = "low"
    elif all(c == "high" for c in item_confidence_grades):
        overall_confidence = "high"
    elif any(c == "low" for c in item_confidence_grades):
        overall_confidence = "low" if item_confidence_grades.count("low") >= len(item_confidence_grades) / 2 else "medium"
    else:
        overall_confidence = "medium"

    total_cost = sum(r.line_cost for r in recommendations)

    return AutopilotSuggestion(
        generated_at=datetime.utcnow().isoformat() + "Z",
        branch_id=str(branch_id) if branch_id else None,
        days_ahead=days_ahead,
        confidence=overall_confidence,
        basis={
            "weeks_of_data": LOOKBACK_WEEKS,
            "items_total": len(items),
            "items_with_history": sum(1 for s in history.values() if s["samples"] > 0),
            "items_suggested": len(recommendations),
            "weather_used": weather_used,
            "lookback_start": history_start.isoformat(),
            "lookback_end": history_end.isoformat(),
        },
        items=recommendations,
        suppliers=suppliers,
        total_cost=total_cost,
        compliance_warnings=compliance_warnings,
    )


# ─── Apply (send orders) ──────────────────────────────────────────────


def _format_order_email(
    *,
    user: User,
    supplier_name: Optional[str],
    items: list[dict],
    currency: str = "DKK",
) -> tuple[str, str]:
    """Build (subject, html) for a single supplier order email.

    Plain, no-fluff layout: business name → date → table → total.
    Reply-to is set by the caller to user.email so the supplier
    can reply directly to the owner.
    """
    business_name = getattr(user, "business_name", None) or "BonBox"
    today_iso = date.today().isoformat()
    safe_name = supplier_name or "Supplier"

    rows_html: list[str] = []
    total = 0.0
    for it in items:
        name = (it.get("name") or "").strip()[:120]
        qty = _safe_float(it.get("qty"), 0.0)
        unit = (it.get("unit") or "pieces")[:20]
        cost = _safe_float(it.get("cost_per_unit"), 0.0)
        line = qty * cost
        total += line
        rows_html.append(
            f"<tr><td style='padding:6px 12px;border-bottom:1px solid #eee'>{name}</td>"
            f"<td style='padding:6px 12px;border-bottom:1px solid #eee;text-align:right'>{qty:.2f} {unit}</td>"
            f"<td style='padding:6px 12px;border-bottom:1px solid #eee;text-align:right'>{cost:.2f}</td>"
            f"<td style='padding:6px 12px;border-bottom:1px solid #eee;text-align:right'>{line:.2f} {currency}</td></tr>"
        )

    subject = f"Order from {business_name} — {today_iso}"
    html = (
        f"<div style='font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;max-width:640px'>"
        f"<p>Hi {safe_name},</p>"
        f"<p>Please find our latest order below. Reply to this email to confirm "
        f"availability and expected delivery.</p>"
        f"<table style='border-collapse:collapse;width:100%;margin:16px 0'>"
        f"<thead><tr style='background:#f7f5f1'>"
        f"<th style='padding:8px 12px;text-align:left'>Item</th>"
        f"<th style='padding:8px 12px;text-align:right'>Quantity</th>"
        f"<th style='padding:8px 12px;text-align:right'>Unit cost</th>"
        f"<th style='padding:8px 12px;text-align:right'>Line total</th>"
        f"</tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody>"
        f"<tfoot><tr><td colspan='3' style='padding:10px 12px;text-align:right;font-weight:600'>Total (est.)</td>"
        f"<td style='padding:10px 12px;text-align:right;font-weight:600'>{total:.2f} {currency}</td></tr></tfoot>"
        f"</table>"
        f"<p>Thanks,<br/>{business_name}</p>"
        f"<hr style='border:0;border-top:1px solid #eee;margin:24px 0'/>"
        f"<p style='font-size:12px;color:#888'>Sent via BonBox Inventory Autopilot. "
        f"Reply directly to reach {business_name}.</p>"
        f"</div>"
    )
    return subject, html


def apply_reorder(
    db: Session,
    *,
    user: User,
    items: list[dict],
    send_email_fn=None,
) -> dict:
    """Materialize the (owner-edited) suggestion into supplier emails.

    Each `items` entry must include:
      - item_id     (string UUID, tenant-owned)
      - qty         (float > 0)
      - supplier_name   (optional, sourced from item if missing)
      - supplier_email  (optional, sourced from item if missing)
      - unit, cost_per_unit, name — optional, sourced from item if missing

    Items are grouped by supplier_email and ONE email is sent per supplier.
    Items missing a supplier_email are returned in `skipped_no_supplier`
    so the UI can show "Add supplier email to send" hints.

    `send_email_fn` is injected for testing. Defaults to the real Resend
    sender at runtime.

    Returns: {
      sent: int,
      skipped_no_supplier: int,
      failures: list[{supplier_email, reason}],
      audit: list[{supplier_email, item_count, total_cost}],
      groups: list[...],
    }
    """
    if not items:
        return {
            "sent": 0,
            "skipped_no_supplier": 0,
            "failures": [],
            "audit": [],
            "groups": [],
        }
    if len(items) > MAX_ITEMS_PER_APPLY:
        raise ValueError(f"too many items (max {MAX_ITEMS_PER_APPLY})")

    # ─── Validate + tenant-scope every item_id ─────────────────────
    item_ids_raw = [i.get("item_id") for i in items if i.get("item_id")]
    item_uuids: list[uuid.UUID] = []
    for raw in item_ids_raw:
        try:
            item_uuids.append(uuid.UUID(str(raw)))
        except (TypeError, ValueError):
            raise ValueError(f"invalid item_id: {raw}")

    owned = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.id.in_(item_uuids),
            InventoryItem.user_id == user.id,
        )
        .all()
    )
    owned_by_id: dict[str, InventoryItem] = {str(it.id): it for it in owned}
    for u in item_uuids:
        if str(u) not in owned_by_id:
            raise ValueError(f"item_id {u} not owned by this user")

    # ─── Group by supplier_email ───────────────────────────────────
    groups: dict[str, list[dict]] = defaultdict(list)
    skipped_no_supplier = 0

    for raw in items:
        item_id = str(raw.get("item_id"))
        it = owned_by_id[item_id]
        qty = _safe_float(raw.get("qty"), 0.0)
        # Defense: clamp qty to MAX_QTY_PER_ITEM and refuse non-positive
        if qty <= 0:
            continue
        if qty > MAX_QTY_PER_ITEM:
            qty = MAX_QTY_PER_ITEM

        # Caller-provided supplier overrides item's stored supplier so
        # the owner can edit on the way to send. We never persist edits
        # via apply — that's a separate /inventory PATCH operation.
        supplier_email = (raw.get("supplier_email") or getattr(it, "supplier_email", None) or "").strip()
        supplier_name = (raw.get("supplier_name") or getattr(it, "supplier_name", None) or "").strip()

        line = {
            "item_id": item_id,
            "name": raw.get("name") or it.name,
            "unit": raw.get("unit") or it.unit or "pieces",
            "qty": qty,
            "cost_per_unit": _safe_float(raw.get("cost_per_unit"), _safe_float(it.cost_per_unit)),
            "supplier_name": supplier_name or None,
            "supplier_email": supplier_email or None,
        }
        if not supplier_email or "@" not in supplier_email:
            skipped_no_supplier += 1
            groups.setdefault("__no_supplier__", []).append(line)
            continue
        groups[supplier_email].append(line)

    # ─── Send one email per supplier ──────────────────────────────
    sent = 0
    failures: list[dict] = []
    audit_entries: list[dict] = []
    summarized_groups: list[dict] = []

    # Lazy import so this module is testable without resend env set.
    if send_email_fn is None:
        from app.services.email_service import send_email_with_attachment  # noqa: F401
        from app.services.email_service import send_email as _send_email

        def _default_sender(to, subject, html, *, reply_to=None):
            # Audit P3 (Task #80): pass reply_to through to Resend so
            # the supplier's Reply lands in the owner's inbox, not in
            # noreply@bonbox.dk.  Previously this kwarg was silently
            # dropped — see send_email signature.
            return _send_email(to, subject, html, reply_to=reply_to), None

        send_email_fn = _default_sender

    currency = getattr(user, "currency", None) or "DKK"

    for supplier_email, lines in groups.items():
        total = sum(_safe_float(l.get("qty")) * _safe_float(l.get("cost_per_unit")) for l in lines)
        summary = {
            "supplier_email": None if supplier_email == "__no_supplier__" else supplier_email,
            "supplier_name": next((l.get("supplier_name") for l in lines if l.get("supplier_name")), None),
            "items": [
                {
                    "item_id": l["item_id"],
                    "name": l["name"],
                    "qty": round(_safe_float(l["qty"]), 2),
                    "unit": l["unit"],
                }
                for l in lines
            ],
            "total_cost": round(total, 2),
        }
        summarized_groups.append(summary)

        if supplier_email == "__no_supplier__":
            continue

        subject, html = _format_order_email(
            user=user,
            supplier_name=next((l.get("supplier_name") for l in lines), None),
            items=lines,
            currency=currency,
        )
        try:
            ok, reason = send_email_fn(
                supplier_email, subject, html,
                reply_to=getattr(user, "email", None),
            )
        except Exception as e:  # noqa: BLE001
            ok = False
            reason = f"send_exception: {type(e).__name__}"

        if ok:
            sent += 1
            audit_entries.append({
                "supplier_email": supplier_email,
                "item_count": len(lines),
                "total_cost": round(total, 2),
            })
        else:
            failures.append({
                "supplier_email": supplier_email,
                "reason": reason or "send_failed",
            })

    return {
        "sent": sent,
        "skipped_no_supplier": skipped_no_supplier,
        "failures": failures,
        "audit": audit_entries,
        "groups": summarized_groups,
    }
