"""jobs/ops_triage_job — the in-process 15-minute ops triage (R-i, OPS-04).

Pins: production-only; one digest per tick with group lines only (no error
messages, so no guest names or allergy notes); CLIENT beacon rows excluded;
a watermark that never double-counts; no LLM on the automatic path; the
storage standing check; a failing tick alerts directly and does not advance
the watermark; and the manual run_triage's honest email_sent flag. Fix round:
a digest that is not SENT (FAILED, CAPPED, or a tick that failed after the
notes were written) is re-offered on later ticks for 24 h, and the automatic
path stores no copy of the error message.
"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database
import app.jobs.frontend_monitor_job as fmj
import app.jobs.ops_triage_job as otj
import app.services.email_service as email_service
import app.services.storage as storage
import app.services.triage_service as triage_service
from app.config import settings
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.models.error_log import ErrorLog
from app.models.monitor_state import MonitorState
from app.models.triage_note import TriageNote
from app.services import ops_alert
from app.services.ops_alert import AlertOutcome
from app.utils.time import utc_now

T0 = utc_now()
_TB = 'Traceback (most recent call last):\n  File "/srv/app/routers/x.py", line 10, in f\n    boom()\nRuntimeError: boom'


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
    return TestSession


@pytest.fixture
def prod(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "OPS_ALERTS_ENABLED", True)
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "ops@example.test")
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", "")
    monkeypatch.setattr(storage, "get_storage", lambda: SimpleNamespace(is_durable=True))


@pytest.fixture
def alerts(monkeypatch):
    calls: list[dict] = []

    def _rec(dedupe_key, subject, lines, *, cooldown_minutes=None):
        calls.append({"key": dedupe_key, "subject": subject, "lines": list(lines),
                      "cooldown_minutes": cooldown_minutes})
        return AlertOutcome.SENT

    monkeypatch.setattr(ops_alert, "send_ops_alert", _rec)
    return calls


@pytest.fixture
def clock(monkeypatch):
    now = {"t": T0}
    monkeypatch.setattr(otj, "utc_now", lambda: now["t"])
    return now


def _seed(Session, **k):
    db = Session()
    try:
        row = ErrorLog(**k)
        db.add(row)
        db.commit()
    finally:
        db.close()


def _seed_standard(Session):
    for _ in range(2):
        _seed(Session, method="POST", path="/api/daily-close", status_code=500,
              error_type="RuntimeError", message="Anna Jensen allergy: nuts",
              traceback=_TB, created_at=T0 - timedelta(minutes=10))
    _seed(Session, method="JOB", path="job:daily_maintenance", status_code=None,
          error_type="JobStep:error_log_retention_error", message="x",
          created_at=T0 - timedelta(minutes=9))
    _seed(Session, method="CLIENT", path="/dashboard", status_code=0,
          error_type="ChunkLoadError", message="client beacon",
          created_at=T0 - timedelta(minutes=8))


def _count(Session, model):
    db = Session()
    try:
        return db.query(model).count()
    finally:
        db.close()


# 1 ─────────────────────────────────────────────────────────────────────
def test_non_production_is_skipped(mem, alerts, monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    _seed_standard(mem)
    assert otj.run_ops_triage_tick() == {"skipped": "non_production"}
    assert _count(mem, TriageNote) == 0
    assert _count(mem, MonitorState) == 0
    assert alerts == []


# 2 ─────────────────────────────────────────────────────────────────────
def test_one_digest_with_group_lines_and_no_customer_text(mem, prod, alerts, clock):
    _seed_standard(mem)
    out = otj.run_ops_triage_tick()
    assert out["new_notes"] == 2
    assert out["rows"] == 3                                    # CLIENT row excluded
    assert not any(k.endswith("_error") for k in out)
    assert _count(mem, TriageNote) == 2

    digests = [c for c in alerts if c["key"].startswith("triage:")]
    assert len(digests) == 1
    d = digests[0]
    assert d["subject"] == "2 new error group(s) on prod"
    assert d["lines"][0] == "error rows in window: 3"
    group_lines = d["lines"][1:]
    assert len(group_lines) == 2
    assert any("RuntimeError | /api/daily-close | 2x | fp " in ln for ln in group_lines)
    assert any("JobStep:error_log_retention_error | job:daily_maintenance | 1x" in ln
               for ln in group_lines)
    text = d["subject"] + " ".join(d["lines"])
    for word in ("Anna", "allergy", "nuts", "ChunkLoadError"):
        assert word not in text
    # The dedupe key is the sorted fingerprints of the new groups.
    db = mem()
    try:
        fps = sorted(n.fingerprint for n in db.query(TriageNote).all())
    finally:
        db.close()
    assert d["key"] == "triage:" + ",".join(fps)


def test_digest_through_the_real_sender_has_no_customer_text(mem, prod, clock, monkeypatch):
    sent = []
    monkeypatch.setattr(email_service, "send_email",
                        lambda to, s, h, **kw: sent.append((s, h)) or True)
    monkeypatch.setattr(fmj, "_push_operators", lambda *a: None)
    _seed_standard(mem)
    out = otj.run_ops_triage_tick()
    assert out["digest"] == "sent"
    assert len(sent) == 1
    subject, html = sent[0]
    for word in ("Anna", "Jensen", "allergy", "nuts", "Traceback", "boom()"):
        assert word not in subject and word not in html


# 3 ─────────────────────────────────────────────────────────────────────
def test_watermark_never_rescans_or_double_counts(mem, prod, alerts, clock):
    _seed_standard(mem)
    otj.run_ops_triage_tick()
    assert len(alerts) == 1

    # Second tick, nothing new → no digest.
    clock["t"] = T0 + timedelta(minutes=2)
    out = otj.run_ops_triage_tick()
    assert out["rows"] == 0 and out["new_notes"] == 0
    assert len(alerts) == 1

    # A new row with an existing fingerprint → no new note, count +1 exactly.
    _seed(mem, method="POST", path="/api/daily-close", status_code=500,
          error_type="RuntimeError", message="again", traceback=_TB,
          created_at=T0 + timedelta(minutes=3))
    clock["t"] = T0 + timedelta(minutes=5)
    out = otj.run_ops_triage_tick()
    assert out["rows"] == 1 and out["new_notes"] == 0 and out["skipped"] == 1
    assert len(alerts) == 1
    db = mem()
    try:
        note = db.query(TriageNote).filter(TriageNote.path_template == "/api/daily-close").one()
        assert note.occurrence_count == 3
        st = db.query(MonitorState).filter(MonitorState.service == "ops_triage").one()
        assert st.last_check_at == T0 + timedelta(minutes=5) - timedelta(seconds=30)
    finally:
        db.close()


def test_first_tick_looks_back_at_most_24h(mem, prod, alerts, clock):
    _seed(mem, method="GET", path="/api/old", status_code=500, error_type="OldError",
          traceback="x", created_at=T0 - timedelta(hours=30))
    out = otj.run_ops_triage_tick()
    assert out["rows"] == 0
    assert alerts == []


# 4 ─────────────────────────────────────────────────────────────────────
def test_automatic_path_never_calls_the_llm(mem, prod, alerts, clock, monkeypatch):
    def _llm(*a, **k):
        raise AssertionError("LLM must not be called on the job path")

    monkeypatch.setattr(triage_service, "_try_llm_triage", _llm)
    monkeypatch.setattr(settings, "USE_CLAUDE_API", True)
    _seed_standard(mem)
    out = otj.run_ops_triage_tick()
    assert "ops_triage_failed" not in out
    assert out["new_notes"] == 2
    db = mem()
    try:
        assert all(n.polished_by_ai is False for n in db.query(TriageNote).all())
    finally:
        db.close()


# 5 ─────────────────────────────────────────────────────────────────────
def test_storage_standing_check_alerts_once_a_day(mem, prod, alerts, clock, monkeypatch):
    monkeypatch.setattr(storage, "get_storage", lambda: SimpleNamespace(is_durable=False))
    out = otj.run_ops_triage_tick()
    st = [c for c in alerts if c["key"] == "storage:not_durable"]
    assert len(st) == 1
    assert st[0]["cooldown_minutes"] == 1440
    assert st[0]["subject"] == "File storage is NOT durable in production"
    assert out["storage"].startswith("not_durable")


def test_durable_storage_sends_nothing(mem, prod, alerts, clock):
    out = otj.run_ops_triage_tick()
    assert out["storage"] == "durable"
    assert alerts == []


# 6 ─────────────────────────────────────────────────────────────────────
def test_failing_tick_alerts_directly_and_keeps_the_watermark(mem, prod, alerts, clock, monkeypatch):
    otj.run_ops_triage_tick()                                   # sets the watermark
    db = mem()
    try:
        first = db.query(MonitorState).filter(MonitorState.service == "ops_triage").one().last_check_at
    finally:
        db.close()

    def _boom(*a, **k):
        raise RuntimeError("triage exploded with Anna's data")

    monkeypatch.setattr(triage_service, "run_triage", _boom)
    clock["t"] = T0 + timedelta(minutes=15)
    assert otj.run_ops_triage_tick() == {"ops_triage_failed": True}
    errs = [c for c in alerts if c["key"] == "job_error:ops_triage"]
    assert len(errs) == 1
    assert errs[0]["lines"] == ["error_type: RuntimeError"]
    db = mem()
    try:
        st = db.query(MonitorState).filter(MonitorState.service == "ops_triage").one()
        assert st.last_check_at == first                        # not advanced
    finally:
        db.close()


def test_tick_never_raises_even_without_a_database(prod, alerts, monkeypatch):
    def _no_db():
        raise RuntimeError("no db")

    monkeypatch.setattr(app.database, "SessionLocal", _no_db)
    assert otj.run_ops_triage_tick() == {"ops_triage_failed": True}


# 7 ─────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("delivered", [False, True])
def test_manual_run_triage_email_sent_is_honest(mem, monkeypatch, delivered):
    monkeypatch.setattr(settings, "ADMIN_EMAIL", "ops@example.test")
    monkeypatch.setattr(triage_service, "_try_llm_triage", lambda s: None)
    monkeypatch.setattr(triage_service, "send_email", lambda to, s, h: delivered)
    _seed(mem, method="GET", path="/api/x", status_code=500, error_type="KeyError",
          traceback="x", created_at=utc_now() - timedelta(minutes=5))
    db = mem()
    try:
        res = triage_service.run_triage(db, window_minutes=60, send_emails=True)
        assert len(res.new_notes) == 1
        assert res.new_notes[0].email_sent is delivered
    finally:
        db.close()


# Route templates in the digest ────────────────────────────────────────────
def test_digest_names_route_templates_not_path_values():
    import app.main  # noqa: F401 — the live app's routes
    assert otj._route_template("/api/public/reservations/cafe-anna/availability") == \
        "/api/public/reservations/{slug}/availability"
    assert otj._route_template("/api/billing/stripe/webhook") == "/api/billing/stripe/webhook"
    assert otj._route_template("job:daily_maintenance") == "job:daily_maintenance"
    assert otj._route_template(None) == "-"


# Undelivered digests are re-offered (fix round) ─────────────────────────────
@pytest.fixture
def scripted(monkeypatch):
    """send_ops_alert stub that answers from a script (then SENT)."""
    calls: list[dict] = []
    script: list[AlertOutcome] = []

    def _rec(dedupe_key, subject, lines, *, cooldown_minutes=None):
        calls.append({"key": dedupe_key, "subject": subject, "lines": list(lines)})
        return script.pop(0) if script else AlertOutcome.SENT

    monkeypatch.setattr(ops_alert, "send_ops_alert", _rec)
    return SimpleNamespace(calls=calls, script=script)


def _notes(Session):
    db = Session()
    try:
        return [(n.fingerprint, bool(n.email_sent)) for n in db.query(TriageNote).all()]
    finally:
        db.close()


@pytest.mark.parametrize("first", [AlertOutcome.FAILED, AlertOutcome.CAPPED])
def test_undelivered_digest_is_sent_on_a_later_tick(mem, prod, clock, scripted, first):
    """Tick 1's digest is FAILED (Resend down) or CAPPED; its notes are not
    marked delivered. Tick 2 — the same bug recurs, no new note — re-offers
    the same groups under the same key; SENT marks them, so tick 3 is quiet."""
    scripted.script.append(first)
    _seed_standard(mem)
    out1 = otj.run_ops_triage_tick()
    assert out1["digest"] == first.value
    assert out1["new_notes"] == 2
    assert all(sent is False for _, sent in _notes(mem))

    _seed(mem, method="POST", path="/api/daily-close", status_code=500,
          error_type="RuntimeError", message="again", traceback=_TB,
          created_at=T0 + timedelta(minutes=3))
    clock["t"] = T0 + timedelta(minutes=15)
    out2 = otj.run_ops_triage_tick()
    assert out2["new_notes"] == 0 and out2["skipped"] == 1
    assert out2["digest"] == "sent"
    digests = [c for c in scripted.calls if c["key"].startswith("triage:")]
    assert len(digests) == 2
    assert digests[1]["key"] == digests[0]["key"]               # the same groups
    assert any("RuntimeError | /api/daily-close" in ln for ln in digests[1]["lines"])
    assert all(sent is True for _, sent in _notes(mem))

    clock["t"] = T0 + timedelta(minutes=30)
    out3 = otj.run_ops_triage_tick()
    assert out3["digest"] is None
    assert len([c for c in scripted.calls if c["key"].startswith("triage:")]) == 2


def test_capped_digest_goes_out_after_the_utc_day_rolls(mem, prod, clock, monkeypatch):
    """Through the real sender: the cap is used up, the digest is CAPPED, and
    the first tick of the next UTC day delivers the held group."""
    sent = []
    monkeypatch.setattr(settings, "OPS_ALERT_DAILY_CAP", 1)
    monkeypatch.setattr(email_service, "send_email",
                        lambda to, s, h, **kw: sent.append((s, h)) or True)
    monkeypatch.setattr(fmj, "_push_operators", lambda *a: None)
    assert ops_alert.send_ops_alert("other:x", "x", ["y"]) is AlertOutcome.SENT
    _seed_standard(mem)
    assert otj.run_ops_triage_tick()["digest"] == "capped"
    assert len(sent) == 1
    assert "retried for 24 h" in sent[0][1]                      # the footer is true

    db = mem()
    try:
        day = db.query(MonitorState).filter(MonitorState.service == "alert:day").one()
        day.incident_entry = "2000-01-01"                        # a new UTC day
        db.commit()
    finally:
        db.close()
    clock["t"] = T0 + timedelta(minutes=15)
    out = otj.run_ops_triage_tick()
    assert out["digest"] == "sent"
    assert len(sent) == 2
    assert "2 new error group(s) on prod" in sent[1][0]
    assert all(s is True for _, s in _notes(mem))


def test_notes_older_than_24h_are_not_re_offered(mem, prod, clock, scripted):
    scripted.script.append(AlertOutcome.FAILED)
    _seed_standard(mem)
    otj.run_ops_triage_tick()
    clock["t"] = T0 + timedelta(hours=25)
    out = otj.run_ops_triage_tick()
    assert out["digest"] is None
    assert len([c for c in scripted.calls if c["key"].startswith("triage:")]) == 1


def test_tick_that_fails_after_notes_were_written_does_not_lose_them(mem, prod, clock, scripted, monkeypatch):
    real = otj._digest_lines

    def _boom(*a, **k):
        raise RuntimeError("digest build failed")

    monkeypatch.setattr(otj, "_digest_lines", _boom)
    _seed_standard(mem)
    assert otj.run_ops_triage_tick() == {"ops_triage_failed": True}
    assert len(_notes(mem)) == 2

    monkeypatch.setattr(otj, "_digest_lines", real)
    clock["t"] = T0 + timedelta(minutes=15)
    out = otj.run_ops_triage_tick()
    assert out["digest"] == "sent"
    assert all(s is True for _, s in _notes(mem))


# The automatic path stores no message text (fix round, retention) ─────────────
def test_automatic_path_stores_no_message_text(mem, prod, alerts, clock):
    _seed(mem, method="POST", path="/api/reservations", status_code=500,
          error_type="IntegrityError", message="Anna Jensen +4512345678 allergy: nuts",
          traceback=_TB, created_at=T0 - timedelta(minutes=5))
    otj.run_ops_triage_tick()
    db = mem()
    try:
        note = db.query(TriageNote).one()
        assert not note.sample_message
        for col in ("probable_cause", "blast_radius", "suggested_actions"):
            text = getattr(note, col) or ""
            for word in ("Anna", "4512345678", "allergy", "nuts"):
                assert word not in text
    finally:
        db.close()


def test_manual_run_triage_still_keeps_its_sanitized_sample(mem, monkeypatch):
    monkeypatch.setattr(triage_service, "_try_llm_triage", lambda s: None)
    _seed(mem, method="GET", path="/api/x", status_code=500, error_type="KeyError",
          message="lookup failed for key x", traceback="x",
          created_at=utc_now() - timedelta(minutes=5))
    db = mem()
    try:
        res = triage_service.run_triage(db, window_minutes=60, send_emails=False)
        assert res.new_notes[0].sample_message == "lookup failed for key x"
    finally:
        db.close()


# Billing:* groups first, never dropped for the cap (review, 12 Oct) ─────────
_BILLING = "Billing:SecondLiveSubscription"


def _seed_flood_and_alarms(Session, n_other=25, n_billing=2):
    """n_other distinct NEWER error groups and n_billing OLDER billing alarms:
    run_triage walks groups newest-first, so the alarms come last."""
    for i in range(n_billing):
        _seed(Session, method="WEBHOOK", path="/api/billing/stripe/webhook", status_code=None,
              error_type=_BILLING, message=f"second live subscription: sub_A{i} -> sub_B{i}",
              created_at=T0 - timedelta(minutes=20) + timedelta(seconds=i))
    for i in range(n_other):
        _seed(Session, method="GET", path=f"/api/flood{i}", status_code=500,
              error_type=f"FloodError{i}", traceback=_TB,
              created_at=T0 - timedelta(minutes=10) + timedelta(seconds=i))


def _billing_notes(Session):
    db = Session()
    try:
        return db.query(TriageNote).filter(TriageNote.error_type == _BILLING).count()
    finally:
        db.close()


def test_billing_alarms_are_noted_even_when_20_other_groups_land(mem, prod, alerts, clock):
    _seed_flood_and_alarms(mem, n_other=25, n_billing=2)
    out = otj.run_ops_triage_tick()
    assert _billing_notes(mem) == 2, "a billing alarm was dropped by the 20-group cap"
    assert out["new_notes"] == 22                  # 2 billing + the 20-group cap
    digest = [c for c in alerts if c["key"].startswith("triage:")][0]
    db = mem()
    try:
        fps = {n.fingerprint for n in db.query(TriageNote).filter(TriageNote.error_type == _BILLING)}
    finally:
        db.close()
    assert all(fp in digest["key"] for fp in fps)


def test_billing_alarms_beyond_the_2000_row_bound_are_read(mem, prod, alerts, clock, monkeypatch):
    _seed_flood_and_alarms(mem, n_other=3, n_billing=1)
    # Squeeze the safety bound so the older alarm row falls outside it.
    from sqlalchemy.orm import Query
    orig = Query.limit
    monkeypatch.setattr(Query, "limit", lambda self, n: orig(self, 3 if n == 2000 else n))
    otj.run_ops_triage_tick()
    assert _billing_notes(mem) == 1


def test_watermark_stops_at_an_unnoted_billing_row(mem, prod, alerts, clock, monkeypatch):
    monkeypatch.setattr(triage_service, "MAX_BILLING_TRIAGES_PER_RUN", 1)
    _seed_flood_and_alarms(mem, n_other=0, n_billing=2)
    out = otj.run_ops_triage_tick()
    assert out["new_notes"] == 1
    db = mem()
    try:
        st = db.query(MonitorState).filter(MonitorState.service == "ops_triage").one()
        second = db.query(ErrorLog).filter(ErrorLog.message.like("%sub_A1 -> sub_B1")).one()
        assert st.last_check_at == second.created_at   # not past the un-noted alarm
    finally:
        db.close()
    clock["t"] = T0 + timedelta(minutes=15)
    otj.run_ops_triage_tick()
    assert _billing_notes(mem) == 2
