"""Fix round 27 Oct (I, backend F1) — a lost race answers 409, never 500.

On Postgres, audit_service.record() flushed the caller's pending change INSIDE
its try/except: the change's own unique or exclusion violation was swallowed
there, the session was left rolled back, and the route's db.commit() then
raised PendingRollbackError — a 500 where the route meant a 409 (and the page
only says "Tryk Bekræft igen" on a 409). The data stayed correct; the answer
did not. Now the caller's change is flushed OUTSIDE the guard (and the three
routes flush it inside their own IntegrityError handler). The audit row stays
ATOMIC with the change (fix round 4, review2 #4): a row that cannot be written
takes the change with it; only `best_effort=True` (plain logging) puts it in a
SAVEPOINT that never takes the change with it.

SQLite has neither the slug's unique index nor the occupancy exclusion
constraint the way production does, so these tests give the in-memory
database the same rules — the unique index main.py creates on Postgres, and a
trigger with the exclusion constraint's meaning — and open the race window
with a monkeypatch: the check before the write reads "free", the competitor
commits, the write fails AT FLUSH with a real IntegrityError. The final gate
re-runs test/backend/pg/pg_checks.py on Postgres itself.

Run: cd backend && python -m pytest tests/test_fix27_conflicts_answer_409.py -q
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import text

from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.services import audit_service
from app.services import reservation_occupancy_service as occ_service
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    active_occupancy, as_owner, book, client, db, engine_and_session, outbox,
    reservation, restaurant, today_local,
)

DAY = today_local() + timedelta(days=5)


# ── Production's rules, on the in-memory database ─────────────────────────
def _exclusion(eng) -> None:
    """The occupancy exclusion constraint's meaning: no two ACTIVE holds on
    one table overlap ([start, end) half-open)."""
    for op in ("INSERT", "UPDATE"):
        with eng.begin() as conn:
            conn.execute(text(f"""
                CREATE TRIGGER IF NOT EXISTS occ_no_overlap_{op.lower()}
                BEFORE {op} ON reservation_occupancy
                WHEN NEW.active = 1 AND EXISTS (
                    SELECT 1 FROM reservation_occupancy o
                    WHERE o.resource_id = NEW.resource_id AND o.active = 1
                      AND o.id != NEW.id
                      AND o.starts_at < NEW.ends_at AND o.ends_at > NEW.starts_at)
                BEGIN
                    SELECT RAISE(ABORT, 'conflicting key value violates exclusion constraint');
                END"""))


def _unique_slug(eng) -> None:
    """The index main.py creates on Postgres (ux_business_reservation_slug)."""
    with eng.begin() as conn:
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_business_reservation_slug "
                          "ON business_profiles (reservation_slug)"))


def _one_table(db, owner, label, seats):
    for r in db.query(BookableResource).filter(BookableResource.user_id == owner.id).all():
        db.delete(r)
    db.commit()
    t = BookableResource(user_id=owner.id, kind="table", label=label, capacity_seats=seats,
                         sort_order=0, zone="inde", combinable=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _hold(SessionLocal, rid, table_id) -> None:
    """Another screen's change, committed in its own session."""
    s = SessionLocal()
    try:
        r = s.get(Reservation, uuid.UUID(str(rid)))
        r.status = "confirmed"
        r.resource_id = table_id
        r.combined_resource_ids = None
        s.flush()
        occ_service.add_occupancy_row(s, r, active=True)
        s.commit()
    finally:
        s.close()


# ── R11: two screens confirm two groups onto one 8-top ────────────────────
def test_fix_i_the_screen_that_loses_the_8_top_gets_409_slot_unavailable(
        client, db, engine_and_session, outbox, monkeypatch):
    eng, SessionLocal = engine_and_session
    _exclusion(eng)
    u, p, _ = restaurant(db, tables=0)
    eight = _one_table(db, u, "Bord 8", 8)
    first = book(client, p.reservation_slug, day=DAY, time="20:30", party=8, name="Selskab A",
                 email="a@example.com").json()["id"]
    second = book(client, p.reservation_slug, day=DAY, time="20:30", party=8, name="Selskab B",
                  email="b@example.com").json()["id"]
    assert reservation(db, second).status == "requested"

    import app.routers.reservations as R
    real = R._tables_on_confirm

    def racing(db_, user, r, if_no_table):
        out = real(db_, user, r, if_no_table)      # B reads the 8-top free...
        _hold(SessionLocal, first, eight.id)       # ...and A's confirm commits first
        return out

    monkeypatch.setattr(R, "_tables_on_confirm", racing)
    as_owner(u)
    res = client.patch(f"/api/reservations/reservations/{second}/status",
                       json={"status": "confirmed", "if_no_table": "ask"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "slot_unavailable"
    # Nothing of B's half-made change stays; A keeps the table.
    b = reservation(db, second)
    assert b.status == "requested" and b.resource_id is None and active_occupancy(db, second) == []
    assert [o.resource_id for o in active_occupancy(db, first)] == [eight.id]
    # A clean session: the next ask answers, and says the table is taken.
    monkeypatch.setattr(R, "_tables_on_confirm", real)
    again = client.patch(f"/api/reservations/reservations/{second}/status",
                         json={"status": "confirmed", "if_no_table": "ask"})
    assert again.status_code == 409 and again.json()["detail"]["error"] == "no_table_fits"


# ── R2: "Fortryd" on a spam mark vs a guest who took the freed table ──────
def test_fix_i_undoing_spam_onto_a_table_a_guest_just_took_is_409(
        client, db, engine_and_session, outbox, monkeypatch):
    eng, _ = engine_and_session
    _exclusion(eng)
    u, p, _ = restaurant(db, tables=0)
    _one_table(db, u, "Bord 1", 4)
    rid = book(client, p.reservation_slug, day=DAY, time="19:00", name="Falsk Frida",
               email="falsk@example.com").json()["id"]
    as_owner(u)
    assert client.post(f"/api/reservations/reservations/{rid}/spam", json={}).status_code == 200
    # A real guest books the freed table...
    guest = book(client, p.reservation_slug, day=DAY, time="19:00", name="Ægte Gæst",
                 email="guest@example.com")
    assert guest.status_code == 200 and guest.json()["status"] == "confirmed"
    # ...after the undo's own check read it free.
    import app.routers.reservations as R
    monkeypatch.setattr(R, "_held_pick_free", lambda *a, **k: True)
    as_owner(u)
    res = client.post(f"/api/reservations/reservations/{rid}/spam/undo")
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "slot_unavailable"
    r = reservation(db, rid)
    assert r.status == "cancelled" and active_occupancy(db, rid) == []
    assert len(active_occupancy(db, guest.json()["id"])) == 1
    assert db.query(AuditLog).filter(AuditLog.entity_id == r.id,
                                     AuditLog.action.like("%undo%")).count() == 0
    # A clean session: the owner's next call answers.
    assert client.get("/api/reservations/contact-blocks").status_code == 200


# ── R9: two venues take one link in the same instant ─────────────────────
def test_fix_i_the_venue_that_loses_a_link_race_gets_409_slug_taken(
        client, db, engine_and_session, outbox, monkeypatch):
    eng, SessionLocal = engine_and_session
    _unique_slug(eng)
    u, p, _ = restaurant(db, tables=0)
    other_u, other_p, _ = restaurant(db, tables=0)
    before = p.reservation_slug
    from app.services import reservation_service as rsvc
    real = rsvc.alias_lookup

    def racing(db_, slug):
        if slug == "hjornet":
            s = SessionLocal()                     # the other venue commits first
            try:
                s.get(BusinessProfile, other_p.id).reservation_slug = "hjornet"
                s.commit()
            finally:
                s.close()
        return real(db_, slug)

    monkeypatch.setattr(rsvc, "alias_lookup", racing)
    as_owner(u)
    res = client.post("/api/reservations/slug", json={"slug": "hjornet"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "slug_taken"
    db.expire_all()
    assert db.get(BusinessProfile, p.id).reservation_slug == before
    assert db.get(BusinessProfile, other_p.id).reservation_slug == "hjornet"
    monkeypatch.setattr(rsvc, "alias_lookup", real)
    assert client.post("/api/reservations/slug", json={"slug": "hjornet-2"}).status_code == 200


# ── audit_service.record itself ───────────────────────────────────────────
def test_fix_i_record_never_swallows_the_callers_own_conflict(db, engine_and_session):
    from sqlalchemy.exc import IntegrityError
    eng, _ = engine_and_session
    _unique_slug(eng)
    u, p, _ = restaurant(db, tables=0)
    o_u, o_p, _ = restaurant(db, tables=0)
    uid, pid, taken = u.id, p.id, o_p.reservation_slug  # read before the change: no
    p.reservation_slug = taken                          # autoflush may fire it early
    try:
        audit_service.record(db, uid, "reservation.slug_changed", "business_profile", pid)
    except IntegrityError:
        db.rollback()
    else:  # pragma: no cover
        raise AssertionError("the caller's conflict must reach the caller")
    assert db.query(AuditLog).filter(AuditLog.user_id == uid).count() == 0


def test_fix_i_a_best_effort_audit_row_never_takes_the_change_with_it(db):
    """The opt-in (fix round 4): plain logging that carries no state may go
    in a SAVEPOINT — if it fails, the change still commits."""
    u, p, _ = restaurant(db, tables=0)
    uid, pid = u.id, p.id
    p.company_name = "Nyt Navn"
    # An audit row that cannot be written on its own (action is NOT NULL).
    audit_service.record(db, uid, None, "business_profile", pid, best_effort=True)
    audit_service.record(db, uid, "business_profile.renamed", "business_profile", pid)
    db.commit()
    db.expire_all()
    assert db.get(BusinessProfile, pid).company_name == "Nyt Navn"
    assert [a.action for a in db.query(AuditLog).filter(AuditLog.user_id == uid).all()] == [
        "business_profile.renamed"]


def test_fix_i_by_default_a_failing_audit_row_takes_the_change_with_it(db):
    """Atomic by default (fix round 4, review2 #4): a change never commits
    without its row — the row may BE the state (a held mark, a lock)."""
    import pytest
    u, p, _ = restaurant(db, tables=0)
    uid, pid, before = u.id, p.id, p.company_name
    p.company_name = "Nyt Navn"
    audit_service.record(db, uid, None, "business_profile", pid)     # cannot be written
    with pytest.raises(Exception):
        db.commit()
    db.rollback()
    db.expire_all()
    assert db.get(BusinessProfile, pid).company_name == before
    assert db.query(AuditLog).filter(AuditLog.user_id == uid).count() == 0
