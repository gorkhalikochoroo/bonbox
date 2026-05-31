"""Business-archetype-aware onboarding — detection endpoint + signup defaults.

Covers (no live AI — keyword fast-path + pure-function paths only):
  • POST /api/onboarding/detect-archetype keyword fast-path: a confident
    keyword hit returns source="keyword", confidence="high", the right
    business_type + resolved archetype, and does NOT call the model.
  • Danish + immigrant-community terms resolve correctly.
  • apply_archetype_defaults: sets day_cutoff_hour on a new profile, merges
    suggested modules additively, seeds DK starter expense categories once,
    and is idempotent + non-clobbering on repeat / customised state.

Run: cd backend && pytest tests/test_archetype_onboarding.py -v
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.expense import ExpenseCategory
from app.models.user import User
from app.services.archetype import archetype_id_for
from app.services.archetype_defaults import apply_archetype_defaults
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        from app.routers.onboarding import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email, business_type="restaurant", enabled_modules=None):
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Test Biz",
        business_type=business_type,
        currency="DKK",
        role="owner",
        email_verified=True,
        enabled_modules=enabled_modules,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _override_user(user):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── 1. Detection endpoint — keyword fast-path (no AI) ───────────────────


def test_detect_keyword_pizza_is_restaurant_food_service(client, db, monkeypatch):
    """'pizza' → business_type=restaurant, archetype=food_service, via the
    keyword fast-path (high confidence) with NO model call."""
    # Hard-fail if the AI path is ever reached — proves the fast-path fired.
    import app.routers.onboarding as ob
    monkeypatch.setattr(ob, "_ai_detect", lambda *_a, **_k: pytest.fail("AI called"))

    user = _make_user(db, "pizza@bonbox.test")
    _override_user(user)

    r = client.post("/api/onboarding/detect-archetype", json={"text": "Pizza place"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_type"] == "restaurant"
    assert body["archetype"] == "food_service"
    assert body["source"] == "keyword"
    assert body["confidence"] == "high"
    assert body["summary"]["id"] == "food_service"


@pytest.mark.parametrize(
    "text,expected_type,expected_archetype",
    [
        ("frisør", "salon", "salon"),
        ("bageri på hjørnet", "bakery", "food_service"),
        ("min kiosk", "kiosk", "retail"),
        ("grønthandler", "grocery", "retail"),
        ("autoværksted", "workshop", "services"),
        ("mobil reparation", "mobile_repair", "services"),
        ("kaffebar", "cafe", "food_service"),
        ("cocktail bar", "bar", "bar"),
        ("webshop med tøj", "online_clothing", "retail"),
    ],
)
def test_detect_keyword_multilingual(client, db, monkeypatch, text, expected_type, expected_archetype):
    """Danish + immigrant-community terms resolve via the keyword map."""
    import app.routers.onboarding as ob
    monkeypatch.setattr(ob, "_ai_detect", lambda *_a, **_k: pytest.fail("AI called"))

    user = _make_user(db, f"kw-{expected_type}@bonbox.test")
    _override_user(user)

    r = client.post("/api/onboarding/detect-archetype", json={"text": text})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_type"] == expected_type, body
    assert body["archetype"] == expected_archetype, body
    assert body["source"] == "keyword"
    # Sanity: archetype resolution agrees with the canonical mapping.
    assert archetype_id_for(expected_type) == expected_archetype


def test_detect_requires_auth(client):
    """Anonymous callers get 401/403 — never an open AI endpoint."""
    r = client.post("/api/onboarding/detect-archetype", json={"text": "pizza"})
    assert r.status_code in (401, 403), r.text


def test_detect_validates_text_bounds(client, db):
    """Empty text → 422 (min_length=1); over-120-char text → 422."""
    user = _make_user(db, "bounds@bonbox.test")
    _override_user(user)
    assert client.post("/api/onboarding/detect-archetype", json={"text": ""}).status_code == 422
    assert client.post(
        "/api/onboarding/detect-archetype", json={"text": "x" * 121}
    ).status_code == 422


# ─── 2. apply_archetype_defaults ─────────────────────────────────────────


def test_defaults_sets_cutoff_on_new_profile(db):
    """food_service → day_cutoff_hour 6 on a freshly-created profile."""
    user = _make_user(db, "cutoff@bonbox.test", business_type="restaurant")
    res = apply_archetype_defaults(db, user)
    assert res["archetype"] == "food_service"
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    assert prof is not None
    assert prof.day_cutoff_hour == 6


def test_defaults_does_not_clobber_customised_cutoff(db):
    """An owner-set cutoff (e.g. 3) is never overwritten by re-applying."""
    user = _make_user(db, "custom-cutoff@bonbox.test", business_type="restaurant")
    prof = BusinessProfile(user_id=user.id, day_cutoff_hour=3)
    db.add(prof)
    db.commit()
    apply_archetype_defaults(db, user)
    db.refresh(prof)
    assert prof.day_cutoff_hour == 3  # untouched


def test_defaults_merge_modules_additive(db):
    """Suggested modules are unioned in; existing ones are preserved."""
    # 'khata' is pre-existing and NOT in food_service's suggestions, so it
    # must survive the merge alongside the new competitor/weather/expiry.
    user = _make_user(db, "mods@bonbox.test", business_type="restaurant",
                      enabled_modules="khata")
    apply_archetype_defaults(db, user)
    db.refresh(user)
    mods = set((user.enabled_modules or "").split(","))
    assert "khata" in mods
    assert {"competitor", "weather", "expiry"}.issubset(mods)


def test_defaults_seeds_starter_categories_once(db):
    """Zero categories → seed DK starters; re-apply does not duplicate."""
    user = _make_user(db, "cats@bonbox.test", business_type="restaurant")
    apply_archetype_defaults(db, user)
    names = [
        c.name for c in db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user.id).all()
    ]
    assert set(names) == {"Vareforbrug", "Løn", "Husleje", "Emballage"}

    # Idempotent — second call must not duplicate.
    apply_archetype_defaults(db, user)
    count = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).count()
    assert count == 4


def test_defaults_skips_category_seed_when_user_has_any(db):
    """If the user already has a category, we DON'T seed starters."""
    user = _make_user(db, "hascat@bonbox.test", business_type="restaurant")
    db.add(ExpenseCategory(user_id=user.id, name="Mine egne"))
    db.commit()
    apply_archetype_defaults(db, user)
    names = [
        c.name for c in db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user.id).all()
    ]
    assert names == ["Mine egne"]  # no starters added


def test_defaults_never_raises_on_bad_input(db):
    """Defaults must swallow everything — None user returns cleanly."""
    res = apply_archetype_defaults(db, None)  # type: ignore[arg-type]
    assert res["archetype"] is None


# ─── 3. Wiring / mapping sanity ──────────────────────────────────────────


def test_route_is_registered():
    """The detect-archetype route is mounted under /api/onboarding (POST)."""
    paths = {
        r.path: sorted(getattr(r, "methods", []) or [])
        for r in app.routes if hasattr(r, "path")
    }
    p = "/api/onboarding/detect-archetype"
    assert p in paths, f"route not registered: {p}"
    assert "POST" in paths[p]


def test_keyword_map_values_are_valid_business_types():
    """Every keyword-map target must be a real BUSINESS_TYPE_TO_ARCHETYPE key,
    otherwise it would silently resolve to generic."""
    import app.routers.onboarding as ob
    from app.services.archetype import BUSINESS_TYPE_TO_ARCHETYPE

    bad = sorted({v for v in ob._KEYWORD_MAP.values() if v not in BUSINESS_TYPE_TO_ARCHETYPE})
    assert not bad, f"keyword map targets not in mapping: {bad}"
