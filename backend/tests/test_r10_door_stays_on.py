"""
R10 — the door iPad stays on (backend half).

  * The book's REVISION (services/book_revision): /book carries the revision of
    what it sent; /changes?day= carries the revision of that day now. The
    screen reloads quietly when they differ, so a change made by anyone on any
    screen shows everywhere within one poll (~20 s) instead of up to 75 s.
    It must move on EVERY kind of change to the day — create, edit, seat,
    cancel, a move off the day, the Venteliste — and on nothing else: not on
    another day, not on another venue, not on a plain read.
  * It is an opaque hash: no data rides along to a device in a public room.
  * Without `day`, /changes reads nothing extra (a screen with no book open
    pays nothing), and the alert rules are untouched (an owner's own booking
    still never chimes — it only moves the revision).
  * "Afbryd denne skærm": the device switches off its OWN link and nothing
    else; afterwards it 404s like any dead token.

Run: cd backend && python -m pytest tests/test_r10_door_stays_on.py -q
"""

import re
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.stand_link import StandLink
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()
_DAY = "2026-07-04"
_NEXT = "2026-07-05"
_START = f"{_DAY}T19:00:00"


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
    from app.main import _coarse_hits
    from app.routers.stand_link import limiter as _stand_limiter
    _stand_limiter.reset()
    _coarse_hits.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, name="Bistro Nørrebro"):
    u = User(
        email=f"o-{uuid.uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name=name, business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    from app.routers import reservations as R
    from app.routers import stand_link as S
    app.dependency_overrides[S.get_current_user] = lambda: user
    app.dependency_overrides[R.get_current_user] = lambda: user


def _pair(client):
    code = client.post("/api/stand/links", json={"label": "Door iPad"}).json()["code"]
    r = client.post("/api/stand/join", json={"code": code})
    assert r.status_code == 200, r.text
    return r.json()["path"].rsplit("/", 1)[-1]


def _book(client, **body):
    base = {"guest_name": "Agnes Holm", "party_size": 4, "starts_at": _START,
            "auto_assign": False, "allow_overflow": True}
    base.update(body)
    r = client.post("/api/reservations/book", json=base)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _rev(client, day=_DAY):
    r = client.get("/api/reservations/book", params={"day": day})
    assert r.status_code == 200, r.text
    return r.json()["rev"]


def _poll_rev(client, day=_DAY):
    r = client.get("/api/reservations/changes", params={"day": day})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["book_day"] == day
    return body["book_rev"]


# ── the revision ─────────────────────────────────────────────────────

def test_the_book_answer_carries_the_days_revision(client, db):
    u = _seed(db); _as(u)
    _book(client)
    rev = _rev(client)
    assert isinstance(rev, str) and rev
    # The poll answers the same day with the same revision while nothing moves.
    assert _poll_rev(client) == rev
    assert _rev(client) == rev, "a plain read moved the revision"


def test_the_revision_is_an_opaque_hash_with_no_data(client, db):
    u = _seed(db); _as(u)
    _book(client, guest_name="Ingrid Vestergaard", guest_phone="+4512345678")
    rev = _rev(client)
    assert re.fullmatch(r"[0-9a-f]{16}", rev), rev
    body = client.get("/api/reservations/changes", params={"day": _DAY}).text
    for leak in ("Ingrid", "Vestergaard", "12345678"):
        assert leak not in body


def test_an_empty_day_has_a_revision_too_and_the_first_booking_moves_it(client, db):
    u = _seed(db); _as(u)
    empty = _rev(client)
    assert empty
    _book(client)
    assert _rev(client) != empty


@pytest.mark.parametrize("change", [
    "edit_party", "seat", "cancel", "assign_nothing_but_note", "allergy",
])
def test_every_change_to_a_booking_moves_the_revision(client, db, change):
    u = _seed(db); _as(u)
    rid = _book(client)
    before = _rev(client)
    if change == "edit_party":
        r = client.patch(f"/api/reservations/reservations/{rid}",
                         json={"party_size": 5, "notify_guest": False, "allow_overflow": True})
    elif change == "seat":
        r = client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": "seated"})
    elif change == "cancel":
        r = client.patch(f"/api/reservations/reservations/{rid}/status",
                         json={"status": "cancelled", "notify_guest": False})
    elif change == "assign_nothing_but_note":
        r = client.patch(f"/api/reservations/reservations/{rid}",
                         json={"guest_notes": "Vinduesbord hvis muligt", "notify_guest": False})
    else:
        r = client.patch(f"/api/reservations/reservations/{rid}",
                         json={"allergy_note": "Nødder", "allergy_severity": "severe",
                               "notify_guest": False})
    assert r.status_code == 200, r.text
    after = _rev(client)
    assert after != before, f"{change} did not move the revision"
    # …and the poll sees exactly what the book sends.
    assert _poll_rev(client) == after


def test_a_booking_moved_to_another_day_moves_both_days(client, db):
    u = _seed(db); _as(u)
    rid = _book(client)
    _book(client, guest_name="Bo", starts_at=f"{_DAY}T18:00:00")
    today_before, tomorrow_before = _rev(client), _rev(client, _NEXT)
    r = client.patch(f"/api/reservations/reservations/{rid}",
                     json={"starts_at": f"{_NEXT}T19:00:00", "notify_guest": False,
                           "allow_overflow": True})
    assert r.status_code == 200, r.text
    assert _rev(client) != today_before, "the day it left did not notice"
    assert _rev(client, _NEXT) != tomorrow_before, "the day it joined did not notice"


def test_a_deleted_row_moves_the_revision(client, db):
    """A hard delete (the GDPR purge) or a soft delete: the count drops."""
    u = _seed(db); _as(u)
    rid = _book(client)
    _book(client, guest_name="Bo", starts_at=f"{_DAY}T18:00:00")
    before = _rev(client)
    row = db.query(Reservation).filter(Reservation.id == uuid.UUID(rid)).first()
    db.delete(row); db.commit()
    assert _rev(client) != before


def test_the_venteliste_moves_the_revision(client, db):
    u = _seed(db); _as(u)
    before = _rev(client)
    added = client.post("/api/reservations/waitlist", json={
        "guest_name": "Mette", "guest_phone": "+4520304050", "party_size": 2,
        "waitlist_date": _DAY,
    })
    assert added.status_code in (200, 201), added.text
    after_add = _rev(client)
    assert after_add != before
    gone = client.patch(f"/api/reservations/waitlist/{added.json()['id']}",
                        json={"status": "cancelled"})
    assert gone.status_code == 200, gone.text
    assert _rev(client) != after_add


def test_another_day_and_another_venue_leave_the_revision_alone(client, db):
    a, b = _seed(db), _seed(db, "Café Nabo")
    _as(a)
    _book(client)
    rev_a = _rev(client)
    _book(client, guest_name="Tomorrow", starts_at=f"{_NEXT}T19:00:00")
    assert _rev(client) == rev_a, "a booking tomorrow moved today's revision"
    _as(b)
    _book(client, guest_name="Neighbour")
    _as(a)
    assert _rev(client) == rev_a, "the venue next door moved this venue's revision"


def test_a_late_seating_after_midnight_belongs_to_tonight(client, db):
    """Same business-day window as the book (06:00 cutoff): a 00:30 drop-in is
    tonight's, so it moves tonight's revision, not tomorrow's."""
    u = _seed(db); _as(u)
    tonight, tomorrow = _rev(client), _rev(client, _NEXT)
    _book(client, guest_name="Natugle", starts_at=f"{_NEXT}T00:30:00")
    assert _rev(client) != tonight
    assert _rev(client, _NEXT) == tomorrow


# ── the poll: cheap, and the alert rules unchanged ───────────────────

def test_changes_without_a_day_reads_nothing_extra(client, db, engine_and_session):
    engine, _ = engine_and_session
    u = _seed(db); _as(u)
    _book(client)
    seen = []

    def _count(conn, cursor, statement, *a, **k):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        r = client.get("/api/reservations/changes")
        assert r.status_code == 200
        assert "book_rev" not in r.json() and "book_day" not in r.json()
        assert seen == [], f"the bare poll read the database: {seen}"
        r = client.get("/api/reservations/changes", params={"day": _DAY})
        assert r.json()["book_rev"]
        assert len(seen) == 2, f"the revision should cost two aggregate reads, not {len(seen)}"
    finally:
        event.remove(engine, "before_cursor_execute", _count)


def test_an_owners_own_booking_moves_the_revision_but_never_alerts(client, db):
    u = _seed(db); _as(u)
    first = client.get("/api/reservations/changes", params={"day": _DAY}).json()
    anchor, rev0 = first["server_time"], first["book_rev"]
    assert first["changes"] == []
    _book(client, guest_name="Telefon")
    nxt = client.get("/api/reservations/changes", params={"since": anchor, "day": _DAY}).json()
    assert nxt["changes"] == [], "the owner's own booking chimed back at them"
    assert nxt["book_rev"] != rev0, "…and the other screens never heard of it"


def test_a_guest_booking_still_alerts_and_moves_the_revision(client, db):
    u = _seed(db); _as(u)
    first = client.get("/api/reservations/changes", params={"day": _DAY}).json()
    start = datetime.fromisoformat(_START)
    guest = Reservation(
        user_id=u.id, guest_name="Online Gæst", party_size=2,
        starts_at=start, ends_at=start + timedelta(minutes=90), duration_min=90,
        status="confirmed", source="public",
    )
    db.add(guest); db.commit()
    nxt = client.get("/api/reservations/changes",
                     params={"since": first["server_time"], "day": _DAY}).json()
    assert str(guest.id) in [c["id"] for c in nxt["changes"]]
    assert nxt["book_rev"] != first["book_rev"]


def test_a_failed_revision_costs_freshness_never_the_book(client, db, monkeypatch):
    u = _seed(db); _as(u)
    rid = _book(client)
    from app.services import book_revision

    def boom(*a, **k):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(book_revision, "day_revision", boom)
    r = client.get("/api/reservations/book", params={"day": _DAY})
    assert r.status_code == 200, r.text
    assert r.json()["rev"] is None
    assert rid in [x["id"] for x in r.json()["reservations"]]
    c = client.get("/api/reservations/changes", params={"day": _DAY})
    assert c.status_code == 200 and c.json()["book_rev"] is None


def test_a_bad_day_is_refused_not_guessed(client, db):
    u = _seed(db); _as(u)
    assert client.get("/api/reservations/changes", params={"day": "i-dag"}).status_code == 422


# ── the paired device ────────────────────────────────────────────────

def test_the_door_device_gets_the_same_revision_as_the_owner(client, db):
    u = _seed(db); _as(u)
    token = _pair(client)
    _book(client)
    owner_rev = _rev(client)
    book = client.get(f"/api/stand/{token}/book", params={"day": _DAY})
    assert book.status_code == 200, book.text
    assert book.json()["rev"] == owner_rev
    poll = client.get(f"/api/stand/{token}/changes", params={"day": _DAY})
    assert poll.status_code == 200, poll.text
    assert poll.json()["book_day"] == _DAY
    assert poll.json()["book_rev"] == owner_rev
    # The owner's phone booking reaches the door within one poll.
    _book(client, guest_name="Fra telefonen", starts_at=f"{_DAY}T20:00:00")
    assert client.get(f"/api/stand/{token}/changes",
                      params={"day": _DAY}).json()["book_rev"] != owner_rev


def test_the_door_device_poll_without_a_day_is_unchanged(client, db):
    u = _seed(db); _as(u)
    token = _pair(client)
    r = client.get(f"/api/stand/{token}/changes")
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"server_time", "changes"}


def test_the_door_device_revision_is_tenant_locked(client, db):
    a, b = _seed(db), _seed(db, "Café Nabo")
    _as(a); token_a = _pair(client)
    rev = client.get(f"/api/stand/{token_a}/changes", params={"day": _DAY}).json()["book_rev"]
    _as(b); _book(client, guest_name="Nabo")
    assert client.get(f"/api/stand/{token_a}/changes",
                      params={"day": _DAY}).json()["book_rev"] == rev


def test_unpair_switches_off_the_devices_own_link(client, db):
    u = _seed(db); _as(u)
    token = _pair(client)
    assert client.get(f"/api/stand/{token}/book", params={"day": _DAY}).status_code == 200

    r = client.post(f"/api/stand/{token}/unpair", json={})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}

    # The link is dead everywhere: book, poll, and a second unpair.
    assert client.get(f"/api/stand/{token}/book", params={"day": _DAY}).status_code == 404
    assert client.get(f"/api/stand/{token}/changes").status_code == 404
    assert client.post(f"/api/stand/{token}/unpair", json={}).status_code == 404

    row = db.query(StandLink).filter(StandLink.token == token).first()
    db.refresh(row)
    assert row.active is False and row.revoked_at is not None
    # The owner's list says it is gone.
    devices = client.get("/api/stand/links").json()["devices"]
    assert [d["active"] for d in devices] == [False]
    # …and the audit says the DEVICE did it, for the venue.
    audit = (db.query(AuditLog)
             .filter(AuditLog.action == "stand.link_unpaired", AuditLog.user_id == u.id)
             .all())
    assert len(audit) == 1 and audit[0].actor_type == "stand_device"


def test_unpair_reaches_no_other_link(client, db):
    a, b = _seed(db), _seed(db, "Café Nabo")
    _as(a)
    door, bar = _pair(client), _pair(client)
    _as(b)
    neighbour = _pair(client)
    assert client.post(f"/api/stand/{door}/unpair", json={}).status_code == 200
    assert client.get(f"/api/stand/{bar}/book", params={"day": _DAY}).status_code == 200
    assert client.get(f"/api/stand/{neighbour}/book", params={"day": _DAY}).status_code == 200


def test_unpair_of_an_unknown_token_is_the_same_404(client, db):
    _seed(db)
    r = client.post(f"/api/stand/{'x' * 32}/unpair", json={})
    assert r.status_code == 404
    assert r.json()["detail"] == {"error": "not_found"}


def test_unpair_is_rate_limited(client, db):
    """slowapi keys these by URL (key_style "url"), so the cap is per link and
    per address — a script hammering one door's unpair gets 429 after ten."""
    _seed(db)
    codes = [client.post("/api/stand/nope/unpair", json={}).status_code for _ in range(11)]
    assert codes[:10] == [404] * 10
    assert codes[10] == 429
