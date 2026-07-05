"""
frontend_monitor_job — flap tolerance + alert-once + recovered logic.

The monitor must NOT cry wolf: a single transient edge skew (the /reservations
outage) must never alarm, a real broken deploy alarms exactly ONCE, and it
sends exactly one RECOVERED note when it clears. This drives the whole job with
a scripted check() so we prove the state machine without a real outage.

Run: cd backend && python3 -m pytest tests/test_frontend_monitor.py -q
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.jobs.frontend_monitor_job as fmj
from app.services.prod_healthcheck import HealthResult
from app.models.monitor_state import MonitorState
from app.models.error_log import ErrorLog


def _result(healthy: bool):
    return HealthResult(
        healthy=healthy,
        entry="index-abcd1234.js",
        errors=[] if healthy else ["ReservationsPage-BI6AHUrv.js did not resolve to JS — stale deploy"],
        summary="ok" if healthy else "entry=index-abcd1234.js; ReservationsPage-BI6AHUrv.js 404",
    )


@pytest.fixture
def harness(monkeypatch):
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)

    # Job opens its own SessionLocal() — point it at the in-memory DB.
    monkeypatch.setattr(fmj, "SessionLocal", TestSession)

    # Count alerts/recovered without sending anything real.
    calls = {"alert": 0, "recovered": 0}
    monkeypatch.setattr(fmj, "_send_alert", lambda db, st, r: calls.__setitem__("alert", calls["alert"] + 1))
    monkeypatch.setattr(fmj, "_send_recovered", lambda db, st: calls.__setitem__("recovered", calls["recovered"] + 1))

    # Script the health check per tick.
    script = {"seq": []}
    monkeypatch.setattr(fmj, "check_prod_frontend", lambda base="": script["seq"].pop(0))

    def run(sequence):
        script["seq"] = list(sequence)
        while script["seq"]:
            fmj.run_frontend_monitor_tick()

    def state():
        db = TestSession()
        try:
            st = db.query(MonitorState).filter(MonitorState.service == "frontend_prod").first()
            n_incidents = db.query(ErrorLog).filter(ErrorLog.method == "MONITOR").count()
            return st.state, st.fail_streak, n_incidents
        finally:
            db.close()

    return run, state, calls, TestSession


OK = _result(True)
FAIL = _result(False)


def test_single_blip_never_alarms(harness):
    """The /reservations case: OK, one FAIL, OK → stays HEALTHY, zero alerts."""
    run, state, calls, _ = harness
    run([OK, FAIL, OK])
    st, streak, incidents = state()
    assert st == "HEALTHY"
    assert calls["alert"] == 0
    assert incidents == 0


def test_three_fails_alerts_once(harness):
    """Sustained breakage: 3 consecutive fails → BROKEN, exactly one alert + one incident row."""
    run, state, calls, _ = harness
    run([FAIL, FAIL, FAIL])
    st, streak, incidents = state()
    assert st == "BROKEN"
    assert calls["alert"] == 1
    assert incidents == 1


def test_still_broken_does_not_re_alert(harness):
    """While BROKEN, more failing ticks must NOT re-alert (anti-spam)."""
    run, state, calls, _ = harness
    run([FAIL, FAIL, FAIL, FAIL, FAIL])
    st, streak, incidents = state()
    assert st == "BROKEN"
    assert calls["alert"] == 1        # still exactly one
    assert incidents == 1


def test_recovers_once_after_two_green(harness):
    """BROKEN → 2 green ticks → HEALTHY, exactly one recovered note."""
    run, state, calls, _ = harness
    run([FAIL, FAIL, FAIL, OK, OK])
    st, streak, incidents = state()
    assert st == "HEALTHY"
    assert calls["alert"] == 1
    assert calls["recovered"] == 1
    assert streak == 0


def test_one_green_is_not_recovery(harness):
    """A single green tick mid-incident does NOT declare recovery (anti-flap back)."""
    run, state, calls, _ = harness
    run([FAIL, FAIL, FAIL, OK])       # only 1 green
    st, _s, _i = state()
    assert st == "BROKEN"
    assert calls["recovered"] == 0


def test_second_incident_can_alert_again(harness):
    """After a full recover, a NEW incident alerts again (last_alert_at was reset)."""
    run, state, calls, _ = harness
    run([FAIL, FAIL, FAIL, OK, OK, FAIL, FAIL, FAIL])
    st, _s, incidents = state()
    assert st == "BROKEN"
    assert calls["alert"] == 2        # two distinct incidents
    assert calls["recovered"] == 1
    assert incidents == 2
