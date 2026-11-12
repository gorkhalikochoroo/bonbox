"""Egenkontrol R1a — the "Needs du nu" detector (egenkontrol_due).

It reads the ONE status module, so the queue says what the Egenkontrol page
and the kitchen iPad say: warn for a missing reading, urgent for an open
deviation, nothing without active checks, nothing for the accountant view.
"""
from datetime import timedelta

from app.services import diagnostics_service as ds
from tests._ek_support import T0, env  # noqa: F401 — fixture


def _finding(env, user):
    db = env.SL()
    try:
        u = db.merge(user)
        return next((f for f in ds.run_diagnostics(db, u) if f["code"] == "egenkontrol_due"), None)
    finally:
        db.close()


def test_no_checks_no_finding(env):
    o = env.owner()
    env.clock.set(T0 + timedelta(hours=4))
    assert _finding(env, o) is None


def test_nothing_due_yet_no_finding(env):
    o = env.owner()
    env.setup(o)
    assert _finding(env, o) is None          # 07:30, fridge due 08:00


def test_an_overdue_reading_is_a_warning(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))   # 09:30: fridge + freezer overdue
    f = _finding(env, o)
    assert f == {"code": "egenkontrol_due", "severity": "warn", "deep_link": "/egenkontrol",
                 "meta": {"date": "2026-11-12", "missing": 2, "deviations": 0, "count": 2}}


def test_an_open_deviation_is_urgent(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    r = env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    assert r.status_code == 201
    f = _finding(env, o)
    assert f["severity"] == "urgent" and f["meta"]["deviations"] == 1 and f["meta"]["missing"] == 0


def test_never_for_the_accountant_view(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))
    db = env.SL()
    try:
        u = db.merge(o)
        u._is_accountant_view = True
        assert not [f for f in ds.run_diagnostics(db, u) if f["code"] == "egenkontrol_due"]
    finally:
        db.close()


def test_the_needs_you_endpoint_carries_it(env):
    o = env.owner()
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))
    r = env.client.get("/api/diagnostics/needs-you", headers=env.h(o))
    assert r.status_code == 200, r.text
    body = r.json()
    items = body if isinstance(body, list) else (body.get("findings") or body.get("items") or [])
    assert any(i["code"] == "egenkontrol_due" and i["deep_link"] == "/egenkontrol" for i in items), body
