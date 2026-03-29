"""Weather-Smart Business — correlate weather with sales, staffing, and sick calls."""

import uuid
from datetime import date, datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, extract
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.weather import SickCall
from app.schemas.weather import LocationUpdate, SickCallCreate, SickCallResponse
from app.services.auth import get_current_user

router = APIRouter()

# WMO weather code → condition category
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

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"


def _wmo_to_condition(code: int) -> str:
    return WMO_MAP.get(code, "cloudy")


# ─── Save location ───────────────────────────────────────────────
@router.post("/location")
def save_location(
    body: LocationUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.latitude = body.latitude
    user.longitude = body.longitude
    db.commit()
    return {"status": "ok", "latitude": body.latitude, "longitude": body.longitude}


# ─── 7-day forecast ──────────────────────────────────────────────
@router.get("/forecast")
def get_forecast(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lat = getattr(user, "latitude", None)
    lon = getattr(user, "longitude", None)
    if not lat or not lon:
        raise HTTPException(400, "Set your location first")

    resp = httpx.get(OPEN_METEO_FORECAST, params={
        "latitude": lat, "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max",
        "timezone": "auto",
    }, timeout=10)
    if resp.status_code != 200:
        raise HTTPException(502, "Weather service unavailable")

    data = resp.json()["daily"]
    days = []
    for i in range(len(data["time"])):
        wmo = data["weather_code"][i]
        days.append({
            "date": data["time"][i],
            "temp_max": data["temperature_2m_max"][i],
            "temp_min": data["temperature_2m_min"][i],
            "precipitation": data["precipitation_sum"][i],
            "wind_speed": data["wind_speed_10m_max"][i],
            "weather_code": wmo,
            "condition": _wmo_to_condition(wmo),
        })
    return {"days": days, "timezone": resp.json().get("timezone", "UTC")}


# ─── Weather impact profile (sales by weather condition) ─────────
@router.get("/impact-profile")
def get_impact_profile(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Correlate historical sales with weather conditions using Open-Meteo archive."""
    lat = getattr(user, "latitude", None)
    lon = getattr(user, "longitude", None)
    if not lat or not lon:
        raise HTTPException(400, "Set your location first")

    # Get user's sales data range
    sales = (
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(Sale.user_id == user.id, Sale.is_deleted == False)
        .group_by(Sale.date)
        .all()
    )
    if not sales:
        return {"conditions": {}, "average_daily": 0, "message": "Log some sales first to see weather impact"}

    sales_by_date = {str(s[0]): float(s[1]) for s in sales}
    all_dates = sorted(sales_by_date.keys())
    start_date = all_dates[0]
    end_date = all_dates[-1]

    # Fetch historical weather for the sales date range
    try:
        resp = httpx.get(OPEN_METEO_ARCHIVE, params={
            "latitude": lat, "longitude": lon,
            "daily": "weather_code,temperature_2m_max,precipitation_sum",
            "start_date": start_date, "end_date": end_date,
            "timezone": "auto",
        }, timeout=15)
        if resp.status_code != 200:
            return {"conditions": {}, "average_daily": 0, "message": "Could not fetch historical weather"}

        weather_data = resp.json()["daily"]
        weather_by_date = {}
        for i in range(len(weather_data["time"])):
            weather_by_date[weather_data["time"][i]] = _wmo_to_condition(weather_data["weather_code"][i])
    except Exception:
        return {"conditions": {}, "average_daily": 0, "message": "Weather service error"}

    # Correlate sales with conditions
    condition_totals: dict[str, list[float]] = {}
    for d, amount in sales_by_date.items():
        cond = weather_by_date.get(d, "unknown")
        if cond == "unknown":
            continue
        condition_totals.setdefault(cond, []).append(amount)

    avg_daily = sum(sales_by_date.values()) / len(sales_by_date) if sales_by_date else 0
    conditions = {}
    for cond, amounts in condition_totals.items():
        avg = sum(amounts) / len(amounts)
        conditions[cond] = {
            "average_revenue": round(avg, 2),
            "sample_days": len(amounts),
            "multiplier": round(avg / avg_daily, 2) if avg_daily else 1.0,
        }

    return {"conditions": conditions, "average_daily": round(avg_daily, 2)}


# ─── Seasonal patterns (monthly averages) ────────────────────────
@router.get("/seasonal")
def get_seasonal(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        db.query(
            extract("month", Sale.date).label("month"),
            func.avg(Sale.amount).label("avg"),
            func.count(Sale.id).label("count"),
        )
        .filter(Sale.user_id == user.id, Sale.is_deleted == False)
        .group_by("month")
        .all()
    )
    months = {}
    for r in rows:
        months[int(r.month)] = {"average": round(float(r.avg), 2), "transactions": int(r.count)}
    return {"months": months}


# ─── Sick calls ──────────────────────────────────────────────────
@router.post("/sick-calls")
def add_sick_call(
    body: SickCallCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    sc = SickCall(
        id=uuid.uuid4(),
        user_id=user.id,
        staff_name=body.staff_name,
        date=body.date,
        weather_condition=body.weather_condition,
        notes=body.notes,
    )
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return {"id": str(sc.id), "staff_name": sc.staff_name, "date": str(sc.date)}


@router.get("/sick-calls")
def list_sick_calls(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    calls = (
        db.query(SickCall)
        .filter(SickCall.user_id == user.id)
        .order_by(SickCall.date.desc())
        .limit(50)
        .all()
    )
    return [
        {
            "id": str(c.id),
            "staff_name": c.staff_name,
            "date": str(c.date),
            "weather_condition": c.weather_condition,
            "notes": c.notes,
        }
        for c in calls
    ]


@router.get("/sick-calls/stats")
def sick_call_stats(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    today = date.today()
    this_month_start = today.replace(day=1)
    last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)

    this_month = db.query(func.count(SickCall.id)).filter(
        SickCall.user_id == user.id, SickCall.date >= this_month_start
    ).scalar() or 0

    last_month = db.query(func.count(SickCall.id)).filter(
        SickCall.user_id == user.id,
        SickCall.date >= last_month_start,
        SickCall.date < this_month_start,
    ).scalar() or 0

    # Count sick calls on bad weather days
    weather_sick = db.query(func.count(SickCall.id)).filter(
        SickCall.user_id == user.id,
        SickCall.weather_condition.in_(["rain", "snow", "storm"]),
    ).scalar() or 0

    total = db.query(func.count(SickCall.id)).filter(SickCall.user_id == user.id).scalar() or 0

    # By condition breakdown
    by_condition = (
        db.query(SickCall.weather_condition, func.count(SickCall.id))
        .filter(SickCall.user_id == user.id, SickCall.weather_condition.isnot(None))
        .group_by(SickCall.weather_condition)
        .all()
    )

    return {
        "this_month": this_month,
        "last_month": last_month,
        "weather_related": weather_sick,
        "total": total,
        "by_condition": {c: cnt for c, cnt in by_condition},
    }


# ─── Smart insights (generated from forecast + history) ──────────
@router.get("/insights")
def get_insights(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lat = getattr(user, "latitude", None)
    lon = getattr(user, "longitude", None)
    if not lat or not lon:
        return {"insights": [{"type": "setup", "severity": "info", "title": "Set Your Location", "detail": "Enable weather insights by setting your business location."}]}

    # Get forecast
    try:
        resp = httpx.get(OPEN_METEO_FORECAST, params={
            "latitude": lat, "longitude": lon,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max",
            "timezone": "auto",
        }, timeout=10)
        forecast = resp.json()["daily"]
    except Exception:
        return {"insights": [{"type": "error", "severity": "warning", "title": "Weather Unavailable", "detail": "Could not fetch forecast data."}]}

    insights = []
    for i in range(min(3, len(forecast["time"]))):
        d = forecast["time"][i]
        wmo = forecast["weather_code"][i]
        cond = _wmo_to_condition(wmo)
        precip = forecast["precipitation_sum"][i] or 0
        wind = forecast["wind_speed_10m_max"][i] or 0
        temp_max = forecast["temperature_2m_max"][i]

        day_label = "Today" if i == 0 else ("Tomorrow" if i == 1 else d)

        if cond in ("rain", "storm") and precip > 5:
            insights.append({
                "type": "weather",
                "severity": "high",
                "title": f"{day_label}: Heavy {'Storm' if cond == 'storm' else 'Rain'} Expected",
                "detail": f"{precip}mm precipitation — expect 20-40% lower foot traffic. Consider reducing staff.",
            })
        elif cond == "rain":
            insights.append({
                "type": "weather",
                "severity": "medium",
                "title": f"{day_label}: Rain Forecast",
                "detail": f"{precip}mm precipitation — foot traffic may drop 10-20%.",
            })
        elif cond == "snow":
            insights.append({
                "type": "weather",
                "severity": "high",
                "title": f"{day_label}: Snow Expected",
                "detail": f"Expect lower foot traffic and possible staff no-shows. Plan ahead.",
            })
        elif wind > 50:
            insights.append({
                "type": "weather",
                "severity": "medium",
                "title": f"{day_label}: High Winds ({wind} km/h)",
                "detail": "Strong winds may reduce walk-in traffic. Secure outdoor items.",
            })
        elif cond == "clear" and temp_max and temp_max > 25:
            insights.append({
                "type": "weather",
                "severity": "low",
                "title": f"{day_label}: Great Weather!",
                "detail": f"Sunny and {temp_max}°C — expect higher foot traffic. Staff up if possible.",
            })

    if not insights:
        insights.append({
            "type": "weather",
            "severity": "low",
            "title": "Weather Looks Normal",
            "detail": "No major weather impacts expected in the next 3 days.",
        })

    return {"insights": insights}
