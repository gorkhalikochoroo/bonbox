"""One writer per Daily close day.

Every write to one day's close — a save, a lock, a delete, an unlock, a
resend's claim, the demo clear — first takes a lock on (user, day, branch)
for the rest of its transaction. The writes read the day and then write it:
without the lock, two of them on Postgres (READ COMMITTED) both read the old
state and the later one wrote over the earlier one's result. Found by real
two-connection races on Postgres 16 (tests/test_pg_races.py), 9 Oct 2026:
  • a save racing a version-checked delete answered 200 and wrote its
    figures into the soft-deleted row — no live row held them;
  • a save sent without base_updated_at (an older app build, a queued copy)
    racing a lock rewrote the locked kasserapport's figures;
  • two first saves of a day made two live drafts (no branch) or a 500
    (with a branch: the unique key).

Postgres only: pg_advisory_xact_lock is released by the transaction's commit
or rollback, so nothing can leak it (also safe behind a transaction pooler).
SQLite serialises its writers itself; there it is a no-op.
"""
from __future__ import annotations

import uuid as _uuid


def _norm_id(v) -> str:
    """The same id always gives the same key — a UUID object, its string, or
    its upper-case / unhyphenated spelling."""
    if v is None:
        return "-"
    try:
        return str(_uuid.UUID(str(v)))
    except (ValueError, TypeError, AttributeError):
        return str(v)


def _norm_day(day) -> str:
    if hasattr(day, "date") and callable(getattr(day, "date")):
        day = day.date()  # a datetime: its date
    return day.isoformat() if hasattr(day, "isoformat") else str(day)


def close_day_key(user_id, day, branch_id) -> str:
    return f"daily_close:{_norm_id(user_id)}:{_norm_day(day)}:{_norm_id(branch_id)}"


def lock_close_day(db, user_id, day, branch_id) -> bool:
    """Hold every other write to this (user, day, branch) until this
    transaction ends. True when a lock was taken (Postgres), False on a
    database that needs none (SQLite)."""
    try:
        dialect = db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — no bind, nothing to lock
        return False
    if dialect != "postgresql":
        return False
    from sqlalchemy import text
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": close_day_key(user_id, day, branch_id)},
    )
    return True
