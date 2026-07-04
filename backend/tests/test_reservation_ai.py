"""
Reservation AI signals — allergy suggestion + note intent wired into the create
paths + the confirm/dismiss endpoint.

Locks under test (honesty / safety invariants):
  • A booking whose free-text names an allergy gets an UNCONFIRMED suggestion in
    the SEPARATE ai_allergy.* fields (never in the confirmed allergen_tags).
  • A food PREFERENCE never raises a suggestion.
  • confirm MERGES the suggested tags into the confirmed allergen_tags and
    ESCALATES severity upward; the prompt then stops (has_ai_suggested_allergy
    False).
  • dismiss clears the suggestion but NEVER touches a guest's confirmed entry.
  • The AI is ADDITIVE: a guest's confirmed allergen_tags are never overwritten
    by detection.
  • note_intent is classified on create.
  • confirm/dismiss is tenant-scoped (foreign reservation → 404).

Run: cd backend && python3 -m pytest tests/test_reservation_ai.py -x -q
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()

_TODAY = "2026-07-04"
_START = "2026-07-04T19:00:00"


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, *, plan="pro", business_type="restaurant"):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bon Restaurant", business_type=business_type,
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


def _book(client, **body):
    base = {"guest_name": "Agnes", "party_size": 4, "starts_at": _START,
            "auto_assign": False, "allow_overflow": True}
    base.update(body)
    r = client.post("/api/reservations/book", json=base)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _get(client, rid):
    lst = client.get(f"/api/reservations/book?day={_TODAY}").json()
    for r in lst.get("reservations", []):
        if r["id"] == rid:
            return r
    raise AssertionError("reservation not found in book")


# ── detection on create ──────────────────────────────────────────────

def test_allergy_note_raises_unconfirmed_suggestion(client, db):
    _as(_seed(db))
    rid = _book(client, allergy_note="Allergisk over for nødder")
    r = _get(client, rid)
    ai = r["ai_allergy"]
    assert ai["has_ai_suggested_allergy"] is True
    assert "nuts" in ai["ai_tags"]
    assert ai["ai_confirmed"] is False
    # It did NOT leak into the confirmed structured field.
    assert r["allergen_tags"] == []


def test_preference_raises_no_suggestion(client, db):
    _as(_seed(db))
    rid = _book(client, guest_notes="Vi elsker nødder")  # loves nuts
    r = _get(client, rid)
    assert r["ai_allergy"]["has_ai_suggested_allergy"] is False


def test_note_intent_classified_on_create(client, db):
    _as(_seed(db))
    rid = _book(client, guest_notes="Fejrer fødselsdag i aften")
    assert _get(client, rid)["note_intent"] == "celebration_birthday"


# ── confirm / dismiss ────────────────────────────────────────────────

def test_confirm_merges_tags_and_escalates_severity(client, db):
    _as(_seed(db))
    rid = _book(client, allergy_note="Livstruende nøddeallergi")  # severe nuts
    resp = client.patch(
        f"/api/reservations/reservations/{rid}/allergy-suggestion",
        json={"action": "confirm"},
    )
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert "nuts" in r["allergen_tags"]          # merged into CONFIRMED
    assert r["allergy_severity"] == "severe"     # escalated upward
    assert r["ai_allergy"]["ai_confirmed"] is True
    assert r["ai_allergy"]["has_ai_suggested_allergy"] is False  # prompt gone


def test_confirm_generic_leaves_a_confirmed_trace(client, db):
    # Life-safety regression: a GENERIC suggestion (allergy language, no specific
    # allergen) that the owner confirms must NOT vanish — the row has to keep an
    # allergy flag, or a confirmed allergy is silently erased.
    _as(_seed(db))
    rid = _book(client, guest_notes="Gæsten har en allergi")  # generic, unspecified
    before = _get(client, rid)
    assert before["ai_allergy"]["has_ai_suggested_allergy"] is True
    assert before["ai_allergy"]["ai_generic"] is True
    assert before["allergen_tags"] == [] and before["allergy_severity"] is None
    resp = client.patch(
        f"/api/reservations/reservations/{rid}/allergy-suggestion",
        json={"action": "confirm"},
    )
    assert resp.status_code == 200, resp.text
    r = resp.json()
    has_flag = bool(r["allergen_tags"]) or bool(r["allergy_severity"]) or bool(r["allergy_note"])
    assert has_flag, "a confirmed generic allergy must leave a confirmed trace"
    assert r["ai_allergy"]["has_ai_suggested_allergy"] is False


def test_dismiss_clears_suggestion_keeps_confirmed(client, db):
    _as(_seed(db))
    # Guest confirmed milk; free-text also trips the nuts detector.
    rid = _book(client, allergen_tags=["milk"], allergy_note="allergisk over for nødder")
    before = _get(client, rid)
    assert before["allergen_tags"] == ["milk"]
    assert "nuts" in before["ai_allergy"]["ai_tags"]   # separate channel
    resp = client.patch(
        f"/api/reservations/reservations/{rid}/allergy-suggestion",
        json={"action": "dismiss"},
    )
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert r["allergen_tags"] == ["milk"]              # confirmed untouched
    assert r["ai_allergy"]["ai_tags"] == []            # suggestion wiped
    assert r["ai_allergy"]["ai_confirmed"] is True     # won't re-prompt


def test_ai_never_overwrites_a_confirmed_entry(client, db):
    _as(_seed(db))
    rid = _book(client, allergen_tags=["milk"], allergy_note="allergisk over for nødder")
    r = _get(client, rid)
    # Confirmed stays exactly the guest's own; AI sits beside it, never over it.
    assert r["allergen_tags"] == ["milk"]
    assert "nuts" in r["ai_allergy"]["ai_tags"]


def test_action_is_tenant_scoped(client, db):
    a = _seed(db)
    _as(a)
    rid = _book(client, allergy_note="allergisk over for nødder")
    b = _seed(db)
    _as(b)  # switch identity — A's booking must be invisible
    resp = client.patch(
        f"/api/reservations/reservations/{rid}/allergy-suggestion",
        json={"action": "confirm"},
    )
    assert resp.status_code == 404


def test_bad_action_rejected(client, db):
    _as(_seed(db))
    rid = _book(client, allergy_note="allergisk over for nødder")
    resp = client.patch(
        f"/api/reservations/reservations/{rid}/allergy-suggestion",
        json={"action": "delete"},
    )
    assert resp.status_code == 422
