"""A job that catches its own failure must still reach the operator.

R-i's listener (app/jobs/job_events.py) turns a finished job's return dict
into one error_logs row per top-level key that ends in "_error"; the
15-minute ops triage then sends one digest per group per 24 h. Jobs from the
other releases in this bundle swallowed their failures under other names:

  * R-sec's abuse monitor returned {"error": ...} on every failed tick, so a
    tick that kept failing (database down, a query that breaks on Postgres)
    only printed a line every 2 minutes while the mail ceilings could hold
    real owners' and guests' mail back with nobody told;
  * the nightly backup's hourly watch returned {"status": "error"};
  * R-h's privacy purges and the change-log cleanup put their error one level
    down (summary["privacy_purges"]["whatsapp_messages"] = {"error": ...},
    summary["audit_email_cleanup"]["error"]), where the listener never looks.

Each now also returns a top-level *_error key (error names only, never the
exception text), so one JOB row is written per failed run.

Run: cd backend && python -m pytest tests/test_job_step_errors_reach_ops.py -q
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apscheduler.events import EVENT_JOB_EXECUTED, JobExecutionEvent
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database
from app import models as _all_models  # noqa: F401
from app.database import Base
from app.jobs.job_events import on_job_event
from app.models.error_log import ErrorLog

NOW = datetime(2026, 10, 11, 2, 30, tzinfo=timezone.utc)


@pytest.fixture
def mem(monkeypatch):
    """Where the listener writes its rows."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    S = sessionmaker(bind=engine)
    monkeypatch.setattr(app.database, "SessionLocal", S)
    return S


def _broken_session():
    """A database with no tables: every query raises OperationalError."""
    return sessionmaker(bind=create_engine("sqlite:///:memory:",
                                           connect_args={"check_same_thread": False},
                                           poolclass=StaticPool))


def _job_rows(S, job_id):
    s = S()
    try:
        return s.query(ErrorLog).filter(ErrorLog.path == f"job:{job_id}").all()
    finally:
        s.close()


def _finished(job_id, retval):
    on_job_event(JobExecutionEvent(EVENT_JOB_EXECUTED, job_id, "default", NOW, retval=retval))


# ── R-sec: abuse monitor ──────────────────────────────────────────────

def test_a_failing_abuse_monitor_tick_becomes_one_job_row(mem, monkeypatch):
    import app.jobs.abuse_monitor_job as amj
    from app.utils import abuse_signals

    monkeypatch.setattr(amj, "SessionLocal", _broken_session())
    abuse_signals.reset()
    abuse_signals.bump("magic_link_fleet", 1)
    out = amj.run_abuse_monitor_tick()
    assert out.get("abuse_monitor_error") == "OperationalError", out
    assert abuse_signals.drain() == {"magic_link_fleet": 1}   # kept for the next tick

    _finished("abuse_monitor", out)
    rows = _job_rows(mem, "abuse_monitor")
    assert [r.error_type for r in rows] == ["JobStep:abuse_monitor_error"]
    assert rows[0].message == "OperationalError" and rows[0].method == "JOB"


def test_a_healthy_abuse_monitor_tick_writes_no_job_row(mem, monkeypatch):
    import app.jobs.abuse_monitor_job as amj
    from app.utils import abuse_signals

    monkeypatch.setattr(amj, "SessionLocal", mem)
    abuse_signals.reset()
    out = amj.run_abuse_monitor_tick()
    assert not any(k.endswith("_error") for k in out), out
    _finished("abuse_monitor", out)
    assert _job_rows(mem, "abuse_monitor") == []


# ── nightly backup: the hourly watch ──────────────────────────────────

def test_a_failing_backup_watch_becomes_one_job_row(mem):
    from app.services import backup_service as bs

    cfg = bs.BackupConfig(status="enabled")
    out = bs.check_backup_staleness(cfg=cfg, session_factory=_broken_session())
    assert out["status"] == "error"                          # unchanged for its callers
    assert out.get("backup_watch_error") == "OperationalError", out

    _finished("nightly_backup_watch", out)
    rows = _job_rows(mem, "nightly_backup_watch")
    assert [r.error_type for r in rows] == ["JobStep:backup_watch_error"]
    assert rows[0].message == "OperationalError"


def test_a_quiet_backup_watch_writes_no_job_row(mem):
    from app.services import backup_service as bs

    for out in (bs.check_backup_staleness(cfg=bs.BackupConfig(status="disabled")),
                bs.check_backup_staleness(cfg=bs.BackupConfig(status="enabled"), session_factory=mem)):
        assert not any(k.endswith("_error") for k in out), out
        _finished("nightly_backup_watch", out)
    assert _job_rows(mem, "nightly_backup_watch") == []


# ── R-h: nested errors inside daily_maintenance ───────────────────────

@pytest.fixture
def quiet_maintenance(monkeypatch):
    """Every other nightly step stubbed: only the R-h steps are under test."""
    from app.jobs import retention_and_patterns as rp
    from app.services import accounting_retention

    for name in ("purge_old_events", "expire_stale_patterns", "purge_old_error_logs",
                 "purge_expired_signup_refs"):
        monkeypatch.setattr(rp, name, lambda: 0)
    monkeypatch.setattr(rp, "detect_patterns_for_all", lambda: {})
    monkeypatch.setattr(rp, "smart_drift_scan_for_all", lambda: {})
    import app.jobs.reservation_request_expiry as rre
    monkeypatch.setattr(rre, "expire_stale_requests", lambda: {})
    monkeypatch.setattr(accounting_retention, "run_retention_sweep", lambda: {"ok": True})
    return rp


def _ok_purges(monkeypatch):
    from app.jobs import privacy_purges as pp
    for _key, fn in pp._PURGES:
        monkeypatch.setattr(pp, fn, lambda: {"due": 0, "deleted": 0, "dry_run": True})
    return pp


def test_a_failing_privacy_purge_becomes_one_job_row(mem, monkeypatch, quiet_maintenance):
    pp = _ok_purges(monkeypatch)
    from app.services import audit_email_cleanup as aec
    monkeypatch.setattr(aec, "run_cleanup", lambda: {"due": 0, "changed": 0, "dry_run": True})

    def _boom():
        raise RuntimeError("guest +4520202020 agnes@example.dk")

    monkeypatch.setattr(pp, "purge_old_whatsapp_messages", _boom)
    monkeypatch.setattr(pp, "purge_expired_magic_links", _boom)
    summary = quiet_maintenance.daily_maintenance()
    # The per-purge detail stays where it was (R-h's dry-run log reads it).
    assert summary["privacy_purges"]["whatsapp_messages"] == {"error": "RuntimeError"}
    assert summary["privacy_purges_error"] == \
        "whatsapp_messages:RuntimeError, magic_link_tokens:RuntimeError"
    assert "agnes" not in repr(summary) and "+4520" not in repr(summary)

    _finished("daily_maintenance", summary)
    rows = _job_rows(mem, "daily_maintenance")
    assert [r.error_type for r in rows] == ["JobStep:privacy_purges_error"]


def test_a_stopped_change_log_cleanup_becomes_one_job_row(mem, monkeypatch, quiet_maintenance):
    _ok_purges(monkeypatch)
    from app.services import audit_email_cleanup as aec
    monkeypatch.setattr(aec, "run_cleanup", lambda: {"due": 9, "changed": 4, "dry_run": False,
                                                     "tenants": 1, "error": "OperationalError"})
    summary = quiet_maintenance.daily_maintenance()
    assert summary["audit_email_cleanup"]["changed"] == 4
    assert summary["audit_email_cleanup_error"] == "OperationalError"

    _finished("daily_maintenance", summary)
    rows = _job_rows(mem, "daily_maintenance")
    assert [r.error_type for r in rows] == ["JobStep:audit_email_cleanup_error"]


def test_a_clean_night_writes_no_job_row(mem, monkeypatch, quiet_maintenance):
    _ok_purges(monkeypatch)
    from app.services import audit_email_cleanup as aec
    monkeypatch.setattr(aec, "run_cleanup", lambda: {"due": 0, "changed": 0, "dry_run": True})
    summary = quiet_maintenance.daily_maintenance()
    assert "privacy_purges_error" not in summary and "audit_email_cleanup_error" not in summary
    _finished("daily_maintenance", summary)
    assert _job_rows(mem, "daily_maintenance") == []
