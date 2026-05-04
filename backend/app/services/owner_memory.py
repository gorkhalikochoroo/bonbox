"""
Owner memory — builds the per-user context summary that gets injected into
Claude's system prompt. This is what makes the BonBox AI Copilot adapt to
each owner instead of being a generic chatbot.

The memory is computed cheaply (5-10 SQL queries) and rebuilt per chat session
(so it always reflects the latest state). It is small enough (<2k tokens) to
fit comfortably alongside the user's conversation.

Privacy: the memory NEVER leaves the server in a way that exposes another
user's data. Each call is scoped strictly to the calling user's user_id.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.event_log import EventLog
from app.models.expense import Expense
from app.models.owner_pattern import OwnerPattern
from app.models.sale import Sale
from app.models.user import User


def _safe_avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def build_owner_context(user: User, db: Session, max_patterns: int = 5) -> str:
    """
    Returns a compact context string suitable for prepending to Claude's
    system prompt. Caller is responsible for choosing whether to include it.

    Output stays small — <2k chars in typical case. Designed to be skimmable
    by both humans (debugging) and Claude (context injection).
    """
    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # ── 1. Basic profile ──
    lines = [
        f"Business: {user.business_name or '(unnamed)'} ({user.business_type or 'general'})",
        f"Currency: {user.currency or 'DKK'}",
    ]

    # ── 2. Recent revenue ──
    week_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= week_ago.date(),
            Sale.is_deleted == False,  # noqa: E712
            Sale.status != "returned",
        )
        .scalar()
        or 0
    )
    month_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= month_ago.date(),
            Sale.is_deleted == False,  # noqa: E712
            Sale.status != "returned",
        )
        .scalar()
        or 0
    )
    sale_count_week = (
        db.query(func.count(Sale.id))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= week_ago.date(),
            Sale.is_deleted == False,  # noqa: E712
        )
        .scalar()
        or 0
    )
    lines.append(
        f"Last 7d: {float(week_rev):,.0f} {user.currency} across {sale_count_week} sales"
    )
    lines.append(f"Last 30d: {float(month_rev):,.0f} {user.currency}")

    # ── 3. Recent expenses ──
    month_exp = (
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(
            Expense.user_id == user.id,
            Expense.date >= month_ago.date(),
            Expense.is_deleted == False,  # noqa: E712
            Expense.is_personal == False,  # noqa: E712
        )
        .scalar()
        or 0
    )
    lines.append(f"Last 30d expenses: {float(month_exp):,.0f} {user.currency}")
    if float(month_rev) > 0:
        margin = (float(month_rev) - float(month_exp)) / float(month_rev) * 100
        lines.append(f"30d margin: {margin:.0f}%")

    # ── 4. Engagement signals (which features they use) ──
    feature_rows = (
        db.query(EventLog.page, func.count(EventLog.id))
        .filter(
            EventLog.user_id == user.id,
            EventLog.event == "page_view",
            EventLog.created_at >= month_ago,
            EventLog.page.isnot(None),
        )
        .group_by(EventLog.page)
        .order_by(func.count(EventLog.id).desc())
        .limit(5)
        .all()
    )
    if feature_rows:
        top = ", ".join(f"{p} ({c})" for p, c in feature_rows)
        lines.append(f"Most-used (30d): {top}")

    # ── 5. Active patterns (the meat — recent insights about THIS owner) ──
    patterns = (
        db.query(OwnerPattern)
        .filter(
            OwnerPattern.user_id == user.id,
            OwnerPattern.state == "active",
        )
        .order_by(OwnerPattern.detected_at.desc())
        .limit(max_patterns)
        .all()
    )
    if patterns:
        lines.append("")
        lines.append("ACTIVE INSIGHTS:")
        for p in patterns:
            lines.append(f"- [{p.severity}] {p.title}")
            if p.detail:
                # Trim long detail strings to keep token budget tight
                trimmed = p.detail[:200] + ("…" if len(p.detail) > 200 else "")
                lines.append(f"    {trimmed}")
            if p.suggested_action:
                lines.append(f"    → {p.suggested_action}")

    return "\n".join(lines)


def build_system_prompt_addendum(user: User, db: Session) -> str:
    """
    Wraps build_owner_context with framing language ready to slot into Claude's
    system prompt. The agent.py router can append this to its existing system
    prompt without restructuring.
    """
    ctx = build_owner_context(user, db)
    return (
        "\n\n"
        "─── THIS OWNER'S CURRENT BUSINESS CONTEXT ───\n"
        f"{ctx}\n"
        "──────────────────────────────────────────────\n"
        "Use this context to answer concretely about THIS specific business. "
        "When asked vague questions, lead with the most relevant active insight. "
        "Match the owner's currency and language. Be concise — they're busy.\n"
    )
