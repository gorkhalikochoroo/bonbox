"""
Root-slug vanity link (bonbox.dk/<slug>) — reserved-word guard + URL helper.

Locks:
  • A normal slug resolves to the pretty root link.
  • A slug that collides with an app route keeps the /r/ prefix (so the SPA
    route can't shadow a legacy venue's link).
  • The core app-route + generic words are reserved (owners can't claim them).

Run: cd backend && python3 -m pytest tests/test_reservation_slug.py -q
"""
from app.routers.reservations import RESERVED_SLUGS, _public_reservation_url


def test_normal_slug_is_root_vanity_link():
    assert _public_reservation_url("bistro") == "https://bonbox.dk/bistro"
    assert _public_reservation_url("cafe-mokka") == "https://bonbox.dk/cafe-mokka"


def test_reserved_slug_keeps_r_prefix():
    # A legacy venue whose slug matches an app route must NOT sit at the root
    # (the SPA route would shadow it) — it falls back to the /r/ alias.
    assert _public_reservation_url("tax") == "https://bonbox.dk/r/tax"
    assert _public_reservation_url("bar") == "https://bonbox.dk/r/bar"


def test_none_slug_is_none():
    assert _public_reservation_url(None) is None
    assert _public_reservation_url("") is None


def test_app_routes_and_generics_are_reserved():
    for w in ["tax", "login", "dashboard", "staff", "faktura", "gavekort",
              "reservations", "admin", "api", "r", "g", "book"]:
        assert w in RESERVED_SLUGS, w


def test_real_venue_names_are_not_reserved():
    for w in ["bistro", "mokka", "noma", "bageriet", "salon-lux"]:
        assert w not in RESERVED_SLUGS, w
