"""
Customer Retention Service — repeat rate, churn detection, CLV, recency analysis.

Works with Khata customers (credit/debit transactions) as the customer base.
Falls back to aggregate sales patterns when no Khata data exists.

Multi-layer defense: every sub-function wraps its own work in try/except so
a single bad customer row or NULL transaction date doesn't tank the whole
report. Bad rows are skipped and logged, not silently mis-counted.
"""

import logging
from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func, and_, case, distinct
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.khata import KhataCustomer, KhataTransaction

log = logging.getLogger("bonbox.retention_service")


def get_retention_insights(user_id: str, db: Session) -> dict:
    """Full customer retention analysis."""
    today = date.today()
    d30 = today - timedelta(days=30)
    d60 = today - timedelta(days=60)
    d90 = today - timedelta(days=90)

    # ─── Khata customer metrics ───
    customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user_id, KhataCustomer.is_deleted.isnot(True))
        .all()
    )

    customer_profiles = []
    active_count = 0
    at_risk_count = 0
    churned_count = 0
    total_clv = 0

    for cust in customers:
        try:
            txns = (
                db.query(KhataTransaction)
                .filter(KhataTransaction.customer_id == cust.id)
                .order_by(KhataTransaction.date.desc())
                .all()
            )
        except Exception as e:
            log.warning("retention: txn query failed for customer %s: %s", cust.id, e)
            continue
        if not txns:
            continue

        # Filter out rows with bad/NULL dates — defensive against schema drift
        valid_txns = [t for t in txns if t.date is not None and t.amount is not None]
        if not valid_txns:
            continue

        try:
            # Transaction stats — coerce to safe defaults
            total_spent = sum(float(t.amount or 0) for t in valid_txns if t.type == "credit")
            total_paid = sum(float(t.amount or 0) for t in valid_txns if t.type == "debit")
            txn_count = len(valid_txns)
            first_txn = min(t.date for t in valid_txns)
            last_txn = max(t.date for t in valid_txns)
            days_since_last = (today - last_txn).days
            lifetime_days = max((last_txn - first_txn).days, 1)
        except Exception as e:
            log.warning("retention: stat calc failed for customer %s: %s", cust.id, e)
            continue

        # Frequency: average days between transactions
        if txn_count >= 2:
            avg_gap = lifetime_days / (txn_count - 1)
        else:
            avg_gap = lifetime_days if lifetime_days > 0 else 30

        # Status classification
        if days_since_last <= 30:
            status = "active"
            active_count += 1
        elif days_since_last <= 60:
            status = "at_risk"
            at_risk_count += 1
        else:
            status = "churned"
            churned_count += 1

        # Simple CLV: avg monthly spend * 12
        months_active = max(lifetime_days / 30, 1)
        monthly_avg = total_spent / months_active
        clv = round(monthly_avg * 12, 2)
        total_clv += clv

        balance = round(total_spent - total_paid, 2)

        profile = {
            "id": str(cust.id),
            "name": cust.name,
            "phone": cust.phone,
            "status": status,
            "total_spent": round(total_spent, 2),
            "total_paid": round(total_paid, 2),
            "balance": balance,
            "txn_count": txn_count,
            "first_visit": str(first_txn),
            "last_visit": str(last_txn),
            "days_since_last": days_since_last,
            "avg_gap_days": round(avg_gap, 1),
            "clv": clv,
            "monthly_avg": round(monthly_avg, 2),
        }
        customer_profiles.append(profile)

    # Sort by CLV descending
    customer_profiles.sort(key=lambda x: x["clv"], reverse=True)

    total_customers = len(customer_profiles)
    retention_rate = round(active_count / total_customers * 100, 1) if total_customers else 0
    churn_rate = round(churned_count / total_customers * 100, 1) if total_customers else 0

    # ─── Aggregate sales trends (for non-Khata overview) ───
    try:
        cur_sales = db.query(func.count(Sale.id), func.coalesce(func.sum(Sale.amount), 0)).filter(
            Sale.user_id == user_id, Sale.date >= d30, Sale.is_deleted.isnot(True)
        ).first()
        prev_sales = db.query(func.count(Sale.id), func.coalesce(func.sum(Sale.amount), 0)).filter(
            Sale.user_id == user_id, Sale.date >= d60, Sale.date < d30, Sale.is_deleted.isnot(True)
        ).first()

        cur_txn_count = int(cur_sales[0] or 0)
        prev_txn_count = int(prev_sales[0] or 0)
        cur_rev = float(cur_sales[1] or 0)
        prev_rev = float(prev_sales[1] or 0)

        txn_trend = round(((cur_txn_count - prev_txn_count) / prev_txn_count * 100), 1) if prev_txn_count else 0
        rev_trend = round(((cur_rev - prev_rev) / prev_rev * 100), 1) if prev_rev else 0
    except Exception as e:
        log.warning("retention: aggregate sales query failed: %s", e)
        cur_txn_count = prev_txn_count = 0
        cur_rev = prev_rev = 0.0
        txn_trend = rev_trend = 0

    # ─── Cohort: monthly new vs returning (via Khata) ───
    try:
        monthly_cohort = _build_monthly_cohort(user_id, db, today)
    except Exception as e:
        log.warning("retention: cohort build failed: %s", e)
        monthly_cohort = []

    # ─── Alerts ───
    try:
        alerts = _generate_retention_alerts(
            total_customers, active_count, at_risk_count, churned_count,
            retention_rate, churn_rate, customer_profiles, txn_trend,
        )
    except Exception as e:
        log.warning("retention: alert generation failed: %s", e)
        alerts = []

    return {
        "total_customers": total_customers,
        "active_customers": active_count,
        "at_risk_customers": at_risk_count,
        "churned_customers": churned_count,
        "retention_rate": retention_rate,
        "churn_rate": churn_rate,
        "avg_clv": round(total_clv / total_customers, 2) if total_customers else 0,
        "total_clv": round(total_clv, 2),
        "txn_trend_pct": txn_trend,
        "rev_trend_pct": rev_trend,
        "current_month_txns": cur_txn_count,
        "prev_month_txns": prev_txn_count,
        "top_customers": customer_profiles[:10],
        "at_risk_list": [c for c in customer_profiles if c["status"] == "at_risk"][:10],
        "churned_list": [c for c in customer_profiles if c["status"] == "churned"][:10],
        "monthly_cohort": monthly_cohort,
        "alerts": alerts,
    }


def _build_monthly_cohort(user_id: str, db: Session, today: date) -> list:
    """Build 6-month cohort: new customers vs returning each month."""
    cohort = []
    seen_ids = set()

    for i in range(5, -1, -1):
        month_start = (today.replace(day=1) - timedelta(days=i * 30)).replace(day=1)
        if i > 0:
            month_end = (month_start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        else:
            month_end = today

        txns = (
            db.query(KhataTransaction.customer_id)
            .join(KhataCustomer, KhataTransaction.customer_id == KhataCustomer.id)
            .filter(
                KhataCustomer.user_id == user_id,
                KhataTransaction.date >= month_start,
                KhataTransaction.date <= month_end,
            )
            .distinct()
            .all()
        )
        customer_ids = {str(t[0]) for t in txns}
        new_count = len(customer_ids - seen_ids)
        returning_count = len(customer_ids & seen_ids)
        seen_ids |= customer_ids

        cohort.append({
            "month": month_start.strftime("%b %Y"),
            "new": new_count,
            "returning": returning_count,
            "total": new_count + returning_count,
        })

    return cohort


def _generate_retention_alerts(
    total, active, at_risk, churned,
    retention_rate, churn_rate, profiles, txn_trend,
):
    alerts = []

    if churn_rate > 30 and total >= 5:
        alerts.append({
            "type": "high_churn", "severity": "warning", "icon": "🚨",
            "title": f"High churn rate: {churn_rate}%",
            "detail": f"{churned} of {total} customers haven't returned in 60+ days.",
            "action": "Consider reaching out with promotions or loyalty offers.",
        })

    if at_risk > 0:
        names = ", ".join(c["name"] for c in profiles if c["status"] == "at_risk")[:80]
        alerts.append({
            "type": "at_risk", "severity": "warning", "icon": "⚠️",
            "title": f"{at_risk} customers at risk of churning",
            "detail": f"Last visited 30-60 days ago: {names}",
            "action": "Send a personal message or offer to bring them back.",
        })

    if retention_rate >= 70 and total >= 5:
        alerts.append({
            "type": "healthy_retention", "severity": "positive", "icon": "💚",
            "title": f"Strong retention: {retention_rate}%",
            "detail": f"{active} of {total} customers active in last 30 days.",
            "action": None,
        })

    if txn_trend < -20:
        alerts.append({
            "type": "txn_decline", "severity": "warning", "icon": "📉",
            "title": f"Transaction volume down {abs(txn_trend)}%",
            "detail": "Fewer transactions vs last month. Could indicate customer drop-off.",
            "action": "Check if seasonal or investigate customer feedback.",
        })
    elif txn_trend > 20:
        alerts.append({
            "type": "txn_growth", "severity": "positive", "icon": "📈",
            "title": f"Transactions up {txn_trend}%!",
            "detail": "More customer activity compared to last month.",
            "action": None,
        })

    top_customers = [c for c in profiles if c["clv"] > 0][:3]
    if top_customers:
        names = ", ".join(c["name"] for c in top_customers)
        alerts.append({
            "type": "vip", "severity": "info", "icon": "👑",
            "title": f"Top customers: {names}",
            "detail": f"Your highest-value customers by lifetime spend. Keep them happy!",
            "action": "Consider a VIP reward or personal thank-you.",
        })

    if not alerts:
        if total == 0:
            alerts.append({
                "type": "no_data", "severity": "info", "icon": "📊",
                "title": "No customer data yet",
                "detail": "Add customers in Khata to unlock retention analytics.",
                "action": "Go to Khata and start tracking your regular customers.",
            })
        else:
            alerts.append({
                "type": "healthy", "severity": "positive", "icon": "✅",
                "title": "Customer retention looks healthy",
                "detail": "No major issues detected.",
                "action": None,
            })

    return alerts
