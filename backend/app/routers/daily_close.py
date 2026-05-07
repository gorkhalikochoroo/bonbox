"""
Daily Close (Kasserapport) — structured end-of-day closing for restaurants.

Endpoints:
  POST   /api/daily-close              — submit daily close
  GET    /api/daily-close               — list closes (date range)
  GET    /api/daily-close/insights      — aggregated insights
  GET    /api/daily-close/prefill       — prefill from sales/expenses/cash
  POST   /api/daily-close/scan-report   — scan Z-report image via OCR
  GET    /api/daily-close/{id}          — single close
  GET    /api/daily-close/{id}/pdf      — kasserapport PDF
  DELETE /api/daily-close/{id}          — soft delete
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict
from io import BytesIO

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.daily_close import DailyClose, encode_breakdown, decode_breakdown
from app.models.branch import Branch
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.cashbook import CashTransaction
from app.models.business_profile import BusinessProfile
from app.schemas.daily_close import DailyCloseCreate, DailyCloseResponse, DailyCloseUnlock
from app.services.auth import get_current_user
from app.services.billing import effective_plan
from app.services.receipt_ocr import save_receipt_photo, parse_z_report
from app.services.daily_close_range_export import (
    build_daily_close_range_pdf,
    closes_to_csv_bytes,
)

router = APIRouter()

# Per-IP rate limiter — protects state-changing daily-close endpoints.
# Same shape as inventory/pour, modules, smart-import: a per-router
# Limiter so each router controls its own thresholds. Mirrors the
# 6-layer pattern (auth, bounds, rate limit, tenant scope, plan/quota,
# audit) used everywhere else.
_limiter = Limiter(key_func=get_remote_address)

# Per-tier daily Z-report scan caps — prevents Free users (or a script
# probing as Free) from draining Anthropic quota on the OCR pass.
# Numbers conservative: most owners scan once at end-of-day, multi-
# terminal venues might scan up to 4x. Pro generously covers all.
_SCAN_CAP_BY_PLAN = {
    "free":     5,
    "starter":  15,
    "trial":    50,
    "pro":      50,
    "business": 500,
}


def _today_scan_count(db: Session, user_id) -> int:
    """How many Z-report scans this user already triggered today.
    Counted via DailyClose rows with receipt_photo set on today's date —
    the scan-report endpoint doesn't have its own audit table, but a
    successful scan that produces a close lands here."""
    today = date.today()
    return (
        db.query(func.count(DailyClose.id))
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.date == today,
            DailyClose.receipt_photo.isnot(None),
        )
        .scalar()
    ) or 0


# ─── Helpers ───

def _to_response(dc: DailyClose) -> dict:
    """Convert DailyClose ORM to response dict with decoded breakdowns."""
    return {
        "id": dc.id,
        "date": dc.date,
        "branch_id": dc.branch_id,
        "revenue_breakdown": decode_breakdown(dc.revenue_categories),
        "revenue_total": float(dc.revenue_total or 0),
        "payment_breakdown": decode_breakdown(dc.payment_categories),
        "payment_total": float(dc.payment_total or 0),
        "moms_total": float(dc.moms_total) if dc.moms_total is not None else None,
        "revenue_ex_moms": float(dc.revenue_ex_moms) if dc.revenue_ex_moms is not None else None,
        "moms_mode": dc.moms_mode,
        "cash_expected": float(dc.cash_expected) if dc.cash_expected is not None else None,
        "cash_counted": float(dc.cash_counted) if dc.cash_counted is not None else None,
        "cash_difference": float(dc.cash_difference) if dc.cash_difference is not None else None,
        "tips_total": float(dc.tips_total) if dc.tips_total is not None else None,
        "tips_staff_count": dc.tips_staff_count,
        "tips_per_person": float(dc.tips_per_person) if dc.tips_per_person is not None else None,
        "status": getattr(dc, "status", None) or "confirmed",
        "notes": dc.notes,
        "closed_by": dc.closed_by,
        "closed_at": dc.closed_at,
        "unlock_reason": getattr(dc, "unlock_reason", None),
        "unlocked_by": getattr(dc, "unlocked_by", None),
        "unlocked_at": getattr(dc, "unlocked_at", None),
        "is_deleted": dc.is_deleted,
        "created_at": dc.created_at,
        "receipt_photo": getattr(dc, "receipt_photo", None),
    }


# ─── POST — submit daily close ───

@router.post("")
@_limiter.limit("30/minute")
def create_daily_close(
    request: Request,
    data: DailyCloseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Check for existing close on same date+branch (upsert)
    existing = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == data.date,
            DailyClose.branch_id == data.branch_id,
            DailyClose.is_deleted.isnot(True),
        )
        .first()
    )

    # Revenue total: when the OCR detected a bottom-line total
    # (revenue_total_override) AND the user didn't fully reconcile the
    # category breakdown, prefer the larger value. Three cases:
    #   • All categories filled, sum = override        → save sum (= override)
    #   • Categories partial (e.g. only Drinks=1.82),
    #     override = 17030                             → save 17030 (override
    #                                                    wins; breakdown is
    #                                                    incomplete or wrong)
    #   • Categories filled past override (user added
    #     extra revenue manually)                      → save sum (user
    #                                                    customizing)
    # The previous logic preferred any non-zero breakdown sum, which
    # broke the "skip — total saves correctly either way" promise of
    # the partial-detection banner: a single wrong OCR parse like 1.82
    # would silently overwrite the real 17,030 total.
    breakdown_sum = sum((data.revenue_breakdown or {}).values())
    override = data.revenue_total_override
    if override is not None and override > 0:
        revenue_total = float(max(breakdown_sum, override))
    elif breakdown_sum > 0:
        revenue_total = breakdown_sum
    else:
        revenue_total = 0

    # Detective control — when the breakdown sum diverges wildly from
    # the OCR'd override (>5x apart), emit a structured warning so an
    # admin can spot OCR quality issues + edge-case bugs in production
    # logs WITHOUT blocking the save (the save itself uses max() which
    # is the safe value for the user). Pairs with the schema + service
    # layers as a per-row monitor.
    if (
        breakdown_sum > 0
        and override is not None
        and override > 0
        and abs(breakdown_sum - override) / max(breakdown_sum, override) > 0.8
    ):
        logger.warning(
            "daily_close: revenue mismatch (using max=%s) "
            "user=%s breakdown_sum=%s override=%s breakdown=%s",
            revenue_total, user.id, breakdown_sum, override,
            data.revenue_breakdown,
        )

    payment_total = sum((data.payment_breakdown or {}).values())

    # Cash expected — explicit None check so 0 (legitimate "no cash today")
    # doesn't get treated as missing. The previous `or` chain coerced 0 → None.
    pb = data.payment_breakdown or {}
    if "cash" in pb:
        cash_expected = pb["cash"]
    elif "kontant" in pb:
        cash_expected = pb["kontant"]
    else:
        cash_expected = None
    cash_difference = None
    if cash_expected is not None and data.cash_counted is not None:
        cash_difference = round(float(data.cash_counted) - float(cash_expected), 2)

    tips_per_person = None
    if data.tips_total and data.tips_staff_count and data.tips_staff_count > 0:
        tips_per_person = round(data.tips_total / data.tips_staff_count, 2)

    # MOMS / VAT — use provided value or auto-calculate using the user's
    # currency rate AND their prices-include-Moms preference.
    # Previously hardcoded 25% which gave wrong MOMS for any non-DK user
    # (NPR 13%, GBP 20%, EUR 21%, etc.) and ignored B2B net-amount mode.
    moms_mode = data.moms_mode or "auto"
    if data.moms_total is not None:
        moms_total = round(data.moms_total, 2)
    else:
        try:
            from app.services.tax_service import _get_vat_rate
            vat_rate = _get_vat_rate(user.currency or "DKK")
        except Exception:  # noqa: BLE001
            vat_rate = 0.25  # safe DK fallback if tax service load fails
        # Per-close override beats user-level default (e.g. "this Z-report
        # is gross because the user picked 'with MOMS' before scanning").
        if data.prices_include_moms_override is not None:
            prices_incl_moms = bool(data.prices_include_moms_override)
        else:
            prices_incl_moms = bool(getattr(user, "prices_include_moms", True))
        if revenue_total > 0 and vat_rate > 0:
            if prices_incl_moms:
                # Gross-input mode (B2C): extract VAT from total
                moms_total = round(revenue_total * vat_rate / (1 + vat_rate), 2)
            else:
                # Net-input mode (B2B): VAT is rate × net
                moms_total = round(revenue_total * vat_rate, 2)
        else:
            moms_total = 0
    revenue_ex_moms = round(revenue_total - moms_total, 2) if revenue_total > 0 else 0

    status = data.status if data.status in ("draft", "confirmed") else "confirmed"

    if existing:
        # Block edits to confirmed (locked) entries — must unlock first
        existing_status = getattr(existing, "status", None) or "confirmed"
        if existing_status == "confirmed" and status != "draft":
            raise HTTPException(
                status_code=409,
                detail="This daily close is locked. Unlock it first to make changes."
            )
        # Update existing
        existing.revenue_categories = encode_breakdown(data.revenue_breakdown)
        existing.revenue_total = revenue_total
        existing.payment_categories = encode_breakdown(data.payment_breakdown)
        existing.payment_total = payment_total
        existing.moms_total = moms_total
        existing.revenue_ex_moms = revenue_ex_moms
        existing.moms_mode = moms_mode
        existing.cash_expected = cash_expected
        existing.cash_counted = data.cash_counted
        existing.cash_difference = cash_difference
        existing.tips_total = data.tips_total
        existing.tips_staff_count = data.tips_staff_count
        existing.tips_per_person = tips_per_person
        existing.status = status
        existing.notes = data.notes
        existing.closed_by = data.closed_by
        # Only overwrite the photo if the caller provided one — owners
        # editing a draft without re-uploading the photo shouldn't lose
        # the existing reference.
        if data.receipt_photo:
            existing.receipt_photo = data.receipt_photo
        if status == "confirmed":
            existing.closed_at = datetime.utcnow()
            # Clear unlock audit when re-confirming
            existing.unlock_reason = None
            existing.unlocked_by = None
            existing.unlocked_at = None
        db.commit()
        db.refresh(existing)
        return _to_response(existing)

    dc = DailyClose(
        id=uuid.uuid4(),
        user_id=user.id,
        branch_id=data.branch_id,
        date=data.date,
        revenue_categories=encode_breakdown(data.revenue_breakdown),
        revenue_total=revenue_total,
        payment_categories=encode_breakdown(data.payment_breakdown),
        payment_total=payment_total,
        moms_total=moms_total,
        revenue_ex_moms=revenue_ex_moms,
        moms_mode=moms_mode,
        cash_expected=cash_expected,
        cash_counted=data.cash_counted,
        cash_difference=cash_difference,
        tips_total=data.tips_total,
        tips_staff_count=data.tips_staff_count,
        tips_per_person=tips_per_person,
        status=status,
        notes=data.notes,
        closed_by=data.closed_by,
        closed_at=datetime.utcnow() if status == "confirmed" else None,
        receipt_photo=data.receipt_photo,
    )
    db.add(dc)
    db.commit()
    db.refresh(dc)
    return _to_response(dc)


# ─── POST — unlock a confirmed daily close ───

@router.post("/{close_id}/unlock")
@_limiter.limit("5/minute")
def unlock_daily_close(
    request: Request,
    close_id: str,
    data: DailyCloseUnlock,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Unlock a confirmed daily close so it can be edited. Owner only. Requires a reason."""
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    current_status = getattr(dc, "status", None) or "confirmed"
    if current_status != "confirmed":
        raise HTTPException(status_code=400, detail="Only confirmed closes can be unlocked")
    if not data.reason or not data.reason.strip():
        raise HTTPException(status_code=422, detail="A reason is required to unlock")

    dc.status = "draft"
    dc.unlock_reason = data.reason.strip()
    dc.unlocked_by = user.email or str(user.id)
    dc.unlocked_at = datetime.utcnow()
    db.commit()
    db.refresh(dc)
    return _to_response(dc)


# ─── GET — list daily closes ───

@router.get("")
def list_daily_closes(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    )
    if from_date:
        q = q.filter(DailyClose.date >= from_date)
    if to_date:
        q = q.filter(DailyClose.date <= to_date)
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)

    closes = q.order_by(DailyClose.date.desc()).limit(90).all()
    return [_to_response(dc) for dc in closes]


# ─── GET — insights ───

@router.get("/insights")
def daily_close_insights(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    d90 = date.today() - timedelta(days=90)
    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.is_deleted.isnot(True),
            DailyClose.date >= d90,
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    if not closes:
        return {"has_data": False, "insights": [], "summary": {}}

    # Aggregate data
    total_revenue = 0
    total_food = 0
    total_drinks = 0
    total_takeaway = 0
    total_tips = 0
    total_cash_diff = 0
    cash_diff_negative_days = 0
    cash_diff_count = 0
    tips_by_weekday = defaultdict(list)
    takeaway_by_month = defaultdict(float)
    revenue_by_month = defaultdict(float)

    for dc in closes:
        rev = decode_breakdown(dc.revenue_categories)
        rev_total = float(dc.revenue_total or 0)
        total_revenue += rev_total

        food = sum(v for k, v in rev.items() if k.lower() in ("food", "mad"))
        drinks = sum(v for k, v in rev.items() if k.lower() in ("drinks", "drikkevarer", "beverages"))
        takeaway = sum(v for k, v in rev.items() if k.lower() in ("takeaway", "udbringning", "delivery"))
        total_food += food
        total_drinks += drinks
        total_takeaway += takeaway

        if dc.tips_total:
            total_tips += float(dc.tips_total)
            weekday = dc.date.strftime("%A")
            tips_by_weekday[weekday].append(float(dc.tips_total))

        if dc.cash_difference is not None:
            diff = float(dc.cash_difference)
            total_cash_diff += diff
            cash_diff_count += 1
            if diff < 0:
                cash_diff_negative_days += 1

        month_key = dc.date.strftime("%Y-%m")
        takeaway_by_month[month_key] += takeaway
        revenue_by_month[month_key] += rev_total

    insights = []
    count = len(closes)

    # 1. Drink-to-food ratio
    if total_food > 0:
        ratio = round((total_drinks / (total_food + total_drinks)) * 100, 1)
        insights.append({
            "type": "drink_ratio",
            "icon": "🍸",
            "title": f"Drink-to-food ratio: {ratio}%",
            "detail": "Danish restaurant average is 35-45%. "
                      + ("You might be under-selling beverages — consider upselling wine with dinner." if ratio < 35
                         else "Great balance!" if ratio <= 45
                         else "Strong drink sales! Make sure food margins are healthy too."),
            "value": ratio,
            "benchmark": "35-45%",
        })

    # 2. Tip trends by weekday
    if tips_by_weekday:
        tip_avgs = {day: round(sum(vals) / len(vals)) for day, vals in tips_by_weekday.items()}
        best_day = max(tip_avgs, key=tip_avgs.get)
        worst_day = min(tip_avgs, key=tip_avgs.get)
        if tip_avgs[best_day] > 0 and tip_avgs[worst_day] > 0:
            multiplier = round(tip_avgs[best_day] / tip_avgs[worst_day], 1)
            insights.append({
                "type": "tip_trends",
                "icon": "💰",
                "title": f"{best_day} tips avg {tip_avgs[best_day]:,} vs {worst_day} avg {tip_avgs[worst_day]:,}",
                "detail": f"Your {best_day} staff earns {multiplier}x more in tips than {worst_day} staff.",
                "weekday_averages": tip_avgs,
            })

    # 3. Cash difference tracking
    if cash_diff_count >= 5:
        insights.append({
            "type": "cash_drift",
            "icon": "🔍" if total_cash_diff < -200 else "✅",
            "title": f"Cash difference: {total_cash_diff:+,.0f} over {cash_diff_count} days",
            "detail": (
                f"Negative {cash_diff_negative_days} out of {cash_diff_count} days. Investigate — could be counting errors or shrinkage."
                if cash_diff_negative_days > cash_diff_count * 0.5
                else "Cash drawer tracking looks healthy."
            ),
            "total_drift": round(total_cash_diff, 2),
            "negative_days": cash_diff_negative_days,
            "total_days": cash_diff_count,
        })

    # 5. Cash variance streak detection — consecutive nights short
    streak_alert = None
    closes_by_date = sorted(
        [(dc.date, float(dc.cash_difference)) for dc in closes if dc.cash_difference is not None],
        key=lambda x: x[0],
    )

    if len(closes_by_date) >= 2:
        streaks = []
        cur_streak = []

        for d, diff in closes_by_date:
            if diff < 0:
                if not cur_streak:
                    cur_streak = [(d, diff)]
                else:
                    gap = (d - cur_streak[-1][0]).days
                    if gap <= 3:          # allow gaps for days the business is closed
                        cur_streak.append((d, diff))
                    else:
                        if len(cur_streak) >= 2:
                            streaks.append(list(cur_streak))
                        cur_streak = [(d, diff)]
            else:
                if len(cur_streak) >= 2:
                    streaks.append(list(cur_streak))
                cur_streak = []

        if len(cur_streak) >= 2:
            streaks.append(list(cur_streak))

        if streaks:
            latest = streaks[-1]
            s_len = len(latest)
            s_total = round(sum(diff for _, diff in latest), 2)
            s_start = latest[0][0].strftime("%-d %b")
            s_end = latest[-1][0].strftime("%-d %b")
            most_recent = closes_by_date[-1][0]
            is_active = (most_recent - latest[-1][0]).days <= 2

            if s_len >= 5:
                severity, icon = "critical", "\U0001f6a8"
                title = f"Cash short {s_len} nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} over {s_len} consecutive days "
                    f"({s_start}\u2013{s_end}). This pattern suggests systematic issues \u2014 "
                    "review camera footage, POS reconciliation, and cash handling procedures."
                )
            elif s_len >= 3:
                severity, icon = "warning", "\u26a0\ufe0f"
                title = f"Cash short {s_len} nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} from {s_start} to {s_end}. "
                    "Three or more consecutive shortages is a pattern worth investigating."
                )
            else:
                severity, icon = "info", "\U0001f4a1"
                title = "Cash short 2 nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} on {s_start} and {s_end}. "
                    "Might be coincidence, but keep an eye on it."
                )

            streak_alert = {
                "type": "cash_streak",
                "icon": icon,
                "title": title,
                "detail": detail,
                "severity": severity,
                "streak_length": s_len,
                "streak_total": s_total,
                "streak_start": latest[0][0].isoformat(),
                "streak_end": latest[-1][0].isoformat(),
                "is_active": is_active,
                "total_streaks": len(streaks),
            }
            insights.insert(0, streak_alert)

    # 4. Takeaway growth
    sorted_months = sorted(revenue_by_month.keys())
    if len(sorted_months) >= 2:
        curr = sorted_months[-1]
        prev = sorted_months[-2]
        curr_takeaway = takeaway_by_month.get(curr, 0)
        prev_takeaway = takeaway_by_month.get(prev, 0)
        curr_rev = revenue_by_month.get(curr, 0)
        prev_rev = revenue_by_month.get(prev, 0)
        if prev_takeaway > 0 and curr_rev > 0:
            growth = round(((curr_takeaway - prev_takeaway) / prev_takeaway) * 100)
            share_curr = round((curr_takeaway / curr_rev) * 100, 1) if curr_rev else 0
            share_prev = round((prev_takeaway / prev_rev) * 100, 1) if prev_rev else 0
            if growth != 0:
                insights.append({
                    "type": "takeaway_growth",
                    "icon": "📦",
                    "title": f"Takeaway {'grew' if growth > 0 else 'dropped'} {abs(growth)}% this month",
                    "detail": f"Now {share_curr}% of total sales vs {share_prev}% last month.",
                    "growth_pct": growth,
                    "current_share": share_curr,
                })

    summary = {
        "total_closes": count,
        "total_revenue": round(total_revenue, 2),
        "avg_daily_revenue": round(total_revenue / count, 2) if count else 0,
        "total_tips": round(total_tips, 2),
        "avg_daily_tips": round(total_tips / count, 2) if count else 0,
        "total_cash_difference": round(total_cash_diff, 2),
        "cash_streak": streak_alert,
    }

    return {"has_data": True, "insights": insights, "summary": summary}


# ─── GET — multi-branch daily summary ───

@router.get("/branch-summary")
def branch_summary(
    target_date: date = Query(None, alias="date"),
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cross-branch comparison: per-branch revenue, cash, tips for a date or range."""
    if target_date:
        from_date = to_date = target_date
    if not from_date:
        from_date = date.today() - timedelta(days=7)
    if not to_date:
        to_date = date.today()

    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date >= from_date,
            DailyClose.date <= to_date,
            DailyClose.is_deleted.isnot(True),
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    # Fetch branch names
    branches = db.query(Branch).filter(Branch.user_id == user.id, Branch.is_active.isnot(False)).all()
    branch_names = {str(b.id): b.name for b in branches}
    branch_names[None] = "No Branch"

    # Aggregate per branch
    per_branch = defaultdict(lambda: {
        "revenue_total": 0, "payment_total": 0, "cash_diff_total": 0,
        "tips_total": 0, "days_count": 0, "cash_diff_count": 0,
    })

    for dc in closes:
        bid = str(dc.branch_id) if dc.branch_id else None
        b = per_branch[bid]
        b["revenue_total"] += float(dc.revenue_total or 0)
        b["payment_total"] += float(dc.payment_total or 0)
        b["tips_total"] += float(dc.tips_total or 0)
        b["days_count"] += 1
        if dc.cash_difference is not None:
            b["cash_diff_total"] += float(dc.cash_difference)
            b["cash_diff_count"] += 1

    # Build response list
    results = []
    for bid, agg in per_branch.items():
        results.append({
            "branch_id": bid,
            "branch_name": branch_names.get(bid, bid or "Unknown"),
            "revenue_total": round(agg["revenue_total"], 2),
            "avg_daily_revenue": round(agg["revenue_total"] / agg["days_count"], 2) if agg["days_count"] else 0,
            "payment_total": round(agg["payment_total"], 2),
            "cash_diff_total": round(agg["cash_diff_total"], 2),
            "tips_total": round(agg["tips_total"], 2),
            "days_count": agg["days_count"],
        })

    # Sort by revenue descending (top performers first)
    results.sort(key=lambda x: x["revenue_total"], reverse=True)

    grand = {
        "revenue_total": round(sum(r["revenue_total"] for r in results), 2),
        "cash_diff_total": round(sum(r["cash_diff_total"] for r in results), 2),
        "tips_total": round(sum(r["tips_total"] for r in results), 2),
        "total_days": sum(r["days_count"] for r in results),
        "branch_count": len(results),
    }

    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "branches": results,
        "grand_total": grand,
    }


# ─── GET — prefill from real sales/expenses/cash data ───

@router.get("/prefill")
def prefill_daily_close(
    target_date: date = Query(default=None, alias="date"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Pull today's actual sales/expenses/cash to pre-fill the daily close form."""
    if not target_date:
        target_date = date.today()

    # ── Sales total + by payment method ──
    sales_q = db.query(Sale).filter(
        Sale.user_id == user.id,
        Sale.date == target_date,
        Sale.is_deleted.isnot(True),
        Sale.status == "completed",
    )
    if branch_id:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)

    sales_total = float(
        sales_q.with_entities(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    )
    sales_count = sales_q.count()

    payment_rows = (
        sales_q.with_entities(Sale.payment_method, func.sum(Sale.amount).label("total"))
        .group_by(Sale.payment_method)
        .all()
    )
    by_payment = {}
    for method, total in payment_rows:
        key = (method or "other").lower()
        if key == "kontant":
            key = "cash"
        elif key == "dankort":
            key = "card"
        by_payment[key] = by_payment.get(key, 0) + round(float(total), 2)

    # ── Sales by item_name (for revenue breakdown hints) ──
    item_rows = (
        sales_q.filter(Sale.item_name.isnot(None))
        .with_entities(Sale.item_name, func.sum(Sale.amount).label("total"))
        .group_by(Sale.item_name)
        .all()
    )
    by_item = {name: round(float(total), 2) for name, total in item_rows}

    # ── Expenses by category ──
    expense_q = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            Expense.date == target_date,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
        )
    )
    if branch_id:
        expense_q = expense_q.filter(Expense.branch_id == branch_id)

    expense_rows = expense_q.group_by(ExpenseCategory.name).all()
    by_expense_cat = {name: round(float(total), 2) for name, total in expense_rows}
    expenses_total = sum(by_expense_cat.values())

    expenses_count = db.query(func.count(Expense.id)).filter(
        Expense.user_id == user.id,
        Expense.date == target_date,
        Expense.is_deleted.isnot(True),
        Expense.is_personal.isnot(True),
    ).scalar() or 0

    # ── Cash transactions ──
    cash_q = db.query(CashTransaction).filter(
        CashTransaction.user_id == user.id,
        CashTransaction.date == target_date,
        CashTransaction.is_deleted.isnot(True),
    )
    if branch_id:
        cash_q = cash_q.filter(CashTransaction.branch_id == branch_id)

    cash_in = float(
        cash_q.filter(CashTransaction.type == "cash_in")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )
    cash_out = float(
        cash_q.filter(CashTransaction.type == "cash_out")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )

    has_data = sales_count > 0 or expenses_count > 0

    # Night shift cutoff from business profile
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    cutoff = getattr(profile, "day_cutoff_hour", 0) or 0

    return {
        "date": target_date.isoformat(),
        "has_data": has_data,
        "day_cutoff_hour": cutoff,
        "sales": {
            "total": sales_total,
            "count": sales_count,
            "by_payment_method": by_payment,
            "by_item": by_item,
        },
        "expenses": {
            "total": expenses_total,
            "count": expenses_count,
            "by_category": by_expense_cat,
        },
        "cash": {
            "total_in": cash_in,
            "total_out": cash_out,
            "net": round(cash_in - cash_out, 2),
        },
        "suggested_prefill": {
            "revenue_total": sales_total,
            "payment_breakdown": by_payment,
            "cash_expected": by_payment.get("cash", 0),
        },
    }


# ─── POST — scan Z-report image ───

@router.post("/scan-report")
@_limiter.limit("12/minute")
async def scan_z_report(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a Z-report / kasserapport photo and extract structured data via OCR.

    Multi-layer defense:
      L1 — auth (get_current_user dep).
      L2 — input bounds: content-type prefix check + 12MB size cap.
      L3 — rate limit (@_limiter.limit("12/minute") per IP). Tight
           because each call may run a Sonnet vision pass = real $.
      L4 — tenant scope: image bytes go to <user_id>/kasserapport/<sha>.jpg
           via the storage abstraction.
      L5 — daily quota: per-tier _SCAN_CAP_BY_PLAN — Free=5/day,
           Pro=50/day. Refuses 429 when exceeded so a script can't
           drain Anthropic spend even within a single rate-limit window.
      L6 — audit trail: the resulting DailyClose row carries the
           image_url + receipt_photo path for §10 retention.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    file_bytes = await file.read()
    # Size cap matches kasserapport extractor (12 MB) — same threshold
    # everywhere the user might upload an image.
    if len(file_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 12 MB)")

    # L5 — per-tier daily quota.
    plan = effective_plan(user) or "free"
    cap = _SCAN_CAP_BY_PLAN.get(plan, 5)
    used = _today_scan_count(db, user.id)
    if used >= cap:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily Z-report scan limit reached ({used}/{cap}). "
                "Upgrade or try again tomorrow."
            ),
        )

    # Save the image (Supabase or local fallback). kind="kasserapport"
    # routes the storage path to <user_id>/kasserapport/<sha>.jpg so Z-
    # report photos sit in their own namespace separate from per-receipt
    # photos on individual sales / expenses.
    image_url = save_receipt_photo(
        file_bytes,
        file.filename or "z_report.jpg",
        str(user.id),
        kind="kasserapport",
    )

    # Resolve the local path for OCR processing
    # save_receipt_photo returns either a Supabase URL or a local path
    if image_url.startswith("http"):
        # Image was uploaded to Supabase — local copy is in uploads/receipts/
        import time
        from pathlib import Path
        local_dir = Path("uploads/receipts")
        # Find the most recent file for this user (saved moments ago)
        candidates = sorted(local_dir.glob(f"{user.id}_*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
        if candidates:
            local_path = str(candidates[0])
        else:
            raise HTTPException(status_code=500, detail="Failed to save image for OCR processing")
    else:
        local_path = image_url

    # Parse the Z-report
    parsed = parse_z_report(local_path)
    parsed["image_url"] = image_url

    return parsed


# ─── GET — date-range PDF / CSV export (accountant handoff) ───
#
# These two endpoints aggregate a date range into a single document so
# the owner can hand off a week / month / quarter to the accountant in
# one click. Distinct from /{close_id}/pdf (single close, polished
# receipt) — this is the "weekly review" / "month-end" format with
# totals + averages.
#
# Path order: declared BEFORE /{close_id} so FastAPI matches the
# literal "export.pdf" / "export.csv" path before falling through to
# the parametric close_id.

# Hard-cap the date range to prevent both abuse and accidental
# unbounded queries. 366 covers leap years + a comfortable yearly
# review; anything longer should be done in chunks.
_MAX_RANGE_DAYS = 366


def _resolve_range(from_date: date | None, to_date: date | None) -> tuple[date, date]:
    """Validate + default the (from, to) inputs.

    Defaults: today minus 30 days → today.
    Raises 422 if from > to or the span exceeds _MAX_RANGE_DAYS.
    """
    if not to_date:
        to_date = date.today()
    if not from_date:
        from_date = to_date - timedelta(days=30)
    if from_date > to_date:
        raise HTTPException(
            status_code=422,
            detail="Invalid date range: 'from' must be on or before 'to'.",
        )
    span = (to_date - from_date).days + 1
    if span > _MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"Date range too large ({span} days). Max is {_MAX_RANGE_DAYS} days.",
        )
    return from_date, to_date


def _fetch_range_closes(
    db: Session, *, user_id, from_date: date, to_date: date,
    branch_id: str | None,
) -> list[DailyClose]:
    """Tenant-scoped fetch of closes in the requested range."""
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user_id,
        DailyClose.is_deleted.isnot(True),
        DailyClose.date >= from_date,
        DailyClose.date <= to_date,
    )
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)
    return q.order_by(DailyClose.date.asc()).all()


@router.get("/export.pdf")
@_limiter.limit("5/minute")
def export_range_pdf(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close PDF for accountant handoff.

    Layered defense (same shape as scan-report):
      L1 auth → L2 input bounds (max 366d) → L3 rate limit (5/min)
      L4 tenant scope (user_id filter) → L5 plan: free; this is read-only
      and trivially cheap, no Anthropic calls, so no quota beyond the
      rate limit. L6 the file is streamed not stored — no audit row.
    """
    f, t = _resolve_range(from_date, to_date)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    # Business name for the title page — falls back through profile, user,
    # then a generic label so the PDF always has something readable.
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = (
        (profile.business_name if profile and profile.business_name else None)
        or getattr(user, "business_name", None)
        or "Daily Close Report"
    )
    currency = user.currency or "DKK"

    pdf_bytes = build_daily_close_range_pdf(
        closes, from_date=f, to_date=t,
        business_name=business_name, currency=currency,
    )
    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.csv")
@_limiter.limit("10/minute")
def export_range_csv(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close CSV. UTF-8 + BOM + semicolon delimiter so
    Danish Excel opens it cleanly with Æ/Ø/Å intact. Encoded breakdown
    columns ("food:12400|drinks:5800") so the accountant can re-import
    or pivot in Excel."""
    f, t = _resolve_range(from_date, to_date)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )
    csv_bytes = closes_to_csv_bytes(closes)
    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


# ─── GET — single close ───

@router.get("/{close_id}")
def get_daily_close(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    return _to_response(dc)


# ─── GET — PDF Kasserapport ───

@router.get("/{close_id}/pdf")
def daily_close_pdf(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Kasserapport PDF — Copenhagen-clean format for accountant handover.

    Layout principles:
      - Generous whitespace (22mm margins)
      - No heavy black header bands; sections separated by hairline rules
      - Helvetica throughout; right-aligned numbers
      - Danish number format (1.234,56)
      - MOMS section explicit so accountant doesn't have to recompute
    """
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")

    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()

    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    # Copenhagen-clean palette
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    DANGER = colors.HexColor("#b91c1c")

    currency = user.currency or "DKK"

    def fmt(v):
        if v is None:
            return "—"
        # Danish number format: 1.234,56
        formatted = f"{float(v):,.2f}"
        return f"{formatted.replace(',', 'X').replace('.', ',').replace('X', '.')} {currency}"

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title="Kasserapport",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=2,
                        textColor=INK, fontName="Helvetica-Bold")
    h_period = ParagraphStyle("Period", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, alignment=TA_RIGHT)
    section_title = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8.5,
                                   textColor=MUTED, fontName="Helvetica-Bold",
                                   leading=12, spaceBefore=10, spaceAfter=4)
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=10.5,
                         textColor=INK, fontName="Helvetica", leading=14)
    val_r = ParagraphStyle("ValR", parent=val, alignment=TA_RIGHT)
    val_b = ParagraphStyle("ValB", parent=val, fontName="Helvetica-Bold")
    val_br = ParagraphStyle("ValBR", parent=val_b, alignment=TA_RIGHT)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    story = []

    # ─── Header: title + date ───
    head_table = Table(
        [[Paragraph("KASSERAPPORT", h1), Paragraph(dc.date.strftime("%d %B %Y"), h_period)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=4, spaceAfter=12))

    # ─── Voucher range for the day (Bogføringsloven 2024 audit trail) ───
    # If sales/expenses for this date have voucher_numbers, show min-max range
    # so accountant can cross-check the closes against the bilag list.
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense
        sale_vmin, sale_vmax = (
            db.query(func.min(Sale.voucher_number), func.max(Sale.voucher_number))
            .filter(
                Sale.user_id == user.id,
                Sale.date == dc.date,
                Sale.voucher_number.is_not(None),
                Sale.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
        exp_vmin, exp_vmax = (
            db.query(func.min(Expense.voucher_number), func.max(Expense.voucher_number))
            .filter(
                Expense.user_id == user.id,
                Expense.date == dc.date,
                Expense.voucher_number.is_not(None),
                Expense.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
    except Exception:  # noqa: BLE001
        sale_vmin = sale_vmax = exp_vmin = exp_vmax = None

    # ─── Business info ───
    biz_name = (profile.business_name if profile and profile.business_name
                else getattr(user, "business_name", None)) or "—"
    biz_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_name}</font>"]
    if profile:
        addr_parts = [p for p in [profile.address,
                                  " ".join(p for p in [getattr(profile, "zipcode", None),
                                                       getattr(profile, "city", None)] if p)]
                      if p]
        if addr_parts:
            biz_lines.append(f"<font color='#6b7280'>{', '.join(addr_parts)}</font>")
        if getattr(profile, "org_number", None):
            biz_lines.append(f"<font color='#6b7280'>CVR {profile.org_number}</font>")
    if dc.closed_by:
        biz_lines.append(f"<font color='#6b7280'>Closed by: {dc.closed_by}</font>")
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * mm))

    # ─── Revenue Breakdown ───
    rev = decode_breakdown(dc.revenue_categories)
    if rev:
        story.append(Paragraph("REVENUE BREAKDOWN", section_title))
        rows = []
        for k, v in rev.items():
            rows.append([Paragraph(k.title(), val), Paragraph(fmt(v), val_r)])
        rows.append([Paragraph("Total revenue", val_b),
                     Paragraph(fmt(float(dc.revenue_total or 0)), val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── MOMS / VAT (added — was missing in old PDF) ───
    if dc.moms_total is not None or dc.revenue_ex_moms is not None:
        story.append(Paragraph("MOMS BREAKDOWN", section_title))
        moms_rows = [
            [Paragraph("Revenue (incl. Moms)", val), Paragraph(fmt(float(dc.revenue_total or 0)), val_r)],
            [Paragraph("Moms (output VAT)", val), Paragraph(fmt(float(dc.moms_total or 0)), val_r)],
            [Paragraph("Revenue (excl. Moms)", val_b),
             Paragraph(fmt(float(dc.revenue_ex_moms or 0)), val_br)],
        ]
        t = Table(moms_rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        if dc.moms_mode == "manual":
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph("Moms entered manually by closer.", foot))

    # ─── Payment Methods ───
    pay = decode_breakdown(dc.payment_categories)
    if pay:
        story.append(Paragraph("PAYMENT METHODS", section_title))
        rows = []
        for k, v in pay.items():
            rows.append([Paragraph(k.replace("_", " ").title(), val), Paragraph(fmt(v), val_r)])
        rows.append([Paragraph("Total payments", val_b),
                     Paragraph(fmt(float(dc.payment_total or 0)), val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── Cash Drawer ───
    if dc.cash_counted is not None:
        story.append(Paragraph("CASH DRAWER", section_title))
        diff = float(dc.cash_difference or 0)
        diff_style = ParagraphStyle("Diff", parent=val_br,
                                    textColor=DANGER if abs(diff) > 100 else INK)
        rows = [
            [Paragraph("Expected (from receipts)", val), Paragraph(fmt(dc.cash_expected), val_r)],
            [Paragraph("Counted", val), Paragraph(fmt(dc.cash_counted), val_r)],
            [Paragraph("Difference", val_b), Paragraph(fmt(dc.cash_difference), diff_style)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── Tips ───
    if dc.tips_total:
        story.append(Paragraph("TIPS", section_title))
        rows = [
            [Paragraph("Total tips", val), Paragraph(fmt(dc.tips_total), val_r)],
            [Paragraph("Staff count", val),
             Paragraph(str(dc.tips_staff_count or "—"), val_r)],
            [Paragraph("Per person", val_b), Paragraph(fmt(dc.tips_per_person), val_br)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(
            "Tips must be reported via eIndkomst. Share with your lønsystem.",
            foot,
        ))

    # ─── Bilagsnummer audit trail (DK Bogføringsloven 2024) ───
    if currency == "DKK" and (sale_vmin or exp_vmin):
        story.append(Paragraph("BILAGSNUMMER", section_title))
        rows = []
        if sale_vmin and sale_vmax:
            label = (f"S-{dc.date.year}-{sale_vmin:04d} → S-{dc.date.year}-{sale_vmax:04d}"
                     if sale_vmin != sale_vmax
                     else f"S-{dc.date.year}-{sale_vmin:04d}")
            rows.append([Paragraph("Sales vouchers", val), Paragraph(label, val_r)])
        if exp_vmin and exp_vmax:
            label = (f"E-{dc.date.year}-{exp_vmin:04d} → E-{dc.date.year}-{exp_vmax:04d}"
                     if exp_vmin != exp_vmax
                     else f"E-{dc.date.year}-{exp_vmin:04d}")
            rows.append([Paragraph("Expense vouchers", val), Paragraph(label, val_r)])
        if rows:
            t = Table(rows, colWidths=[110 * mm, 56 * mm])
            t.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(t)

    # ─── Notes ───
    if dc.notes:
        story.append(Paragraph("NOTES", section_title))
        story.append(Paragraph(dc.notes, val))

    # ─── Footer ───
    story.append(Spacer(1, 14 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=4))
    closed_time = dc.closed_at.strftime("%d/%m/%Y %H:%M") if dc.closed_at else "—"
    story.append(Paragraph(
        f"Generated by BonBox · Closed {closed_time} · "
        f"Use this report alongside your accounting software.",
        foot,
    ))

    doc.build(story)
    buf.seek(0)
    filename = f"kasserapport_{dc.date.isoformat()}.pdf"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─── DELETE — soft delete ───

@router.delete("/{close_id}", status_code=204)
def delete_daily_close(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    dc.is_deleted = True
    dc.deleted_at = datetime.utcnow()
    db.commit()
