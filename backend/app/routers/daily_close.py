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

import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict
from io import BytesIO

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
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
from app.services.receipt_ocr import save_receipt_photo, parse_z_report

router = APIRouter()


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
    }


# ─── POST — submit daily close ───

@router.post("")
def create_daily_close(
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

    revenue_total = sum((data.revenue_breakdown or {}).values())
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
    )
    db.add(dc)
    db.commit()
    db.refresh(dc)
    return _to_response(dc)


# ─── POST — unlock a confirmed daily close ───

@router.post("/{close_id}/unlock")
def unlock_daily_close(
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
async def scan_z_report(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Upload a Z-report / kasserapport photo and extract structured data via OCR."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    file_bytes = await file.read()
    if len(file_bytes) > 10 * 1024 * 1024:  # 10 MB limit
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

    # Save the image (Supabase or local fallback)
    image_url = save_receipt_photo(file_bytes, file.filename or "z_report.jpg", str(user.id))

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
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=15 * mm,
                            leftMargin=20 * mm, rightMargin=20 * mm)
    styles = getSampleStyleSheet()
    story = []

    currency = user.currency or "DKK"
    fmt = lambda v: f"{v:,.2f} {currency}" if v is not None else "—"

    # Title
    title_style = ParagraphStyle("Title", parent=styles["Title"], fontSize=18, spaceAfter=4)
    story.append(Paragraph("Kasserapport / Daily Close", title_style))

    # Business info
    biz_name = profile.business_name if profile else (user.business_name if hasattr(user, "business_name") else "")
    if biz_name:
        story.append(Paragraph(biz_name, styles["Heading3"]))
    if profile:
        addr_parts = [p for p in [profile.address, profile.zipcode, profile.city] if p]
        if addr_parts:
            story.append(Paragraph(", ".join(addr_parts), styles["Normal"]))
        if profile.org_number:
            story.append(Paragraph(f"CVR: {profile.org_number}", styles["Normal"]))

    story.append(Paragraph(f"Date: {dc.date.strftime('%d %B %Y')}", styles["Normal"]))
    if dc.closed_by:
        story.append(Paragraph(f"Closed by: {dc.closed_by}", styles["Normal"]))
    story.append(Spacer(1, 8 * mm))

    # Revenue breakdown
    rev = decode_breakdown(dc.revenue_categories)
    if rev:
        story.append(Paragraph("Revenue Breakdown", styles["Heading2"]))
        rev_data = [["Category", "Amount"]]
        for k, v in rev.items():
            rev_data.append([k.title(), fmt(v)])
        rev_data.append(["TOTAL", fmt(float(dc.revenue_total or 0))])
        t = Table(rev_data, colWidths=[100 * mm, 60 * mm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 6 * mm))

    # Payment breakdown
    pay = decode_breakdown(dc.payment_categories)
    if pay:
        story.append(Paragraph("Payment Methods", styles["Heading2"]))
        pay_data = [["Method", "Amount"]]
        for k, v in pay.items():
            pay_data.append([k.title(), fmt(v)])
        pay_data.append(["TOTAL", fmt(float(dc.payment_total or 0))])
        t = Table(pay_data, colWidths=[100 * mm, 60 * mm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 6 * mm))

    # Cash drawer
    if dc.cash_counted is not None:
        story.append(Paragraph("Cash Drawer", styles["Heading2"]))
        diff_color = colors.red if (dc.cash_difference or 0) < -100 else colors.black
        drawer_data = [
            ["Expected", fmt(dc.cash_expected)],
            ["Counted", fmt(dc.cash_counted)],
            ["Difference", fmt(dc.cash_difference)],
        ]
        t = Table(drawer_data, colWidths=[100 * mm, 60 * mm])
        t.setStyle(TableStyle([
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("TEXTCOLOR", (1, -1), (1, -1), diff_color),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 6 * mm))

    # Tips
    if dc.tips_total:
        story.append(Paragraph("Tips", styles["Heading2"]))
        tips_data = [
            ["Total Tips", fmt(dc.tips_total)],
            ["Staff Count", str(dc.tips_staff_count or "—")],
            ["Per Person", fmt(dc.tips_per_person)],
        ]
        t = Table(tips_data, colWidths=[100 * mm, 60 * mm])
        t.setStyle(TableStyle([
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(
            "<i>Note: Tips must be reported via eIndkomst. Share this data with your accountant.</i>",
            ParagraphStyle("Note", parent=styles["Normal"], fontSize=8, textColor=colors.grey),
        ))
        story.append(Spacer(1, 6 * mm))

    # Notes
    if dc.notes:
        story.append(Paragraph("Notes", styles["Heading2"]))
        story.append(Paragraph(dc.notes, styles["Normal"]))
        story.append(Spacer(1, 6 * mm))

    # Footer
    story.append(HRFlowable(width="100%", color=colors.grey))
    story.append(Spacer(1, 3 * mm))
    closed_time = dc.closed_at.strftime("%d/%m/%Y %H:%M") if dc.closed_at else "—"
    story.append(Paragraph(f"Generated from BonBox · Closed at {closed_time}", styles["Normal"]))

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
