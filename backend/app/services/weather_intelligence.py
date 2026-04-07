"""
Weather Intelligence Service — correlate weather with sales for predictive insights.

Flow:
1. sync_historical_weather() — backfill daily_weather table from Open-Meteo archive
2. get_correlation()         — group sales by weather condition, compute revenue per condition
3. get_prediction()          — predict tomorrow's revenue from forecast + historical correlation
4. get_smart_alerts()        — generate actionable alerts based on upcoming weather + history
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.sale import Sale
from app.models.weather import DailyWeather

logger = logging.getLogger(__name__)

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

WMO_MAP = {
    0: "clear", 1: "clear", 2: "cloudy", 3: "cloudy",
    45: "fog", 48: "fog",
    51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "drizzle", 57: "drizzle",
    61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
    71: "snow", 73: "snow", 75: "snow", 77: "snow",
    80: "rain", 81: "rain", 82: "rain",
    85: "snow", 86: "snow",
    95: "storm", 96: "storm", 99: "storm",
}

CONDITION_EMOJI = {
    "clear": "☀️", "cloudy": "⛅", "rain": "🌧️", "drizzle": "🌦️",
    "snow": "❄️", "storm": "⛈️", "fog": "🌫️",
}


def _wmo_to_condition(code: int) -> str:
    return WMO_MAP.get(code, "cloudy")


# ─── 1. Sync Historical Weather ────────────────────────────────
def sync_historical_weather(user: User, db: Session) -> dict:
    """
    Backfill daily_weather table for every day the user has sales.
    Fetches from Open-Meteo archive API (free, no key needed).
    Returns stats: {synced, skipped, total_sales_days}.
    """
    lat, lon = getattr(user, "latitude", None), getattr(user, "longitude", None)
    if not lat or not lon:
        return {"error": "No location set", "synced": 0}

    # Get all dates where user has sales
    sales_dates = (
        db.query(Sale.date)
        .filter(Sale.user_id == user.id, Sale.is_deleted == False)
        .distinct()
        .all()
    )
    if not sales_dates:
        return {"error": "No sales data yet", "synced": 0}

    all_dates = sorted(set(d[0] for d in sales_dates))

    # Check which dates already have weather stored
    existing = set(
        r[0] for r in
        db.query(DailyWeather.date)
        .filter(DailyWeather.user_id == user.id)
        .all()
    )

    missing_dates = [d for d in all_dates if d not in existing]
    if not missing_dates:
        return {"synced": 0, "skipped": len(all_dates), "total_sales_days": len(all_dates), "message": "Already up to date"}

    # Fetch weather in chunks (Open-Meteo allows big date ranges)
    start_date = str(min(missing_dates))
    end_date = str(max(missing_dates))

    # Cap at max 2 years back (Open-Meteo archive limit)
    earliest_allowed = str(date.today() - timedelta(days=730))
    if start_date < earliest_allowed:
        start_date = earliest_allowed

    try:
        resp = httpx.get(OPEN_METEO_ARCHIVE, params={
            "latitude": float(lat), "longitude": float(lon),
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
            "start_date": start_date, "end_date": end_date,
            "timezone": "auto",
        }, timeout=30)
        if resp.status_code != 200:
            return {"error": f"Weather API returned {resp.status_code}", "synced": 0}

        data = resp.json()["daily"]
    except Exception as e:
        logger.error("Weather sync failed: %s", e)
        return {"error": str(e), "synced": 0}

    # Build lookup: date_str → weather
    weather_lookup = {}
    for i in range(len(data["time"])):
        weather_lookup[data["time"][i]] = {
            "weather_code": data["weather_code"][i],
            "temp_max": data["temperature_2m_max"][i],
            "temp_min": data["temperature_2m_min"][i],
            "rain_mm": data["precipitation_sum"][i] or 0,
            "wind_max_kmh": data["wind_speed_10m_max"][i],
        }

    # Insert missing dates
    synced = 0
    for d in missing_dates:
        d_str = str(d)
        if d_str not in weather_lookup:
            continue
        w = weather_lookup[d_str]
        dw = DailyWeather(
            id=uuid.uuid4(),
            user_id=user.id,
            date=d,
            temp_max=w["temp_max"],
            temp_min=w["temp_min"],
            rain_mm=w["rain_mm"],
            wind_max_kmh=w["wind_max_kmh"],
            weather_code=w["weather_code"],
            condition=_wmo_to_condition(w["weather_code"]) if w["weather_code"] is not None else None,
        )
        db.add(dw)
        synced += 1

    db.commit()
    return {
        "synced": synced,
        "skipped": len(all_dates) - len(missing_dates),
        "total_sales_days": len(all_dates),
    }


# ─── 2. Weather × Sales Correlation ────────────────────────────
def get_correlation(user: User, db: Session) -> dict:
    """
    Correlate stored weather with sales data.
    Returns per-condition revenue stats + overall metrics.
    Requires 30+ days of paired data for meaningful results.
    """
    # Join daily_weather with sales aggregated by date
    sales_by_date = dict(
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(Sale.user_id == user.id, Sale.is_deleted == False)
        .group_by(Sale.date)
        .all()
    )

    weather_records = (
        db.query(DailyWeather)
        .filter(DailyWeather.user_id == user.id)
        .all()
    )

    if not weather_records or not sales_by_date:
        return {
            "ready": False,
            "days_collected": len(weather_records),
            "days_needed": 30,
            "conditions": {},
            "message": "Need more data. Keep logging sales!",
        }

    # Match weather days with sales days
    paired = []
    for w in weather_records:
        if w.date in sales_by_date:
            paired.append({
                "date": w.date,
                "condition": w.condition or "unknown",
                "temp_max": float(w.temp_max) if w.temp_max else None,
                "rain_mm": float(w.rain_mm) if w.rain_mm else 0,
                "revenue": float(sales_by_date[w.date]),
            })

    n = len(paired)
    ready = n >= 30

    if n == 0:
        return {
            "ready": False,
            "days_collected": 0,
            "days_needed": 30,
            "conditions": {},
            "message": "Sync weather data first.",
        }

    # Group by condition
    by_cond = defaultdict(list)
    for p in paired:
        by_cond[p["condition"]].append(p["revenue"])

    overall_avg = sum(p["revenue"] for p in paired) / n

    conditions = {}
    for cond, revenues in sorted(by_cond.items()):
        avg = sum(revenues) / len(revenues)
        conditions[cond] = {
            "average_revenue": round(avg, 2),
            "sample_days": len(revenues),
            "multiplier": round(avg / overall_avg, 2) if overall_avg else 1.0,
            "impact_pct": round((avg / overall_avg - 1) * 100, 1) if overall_avg else 0,
            "best_day": round(max(revenues), 2),
            "worst_day": round(min(revenues), 2),
        }

    # Temperature-based analysis (warm vs cold)
    temp_analysis = None
    temp_paired = [p for p in paired if p["temp_max"] is not None]
    if len(temp_paired) >= 10:
        warm = [p["revenue"] for p in temp_paired if p["temp_max"] >= 20]
        cold = [p["revenue"] for p in temp_paired if p["temp_max"] < 5]
        mild = [p["revenue"] for p in temp_paired if 5 <= p["temp_max"] < 20]
        temp_analysis = {}
        if warm:
            temp_analysis["warm_20plus"] = {"avg_revenue": round(sum(warm) / len(warm), 2), "days": len(warm)}
        if cold:
            temp_analysis["cold_below_5"] = {"avg_revenue": round(sum(cold) / len(cold), 2), "days": len(cold)}
        if mild:
            temp_analysis["mild_5_to_20"] = {"avg_revenue": round(sum(mild) / len(mild), 2), "days": len(mild)}

    # Rain impact
    rain_analysis = None
    rain_paired = [p for p in paired if p["rain_mm"] is not None]
    if len(rain_paired) >= 10:
        dry = [p["revenue"] for p in rain_paired if p["rain_mm"] < 1]
        light = [p["revenue"] for p in rain_paired if 1 <= p["rain_mm"] < 5]
        heavy = [p["revenue"] for p in rain_paired if p["rain_mm"] >= 5]
        rain_analysis = {}
        if dry:
            rain_analysis["dry"] = {"avg_revenue": round(sum(dry) / len(dry), 2), "days": len(dry)}
        if light:
            rain_analysis["light_rain"] = {"avg_revenue": round(sum(light) / len(light), 2), "days": len(light)}
        if heavy:
            rain_analysis["heavy_rain"] = {"avg_revenue": round(sum(heavy) / len(heavy), 2), "days": len(heavy)}

    return {
        "ready": ready,
        "days_collected": n,
        "days_needed": 30,
        "overall_average": round(overall_avg, 2),
        "conditions": conditions,
        "temperature_analysis": temp_analysis,
        "rain_analysis": rain_analysis,
    }


# ─── 3. Tomorrow's Revenue Prediction ──────────────────────────
def get_prediction(user: User, db: Session) -> dict:
    """
    Predict tomorrow's revenue based on forecast weather + historical correlation.
    """
    lat, lon = getattr(user, "latitude", None), getattr(user, "longitude", None)
    if not lat or not lon:
        return {"error": "No location set"}

    # Get correlation data
    corr = get_correlation(user, db)
    if not corr.get("ready"):
        return {
            "available": False,
            "days_collected": corr.get("days_collected", 0),
            "days_needed": 30,
            "message": f"Need {30 - corr.get('days_collected', 0)} more days of data for predictions.",
        }

    # Get tomorrow's forecast
    try:
        resp = httpx.get(OPEN_METEO_FORECAST, params={
            "latitude": float(lat), "longitude": float(lon),
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
            "forecast_days": 3,
            "timezone": "auto",
        }, timeout=15)
        if resp.status_code != 200:
            return {"available": False, "error": "Forecast unavailable"}
        forecast_data = resp.json()["daily"]
    except Exception as e:
        return {"available": False, "error": str(e)}

    predictions = []
    conditions = corr["conditions"]
    overall_avg = corr["overall_average"]

    for i in range(min(3, len(forecast_data["time"]))):
        fc_date = forecast_data["time"][i]
        wmo = forecast_data["weather_code"][i]
        cond = _wmo_to_condition(wmo) if wmo is not None else "cloudy"
        temp_max = forecast_data["temperature_2m_max"][i]
        rain = forecast_data["precipitation_sum"][i] or 0

        day_label = "Today" if i == 0 else ("Tomorrow" if i == 1 else fc_date)

        # Look up this condition's historical revenue
        cond_data = conditions.get(cond, {})
        predicted_revenue = cond_data.get("average_revenue", overall_avg)
        multiplier = cond_data.get("multiplier", 1.0)
        impact_pct = cond_data.get("impact_pct", 0)
        sample_days = cond_data.get("sample_days", 0)

        confidence = "high" if sample_days >= 15 else ("medium" if sample_days >= 5 else "low")

        predictions.append({
            "date": fc_date,
            "day_label": day_label,
            "condition": cond,
            "emoji": CONDITION_EMOJI.get(cond, "🌡️"),
            "temp_max": temp_max,
            "rain_mm": rain,
            "predicted_revenue": round(predicted_revenue, 2),
            "overall_average": round(overall_avg, 2),
            "multiplier": multiplier,
            "impact_pct": impact_pct,
            "confidence": confidence,
            "sample_days": sample_days,
        })

    return {
        "available": True,
        "predictions": predictions,
        "overall_average": round(overall_avg, 2),
    }


# ─── 4. Smart Predictive Alerts ────────────────────────────────
def get_smart_alerts(user: User, db: Session) -> list[dict]:
    """
    Generate actionable alerts combining forecast with historical patterns.
    Returns a list of alert dicts with type, severity, title, detail, action.
    """
    alerts = []

    prediction = get_prediction(user, db)

    if not prediction.get("available"):
        # Not enough data yet — show progress alert
        days = prediction.get("days_collected", 0)
        alerts.append({
            "type": "progress",
            "severity": "info",
            "icon": "📊",
            "title": "Building Your Weather Intelligence",
            "detail": f"{days}/30 days collected. Keep logging sales — predictions unlock at 30 days!",
            "action": "Log today's sales to speed up intelligence.",
        })
        return alerts

    preds = prediction.get("predictions", [])
    overall_avg = prediction.get("overall_average", 0)

    for p in preds:
        cond = p["condition"]
        impact = p["impact_pct"]
        predicted = p["predicted_revenue"]
        label = p["day_label"]
        rain = p.get("rain_mm", 0)
        emoji = p["emoji"]

        # Revenue drop alert
        if impact <= -15:
            drop_pct = abs(round(impact))
            loss = round(overall_avg - predicted, 2)
            alerts.append({
                "type": "revenue_drop",
                "severity": "high",
                "icon": "📉",
                "title": f"{emoji} {label}: Revenue likely down ~{drop_pct}%",
                "detail": f"On {cond} days, you typically make {round(predicted)} vs {round(overall_avg)} average. Expected loss: ~{round(loss)}.",
                "action": "Consider reducing staff, pushing delivery orders, or running a rainy-day promo.",
            })
        elif impact <= -5:
            alerts.append({
                "type": "revenue_dip",
                "severity": "medium",
                "icon": "⚠️",
                "title": f"{emoji} {label}: Slight dip expected ({round(impact)}%)",
                "detail": f"{cond.capitalize()} weather historically brings slightly lower revenue.",
                "action": "Monitor walk-in traffic and adjust staff if needed.",
            })

        # Revenue boost alert
        if impact >= 15:
            boost_pct = round(impact)
            gain = round(predicted - overall_avg, 2)
            alerts.append({
                "type": "revenue_boost",
                "severity": "positive",
                "icon": "🚀",
                "title": f"{emoji} {label}: Revenue boost expected! +{boost_pct}%",
                "detail": f"On {cond} days, you typically make {round(predicted)} vs {round(overall_avg)} average. Extra: ~{round(gain)}.",
                "action": "Ensure full staffing. Stock up on popular items.",
            })

        # Heavy rain operational alert
        if rain >= 10:
            alerts.append({
                "type": "operations",
                "severity": "high",
                "icon": "🌊",
                "title": f"{label}: Heavy rain ({rain}mm) — operational risk",
                "detail": "Expect delivery delays, possible supplier issues, and higher sick calls.",
                "action": "Confirm supplier deliveries. Check umbrella/entrance prep. Have backup staff on standby.",
            })

    # Staffing correlation with sick calls
    try:
        from app.models.weather import SickCall
        last_30 = date.today() - timedelta(days=30)
        sick_count = (
            db.query(func.count(SickCall.id))
            .filter(SickCall.user_id == user.id, SickCall.date >= last_30)
            .scalar() or 0
        )
        if sick_count >= 3:
            # Check if upcoming weather is bad
            bad_upcoming = any(p["condition"] in ("rain", "snow", "storm") for p in preds[:2])
            if bad_upcoming:
                alerts.append({
                    "type": "sick_risk",
                    "severity": "medium",
                    "icon": "🤒",
                    "title": "Staff sick call risk elevated",
                    "detail": f"You've had {sick_count} sick calls in the last 30 days and bad weather is coming.",
                    "action": "Have backup staff ready. Consider flexible scheduling.",
                })
    except Exception:
        pass

    if not alerts:
        alerts.append({
            "type": "all_clear",
            "severity": "low",
            "icon": "✅",
            "title": "Weather looks good for business!",
            "detail": "No significant weather impacts expected in the next few days.",
            "action": None,
        })

    return alerts
