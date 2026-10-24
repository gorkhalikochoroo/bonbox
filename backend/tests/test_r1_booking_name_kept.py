"""R1 A2 — a Profile save no longer overwrites the booking page's name.

users.business_name is the name the booking page shows (venue_identity).
Every Profile card ("Hvad serverer du", revisor, payment) echoes
company_name on save, and PUT /api/business copied it into business_name
unconditionally: "Trattoria Testa Aarhus", set for the booking page, became
"Trattoria Testa" on the next cuisine save (settings audit, 24 Oct 2026).
Now the copy happens only when there is no trading name yet, or when the
trading name was only MIRRORING the old company name and the company name
really changed. A trading name the owner chose (Reservationer → Indstillinger
→ Navn på bookingsiden) differs from the legal name, and stays — a CVR
lookup's "BISTRO HAVN ApS" replaced it before the fix round (R1 review).

Run: cd backend && python -m pytest tests/test_r1_booking_name_kept.py -q
"""
from __future__ import annotations

import uuid

from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import create_access_token
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, db, engine_and_session,
)

# A real bearer token: the handler then loads the owner in the REQUEST's own
# session, so its write to users.business_name is the one that commits.
_HEADERS: dict = {}


def as_owner(user):
    _HEADERS.clear()
    _HEADERS["Authorization"] = f"Bearer {create_access_token(str(user.id))}"


def _owner(db, *, business_name, company_name=None):
    u = User(email=f"trattoria-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name=business_name, business_type="restaurant",
             currency="DKK", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    if company_name is not None:
        db.add(BusinessProfile(user_id=u.id, company_name=company_name, country="DK"))
        db.commit()
    return u


def _reload(db, u):
    db.expire_all()
    return db.query(User).filter(User.id == u.id).first()


def _put(client, body):
    from app.routers import business_profile as bp
    bp._limiter.reset()
    return client.put("/api/business", json=body, headers=dict(_HEADERS))


def test_echoed_company_name_keeps_the_trading_name(client, db):
    u = _owner(db, business_name="Trattoria Testa Aarhus", company_name="Trattoria Testa")
    as_owner(u)
    # The "Hvad serverer du" card: the cuisine, with company_name echoed.
    r = _put(client, {"company_name": "Trattoria Testa", "cuisine": "italian"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Trattoria Testa Aarhus"
    # The public page keeps reading it.
    from app.services import venue_identity
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    assert venue_identity.public_venue_name(_reload(db, u), prof) == "Trattoria Testa Aarhus"


def test_a_real_company_name_change_carries_over_a_mirrored_name(client, db):
    # The trading name was the company name: a rename follows it.
    u = _owner(db, business_name="Trattoria Testa", company_name="Trattoria Testa")
    as_owner(u)
    r = _put(client, {"company_name": "Trattoria Testa ApS"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Trattoria Testa ApS"


def test_a_cvr_save_never_replaces_a_chosen_booking_name(client, db):
    # The review's repro: the name row set "Bistro Havn Harbour"; then Profil
    # → "Find din virksomhed" sent the CVR's legal name.
    u = _owner(db, business_name="Bistro Havn Harbour", company_name="Bistro Havn")
    as_owner(u)
    r = _put(client, {"company_name": "BISTRO HAVN ApS", "org_number": "12345678",
                      "source": "cvr"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Bistro Havn Harbour"


def test_the_first_company_name_save_keeps_the_signup_name(client, db):
    # Signed up as "Bistro Havn" (no profile yet); the first legal-name save
    # used to make it "Bistro Havn ApS" — and the slug bistro-havn-aps.
    u = _owner(db, business_name="Bistro Havn", company_name=None)
    as_owner(u)
    r = _put(client, {"company_name": "Bistro Havn ApS"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Bistro Havn"


def test_first_save_copies_the_name_when_there_is_none(client, db):
    u = _owner(db, business_name="", company_name=None)
    as_owner(u)
    r = _put(client, {"company_name": "Café Nord"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Café Nord"


def test_an_echo_still_fills_an_empty_trading_name(client, db):
    u = _owner(db, business_name="", company_name="Café Nord")
    as_owner(u)
    r = _put(client, {"company_name": "Café Nord", "cuisine": "nordic"})
    assert r.status_code == 200, r.text
    assert _reload(db, u).business_name == "Café Nord"
