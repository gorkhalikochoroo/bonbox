"""OAuth token replay defense — single-use jti tracking (Audit P1, Task #75).

Why this exists
---------------
Apple + Google id_tokens carry a unique `jti` claim (JWT ID).  Without
replay protection, a captured-but-unexpired id_token can be POSTed to
/oauth/apple|google multiple times within the token's 5–60 minute TTL.
This module rejects the second use.

How
---
Module-level dict keyed by `jti`, value = token expiry (Unix seconds).
Inserts prune entries with expiry < now.  Survives the process lifetime
but NOT restarts — that's intentional v1 scope.  Render's BonBox box
is single-instance + restart-on-deploy, so cache loss happens on the
same cadence as a fresh consent flow anyway.

V2 plan (deferred)
------------------
When we shard to multiple workers, swap the dict for a Postgres
`oauth_token_jti(jti PK, expires_at)` table with INSERT ... ON CONFLICT
DO NOTHING + RETURNING — that gives us a global one-shot guarantee.
Until then, this in-process check materially raises the bar against
opportunistic replay (e.g., a token leaked in a screenshot).

Concurrency
-----------
GIL-protected so the read-then-write is safe enough for our throughput
(a few hundred sign-ins per minute peak).  We use a threading.Lock
anyway for clarity.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)


# jti → expiry (Unix seconds)
_CACHE: dict[str, float] = {}
_LOCK = threading.Lock()

# How aggressively to prune.  Walk the dict every N inserts; cheaper
# than an every-insert sweep on a few-hundred-element dict.
_PRUNE_EVERY = 64
_INSERTS_SINCE_PRUNE = 0


def _prune_expired(now: float) -> None:
    """Drop entries whose expiry has passed.  Caller must hold _LOCK."""
    stale = [k for k, exp in _CACHE.items() if exp < now]
    for k in stale:
        _CACHE.pop(k, None)


def claim_jti(jti: Optional[str], expires_at: Optional[float] = None) -> bool:
    """Atomically attempt to record `jti` as used.

    Args:
      jti: the `jti` claim from the verified id_token.  If the token
        didn't carry a jti (some providers omit it), return True so we
        don't lock out legitimate sign-ins — the wider replay surface
        is still mitigated by the token's `exp` claim.
      expires_at: Unix seconds at which the token naturally expires.
        Once past this time we forget the jti.  Defaults to now+1h.

    Returns:
      True  — first time we've seen this jti; caller may proceed.
      False — already seen; caller must reject the sign-in.
    """
    if not jti:
        return True

    now = time.time()
    exp = float(expires_at) if expires_at else now + 3600.0

    global _INSERTS_SINCE_PRUNE  # noqa: PLW0603
    with _LOCK:
        existing = _CACHE.get(jti)
        if existing is not None and existing >= now:
            # Replay — refuse.  Note: an EXPIRED jti returns False
            # only if it's still hanging around in the cache; that's
            # also a replay attempt against an expired token, which we
            # block belt-and-suspenders.
            return False

        _CACHE[jti] = exp
        _INSERTS_SINCE_PRUNE += 1
        if _INSERTS_SINCE_PRUNE >= _PRUNE_EVERY:
            _INSERTS_SINCE_PRUNE = 0
            _prune_expired(now)
        return True


# ── Testing helpers ──────────────────────────────────────────────────


def _reset_for_tests() -> None:
    """Wipe the cache — call from pytest fixtures.  Never called in prod."""
    with _LOCK:
        _CACHE.clear()
        global _INSERTS_SINCE_PRUNE  # noqa: PLW0603
        _INSERTS_SINCE_PRUNE = 0
