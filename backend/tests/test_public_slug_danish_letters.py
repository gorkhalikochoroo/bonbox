"""New public slugs keep Danish letters readable; no venue gets an app route
(Push 8, 12 Oct 2026).

THE DEFECTS
  • Every slug minter stripped anything outside a-z0-9: "Café Mirabelle" got
    bonbox.dk/caf-mirabelle and "Cykelværkstedet" bonbox.dk/cykelv-rkstedet
    (booking page; the gavekort shop and an event's page the same).
  • The booking-slug minter never looked at RESERVED_SLUGS: a venue named
    "Staff" or "Stand" was handed a root link that an app route shadows.
  • Six top-level app routes were missing from RESERVED_SLUGS (stand, v2,
    accept-invite, getting-started, weekly-report, wine-list), so an owner
    could claim them as a vanity link nobody could open.

WHAT STAYS
  • A slug already minted is a published URL: never recomputed or renamed.
  • The /r/ prefix for a legacy slug that collides with an app route.

Run: cd backend && python -m pytest -q tests/test_public_slug_danish_letters.py
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.business_profile import BusinessProfile
from app.models.event import Event
from app.models.user import User
from app.routers import reservations as R
from app.routers.events import _allocate_slug as allocate_event_slug
from app.routers.gavekort import _allocate_gavekort_slug
from app.services.auth import hash_password
from app.utils.text import public_slug

_db_ready.set()

APP_JSX = Path(__file__).resolve().parents[2] / "frontend" / "src" / "App.jsx"


@pytest.fixture
def factory():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def db(factory):
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(factory):
    def _get_test_db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, name="Café Mirabelle"):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@bonbox.dk", password_hash=hash_password("x"),
             business_name=name, business_type="restaurant", currency="DKK",
             role="owner", timezone="Europe/Copenhagen", plan="pro")
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, company_name=name))
    db.commit()
    return u


# ── the transliteration ─────────────────────────────────────────────────


@pytest.mark.parametrize("name,slug", [
    ("Café Mirabelle", "cafe-mirabelle"),
    ("Cykelværkstedet", "cykelvaerkstedet"),
    ("Smørrebrød & Øl", "smoerrebroed-oel"),
    ("Århus Bageri", "aarhus-bageri"),
    ("ÆBLEHAVEN", "aeblehaven"),
    ("Crème Brûlée", "creme-brulee"),
    ("Müllers Bistro", "mullers-bistro"),
    ("Ölstugan", "olstugan"),
    ("Bäckerei Hansen", "backerei-hansen"),
    ("Hè Café", "he-cafe"),
])
def test_public_slug_transliterates(name, slug):
    assert public_slug(name, "booking", 50) == slug


def test_public_slug_never_ends_on_a_dash_after_truncation():
    s = public_slug("Restaurant " + "x" * 39 + " Øst", "booking", 50)
    assert len(s) <= 50 and not s.endswith("-")


def test_public_slug_falls_back_when_nothing_survives():
    assert public_slug("ネパール", "booking", 50) == "booking"
    assert public_slug(None, "gavekort", 50) == "gavekort"


def test_new_booking_slug_keeps_the_letters(db):
    assert R._allocate_slug(db, "Café Mirabelle") == "cafe-mirabelle"
    assert R._allocate_slug(db, "Cykelværkstedet") == "cykelvaerkstedet"


def test_new_gavekort_and_event_slugs_keep_the_letters(db):
    assert _allocate_gavekort_slug(db, "Café Mirabelle") == "cafe-mirabelle"
    ev_slug = allocate_event_slug(db, Event(name="Julefrokost på Café Ørsted"))
    assert re.fullmatch(r"julefrokost-paa-cafe-oersted-[a-z2-9]{4}", ev_slug), ev_slug


# ── existing slugs are published URLs ───────────────────────────────────


def test_an_existing_slug_is_never_recomputed(client, db):
    u = _owner(db)
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    prof.reservation_slug = "caf-mirabelle"     # minted before this fix
    db.commit()
    app.dependency_overrides[R.get_current_user] = lambda: u
    r = client.put("/api/reservations/settings", json={"reservations_enabled": True})
    assert r.status_code == 200, r.text
    db.expire_all()
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    assert prof.reservation_slug == "caf-mirabelle"
    assert R._public_reservation_url("caf-mirabelle") == "https://www.bonbox.dk/caf-mirabelle"


def test_first_enable_mints_the_readable_slug(client, db):
    u = _owner(db)
    app.dependency_overrides[R.get_current_user] = lambda: u
    r = client.put("/api/reservations/settings", json={"reservations_enabled": True})
    assert r.status_code == 200, r.text
    db.expire_all()
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    assert prof.reservation_slug == "cafe-mirabelle"


def test_an_owner_typed_slug_is_transliterated_too(client, db):
    u = _owner(db)
    app.dependency_overrides[R.get_current_user] = lambda: u
    r = client.post("/api/reservations/slug", json={"slug": "Smørrebrød-hjørnet"})
    assert r.status_code == 200, r.text
    assert r.json()["reservation_slug"] == "smoerrebroed-hjoernet"


# ── reserved words ──────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["Staff", "STAND", "Login", "Tax", "Wine List"])
def test_a_minted_booking_slug_is_never_a_reserved_word(db, name):
    slug = R._allocate_slug(db, name)
    assert slug not in R.RESERVED_SLUGS, slug
    assert slug.startswith(public_slug(name, "booking", 50) + "-"), slug
    # …so the shared link is the pretty root one, never the /r/ fallback.
    assert R._public_reservation_url(slug) == f"https://www.bonbox.dk/{slug}"


@pytest.mark.parametrize("word", ["staff", "stand", "v2", "wine-list"])
def test_an_owner_cannot_claim_an_app_route(client, db, word):
    u = _owner(db)
    app.dependency_overrides[R.get_current_user] = lambda: u
    r = client.post("/api/reservations/slug", json={"slug": word})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "slug_reserved"


def test_a_legacy_reserved_slug_keeps_its_r_link():
    assert R._public_reservation_url("staff") == "https://www.bonbox.dk/r/staff"
    assert R._public_reservation_url("stand") == "https://www.bonbox.dk/r/stand"


def test_every_top_level_app_route_is_reserved():
    """Both directions of the list: a top-level route the SPA serves can never
    be a venue's root link (React Router ranks the static route first)."""
    src = APP_JSX.read_text()
    segments = {p.split("/")[1] for p in re.findall(r'path="(/[^"]*)"', src)}
    segments = {s for s in segments if s and not s.startswith(":")}
    missing = sorted(s for s in segments if s not in R.RESERVED_SLUGS)
    assert not missing, f"app routes a venue could claim as its link: {missing}"
    # /staff itself is an app route (it opens Vagtplan), not the guest page.
    assert 'path="/staff"' in src, "the /staff entry route is gone from App.jsx"
