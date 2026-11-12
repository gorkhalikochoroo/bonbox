"""Egenkontrol R1b — "Fra papir" (owner only, at most 14 days back).

The reading's slot, late and business day follow the MEASURED time; its
recorded_at is when it was typed in; both times are always shown. Out of
limit it must carry a closing fate, and it never opens, closes or reopens
another reading.
"""
import uuid
from datetime import date, datetime, timedelta

from app.models.food_check import FoodCheckEntry
from tests._ek_support import T0, env  # noqa: F401 — fixture

# T0 = Thu 12 Nov 2026 07:30 Copenhagen; the checks are created then.
T1 = T0 + timedelta(days=14)          # Thu 26 Nov 2026 07:30 Copenhagen


def _setup(env, **kw):
    o = env.owner(**kw)
    checks = env.setup(o)
    env.clock.set(T1)
    return o, checks


def _rows(env, uid):
    env.db.expire_all()
    return env.db.query(FoodCheckEntry).filter(FoodCheckEntry.user_id == uid).all()


def test_the_14_day_window_and_no_future(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    r = env.paper(o, fridge, 3.0, "2026-11-11", "07:30")          # 15 days back
    assert r.status_code == 422 and r.json()["detail"] == {"code": "paper_too_old", "max_days": 14}
    r = env.paper(o, fridge, 3.0, "2026-11-12", "07:31")          # 14 d − 1 min
    assert r.status_code == 201, r.text
    r = env.paper(o, fridge, 3.0, "2026-11-26", "07:31")          # 1 minute ahead
    assert r.status_code == 422 and r.json()["detail"]["code"] == "paper_in_future"
    r = env.paper(o, fridge, 3.0, "2026-11-20", "25:00")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_time"


def test_only_the_owner_types_paper_entries(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    for role in ("manager", "cashier"):
        m = env.member(o, role)
        r = env.paper(o, fridge, 3.0, "2026-11-25", "08:10", headers=env.h(m))
        assert r.status_code == 403, (role, r.text)
    acc = env.accountant(o)
    assert env.paper(o, fridge, 3.0, "2026-11-25", "08:10", headers=env.h(acc)).status_code == 403
    token = env.pair(o)
    r = env.client.post(f"/api/kitchen/{token}/paper-entries", json={
        "client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3.0,
        "measured_date": "2026-11-25", "measured_time": "08:10", "paper_reason": "x",
        "typed_name": "Bo"})
    assert r.status_code in (404, 405)
    assert _rows(env, o.id) == []


def test_the_reason_is_required_verbatim_and_never_cut(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    r = env.paper(o, fridge, 3.0, "2026-11-25", "08:10", reason="   ")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "paper_reason_required"
    r = env.paper(o, fridge, 3.0, "2026-11-25", "08:10", reason="x" * 121)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "paper_reason_too_long"
    reason = "  Nettet <b>nede</b> & iPad død  "
    r = env.paper(o, fridge, 3.0, "2026-11-25", "08:10", reason=reason)
    assert r.status_code == 201
    assert r.json()["reason_text"] == reason


def test_times_both_dates_and_the_missed_slot_gets_filled(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    before = env.folder(o, **{"from": "2026-11-25", "to": "2026-11-25"})
    assert [m["date"] for m in before["missed"] if m["check_id"] == fridge] == ["2026-11-25"]
    r = env.paper(o, fridge, 3.0, "2026-11-25", "08:10")
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["source"] == "paper"
    assert e["recorded_at"] == T1.isoformat() + "Z"               # when it was typed in
    assert e["business_date"] == "2026-11-25"                       # the measured day
    assert e["paper_measured_local"] == "08:10" and e["paper_measured_local_date"] == "2026-11-25"
    assert e["recorded_local"] == "07:30" and e["recorded_local_date"] == "2026-11-26"
    assert e["slot_due_local"] == "08:00" and e["late"] is False
    row = _rows(env, o.id)[0]
    assert row.recorded_at == T1 and row.client_typed_at is None and row.followup_of_id is None
    after = env.folder(o, **{"from": "2026-11-25", "to": "2026-11-25"})
    assert not [m for m in after["missed"] if m["check_id"] == fridge]
    assert after["summary"]["paper"] == 1 and after["summary"]["slots_on_time"] >= 1
    assert [p["id"] for p in after["paper"]] == [e["id"]]
    # a late paper reading is judged by the MEASURED time
    r = env.paper(o, fridge, 3.0, "2026-11-24", "10:30")
    assert r.status_code == 201 and r.json()["late"] is True


def test_out_of_limit_on_paper_needs_a_closing_fate(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    r = env.paper(o, fridge, 8.0, "2026-11-25", "08:10")
    assert r.status_code == 422 and r.json()["detail"] == {
        "code": "deviation_fields_required", "missing": ["action", "fate"]}
    r = env.paper(o, fridge, 8.0, "2026-11-25", "08:10", action_code="thermostat_adjusted",
                  fate_code="awaiting_recheck")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "paper_fate_must_close"
    r = env.paper(o, fridge, 8.0, "2026-11-25", "08:10", action_code="thermostat_adjusted",
                  fate_code="discarded")
    assert r.status_code == 201, r.text
    assert r.json()["deviation_state"] == "closed" and r.json()["in_limit"] is False
    f = env.folder(o, **{"from": "2026-11-25", "to": "2026-11-25"})
    dev = f["deviations"][0]
    assert dev["source"] == "paper" and dev["state"] == "closed"
    assert f["summary"]["deviations_open"] == 0


def test_an_in_limit_paper_reading_never_closes_a_live_deviation(env):
    o, c = _setup(env)
    fridge = c["fridge"]["id"]
    live = env.save(o, fridge, 9.0, action_code="thermostat_adjusted",
                    fate_code="awaiting_recheck")
    assert live.status_code == 201 and live.json()["deviation_state"] == "open"
    r = env.paper(o, fridge, 3.0, "2026-11-25", "20:00")
    assert r.status_code == 201
    assert r.json()["followup_of_id"] is None and r.json()["deviation_state"] is None
    env.db.expire_all()
    assert env.db.get(FoodCheckEntry, uuid.UUID(live.json()["id"])).deviation_state == "open"
    row = next(x for x in env.today_json(o)["checks"] if x["id"] == fridge)
    assert row["status"] == "deviation_open"


def test_a_check_created_after_the_measured_time_refuses(env):
    o, c = _setup(env)
    r = env.client.post("/api/egenkontrol/checks", json={"template_key": "fridge", "name": "Køl 2"},
                        headers=env.h(o))
    assert r.status_code == 201
    r = env.paper(o, r.json()["id"], 3.0, "2026-11-26", "06:30")
    assert r.status_code == 409 and r.json()["detail"] == {"code": "check_inactive", "at": "measured"}


def test_a_replay_of_the_same_client_id_is_one_row(env):
    o, c = _setup(env)
    cid = str(uuid.uuid4())
    a = env.paper(o, c["fridge"]["id"], 3.0, "2026-11-25", "08:10", client_id=cid)
    b = env.paper(o, c["fridge"]["id"], 3.0, "2026-11-25", "08:10", client_id=cid)
    assert a.status_code == 201 and b.status_code == 200 and b.json()["replayed"] is True
    assert len(_rows(env, o.id)) == 1


def test_a_spring_gap_time_moves_forward(env):
    env.clock.set(datetime(2027, 3, 20, 8, 0))
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(datetime(2027, 3, 29, 8, 0))
    r = env.paper(o, fridge, 3.0, "2027-03-28", "02:30")
    assert r.status_code == 201, r.text
    assert r.json()["paper_measured_local"] == "03:00"
    assert r.json()["paper_measured_at"] == "2027-03-28T01:00:00Z"
    assert date.fromisoformat(r.json()["business_date"]) == date(2027, 3, 27)  # before 06:00
