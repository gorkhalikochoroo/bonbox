"""A shop or a workshop asks its customers no allergies (Push 8 review, Oct 2026).

QA opened the public booking page of a bike workshop ("Cykelværkstedet
Amager") and of a clothing shop: step 2 asked "Allergier, anledning eller en
besked? · Valgfrit — så køkkenet kan tage hensyn" and offered all 14 EU food
allergens (Krebsdyr, Lupin, Bløddyr …). The page shows the catalogue the
server sends (`allergen_set`), and allergen_set_for fell back to the food set
for every type it did not know — every shop and every trade.

Health data with no purpose is not collected (GDPR Art. 5(1)(c)): the
retail and services archetypes get no catalogue, and the public booking
stores no allergy tag, note or severity for them even when one is sent. Food
venues keep the food set, the salon its care set, an unknown type the food
set (the primary market) — control cases below.

Run: cd backend && pytest tests/test_allergens_shop_workshop.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services.allergens import (
    CARE_ALLERGENS,
    FOOD_ALLERGENS_EU14,
    allergen_set_for,
    collects_allergies,
    sanitize_tags,
)
from app.services.archetype import BUSINESS_TYPE_TO_ARCHETYPE

_db_ready.set()


# ── the catalogue ─────────────────────────────────────────────────────────

SHOPS_AND_TRADES = sorted(
    bt for bt, arch in BUSINESS_TYPE_TO_ARCHETYPE.items() if arch in ("retail", "services")
)


def test_every_shop_and_trade_type_is_covered():
    # The real map, not a copy: a type added to retail/services later is
    # checked too. Both QA venues are in it.
    assert {"workshop", "clothing", "laundry", "mobile_repair", "pharmacy"} <= set(SHOPS_AND_TRADES)


@pytest.mark.parametrize("btype", SHOPS_AND_TRADES + ["Workshop ", "CLOTHING"])
def test_a_shop_or_a_trade_has_no_allergen_catalogue(btype):
    assert allergen_set_for(btype) == []
    assert collects_allergies(btype) is False
    assert sanitize_tags(["nuts", "milk", "latex"], btype) == []


@pytest.mark.parametrize(
    "btype,expected",
    [
        ("restaurant", FOOD_ALLERGENS_EU14),
        ("cafe", FOOD_ALLERGENS_EU14),
        ("bakery", FOOD_ALLERGENS_EU14),
        ("takeaway", FOOD_ALLERGENS_EU14),
        ("tea_shop", FOOD_ALLERGENS_EU14),
        ("bar", FOOD_ALLERGENS_EU14),
        ("salon", CARE_ALLERGENS),
        # Unknown, generic and empty keep the food set (unchanged).
        ("other", FOOD_ALLERGENS_EU14),
        ("general", FOOD_ALLERGENS_EU14),
        ("something_new", FOOD_ALLERGENS_EU14),
        (None, FOOD_ALLERGENS_EU14),
        ("", FOOD_ALLERGENS_EU14),
    ],
)
def test_food_venues_and_the_salon_keep_their_catalogue(btype, expected):
    assert allergen_set_for(btype) == expected
    assert collects_allergies(btype) is True


def test_a_restaurant_still_keeps_a_recognised_tag():
    assert sanitize_tags(["nuts", "not_real"], "restaurant") == ["nuts"]


# ── the public page and the public booking ────────────────────────────────

_SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [{"up_to": 2, "minutes": 60}],
    "default_duration_min": 60,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 10,
    "group_request_threshold": 8,
    "retention_days": 90,
}
_HOURS = {k: "09:00-17:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


@pytest.fixture
def session_factory():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory, monkeypatch):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    import app.services.email_service as es

    monkeypatch.setattr(es, "send_email", lambda **k: True)  # never the network
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _venue(db, btype: str, name: str):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name=name, business_type=btype, currency="DKK", plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    profile = BusinessProfile(
        user_id=u.id, company_name=name,
        reservation_slug=f"v-{uuid.uuid4().hex[:8]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(_HOURS),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    # The places quick setup made for the QA workshop ("Bord N · 2 pladser").
    for i in range(3):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Plads {i + 1}",
                                capacity_seats=2, sort_order=i))
    db.commit()
    return u, profile


@pytest.mark.parametrize("btype", ["workshop", "clothing"])
def test_the_public_page_offers_a_shop_no_allergens(client, db, btype):
    _, profile = _venue(db, btype, "Cykelværkstedet Amager")
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    assert r.status_code == 200, r.text
    assert r.json()["allergen_set"] == []


def test_the_public_page_of_a_restaurant_keeps_the_14(client, db):
    _, profile = _venue(db, "restaurant", "Bistro")
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    assert r.status_code == 200, r.text
    assert [a["key"] for a in r.json()["allergen_set"]] == [a["key"] for a in FOOD_ALLERGENS_EU14]


def _book(client, profile, **extra):
    day = date.today() + timedelta(days=3)
    return client.post(
        f"/api/public/reservations/{profile.reservation_slug}",
        json={
            "day": day.isoformat(), "time": "10:00", "party_size": 1,
            "guest_name": "Sofie", "guest_email": "sofie@example.com",
            "allergen_tags": ["nuts", "crustaceans"],
            "allergy_note": "Svær nøddeallergi",
            "allergy_severity": "severe",
            **extra,
        },
    )


@pytest.mark.parametrize("btype", ["workshop", "clothing"])
def test_a_shop_booking_stores_no_allergy_data_even_when_sent(client, db, btype):
    _, profile = _venue(db, btype, "Butik")
    r = _book(client, profile, guest_notes="Bremserne hviner")
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.query(Reservation).one()
    assert (row.allergen_tags or []) == []
    assert row.allergy_note is None
    assert row.allergy_severity is None
    # The customer's own message is kept — only the health data goes.
    assert row.guest_notes == "Bremserne hviner"


def test_a_restaurant_booking_keeps_its_allergy_data(client, db):
    _, profile = _venue(db, "restaurant", "Bistro")
    r = _book(client, profile)
    assert r.status_code == 200, r.text
    db.expire_all()
    row = db.query(Reservation).one()
    assert row.allergen_tags == ["nuts", "crustaceans"]
    assert row.allergy_note == "Svær nøddeallergi"
    assert row.allergy_severity == "severe"
