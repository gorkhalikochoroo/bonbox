"""
public_surface_check + public_surface_monitor_job — the false-alarm-proof + flap
guarantees. A monitor that cries wolf is worse than none, so these lock:
  • dead_on_arrival fires ONLY on 0 availability across the whole 14-day horizon
    — "closed today, open this week" (the /bistro case) is NEVER flagged.
  • stale_meta reads the resolved venue name (data source), never HTTP.
  • FLAP: 2 consecutive unhealthy ticks → DEGRADED + exactly one alert; 2 green → OK.

Run: cd backend && python3 -m pytest tests/test_public_surface_check.py -q
"""
import uuid
from types import SimpleNamespace
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.services.public_surface_check as psc
import app.jobs.public_surface_monitor_job as job
from app.models.surface_finding import SurfaceFinding

_NOW = datetime(2026, 7, 5, 12, 0, tzinfo=ZoneInfo("Europe/Copenhagen"))
_UID = "11111111-1111-1111-1111-111111111111"


def _prof(name="Café Nord", slug="cafenord"):
    return SimpleNamespace(reservation_slug=slug, user_id=_UID, company_name=name)


def _owner(name="Café Nord"):
    return SimpleNamespace(id=_UID, business_name=name)


def _week(open_days):
    """A 14-day summary with `open_days` open."""
    days = [{"date": f"2026-07-{5+i:02d}", "has_slots": i < open_days} for i in range(14)]
    nxt = next((d["date"] for d in days if d["has_slots"]), None)
    return {"next_open_day": nxt, "days": days}


# ── detectors ──────────────────────────────────────────────────────
def test_not_dead_when_week_has_open_days(monkeypatch):
    """The /bistro case: closed today but open this week → NEVER dead_on_arrival."""
    monkeypatch.setattr(psc.rsvc, "summarize_days",
                        lambda *a, **k: {"next_open_day": "2026-07-06",
                                         "days": [{"date": "2026-07-05", "has_slots": False},
                                                  {"date": "2026-07-06", "has_slots": True}]})
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1, 2, 3])
    res = psc.check_slug(None, profile=_prof(), owner=_owner(), now=_NOW)
    assert "dead_on_arrival" not in res["codes"]
    assert res["healthy"] is True


def test_dead_only_when_zero_open_days(monkeypatch):
    monkeypatch.setattr(psc.rsvc, "summarize_days", lambda *a, **k: _week(0))
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1])
    res = psc.check_slug(None, profile=_prof(), owner=_owner(), now=_NOW)
    assert "dead_on_arrival" in res["codes"]
    assert res["severity"] == "urgent"


def test_stale_meta_on_default_name_is_warn_not_urgent(monkeypatch):
    monkeypatch.setattr(psc.rsvc, "summarize_days", lambda *a, **k: _week(6))
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1])
    res = psc.check_slug(None, profile=_prof(name=""), owner=_owner(name="BonBox"), now=_NOW)
    assert "stale_meta" in res["codes"]
    assert res["severity"] == "warn"       # not urgent → no intrusive alert


def test_no_bookable_resources(monkeypatch):
    monkeypatch.setattr(psc.rsvc, "summarize_days", lambda *a, **k: _week(0))
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [])
    res = psc.check_slug(None, profile=_prof(), owner=_owner(), now=_NOW)
    assert "no_bookable_resources" in res["codes"]
    assert "dead_on_arrival" in res["codes"]


def test_probe_error_is_inconclusive_not_a_defect(monkeypatch):
    """A probe error must NOT masquerade as dead_on_arrival (never cry wolf on our bug)."""
    def boom(*a, **k):
        raise RuntimeError("db hiccup")
    monkeypatch.setattr(psc.rsvc, "summarize_days", boom)
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1])
    res = psc.check_slug(None, profile=_prof(), owner=_owner(), now=_NOW)
    assert "dead_on_arrival" not in res["codes"]


# ── flap logic ─────────────────────────────────────────────────────
@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _res(healthy, codes=None, sev=None):
    return {"healthy": healthy, "codes": codes or [], "detail": {}, "severity": sev, "summary": "s"}


def test_flap_two_ticks_to_degrade_alert_once_then_recover(db, monkeypatch):
    monkeypatch.setattr(job, "_write_incident", lambda *a, **k: None)
    calls = {"alert": 0}
    monkeypatch.setattr(job, "_alert_operator", lambda *a, **k: calls.__setitem__("alert", calls["alert"] + 1))
    prof = _prof()
    bad = _res(False, ["dead_on_arrival"], "urgent")
    good = _res(True)

    def state():
        return db.query(SurfaceFinding).filter(SurfaceFinding.slug == "cafenord").first().state

    job._apply(db, prof, bad, _NOW);  assert state() == "OK"        # 1 fail → still OK
    job._apply(db, prof, bad, _NOW);  assert state() == "DEGRADED"  # 2 → DEGRADED
    assert calls["alert"] == 1
    job._apply(db, prof, bad, _NOW);  assert calls["alert"] == 1    # still broken → no re-alert
    job._apply(db, prof, good, _NOW); assert state() == "DEGRADED"  # 1 green → not yet
    job._apply(db, prof, good, _NOW); assert state() == "OK"        # 2 green → recovered


def test_warn_never_sends_intrusive_alert(db, monkeypatch):
    monkeypatch.setattr(job, "_write_incident", lambda *a, **k: None)
    calls = {"alert": 0}
    monkeypatch.setattr(job, "_alert_operator", lambda *a, **k: calls.__setitem__("alert", calls["alert"] + 1))
    prof = _prof()
    warn = _res(False, ["stale_meta"], "warn")
    job._apply(db, prof, warn, _NOW)
    job._apply(db, prof, warn, _NOW)   # → DEGRADED, but warn
    row = db.query(SurfaceFinding).filter(SurfaceFinding.slug == "cafenord").first()
    assert row.state == "DEGRADED"
    assert calls["alert"] == 0          # a demo's missing name never pages anyone
