"""Unit tests for the portal realtime bus (Staff live-sync Phase 2).

Exercises the part most likely to harbour a subtle bug: the cross-thread
hand-off. In production `publish()` is called from a SYNC request handler
(staff.publish_week) running in a worker thread, while subscribers live on the
event loop. We reproduce that exactly with anyio.to_thread.run_sync.
"""

import anyio

from app.services import portal_events as pe


def test_roundtrip_publish_from_worker_thread():
    """A nudge published from a worker thread reaches a loop-side subscriber."""
    async def scenario():
        key = "tenant-roundtrip"
        q = pe.subscribe(key)
        assert q is not None
        assert pe.connection_count(key) == 1

        # publish() from a WORKER THREAD — mirrors the sync publish_week handler.
        await anyio.to_thread.run_sync(
            pe.publish, key, {"type": "schedule_published", "week_start": "2026-06-01"}
        )
        with anyio.fail_after(2):
            evt = await q.get()
        assert evt["type"] == "schedule_published"
        assert evt["week_start"] == "2026-06-01"

        # After unsubscribe, the key is gone and a further publish is a no-op.
        pe.unsubscribe(key, q)
        assert pe.connection_count(key) == 0
        await anyio.to_thread.run_sync(pe.publish, key, {"type": "noop"})

    anyio.run(scenario)


def test_publish_with_no_subscribers_never_raises():
    """No subscribers (or a closed/stale loop) must never raise into the caller —
    a nudge can never break the publish flow."""
    pe.publish("nobody-home-key", {"type": "schedule_published"})  # must not raise


def test_per_key_bound_refuses_excess_then_recovers():
    """The per-tenant cap refuses extra streams (caller falls back to polling),
    and freeing a slot lets a new one in."""
    async def scenario():
        key = "tenant-bounds"
        qs = []
        for _ in range(pe._MAX_PER_KEY):
            q = pe.subscribe(key)
            assert q is not None
            qs.append(q)
        # One past the cap → refused.
        assert pe.subscribe(key) is None
        # Free one slot → a new subscriber is admitted again.
        pe.unsubscribe(key, qs.pop())
        q_new = pe.subscribe(key)
        assert q_new is not None
        qs.append(q_new)
        # Cleanup.
        for q in qs:
            pe.unsubscribe(key, q)
        assert pe.connection_count(key) == 0

    anyio.run(scenario)


def test_isolation_between_tenants():
    """A publish to one tenant never leaks to another tenant's subscriber."""
    async def scenario():
        qa = pe.subscribe("tenant-A")
        qb = pe.subscribe("tenant-B")
        assert qa is not None and qb is not None
        await anyio.to_thread.run_sync(pe.publish, "tenant-A", {"type": "schedule_published"})
        with anyio.fail_after(2):
            evt = await qa.get()
        assert evt["type"] == "schedule_published"
        # tenant-B got nothing.
        assert qb.empty()
        pe.unsubscribe("tenant-A", qa)
        pe.unsubscribe("tenant-B", qb)

    anyio.run(scenario)
