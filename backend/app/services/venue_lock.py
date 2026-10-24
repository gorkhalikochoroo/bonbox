"""One writer at a time per venue for the anonymous booking door (R1 fix
round, 24 Oct 2026).

The booking screen (services/booking_screen.py) and the owner's ping budget
(services/owner_booking_alerts.py) each COUNT first and WRITE later. Twelve
posts fired at the same instant all read "under the ceiling" and all went
through: 11 confirmed fake bookings where the design allows 3, and up to
twice the owner pings the budget allows (security review, run/atk_b_race.py).

`venue_lock(db, key)` serialises that count-then-write per venue:

  • in this process, a threading.Lock per key — the API runs one worker per
    instance and sync endpoints run in its thread pool;
  • on Postgres, also pg_advisory_xact_lock(hashtext(key)) in the caller's
    transaction, so two instances (a deploy overlap) wait for each other too.
    It is released by the caller's commit or rollback — the count's own write
    is committed under it, which is the point.

FAIL-OPEN, like the rules it protects: a lock that cannot be taken within
`timeout` seconds, or an advisory-lock error, lets the caller go on without
it. A broken lock must never stop a real guest booking. Hold it only around
fast database work — never around an e-mail or a push send.
"""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager

from sqlalchemy import text

logger = logging.getLogger(__name__)

_GUARD = threading.Lock()
_LOCKS: dict[str, threading.Lock] = {}
# Keys are per venue (and per purpose); the table is cleared when it grows
# past this. A lock cleared while held keeps working for its holder — the
# next caller just gets a fresh one (one unserialised moment, at worst).
_MAX_KEYS = 20_000


def _lock_for(key: str) -> threading.Lock:
    with _GUARD:
        lk = _LOCKS.get(key)
        if lk is None:
            if len(_LOCKS) >= _MAX_KEYS:
                _LOCKS.clear()
            lk = _LOCKS[key] = threading.Lock()
        return lk


def _pg_lock(db, key: str) -> None:
    try:
        bind = db.get_bind()
        if bind is None or bind.dialect.name != "postgresql":
            return
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})
    except Exception:  # noqa: BLE001 — fail open; the thread lock still holds
        logger.warning("advisory lock failed for %s — going on without it", key, exc_info=True)


@contextmanager
def venue_lock(db, key: str, *, timeout: float = 5.0):
    """Hold the per-venue lock for `key` around a count-then-write."""
    lk = _lock_for(key)
    got = False
    try:
        got = lk.acquire(timeout=timeout)
    except Exception:  # noqa: BLE001
        got = False
    if not got:
        logger.warning("venue lock %s not taken within %ss — going on without it", key, timeout)
    try:
        _pg_lock(db, key)
        yield
    finally:
        if got:
            lk.release()
