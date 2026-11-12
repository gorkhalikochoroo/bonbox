"""The server owns business_profiles.dawa_address_id (DAWA replacement plan
3.4, Audit P2 / Task #76).

The market-comparison gate trusts this id, and PUT /business stored any
string a client sent in it. Now:
  • a client value is ignored (old builds still send it);
  • the server washes the address against Danmarks Adresseregister AFTER the
    save's own commit, when the address changed or when no id is stored and
    the save came from the register (cvrapi.dk / virk.dk) — never because the
    client sent an id;
  • A (unit or building) sets the id; a near match (B) or not found clears
    it; "couldn't check" clears it only when the address changed;
  • the id write is compare-and-set on the washed address;
  • a failed wash never fails the save, and nothing but the id is written
    (a confirmed geofence anchor is never moved).

Register replies are REAL recordings (tests/_geo_fixtures.py).
"""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.routers import business_profile as bp_router
from app.services.auth import get_current_user, hash_password
from app.services.dawa_verify import Outcome
from tests._geo_fixtures import geo_on  # noqa: F401 — fixture

_db_ready.set()

CPH_ID = "70865c44-d570-44e7-a6f5-6f7c90add725"          # Rådhuspladsen 1, 1550 (adresse)
BUILDING_ID = "0a3f507a-9af2-32b8-e044-0003ba298018"     # Islands Brygge 32B, 2300 (husnummer)
CPH = {"address": "Rådhuspladsen 1", "zipcode": "1550", "city": "København V"}


@pytest.fixture
def env():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_test_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    s = Session()
    u = User(email=f"{uuid.uuid4().hex[:8]}@bonbox.dk", password_hash=hash_password("pw123456"),
             business_name="Bon Bistro", business_type="cafe", currency="DKK", plan="pro", role="owner")
    s.add(u)
    s.commit()
    s.refresh(u)
    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: u
    bp_router._limiter.reset()

    class Env:
        client = TestClient(app)
        user = u
        SessionLocal = Session

        def profile(self):
            with Session() as fresh:
                return fresh.query(BusinessProfile).filter_by(user_id=u.id).first()

        def seed(self, **fields):
            with Session() as fresh:
                p = BusinessProfile(id=uuid.uuid4(), user_id=u.id, company_name="Bon Bistro",
                                    country="DK", **fields)
                fresh.add(p)
                fresh.commit()

    yield Env()
    app.dependency_overrides.clear()
    bp_router._limiter.reset()
    s.close()


def _put(env, **body):
    r = env.client.put("/api/business", json={"company_name": "Bon Bistro", **body})
    assert r.status_code == 200, r.text
    return r.json()


# ── the client value is never trusted ───────────────────────────────────

def test_a_crafted_id_is_ignored_when_a_profile_is_created(env):
    out = _put(env, **CPH, dawa_address_id="forged-0000")
    assert out["dawa_address_id"] is None
    assert env.profile().dawa_address_id is None


def test_a_crafted_id_is_ignored_on_an_update(env, geo_on):
    env.seed(**CPH, dawa_address_id=CPH_ID)
    t = geo_on()
    out = _put(env, **CPH, cuisine="italian", dawa_address_id="forged-0000")
    assert out["dawa_address_id"] == CPH_ID
    assert t.calls == [], "nothing about the address changed: no outbound call"


def test_a_crafted_id_cannot_unlock_market_comparison(env):
    """Old builds send dawa_address_id from the picker. A forged one on a
    register-source save (which also stamps cvr_verified_at) must not open
    the gate: the server's own wash decides (here: couldn't check -> none)."""
    out = _put(env, **CPH, source="cvrapi.dk", dawa_address_id=CPH_ID, cuisine="italian")
    assert out["cvr_verified_at"] is not None
    assert out["dawa_address_id"] is None


# ── the server's wash decides ───────────────────────────────────────────

def test_a_verified_address_gets_the_server_set_id(env, geo_on):
    geo_on()
    out = _put(env, **CPH)
    assert out["dawa_address_id"] == CPH_ID


def test_a_building_level_match_stores_the_husnummer_id(env, geo_on):
    geo_on()
    out = _put(env, address="Islands Brygge 32B 2300 København S", zipcode="2300", city="København S")
    assert out["dawa_address_id"] == BUILDING_ID


def test_a_near_match_stores_no_id(env, geo_on):
    """"Algade 2, 9000" washes to "Adelgade 2" (kode 900): the picker, not trust."""
    geo_on()
    out = _put(env, address="Algade 2", zipcode="9000", city="Aalborg")
    assert out["dawa_address_id"] is None


def test_an_address_change_clears_the_old_id_when_the_register_is_down(env):
    env.seed(**CPH, dawa_address_id=CPH_ID)
    out = _put(env, address="Søndergade 2", zipcode="8000", city="Aarhus C")
    assert out["dawa_address_id"] is None


def test_an_address_change_to_a_miss_clears_the_id(env, geo_on):
    env.seed(**CPH, dawa_address_id=CPH_ID)
    geo_on()
    out = _put(env, address="Søndergade 1", zipcode="8000", city="Aarhus C")
    assert out["dawa_address_id"] is None


def test_an_address_change_to_a_real_address_sets_the_new_id(env, geo_on):
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C", dawa_address_id="old-id")
    geo_on()
    out = _put(env, **CPH)
    assert out["dawa_address_id"] == CPH_ID


def test_unavailable_with_the_address_unchanged_keeps_the_id(env, monkeypatch):
    """Re-verify washes when no id is stored; here the stamp helper is driven
    directly with an unchanged address and a register outage: the old id
    stays."""
    env.seed(**CPH, dawa_address_id=CPH_ID)
    monkeypatch.setattr(bp_router, "verify_address_outcome",
                        lambda *a, **k: (Outcome.UNAVAILABLE, None))
    p = env.profile()
    with env.SessionLocal() as s:
        bp_router._stamp_register_address_id(
            s, profile_id=p.id, country="DK", snapshot=(p.address, p.zipcode, p.city),
            address_changed=False, stored_id=CPH_ID, user_key="u")
    assert env.profile().dawa_address_id == CPH_ID


def test_no_call_when_only_other_fields_change(env, geo_on):
    env.seed(**CPH, dawa_address_id=CPH_ID)
    t = geo_on()
    _put(env, **CPH, cuisine="ramen", phone="+45 11 22 33 44")
    _put(env, address=" Rådhuspladsen 1 ", zipcode="1550", city="københavn v")  # echo, not a move
    assert t.calls == []
    assert env.profile().dawa_address_id == CPH_ID


def test_a_register_source_save_with_no_id_triggers_a_wash(env, geo_on):
    env.seed(**CPH)
    t = geo_on()
    out = _put(env, **CPH, source="cvrapi.dk")
    assert out["dawa_address_id"] == CPH_ID
    assert t.paths()[0] == "/vask/"


def test_a_manual_save_with_no_id_and_no_change_makes_no_call(env, geo_on):
    env.seed(**CPH)
    t = geo_on()
    _put(env, **CPH, source="manual")
    assert t.calls == []


def test_a_non_danish_profile_is_never_sent(env, geo_on):
    t = geo_on()
    out = _put(env, country="NO", address="Karl Johans gate 1", zipcode="0154", city="Oslo")
    assert out["dawa_address_id"] is None
    assert t.calls == []


def test_a_failed_wash_never_fails_the_save(env, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("register exploded")

    monkeypatch.setattr(bp_router, "verify_address_outcome", boom)
    out = _put(env, **CPH, cuisine="italian")
    assert out["address"] == "Rådhuspladsen 1" and out["cuisine"] == "italian"
    assert out["dawa_address_id"] is None


# ── order and races ─────────────────────────────────────────────────────

def test_the_wash_runs_after_the_save_is_committed(env, monkeypatch):
    """The pooled connection goes back before the outbound call: when the
    wash runs, the new address is already committed (another session sees
    it)."""
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C")
    seen = {}

    def fake(address, zipcode, city, *, user_key=None):
        seen["committed"] = env.profile().address
        return Outcome.FOUND, {"id": CPH_ID, "category": "A"}

    monkeypatch.setattr(bp_router, "verify_address_outcome", fake)
    out = _put(env, **CPH)
    assert seen["committed"] == "Rådhuspladsen 1"
    assert out["dawa_address_id"] == CPH_ID


def test_compare_and_set_refuses_a_stale_id(env, monkeypatch):
    """A parallel save moved the address while the wash was out: the washed
    id must not land beside the newer address."""
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C")

    def fake(address, zipcode, city, *, user_key=None):
        with env.SessionLocal() as other:
            p = other.query(BusinessProfile).filter_by(user_id=env.user.id).first()
            p.address = "Søndergade 2"
            p.zipcode = "8000"
            p.city = "Aarhus C"
            other.commit()
        return Outcome.FOUND, {"id": CPH_ID, "category": "A"}

    monkeypatch.setattr(bp_router, "verify_address_outcome", fake)
    _put(env, **CPH)
    p = env.profile()
    assert p.address == "Søndergade 2"
    assert p.dawa_address_id is None


def test_a_confirmed_geofence_anchor_is_never_moved(env, geo_on):
    anchor = json.dumps({"enabled": True, "lat": 55.6734, "lng": 12.5692, "radius_m": 150,
                         "anchor_source": "gps", "anchor_label": None})
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C", clock_settings_json=anchor)
    geo_on()
    out = _put(env, **CPH)
    assert out["dawa_address_id"] == CPH_ID
    assert env.profile().clock_settings_json == anchor


# ── demo exit and re-verify ─────────────────────────────────────────────

def test_leaving_the_demo_company_drops_the_sample_id(env, geo_on):
    """The demo seeder writes the sample's DAR id directly. When the owner
    replaces the sample company with their own, the sample's id must not
    survive under their address; their own address is washed."""
    from app.services.demo_seed import _seed_business_profile
    with env.SessionLocal() as s:
        u = s.query(User).filter_by(id=env.user.id).first()
        _seed_business_profile(s, u, mark_demo=True)
        s.commit()
    assert env.profile().dawa_address_id == "0a3f50ad-2b4f-32b8-e044-0003ba298018"
    geo_on()
    out = _put(env, company_name="Rådhus Café ApS", org_number="12345678", **CPH, source="manual")
    assert out["dawa_address_id"] == CPH_ID


def test_reverify_that_moves_the_address_rewashes(env, geo_on, monkeypatch):
    from datetime import timedelta
    from app.utils.time import utc_now
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C", dawa_address_id="old-id",
             org_number="12345678", cvr_verified_at=utc_now() - timedelta(days=3))

    async def fake_lookup(q, country):
        return [{"name": "Bon Bistro", "address": "Rådhuspladsen 1", "zipcode": "1550",
                 "city": "København V", "source": "cvrapi.dk", "status_flags": [],
                 "vat_registered": True}]

    monkeypatch.setattr(bp_router, "lookup_business", fake_lookup)
    geo_on()
    r = env.client.post("/api/business/reverify")
    assert r.status_code == 200, r.text
    assert "address" in r.json()["fields_changed"]
    assert env.profile().dawa_address_id == CPH_ID


def test_reverify_with_the_register_down_clears_a_moved_id(env, monkeypatch):
    from datetime import timedelta
    from app.utils.time import utc_now
    env.seed(address="Søndergade 1", zipcode="8000", city="Aarhus C", dawa_address_id="old-id",
             org_number="12345678", cvr_verified_at=utc_now() - timedelta(days=3))

    async def fake_lookup(q, country):
        return [{"name": "Bon Bistro", "address": "Rådhuspladsen 1", "zipcode": "1550",
                 "city": "København V", "source": "cvrapi.dk"}]

    monkeypatch.setattr(bp_router, "lookup_business", fake_lookup)
    r = env.client.post("/api/business/reverify")
    assert r.status_code == 200, r.text
    assert env.profile().dawa_address_id is None
