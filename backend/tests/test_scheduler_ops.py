"""Scheduler ops safety (R-i, OPS-10).

Pins: every job runs with misfire_grace_time=3600 + coalesce (the nightly
backup run keeps its own longer 3 h); the 21 jobs (18 + ops_triage every
15 min + the nightly backup and its hourly watch) are registered; the
job-event listener is
attached; and job errors, misses, max-instance skips and daily_maintenance's
swallowed "*_error" steps become error_logs rows (method=JOB) — including a
real-producer test on a live BackgroundScheduler, so the stub events cannot
assert a fiction about what APScheduler actually emits.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest
from apscheduler.events import (
    EVENT_JOB_ERROR,
    EVENT_JOB_EXECUTED,
    EVENT_JOB_MAX_INSTANCES,
    EVENT_JOB_MISSED,
    JobExecutionEvent,
    JobSubmissionEvent,
)
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.jobs.job_events import JOB_EVENT_MASK, on_job_event
from app.models.error_log import ErrorLog

NOW = datetime(2026, 10, 11, 2, 30, tzinfo=timezone.utc)


@pytest.fixture
def mem(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(app.database, "SessionLocal", TestSession)
    return TestSession


def _rows(Session):
    db = Session()
    try:
        return db.query(ErrorLog).all()
    finally:
        db.close()


# 1 ─────────────────────────────────────────────────────────────────────
# Checked in a FRESH process — exactly the release-gate command. In this test
# process another file's `with TestClient(app)` may already have run the app
# lifespan shutdown, which stops the shared scheduler and empties its jobs.
_PROBE = """
import json
import app.main as m
from app.jobs.job_events import on_job_event, JOB_EVENT_MASK
s = m._scheduler
jobs = s.get_jobs()
t = s.get_job("ops_triage")
print("RESULT=" + json.dumps({
    "running": s.running,
    "jobs": len(jobs),
    "defaults": sorted({(j.misfire_grace_time, j.coalesce, j.max_instances)
                        for j in jobs if j.id != "nightly_backup"}),
    "backup": [[j.misfire_grace_time, j.coalesce, j.max_instances]
               for j in jobs if j.id == "nightly_backup"],
    "triage_trigger": type(t.trigger).__name__ if t else None,
    "triage_seconds": t.trigger.interval.total_seconds() if t else None,
    "listener": (on_job_event, JOB_EVENT_MASK) in s._listeners,
}))
s.shutdown(wait=False)
"""


@pytest.fixture(scope="module")
def app_scheduler():
    import json
    import os
    import subprocess
    import sys

    backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, "-c", _PROBE], cwd=backend, capture_output=True,
                         text=True, timeout=180, env=dict(os.environ))
    line = next((ln for ln in out.stdout.splitlines() if ln.startswith("RESULT=")), None)
    assert line is not None, out.stdout[-2000:] + out.stderr[-2000:]
    return json.loads(line[len("RESULT="):])


def test_importing_the_app_starts_the_scheduler_with_21_jobs(app_scheduler):
    assert app_scheduler["running"] is True
    assert app_scheduler["jobs"] == 21


def test_every_job_has_misfire_grace_and_coalesce(app_scheduler):
    # One distinct (misfire_grace_time, coalesce, max_instances) across every
    # job but the nightly backup, which sets a longer 3 h grace of its own
    # (services/backup_service.register_backup_job): never below one hour.
    assert app_scheduler["defaults"] == [[3600, True, 1]]
    assert app_scheduler["backup"] == [[3 * 3600, True, 1]]


def test_ops_triage_runs_every_15_minutes(app_scheduler):
    assert app_scheduler["triage_trigger"] == "IntervalTrigger"
    assert app_scheduler["triage_seconds"] == 15 * 60


def test_job_event_listener_is_attached(app_scheduler):
    assert app_scheduler["listener"] is True


# 2 ─────────────────────────────────────────────────────────────────────
def test_job_error_becomes_a_job_row(mem):
    evt = JobExecutionEvent(EVENT_JOB_ERROR, "x", "default", NOW,
                            exception=RuntimeError("boom"), traceback="Traceback...\nRuntimeError: boom")
    on_job_event(evt)
    rows = _rows(mem)
    assert len(rows) == 1
    r = rows[0]
    assert r.method == "JOB"
    assert r.path == "job:x"
    assert r.error_type == "RuntimeError"
    assert r.status_code is None
    assert r.message == "boom"
    assert "RuntimeError: boom" in r.traceback
    assert r.ip_address is None and r.user_agent is None


# 3 ─────────────────────────────────────────────────────────────────────
def test_missed_and_max_instances_become_rows(mem):
    on_job_event(JobExecutionEvent(EVENT_JOB_MISSED, "daily_maintenance", "default", NOW))
    on_job_event(JobSubmissionEvent(EVENT_JOB_MAX_INSTANCES, "shift_reminders", "default",
                                    [NOW, NOW]))
    by_type = {r.error_type: r for r in _rows(mem)}
    assert by_type["JobMissed"].path == "job:daily_maintenance"
    assert "2026-10-11T02:30:00" in by_type["JobMissed"].message
    assert by_type["JobMaxInstances"].path == "job:shift_reminders"
    assert by_type["JobMaxInstances"].message == "2 run(s) skipped"
    assert all(r.status_code is None and r.method == "JOB" for r in by_type.values())


# 4 ─────────────────────────────────────────────────────────────────────
def test_swallowed_maintenance_step_becomes_one_row(mem):
    evt = JobExecutionEvent(EVENT_JOB_EXECUTED, "daily_maintenance", "default", NOW,
                            retval={"error_log_retention_error": "x", "error_logs_purged": 3,
                                    "signup_ref_retention_error": "", "ran_at": "t"})
    on_job_event(evt)
    rows = _rows(mem)
    assert [r.error_type for r in rows] == ["JobStep:error_log_retention_error"]
    assert rows[0].message == "x"
    assert rows[0].path == "job:daily_maintenance"


@pytest.mark.parametrize("retval", [None, 3, "ok", ["a_error"], {"healthy": True, "error": "x"}])
def test_executed_without_error_steps_writes_nothing(mem, retval):
    on_job_event(JobExecutionEvent(EVENT_JOB_EXECUTED, "j", "default", NOW, retval=retval))
    assert _rows(mem) == []


def test_ops_triage_summary_keys_never_trip_the_listener(mem):
    """The triage job's own summary must not be read as a failed step."""
    on_job_event(JobExecutionEvent(EVENT_JOB_EXECUTED, "ops_triage", "default", NOW,
                                   retval={"rows": 1, "new_notes": 0, "skipped": 0,
                                           "digest": None, "storage": "durable"}))
    on_job_event(JobExecutionEvent(EVENT_JOB_EXECUTED, "ops_triage", "default", NOW,
                                   retval={"ops_triage_failed": True}))
    assert _rows(mem) == []


# 5 ─────────────────────────────────────────────────────────────────────
def test_db_failure_never_raises(monkeypatch):
    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(app.database, "SessionLocal", _boom)
    on_job_event(JobExecutionEvent(EVENT_JOB_ERROR, "x", "default", NOW,
                                   exception=RuntimeError("boom"), traceback="tb"))


def test_pool_exhausted_skips_the_write(mem, monkeypatch):
    import app.utils.off_loop as off_loop
    monkeypatch.setattr(off_loop, "pool_exhausted", lambda *a, **k: True)
    on_job_event(JobExecutionEvent(EVENT_JOB_ERROR, "x", "default", NOW,
                                   exception=RuntimeError("boom"), traceback="tb"))
    assert _rows(mem) == []


# 6 ─────────────────────────────────────────────────────────────────────
def test_real_scheduler_emits_exception_and_traceback(mem):
    """Real producer: a live BackgroundScheduler with the same job_defaults
    and listener, and a job that raises. Proves the real event carries
    .exception and .traceback the way the listener reads them."""
    def _raising_job():
        raise ValueError("real-producer-boom")

    sched = BackgroundScheduler(
        job_defaults={"misfire_grace_time": 3600, "coalesce": True, "max_instances": 1}
    )
    sched.add_listener(on_job_event, JOB_EVENT_MASK)
    try:
        sched.start()
        sched.add_job(_raising_job, id="contract_job")       # date trigger: runs now
        deadline = time.monotonic() + 5.0
        rows = []
        while time.monotonic() < deadline:
            rows = _rows(mem)
            if rows:
                break
            time.sleep(0.05)
    finally:
        sched.shutdown(wait=True)
    assert len(rows) == 1
    r = rows[0]
    assert r.method == "JOB" and r.path == "job:contract_job"
    assert r.error_type == "ValueError"
    assert r.message == "real-producer-boom"
    assert "_raising_job" in (r.traceback or "")
