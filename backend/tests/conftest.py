"""Suite-wide test isolation for the app's shared, in-process rate limits.

The app keeps this per-client state in process memory, and no single test
file owns it:

- slowapi's app-wide default, 120/minute per route (SlowAPIMiddleware,
  `app.state.limiter`). It also applies to routes that a router's own
  Limiter decorates, such as POST /api/daily-close.
- the coarse ceiling, 600/minute per IP across every path (`_coarse_hits`).
- the /api/admin scan blocker (`_admin_ip_strikes`, `_admin_ip_banned`):
  20 4xx answers within 60 s ban the IP for 10 minutes, after which every
  /api/admin request gets 404. No test owns it either.

Every TestClient request comes from the same client ("testclient"; it sends
no edge header, so the rate-limit key is the shared "no-edge" bucket). CI runs
the whole suite in ONE serial process (.github/workflows/tests.yml), so these
buckets fill across tests and files. A test that runs within a minute of
enough earlier traffic then gets a 429 it did nothing to cause. On 9 Oct
that made 28-31 tests fail per run, from test_daily_close_r21 on, and later
also test_revisor_artifacts. The local release gate splits the suite into
parallel batches, so it never saw this.

So each test starts and ends with all of them empty. A test that checks a
limit still makes its own requests inside the test and still sees its 429.
The router-level limiters (for example daily_close._limiter) are reset by the
files that use them, as before.
"""
import sys

import pytest


def _pause_abuse_monitor(main) -> None:
    """Importing app.main starts the background scheduler. Its 2-minute abuse
    monitor drains the in-process abuse counters that tests read, so in a
    test run it is taken off the scheduler (tests/test_abuse_monitor.py
    drives the job directly)."""
    sched = getattr(main, "_scheduler", None)
    try:
        if sched is not None and sched.get_job("abuse_monitor") is not None:
            sched.remove_job("abuse_monitor")
    except Exception:  # noqa: BLE001 — isolation helper, never fails a test
        pass


def _reset_app_rate_limits() -> None:
    signals = sys.modules.get("app.utils.abuse_signals")
    if signals is not None:  # in-process abuse counters (the abuse monitor drains them)
        signals.reset()
    main = sys.modules.get("app.main")
    if main is None:  # nothing in this run has loaded the app yet
        return
    _pause_abuse_monitor(main)
    main.limiter.reset()
    main._coarse_hits.clear()
    main._admin_ip_strikes.clear()
    main._admin_ip_banned.clear()


@pytest.fixture(autouse=True)
def _fresh_app_rate_limits():
    _reset_app_rate_limits()
    yield
    _reset_app_rate_limits()
