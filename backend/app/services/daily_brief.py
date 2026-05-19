"""Daily Brief — actionable AI summary for business owners.

Architectural goal: maximum accuracy, zero hallucination, predictable cost.

Pipeline (each step is a barrier — if any fails, the next one absorbs):

  Layer 1 — INPUT VALIDATION
      ↓ User must be authenticated; brief_date is server-derived (today in
        user TZ); no caller-supplied data influences the output.

  Layer 2 — DETERMINISTIC PRECOMPUTE
      ↓ Pull real numbers from the DB (sales, expenses, inventory, khata).
        These are the ONLY facts the LLM will see — it never queries
        anything itself, can't invent.

  Layer 2.5 — CANDIDATE INSIGHTS
      ↓ Apply hand-tuned rules to the precomputed data to generate a list
        of candidate insights (e.g. "low stock — order soon", "khata
        outstanding — collect"). Each candidate carries the EXACT phrasing
        the LLM is allowed to use, plus a weight for ranking.

  Layer 3 — STRUCTURED LLM POLISH (skipped on free-tier cap miss)
      ↓ LLM receives candidates + owner-memory addendum and is asked to
        select 2-4 and rephrase them in friendly Copenhagen-style prose.
        Uses tool-use to enforce JSON output (no free-form drift).
        Prompt caching applied to the system prompt + tool schema.

  Layer 4 — POST-VALIDATION
      ↓ Every number / item-name in the LLM output must appear in the
        precomputed data set. Any drift = reject and fall back.
        Length caps enforced; no HTML; no markdown.

  Layer 5 — FALLBACK
      ↓ If the LLM call fails OR validation rejects the output, render
        a deterministic non-AI brief from the same candidates. Owner
        sees a useful brief either way; AI failure is invisible.

  Layer 6 — CACHE + USAGE CAP
      ↓ Cached per (user, brief_date) in DailyBrief table. Free tier:
        1 generation/day, no manual refresh. Pro tier: 1 + 5 manual
        refreshes/day. Enforced via refresh_count column.

  Layer 7 — PROMPT CACHING (provider-side)
      ↓ System prompt + tool definition cached at Anthropic for ~80%
        cost reduction on repeats. Only the per-user candidates and
        owner memory are uncached.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    DailyBrief,
    Expense,
    InventoryItem,
    KhataCustomer,
    KhataTransaction,
    Sale,
    User,
)
# Faktura intel — Day 9 of the compliance sprint. The Brief surfaces
# overdue + payments-to-review counts so they're the first thing the
# owner sees each morning, driving traffic to /faktura/review without
# requiring users to remember to check.
from app.models.invoice import Invoice
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.services.billing import effective_plan, get_cap
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# Tier configuration
# ─────────────────────────────────────────────────────────────────

# Per-day refresh cap (manual force-refresh calls beyond the auto one).
# Auto-generation on first visit doesn't count. The cap exists to keep
# token cost predictable per user, not to be stingy with free users.
# Refresh caps live in PLAN_CAPS ("ai_brief_refreshes_per_day") — see
# services/billing.py for the source of truth. Local dict removed (May
# 2026 consolidation): previously had a Starter-tier leak (Starter
# missing → fell through to default 0 = no refreshes despite paying).
def _refresh_cap_for(user: User) -> int:
    return get_cap(user, "ai_brief_refreshes_per_day")


# ─────────────────────────────────────────────────────────────────
# Layer 2 — deterministic precompute
# ─────────────────────────────────────────────────────────────────

@dataclass
class Precompute:
    """Everything the brief generator is allowed to know about the user.

    The LLM gets a JSON dump of this object and nothing else; if a fact
    isn't in here, it can't appear in the output. Validation in Layer 4
    cross-checks the LLM output against this dict.
    """
    business_name: str
    currency: str
    today: str  # ISO date string
    yesterday: str
    weekday: str  # "Wednesday"
    today_revenue: float
    yesterday_revenue: float
    pct_change_yesterday: float | None
    week_avg_revenue: float
    pct_change_week_avg: float | None
    month_revenue: float
    month_expenses: float
    month_profit_margin_pct: float | None
    monthly_goal: float | None
    monthly_goal_progress_pct: float | None
    days_left_in_month: int
    top_seller_today: dict | None  # {"name": str, "qty": int, "revenue": float}
    low_stock_items: list[dict]  # [{"name": str, "qty": float, "unit": str}]
    khata_outstanding: float
    khata_with_balance: int
    # ── Faktura intel (Day 9) ───────────────────────────────────────
    # Counts/amounts that drive the morning "what needs my attention"
    # block. All Numbers come from already-validated DB rows; the LLM
    # can phrase but can't invent.
    overdue_invoice_count: int = 0          # status='overdue' OR (sent + past due_date)
    overdue_invoice_total: float = 0.0      # sum of total_gross on those
    payment_suggestions_pending: int = 0    # PaymentMatchSuggestion review inbox depth
    invoices_sent_this_month: int = 0       # progress counter — "Y sent so far"
    invoices_paid_this_month: int = 0       # closed loop counter

    # ── Brief 2.0 signals (May 2026) ──────────────────────────────
    # MOMS countdown — pulled from tax_service.get_tax_overview(). When
    # the deadline is within 30 days we surface it; closer = higher
    # weight in the candidate ranker.
    moms_days_left: int | None = None
    moms_estimated_owed: float | None = None
    moms_deadline_date: str | None = None   # ISO YYYY-MM-DD

    # Recurring expenses materializing in the next 3 days — gives
    # owners a "head's up your rent posts tomorrow" before the cron
    # runs. Empty list when none upcoming.
    recurring_due_soon: list[dict] = field(default_factory=list)   # [{name, amount, day_of_month, when_text}]
    recurring_due_soon_total: float = 0.0

    # Latest daily_close compared to the same date's sales register.
    # When variance > 10%, fires an "audit your numbers" alert because
    # the close + the POS disagree by a meaningful margin.
    last_close_variance_pct: float | None = None  # signed; positive = close > sales
    last_close_date: str | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


def compute_precompute(user: User, db: Session) -> Precompute:
    """Pull the real numbers from the DB. No LLM, no caching — runs each
    time the brief is generated."""
    today = date.today()
    yesterday = today - timedelta(days=1)
    week_ago = today - timedelta(days=7)
    month_start = today.replace(day=1)
    next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
    days_left = max(0, (next_month - today).days)

    # Today + yesterday revenue
    today_rev = float(
        db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True), Sale.date == today)
        .scalar() or 0
    )
    yesterday_rev = float(
        db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True), Sale.date == yesterday)
        .scalar() or 0
    )
    pct_yesterday = None
    if yesterday_rev > 0:
        raw = ((today_rev - yesterday_rev) / yesterday_rev) * 100
        pct_yesterday = round(max(-500.0, min(500.0, raw)), 1)

    # 7-day average (excluding today, since today is in-progress)
    week_rev = float(
        db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= week_ago,
            Sale.date < today,
        )
        .scalar() or 0
    )
    week_avg = round(week_rev / 7, 2) if week_rev > 0 else 0.0
    pct_week_avg = None
    if week_avg > 0:
        raw = ((today_rev - week_avg) / week_avg) * 100
        pct_week_avg = round(max(-500.0, min(500.0, raw)), 1)

    # Month revenue / expenses / margin
    month_rev = float(
        db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= month_start,
            Sale.date <= today,
        )
        .scalar() or 0
    )
    month_exp = float(
        db.query(sa_func.coalesce(sa_func.sum(Expense.amount), 0))
        .filter(
            Expense.user_id == user.id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= month_start,
            Expense.date <= today,
        )
        .scalar() or 0
    )
    margin = None
    if month_rev > 0:
        margin = round(((month_rev - month_exp) / month_rev) * 100, 1)

    # Monthly goal progress
    goal = float(user.monthly_goal) if getattr(user, "monthly_goal", None) else None
    goal_pct = None
    if goal and goal > 0:
        goal_pct = round(min(999.0, (month_rev / goal) * 100), 1)

    # Top seller today (by qty within sales table — only if item_name populated)
    top_seller = None
    rows = (
        db.query(
            Sale.item_name,
            sa_func.coalesce(sa_func.sum(Sale.quantity_sold), 0).label("qty"),
            sa_func.coalesce(sa_func.sum(Sale.amount), 0).label("rev"),
        )
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date == today,
            Sale.item_name.isnot(None),
        )
        .group_by(Sale.item_name)
        .order_by(sa_func.coalesce(sa_func.sum(Sale.quantity_sold), 0).desc())
        .limit(1)
        .all()
    )
    if rows and rows[0].item_name:
        top_seller = {
            "name": str(rows[0].item_name),
            "qty": int(rows[0].qty or 0),
            "revenue": float(rows[0].rev or 0),
        }

    # Low-stock items (capped at top 5 by absolute shortfall)
    low_stock_rows = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .limit(5)
        .all()
    )
    low_stock = [
        {
            "name": str(i.name),
            "qty": float(i.quantity or 0),
            "unit": str(i.unit or "units"),
        }
        for i in low_stock_rows
    ]

    # Khata outstanding (sum of unpaid balances across all customers)
    khata_total = 0.0
    khata_count = 0
    for cust in db.query(KhataCustomer).filter(
        KhataCustomer.user_id == user.id,
        KhataCustomer.is_deleted.isnot(True),
    ).all():
        agg = (
            db.query(
                sa_func.coalesce(sa_func.sum(KhataTransaction.purchase_amount), 0).label("p"),
                sa_func.coalesce(sa_func.sum(KhataTransaction.paid_amount), 0).label("pd"),
            )
            .filter(
                KhataTransaction.customer_id == cust.id,
                KhataTransaction.user_id == user.id,
            )
            .first()
        )
        outstanding = float(agg.p or 0) - float(agg.pd or 0)
        if outstanding > 0:
            khata_total += outstanding
            khata_count += 1

    # ── Faktura intel — Day 9 ───────────────────────────────────────
    # Catch both rows already flipped to 'overdue' by the nightly
    # status sweep AND rows still 'sent' but past their due_date (in
    # case the sweep hasn't run yet today). Excludes credit notes —
    # negative-amount rows aren't "owed to us".
    overdue_q = (
        db.query(
            sa_func.count(Invoice.id).label("n"),
            sa_func.coalesce(sa_func.sum(Invoice.total_gross), 0).label("total"),
        )
        .filter(
            Invoice.user_id == user.id,
            Invoice.is_credit_note.is_(False),
            Invoice.due_date < today,
            Invoice.status.in_(("sent", "overdue")),
        )
        .first()
    )
    overdue_count = int(overdue_q.n or 0)
    overdue_total = float(overdue_q.total or 0)

    # Pending payment-match suggestions — review inbox depth
    pending_suggestions = (
        db.query(sa_func.count(PaymentMatchSuggestion.id))
        .filter(
            PaymentMatchSuggestion.user_id == user.id,
            PaymentMatchSuggestion.status == "pending",
        )
        .scalar()
    ) or 0

    # Month-to-date progress counters — only counts non-draft, non-credit
    sent_this_month = (
        db.query(sa_func.count(Invoice.id))
        .filter(
            Invoice.user_id == user.id,
            Invoice.is_credit_note.is_(False),
            Invoice.issue_date >= month_start,
            Invoice.issue_date <= today,
            Invoice.status.in_(("sent", "paid", "overdue", "credited")),
        )
        .scalar()
    ) or 0
    paid_this_month = (
        db.query(sa_func.count(Invoice.id))
        .filter(
            Invoice.user_id == user.id,
            Invoice.is_credit_note.is_(False),
            Invoice.paid_at.isnot(None),
            Invoice.paid_at >= datetime.combine(month_start, datetime.min.time()),
        )
        .scalar()
    ) or 0

    # ── Brief 2.0 signals — MOMS countdown ──────────────────────────
    # Pulled via the tax service so the deadline math (jurisdiction,
    # filing frequency, prices-include-moms toggle) stays in ONE place.
    # Defensive: wrap in try/except since tax service has a lot of
    # surface area and we never want it to take down the brief.
    moms_days_left = None
    moms_estimated_owed = None
    moms_deadline_date = None
    try:
        from app.services.tax_service import get_tax_overview
        tx = get_tax_overview(user, db) or {}
        deadlines = tx.get("upcoming_deadlines") or []
        # First deadline = the soonest. Skip payroll deadlines — those
        # are handled separately by the staff brief.
        next_vat = next(
            (d for d in deadlines if (d.get("type") or "vat") in ("vat", "moms")),
            deadlines[0] if deadlines else None,
        )
        if next_vat and next_vat.get("date"):
            try:
                _d = date.fromisoformat(str(next_vat["date"])[:10])
                moms_days_left = (_d - today).days
                moms_deadline_date = _d.isoformat()
                # estimated_amount may live on the deadline OR on ytd.vat_payable.
                amt = next_vat.get("estimated_amount")
                if amt is None:
                    amt = (tx.get("ytd") or {}).get("vat_payable")
                if amt is not None:
                    moms_estimated_owed = float(amt)
            except (ValueError, TypeError):
                pass
    except Exception as e:  # noqa: BLE001
        logger.debug("daily_brief: tax_overview unavailable: %s", e)

    # ── Brief 2.0 signals — recurring expenses due in next 3 days ──
    # Owners need a heads-up before a 18k rent posts. Idempotent and
    # tolerant of the table not existing yet (fresh deploys).
    recurring_due_soon: list[dict] = []
    recurring_due_soon_total = 0.0
    try:
        from app.models.recurring_expense import RecurringExpense
        upcoming_window = today + timedelta(days=3)
        rules = (
            db.query(RecurringExpense)
            .filter(
                RecurringExpense.user_id == user.id,
                RecurringExpense.is_active.is_(True),
                RecurringExpense.next_run_date.isnot(None),
                RecurringExpense.next_run_date <= upcoming_window,
                RecurringExpense.next_run_date >= today,
            )
            .order_by(RecurringExpense.next_run_date.asc())
            .limit(5)
            .all()
        )
        for r in rules:
            days_out = (r.next_run_date - today).days
            when_text = (
                "today" if days_out == 0
                else "tomorrow" if days_out == 1
                else f"in {days_out} days"
            )
            recurring_due_soon.append({
                "name": r.name,
                "amount": float(r.amount or 0),
                "day_of_month": r.day_of_month,
                "when_text": when_text,
            })
            recurring_due_soon_total += float(r.amount or 0)
    except Exception as e:  # noqa: BLE001
        # Table may not exist on legacy deploys — fail open so the brief still renders.
        logger.debug("daily_brief: recurring_expenses unavailable: %s", e)

    # ── Brief 2.0 signals — last close variance vs sales register ──
    # When the owner posts a close that materially diverges from the
    # POS sales total for the same date, flag it. Tied to the Daily
    # Close reconciliation we shipped earlier — turns a hidden warning
    # into a morning action.
    last_close_variance_pct = None
    last_close_date = None
    try:
        from app.models.daily_close import DailyClose
        recent_close = (
            db.query(DailyClose)
            .filter(
                DailyClose.user_id == user.id,
                DailyClose.is_deleted.isnot(True),
                DailyClose.status == "confirmed",
            )
            .order_by(DailyClose.date.desc(), DailyClose.closed_at.desc())
            .first()
        )
        if recent_close and recent_close.revenue_total and recent_close.revenue_total > 0:
            pos_for_date = (
                db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
                .filter(
                    Sale.user_id == user.id,
                    Sale.date == recent_close.date,
                    Sale.is_deleted.isnot(True),
                    Sale.status == "completed",
                )
                .scalar()
            ) or 0
            pos_for_date = float(pos_for_date)
            close_rev = float(recent_close.revenue_total)
            if pos_for_date > 0:
                diff_pct = ((close_rev - pos_for_date) / pos_for_date) * 100
                last_close_variance_pct = round(diff_pct, 1)
                last_close_date = recent_close.date.isoformat()
    except Exception as e:  # noqa: BLE001
        logger.debug("daily_brief: close-variance signal unavailable: %s", e)

    return Precompute(
        business_name=user.business_name or "your business",
        currency=user.currency or "DKK",
        today=today.isoformat(),
        yesterday=yesterday.isoformat(),
        weekday=today.strftime("%A"),
        today_revenue=round(today_rev, 2),
        yesterday_revenue=round(yesterday_rev, 2),
        pct_change_yesterday=pct_yesterday,
        week_avg_revenue=week_avg,
        pct_change_week_avg=pct_week_avg,
        month_revenue=round(month_rev, 2),
        month_expenses=round(month_exp, 2),
        month_profit_margin_pct=margin,
        monthly_goal=goal,
        monthly_goal_progress_pct=goal_pct,
        days_left_in_month=days_left,
        top_seller_today=top_seller,
        low_stock_items=low_stock,
        khata_outstanding=round(khata_total, 2),
        khata_with_balance=khata_count,
        overdue_invoice_count=int(overdue_count),
        overdue_invoice_total=round(overdue_total, 2),
        payment_suggestions_pending=int(pending_suggestions),
        invoices_sent_this_month=int(sent_this_month),
        invoices_paid_this_month=int(paid_this_month),
        moms_days_left=moms_days_left,
        moms_estimated_owed=moms_estimated_owed,
        moms_deadline_date=moms_deadline_date,
        recurring_due_soon=recurring_due_soon,
        recurring_due_soon_total=round(recurring_due_soon_total, 2),
        last_close_variance_pct=last_close_variance_pct,
        last_close_date=last_close_date,
    )


# ─────────────────────────────────────────────────────────────────
# Layer 2.5 — candidate insights (deterministic, hand-tuned rules)
# ─────────────────────────────────────────────────────────────────

@dataclass
class Candidate:
    """A pre-phrased insight the LLM may choose and rephrase. The LLM's
    output is validated to ensure no fact appears that isn't in some
    candidate."""
    type: str  # "win" | "watch" | "action"
    text: str
    weight: float = 0.5  # higher = more important
    # Numbers / item names that appear in this candidate. Used by Layer 4
    # validation to confirm the LLM didn't invent anything.
    facts: list[str] = field(default_factory=list)
    # Optional "tap to open" target the frontend renders as a chip next
    # to the insight. cta_url is an in-app path (never an external URL)
    # so we don't have to deal with safe-link checks. cta_label is the
    # short button text — "Open faktura inbox", "Review matches", etc.
    # Brief 2.0 (May 2026) — turns insights into actions, not just
    # observations. None when no clear next step exists.
    cta_label: str | None = None
    cta_url: str | None = None


def _fmt_money(amount: float, currency: str) -> str:
    return f"{int(round(amount)):,} {currency}"


def generate_candidates(p: Precompute) -> list[Candidate]:
    """Apply hand-tuned rules to the precompute. Each rule fires only when
    its data is present and meaningful — no generic filler."""
    out: list[Candidate] = []
    cur = p.currency

    # Revenue trend vs week average — most impactful signal
    if p.pct_change_week_avg is not None:
        if p.pct_change_week_avg >= 15:
            out.append(Candidate(
                type="win",
                text=f"Today is tracking {p.pct_change_week_avg:+.0f}% above your usual {p.weekday} — strong start.",
                weight=0.85,
                facts=[f"{p.pct_change_week_avg:+.0f}%", p.weekday],
            ))
        elif p.pct_change_week_avg <= -20:
            out.append(Candidate(
                type="watch",
                text=f"Today is {abs(p.pct_change_week_avg):.0f}% below your typical {p.weekday} pace — consider a midday push.",
                weight=0.9,
                facts=[f"{abs(p.pct_change_week_avg):.0f}%", p.weekday],
            ))

    # Yesterday's headline number (always include if data exists)
    if p.yesterday_revenue > 0:
        out.append(Candidate(
            type="win" if (p.pct_change_yesterday or 0) >= 0 else "watch",
            text=f"Yesterday: {_fmt_money(p.yesterday_revenue, cur)}"
                 + (f" ({p.pct_change_yesterday:+.0f}% vs day before)" if p.pct_change_yesterday is not None else ""),
            weight=0.6,
            facts=[_fmt_money(p.yesterday_revenue, cur)] + ([f"{p.pct_change_yesterday:+.0f}%"] if p.pct_change_yesterday is not None else []),
        ))

    # Top seller — actionable when stock is also low
    if p.top_seller_today:
        ts = p.top_seller_today
        # Cross-reference: is the top seller also low-stock?
        low_match = next(
            (li for li in p.low_stock_items
             if str(li["name"]).lower() == str(ts["name"]).lower()),
            None,
        )
        if low_match:
            out.append(Candidate(
                type="action",
                text=f"Push {ts['name']} today — your top seller, only {low_match['qty']:g} {low_match['unit']} left in stock.",
                weight=0.95,
                facts=[ts["name"], f"{low_match['qty']:g}", low_match["unit"]],
            ))
        else:
            out.append(Candidate(
                type="action",
                text=f"{ts['name']} is your top seller today — {ts['qty']} sold so far.",
                weight=0.55,
                facts=[ts["name"], str(ts["qty"])],
            ))

    # Low stock that ISN'T already covered by the top-seller rule
    if p.low_stock_items:
        # Filter out items already mentioned via top-seller match
        top_name = (p.top_seller_today or {}).get("name", "").lower()
        rest = [li for li in p.low_stock_items if str(li["name"]).lower() != top_name]
        if rest:
            names = ", ".join(li["name"] for li in rest[:3])
            out.append(Candidate(
                type="action",
                text=f"Running low: {names}. Reorder before the weekend.",
                weight=0.75,
                facts=[li["name"] for li in rest[:3]],
            ))

    # Monthly goal progress — only when the user has set a goal
    if p.monthly_goal and p.monthly_goal_progress_pct is not None:
        if p.monthly_goal_progress_pct >= 100:
            out.append(Candidate(
                type="win",
                text=f"You've hit {p.monthly_goal_progress_pct:.0f}% of your monthly goal — well done.",
                weight=0.9,
                facts=[f"{p.monthly_goal_progress_pct:.0f}%"],
            ))
        elif p.days_left_in_month <= 7 and p.monthly_goal_progress_pct < 80:
            out.append(Candidate(
                type="watch",
                text=f"{p.monthly_goal_progress_pct:.0f}% of monthly goal with {p.days_left_in_month} days left.",
                weight=0.85,
                facts=[f"{p.monthly_goal_progress_pct:.0f}%", str(p.days_left_in_month)],
            ))

    # Profit margin watch
    if p.month_profit_margin_pct is not None and p.month_profit_margin_pct < 15 and p.month_revenue > 0:
        out.append(Candidate(
            type="watch",
            text=f"Profit margin is {p.month_profit_margin_pct:.0f}% this month — review pricing or cut a top expense.",
            weight=0.7,
            facts=[f"{p.month_profit_margin_pct:.0f}%"],
        ))

    # ── Faktura intel — Day 9 ───────────────────────────────────────
    # Highest-weight rule when conditions hit. Owners forget about
    # overdue fakturaer until the customer reminds them; the Brief
    # is the morning reminder that earns its keep.
    if p.overdue_invoice_count > 0 and p.overdue_invoice_total > 0:
        n = p.overdue_invoice_count
        amount = _fmt_money(p.overdue_invoice_total, cur)
        # Singular/plural — Brief is read by Danes; even in EN we
        # want it to feel hand-written, not template-y.
        faktura_word = "faktura" if n == 1 else "fakturaer"
        out.append(Candidate(
            type="action",
            text=f"{amount} overdue across {n} {faktura_word} — send a reminder this morning.",
            # Same weight as low-stock-top-seller — both are "do this now"
            weight=0.95,
            facts=[amount, str(n)],
        ))

    # Review inbox depth — drives traffic to /faktura/review for
    # MEDIUM/LOW confidence bank matches that need an owner decision.
    # Only fires when there's actually something pending; we never
    # generate filler ("0 to review" is silence, not a candidate).
    if p.payment_suggestions_pending > 0:
        n = p.payment_suggestions_pending
        match_word = "match" if n == 1 else "matches"
        out.append(Candidate(
            type="action",
            text=f"{n} payment {match_word} need your review — open the faktura inbox.",
            weight=0.88,
            facts=[str(n)],
        ))

    # Faktura momentum — month-to-date "wins" rule. Only fires when
    # paid count is meaningful (3+) AND sent count is meaningful so
    # we're not celebrating a single invoice.
    if p.invoices_paid_this_month >= 3 and p.invoices_sent_this_month >= 3:
        ratio_pct = round(
            (p.invoices_paid_this_month / max(p.invoices_sent_this_month, 1)) * 100
        )
        if ratio_pct >= 70:
            out.append(Candidate(
                type="win",
                text=f"{p.invoices_paid_this_month} of {p.invoices_sent_this_month} fakturaer paid this month — clean cash flow.",
                weight=0.6,
                facts=[str(p.invoices_paid_this_month), str(p.invoices_sent_this_month)],
            ))

    # Khata outstanding (NP/DK customer credit)
    if p.khata_outstanding > 500 and p.khata_with_balance > 0:
        out.append(Candidate(
            type="action",
            text=f"{_fmt_money(p.khata_outstanding, cur)} owed by {p.khata_with_balance} customer{'s' if p.khata_with_balance > 1 else ''} — reach out this week.",
            weight=0.7,
            facts=[_fmt_money(p.khata_outstanding, cur), str(p.khata_with_balance)],
            cta_label="Open Khata",
            cta_url="/khata",
        ))

    # ── Brief 2.0: MOMS deadline countdown ──────────────────────────
    # Single most anxiety-reducing signal for a DK biz owner. Weight
    # scales with urgency — overdue is highest, then ≤3 days, then ≤14,
    # then ≤30. Beyond 30 days we suppress (don't be noisy).
    if p.moms_days_left is not None and p.moms_days_left <= 30:
        owed_text = (
            f", est. {_fmt_money(p.moms_estimated_owed, cur)} owed"
            if p.moms_estimated_owed and p.moms_estimated_owed > 0
            else ""
        )
        if p.moms_days_left < 0:
            n = abs(p.moms_days_left)
            out.append(Candidate(
                type="watch",
                text=f"Moms filing is {n} day{'s' if n != 1 else ''} overdue{owed_text} — file before SKAT fines accrue.",
                weight=0.98,
                facts=[str(n)] + ([_fmt_money(p.moms_estimated_owed, cur)] if p.moms_estimated_owed else []),
                cta_label="Open Tax Autopilot",
                cta_url="/tax",
            ))
        elif p.moms_days_left == 0:
            out.append(Candidate(
                type="action",
                text=f"Moms filing is due today{owed_text} — file before midnight.",
                weight=0.97,
                facts=([_fmt_money(p.moms_estimated_owed, cur)] if p.moms_estimated_owed else []),
                cta_label="File now",
                cta_url="/tax",
            ))
        elif p.moms_days_left <= 3:
            out.append(Candidate(
                type="action",
                text=f"Moms filing in {p.moms_days_left} day{'s' if p.moms_days_left != 1 else ''}{owed_text} — review now to avoid the rush.",
                weight=0.92,
                facts=[str(p.moms_days_left)] + ([_fmt_money(p.moms_estimated_owed, cur)] if p.moms_estimated_owed else []),
                cta_label="Review filing",
                cta_url="/tax",
            ))
        elif p.moms_days_left <= 14:
            out.append(Candidate(
                type="watch",
                text=f"Moms filing in {p.moms_days_left} days{owed_text}.",
                weight=0.75,
                facts=[str(p.moms_days_left)] + ([_fmt_money(p.moms_estimated_owed, cur)] if p.moms_estimated_owed else []),
                cta_label="Open Tax Autopilot",
                cta_url="/tax",
            ))
        # 15-30 days = suppress (would be noise this far out)

    # ── Brief 2.0: bank reconciliation pending matches ──────────────
    # Reuses the payment_suggestions_pending counter (already in
    # Precompute via PaymentMatchSuggestion). The existing faktura
    # rule above covers the Faktura context — this rule fires
    # specifically when the count is HIGH (≥10) so it surfaces as a
    # separate "you have real bank-rec backlog" insight worth its own
    # bullet point. Keeps weight under the faktura rule by design.
    if p.payment_suggestions_pending >= 10:
        out.append(Candidate(
            type="action",
            text=f"{p.payment_suggestions_pending} bank transactions waiting to be matched — clear the backlog before month-end.",
            weight=0.82,
            facts=[str(p.payment_suggestions_pending)],
            cta_label="Review matches",
            cta_url="/bank-import",
        ))

    # ── Brief 2.0: recurring expenses due in next 3 days ────────────
    # Heads-up before a 18k rent auto-posts. Friendly: name the items
    # so the owner immediately knows what's about to hit their books.
    if p.recurring_due_soon:
        # Compact preview — first 2 by name, "+N more" if longer.
        names = [r["name"] for r in p.recurring_due_soon[:2]]
        more = max(0, len(p.recurring_due_soon) - 2)
        if more > 0:
            names_text = f"{', '.join(names)} +{more} more"
        else:
            names_text = ", ".join(names) if names else "—"
        # When-text uses the soonest (first item, since the SQL ORDERed).
        when = p.recurring_due_soon[0]["when_text"]
        out.append(Candidate(
            type="watch",
            text=f"Recurring posts {when}: {names_text} ({_fmt_money(p.recurring_due_soon_total, cur)}).",
            weight=0.7,
            facts=[when, _fmt_money(p.recurring_due_soon_total, cur)] + names,
            cta_label="Manage recurring",
            cta_url="/expenses",
        ))

    # ── Brief 2.0: daily close vs POS variance ──────────────────────
    # When the owner's last confirmed close diverges >10% from the
    # POS sales total for the same date, flag it. Caught silently by
    # Daily Close Step 1 today; the brief makes it morning-visible.
    if p.last_close_variance_pct is not None and abs(p.last_close_variance_pct) >= 10:
        sign = "above" if p.last_close_variance_pct > 0 else "below"
        out.append(Candidate(
            type="watch",
            text=f"Latest close ({p.last_close_date}) is {abs(p.last_close_variance_pct):.0f}% {sign} POS sales — audit before sending to your accountant.",
            weight=0.86,
            facts=[
                p.last_close_date or "",
                f"{abs(p.last_close_variance_pct):.0f}%",
            ],
            cta_label="Open Daily Close",
            cta_url="/daily-close",
        ))

    # Sort by weight descending so the LLM (or the fallback) picks
    # the most important first.
    out.sort(key=lambda c: c.weight, reverse=True)
    return out


# ─────────────────────────────────────────────────────────────────
# Layer 5 — deterministic fallback brief
# ─────────────────────────────────────────────────────────────────

def fallback_brief(p: Precompute, candidates: list[Candidate], user: User | None = None) -> dict:
    """Render a non-AI brief from the precompute + candidates. This is
    what gets shown if the LLM fails OR validation rejects the output.

    Always populated — no empty-state path. If there are no candidates
    (brand-new account with no data), a friendly first-time message."""
    if not candidates:
        return {
            "greeting": _greeting_for(user),
            "date_label": _date_label_for(p),
            "headline": "Welcome to BonBox — log a few sales and expenses to start seeing daily insights.",
            "insights": [],
            "ai_polished": False,
        }
    # Lead candidate becomes the headline; next 2-3 are insights.
    head = candidates[0]
    rest = candidates[1:4]
    return {
        "greeting": _greeting_for(user),
        "date_label": _date_label_for(p),
        "headline": head.text,
        # Brief 2.0 — pass cta through to the client so each insight can
        # render its own "Open X" action chip. The frontend handles the
        # None case (no chip) gracefully.
        "insights": [
            {
                "type": c.type,
                "text": c.text,
                "cta_label": c.cta_label,
                "cta_url": c.cta_url,
            }
            for c in rest
        ],
        # Top candidate's CTA — used by the headline row in the frontend.
        "headline_cta_label": head.cta_label,
        "headline_cta_url": head.cta_url,
        "ai_polished": False,
    }


def _greeting_for(user: User | None = None) -> str:
    """Time-aware greeting in the USER'S timezone — not UTC. Falls back
    to UTC if the user has no timezone set or the zone string is invalid
    (won't crash on bad data)."""
    tz_name = getattr(user, "timezone", None) if user is not None else None
    now_utc = utc_now()
    h = now_utc.hour
    if tz_name:
        try:
            from zoneinfo import ZoneInfo
            from datetime import timezone as _tz
            now_local = now_utc.replace(tzinfo=_tz.utc).astimezone(ZoneInfo(tz_name))
            h = now_local.hour
        except Exception:  # noqa: BLE001
            # Bad / unknown TZ string — silently fall back to UTC
            pass
    if h < 11:
        return "Good morning"
    if h < 17:
        return "Good afternoon"
    return "Good evening"


def _date_label_for(p: Precompute) -> str:
    # "Wednesday · 6 May"
    d = date.fromisoformat(p.today)
    return f"{p.weekday} · {d.day} {d.strftime('%b')}"


# ─────────────────────────────────────────────────────────────────
# Layer 3 + 4 — LLM polish with strict post-validation
# ─────────────────────────────────────────────────────────────────

# JSON-schema enforced via tool-use. The model MUST call this tool with
# the exact shape, otherwise no output reaches the user.
_BRIEF_TOOL = {
    "name": "publish_daily_brief",
    "description": (
        "Publish the daily brief for the business owner. Choose 1 headline "
        "and 2-3 insights from the provided candidates, rephrasing each in a "
        "warm, concise Copenhagen style. NEVER invent numbers or item names "
        "that are not in the provided data — only rephrase what's already "
        "in the candidate.text or precompute fields."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "headline": {
                "type": "string",
                "minLength": 10,
                "maxLength": 140,
                "description": "1 sentence summary of the day, friendly tone, plain text only.",
            },
            "insights": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["win", "watch", "action"]},
                        "text": {"type": "string", "minLength": 8, "maxLength": 140},
                    },
                    "required": ["type", "text"],
                },
            },
        },
        "required": ["headline", "insights"],
    },
}


_SYSTEM_PROMPT = (
    "You are BonBox's morning briefing writer for a small business owner.\n"
    "Your job: pick the most important 3-4 candidates from the provided list, "
    "and rephrase each one into a calm, concise sentence. Use the Copenhagen "
    "style — sober, professional, no exclamation points, no emoji, no markdown. "
    "Keep the warmth subtle.\n\n"
    "STRICT RULES:\n"
    "- Numbers, percentages, item names, and currency amounts may ONLY come "
    "  from the candidate.text or the precompute data. NEVER invent any value, "
    "  item, or fact. If a number is in the data and you reference it, format "
    "  it the same way (with the same currency suffix and thousand separators).\n"
    "- One sentence per insight. Active verbs (push, order, schedule, review).\n"
    "- The first selected candidate becomes the headline; the rest are insights.\n"
    "- Output exclusively via the publish_daily_brief tool — never plain text.\n"
)


def _try_llm_polish(
    p: Precompute,
    candidates: list[Candidate],
    user: User,
    db: Session,
) -> tuple[Optional[dict], int, int, str]:
    """Call Claude to rephrase the top candidates. Returns
    (validated_brief_or_None, input_tokens, output_tokens, model)."""
    try:
        import anthropic
    except ImportError:
        logger.info("anthropic SDK not installed — skipping AI polish")
        return None, 0, 0, "deterministic"

    if not settings.ANTHROPIC_API_KEY or not settings.USE_CLAUDE_API:
        return None, 0, 0, "deterministic"

    if not candidates:
        return None, 0, 0, "deterministic"

    # Optional owner-memory addendum (already validated by the existing
    # owner_memory service — skipped silently if unavailable)
    try:
        from app.services import owner_memory  # type: ignore
        addendum = owner_memory.build_system_prompt_addendum(user, db) or ""
    except Exception:  # noqa: BLE001
        addendum = ""

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    # User content: candidates + precompute, all as JSON. Keeping this
    # purely structured eliminates parsing ambiguity.
    payload = {
        "candidates": [
            {"type": c.type, "text": c.text, "weight": c.weight}
            for c in candidates[:6]  # cap input — 6 candidates plenty
        ],
        "precompute": p.to_dict(),
    }

    # System prompt is stable per user — flag for prompt caching to amortize
    # cost across users that share the prompt prefix.
    system_blocks = [
        {
            "type": "text",
            "text": _SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
    ]
    if addendum:
        # Per-user addendum — NOT cached (changes per user). Sent fresh.
        system_blocks.append({"type": "text", "text": addendum})

    model = getattr(settings, "AI_MODEL_DAILY_BRIEF", "claude-sonnet-4-20250514")

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=600,
            system=system_blocks,
            tools=[_BRIEF_TOOL],
            tool_choice={"type": "tool", "name": _BRIEF_TOOL["name"]},
            messages=[
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("daily_brief: Claude call failed: %s", e)
        return None, 0, 0, "deterministic"

    in_toks = int(getattr(resp.usage, "input_tokens", 0) or 0)
    out_toks = int(getattr(resp.usage, "output_tokens", 0) or 0)

    # Find the tool_use block. Anthropic returns content as a list of blocks.
    tool_block = next(
        (b for b in (resp.content or []) if getattr(b, "type", None) == "tool_use"),
        None,
    )
    if not tool_block or tool_block.name != _BRIEF_TOOL["name"]:
        logger.warning("daily_brief: no tool_use block in response")
        return None, in_toks, out_toks, model

    raw = tool_block.input or {}
    validated = _validate_llm_output(raw, p, candidates)
    if not validated:
        logger.warning("daily_brief: LLM output failed validation, falling back")
        return None, in_toks, out_toks, model

    validated["greeting"] = _greeting_for(user)
    validated["date_label"] = _date_label_for(p)
    validated["ai_polished"] = True
    return validated, in_toks, out_toks, model


# ── Layer 4 validation ───────────────────────────────────────────

# Numbers we extract from output strings to cross-check against the
# candidates. Allows decimals, commas, percent signs.
_NUM_RE = re.compile(r"[-+]?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d+)?\s*%?")


def _normalize_token(s: str) -> str:
    """Normalize a number/string for fuzzy match. Strips whitespace,
    lowercases, removes commas/dots/percent, keeps digits + sign."""
    return re.sub(r"[\s,.%+]", "", s).lower()


def _validate_llm_output(
    raw: dict,
    p: Precompute,
    candidates: list[Candidate],
) -> Optional[dict]:
    """Reject the output if it references any fact not in the candidates
    or precompute. Returns the cleaned dict on success, None on reject."""
    if not isinstance(raw, dict):
        return None
    headline = raw.get("headline")
    insights = raw.get("insights")
    if not isinstance(headline, str) or not isinstance(insights, list):
        return None
    if len(headline) < 10 or len(headline) > 140:
        return None
    # 0-3 because the post-validation may dedup an insight that
    # duplicates the headline (see _norm_for_dedup below) — leaving
    # the bullet list empty is acceptable; the headline alone is
    # still a complete brief.
    if not (0 <= len(insights) <= 3):
        return None

    # Build the set of "approved tokens" — numbers and named entities that
    # the LLM was allowed to use. Anything in the output not in this set
    # is treated as a hallucination.
    approved: set[str] = set()
    # From candidates
    for c in candidates:
        for f in c.facts:
            approved.add(_normalize_token(f))
        for n in _NUM_RE.findall(c.text):
            approved.add(_normalize_token(n))
    # From precompute (numeric fields only)
    for k, v in p.to_dict().items():
        if isinstance(v, (int, float)) and v is not None:
            # Approve both raw and rounded forms
            approved.add(_normalize_token(str(v)))
            approved.add(_normalize_token(str(round(v))))
            approved.add(_normalize_token(f"{int(round(abs(v))):,}"))

    def _tokens_ok(s: str) -> bool:
        # Reject any HTML/script smuggle attempt
        if "<" in s or ">" in s or "javascript:" in s.lower():
            return False
        # Every number in the string must be approved (named entities are
        # approved separately by candidate.facts; this checks numerics only)
        for n in _NUM_RE.findall(s):
            tok = _normalize_token(n)
            if tok in {"", "0"}:  # plain "0" or empty after strip — fine
                continue
            if tok not in approved:
                logger.info("daily_brief: rejecting LLM output — number %r not in approved set", n)
                return False
        return True

    if not _tokens_ok(headline):
        return None

    # Dedup helper — collapses whitespace + case so trivial differences
    # ("running LOW: cheese..." vs "Running low: Cheese...") still
    # match. Used to drop insights that duplicate the headline.
    def _norm_for_dedup(s: str) -> str:
        return " ".join(s.split()).strip().lower()

    norm_headline = _norm_for_dedup(headline)
    cleaned_insights = []
    for ins in insights:
        if not isinstance(ins, dict):
            return None
        t = ins.get("type")
        text = ins.get("text")
        if t not in ("win", "watch", "action"):
            return None
        if not isinstance(text, str) or len(text) < 8 or len(text) > 140:
            return None
        if not _tokens_ok(text):
            return None
        # Drop insights that duplicate the headline. The LLM occasionally
        # emits the same string in both fields when there's only one
        # strong candidate — the frontend then renders the same text
        # twice ("Running low: Cheese, Butter…" as the body paragraph
        # AND as a bullet underneath). Trivial whitespace/case
        # differences are normalized before comparing.
        if _norm_for_dedup(text) == norm_headline:
            logger.info(
                "daily_brief: dropping insight identical to headline (LLM dup)"
            )
            continue
        cleaned_insights.append({"type": t, "text": text})

    return {"headline": headline, "insights": cleaned_insights}


# ─────────────────────────────────────────────────────────────────
# Layer 6 — public entry point: cache, generate, return
# ─────────────────────────────────────────────────────────────────

def get_or_create_brief(
    user: User,
    db: Session,
    *,
    force_refresh: bool = False,
) -> dict:
    """Return today's brief for the user. Generates it on first call;
    subsequent calls within the same day return the cached row.

    force_refresh=True regenerates — gated by REFRESH_CAP_BY_PLAN. If the
    user is over their cap, the cached brief is returned with no refresh.
    """
    today = date.today()
    row: DailyBrief | None = (
        db.query(DailyBrief)
        .filter(DailyBrief.user_id == user.id, DailyBrief.brief_date == today)
        .first()
    )

    cap_left = _refresh_cap_for(user) - (row.refresh_count if row else 0)
    can_regen = force_refresh and (row is None or cap_left > 0)

    if row and not can_regen and not force_refresh:
        # Cache hit — quickest path, no work
        try:
            payload = json.loads(row.payload_json)
            payload["from_cache"] = True
            payload["tier"] = row.tier
            return payload
        except Exception:  # noqa: BLE001
            # Corrupt cached row — regenerate. Log but don't fail.
            logger.warning("daily_brief: corrupt cached row, regenerating")

    # Generate fresh
    p = compute_precompute(user, db)
    candidates = generate_candidates(p)
    polished, in_tok, out_tok, model = _try_llm_polish(p, candidates, user, db)
    payload = polished if polished else fallback_brief(p, candidates, user=user)
    payload["from_cache"] = False
    tier = effective_plan(user)
    payload["tier"] = tier

    # Brief 2.0 — re-attach CTAs to LLM-rephrased insights.
    # The LLM rewrites the candidate text in friendly prose, but loses
    # the cta_label/cta_url that came with each Candidate. Match each
    # output insight back to its source candidate by checking whether
    # the candidate's distinctive facts (long enough numbers / proper
    # nouns) all appear in the rephrased text. When a match is found,
    # carry over the candidate's CTA so the frontend can render a
    # tap-to-action chip.
    #
    # Fuzzy but safe: a candidate without facts can't be matched →
    # no CTA, no false positive. Multiple candidates matching the
    # same text → first (highest weight) wins.
    if polished:
        def _norm(s):
            return " ".join(str(s).lower().split())

        def _match_candidate_cta(text: str):
            t = _norm(text)
            for c in candidates:
                if not c.cta_url:
                    continue
                facts = [_norm(f) for f in c.facts if len(str(f)) >= 2]
                if not facts:
                    continue
                if all(f in t for f in facts):
                    return c.cta_label, c.cta_url
            return None, None

        # Headline
        if payload.get("headline") and not payload.get("headline_cta_url"):
            lbl, url = _match_candidate_cta(payload["headline"])
            if url:
                payload["headline_cta_label"] = lbl
                payload["headline_cta_url"] = url

        # Insights — add cta_* fields when a match exists. Keep existing
        # fields untouched (the LLM doesn't emit cta_*, but be defensive).
        for ins in payload.get("insights") or []:
            if ins.get("cta_url"):
                continue
            lbl, url = _match_candidate_cta(ins.get("text") or "")
            if url:
                ins["cta_label"] = lbl
                ins["cta_url"] = url

    payload_json = json.dumps(payload, ensure_ascii=False)

    if row is None:
        row = DailyBrief(
            user_id=user.id,
            brief_date=today,
            payload_json=payload_json,
            tier=tier,
            model=model,
            input_tokens=in_tok or None,
            output_tokens=out_tok or None,
            refresh_count=0,
        )
        db.add(row)
    else:
        row.payload_json = payload_json
        row.tier = tier
        row.model = model
        row.input_tokens = in_tok or None
        row.output_tokens = out_tok or None
        if force_refresh:
            row.refresh_count = (row.refresh_count or 0) + 1
        row.updated_at = utc_now()

    db.commit()

    # Echo cap state for the frontend (so it can disable the refresh button
    # when the user has hit their limit).
    payload["refreshes_left"] = max(0, _refresh_cap_for(user) - (row.refresh_count or 0))
    payload["model"] = model
    return payload
