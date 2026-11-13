"""Egenkontrol R1a — erasure, export, retention, and no fake records.

  • DELETE /api/auth/delete-account removes every food_* and kitchen_links row
    of that venue (with SQLite foreign keys ON, as in
    test_delete_account_completeness) and leaves another venue's rows alone;
  • the GDPR export carries the five tables and never kitchen_links.token or
    join_code;
  • the 730-day purge deletes old readings and keeps younger ones, always on,
    and is part of the nightly run;
  • the demo seeders create NO egenkontrol rows — a made-up record shown to an
    inspector is a serious problem (plan A4).
"""
import csv
import io
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.food_check import (
    FoodCheck, FoodCheckDocument, FoodCheckEntry, FoodCheckPhoto, FoodCheckReview,
    FoodCheckRevision, FoodCheckSettings,
)
from app.models.kitchen_link import KitchenLink
from tests._ek_support import env, store  # noqa: F401 — fixtures

# R1b adds reviews, documents and photos (8 egenkontrol tables in all).
EK_MODELS = (FoodCheck, FoodCheckRevision, FoodCheckEntry, FoodCheckSettings, KitchenLink,
             FoodCheckReview, FoodCheckDocument, FoodCheckPhoto)
R1A_MODELS = EK_MODELS[:5]


def _seed_venue(env, name):
    o = env.owner(name=name, email=f"{name.lower()}-{uuid.uuid4().hex[:6]}@bonbox.dk")
    checks = env.setup(o)
    fridge = checks["fridge"]["id"]
    staff = env.staff(o, "Ali Khan")
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck",
             staff_id=str(staff.id))
    env.clock.tick(minutes=30)
    env.save(o, fridge, 4.0, fate_code="assessed_ok")
    r = env.client.post("/api/egenkontrol/devices", json={"label": "Køkken"}, headers=env.h(o))
    code = r.json()["code"]
    tok = env.client.post("/api/stand/join", json={"code": code}).json()["path"].rsplit("/", 1)[-1]
    env.client.post(f"/api/kitchen/{tok}/entries", json={
        "client_id": str(uuid.uuid4()), "check_id": fridge, "value_c": 3.0, "typed_name": "Bo"})
    return o, tok


def _count(env, uid, models=R1A_MODELS):
    env.db.expire_all()
    return {m.__tablename__: env.db.query(m).filter(m.user_id == uid).count() for m in models}


def test_delete_account_erases_every_egenkontrol_row_and_only_that_venues(env):
    with env.engine.connect() as c:
        c.execute(text("PRAGMA foreign_keys=ON"))
    gone, _ = _seed_venue(env, "Gone")
    kept, _ = _seed_venue(env, "Kept")
    assert all(_count(env, gone.id).values())
    r = env.client.request("DELETE", "/api/auth/delete-account",
                           json={"password": "ownerpw123"}, headers=env.h(gone))
    assert r.status_code == 200, r.text
    assert set(_count(env, gone.id).values()) == {0}
    assert all(_count(env, kept.id).values())


def test_gdpr_export_has_the_tables_and_no_device_secrets(env):
    o, tok = _seed_venue(env, "Export")
    r = env.client.get("/api/auth/export-data", headers=env.h(o))
    assert r.status_code == 200, r.text
    body = r.text
    sections = {}
    cur = None
    for row in csv.reader(io.StringIO(body)):
        if row and row[0].startswith("=== table: "):
            cur = row[0][len("=== table: "):].split(" (")[0]
            sections[cur] = []
        elif cur and row:
            sections[cur].append(row)
    for t in ("food_checks", "food_check_revisions", "food_check_entries",
              "food_check_settings", "kitchen_links"):
        assert t in sections, t
    header = sections["kitchen_links"][0]
    assert "token" not in header and "join_code" not in header
    assert tok not in body


@pytest.fixture
def purge_db(monkeypatch):
    from app.jobs import privacy_purges as pp
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    SL = sessionmaker(bind=eng)
    monkeypatch.setattr(pp, "SessionLocal", SL)
    return SL


def test_the_730_day_purge_deletes_old_readings_only(env, monkeypatch):
    from app.jobs import privacy_purges as pp
    assert pp.EGENKONTROL_RETENTION_DAYS == 730
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    old_id = env.save(o, fridge, 3.0).json()["id"]
    env.clock.tick(days=400)
    young_id = env.save(o, fridge, 3.1).json()["id"]
    now = env.clock() + timedelta(days=331)   # old: 731 days, young: 331 days
    monkeypatch.setattr(pp, "SessionLocal", env.SL)
    assert pp.dry_run_counts(env.SL(), now=now)["egenkontrol_entries"] == 1
    out = pp.purge_old_egenkontrol_entries(now=now)
    assert out == {"due": 1, "deleted": 1, "dry_run": False}
    env.db.expire_all()
    left = {str(r.id) for r in env.db.query(FoodCheckEntry).all()}
    assert left == {young_id} and old_id not in left


def test_the_purge_is_in_the_nightly_run_and_always_on(purge_db, monkeypatch):
    from app.jobs import privacy_purges as pp
    assert ("egenkontrol_entries", "purge_old_egenkontrol_entries") in pp._PURGES
    out = pp.run_privacy_purges()
    assert out["egenkontrol_entries"] == {"due": 0, "deleted": 0, "dry_run": False}


def test_demo_seeders_create_no_egenkontrol_rows():
    from app.models.business_profile import BusinessProfile
    from app.models.user import User
    from app.services.auth import hash_password
    from app.services.demo_seed import seed_demo_account, seed_for_user

    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        u = User(email="cafe@bonbox.dk", password_hash=hash_password("x12345678"),
                 business_name="Café", business_type="cafe", currency="DKK", role="owner")
        s.add(u)
        s.commit()
        s.add(BusinessProfile(user_id=u.id))
        s.commit()
        seed_for_user(s, u)
        seed_demo_account(s)
        s.commit()
        for m in EK_MODELS:
            assert s.query(m).count() == 0, m.__tablename__
    finally:
        s.close()
    assert datetime


def test_r1b_tables_are_in_the_export_and_erased(env, store):
    """R1b: reviews, documents and photos travel with the export and go with
    the account (the delete-account walk + the blob prefix purge — the blob
    half is pinned in test_egenkontrol_r1b_documents)."""
    with env.engine.connect() as c:
        c.execute(text("PRAGMA foreign_keys=ON"))
    o, _ = _seed_venue(env, "R1b")
    fridge = env.today_json(o)["checks"][0]["id"]
    dev = env.save(o, fridge, 9.0, action_code="thermostat_adjusted", fate_code="moved").json()
    assert env.photo(o, dev["id"]).status_code == 201
    assert env.doc(o).status_code == 201
    env.clock.set(datetime(2026, 11, 17, 9, 0))
    assert env.client.post("/api/egenkontrol/week/2026-W46/reviewed", json={},
                           headers=env.h(o)).status_code == 201
    body = env.client.get("/api/auth/export-data", headers=env.h(o)).text
    for t in ("food_check_reviews", "food_check_documents", "food_check_photos"):
        assert f"=== table: {t}" in body, t
    uid = o.id
    assert all(_count(env, uid, EK_MODELS[5:]).values())
    r = env.client.request("DELETE", "/api/auth/delete-account",
                           json={"password": "ownerpw123"}, headers=env.h(o))
    assert r.status_code == 200, r.text
    env.db.expunge_all()
    assert set(_count(env, uid, EK_MODELS).values()) == {0}
