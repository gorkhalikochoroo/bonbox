"""Booking R5 — the owner's colour on the public booking page.

  • The palette gains a light "gold" (#C9A45C) for the gold/brass restaurant
    sites (nepalibhancha.dk is #D9A868); the other six are unchanged.
  • GET /public/reservations/{slug} carries `accent_color`: the stored colour
    as a canonical #RRGGBB, or None — never a palette name, never garbage.
    The page itself picks the text colour by contrast (utils/accentColor.js).
  • PATCH /business/brand {"accent_color": null} CLEARS the colour. An
    explicit null used to be read as "not sent", so "Standard" saved nothing
    and a colour, once picked, could never be taken off again. A field left
    out is still left alone.
  • The gavekort PDF never writes words in a colour they cannot be read in:
    readable_on() / readable_ink() (logo_service) pick the monogram's letters
    and deepen the GAVEKORT eyebrow when the accent is light.

Run:
  cd backend && python -m pytest tests/test_r5_accent_colour.py -q
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.routers import public_reservations as pubres
from app.services.auth import get_current_user
from app.services.gavekort_pdf import build_gavekort_pdf
from app.services.logo_service import (
    ACCENT_COLOR_PALETTE,
    contrast_ratio,
    readable_ink,
    readable_on,
    validate_accent_color,
)

_db_ready.set()

PAPER = "#fbfaf7"
INK = "#14120f"


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()
    pubres._limiter.reset()


def _venue(db, *, accent=None, plan="pro", reservations=True):
    owner = User(email=f"r5-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
                 business_name="Guldkanten", business_type="restaurant",
                 currency="DKK", plan=plan)
    db.add(owner)
    db.commit()
    db.refresh(owner)
    profile = BusinessProfile(
        user_id=owner.id, company_name="Guldkanten ApS",
        reservation_slug=f"r5-{uuid.uuid4().hex[:8]}",
        reservations_enabled=reservations,
        reservation_settings_json=json.dumps({"max_advance_days": 30}),
        accent_color=accent,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return owner, profile


# ── the palette ──────────────────────────────────────────────────────────

def test_gold_joins_the_palette_and_the_six_are_unchanged():
    assert ACCENT_COLOR_PALETTE["gold"] == "#C9A45C"
    assert {k: v for k, v in ACCENT_COLOR_PALETTE.items() if k != "gold"} == {
        "emerald": "#10B981", "blue": "#2563EB", "slate": "#475569",
        "terracotta": "#C2410C", "charcoal": "#1F2937", "burgundy": "#9F1239",
    }
    assert validate_accent_color("gold") == "#C9A45C"
    assert validate_accent_color("#c9a45c") == "#C9A45C"
    # Still a closed list: the site's own gold is not a free pass.
    with pytest.raises(ValueError):
        validate_accent_color("#D9A868")


def test_gold_needs_dark_text_and_the_contrast_maths_is_right():
    assert round(contrast_ratio("#FFFFFF", "#000000"), 2) == 21.0
    assert contrast_ratio("#FFFFFF", "#FFFFFF") == 1.0
    assert contrast_ratio("not a colour", "#FFFFFF") == 1.0
    # White on gold is far below AA; the ink reads.
    assert contrast_ratio("#FFFFFF", "#C9A45C") < 3
    assert readable_on("#C9A45C", light=PAPER, dark=INK) == INK
    assert contrast_ratio(INK, "#C9A45C") >= 4.5
    # The dark presets keep their paper/white letters.
    for name in ("blue", "slate", "terracotta", "charcoal", "burgundy"):
        assert readable_on(ACCENT_COLOR_PALETTE[name], light=PAPER, dark=INK) == PAPER, name


def test_readable_ink_deepens_a_light_accent_only_as_far_as_it_must():
    deep = readable_ink("#C9A45C", PAPER)
    assert deep != "#C9A45C"
    assert contrast_ratio(deep, PAPER) >= 4.5
    # A colour that already reads on paper is left exactly as it is.
    assert readable_ink("#166b4f", PAPER) == "#166b4f"
    assert readable_ink("#2563EB", PAPER) == "#2563EB"
    # Garbage comes back untouched, never an exception.
    assert readable_ink("nope", PAPER) == "nope"


# ── the public page ─────────────────────────────────────────────────────

@pytest.mark.parametrize("stored,served", [
    ("#C9A45C", "#C9A45C"),
    ("#c9a45c", "#C9A45C"),
    (" #2563EB ", "#2563EB"),
    (None, None),
    ("", None),
    ("gold", None),        # a palette NAME is not a colour on the wire
    ("#12345", None),
    ("#GGGGGG", None),
    ("red;}", None),
])
def test_public_page_serves_the_accent_as_a_plain_colour_or_none(client, db, stored, served):
    _, profile = _venue(db, accent=stored)
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "accent_color" in body
    assert body["accent_color"] == served


def test_public_accent_helper_fails_closed():
    assert pubres._public_accent(None) is None
    assert pubres._public_accent(SimpleNamespace(accent_color=123)) is None
    assert pubres._public_accent(SimpleNamespace()) is None
    assert pubres._public_accent(SimpleNamespace(accent_color="#ffffff")) == "#FFFFFF"


# ── PATCH /business/brand ───────────────────────────────────────────────

def _as(owner):
    app.dependency_overrides[get_current_user] = lambda: owner


def test_an_explicit_null_clears_the_colour(client, db):
    owner, profile = _venue(db, accent="#C9A45C")
    _as(owner)
    r = client.patch("/api/business/brand", json={"accent_color": None})
    assert r.status_code == 200, r.text
    assert r.json()["accent_color"] is None
    db.refresh(profile)
    assert profile.accent_color is None


def test_an_empty_string_clears_too(client, db):
    owner, profile = _venue(db, accent="#2563EB")
    _as(owner)
    r = client.patch("/api/business/brand", json={"accent_color": ""})
    assert r.status_code == 200, r.text
    db.refresh(profile)
    assert profile.accent_color is None


def test_a_field_left_out_is_left_alone(client, db):
    owner, profile = _venue(db, accent="#C9A45C")
    _as(owner)
    r = client.patch("/api/business/brand", json={"logo_position": "center"})
    assert r.status_code == 200, r.text
    db.refresh(profile)
    assert profile.accent_color == "#C9A45C"
    assert profile.logo_position == "center"


def test_gold_by_name_is_stored_as_its_colour_and_served_on_the_page(client, db):
    owner, profile = _venue(db, accent=None)
    _as(owner)
    r = client.patch("/api/business/brand", json={"accent_color": "gold"})
    assert r.status_code == 200, r.text
    assert r.json()["accent_color"] == "#C9A45C"
    assert r.json()["accent_palette"]["gold"] == "#C9A45C"
    page = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert page["accent_color"] == "#C9A45C"


def test_a_colour_outside_the_palette_is_still_refused(client, db):
    owner, profile = _venue(db, accent="#2563EB")
    _as(owner)
    r = client.patch("/api/business/brand", json={"accent_color": "#D9A868"})
    assert r.status_code == 422
    db.refresh(profile)
    assert profile.accent_color == "#2563EB"


def test_a_free_venue_with_booking_on_may_pick_its_colour(client, db):
    # _require_brand_access: Starter+ OR reservations on (the booking page shows it).
    owner, profile = _venue(db, accent=None, plan="free", reservations=True)
    _as(owner)
    r = client.patch("/api/business/brand", json={"accent_color": "gold"})
    assert r.status_code == 200, r.text


# ── the gavekort PDF ────────────────────────────────────────────────────

def _card():
    return SimpleNamespace(short_code="GK-7K2M-9QX4", face_value_minor=50000,
                           balance_minor=50000, recipient_name=None, note=None,
                           expires_at=None)


def _profile(accent):
    return SimpleNamespace(company_name="Guldkanten", vat_number="12345678",
                           org_number=None, address="Nørregade 12", zipcode="1165",
                           city="København", accent_color=accent, logo_url=None,
                           logo_position="left")


@pytest.mark.parametrize("template", ["minimal", "foil"])
@pytest.mark.parametrize("accent", ["#C9A45C", "#10B981", "#1F2937", None])
def test_gavekort_renders_with_every_kind_of_accent(template, accent):
    pdf = build_gavekort_pdf(card=_card(), profile=_profile(accent),
                             template=template, redeem_url="GK-7K2M-9QX4")
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 500


def test_gavekort_minimal_writes_its_words_in_readable_colours(monkeypatch):
    """The monogram's letters and the GAVEKORT eyebrow on a gold card: the
    letters are the ink (not paper-on-gold, ~2.2:1) and the eyebrow is the
    gold deepened to AA on paper. Captured at the canvas, so a later edit that
    paints them in the raw accent fails here."""
    from reportlab.pdfgen import canvas as rl_canvas

    fills: list[tuple[str, str]] = []
    real_fill = rl_canvas.Canvas.setFillColor
    real_centred = rl_canvas.Canvas.drawCentredString
    real_string = rl_canvas.Canvas.drawString

    def remember_fill(self, color, alpha=None):
        self._r5_fill = color
        return real_fill(self, color, alpha) if alpha is not None else real_fill(self, color)

    def hexof(color):
        try:
            return "#" + color.hexval()[2:].upper()
        except Exception:  # noqa: BLE001
            return str(color)

    def centred(self, x, y, text, *a, **k):
        fills.append(("centred:" + str(text), hexof(getattr(self, "_r5_fill", None))))
        return real_centred(self, x, y, text, *a, **k)

    def plain(self, x, y, text, *a, **k):
        fills.append(("string:" + str(text), hexof(getattr(self, "_r5_fill", None))))
        return real_string(self, x, y, text, *a, **k)

    monkeypatch.setattr(rl_canvas.Canvas, "setFillColor", remember_fill)
    monkeypatch.setattr(rl_canvas.Canvas, "drawCentredString", centred)
    monkeypatch.setattr(rl_canvas.Canvas, "drawString", plain)

    build_gavekort_pdf(card=_card(), profile=_profile("#C9A45C"),
                       template="minimal", redeem_url="GK-7K2M-9QX4")

    from app.services.gavekort_pdf import _initials
    mono = [c for t, c in fills if t == "centred:" + _initials("Guldkanten")]
    assert mono, fills[:20]
    assert mono[0] == INK.upper()
    # The eyebrow is drawn glyph by glyph (_draw_tracked): find "GAVEKORT".
    texts = [t for t, _ in fills]
    run = [f"string:{ch}" for ch in "GAVEKORT"]
    at = next(i for i in range(len(texts)) if texts[i:i + 8] == run)
    eyebrow = [c for _, c in fills[at:at + 8]]
    assert len(set(eyebrow)) == 1
    assert eyebrow[0] != "#C9A45C"                  # never the raw light gold
    assert contrast_ratio(eyebrow[0], PAPER) >= 4.5, eyebrow[0]
