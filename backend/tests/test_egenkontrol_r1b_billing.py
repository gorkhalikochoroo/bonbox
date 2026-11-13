"""Egenkontrol R1b — the Free limit (Decision 1) and the downgrade rule.

Free = 6 active TEMPERATURE checks (the 5-check start list + one spare),
Starter / Pro / Trial = 100. Founder, 13 Nov 2026: cleaning and thermometer
ticks do NOT count — on any plan — and never give a 402; a flat abuse ceiling
(egenkontrol_rules.TICKS_MAX) bounds them with a 409 instead. Only ADDING or
RE-ACTIVATING a temperature check is refused over the limit — 402 with the
same payload every other cap uses ("current" = active temperature checks).
After a downgrade every existing check keeps recording, on the owner app and
the kitchen iPad, and the Kontrolmappe and its PDF keep working.
"""
import uuid
from datetime import timedelta

from app.models.food_check import FoodCheck, FoodCheckRevision, FoodCheckSettings
from app.services import billing
from app.services import egenkontrol_rules as R
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


def _active(env, o, check_id, on):
    return env.client.patch(f"/api/egenkontrol/checks/{check_id}", json={"active": on},
                            headers=env.h(o))


def _cap(env, o):
    return env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()["cap"]


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


def test_free_cafe_start_list_plus_cleaning_and_thermometer_is_not_full(env):
    """The founder's case: a Free café with the 5 start checks + cleaning +
    thermometer ticks is NOT full — the 6th temperature check still fits and
    only the 7th temperature check gives the 402."""
    o = _free(env)
    checks = env.setup(o, items=START + TICKS)                  # 5 temperatures + 2 ticks
    assert len(checks) == 7
    assert _cap(env, o) == {"limit": 6, "active": 5}
    assert env.client.get("/api/egenkontrol/checks", headers=env.h(o)).json()["cap"] == \
        {"limit": 6, "active": 5}
    # more ticks: never counted, never a 402
    for key, name in (("cleaning", "Rengøring køkken"), ("cleaning", "Rengøring bar"),
                      ("thermometer", "Termometertjek 2")):
        assert _create(env, o, key, name).status_code == 201
    assert _cap(env, o) == {"limit": 6, "active": 5}
    assert _create(env, o).status_code == 201                  # 6th temperature check
    assert _cap(env, o) == {"limit": 6, "active": 6}
    r = _create(env, o)                                         # 7th temperature check
    assert r.status_code == 402, r.text
    assert r.json()["detail"] == PAYLOAD_6
    assert _rows(env, FoodCheck, o.id) == 11                   # 6 temperatures + 5 ticks
    # still full of temperatures — a tick is still added
    assert _create(env, o, "thermometer", "Termometertjek 3").status_code == 201


def test_free_setup_with_6_temperatures_and_ticks_fits(env):
    o = _free(env)
    items = START + [{"template_key": "fridge", "name": "Køl 2"}] + TICKS
    r = env.client.post("/api/egenkontrol/setup", json={"items": items}, headers=env.h(o))
    assert r.status_code == 201, r.text
    assert _cap(env, o) == {"limit": 6, "active": 6}


def test_free_setup_of_7_temperatures_is_402_and_creates_nothing(env):
    o = _free(env)
    items = START + [{"template_key": "fridge", "name": "Køl 2"},
                     {"template_key": "fridge", "name": "Køl 3"}] + TICKS
    r = env.client.post("/api/egenkontrol/setup", json={"items": items}, headers=env.h(o))
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


def test_a_tick_never_counts_and_never_gives_a_402(env):
    o = _free(env)
    env.setup(o)
    assert _create(env, o).status_code == 201                  # 6 temperatures: full
    clean = _create(env, o, "cleaning", "Rengøring")
    assert clean.status_code == 201, clean.text
    assert _create(env, o, "thermometer", "Termometertjek").status_code == 201
    # switching a tick off and on again over a full limit: never a 402
    assert _active(env, o, clean.json()["id"], False).status_code == 200
    r = _active(env, o, clean.json()["id"], True)
    assert r.status_code == 200, r.text
    assert _cap(env, o) == {"limit": 6, "active": 6}
    r = _create(env, o)
    assert r.status_code == 402 and r.json()["detail"]["current"] == 6


def test_ticks_do_not_count_on_a_paid_plan_either(env, monkeypatch):
    """One rule on every plan: the limit counts temperature checks only."""
    o = env.owner(plan="starter")
    env.setup(o, items=START + TICKS)
    assert _cap(env, o) == {"limit": 100, "active": 5}
    real = billing.get_cap
    monkeypatch.setattr(billing, "get_cap", lambda u, k: 5 if k == CAP else real(u, k))
    assert _create(env, o, "cleaning", "Rengøring 2").status_code == 201
    r = _create(env, o)
    assert r.status_code == 402 and r.json()["detail"]["current"] == 5
    assert r.json()["detail"]["plan"] == "starter"


def test_the_tick_ceiling_is_a_409_never_a_402(env, monkeypatch):
    """Ticks are bounded only by the flat abuse ceiling, the same on every
    plan: 409 too_many_ticks, no upgrade (no plan lifts it)."""
    monkeypatch.setattr(R, "TICKS_MAX", 3)
    for plan in ("free", "pro"):
        o = env.owner(plan=plan)
        made = env.setup(o, items=START + TICKS)              # 2 ticks
        assert _create(env, o, "cleaning", "Rengøring 2").status_code == 201   # 3rd
        r = _create(env, o, "thermometer", "Termometertjek 2")                 # 4th
        assert r.status_code == 409, (plan, r.text)
        assert r.json()["detail"] == {"code": "too_many_ticks", "max": 3}
        # switched off → room; switching it back on over the ceiling → 409
        assert _active(env, o, made["cleaning"]["id"], False).status_code == 200
        assert _create(env, o, "thermometer", "Termometertjek 2").status_code == 201
        r = _active(env, o, made["cleaning"]["id"], True)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many_ticks"
        # temperatures are unaffected by the tick ceiling
        assert _create(env, o).status_code == 201
    o = env.owner(plan="free")
    r = env.client.post("/api/egenkontrol/setup", headers=env.h(o),
                        json={"items": START + TICKS + TICKS})            # 4 ticks
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many_ticks"
    assert _rows(env, FoodCheck, o.id) == 0
    assert R.TICKS_MAX == 3


def test_tick_ceiling_default_is_a_flat_30():
    from app.services import egenkontrol_rules
    assert egenkontrol_rules.TICKS_MAX == 30


def test_after_a_downgrade_existing_checks_keep_recording(env):
    o = env.owner(plan="free")
    o.trial_ends_at = utc_now() + timedelta(days=3)       # live trial: 100
    env.db.commit()
    checks = env.setup(o, items=START + TICKS)
    extra = _create(env, o, "fridge", "Køl 2")
    assert extra.status_code == 201
    extra3 = _create(env, o, "fridge", "Køl 3")
    assert extra3.status_code == 201
    assert _rows(env, FoodCheck, o.id) == 9                    # 7 temperatures + 2 ticks
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
    assert r.status_code == 402 and r.json()["detail"]["current"] == 7
    assert r.json()["detail"]["limit"] == 6
    assert _cap(env, o) == {"limit": 6, "active": 7}             # the ticks are not counted
    # over the limit: a tick can still be added, and switched off and on again
    assert _create(env, o, "cleaning", "Rengøring bar").status_code == 201
    clean = checks["cleaning"]["id"]
    assert _active(env, o, clean, False).status_code == 200
    assert _active(env, o, clean, True).status_code == 200
    # a temperature check switched off cannot come back on while 6 are active
    assert _active(env, o, extra3.json()["id"], False).status_code == 200
    assert _cap(env, o) == {"limit": 6, "active": 6}
    r = _active(env, o, extra3.json()["id"], True)
    assert r.status_code == 402 and r.json()["detail"] == PAYLOAD_6
