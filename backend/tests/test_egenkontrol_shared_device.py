"""Egenkontrol R1a — the shared-device ("Delt enhed") curtain (lead override).

A tablet the owner flagged shared carries a server-signed `sd` claim. On it,
the Kontrolmappe (folder + PDF), the kitchen-device list and every config
write need the existing reveal-PIN proof — enforced by main.py's
shared_device_pin_gate through the shared device's OWN tuples. Readings and
undo stay open (it is the counter device) and are marked via="shared".

The member/manager read tuples are NOT touched: a manager seat still reads the
Kontrolmappe and the PDF, and manager == member stays true.

Token + proof are built exactly as tests/test_device_pin.py builds them.
"""
import uuid

from app.main import (
    _MANAGER_READ_DENY_PREFIXES,
    _MEMBER_READ_DENY_PREFIXES,
    _SHARED_DEVICE_DENY_PREFIXES,
    _SHARED_DEVICE_DENY_WRITE_PREFIXES,
    _SHARED_DEVICE_EXTRA_READ_DENY_PREFIXES,
)
from app.models.food_check import FoodCheckEntry
from app.services.auth import hash_password, mint_device_pin_proof
from tests._ek_support import START, env, store  # noqa: F401 — fixtures

NONCE = "shared-ipad-1"


def _shared_owner(env):
    o = env.owner()
    o.device_pin_hash = hash_password("4271")
    env.db.commit()
    env.db.refresh(o)
    return o


def _proof(o):
    return mint_device_pin_proof(str(o.id), o.device_pin_hash, NONCE)


def _locked(env, o):
    return env.h(o, shared=True, nonce=NONCE)


def _revealed(env, o):
    return env.h(o, shared=True, nonce=NONCE, proof=_proof(o))


def _pin_required(r):
    return r.status_code == 403 and r.json()["detail"]["code"] == "device_pin_required"


def test_folder_pdf_and_devices_need_the_pin_on_a_shared_tablet(env):
    o = _shared_owner(env)
    env.setup(o)
    for path in ("/api/egenkontrol/folder", "/api/egenkontrol/folder.pdf",
                 "/api/egenkontrol/devices"):
        assert _pin_required(env.client.get(path, headers=_locked(env, o))), path
        r = env.client.get(path, headers=_revealed(env, o))
        assert r.status_code == 200, (path, r.text)


def test_config_writes_need_the_pin_on_a_shared_tablet(env):
    o = _shared_owner(env)
    c = env.client
    locked = _locked(env, o)
    assert _pin_required(c.post("/api/egenkontrol/setup", json={"items": START}, headers=locked))
    r = c.post("/api/egenkontrol/setup", json={"items": START}, headers=_revealed(env, o))
    assert r.status_code == 201, r.text
    fridge = next(x["id"] for x in r.json()["checks"] if x["template_key"] == "fridge")

    assert _pin_required(c.post("/api/egenkontrol/checks", headers=locked,
                                json={"template_key": "fridge", "name": "Køl 2"}))
    assert _pin_required(c.patch(f"/api/egenkontrol/checks/{fridge}", headers=locked,
                                 json={"name": "Køl A"}))
    assert _pin_required(c.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=locked))
    assert _pin_required(c.post("/api/egenkontrol/devices", headers=locked, json={}))

    rev = _revealed(env, o)
    assert c.post("/api/egenkontrol/checks", headers=rev,
                  json={"template_key": "fridge", "name": "Køl 2"}).status_code == 201
    assert c.patch(f"/api/egenkontrol/checks/{fridge}", headers=rev,
                   json={"name": "Køl A"}).status_code == 200
    dev = c.post("/api/egenkontrol/devices", headers=rev, json={})
    assert dev.status_code == 201
    assert _pin_required(c.delete(f"/api/egenkontrol/devices/{dev.json()['id']}", headers=locked))
    assert c.delete(f"/api/egenkontrol/devices/{dev.json()['id']}", headers=rev).status_code == 200
    assert c.post(f"/api/egenkontrol/checks/{fridge}/archive", headers=rev).status_code == 200


def test_today_status_readings_and_undo_stay_open_on_a_curtained_tablet(env):
    o = _shared_owner(env)
    fridge = env.setup(o)["fridge"]["id"]
    locked = _locked(env, o)
    assert env.client.get("/api/egenkontrol/today", headers=locked).status_code == 200
    assert env.client.get("/api/egenkontrol/status", headers=locked).status_code == 200
    assert env.client.get("/api/egenkontrol/staff", headers=locked).status_code == 200
    r = env.client.post("/api/egenkontrol/entries", headers=locked, json={
        "client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3.0, "typed_name": "Mia"})
    assert r.status_code == 201, r.text
    assert r.json()["via"] == "shared"
    env.db.expire_all()
    assert env.db.query(FoodCheckEntry).one().actor_user_id == o.id
    u = env.client.post(f"/api/egenkontrol/entries/{r.json()['id']}/undo", headers=locked)
    assert u.status_code == 200 and u.json()["void_reason"] == "undo"


def test_a_manager_seat_is_not_curtained(env):
    o = _shared_owner(env)
    env.setup(o)
    h = env.h(env.member(o, "manager"))
    assert env.client.get("/api/egenkontrol/folder", headers=h).status_code == 200
    assert env.client.get("/api/egenkontrol/folder.pdf", headers=h).status_code == 200


def test_the_member_and_manager_tuples_are_untouched():
    for tup in (_MEMBER_READ_DENY_PREFIXES, _MANAGER_READ_DENY_PREFIXES):
        assert not any(p.startswith("/api/egenkontrol") for p in tup)
    assert set(_MANAGER_READ_DENY_PREFIXES) == set(_MEMBER_READ_DENY_PREFIXES)
    for p in _MANAGER_READ_DENY_PREFIXES:
        assert p in _SHARED_DEVICE_DENY_PREFIXES
    assert "/api/egenkontrol/folder" in _SHARED_DEVICE_DENY_PREFIXES
    assert "/api/egenkontrol/devices" in _SHARED_DEVICE_DENY_PREFIXES
    assert set(_SHARED_DEVICE_EXTRA_READ_DENY_PREFIXES) == {
        "/api/egenkontrol/folder", "/api/egenkontrol/devices",
        # R1b
        "/api/egenkontrol/week", "/api/egenkontrol/documents", "/api/egenkontrol/photos"}
    # readings, undo and (R1b) the photo upload are counter work: neither
    # shared tuple catches them
    for path in ("/api/egenkontrol/entries", "/api/egenkontrol/entries/x/undo",
                 "/api/egenkontrol/entries/x/photo",
                 "/api/egenkontrol/today", "/api/egenkontrol/status"):
        assert not any(path.startswith(p) for p in _SHARED_DEVICE_DENY_PREFIXES), path
        assert not any(path.startswith(p) for p in _SHARED_DEVICE_DENY_WRITE_PREFIXES), path
    for path in ("/api/egenkontrol/setup", "/api/egenkontrol/checks",
                 "/api/egenkontrol/checks/x/archive", "/api/egenkontrol/devices/x",
                 "/api/egenkontrol/settings",
                 # R1b
                 "/api/egenkontrol/paper-entries", "/api/egenkontrol/corrections",
                 "/api/egenkontrol/week/2026-W45/reviewed", "/api/egenkontrol/documents",
                 "/api/egenkontrol/documents/x/reviewed", "/api/egenkontrol/photos/x"):
        assert any(path.startswith(p) for p in _SHARED_DEVICE_DENY_WRITE_PREFIXES), path
    # the existing payroll entry is still there
    assert "/api/staff/payroll" in _SHARED_DEVICE_DENY_WRITE_PREFIXES


# ── R1b ─────────────────────────────────────────────────────────────────

def test_r1b_owner_records_need_the_pin_on_a_shared_tablet(env, store):
    from datetime import datetime
    o = _shared_owner(env)
    checks = env.setup(o)
    fridge = checks["fridge"]["id"]
    locked, rev = _locked(env, o), _revealed(env, o)
    c = env.client
    e = env.save(o, fridge, 3.0).json()
    env.clock.tick(minutes=60)                                   # 08:30

    # paper entries and corrections
    assert _pin_required(env.paper(o, fridge, 3.0, "2026-11-12", "08:00", headers=locked))
    assert env.paper(o, fridge, 3.0, "2026-11-12", "08:00", headers=rev).status_code == 201
    assert _pin_required(env.correct(o, e["id"], "typo", value_c=3.5, headers=locked))
    assert env.correct(o, e["id"], "typo", value_c=3.5, headers=rev).status_code == 201

    # documents: list, upload, file, review, delete
    assert _pin_required(c.get("/api/egenkontrol/documents", headers=locked))
    assert _pin_required(env.doc(o, headers=locked))
    d = env.doc(o, headers=rev)
    assert d.status_code == 201, d.text
    did = d.json()["id"]
    assert c.get("/api/egenkontrol/documents", headers=rev).status_code == 200
    assert _pin_required(c.get(f"/api/egenkontrol/documents/{did}/file", headers=locked))
    assert c.get(f"/api/egenkontrol/documents/{did}/file", headers=rev).status_code == 200
    assert _pin_required(c.post(f"/api/egenkontrol/documents/{did}/reviewed", headers=locked))
    assert _pin_required(c.delete(f"/api/egenkontrol/documents/{did}", headers=locked))

    # photos: the UPLOAD is counter work (no PIN); viewing / removing needs it
    dev = env.save(o, fridge, 9.0, action_code="thermostat_adjusted", fate_code="moved",
                   headers=locked).json()
    p = env.photo(o, dev["id"], headers=locked)
    assert p.status_code == 201, p.text
    assert p.json()["via"] == "shared"
    pid = p.json()["id"]
    assert _pin_required(c.get(f"/api/egenkontrol/photos/{pid}", headers=locked))
    assert c.get(f"/api/egenkontrol/photos/{pid}", headers=rev).status_code == 200
    assert _pin_required(c.delete(f"/api/egenkontrol/photos/{pid}", headers=locked))
    assert c.delete(f"/api/egenkontrol/photos/{pid}", headers=rev).status_code == 200

    # the weekly review, and settings
    env.clock.set(datetime(2026, 11, 17, 9, 0))
    assert _pin_required(c.get("/api/egenkontrol/week", headers=locked))
    assert c.get("/api/egenkontrol/week", headers=rev).status_code == 200
    assert _pin_required(c.post("/api/egenkontrol/week/2026-W46/reviewed", json={}, headers=locked))
    assert c.post("/api/egenkontrol/week/2026-W46/reviewed", json={}, headers=rev).status_code == 201
    assert _pin_required(c.put("/api/egenkontrol/settings", json={}, headers=locked))


def test_r1b_a_manager_seat_still_reads(env, store):
    o = _shared_owner(env)
    env.setup(o)
    env.doc(o)
    h = env.h(env.member(o, "manager"))
    for path in ("/api/egenkontrol/folder", "/api/egenkontrol/folder.pdf",
                 "/api/egenkontrol/week", "/api/egenkontrol/documents",
                 "/api/egenkontrol/settings"):
        assert env.client.get(path, headers=h).status_code == 200, path
