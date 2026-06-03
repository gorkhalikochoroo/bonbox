"""
Portal realtime bus — Staff live-sync Phase 2 (instant push, no third party).

A tiny in-process publish/subscribe bus that lets the staff portal receive an
INSTANT "something changed, refetch" nudge over Server-Sent Events, instead of
waiting for the 20-second poll (Phase 1, which remains the fallback).

Why this design (and NOT Supabase Realtime):
  • No new secret. No JWT-signing key in Render. No third-party ever touches
    staff data — the nudge carries only a type + a week label, never schedule
    rows. The actual data still flows through the existing tenant-scoped,
    audited portal API.
  • Reuses the existing /api/portal/{token} capability-token auth.
  • Single uvicorn worker (see Procfile / render.yaml — no --workers) means a
    plain in-process bus is correct and sufficient; no cross-process broker
    needed. If BonBox ever runs multiple workers/instances, swap the transport
    here for Postgres LISTEN/NOTIFY — the public API (publish/subscribe) stays.

Threading model (important):
  • FastAPI runs async endpoints on the event loop and sync endpoints (`def`,
    like staff.publish_week) in a worker threadpool.
  • subscribe()/unsubscribe() are called from the async SSE endpoint → they run
    ON the loop thread, so they own all mutation of `_subscribers`.
  • publish() is called from a SYNC handler → a worker thread. It must NOT touch
    `_subscribers` directly; it only schedules delivery onto the loop via
    loop.call_soon_threadsafe(). The actual queue writes happen on the loop
    thread inside `_deliver`. This keeps `_subscribers` single-threaded.

Everything is best-effort: a dropped/dead connection or a full queue never
raises into a caller — the Phase-1 poll guarantees eventual freshness.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Optional, Set

logger = logging.getLogger(__name__)

# tenant key (owner user_id, stringified) → set of subscriber queues
_subscribers: Dict[str, Set["asyncio.Queue"]] = {}

# The running event loop, captured the first time a stream subscribes. publish()
# (on a worker thread) uses it to hand delivery back to the loop thread.
_loop: Optional[asyncio.AbstractEventLoop] = None

# Bounds (multi-barrier layer 2). These are ABUSE ceilings, not normal-use
# limits: a single venue's staff devices sit well under _MAX_PER_KEY, and the
# global cap protects the single worker from a connection-exhaustion attack.
# Exceeding either just refuses the stream → the client falls back to polling.
_MAX_PER_KEY = 25
_MAX_TOTAL = 500
_QUEUE_MAXSIZE = 64  # generous: events are rare (only on publish)


def _count_total() -> int:
    return sum(len(s) for s in _subscribers.values())


def subscribe(key: str) -> Optional["asyncio.Queue"]:
    """Register a subscriber for `key`. Returns its queue, or None if a bound
    is hit (caller should then refuse the stream and let the client poll).

    MUST be called from the event loop thread (i.e. from an async endpoint)."""
    global _loop
    try:
        _loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — not in a loop
        _loop = None

    subs = _subscribers.setdefault(key, set())
    if len(subs) >= _MAX_PER_KEY or _count_total() >= _MAX_TOTAL:
        if not subs:  # don't leave an empty set behind
            _subscribers.pop(key, None)
        logger.info("portal_events: subscribe refused (bound hit) key=%s", key)
        return None

    q: "asyncio.Queue" = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    subs.add(q)
    return q


def unsubscribe(key: str, q: "asyncio.Queue") -> None:
    """Remove a subscriber. Idempotent. MUST be called from the loop thread."""
    subs = _subscribers.get(key)
    if not subs:
        return
    subs.discard(q)
    if not subs:
        _subscribers.pop(key, None)


def publish(key: str, event: dict) -> None:
    """Fan `event` out to every subscriber for `key`. Best-effort and
    thread-safe: safe to call from a SYNC request handler (worker thread).

    Carries NO sensitive data — just a small {"type": ..., ...} nudge that tells
    the client to refetch through the normal authenticated API."""
    loop = _loop
    if loop is None:
        return  # nobody has ever connected → nothing to deliver

    def _deliver() -> None:  # runs on the loop thread
        subs = _subscribers.get(key)
        if not subs:
            return
        for q in list(subs):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow/stuck consumer — drop. The 20s poll fallback covers it.
                pass
            except Exception:  # noqa: BLE001 — never let delivery raise
                pass

    try:
        loop.call_soon_threadsafe(_deliver)
    except RuntimeError:
        # Loop is closing/closed (e.g. during shutdown) — ignore.
        pass


def connection_count(key: Optional[str] = None) -> int:
    """Diagnostics/tests: current subscriber count, total or for one key."""
    if key is not None:
        return len(_subscribers.get(key, ()))
    return _count_total()
