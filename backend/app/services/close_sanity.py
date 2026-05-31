"""close_sanity — last-second guard before a daily close commits.

Why this exists (May 2026):
  The 4-layer kasserapport extractor is rigorous, but a confidently-
  wrong amount silently saved costs real money. Real-world failure
  mode at Mirabelle: closer scans 4 slips, validator passes all 4,
  one slip's "Total" was misread as 2.234 instead of 22.340 because
  the dot was a smudge. Owner taps Send → 20K kr quietly missing.

  This service is the calm last guard. Before commit:
    • Compare today's pre-commit total to the recent baseline.
    • If today is dramatically lower OR higher than the band, return
      a flag with a human-readable reason.
    • Frontend renders a soft "double-check" dialog. Owner taps
      "Yes, send" or "Let me check."

  Detection is purely deterministic (no LLM) — a percentage rule
  applied to recent daily totals. Conservative thresholds tuned to
  catch real misreads (>40% drop, >100% spike) without firing on
  honest quiet days.

Multi-layer:
  • Tenant-scoped: lookback queries filter on user_id.
  • Read-only: never writes anything; the close itself is committed
    by the caller.
  • Fail-closed: if anything fails, returns "ok" — we'd rather miss
    a flag than block the close.
  • Floors on tiny baselines: if recent_avg < 100 kr (brand-new
    venue), we don't fire spurious "below average" warnings.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.daily_close import DailyClose
from app.models.sale import Sale
from app.models.user import User

logger = logging.getLogger("bonbox.close_sanity")


# How many recent days form the baseline. 56 (8 weeks) yields up to ~8
# same-weekday samples — enough for a stable per-weekday mean. (14 was too
# short: at most 2 same-weekday days, so the n>=2 floor below almost never
# had data and the guard silently no-opped for close-driven businesses.)
BASELINE_LOOKBACK_DAYS = 56

# Minimum baseline for flags to fire. New accounts and quiet venues
# can have sub-100 kr days where percentage rules become noisy.
MIN_BASELINE_KR = 100.0

# Thresholds. Tuned conservatively: a 40% under-baseline flag fires
# rarely on real data but reliably catches a misread digit. Spikes
# are less common (you can sell more, not less than nothing) so the
# upper threshold is wider.
LOW_PCT = 0.40    # ≥40% below baseline
HIGH_PCT = 1.00   # ≥100% above baseline


def _per_date_revenue(
    db: Session, *, user: User, today: date,
) -> dict[date, float]:
    """Per-date revenue across the lookback, PREFERRING the DailyClose total
    (the source of truth for close-driven businesses) and falling back to the
    Sale-row sum on days that have no close.

    WHY both sources: close-only cafés have NO Sale rows, so a Sale-only
    baseline was always empty and the guard never fired for exactly the
    users it protects (caught in live testing — a 1.070 kr close that the UI
    itself flagged "99% below" still locked silently). Tenant-scoped;
    excludes today and soft-deleted rows. Draft + confirmed closes both
    count — both represent a real day's takings.
    """
    cutoff = today - timedelta(days=BASELINE_LOOKBACK_DAYS)
    by_date: dict[date, float] = {}

    # 1. Closes (draft + confirmed) — the real day totals.
    try:
        close_rows = (
            db.query(DailyClose.date, DailyClose.revenue_total)
            .filter(
                DailyClose.user_id == user.id,
                DailyClose.date >= cutoff,
                DailyClose.date < today,
                DailyClose.is_deleted.isnot(True),
            )
            .all()
        )
        for d, rev in close_rows:
            if d is not None and rev is not None:
                # Multiple closes on a date (e.g. branches) → keep the largest.
                by_date[d] = max(by_date.get(d, 0.0), float(rev or 0))
    except Exception as exc:  # noqa: BLE001 — closes are best-effort enrichment
        logger.warning("close_sanity close baseline read failed: %s", exc)

    # 2. Sale sums for dates WITHOUT a close (sale-driven days).
    sale_rows = (
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= cutoff,
            Sale.date < today,
            Sale.is_deleted.isnot(True),
            Sale.is_void.isnot(True),
            Sale.is_manager_void.isnot(True),
        )
        .group_by(Sale.date)
        .all()
    )
    for d, total in sale_rows:
        if d is not None and d not in by_date and total is not None:
            by_date[d] = float(total or 0)

    return by_date


def _baseline_avg(
    db: Session,
    *,
    user: User,
    today: date,
    weekday: int,
) -> tuple[float, int, str]:
    """Baseline average daily revenue, preferring same-weekday days (so a
    quiet Sunday isn't compared to a busy Friday). Falls back to an all-days
    baseline when same-weekday history is too thin (<2 days) so businesses
    with sparse same-weekday data still get a misread caught.

    Returns (avg, n_days, basis) where basis is "weekday" | "overall" | "none".
    """
    by_date = _per_date_revenue(db, user=user, today=today)
    same_wd = [v for d, v in by_date.items() if d.weekday() == weekday and v > 0]
    if len(same_wd) >= 2:
        return (sum(same_wd) / len(same_wd), len(same_wd), "weekday")
    # Fallback: all positive-revenue days (need a few for a stable mean).
    all_days = [v for v in by_date.values() if v > 0]
    if len(all_days) >= 3:
        return (sum(all_days) / len(all_days), len(all_days), "overall")
    return (0.0, len(all_days), "none")


def check_close_anomaly(
    db: Session,
    *,
    user: User,
    today: date,
    today_total: float,
) -> dict[str, Any]:
    """Compare today's pending close total against recent same-weekday
    baseline. Returns:
      {
        ok: bool,                  # True = no flag, safe to commit
        flagged: bool,             # True = surface a "double-check" dialog
        reason: "low" | "high" | None,
        today_total: float,
        baseline_avg: float,
        baseline_days: int,        # how many days informed the baseline
        delta_pct: float | None,   # signed pct vs. baseline (None if no baseline)
        message: str               # human-readable summary
      }
    """
    try:
        weekday = today.weekday()
        avg, n, basis = _baseline_avg(db, user=user, today=today, weekday=weekday)
    except Exception as exc:  # noqa: BLE001
        logger.warning("close_sanity baseline failed: %s", exc)
        return {
            "ok": True, "flagged": False, "reason": None,
            "today_total": float(today_total),
            "baseline_avg": 0.0, "baseline_days": 0,
            "delta_pct": None,
            "message": "",
        }

    payload = {
        "ok": True, "flagged": False, "reason": None,
        "today_total": float(today_total),
        "baseline_avg": round(avg, 2),
        "baseline_days": n,
        "delta_pct": None,
        "message": "",
    }

    # No useful baseline → don't flag (brand-new account, or fewer than
    # 2 same-weekday + 3 overall days of history → basis == "none").
    if basis == "none" or avg < MIN_BASELINE_KR:
        return payload

    delta_pct = (today_total - avg) / avg if avg > 0 else 0.0
    payload["delta_pct"] = round(delta_pct, 3)

    if delta_pct <= -LOW_PCT:
        payload["ok"] = False
        payload["flagged"] = True
        payload["reason"] = "low"
        pct = int(abs(delta_pct) * 100)
        payload["message"] = (
            f"Today's total ({int(today_total):,} kr) is {pct}% below your "
            f"usual {int(avg):,} kr for this weekday. "
            "Make sure all terminals were scanned and totals look right."
        )
    elif delta_pct >= HIGH_PCT:
        payload["ok"] = False
        payload["flagged"] = True
        payload["reason"] = "high"
        pct = int(delta_pct * 100)
        payload["message"] = (
            f"Today's total ({int(today_total):,} kr) is {pct}% above your "
            f"usual {int(avg):,} kr for this weekday. "
            "If that's right, send away — otherwise check for a misread amount."
        )
    return payload
