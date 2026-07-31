"""
Allergy write on the edit path (PATCH /api/reservations/{id}).

WHY THIS EXISTS. The host stand plays a distinct urgent tone for a SEVERE
allergy — and until now had no way to record one. A guest phoning "nødeallergi"
left the host nowhere to put it: the only allergy write on the whole screen was
confirm/dismiss of a pre-existing AI suggestion. Create already accepted the
fields; edit did not.

Locks under test (safety / honesty / privacy invariants):
  • The edit path can actually set allergy_note, allergy_severity and
    allergen_tags. (The first version of this shipped with the sanitiser
    imported only inside the CREATE function — the edit handler raised
    NameError at runtime while every static check passed.)
  • Severity goes through sanitize_severity: an invented level is dropped,
    never stored raw.
  • Tags go through the vertical vocabulary, never a raw client write.
  • A HUMAN entry counts as confirmed, so the "muligt: X — bekræft?" prompt
    stops nagging over what the host just typed.
  • Allergy is editable on a SEATED booking — the status gate that guards
    time/party changes must not block a guest telling you at the table.
  • The audit row records THAT allergy changed, never what it says: audit rows
    outlive the reservation's purge_after, so Art. 9 health text in there would
    survive the erasure of the booking it belongs to.
  • Tenant-scoped: another owner's reservation is a 404.

Run: cd backend && python3 -m pytest tests/test_reservation_allergy_edit.py -x -q
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


def _edit(client, rid, **body):
    return client.patch(f"/api/reservations/reservations/{rid}", json=body)


# ── the write actually lands ─────────────────────────────────────────

def test_edit_can_set_allergy(client, db):
    """The regression that motivated this file: the handler referenced
    sanitize_tags/sanitize_severity which were imported only inside create."""
    _as(_seed(db))
    rid = _book(client)
    res = _edit(client, rid, allergy_note="Nødeallergi — separat pande",
                allergy_severity="severe")
    assert res.status_code == 200, res.text
    r = _get(client, rid)
    assert r["allergy_note"] == "Nødeallergi — separat pande"
    assert r["allergy_severity"] == "severe"


def test_edit_sets_structured_tags_through_vocabulary(client, db):
    _as(_seed(db))
    rid = _book(client)
    res = _edit(client, rid, allergen_tags=["nuts", "not_a_real_allergen"])
    assert res.status_code == 200, res.text
    tags = _get(client, rid)["allergen_tags"]
    assert "nuts" in tags
    assert "not_a_real_allergen" not in tags  # never a raw client write


def test_invented_severity_is_dropped_not_stored(client, db):
    _as(_seed(db))
    rid = _book(client)
    assert _edit(client, rid, allergy_severity="CATASTROPHIC").status_code == 200
    assert _get(client, rid)["allergy_severity"] is None


def test_severity_accepts_every_real_level(client, db):
    from app.services.allergens import SEVERITY_LEVELS
    _as(_seed(db))
    rid = _book(client)
    for level in SEVERITY_LEVELS:
        assert _edit(client, rid, allergy_severity=level).status_code == 200
        assert _get(client, rid)["allergy_severity"] == level


# ── a human entry is the confirmed record ────────────────────────────

def test_human_entry_stops_the_ai_confirm_prompt(client, db):
    """Booking free-text raises an unconfirmed AI suggestion. Once the host
    types the allergy themselves, the row must stop asking them to confirm a
    guess that sits underneath what they just wrote."""
    _as(_seed(db))
    rid = _book(client, allergy_note="Allergisk over for nødder")
    assert _get(client, rid)["ai_allergy"]["has_ai_suggested_allergy"] is True

    assert _edit(client, rid, allergy_severity="severe").status_code == 200
    assert _get(client, rid)["ai_allergy"]["has_ai_suggested_allergy"] is False


# ── the status gate must not block it ────────────────────────────────

def test_allergy_editable_while_seated(client, db):
    """Time/party edits are gated to requested|confirmed. A guest telling you
    about an allergy once they are at the table is the common case, so the
    allergy write must not inherit that gate."""
    _as(_seed(db))
    rid = _book(client)
    assert client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "seated"}).status_code == 200
    res = _edit(client, rid, allergy_note="Skaldyr — ingen bisque",
                allergy_severity="severe")
    assert res.status_code == 200, res.text
    assert _get(client, rid)["allergy_severity"] == "severe"


def test_time_change_still_blocked_while_seated(client, db):
    """The gate itself must survive — allergy is an exception, not a hole."""
    _as(_seed(db))
    rid = _book(client)
    client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": "seated"})
    assert _edit(client, rid, party_size=9).status_code == 409


# ── privacy: Art. 9 text must not reach the audit log ────────────────

def test_audit_records_that_allergy_changed_not_what_it_says(client, db):
    import json as _json
    from app.models.audit_log import AuditLog

    user = _seed(db)
    _as(user)
    rid = _book(client)
    secret = "Nødeallergi — anafylaksi, adrenalinpen i tasken"
    assert _edit(client, rid, allergy_note=secret,
                 allergy_severity="severe").status_code == 200

    rows = db.query(AuditLog).filter(AuditLog.user_id == user.id).all()
    assert rows, "the edit should have produced an audit row at all"
    blob = " ".join(
        _json.dumps(getattr(row, f, None), default=str, ensure_ascii=False)
        for row in rows
        for f in ("before_state", "after_state")
        if getattr(row, f, None) is not None
    )
    # Guard against the assertion below passing vacuously on an empty blob.
    assert blob.strip(), "no audit state captured — the assertions below would be hollow"
    assert secret not in blob, "Art. 9 allergy text leaked into the audit log"
    assert "allergy_changed" in blob, "the fact of the change should be audited"


# ── tenancy ──────────────────────────────────────────────────────────

def test_foreign_reservation_is_404(client, db):
    owner_a = _seed(db)
    _as(owner_a)
    rid = _book(client)

    _as(_seed(db))  # a different owner
    assert _edit(client, rid, allergy_severity="severe").status_code == 404
