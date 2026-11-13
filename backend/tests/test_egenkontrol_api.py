"""Egenkontrol R1a — owner API (/api/egenkontrol/*).

Pins the plan's R1a backend tests: setup from the start list, revisions on
every config change, "the server decides", deviations, undo that voids,
idempotency on client_id, tenancy (404 across venues), roles (accountant 403
everywhere; members cannot write; cashier/viewer cannot read the folder;
manager can), billing keys, column widths, and the app-level immutability
listeners — which are active during every scenario here, so no code path
the API uses edits a protected column.
"""
import json
import uuid
from datetime import timedelta

import pytest

from app.models.audit_log import AuditLog
from app.models.food_check import (
    EntryImmutableError, FoodCheck, FoodCheckEntry, FoodCheckRevision, FoodCheckSettings,
)
from app.services import billing
from app.services import egenkontrol_service as S
from tests._ek_support import START, T0, env  # noqa: F401 — fixture


def _rows(env, model, **flt):
    env.db.expire_all()
    q = env.db.query(model)
    for k, v in flt.items():
        q = q.filter(getattr(model, k) == v)
    return q.all()


# ── templates + setup ───────────────────────────────────────────────────

def test_templates_list_the_start_values_with_their_sources(env):
    o = env.owner()
    r = env.client.get("/api/egenkontrol/templates", headers=env.h(o))
    assert r.status_code == 200, r.text
    t = {x["key"]: x for x in r.json()["templates"]}
    # R1b adds the two ticks (cleaning, thermometer) — tests/test_egenkontrol_r1b_ticks.py
    assert set(t) == {"fridge", "freezer", "hot_holding", "reheating", "receiving",
                      "cleaning", "thermometer"}
    assert t["hot_holding"]["limit"] == {
        "limit_c": 56.0, "direction": "min", "source": "law",
        "ref": "BEK nr. 1331 af 20/11/2025, § 29, stk. 3",
    }
    assert t["freezer"]["limit"]["source"] == "fvst_example"
    assert {p["product_type"]: p["limit_c"] for p in t["receiving"]["product_limits"]} == \
        {"chilled": 5.0, "fish": 2.0, "frozen": -18.0}
    assert t["receiving"]["schedule_options"] == ["on_event"]
    assert r.json()["cutoff_hour"] == 6


def test_setup_creates_the_start_list_once(env):
    o = env.owner()
    checks = env.setup(o)
    assert set(checks) == {"fridge", "freezer", "hot_holding", "reheating", "receiving"}
    assert len(_rows(env, FoodCheck, user_id=o.id)) == 5
    assert len(_rows(env, FoodCheckRevision, user_id=o.id)) == 5
    st = _rows(env, FoodCheckSettings, user_id=o.id)[0]
    assert st.setup_done_at == T0
    audit = _rows(env, AuditLog, user_id=o.id, action="egenkontrol.setup")
    assert len(audit) == 1 and json.loads(audit[0].after_state)["count"] == 5
    assert checks["fridge"]["schedule"] == {"type": "daily", "due": "08:00"}
    assert checks["receiving"]["limit"] is None and len(checks["receiving"]["product_limits"]) == 3
    r = env.client.post("/api/egenkontrol/setup", json={"items": START}, headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_set_up"


def test_setup_refuses_schedules_the_template_does_not_allow(env):
    o = env.owner()
    r = env.client.post("/api/egenkontrol/setup", headers=env.h(o), json={"items": [
        {"template_key": "receiving", "name": "Varer", "schedule": {"type": "daily", "due": "08:00"}}]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "schedule_not_allowed"
    assert _rows(env, FoodCheck, user_id=o.id) == []


def test_due_before_the_day_start_follows_the_venue_cutoff(env):
    o6 = env.owner()
    item = {"template_key": "fridge", "name": "Køl 1", "schedule": {"type": "daily", "due": "05:30"}}
    r = env.client.post("/api/egenkontrol/setup", json={"items": [item]}, headers=env.h(o6))
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "due_before_day_start", "cutoff_hour": 6}
    o4 = env.owner(business_type="bakery", cutoff=4)
    r = env.client.post("/api/egenkontrol/setup", json={"items": [item]}, headers=env.h(o4))
    assert r.status_code == 201, r.text


# ── config changes write revisions ──────────────────────────────────────

def test_create_patch_archive_write_revisions_and_audit(env):
    o = env.owner()
    checks = env.setup(o)
    fridge = checks["fridge"]["id"]
    env.clock.tick(minutes=5)
    r = env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                        json={"template_key": "fridge", "name": "Køl 2", "note": "Mejeri & grønt"})
    assert r.status_code == 201, r.text
    k2 = r.json()
    assert k2["note"] == "Mejeri & grønt" and k2["sort_order"] == 5
    assert _rows(env, AuditLog, action="egenkontrol.check_created")

    # sort_order alone: no new revision
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"sort_order": 9}, headers=env.h(o))
    assert r.status_code == 200 and r.json()["sort_order"] == 9
    assert len(_rows(env, FoodCheckRevision, check_id=uuid.UUID(fridge))) == 1

    # a stricter limit: a new revision, and the source becomes the owner's
    env.clock.tick(minutes=5)
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"limit_c": 4.0}, headers=env.h(o))
    assert r.status_code == 200, r.text
    assert r.json()["limit"]["source"] == "owner" and r.json()["limit"]["ref"] is None
    revs = _rows(env, FoodCheckRevision, check_id=uuid.UUID(fridge))
    assert len(revs) == 2
    changed = _rows(env, AuditLog, action="egenkontrol.check_changed")
    assert json.loads(changed[0].before_state)["limit_c"] == 5.0
    assert json.loads(changed[0].after_state)["limit_c"] == 4.0
    # back to the start value: the law source returns
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"limit_c": 5.0}, headers=env.h(o))
    assert r.json()["limit"]["source"] == "law"

    # the same value again writes nothing
    n = len(_rows(env, FoodCheckRevision, check_id=uuid.UUID(fridge)))
    env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"limit_c": 5.0}, headers=env.h(o))
    assert len(_rows(env, FoodCheckRevision, check_id=uuid.UUID(fridge))) == n

    # archive: a revision with active=false, one-way
    r = env.client.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=env.h(o))
    assert r.status_code == 200 and r.json()["active"] is False and r.json()["archived_at"]
    assert _rows(env, AuditLog, action="egenkontrol.check_archived")
    r = env.client.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_archived"
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"name": "X"}, headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "archived"
    lst = env.client.get("/api/egenkontrol/checks", headers=env.h(o)).json()
    assert fridge in [c["id"] for c in lst["archived"]]
    assert fridge not in [c["id"] for c in lst["checks"]]


# ── readings: the server decides ────────────────────────────────────────

def test_an_in_limit_reading_on_time(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.tick(minutes=42)  # 08:12 local
    r = env.save(o, fridge, 3.1)
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["in_limit"] is True and e["late"] is False and e["deviation_state"] is None
    assert e["recorded_local"] == "08:12" and e["slot_due_local"] == "08:00"
    assert e["via"] == "owner_app" and e["name_source"] == "typed" and e["staff_name"] == "Mia"
    assert e["undo_until"] == (T0 + timedelta(minutes=42, seconds=120)).isoformat() + "Z"
    t = env.today_json(o)
    row = next(c for c in t["checks"] if c["id"] == fridge)
    assert row["status"] == "done" and row["last"]["value_c"] == 3.1


def test_the_server_decides_in_limit_late_and_the_time(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(T0 + timedelta(hours=2))  # 09:30 local, frist 08:00
    r = env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="moved",
                 in_limit=True, late=False, recorded_at="2026-11-12T07:00:00Z",
                 slot_due_at="2026-11-12T08:00:00Z", deviation_state=None,
                 staff_name="Somebody Else", via="kitchen")
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["in_limit"] is False and e["late"] is True
    assert e["recorded_at"] == (T0 + timedelta(hours=2)).isoformat() + "Z"
    assert e["staff_name"] == "Mia" and e["via"] == "owner_app"
    assert e["deviation_state"] == "closed"
    row = _rows(env, FoodCheckEntry, id=uuid.UUID(e["id"]))[0]
    assert row.recorded_at == T0 + timedelta(hours=2) and row.in_limit is False and row.late is True


def test_out_of_limit_needs_action_and_fate(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    r = env.save(o, fridge, 7.1)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "deviation_fields_required", "missing": ["action", "fate"]}
    r = env.save(o, fridge, 7.1, action_code="thermostat_adjusted")
    assert r.json()["detail"]["missing"] == ["fate"]
    assert _rows(env, FoodCheckEntry) == []


def test_a_followup_closes_the_open_deviation_and_its_undo_reopens_it(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    first = env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck").json()
    assert first["deviation_state"] == "open"
    row = next(c for c in env.today_json(o)["checks"] if c["id"] == fridge)
    assert row["status"] == "deviation_open"
    assert row["open_deviation"]["needs_fate"] is True
    assert row["open_deviation"]["recheck_due_local"] == "08:00"   # 07:30 + 30 min

    env.clock.tick(minutes=30)
    r = env.save(o, fridge, 4.0)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "followup_fate_required"
    fu = env.save(o, fridge, 4.0, fate_code="assessed_ok").json()
    assert fu["followup_of_id"] == first["id"] and fu["fate_code"] == "assessed_ok"
    assert _rows(env, FoodCheckEntry, id=uuid.UUID(first["id"]))[0].deviation_state == "closed"
    row = next(c for c in env.today_json(o)["checks"] if c["id"] == fridge)
    assert row["status"] == "deviation_closed"   # D13: never hidden by the good re-check

    r = env.client.post(f"/api/egenkontrol/entries/{fu['id']}/undo", headers=env.h(o))
    assert r.status_code == 200, r.text
    assert _rows(env, FoodCheckEntry, id=uuid.UUID(first["id"]))[0].deviation_state == "open"


def test_receiving_needs_a_product_type_and_uses_its_limit(env):
    o = env.owner()
    rec = env.setup(o)["receiving"]["id"]
    r = env.save(o, rec, 3.0)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "product_type_required"
    r = env.save(o, rec, 3.0, product_type="fish", action_code="supplier_contacted",
                 fate_code="returned", product_note="Laks <Fiskehuset>", label_ok=True)
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["limit_c"] == 2.0 and e["in_limit"] is False and e["product_note"] == "Laks <Fiskehuset>"
    ok = env.save(o, rec, 4.9, product_type="chilled").json()
    assert ok["in_limit"] is True and ok["limit_c"] == 5.0


# ── undo ────────────────────────────────────────────────────────────────

def test_undo_voids_within_two_minutes_and_never_deletes(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    e = env.save(o, fridge, 3.1).json()
    env.clock.tick(seconds=119)
    r = env.client.post(f"/api/egenkontrol/entries/{e['id']}/undo", headers=env.h(o))
    assert r.status_code == 200, r.text
    assert r.json()["void_reason"] == "undo" and r.json()["undo_until"] is None
    row = _rows(env, FoodCheckEntry, id=uuid.UUID(e["id"]))[0]
    assert row.voided_at is not None and row.value_c is not None   # the row stays
    r = env.client.post(f"/api/egenkontrol/entries/{e['id']}/undo", headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_voided"

    e2 = env.save(o, fridge, 3.2).json()
    env.clock.tick(seconds=121)
    r = env.client.post(f"/api/egenkontrol/entries/{e2['id']}/undo", headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "undo_window_passed"


def test_undo_by_another_actor_is_refused(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    # A reading made on the kitchen iPad cannot be undone from the owner app.
    db = env.db
    from app.models.kitchen_link import KitchenLink
    link = KitchenLink(user_id=o.id, token="k" * 32, active=True)
    db.add(link)
    db.commit()
    r = env.client.post(f"/api/kitchen/{'k' * 32}/entries", json={
        "client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3.0, "typed_name": "Ali"})
    assert r.status_code == 201, r.text
    r = env.client.post(f"/api/egenkontrol/entries/{r.json()['id']}/undo", headers=env.h(o))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "undo_not_yours"


# ── idempotency ─────────────────────────────────────────────────────────

def test_the_same_client_id_makes_one_row(env):
    o = env.owner()
    checks = env.setup(o)
    fridge, freezer = checks["fridge"]["id"], checks["freezer"]["id"]
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "check_id": fridge, "value_c": 3.1, "typed_name": "Mia"}
    a = env.client.post("/api/egenkontrol/entries", json=body, headers=env.h(o))
    env.clock.tick(seconds=30)
    b = env.client.post("/api/egenkontrol/entries", json=body, headers=env.h(o))
    assert a.status_code == 201 and b.status_code == 200
    assert b.json()["replayed"] is True and b.json()["id"] == a.json()["id"]
    assert len(_rows(env, FoodCheckEntry, user_id=o.id)) == 1
    r = env.client.post("/api/egenkontrol/entries", json={**body, "check_id": freezer},
                        headers=env.h(o))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "client_id_reused"


# ── tenancy ─────────────────────────────────────────────────────────────

def test_another_venue_gets_404_on_my_check_branch_and_staff(env):
    a, b = env.owner(name="A"), env.owner(name="B")
    a_fridge = env.setup(a)["fridge"]["id"]
    b_fridge = env.setup(b)["fridge"]["id"]
    a_branch = env.branch(a)
    a_staff = env.staff(a, "Ali Khan")
    hb = env.h(b)
    assert env.save(b, a_fridge, 3.0, headers=hb).status_code == 404
    assert env.client.get("/api/egenkontrol/today", params={"branch_id": str(a_branch.id)},
                          headers=hb).status_code == 404
    assert env.client.patch(f"/api/egenkontrol/checks/{a_fridge}", json={"name": "X"},
                            headers=hb).status_code == 404
    assert env.client.post(f"/api/egenkontrol/checks/{a_fridge}/archive", headers=hb).status_code == 404
    r = env.save(b, b_fridge, 3.0, headers=hb, staff_id=str(a_staff.id))
    assert r.status_code == 404
    e = env.save(a, a_fridge, 3.0).json()
    assert env.client.post(f"/api/egenkontrol/entries/{e['id']}/undo", headers=hb).status_code == 404
    assert env.client.post("/api/egenkontrol/checks", headers=hb, json={
        "template_key": "fridge", "name": "K", "branch_id": str(a_branch.id)}).status_code == 404


def test_a_branch_filter_shows_its_own_and_venue_wide_checks(env):
    o = env.owner()
    b1, b2 = env.branch(o, "Nord"), env.branch(o, "Syd")
    env.setup(o)
    r = env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                        json={"template_key": "fridge", "name": "Nord køl", "branch_id": str(b1.id)})
    nord = r.json()["id"]
    env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                    json={"template_key": "fridge", "name": "Syd køl", "branch_id": str(b2.id)})
    ids = [c["name"] for c in env.today_json(o, branch_id=str(b1.id))["checks"]]
    assert "Nord køl" in ids and "Syd køl" not in ids and "Køl 1" in ids
    assert nord


# ── roles ───────────────────────────────────────────────────────────────

def test_the_accountant_gets_403_everywhere(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    h = env.h(env.accountant(o))
    for path in ("/api/egenkontrol/today", "/api/egenkontrol/status", "/api/egenkontrol/templates",
                 "/api/egenkontrol/checks", "/api/egenkontrol/staff", "/api/egenkontrol/folder",
                 "/api/egenkontrol/folder.pdf", "/api/egenkontrol/devices"):
        r = env.client.get(path, headers=h)
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"]["code"] == "accountant_no_access", path
    for path, body in (("/api/egenkontrol/entries",
                        {"client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3}),
                       ("/api/egenkontrol/setup", {"items": START}),
                       ("/api/egenkontrol/checks", {"template_key": "fridge", "name": "K"}),
                       ("/api/egenkontrol/devices", {})):
        assert env.client.post(path, json=body, headers=h).status_code == 403, path


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_members_cannot_write(env, role):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    h = env.h(env.member(o, role))
    for path, body in (("/api/egenkontrol/entries",
                        {"client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3,
                         "typed_name": "Mia"}),
                       ("/api/egenkontrol/checks", {"template_key": "fridge", "name": "K"}),
                       ("/api/egenkontrol/setup", {"items": START}),
                       ("/api/egenkontrol/devices", {})):
        r = env.client.post(path, json=body, headers=h)
        assert r.status_code == 403, (role, path, r.text)
    assert env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"name": "X"},
                            headers=h).status_code == 403
    assert _rows(env, FoodCheckEntry) == []
    # every seat reads today
    assert env.client.get("/api/egenkontrol/today", headers=h).status_code == 200
    assert env.client.get("/api/egenkontrol/status", headers=h).status_code == 200


@pytest.mark.parametrize("role", ["cashier", "viewer"])
def test_cashier_and_viewer_cannot_read_the_folder(env, role):
    o = env.owner()
    env.setup(o)
    h = env.h(env.member(o, role))
    for path in ("/api/egenkontrol/folder", "/api/egenkontrol/folder.pdf", "/api/egenkontrol/checks"):
        r = env.client.get(path, headers=h)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "read_forbidden", path


def test_a_manager_reads_the_folder_and_pdf_but_not_the_devices(env):
    o = env.owner()
    env.setup(o)
    h = env.h(env.member(o, "manager"))
    assert env.client.get("/api/egenkontrol/folder", headers=h).status_code == 200
    r = env.client.get("/api/egenkontrol/folder.pdf", headers=h)
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    r = env.client.get("/api/egenkontrol/devices", headers=h)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "owner_only"
    assert env.client.get("/api/egenkontrol/staff", headers=h).status_code == 403


# ── billing ─────────────────────────────────────────────────────────────

def test_the_feature_and_the_cap_key_exist_on_all_four_plans():
    for plan in ("free", "starter", "pro", "trial"):
        assert billing.PLAN_FEATURES[plan]["egenkontrol"] is True, plan
        # R1b: Free = 6 (Decision 1); the paid plans keep the 100 abuse ceiling.
        assert billing.PLAN_CAPS[plan]["egenkontrol_active_checks"] == (6 if plan == "free" else 100), plan


def test_the_cap_is_enforced_on_create_setup_and_reactivate(env, monkeypatch):
    o = env.owner(plan="free")
    monkeypatch.setattr(billing, "get_cap",
                        lambda u, k: 2 if k == "egenkontrol_active_checks" else 999)
    r = env.client.post("/api/egenkontrol/setup", json={"items": START}, headers=env.h(o))
    assert r.status_code == 402 and r.json()["detail"]["error"] == "cap_exceeded"
    env.setup(o, items=START[:2])
    r = env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                        json={"template_key": "fridge", "name": "Køl 2"})
    assert r.status_code == 402 and r.json()["detail"]["cap"] == "egenkontrol_active_checks"
    fridge = _rows(env, FoodCheck, user_id=o.id, template_key="fridge")[0].id
    env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": False}, headers=env.h(o))
    env.client.post("/api/egenkontrol/checks", headers=env.h(o),
                    json={"template_key": "fridge", "name": "Køl 2"})
    r = env.client.patch(f"/api/egenkontrol/checks/{fridge}", json={"active": True}, headers=env.h(o))
    assert r.status_code == 402


# ── column widths / verbatim text ───────────────────────────────────────

def test_long_names_are_stored_not_rejected(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    long_staff = env.staff(o, "A" * 200)
    r = env.save(o, fridge, 3.0, staff_id=str(long_staff.id))
    assert r.status_code == 201, r.text
    assert len(r.json()["staff_name"]) <= 80 and r.json()["name_source"] == "picked"
    r = env.save(o, fridge, 3.0, typed_name="x" * 41)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "name_invalid"
    r = env.save(o, fridge, 3.0, typed_name=None)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "name_required"


def test_typed_text_is_stored_byte_for_byte(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    note = "<b>Bold</b> & co"
    r = env.save(o, fridge, 7.1, action_code="other", action_other="Ringede til <Kølefirma>",
                 fate_code="discarded", action_note=note)
    assert r.status_code == 201, r.text
    row = _rows(env, FoodCheckEntry, id=uuid.UUID(r.json()["id"]))[0]
    assert row.action_note == note and row.action_other == "Ringede til <Kølefirma>"


def test_staff_list_first_name_last_initial_on_shift_first(env):
    o = env.owner()
    env.staff(o, "Zoe Andersen")
    env.staff(o, "Ali Khan Hansen", on_shift=True)
    env.staff(o, "Gone Person", deleted=True)
    env.staff(o, "Off Person", active=False)
    r = env.client.get("/api/egenkontrol/staff", headers=env.h(o))
    assert r.status_code == 200
    assert [(s["name"], s["on_shift"]) for s in r.json()["staff"]] == [("Ali H.", True), ("Zoe A.", False)]


# ── today / status / folder ─────────────────────────────────────────────

def test_status_counts_missing_and_never_all_done_over_zero(env):
    o = env.owner()
    r = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert r["setup_done"] is False and r["active_checks"] == 0 and r["has_records"] is False
    assert r["relevant"] is True
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))  # 09:30: the 08:00 fridge + freezer are overdue
    r = env.client.get("/api/egenkontrol/status", headers=env.h(o)).json()
    assert r["missing_now"] == 2 and r["active_checks"] == 5
    t = env.today_json(o)
    assert t["summary"]["total"] == 3 and t["summary"]["missing"] == 2   # + hot holding at 12:00
    statuses = {c["template_key"]: c["status"] for c in t["checks"]}
    assert statuses["fridge"] == "overdue" and statuses["receiving"] == "on_event"
    assert [c["group_key"] for c in t["checks"]][-1] == "receiving"


def test_a_salon_is_not_relevant_but_is_not_refused(env):
    o = env.owner(business_type="salon")
    r = env.client.get("/api/egenkontrol/status", headers=env.h(o))
    assert r.status_code == 200 and r.json()["relevant"] is False


def test_folder_lists_missed_late_deviations_and_undone(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(T0 + timedelta(hours=2))                     # 09:30 → late
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="moved")
    u = env.save(o, fridge, 3.3).json()
    env.client.post(f"/api/egenkontrol/entries/{u['id']}/undo", headers=env.h(o))
    env.clock.set(T0 + timedelta(days=2, hours=4))              # two days on; yesterday missed
    r = env.client.get("/api/egenkontrol/folder", headers=env.h(o))
    assert r.status_code == 200, r.text
    f = r.json()
    assert f["venue_name"] == "Bistro Nørrebro"
    assert f["title_counts"] == {"readings": 1, "deviations": 1, "deviations_open": 0}
    assert f["summary"]["slots_late"] == 1 and f["summary"]["undone"] == 1
    assert f["late"][0]["slot_due_local"] == "08:00" and f["late"][0]["recorded_local"] == "09:30"
    assert any(m["date"] == "2026-11-13" for m in f["missed"])
    assert f["deviations"][0]["check_name"] == "Køl 1"
    days = {d["date"]: d["state"] for d in f["days"]}
    assert days["2026-11-12"] == "deviation" and days["2026-11-13"] == "missed"
    assert days["2026-11-01"] == "none"
    assert f["checks"][0]["revisions"][0]["schedule_text_da"].startswith("Skrives ned")


def test_folder_range_rules(env):
    o = env.owner()
    env.setup(o)
    h = env.h(o)
    # R1b: up to 92 days (93 refused); was 30 in R1a.
    r = env.client.get("/api/egenkontrol/folder", params={"from": "2026-08-12", "to": "2026-11-12"}, headers=h)
    assert r.status_code == 422 and r.json()["detail"] == {"code": "range_too_long", "max_days": 92}
    r = env.client.get("/api/egenkontrol/folder", params={"from": "2026-11-12", "to": "2026-11-11"}, headers=h)
    assert r.json()["detail"]["code"] == "bad_range"
    r = env.client.get("/api/egenkontrol/folder", params={"to": "2026-11-20"}, headers=h)
    assert r.json()["detail"]["code"] == "bad_range"


# ── app-level immutability (SQLite twin of the PG triggers) ─────────────

def test_a_saved_reading_cannot_be_edited_only_voided(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    eid = env.save(o, fridge, 3.1).json()["id"]
    s = env.SL()
    row = s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(eid)).one()
    row.value_c = 2.0
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    row = s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(eid)).one()
    row.recorded_at = row.recorded_at - timedelta(hours=1)
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    # allowed: void once, deviation_state, clearing staff_id
    row = s.query(FoodCheckEntry).filter(FoodCheckEntry.id == uuid.UUID(eid)).one()
    row.voided_at, row.void_reason = T0, "undo"
    s.commit()
    row.void_reason = "correction"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    s.close()


def test_a_revision_is_never_updated(env):
    o = env.owner()
    env.setup(o)
    s = env.SL()
    rev = s.query(FoodCheckRevision).first()
    rev.name = "Changed"
    with pytest.raises(EntryImmutableError):
        s.flush()
    s.rollback()
    s.close()
