"""services/ops_alert.send_ops_alert — the ONE operator alert path (R-i).

Pins the anti-spam and no-customer-data rules every alert goes through:
gate (production only), recipients from config, per-key dedupe + cooldown,
the hard daily cap (reserved before sending), the PII guard, honest
three-way-plus outcomes, and "never raises".

Every test stubs send_email and the push fan-out EXCEPT the real-producer
test, which runs the real email_service.send_email with no Resend key.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database
import app.jobs.frontend_monitor_job as fmj
import app.services.email_service as email_service
from app.config import settings
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.models.monitor_state import MonitorState
from app.services import ops_alert
from app.services.ops_alert import AlertOutcome, send_ops_alert


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
    ops_alert._WARNED.clear()
    yield TestSession
    ops_alert._WARNED.clear()


@pytest.fixture
def prod(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "OPS_ALERTS_ENABLED", True)
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "ops@example.test")
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", "boss@example.test")
    monkeypatch.setattr(settings, "OPS_ALERT_DAILY_CAP", 10)
    monkeypatch.setattr(settings, "OPS_ALERT_COOLDOWN_MINUTES", 360)
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://bonbox.dk")


@pytest.fixture
def spy(monkeypatch):
    sent: list[dict] = []
    pushed: list[tuple] = []

    def _send(to, subject, html, **kw):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(email_service, "send_email", _send)
    monkeypatch.setattr(fmj, "_push_operators", lambda db, title, body: pushed.append((title, body)))
    return SimpleNamespace(sent=sent, pushed=pushed)


def _row(Session, service):
    db = Session()
    try:
        return db.query(MonitorState).filter(MonitorState.service == service).first()
    finally:
        db.close()


# 1 ─────────────────────────────────────────────────────────────────────
def test_development_is_disabled_and_touches_nothing(mem, spy, monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "ops@example.test")
    out = send_ops_alert("test:dev", "hello", ["x"])
    assert out is AlertOutcome.DISABLED
    assert spy.sent == []
    db = mem()
    try:
        assert db.query(MonitorState).count() == 0
    finally:
        db.close()


def test_kill_switch_disables_in_production(mem, spy, prod, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERTS_ENABLED", False)
    assert send_ops_alert("test:off", "hello", ["x"]) is AlertOutcome.DISABLED
    assert spy.sent == []


# 2 ─────────────────────────────────────────────────────────────────────
def test_no_recipient_warns_once(mem, spy, prod, monkeypatch, caplog):
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "")
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", "")
    with caplog.at_level(logging.WARNING, logger="bonbox.ops_alert"):
        assert send_ops_alert("test:none", "hello", ["x"]) is AlertOutcome.NO_RECIPIENT
        assert send_ops_alert("test:none", "hello", ["x"]) is AlertOutcome.NO_RECIPIENT
    warnings = [r for r in caplog.records if r.name == "bonbox.ops_alert"]
    assert len(warnings) == 1
    assert "ADMIN_EMAIL" in warnings[0].getMessage()
    assert spy.sent == []


# 3 ─────────────────────────────────────────────────────────────────────
def test_cooldown_dedupes_and_counts_suppressed(mem, spy, prod):
    assert send_ops_alert("test:cool", "first", ["kind: test"]) is AlertOutcome.SENT
    assert len(spy.sent) == 2                                  # once per recipient
    assert {m["to"] for m in spy.sent} == {"ops@example.test", "boss@example.test"}
    assert len(spy.pushed) == 1

    assert send_ops_alert("test:cool", "again", ["kind: test"]) is AlertOutcome.COOLDOWN
    assert len(spy.sent) == 2                                  # not called again
    row = _row(mem, ops_alert.alert_service("test:cool"))
    assert row.fail_streak == 1

    # Move the last alert back past the 360-min cooldown.
    db = mem()
    try:
        r = db.query(MonitorState).filter(
            MonitorState.service == ops_alert.alert_service("test:cool")).first()
        r.last_alert_at = r.last_alert_at - timedelta(minutes=361)
        db.commit()
    finally:
        db.close()
    assert send_ops_alert("test:cool", "third", ["kind: test"]) is AlertOutcome.SENT
    assert len(spy.sent) == 4
    assert "suppressed since last alert: 1" in spy.sent[-1]["html"]
    assert _row(mem, ops_alert.alert_service("test:cool")).fail_streak == 0


def test_caller_cooldown_override_is_used(mem, spy, prod):
    assert send_ops_alert("storage:x", "s", ["a"], cooldown_minutes=1440) is AlertOutcome.SENT
    db = mem()
    try:
        r = db.query(MonitorState).filter(
            MonitorState.service == ops_alert.alert_service("storage:x")).first()
        r.last_alert_at = r.last_alert_at - timedelta(minutes=400)   # past 360, inside 1440
        db.commit()
    finally:
        db.close()
    assert send_ops_alert("storage:x", "s", ["a"], cooldown_minutes=1440) is AlertOutcome.COOLDOWN


# 4 ─────────────────────────────────────────────────────────────────────
def test_daily_cap_holds_and_resets_next_utc_day(mem, spy, prod, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_DAILY_CAP", 2)
    assert send_ops_alert("cap:a", "a", ["1"]) is AlertOutcome.SENT
    assert send_ops_alert("cap:b", "b", ["2"]) is AlertOutcome.SENT
    assert send_ops_alert("cap:c", "c", ["3"]) is AlertOutcome.CAPPED
    assert len(spy.sent) == 4                                  # 2 messages × 2 recipients
    assert "alerts today 2/2" in spy.sent[-1]["html"]
    # The footer promises only what happens: alerts resume at 00:00 UTC, and the
    # triage digest re-offers undelivered groups for 24 h (it no longer claims
    # alerts are "held", which nothing did).
    assert "daily cap reached: no more alerts until 00:00 UTC" in spy.sent[-1]["html"]
    assert "retried for 24 h" in spy.sent[-1]["html"]
    assert "daily cap reached" not in spy.sent[0]["html"]
    assert _row(mem, ops_alert.alert_service("cap:c")).fail_streak == 1   # counted as held

    db = mem()
    try:
        day = db.query(MonitorState).filter(MonitorState.service == "alert:day").first()
        assert day.fail_streak == 2
        day.incident_entry = "2000-01-01"                      # yesterday, as far as the row knows
        db.commit()
    finally:
        db.close()
    assert send_ops_alert("cap:c", "c", ["3"]) is AlertOutcome.SENT
    assert _row(mem, "alert:day").fail_streak == 1


def test_cap_config_is_clamped(prod, monkeypatch):
    monkeypatch.setattr(settings, "OPS_ALERT_DAILY_CAP", 0)
    assert ops_alert.daily_cap() == 1
    monkeypatch.setattr(settings, "OPS_ALERT_DAILY_CAP", 9999)
    assert ops_alert.daily_cap() == 50
    assert ops_alert._cooldown(1).total_seconds() == 15 * 60
    assert ops_alert._cooldown(10 ** 6).total_seconds() == 10080 * 60


# 5 ─────────────────────────────────────────────────────────────────────
def test_real_producer_without_resend_key_is_failed_not_sent(mem, prod, monkeypatch):
    """Real email_service.send_email (no stub) with no Resend key → False for
    every recipient → FAILED. No cooldown is set (the next tick retries) and
    the reserved cap slot stays consumed. Push is the backup channel: tried
    once for the failure streak, not on every retry."""
    monkeypatch.setattr(email_service.resend, "api_key", None)
    pushed = []
    monkeypatch.setattr(fmj, "_push_operators", lambda *a: pushed.append(a))
    assert send_ops_alert("real:1", "real", ["kind: test"]) is AlertOutcome.FAILED
    row = _row(mem, ops_alert.alert_service("real:1"))
    assert row.last_alert_at is None
    assert _row(mem, "alert:day").fail_streak == 1
    assert len(pushed) == 1
    # Not COOLDOWN: the next call tries again (bounded by the daily cap).
    assert send_ops_alert("real:1", "real", ["kind: test"]) is AlertOutcome.FAILED
    assert _row(mem, "alert:day").fail_streak == 2
    assert len(pushed) == 1                                    # no second push


# 6 ─────────────────────────────────────────────────────────────────────
def test_pii_never_reaches_the_alert(mem, spy, prod):
    pii = [
        "anna@example.com",
        "+45 12 34 56 78",
        "4111111111111111",
        "3f2b8c1e-9a4d-4e2f-8b7c-1d2e3f4a5b6c",
        "Bearer abc.def.ghi",
        "<script>",
    ]
    lines = [f"guest {p} failed" for p in pii] + ["token=s3cr3tvalue", "password: hunter2"]
    out = send_ops_alert("pii:1", "Subject " + " ".join(pii), lines)
    assert out is AlertOutcome.SENT
    for m in spy.sent:
        for raw in pii + ["s3cr3tvalue", "hunter2", "abc.def.ghi", "12 34 56 78"]:
            assert raw not in m["html"], raw
            assert raw not in m["subject"], raw
        assert m["subject"].startswith("[BonBox ops] ")
        assert len(m["subject"]) <= 150
        assert "Ops alerts never contain customer data" in m["html"]
        assert "https://bonbox.dk/admin" in m["html"]
    for title, body in spy.pushed:
        for raw in pii:
            assert raw not in title and raw not in body


def test_safe_fact_caps_length_and_collapses_space():
    out = ops_alert.safe_fact("a  \n  b " + "x" * 500)
    assert out.startswith("a b ")
    assert len(out) <= 160


# 7 ─────────────────────────────────────────────────────────────────────
def test_internal_failure_is_failed_not_raised(prod, spy, monkeypatch):
    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(app.database, "SessionLocal", _boom)
    assert send_ops_alert("boom:1", "x", ["y"]) is AlertOutcome.FAILED
    assert spy.sent == []


# 8 ─────────────────────────────────────────────────────────────────────
def test_state_row_key_fits_the_column():
    for key in ("triage:" + ",".join(["f" * 16] * 20), "storage:not_durable", "test:manual"):
        assert len(ops_alert.alert_service(key)) <= 50
        assert len("alert:" + ops_alert.alert_fingerprint(key)) <= 50
    assert MonitorState.__table__.c.service.type.length == 50


# Super-admin test endpoint ────────────────────────────────────────────────
def test_admin_test_endpoint_outside_production_is_disabled(mem, spy, monkeypatch):
    from app.routers import admin as admin_router
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    assert admin_router.ops_alert_test(admin=SimpleNamespace(id="u1")) == {"outcome": "disabled"}
    assert spy.sent == []


def test_admin_test_endpoint_in_production_sends_once_then_cools_down(mem, spy, prod):
    from app.routers import admin as admin_router
    me = SimpleNamespace(id="3f2b8c1e-9a4d-4e2f-8b7c-1d2e3f4a5b6c")
    assert admin_router.ops_alert_test(admin=me) == {"outcome": "sent"}
    assert admin_router.ops_alert_test(admin=me) == {"outcome": "cooldown"}
    assert len(spy.sent) == 2                                  # one message, two recipients
    assert me.id not in spy.sent[0]["html"]                    # the UUID is stripped


# Push outside the lock; push as the backup channel (fix round) ─────────────
def test_push_runs_after_the_lock_is_released(mem, prod, monkeypatch):
    seen = []
    monkeypatch.setattr(email_service, "send_email", lambda to, s, h, **kw: True)
    monkeypatch.setattr(fmj, "_push_operators",
                        lambda db, title, body: seen.append(ops_alert._LOCK.locked()))
    assert send_ops_alert("lock:1", "x", ["y"]) is AlertOutcome.SENT
    assert seen == [False]


def test_a_hanging_push_does_not_block_other_alerts(mem, prod, monkeypatch):
    import threading

    monkeypatch.setattr(email_service, "send_email", lambda to, s, h, **kw: True)
    entered, release = threading.Event(), threading.Event()

    def _hang(db, title, body):
        if "first" in title:
            entered.set()
            release.wait(10)

    monkeypatch.setattr(fmj, "_push_operators", _hang)
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("a", send_ops_alert("hang:a", "first", ["1"])))
    t.start()
    try:
        assert entered.wait(5), "the first push never started"
        done = threading.Event()
        t2 = threading.Thread(target=lambda: (out.setdefault("b", send_ops_alert("hang:b", "second", ["2"])),
                                              done.set()))
        t2.start()
        assert done.wait(5), "a second alert waited on the first alert's push"
        assert out["b"] is AlertOutcome.SENT
    finally:
        release.set()
        t.join(10)
    assert out["a"] is AlertOutcome.SENT


def test_failed_email_pushes_once_per_failure_streak(mem, prod, monkeypatch):
    """E-mail down: push is the backup channel, once per key until an e-mail
    gets through again (no push every tick)."""
    mail_ok = {"v": False}
    monkeypatch.setattr(email_service, "send_email", lambda to, s, h, **kw: mail_ok["v"])
    pushed = []
    monkeypatch.setattr(fmj, "_push_operators", lambda db, title, body: pushed.append(title))
    assert send_ops_alert("streak:1", "streak", ["kind: test"]) is AlertOutcome.FAILED
    assert send_ops_alert("streak:1", "streak", ["kind: test"]) is AlertOutcome.FAILED
    assert len(pushed) == 1
    assert _row(mem, ops_alert.alert_service("streak:1")).last_alert_at is None   # no cooldown

    mail_ok["v"] = True
    assert send_ops_alert("streak:1", "streak", ["kind: test"]) is AlertOutcome.SENT
    assert len(pushed) == 2
    # After the cooldown, a new mail outage pushes once again.
    db = mem()
    try:
        r = db.query(MonitorState).filter(
            MonitorState.service == ops_alert.alert_service("streak:1")).first()
        r.last_alert_at = r.last_alert_at - timedelta(minutes=361)
        db.commit()
    finally:
        db.close()
    mail_ok["v"] = False
    assert send_ops_alert("streak:1", "streak", ["kind: test"]) is AlertOutcome.FAILED
    assert send_ops_alert("streak:1", "streak", ["kind: test"]) is AlertOutcome.FAILED
    assert len(pushed) == 3


def test_a_raising_push_never_changes_the_outcome(mem, prod, monkeypatch):
    monkeypatch.setattr(email_service, "send_email", lambda to, s, h, **kw: True)

    def _boom(db, title, body):
        raise RuntimeError("push down")

    monkeypatch.setattr(fmj, "_push_operators", _boom)
    assert send_ops_alert("pushboom:1", "x", ["y"]) is AlertOutcome.SENT
    assert _row(mem, ops_alert.alert_service("pushboom:1")).last_alert_at is not None
