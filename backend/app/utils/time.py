"""Time helpers — single source of truth for "what does 'now' mean
in this codebase".

Why this file exists (May 2026):
  Python 3.12 deprecated `datetime.datetime.utcnow()` and Python 3.14
  will REMOVE it. Before this sweep we had ~200 calls to `utcnow()`
  scattered across the backend. Each one needed updating, and the
  natural replacement (`datetime.now(timezone.utc)`) returns a
  TIMEZONE-AWARE datetime — which is incompatible with our existing
  DB columns (bare `DateTime`, no `timezone=True`, populated with
  naive datetimes for over a year).

  Migrating all columns to TIMESTAMPTZ + every comparison to aware
  datetimes is a separate, larger refactor. This module is the
  minimal-risk fix: it produces a NAIVE UTC datetime that's bit-for-bit
  compatible with what `utcnow()` returned, just using a non-deprecated
  API. Every `datetime.utcnow()` call in the codebase becomes
  `utc_now()`.

  When we eventually move to tz-aware columns, we change ONE function
  here and the rest of the codebase keeps working as-is.

Usage:
    from app.utils.time import utc_now
    user.created_at = utc_now()
    if user.trial_ends_at and user.trial_ends_at > utc_now():
        ...
"""

from datetime import datetime, timezone


def utc_now() -> datetime:
    """Naive UTC `datetime.now()` — drop-in replacement for the
    deprecated `datetime.utcnow()`.

    Returns a datetime with `tzinfo=None` so it round-trips identically
    through SQLAlchemy's bare `DateTime` columns (which strip / refuse
    tzinfo depending on the dialect). Comparisons with existing naive
    datetimes pulled from the DB work without TypeError.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
