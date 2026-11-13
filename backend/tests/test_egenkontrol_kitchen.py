"""Egenkontrol R1a — the kitchen iPad credential (/api/kitchen/{token}/*).

A SECOND device credential into an app holding bank balances, tax and payroll.
The load-bearing tests are the NEGATIVE ones: a kitchen token reaches only the
kitchen wrappers, a stand token never reaches them, codes are single-use and
unique across both device tables, every failure is the same 404, the pairing
door is one shared 8/minute bucket, and revoking works on the next request.
"""
import uuid
from datetime import timedelta

from app.models.audit_log import AuditLog
from app.models.food_check import FoodCheckEntry
from app.models.kitchen_link import KitchenLink
from app.models.stand_link import StandLink
from app.routers import stand_link as stand_router
from app.utils.log_redact import redact_path
from tests._ek_support import env  # noqa: F401 — fixture


def _mint(env, owner, **body):
    r = env.client.post("/api/egenkontrol/devices", json=body, headers=env.h(owner))
    assert r.status_code == 201, r.text
    return r.json()


def _join(env, code):
    return env.client.post("/api/stand/join", json={"code": code})


def _pair(env, owner, **body):
    code = _mint(env, owner, **body)["code"]
    r = _join(env, code)
    assert r.status_code == 200, r.text
    return r.json()["path"].rsplit("/", 1)[-1]


def _entry(check_id, value=3.0, **kw):
    body = {"client_id": str(uuid.uuid4()), "check_id": check_id, "value_c": value}
    if "staff_id" not in kw:
        body["typed_name"] = "Ali"
    body.update(kw)
    return body


# ── pairing ─────────────────────────────────────────────────────────────

def test_a_kitchen_code_pairs_through_the_stand_door(env):
    o = env.owner()
    minted = _mint(env, o, label="Køkken-iPad")
    assert len(minted["code"]) == 6 and minted["expires_in_minutes"] == 20
    r = _join(env, minted["code"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["surface"] == "kitchen" and body["venue"] == "Bistro Nørrebro"
    assert body["path"].startswith("/kitchen/") and len(body["path"]) > len("/kitchen/") + 20
    env.db.expire_all()
    assert env.db.query(AuditLog).filter(AuditLog.action == "kitchen.link_redeemed").count() == 1
    assert env.db.query(AuditLog).filter(AuditLog.action == "kitchen.link_created").count() == 1


def test_a_stand_code_still_pairs_the_stand(env):
    o = env.owner()
    r = env.client.post("/api/stand/links", json={"label": "Dør"}, headers=env.h(o))
    assert r.status_code == 200, r.text
    j = _join(env, r.json()["code"])
    assert j.status_code == 200
    assert j.json()["surface"] == "stand" and j.json()["path"].startswith("/stand/")


def test_codes_are_unique_across_both_device_tables(env, monkeypatch):
    o = env.owner()
    stand_code = env.client.post("/api/stand/links", json={}, headers=env.h(o)).json()["code"]
    seq = iter([stand_code, "KTCHN2"])
    monkeypatch.setattr(stand_router, "_gen_code", lambda n=6: next(seq))
    assert _mint(env, o)["code"] == "KTCHN2"
    # and the stand side refuses a kitchen code the same way
    seq2 = iter(["KTCHN2", "STAND3"])
    monkeypatch.setattr(stand_router, "_gen_code", lambda n=6: next(seq2))
    r = env.client.post("/api/stand/links", json={}, headers=env.h(o))
    assert r.json()["code"] == "STAND3"


def test_a_code_is_single_use_and_every_failure_is_the_same_404(env):
    o = env.owner()
    used = _mint(env, o)["code"]
    assert _join(env, used).status_code == 200
    expired = _mint(env, o)
    revoked = _mint(env, o)
    link = env.db.query(KitchenLink).filter(KitchenLink.join_code == expired["code"]).one()
    link.code_expires_at = link.created_at - timedelta(minutes=1)
    env.db.commit()
    env.client.delete(f"/api/egenkontrol/devices/{revoked['id']}", headers=env.h(o))
    bodies = []
    for code in (used, expired["code"], revoked["code"], "ZZZZZZ", "bad!"):
        r = _join(env, code)
        assert r.status_code == 404, code
        bodies.append(r.json())
    assert all(b == {"detail": {"error": "unknown_code"}} for b in bodies)


def test_one_shared_eight_a_minute_bucket(env):
    o = env.owner()
    stand_code = env.client.post("/api/stand/links", json={}, headers=env.h(o)).json()["code"]
    kitchen_codes = [_mint(env, o)["code"] for _ in range(8)]
    for code in kitchen_codes:
        assert _join(env, code).status_code == 200
    # the ninth request in the minute — a perfectly valid STAND code — is refused
    assert _join(env, stand_code).status_code == 429


# ── scope ───────────────────────────────────────────────────────────────

def test_a_kitchen_token_reaches_only_kitchen_routes(env):
    o = env.owner()
    env.setup(o)
    token = _pair(env, o)
    assert env.client.get(f"/api/kitchen/{token}/today").status_code == 200
    assert env.client.get(f"/api/stand/{token}/book").status_code == 404
    for path in ("checks", "devices", "settings", "setup", "folder.pdf", "templates"):
        r = env.client.get(f"/api/kitchen/{token}/{path}")
        assert r.status_code in (404, 405), path
        r = env.client.post(f"/api/kitchen/{token}/{path}", json={})
        assert r.status_code in (404, 405), path
    r = env.client.get("/api/egenkontrol/today", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_a_stand_token_never_reaches_the_kitchen(env):
    o = env.owner()
    env.setup(o)
    code = env.client.post("/api/stand/links", json={}, headers=env.h(o)).json()["code"]
    stand_token = _join(env, code).json()["path"].rsplit("/", 1)[-1]
    assert env.client.get(f"/api/kitchen/{stand_token}/today").status_code == 404
    assert env.client.get(f"/api/kitchen/{stand_token}/folder").status_code == 404


def test_revoke_and_unpair_take_effect_on_the_next_request(env):
    o = env.owner()
    env.setup(o)
    minted = _mint(env, o)
    token = _join(env, minted["code"]).json()["path"].rsplit("/", 1)[-1]
    assert env.client.get(f"/api/kitchen/{token}/today").status_code == 200
    r = env.client.delete(f"/api/egenkontrol/devices/{minted['id']}", headers=env.h(o))
    assert r.status_code == 200
    r = env.client.get(f"/api/kitchen/{token}/today")
    assert r.status_code == 404 and r.json() == {"detail": {"error": "not_found"}}

    t2 = _pair(env, o)
    assert env.client.post(f"/api/kitchen/{t2}/unpair").status_code == 200
    assert env.client.get(f"/api/kitchen/{t2}/today").status_code == 404
    assert env.client.post(f"/api/kitchen/{t2}/unpair").status_code == 404
    env.db.expire_all()
    a = env.db.query(AuditLog).filter(AuditLog.action == "kitchen.link_unpaired").one()
    assert a.actor_type == "kitchen_device"


def test_the_owner_sees_devices_and_a_spent_code_is_hidden(env):
    o = env.owner()
    _pair(env, o, label="Køkken")
    _mint(env, o, label="Ny")
    devs = env.client.get("/api/egenkontrol/devices", headers=env.h(o)).json()["devices"]
    by = {d["label"]: d for d in devs}
    assert by["Køkken"]["paired"] is True and by["Køkken"]["code"] is None
    assert by["Ny"]["paired"] is False and by["Ny"]["code"]
    other = env.owner(name="Other")
    assert env.client.get("/api/egenkontrol/devices", headers=env.h(other)).json()["devices"] == []
    r = env.client.delete(f"/api/egenkontrol/devices/{by['Ny']['id']}", headers=env.h(other))
    assert r.status_code == 404


# ── working a shift ─────────────────────────────────────────────────────

def test_kitchen_today_staff_and_a_reading(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.staff(o, "Zoe Andersen")
    ali = env.staff(o, "Ali Khan", on_shift=True)
    env.staff(o, "Gone Person", deleted=True)
    env.staff(o, "Off Person", active=False)
    token = _pair(env, o, label="Køkken")
    t = env.client.get(f"/api/kitchen/{token}/today").json()
    assert t["venue_name"] == "Bistro Nørrebro" and t["device_label"] == "Køkken"
    assert len(t["checks"]) == 5
    staff = env.client.get(f"/api/kitchen/{token}/staff").json()["staff"]
    assert [(s["name"], s["on_shift"]) for s in staff] == [("Ali K.", True), ("Zoe A.", False)]
    r = env.client.post(f"/api/kitchen/{token}/entries", json=_entry(fridge, staff_id=str(ali.id)))
    assert r.status_code == 201, r.text
    assert r.json()["via"] == "kitchen" and r.json()["staff_name"] == "Ali K."
    env.db.expire_all()
    row = env.db.query(FoodCheckEntry).one()
    link = env.db.query(KitchenLink).filter(KitchenLink.token == token).one()
    assert row.kitchen_link_id == link.id and row.actor_user_id is None
    # the device undoes its own reading
    r = env.client.post(f"/api/kitchen/{token}/entries/{row.id}/undo")
    assert r.status_code == 200 and r.json()["void_reason"] == "undo"
    # the read-only folder
    f = env.client.get(f"/api/kitchen/{token}/folder", params={"days": 30})
    assert f.status_code == 200 and f.json()["summary"]["undone"] == 1
    assert env.client.get(f"/api/kitchen/{token}/folder", params={"days": 31}).status_code == 422


def test_another_links_reading_cannot_be_undone(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    t1, t2 = _pair(env, o), _pair(env, o)
    e = env.client.post(f"/api/kitchen/{t1}/entries", json=_entry(fridge)).json()
    r = env.client.post(f"/api/kitchen/{t2}/entries/{e['id']}/undo")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "undo_not_yours"


def test_a_branch_link_sees_its_branch_and_venue_wide_checks_only(env):
    o = env.owner()
    nord, syd = env.branch(o, "Nord"), env.branch(o, "Syd")
    env.setup(o)
    syd_check = env.client.post("/api/egenkontrol/checks", headers=env.h(o), json={
        "template_key": "fridge", "name": "Syd køl", "branch_id": str(syd.id)}).json()["id"]
    env.client.post("/api/egenkontrol/checks", headers=env.h(o), json={
        "template_key": "fridge", "name": "Nord køl", "branch_id": str(nord.id)})
    token = _pair(env, o, branch_id=str(nord.id))
    t = env.client.get(f"/api/kitchen/{token}/today").json()
    names = [c["name"] for c in t["checks"]]
    assert "Nord køl" in names and "Køl 1" in names and "Syd køl" not in names
    assert t["branch_name"] == "Nord"
    r = env.client.post(f"/api/kitchen/{token}/entries", json=_entry(syd_check))
    assert r.status_code == 404


def test_tenancy_on_the_kitchen_surface(env):
    a, b = env.owner(name="A"), env.owner(name="B")
    a_fridge = env.setup(a)["fridge"]["id"]
    b_fridge = env.setup(b)["fridge"]["id"]
    a_staff = env.staff(a, "Ali Khan")
    b_token = _pair(env, b)
    assert env.client.post(f"/api/kitchen/{b_token}/entries", json=_entry(a_fridge)).status_code == 404
    r = env.client.post(f"/api/kitchen/{b_token}/entries", json=_entry(b_fridge, staff_id=str(a_staff.id)))
    assert r.status_code == 404


def test_last_seen_is_throttled(env):
    o = env.owner()
    env.setup(o)
    token = _pair(env, o)
    env.db.expire_all()
    link = env.db.query(KitchenLink).filter(KitchenLink.token == token).one()
    first = link.last_seen_at
    env.client.get(f"/api/kitchen/{token}/today")
    env.client.get(f"/api/kitchen/{token}/today")
    env.db.expire_all()
    assert env.db.query(KitchenLink).filter(KitchenLink.token == token).one().last_seen_at == first


def test_the_token_never_reaches_a_log_path():
    token = "abcDEF123_-abcDEF123_-abcDEF12"
    assert token not in redact_path(f"/api/kitchen/{token}/today")
    assert redact_path(f"/api/kitchen/{token}/today") == "/api/kitchen/:redacted/today"


def test_the_kitchen_rate_limit_is_per_token(env):
    o = env.owner()
    env.setup(o)
    t1, t2 = _pair(env, o), _pair(env, o)
    codes = [env.client.get(f"/api/kitchen/{t1}/folder").status_code for _ in range(11)]
    assert codes[-1] == 429
    assert env.client.get(f"/api/kitchen/{t2}/folder").status_code == 200
    assert StandLink  # the import documents the sibling credential
