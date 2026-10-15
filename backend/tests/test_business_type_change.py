"""Changing the business type later + the bar module ids (vertical-fit, Oct 2026).

Covers:
  • the contract that every archetype's suggested module id is either a
    canonical services/modules.py id (one a nav gate reads) or a documented
    legacy signal id — never an old spelling like "pour"/"wine";
  • a new bar gets bar_pour + wine_sommelier, and the old spellings map;
  • the boot backfill that RENAMES "pour"/"wine" in place — never adds a
    module, never past the plan's module cap (a Free bar after its trial);
  • a team member's business_type follows the owner's (POST + PATCH + boot);
  • plan_type_change / apply_type_change: the cutoff moves only while it is
    the old type's default, modules + categories are only added (within the
    plan's module cap), a pillar is hidden only when unused, nothing deleted;
  • POST /api/auth/business-type + GET /api/auth/business-type/preview.

Run: cd backend && pytest tests/test_business_type_change.py -v
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.business_profile import BusinessProfile
from app.models.expense import ExpenseCategory
from app.models.user import User
from app.services.archetype import ARCHETYPES
from app.services.archetype_defaults import (
    _MODULE_ALIASES,
    align_member_business_types,
    apply_archetype_defaults,
    apply_type_change,
    plan_type_change,
    rename_legacy_module_ids,
)
from app.services.auth import get_current_user, hash_password
from app.services.modules import MODULES, get_enabled
from app.services.pillars import get_hidden
from app.utils.time import utc_now

_db_ready.set()

# Ids no gate reads — kept in the CSV for continuity, documented in archetype.py.
_LEGACY_SIGNAL_IDS = {"competitor", "weather", "expiry", "khata", "loan"}
_CANONICAL = {m["id"] for m in MODULES}


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture
def db(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db, email, business_type="cafe", enabled_modules=None, role="owner",
          hidden_pillars=None, cutoff=None, trial_days=None, owner=None):
    # trial_days: >0 = a live trial (every new account starts on one — the
    # module cap is unlimited); <0 = a trial that ended (Free, cap 1);
    # None = no trial at all (Free).
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Test Biz",
        business_type=business_type,
        currency="DKK",
        role=role,
        email_verified=True,
        enabled_modules=enabled_modules,
        hidden_pillars=hidden_pillars,
        trial_ends_at=(utc_now() + timedelta(days=trial_days)) if trial_days else None,
        owner_id=owner.id if owner is not None else None,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    if cutoff is not None:
        db.add(BusinessProfile(user_id=u.id, day_cutoff_hour=cutoff))
        db.commit()
    return u


def _categories(db, user):
    return sorted(c.name for c in db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id))


# ─── Module ids ──────────────────────────────────────────────────────────

def test_every_suggested_module_id_is_canonical_or_a_documented_signal():
    for arch_id, arch in ARCHETYPES.items():
        for mid in arch["suggested_modules"]:
            assert mid not in _MODULE_ALIASES, f"{arch_id} suggests old spelling {mid!r}"
            assert mid in _CANONICAL or mid in _LEGACY_SIGNAL_IDS, (
                f"{arch_id} suggests {mid!r}: not a modules.py id and not a known signal id")


def test_every_alias_points_at_a_real_module():
    for old, canon in _MODULE_ALIASES.items():
        assert canon in _CANONICAL, (old, canon)


def test_new_bar_gets_bar_pour_and_wine(db):
    # A new account is on its trial at onboarding — unlimited modules.
    u = _user(db, "bar@bonbox.test", business_type="bar", trial_days=10)
    apply_archetype_defaults(db, u)
    db.refresh(u)
    assert set(get_enabled(u)) == {"bar_pour", "wine_sommelier"}


def test_onboarding_never_grants_past_the_module_cap(db):
    # A bar that runs the wizard after its trial ended is Free (cap 1): the
    # bar's two suggestions must not become two modules.
    u = _user(db, "late@bonbox.test", business_type="bar", trial_days=-3)
    apply_archetype_defaults(db, u)
    db.refresh(u)
    assert get_enabled(u) == ["bar_pour"]
    # The signal id is no module and still rides along.
    assert "competitor" in (u.enabled_modules or "").split(",")
    # One already held: nothing new is granted, nothing taken.
    full = _user(db, "full2@bonbox.test", business_type="bar", trial_days=-3, enabled_modules="workshop")
    apply_archetype_defaults(db, full)
    db.refresh(full)
    assert get_enabled(full) == ["workshop"]


def test_old_spelling_maps_on_merge(db, monkeypatch):
    import app.services.archetype_defaults as ad
    real = ad.archetype_defaults

    def fake(bt):
        d = real(bt)
        d["suggested_modules"] = ["pour", "wine"]
        return d

    monkeypatch.setattr(ad, "archetype_defaults", fake)
    u = _user(db, "alias@bonbox.test", business_type="bar", enabled_modules="khata", trial_days=10)
    ad.apply_archetype_defaults(db, u)
    db.refresh(u)
    csv = (u.enabled_modules or "").split(",")
    assert csv[0] == "khata"
    assert "bar_pour" in csv and "wine_sommelier" in csv
    assert "pour" not in csv and "wine" not in csv


def test_backfill_renames_in_place_and_never_adds(session_factory):
    s = session_factory()
    trial = _user(s, "a@bonbox.test", business_type="bar", enabled_modules="pour,wine,competitor", trial_days=10)
    pro = _user(s, "p@bonbox.test", business_type="bar", enabled_modules="pour,wine,competitor")
    pro.plan = "pro"  # a non-Stripe grant: honoured, unlimited modules
    s.commit()
    b = _user(s, "b@bonbox.test", business_type="cafe", enabled_modules="competitor,weather")
    c = _user(s, "c@bonbox.test", business_type="bar", enabled_modules="bar_pour")  # saved on /modules
    d = _user(s, "d@bonbox.test", business_type="bar", enabled_modules=None)
    one = _user(s, "e@bonbox.test", business_type="bar", enabled_modules="pour,competitor", trial_days=-5)
    for _ in range(2):  # every boot runs it — the second pass must be a no-op
        rename_legacy_module_ids(s)
    s.expire_all()
    rows = {u.email: u.enabled_modules for u in s.query(User).all()}
    # Renamed where the old spelling stood — nothing appended beside it.
    assert rows[pro.email] == "bar_pour,wine_sommelier,competitor"
    # A live trial counts with the Free cap at boot (Push 8, M1): two old ids
    # would be two real modules, so the row stays as it was — the answer the
    # boot gives after the trial too, whatever the deploy date.
    assert rows[trial.email] == "pour,wine,competitor"
    assert rows[b.email] == "competitor,weather"
    assert rows[c.email] == "bar_pour"
    assert rows[d.email] is None
    # Free, one old id → one module: within the cap, so renamed.
    assert rows[one.email] == "bar_pour,competitor"
    s.close()


def test_backfill_keeps_a_free_bar_after_trial_within_its_cap(session_factory):
    # The bar signed up on a trial and got "pour,wine" (no gate read them). The
    # trial ended: Free, one module. Renaming would hand it two real modules,
    # so the row stays exactly as it was — the owner picks on /modules.
    s = session_factory()
    bar = _user(s, "free@bonbox.test", business_type="bar", enabled_modules="pour,wine,competitor", trial_days=-1)
    mixed = _user(s, "mixed@bonbox.test", business_type="bar", enabled_modules="workshop,pour", trial_days=-1)
    out = rename_legacy_module_ids(s)
    assert out == {"renamed": 0, "kept": 2}
    s.expire_all()
    assert s.get(User, bar.id).enabled_modules == "pour,wine,competitor"
    assert s.get(User, mixed.id).enabled_modules == "workshop,pour"
    assert get_enabled(s.get(User, bar.id)) == []
    assert get_enabled(s.get(User, mixed.id)) == ["workshop"]
    s.close()


# ─── plan_type_change / apply_type_change ───────────────────────────────

def test_cafe_to_salon_plan(db):
    u = _user(db, "cs@bonbox.test", business_type="cafe", cutoff=6, hidden_pillars="insights")
    apply_archetype_defaults(db, u)  # café starter categories
    plan = plan_type_change(db, u, "salon")
    assert plan["cutoff"] == {"from": 6, "to": 0}
    assert plan["categories_add"] == ["Produkter"]
    # The café preset hid Insights; a salon's does not → shown again.
    assert plan["pillars_show"] == ["insights"]
    assert plan["pillars_hide"] == []
    assert plan["has_changes"] is True


def test_customised_cutoff_is_kept(db):
    u = _user(db, "cut@bonbox.test", business_type="cafe", cutoff=5)
    plan = plan_type_change(db, u, "salon")
    assert plan["cutoff"] is None
    assert plan["cutoff_kept"] == 5


def test_unused_pillar_is_hidden_used_one_is_kept(db):
    unused = _user(db, "un@bonbox.test", business_type="cafe", cutoff=6)
    assert plan_type_change(db, unused, "clothing")["pillars_hide"] == ["reservations"]

    used = _user(db, "used@bonbox.test", business_type="cafe", cutoff=6)
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == used.id).first()
    prof.reservations_enabled = True
    db.commit()
    plan = plan_type_change(db, used, "clothing")
    assert plan["pillars_hide"] == []
    assert plan["pillars_kept"] == ["reservations"]


def test_module_cap_is_respected(db):
    # Free plan (no trial) → 1 module. A café switching to a bar gets one.
    u = _user(db, "cap@bonbox.test", business_type="cafe", cutoff=6)
    assert plan_type_change(db, u, "bar")["modules_add"] == ["bar_pour"]
    full = _user(db, "full@bonbox.test", business_type="cafe", cutoff=6, enabled_modules="workshop")
    assert plan_type_change(db, full, "bar")["modules_add"] == []


def test_keep_my_settings_changes_only_the_type(db):
    u = _user(db, "keep@bonbox.test", business_type="cafe", cutoff=6, hidden_pillars="insights",
              enabled_modules="competitor")
    apply_archetype_defaults(db, u)
    before_cats = _categories(db, u)
    assert apply_type_change(db, u, "salon", apply_defaults=False) is None
    db.refresh(u)
    assert u.business_type == "salon"
    assert db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first().day_cutoff_hour == 6
    assert _categories(db, u) == before_cats
    assert get_hidden(u) == {"insights"}
    assert u.enabled_modules.startswith("competitor")


def test_apply_is_additive_and_never_deletes(db):
    u = _user(db, "apply@bonbox.test", business_type="cafe", cutoff=6, hidden_pillars="insights",
              enabled_modules="competitor,weather,expiry")
    apply_archetype_defaults(db, u)
    before_cats = set(_categories(db, u))
    applied = apply_type_change(db, u, "bar", apply_defaults=True)
    db.refresh(u)
    assert u.business_type == "bar"
    assert applied is not None
    # Cutoff: café 06 = bar 06 → nothing to move.
    assert applied["cutoff"] is None
    # Legacy ids stay in the CSV; the canonical module is added (cap 1).
    csv = u.enabled_modules.split(",")
    assert csv[:3] == ["competitor", "weather", "expiry"]
    assert "bar_pour" in csv
    # Categories only grow.
    assert before_cats <= set(_categories(db, u))
    # bar preset hides insights too → it stays hidden, nothing new hidden.
    assert get_hidden(u) == {"insights"}


def test_apply_moves_cutoff_and_unhides(db):
    u = _user(db, "move@bonbox.test", business_type="clothing", cutoff=0, hidden_pillars="reservations")
    applied = apply_type_change(db, u, "salon", apply_defaults=True)
    db.refresh(u)
    assert applied["pillars_show"] == ["reservations"]
    assert get_hidden(u) == set()
    assert db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first().day_cutoff_hour == 0


# ─── Endpoints ───────────────────────────────────────────────────────────

def test_preview_and_change_endpoints(client, session_factory):
    s = session_factory()
    u = _user(s, "ep@bonbox.test", business_type="cafe", cutoff=6)
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.get("/api/auth/business-type/preview", params={"business_type": "salon"})
    assert r.status_code == 200, r.text
    assert r.json()["cutoff"] == {"from": 6, "to": 0}

    r = client.post("/api/auth/business-type", json={"business_type": "salon", "apply_defaults": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_type"] == "salon"
    assert body["applied"]["cutoff"] == {"from": 6, "to": 0}
    s.expire_all()
    fresh = s.query(User).filter(User.id == u.id).first()
    assert fresh.business_type == "salon"
    s.close()


def test_unknown_type_is_refused(client, session_factory):
    s = session_factory()
    u = _user(s, "bad@bonbox.test")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/auth/business-type", json={"business_type": "spaceship", "apply_defaults": True})
    assert r.status_code == 422
    r = client.get("/api/auth/business-type/preview", params={"business_type": "spaceship"})
    assert r.status_code == 422
    s.close()


def test_staff_member_cannot_change_the_type(client, session_factory):
    s = session_factory()
    owner = _user(s, "own@bonbox.test")
    staff = _user(s, "mgr@bonbox.test", role="manager")
    staff.owner_id = owner.id
    s.commit()
    app.dependency_overrides[get_current_user] = lambda: staff
    r = client.post("/api/auth/business-type", json={"business_type": "salon"})
    assert r.status_code == 403
    s.close()


# ─── The confirm sheet only claims "because you use it" with a signal ────

def test_kept_pillars_say_why_only_when_used(db):
    # salon → café: the café preset hides Insights. Insights has no usage
    # signal at all, so it stays — but not "because you use it".
    u = _user(db, "why@bonbox.test", business_type="salon", cutoff=0)
    plan = plan_type_change(db, u, "cafe")
    assert plan["pillars_hide"] == []
    assert plan["pillars_kept"] == []
    assert plan["pillars_stay"] == ["insights"]


# ─── Team members carry the owner's type ─────────────────────────────────

def test_type_change_reaches_the_team_in_the_same_commit(db):
    owner = _user(db, "boss@bonbox.test", business_type="cafe", cutoff=6)
    mgr = _user(db, "mgr2@bonbox.test", business_type="cafe", role="manager", owner=owner)
    other_owner = _user(db, "else@bonbox.test", business_type="bar")
    stranger = _user(db, "str@bonbox.test", business_type="bar", role="manager", owner=other_owner)
    apply_type_change(db, owner, "salon", apply_defaults=False)
    db.expire_all()
    assert db.get(User, mgr.id).business_type == "salon"
    assert db.get(User, stranger.id).business_type == "bar"


def _as_user(user_id):
    # The real get_current_user loads the user in the request's own session
    # (get_db is cached per request), which update_profile relies on.
    from fastapi import Depends

    def _dep(db=Depends(get_db)):
        return db.get(User, user_id)
    return _dep


def test_patch_profile_type_reaches_the_team(client, session_factory):
    s = session_factory()
    owner = _user(s, "patch@bonbox.test", business_type="cafe")
    mgr = _user(s, "patchm@bonbox.test", business_type="cafe", role="cashier", owner=owner)
    app.dependency_overrides[get_current_user] = _as_user(owner.id)
    r = client.patch("/api/auth/profile", json={"business_type": "clothing"})
    assert r.status_code == 200, r.text
    s.expire_all()
    assert s.get(User, mgr.id).business_type == "clothing"
    s.close()


def test_post_business_type_reaches_the_team(client, session_factory):
    s = session_factory()
    owner = _user(s, "post@bonbox.test", business_type="cafe", cutoff=6)
    mgr = _user(s, "postm@bonbox.test", business_type="cafe", role="manager", owner=owner)
    app.dependency_overrides[get_current_user] = _as_user(owner.id)
    r = client.post("/api/auth/business-type", json={"business_type": "salon", "apply_defaults": True})
    assert r.status_code == 200, r.text
    s.expire_all()
    assert s.get(User, mgr.id).business_type == "salon"
    s.close()


def test_boot_aligns_members_that_drifted(session_factory):
    s = session_factory()
    owner = _user(s, "drift@bonbox.test", business_type="salon")
    stale = _user(s, "stale@bonbox.test", business_type="cafe", role="viewer", owner=owner)
    fine = _user(s, "fine@bonbox.test", business_type="salon", role="manager", owner=owner)
    lone = _user(s, "lone@bonbox.test", business_type="bar")
    assert align_member_business_types(s) == 1
    assert align_member_business_types(s) == 0  # idempotent
    s.expire_all()
    assert s.get(User, stale.id).business_type == "salon"
    assert s.get(User, fine.id).business_type == "salon"
    assert s.get(User, lone.id).business_type == "bar"
    s.close()
