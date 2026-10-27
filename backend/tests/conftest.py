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
- the global join / stand-pairing cool-off (`_join_fail_times`,
  `_join_cooloff_until`, `_join_in_flight`) and the in-process abuse counters
  (app/utils/abuse_signals.py).

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


# Jobs taken off the scheduler in a test run (see _pause_abuse_monitor).
_PAUSED_JOBS = (
    "abuse_monitor",
    # The online-booking door (R1 fix round): the owner digest every 10 min
    # and the quarter-hourly request expiry read and write the shared database —
    # tests drive them directly (test_r1_fix_owner_budget.py,
    # test_r1_fix_held_no_table.py), never on a timer mid-test.
    "owner_booking_digest",
    "reservation_request_expiry",
)


def _pause_abuse_monitor(main) -> None:
    """Importing app.main starts the background scheduler. Its 2-minute abuse
    monitor drains the in-process abuse counters that tests read, so in a
    test run it is taken off the scheduler (tests/test_abuse_monitor.py
    drives the job directly). The same for the other _PAUSED_JOBS."""
    sched = getattr(main, "_scheduler", None)
    for job_id in _PAUSED_JOBS:
        try:
            if sched is not None and sched.get_job(job_id) is not None:
                sched.remove_job(job_id)
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
    main._join_fail_times.clear()
    main._join_cooloff_until.clear()
    in_flight = getattr(main, "_join_in_flight", None)
    if in_flight is not None:  # join slots reserved but not yet released
        in_flight.clear()


@pytest.fixture(autouse=True)
def _fresh_app_rate_limits():
    _reset_app_rate_limits()
    yield
    _reset_app_rate_limits()
