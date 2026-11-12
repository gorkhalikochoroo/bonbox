"""Egenkontrol R1b — corrections (owner only, readings at most 14 days old).

A correction writes a NEW row (supersedes_id) and voids the old one with
void_reason 'correction'. The official time never changes, a deviation is
never removed (ONE event in the folder, with its chain and reason; "Rettet —
ikke en afvigelse" when the corrected value is in limit; the day strip stays
"deviation"), a correction changes no other row and is never undone.
"""
import uuid
from datetime import timedelta

from app.models.food_check import FoodCheckEntry
from tests._ek_support import T0, env  # noqa: F401 — fixture

TWO_FRIDGES = [{"template_key": "fridge", "name": "Køl 1"},
               {"template_key": "fridge", "name": "Køl 2"},
               {"template_key": "freezer", "name": "Frost 1"}]


def _row(env, entry_id):
    env.db.expire_all()
    return env.db.get(FoodCheckEntry, uuid.UUID(entry_id))


def _dev(env, o, fridge, value=9.9, fate="moved"):
    r = env.save(o, fridge, value, action_code="thermostat_adjusted", fate_code=fate)
    assert r.status_code == 201, r.text
    return r.json()


def test_a_typo_correction_keeps_the_deviation_with_its_reason(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.tick(minutes=40)                                  # 08:10, on time
    e = _dev(env, o, fridge)
    env.clock.tick(minutes=20)
    r = env.correct(o, e["id"], "typo", value_c=3.9)
    assert r.status_code == 201, r.text
    new, old = r.json()["entry"], r.json()["corrected"]
    assert old["id"] == e["id"] and old["voided_at"] and old["void_reason"] == "correction"
    assert new["supersedes_id"] == e["id"] and new["correction_reason"] == "typo"
    assert new["recorded_at"] == e["recorded_at"]               # the official time stays
    assert new["created_at"] == (T0 + timedelta(minutes=60)).isoformat() + "Z"
    assert new["value_c"] == 3.9 and new["in_limit"] is True and new["deviation_state"] is None
    assert new["undo_until"] is None                             # corrected again, never undone
    assert new["slot_due_local"] == "08:00" and new["late"] is False

    f = env.folder(o)
    assert len(f["deviations"]) == 1
    d = f["deviations"][0]
    assert d["id"] == e["id"] and d["state"] == "corrected"
    assert [x["id"] for x in d["chain"]] == [e["id"], new["id"]]
    assert f["summary"]["deviations"] == 1 and f["summary"]["deviations_open"] == 0
    assert f["summary"]["corrections"] == 1 and f["summary"]["undone"] == 0
    assert f["summary"]["readings"] == 1
    assert {x["date"]: x["state"] for x in f["days"]}["2026-11-12"] == "deviation"
    assert f["undone"] == []
    c = f["corrections"][0]
    assert c["original"]["id"] == e["id"] and c["corrected"]["id"] == new["id"]
    assert c["reason_code"] == "typo" and c["check_changed"] is False
    assert c["corrected_local"] == "08:30"
    # the undo route refuses a correction
    u = env.client.post(f"/api/egenkontrol/entries/{new['id']}/undo", headers=env.h(o))
    assert u.status_code == 409


def test_correcting_an_open_deviation_to_in_limit_drops_it_from_open(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = _dev(env, o, fridge, 7.1, fate="awaiting_recheck")
    assert env.folder(o)["summary"]["deviations_open"] == 1
    r = env.correct(o, e["id"], "typo", value_c=2.1)
    assert r.status_code == 201, r.text
    f = env.folder(o)
    assert f["summary"]["deviations_open"] == 0 and f["summary"]["deviations"] == 1
    assert f["deviations"][0]["state"] == "corrected"
    assert {x["date"]: x["state"] for x in f["days"]}["2026-11-12"] == "deviation"
    row = next(x for x in env.today_json(o)["checks"] if x["id"] == fridge)
    assert row["status"] != "deviation_open"


def test_still_out_of_limit_keeps_the_state_and_the_fields(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = _dev(env, o, fridge, 9.9, fate="moved")
    r = env.correct(o, e["id"], "typo", value_c=8.9)
    assert r.status_code == 201
    n = r.json()["entry"]
    assert n["deviation_state"] == "closed" and n["action_code"] == "thermostat_adjusted"
    assert n["fate_code"] == "moved"
    assert env.folder(o)["deviations"][0]["state"] == "closed"


def test_refusals(env):
    o = env.owner()
    checks = env.setup(o)
    fridge = checks["fridge"]["id"]
    e = _dev(env, o, fridge)
    r = env.correct(o, e["id"], "other", value_c=3.0)
    assert r.status_code == 422 and r.json()["detail"] == {"code": "other_text_required", "field": "reason"}
    r = env.correct(o, e["id"], "other", value_c=3.0, reason_text="y" * 121)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reason_too_long"
    r = env.correct(o, e["id"], "nope", value_c=3.0)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reason_unknown"
    r = env.correct(o, e["id"], "typo", value_c=9.9)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "correction_no_change"
    r = env.correct(o, e["id"], "typo", check_id=checks["freezer"]["id"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "check_change_needs_reason"
    env.clock.tick(minutes=5)                      # created AFTER the reading: still kind_mismatch
    cleaning = env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                               json={"template_key": "cleaning", "name": "Rengøring"}).json()
    r = env.correct(o, e["id"], "wrong_check", check_id=cleaning["id"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "kind_mismatch"
    other = env.owner(name="Anden")
    other_fridge = env.setup(other)["fridge"]["id"]
    r = env.correct(o, e["id"], "wrong_check", check_id=other_fridge)
    assert r.status_code == 404
    r = env.correct(other, e["id"], "typo", value_c=3.0)          # another venue's reading
    assert r.status_code == 404
    # nothing was voided by any refusal
    assert _row(env, e["id"]).voided_at is None


def test_an_archived_target_and_an_undone_row_refuse(env):
    o = env.owner()
    env.setup(o, items=TWO_FRIDGES)
    ids = {c["name"]: c["id"] for c in env.client.get("/api/egenkontrol/checks",
                                                      headers=env.h(o)).json()["checks"]}
    e = env.save(o, ids["Køl 1"], 3.0).json()
    assert env.client.post(f"/api/egenkontrol/checks/{ids['Køl 2']}/archive",
                           headers=env.h(o)).status_code == 200
    r = env.correct(o, e["id"], "wrong_check", check_id=ids["Køl 2"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "check_inactive"
    u = env.save(o, ids["Køl 1"], 3.3).json()
    assert env.client.post(f"/api/egenkontrol/entries/{u['id']}/undo", headers=env.h(o)).status_code == 200
    r = env.correct(o, u["id"], "typo", value_c=3.4)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_voided"


def test_too_old(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = env.save(o, fridge, 3.0).json()
    assert e["correctable_until"] == (T0 + timedelta(days=14)).isoformat() + "Z"
    env.clock.tick(days=15)
    r = env.correct(o, e["id"], "typo", value_c=3.5)
    assert r.status_code == 422 and r.json()["detail"] == {"code": "correction_too_old", "max_days": 14}


def test_wrong_check_moves_the_reading(env):
    o = env.owner()
    env.setup(o, items=TWO_FRIDGES)
    ids = {c["name"]: c["id"] for c in env.client.get("/api/egenkontrol/checks",
                                                      headers=env.h(o)).json()["checks"]}
    env.clock.tick(minutes=40)                                    # 08:10
    e = env.save(o, ids["Køl 1"], 3.0).json()
    env.save(o, ids["Frost 1"], -20.0)
    r = env.correct(o, e["id"], "wrong_check", check_id=ids["Køl 2"])
    assert r.status_code == 201, r.text
    n = r.json()["entry"]
    assert n["check_id"] == ids["Køl 2"] and n["slot_due_local"] == "08:00" and n["late"] is False
    assert n["recorded_at"] == e["recorded_at"]
    env.clock.set(T0 + timedelta(days=1))                         # the 12th's windows are over
    f = env.folder(o, **{"from": "2026-11-12", "to": "2026-11-12"})
    missed = {m["check_name"] for m in f["missed"]}
    assert "Køl 1" in missed and "Køl 2" not in missed
    c = f["corrections"][0]
    assert c["check_changed"] is True
    assert c["original_check_name"] == "Køl 1" and c["check_name"] == "Køl 2"


def test_correcting_a_correction_makes_one_chain(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = _dev(env, o, fridge, 9.9)
    n1 = env.correct(o, e["id"], "typo", value_c=8.9).json()["entry"]
    n2 = env.correct(o, n1["id"], "other", value_c=3.9, reason_text="Aflæst forkert <b>&</b>")
    assert n2.status_code == 201, n2.text
    n2 = n2.json()["entry"]
    assert n2["recorded_at"] == e["recorded_at"] and n2["correction_text"] == "Aflæst forkert <b>&</b>"
    assert n2["reason_text"] is None                    # a live reading has no paper reason
    f = env.folder(o)
    assert len(f["deviations"]) == 1
    assert [x["id"] for x in f["deviations"][0]["chain"]] == [e["id"], n1["id"], n2["id"]]
    assert f["deviations"][0]["state"] == "corrected"
    assert f["summary"]["deviations"] == 1 and f["summary"]["corrections"] == 1
    assert len(f["corrections"]) == 2 and f["summary"]["readings"] == 1


def test_a_replay_returns_the_first_correction_and_voids_once(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = env.save(o, fridge, 3.0).json()
    cid = str(uuid.uuid4())
    a = env.correct(o, e["id"], "typo", value_c=3.5, client_id=cid)
    b = env.correct(o, e["id"], "typo", value_c=3.5, client_id=cid)
    assert a.status_code == 201 and b.status_code == 200 and b.json()["replayed"] is True
    assert b.json()["entry"]["id"] == a.json()["entry"]["id"]
    env.db.expire_all()
    rows = env.db.query(FoodCheckEntry).filter(FoodCheckEntry.user_id == o.id).all()
    assert len(rows) == 2 and sum(1 for x in rows if x.voided_at is not None) == 1
    # the same client_id for another reading is refused
    other = env.save(o, fridge, 3.1).json()
    c = env.correct(o, other["id"], "typo", value_c=3.2, client_id=cid)
    assert c.status_code == 409 and c.json()["detail"]["code"] == "client_id_reused"


def test_only_the_owner_corrects(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = env.save(o, fridge, 3.0).json()
    for who in (env.member(o, "manager"), env.member(o, "cashier"), env.accountant(o)):
        r = env.correct(o, e["id"], "typo", value_c=3.5, headers=env.h(who))
        assert r.status_code == 403, r.text
    assert _row(env, e["id"]).voided_at is None


def test_a_correction_changes_no_other_row(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    d = _dev(env, o, fridge, 7.1, fate="awaiting_recheck")
    env.clock.tick(minutes=30)
    f = env.save(o, fridge, 4.0, fate_code="assessed_ok").json()     # closes d
    assert _row(env, d["id"]).deviation_state == "closed"
    r = env.correct(o, f["id"], "typo", value_c=9.0, action_code="thermostat_adjusted",
                    fate_code="awaiting_recheck")
    assert r.status_code == 201, r.text
    assert _row(env, d["id"]).deviation_state == "closed"            # untouched
    assert r.json()["entry"]["followup_of_id"] == d["id"]
    assert r.json()["entry"]["deviation_state"] == "open"


def test_undoing_the_followup_of_a_corrected_deviation_reopens_its_live_row(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    d = _dev(env, o, fridge, 7.1, fate="awaiting_recheck")
    env.clock.tick(minutes=30)
    f = env.save(o, fridge, 4.0, fate_code="assessed_ok").json()       # closes d
    env.clock.tick(seconds=30)
    n = env.correct(o, d["id"], "typo", value_c=7.4).json()["entry"]   # still out of limit
    assert n["deviation_state"] == "closed"
    env.clock.tick(seconds=30)
    u = env.client.post(f"/api/egenkontrol/entries/{f['id']}/undo", headers=env.h(o))
    assert u.status_code == 200, u.text
    assert _row(env, n["id"]).deviation_state == "open"
    assert _row(env, d["id"]).voided_at is not None                    # the original stays voided
    row = next(x for x in env.today_json(o)["checks"] if x["id"] == fridge)
    assert row["status"] == "deviation_open"


def test_corrections_made_at_the_same_instant_keep_their_chain_order():
    """Two corrections with the same created_at (a frozen clock) used to fall
    back to the random id order, so "Rettelser" could list a correction of a
    correction BEFORE the one it corrected. The ids here sort the wrong way
    round on purpose: the chain decides, not the id."""
    from types import SimpleNamespace

    from app.services.egenkontrol_records import corrections_of

    at = T0 + timedelta(days=1)
    a = SimpleNamespace(id=uuid.UUID(int=1), supersedes_id=None, created_at=at - timedelta(hours=1))
    c = SimpleNamespace(id=uuid.UUID(int=9), supersedes_id=a.id, created_at=at)   # corrects a
    b = SimpleNamespace(id=uuid.UUID(int=5), supersedes_id=c.id, created_at=at)   # corrects c
    assert str(b.id) < str(c.id)                       # id order alone would put b first
    for entries in ([a, b, c], [c, b, a], [b, a, c]):
        pairs = corrections_of(SimpleNamespace(entries=entries))
        assert [(o.id, n.id) for o, n in pairs] == [(a.id, c.id), (c.id, b.id)]
    # A later correction still comes after an earlier one, whatever its depth.
    d = SimpleNamespace(id=uuid.UUID(int=2), supersedes_id=None, created_at=at - timedelta(hours=1))
    e = SimpleNamespace(id=uuid.UUID(int=3), supersedes_id=d.id, created_at=at + timedelta(seconds=1))
    pairs = corrections_of(SimpleNamespace(entries=[e, d, b, c, a]))
    assert [n.id for _, n in pairs] == [c.id, b.id, e.id]
