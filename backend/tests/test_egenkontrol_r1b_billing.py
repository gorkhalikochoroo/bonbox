"""Egenkontrol R1b — the Free limit (Decision 1) and the downgrade rule.

Free = 6 active checks (the 5-check start list + one spare; ticks count),
Starter / Pro / Trial = 100. Only ADDING or RE-ACTIVATING a check is refused
over the limit — 402 with the same payload every other cap uses. After a
downgrade every existing check keeps recording, on the owner app and the
kitchen iPad, and the Kontrolmappe and its PDF keep working.
"""
import uuid
from datetime import timedelta

from app.models.food_check import FoodCheck, FoodCheckRevision, FoodCheckSettings
from app.services import billing
from app.utils.time import utc_now
from tests._ek_support import START, env  # noqa: F401 — fixture

CAP = "egenkontrol_active_checks"
TICKS = [{"template_key": "cleaning", "name": "Rengøring"},
         {"template_key": "thermometer", "name": "Termometertjek"}]
PAYLOAD_6 = {"error": "cap_exceeded", "cap": CAP, "current": 6, "limit": 6,
             "plan": "free", "upgrade_to": "starter"}


def _free(env):
    return env.owner(plan="free")


def _create(env, o, template_key="fridge", name=None, headers=None):
    return env.client.post("/api/egenkontrol/checks", headers=headers or env.h(o),
                           json={"template_key": template_key,
                                 "name": name or f"Køl {uuid.uuid4().hex[:4]}"})


def _rows(env, model, uid):
    env.db.expire_all()
    return env.db.query(model).filter(model.user_id == uid).count()


def test_plan_caps_free_6_paid_100_all_four_keys():
    for plan in ("free", "starter", "pro", "trial"):
        assert billing.PLAN_FEATURES[plan]["egenkontrol"] is True, plan
        assert CAP in billing.PLAN_CAPS[plan], plan
    assert billing.PLAN_CAPS["free"][CAP] == 6
    for plan in ("starter", "pro", "trial"):
        assert billing.PLAN_CAPS[plan][CAP] == 100, plan
    assert billing.min_plan_for_cap(CAP, 7) == "starter"


def test_free_setup_of_the_start_list_fits(env):
    o = _free(env)
    assert len(env.setup(o)) == 5
    st = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert st["cap"] == {"limit": 6, "active": 5}
    assert env.client.get("/api/egenkontrol/checks", headers=env.h(o)).json()["cap"] == \
        {"limit": 6, "active": 5}


def test_free_setup_of_7_is_402_and_creates_nothing(env):
    o = _free(env)
    r = env.client.post("/api/egenkontrol/setup", json={"items": START + TICKS}, headers=env.h(o))
    assert r.status_code == 402, r.text
    assert r.json()["detail"] == PAYLOAD_6
    assert _rows(env, FoodCheck, o.id) == 0
    assert _rows(env, FoodCheckRevision, o.id) == 0
    assert _rows(env, FoodCheckSettings, o.id) == 0


def test_create_6th_ok_7th_402_then_deactivate_and_reactivate(env):
    o = _free(env)
    checks = env.setup(o)
    assert _create(env, o).status_code == 201                  # 6th
    r = _create(env, o)                                         # 7th
    assert r.status_code == 402 and r.json()["detail"] == PAYLOAD_6
    assert _rows(env, FoodCheck, o.id) == 6
    # switch one off → room for one more
    fridge = checks["fridge"]["id"]
    assert env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": False},
                            headers=env.h(o)).status_code == 200
    assert _create(env, o).status_code == 201
    # switching it back on would make 7
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": True},
                         headers=env.h(o))
    assert r.status_code == 402 and r.json()["detail"] == PAYLOAD_6


def test_a_tick_counts_toward_the_limit(env):
    o = _free(env)
    env.setup(o)
    assert _create(env, o, "cleaning", "Rengøring").status_code == 201
    r = _create(env, o, "thermometer", "Termometertjek")
    assert r.status_code == 402 and r.json()["detail"]["current"] == 6


def test_after_a_downgrade_existing_checks_keep_recording(env):
    o = env.owner(plan="free")
    o.trial_ends_at = utc_now() + timedelta(days=3)       # live trial: 100
    env.db.commit()
    checks = env.setup(o, items=START + TICKS)
    extra = _create(env, o, "fridge", "Køl 2")
    assert extra.status_code == 201
    assert _rows(env, FoodCheck, o.id) == 8
    token = env.pair(o)

    o.trial_ends_at = utc_now() - timedelta(days=1)       # trial over → Free (6)
    env.db.commit()
    assert billing.effective_plan(o) == "free"

    bodies = {
        "fridge": {"value_c": 3.0}, "freezer": {"value_c": -20.0},
        "hot_holding": {"value_c": 60.0}, "reheating": {"value_c": 80.0},
        "receiving": {"value_c": 3.0, "product_type": "chilled", "label_ok": True},
        "cleaning": {"done": True}, "thermometer": {"done": True},
    }
    for key, extra_body in bodies.items():
        body = {"client_id": str(uuid.uuid4()), "check_id": checks[key]["id"],
                "typed_name": "Mia", **extra_body}
        if "done" in extra_body:
            body["value_c"] = None
        r = env.client.post("/api/egenkontrol/entries", json=body, headers=env.h(o))
        assert r.status_code == 201, (key, r.text)
    assert env.save(o, extra.json()["id"], 2.5).status_code == 201
    k = env.client.post(f"/api/kitchen/{token}/entries", json={
        "client_id": str(uuid.uuid4()), "check_id": checks["fridge"]["id"], "value_c": 3.1,
        "typed_name": "Bo"})
    assert k.status_code == 201, k.text

    assert env.client.get("/api/egenkontrol/folder", headers=env.h(o)).status_code == 200
    pdf = env.client.get("/api/egenkontrol/folder.pdf", headers=env.h(o))
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    patch = env.client.patch(f"/api/egenkontrol/checks/{checks['fridge']['id']}",
                             json={"limit_c": 4.0}, headers=env.h(o))
    assert patch.status_code == 200, patch.text
    r = _create(env, o)
    assert r.status_code == 402 and r.json()["detail"]["current"] == 8
    assert r.json()["detail"]["limit"] == 6
    st = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert st["cap"] == {"limit": 6, "active": 8}
