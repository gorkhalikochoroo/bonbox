"""Daily Brief precompute — the morning's brief written BEFORE the owner opens Home.

Why (C, speed push 15 Oct): the first Home open of the day generated the brief
on the spot — ~116 queries plus the Claude polish (~1.2 s, holding a request
thread and a DB connection), while the owner looked at a placeholder. The
push (06:00 UTC) and email (06:30 UTC) jobs already generate it, but only for
owners with a device or an email subscription, and only from 08:00 local.

What it does: every hour from 04:05 to 07:05 UTC (06:05-09:05 Copenhagen in
summer, 05:05-08:05 in winter) it calls the SAME get_or_create_brief the
dashboard calls, for owners who opened Home recently and have no brief for
today yet. The dashboard then serves the stored row (a cache hit). Nothing
about the brief itself changes: same facts, same LLM layer and validation,
same deterministic fallback, same one-row-per-owner-per-day key.

Rules (all fail safe — skipping only means the brief is made on demand, as
before):
  • Only after the owner's BUSINESS day has rolled over (DK 06:00 cutoff, or
    the venue's own day_cutoff_hour) and the server's date is the owner's
    local date. A brief written at 05:30 local would describe the wrong day:
    "yesterday's close missing" would ask about the day before yesterday.
  • Only owners who opened Home in the last ACTIVE_DAYS days (a DailyBrief
    row exists) — no AI call for dormant accounts; never a locked account,
    never an invited seat or a revisor login (the brief row is the owner's:
    see get_or_create_brief's restricted-seat rule).
  • Never twice: an existing row for today is left alone (no refresh, so no
    refresh cap is touched).
  • One owner's failure never stops the rest; rolled back, logged by id only.
  • At most MAX_PER_RUN owners per run (cost ceiling); the next hourly run
    takes the rest.

Returns {candidates, generated, skipped_not_rolled_over, skipped_existing,
errors} — counts only (no names, no figures) for the log and the tests.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.daily_brief import DailyBrief
from app.models.user import User

logger = logging.getLogger(__name__)

ACTIVE_DAYS = 7
MAX_PER_RUN = 200
_OWNER_ROLES = ("owner", "super_admin")


def _business_day_has_begun(user, today_server: date) -> bool:
    """True once the owner's business day is today's local date AND that date
    is the server's date (the brief row is keyed on the server's date)."""
    from app.services.tz_utils import business_today_local, today_local
    local = today_local(user)
    return business_today_local(user) == local == today_server


def precompute_daily_briefs(
    db_factory: Callable[[], Session] = SessionLocal,
    *,
    today: date | None = None,
) -> dict[str, int]:
    from app.services.daily_brief import get_or_create_brief

    out = {"candidates": 0, "generated": 0, "skipped_not_rolled_over": 0,
           "skipped_existing": 0, "errors": 0}
    today = today or date.today()
    db = db_factory()
    try:
        recent = (
            db.query(DailyBrief.user_id)
            .filter(DailyBrief.brief_date >= today - timedelta(days=ACTIVE_DAYS),
                    DailyBrief.brief_date < today)
            .distinct()
            .subquery()
        )
        done_today = {
            uid for (uid,) in db.query(DailyBrief.user_id)
            .filter(DailyBrief.brief_date == today).all()
        }
        users = (
            db.query(User)
            .filter(User.id.in_(db.query(recent.c.user_id)),
                    User.is_locked.is_(False))
            .order_by(User.id)
            .all()
        )
        # The owner's own row only: never an invited seat or a revisor login.
        users = [u for u in users if str(u.role or "owner").lower() in _OWNER_ROLES]
        out["candidates"] = len(users)
        cutoffs = dict(
            db.query(BusinessProfile.user_id, BusinessProfile.day_cutoff_hour)
            .filter(BusinessProfile.user_id.in_([u.id for u in users]))
            .all()
        ) if users else {}

        for user in users:
            if out["generated"] >= MAX_PER_RUN:
                break   # the next hourly run takes the rest
            if user.id in done_today:
                out["skipped_existing"] += 1
                continue
            try:
                if cutoffs.get(user.id) is not None:
                    user.day_cutoff_hour = cutoffs[user.id]
                if not _business_day_has_begun(user, today):
                    out["skipped_not_rolled_over"] += 1
                    continue
                get_or_create_brief(user, db)   # stores + commits today's row
                out["generated"] += 1
            except Exception as e:  # noqa: BLE001 — one owner never stops the run
                out["errors"] += 1
                logger.warning("daily_brief_precompute: user=%s failed: %s", user.id, type(e).__name__)
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass
        logger.info(
            "daily_brief_precompute: candidates=%d generated=%d not_rolled_over=%d "
            "existing=%d errors=%d",
            out["candidates"], out["generated"], out["skipped_not_rolled_over"],
            out["skipped_existing"], out["errors"],
        )
        return out
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(precompute_daily_briefs())
