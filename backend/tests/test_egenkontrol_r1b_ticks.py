"""Egenkontrol R1b — cleaning and thermometer ticks.

"Udført", no value, no limit, no deviation. On-event only, so a day without
cleaning is never "Ikke registreret". They do NOT count toward the plan's
limit (founder, 13 Nov 2026: temperature checks only, on every plan).
"""
import io
import uuid

from pypdf import PdfReader

from tests._ek_support import env, store  # noqa: F401 — fixtures


def _tick(env, o, key="cleaning", name="Rengøring"):
    r = env.client.post("/api/egenkontrol/checks", json={"template_key": key, "name": name},
                        headers=env.h(o))
    assert r.status_code == 201, r.text
    return r.json()


def _done(env, o, check_id, **kw):
    body = {"client_id": str(uuid.uuid4()), "check_id": check_id, "done": True,
            "typed_name": "Mia", **kw}
    return env.client.post("/api/egenkontrol/entries", json=body, headers=env.h(o))


def test_the_templates_list_both_ticks(env):
    o = env.owner()
    t = {x["key"]: x for x in env.client.get("/api/egenkontrol/templates",
                                             headers=env.h(o)).json()["templates"]}
    for key, group in (("cleaning", "cleaning"), ("thermometer", "other")):
        assert t[key]["kind"] == "tick" and t[key]["group_key"] == group
        assert t[key]["limit"] is None and t[key]["product_limits"] is None
        assert t[key]["schedule_options"] == ["on_event"]
        assert t[key]["schedule_default"] == {"type": "on_event"}
        assert t[key]["action_codes"] == [] and t[key]["fate_codes"] == []


def test_a_tick_is_not_counted_and_saves_done_with_its_note(env):
    o = env.owner()
    env.setup(o)
    c = _tick(env, o)
    assert c["kind"] == "tick" and c["limit"] is None and c["schedule"] == {"type": "on_event"}
    st = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert st["cap"]["active"] == 5                 # the 5 temperature checks; the tick is not counted
    assert st["active_checks"] == 6                 # …but it is an active check like the others
    note = "Gulv & <b>afløb</b>"
    r = _done(env, o, c["id"], action_note=note)
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["done"] is True and e["value_c"] is None and e["in_limit"] is None
    assert e["deviation_state"] is None and e["limit_c"] is None and e["late"] is False
    assert e["action_note"] == note and e["slot_due_at"] is None


def test_tick_refusals(env):
    o = env.owner()
    c = _tick(env, o)
    r = _done(env, o, c["id"], value_c=3.0)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "value_not_allowed"
    body = {"client_id": str(uuid.uuid4()), "check_id": c["id"], "typed_name": "Mia"}
    r = env.client.post("/api/egenkontrol/entries", json=body, headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "done_required"
    r = env.client.post("/api/egenkontrol/checks", headers=env.h(o), json={
        "template_key": "cleaning", "name": "R", "schedule": {"type": "daily", "due": "08:00"}})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "schedule_not_allowed"
    r = env.client.post("/api/egenkontrol/checks", headers=env.h(o), json={
        "template_key": "thermometer", "name": "T", "limit_c": 1.0})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "limit_not_allowed"
    r = env.client.patch(f"/api/egenkontrol/checks/{c['id']}", json={"limit_c": 2.0},
                         headers=env.h(o))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "limit_not_allowed"
    fresh = env.owner(name="Ny")
    r = env.client.post("/api/egenkontrol/setup", headers=env.h(fresh), json={"items": [
        {"template_key": "fridge", "name": "Køl"},
        {"template_key": "cleaning", "name": "R", "limit_c": 3.0}]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "limit_not_allowed"
    assert env.client.get("/api/egenkontrol/checks", headers=env.h(fresh)).json()["checks"] == []


def test_a_tick_is_never_missed(env):
    o = env.owner()
    env.setup(o)
    c = _tick(env, o)
    row = next(x for x in env.today_json(o)["checks"] if x["id"] == c["id"])
    assert row["status"] == "on_event"
    _done(env, o, c["id"])
    env.clock.tick(days=3)
    f = env.folder(o)
    assert not [m for m in f["missed"] if m["check_id"] == c["id"]]
    row = next(x for x in env.today_json(o)["checks"] if x["id"] == c["id"])
    assert row["status"] == "on_event" and row["last"] is None


def test_the_pdf_prints_udfoert_and_the_escaped_note(env):
    o = env.owner()
    env.setup(o)
    c = _tick(env, o)
    _done(env, o, c["id"], action_note="Gulv & <b>afløb</b>")
    r = env.client.get("/api/egenkontrol/folder.pdf", headers=env.h(o))
    assert r.status_code == 200
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(r.content)).pages)
    assert "Udført" in text
    assert "Note: Gulv & <b>afløb</b>" in text


def test_no_photo_on_a_tick(env, store):
    o = env.owner()
    c = _tick(env, o)
    e = _done(env, o, c["id"]).json()
    r = env.photo(o, e["id"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "photo_not_allowed"
