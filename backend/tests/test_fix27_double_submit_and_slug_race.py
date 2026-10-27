"""Fix round 27 Oct (coordinator's extra 2) — a lost race is never a 500.

  • The public booking create with an X-Idempotency-Key: a guest's double tap
    sends the same key twice; the twin read "no booking yet" before the first
    committed. It now re-checks under the venue lock, and if both reads
    missed (two instances, the advisory lock unavailable) the unique key's
    IntegrityError is answered with the booking that exists — the receipt,
    never an error when the booking was made. A key that collides with
    ANOTHER venue's booking is a clean 409 that never hands that booking out.
  • Slug minting in the three setup paths (Indstillinger's switch, the first
    table, the salon quick setup): two venues minting the same link in the
    same instant — each candidate is claimed in a SAVEPOINT, the loser takes
    the next one; the owner's other changes are kept.

SQLite gets production's unique slug index here (main.py creates it on
Postgres); the race windows are opened with monkeypatches.

Run: cd backend && python -m pytest tests/test_fix27_double_submit_and_slug_race.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

from sqlalchemy import text

from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.routers import public_reservations as pubres
from app.services import reservation_service as rsvc
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, client, db, engine_and_session, outbox, restaurant, salon, today_local,
)

DAY = today_local() + timedelta(days=4)


def _post(client, slug, key, *, time="19:00", party=2, name="Sita Sharma"):
    pubres._limiter.reset()
    return client.post(f"/api/public/reservations/{slug}",
                       json={"day": DAY.isoformat(), "time": time, "party_size": party,
                             "guest_name": name, "guest_email": "sita@example.com",
                             "form_ms": 9000, "website": ""},
                       headers={"X-Idempotency-Key": key})


def _misses(monkeypatch, n):
    """The first `n` reads of the key find nothing — the twin read before the
    first booking committed (one miss: outside the lock; two: inside too)."""
    real = pubres._prior_for_key
    calls = {"n": 0}

    def racing(db, owner, key):
        calls["n"] += 1
        return None if calls["n"] <= n else real(db, owner, key)

    monkeypatch.setattr(pubres, "_prior_for_key", racing)
    return calls


def _rows(db, owner):
    db.expire_all()
    return db.query(Reservation).filter(Reservation.user_id == owner.id).all()


# ═══ The double tap ══════════════════════════════════════════════════════
def test_a_double_tap_waits_for_the_lock_and_gets_the_receipt(client, db, outbox, monkeypatch):
    u, p, _ = restaurant(db)
    first = _post(client, p.reservation_slug, "tap-1")
    assert first.status_code == 200 and first.json()["status"] == "confirmed"
    _misses(monkeypatch, 1)                       # read before the first committed
    second = _post(client, p.reservation_slug, "tap-1")
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert len(_rows(db, u)) == 1


def test_both_reads_missed_the_unique_key_still_answers_with_the_booking(client, db, outbox,
                                                                       monkeypatch):
    """No lock between them (two instances): the second insert hits the
    unique key — a confirmed booking (the table path retries, then gives up)
    and a group request (a plain insert) both answer with the first."""
    u, p, _ = restaurant(db)
    for key, party, time in (("tap-2", 2, "19:00"), ("tap-3", 10, "20:00")):
        first = _post(client, p.reservation_slug, key, party=party, time=time)
        assert first.status_code == 200, first.text
        calls = _misses(monkeypatch, 2)
        second = _post(client, p.reservation_slug, key, party=party, time=time)
        assert second.status_code == 200, (key, second.text)
        assert second.json()["id"] == first.json()["id"] and second.json()["status"] == first.json()["status"]
        assert calls["n"] >= 3                    # answered from the committed twin
        monkeypatch.undo()
        db.expire_all()
    assert len(_rows(db, u)) == 2


def test_a_key_another_venue_holds_is_a_clean_409_and_never_its_booking(client, db, outbox):
    a_u, a_p, _ = restaurant(db)
    b_u, b_p, _ = restaurant(db)
    theirs = _post(client, a_p.reservation_slug, "shared-key", party=10, time="20:00")
    assert theirs.status_code == 200
    r = _post(client, b_p.reservation_slug, "shared-key", party=10, time="20:00")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "slot_unavailable"
    assert theirs.json()["id"] not in r.text
    assert _rows(db, b_u) == []


def test_a_salon_double_tap_gets_the_receipt_too(client, db, outbox, monkeypatch):
    """The provider path (a salon's own chair on its opening hours): the
    same double tap, the same receipt."""
    hours = {k: "09:00-17:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    s = salon(db, stylist=None, self_chair=True, booking_hours=hours)
    b = s["behandling"]
    slug = s["profile"].reservation_slug
    slots = client.get(f"/api/public/reservations/{slug}/provider-availability",
                       params={"day": DAY.isoformat(), "behandling_id": str(b.id)}).json()["slots"]
    assert slots, "the chair's opening hours give the day times (control)"
    body = {"day": DAY.isoformat(), "time": slots[0]["start"][11:16], "party_size": 1,
            "guest_name": "Kunde", "guest_email": "kunde@example.com", "form_ms": 9000,
            "website": "", "behandling_id": str(b.id)}
    pubres._limiter.reset()
    first = client.post(f"/api/public/reservations/{slug}", json=body,
                        headers={"X-Idempotency-Key": "salon-tap"})
    assert first.status_code == 200, first.text
    _misses(monkeypatch, 2)
    pubres._limiter.reset()
    second = client.post(f"/api/public/reservations/{slug}", json=body,
                         headers={"X-Idempotency-Key": "salon-tap"})
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert len(_rows(db, s["user"])) == 1


# ═══ Slug minting: two venues, one link, the same instant ════════════════
def _unique_slug(eng) -> None:
    with eng.begin() as conn:
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_business_reservation_slug "
                          "ON business_profiles (reservation_slug)"))


def _competitor_takes(monkeypatch, SessionLocal, slug):
    """While the minter checks `slug` is free, another venue claims it."""
    real = rsvc.alias_lookup
    taken = {"done": False}

    def racing(db, cand):
        if cand == slug and not taken["done"]:
            taken["done"] = True
            s = SessionLocal()
            try:
                other = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
                             business_name="Anden", business_type="restaurant", currency="DKK")
                s.add(other)
                s.flush()
                s.add(BusinessProfile(user_id=other.id, company_name="Anden",
                                      reservation_slug=slug, reservations_enabled=True))
                s.commit()
            finally:
                s.close()
        return real(db, cand)

    monkeypatch.setattr(rsvc, "alias_lookup", racing)
    return taken


def _bare_owner(db, name, business_type="restaurant"):
    u = User(email=f"n-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name=name, business_type=business_type, currency="DKK", plan="pro")
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, company_name=name, reservations_enabled=False,
                           reservation_settings_json=json.dumps({"lead_time_min": 45})))
    db.commit()
    return u


def _slug_of(db, u):
    db.expire_all()
    return db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()


def test_the_settings_switch_mints_another_link_when_one_is_taken_meanwhile(
        client, db, engine_and_session, monkeypatch):
    eng, SessionLocal = engine_and_session
    _unique_slug(eng)
    u = _bare_owner(db, "Hjørnet")
    taken = _competitor_takes(monkeypatch, SessionLocal, "hjoernet")   # ø → oe
    as_owner(u)
    r = client.put("/api/reservations/settings", json={"reservations_enabled": True,
                                                       "settings": {"lead_time_min": 30}})
    assert r.status_code == 200, r.text
    assert taken["done"]
    prof = _slug_of(db, u)
    assert prof.reservation_slug.startswith("hjoernet-") and prof.reservations_enabled is True
    assert json.loads(prof.reservation_settings_json)["lead_time_min"] == 30   # kept


def test_the_first_table_mints_another_link_when_one_is_taken_meanwhile(
        client, db, engine_and_session, monkeypatch):
    eng, SessionLocal = engine_and_session
    _unique_slug(eng)
    u = _bare_owner(db, "Kroen")
    taken = _competitor_takes(monkeypatch, SessionLocal, "kroen")
    as_owner(u)
    r = client.post("/api/reservations/resources", json={
        "kind": "table", "label": "Bord 1", "capacity_seats": 4, "zone": None, "combinable": False})
    assert r.status_code in (200, 201), r.text
    assert taken["done"]
    prof = _slug_of(db, u)
    assert prof.reservation_slug.startswith("kroen-") and prof.reservations_enabled is True


def test_the_salon_quick_setup_mints_another_link_when_one_is_taken_meanwhile(
        client, db, engine_and_session, monkeypatch):
    eng, SessionLocal = engine_and_session
    _unique_slug(eng)
    u = _bare_owner(db, "Saks", business_type="salon")
    taken = _competitor_takes(monkeypatch, SessionLocal, "saks")
    as_owner(u)
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": {"mon": "09:00-17:00"}})
    assert r.status_code == 200, r.text
    assert taken["done"]
    prof = _slug_of(db, u)
    assert prof.reservation_slug.startswith("saks-") and prof.reservations_enabled is True


# ═══ Fix round 4 (review2 #5): never the demo seeder's bookings ══════════
def _seeded(db, owner, *, key, purge_after=None):
    from datetime import datetime as _dt
    start = _dt.combine(DAY, _dt.min.time()).replace(hour=19)
    r = Reservation(user_id=owner.id, guest_name="Sofie Holm", party_size=2, starts_at=start,
                    ends_at=start + timedelta(minutes=90), duration_min=90, status="confirmed",
                    source="public", idempotency_key=key, purge_after=purge_after)
    db.add(r)
    db.commit()
    return r


def test_a_demo_key_never_replays_a_seeded_booking(client, db, outbox):
    """The seeder's key is "demo-<user>-<n>", and the user id is in the
    venue's public logo path: a replay would hand out a sample booking's id
    and booking token."""
    u, p, _ = restaurant(db)
    seeded = _seeded(db, u, key=f"demo-{u.id}-1")
    r = _post(client, p.reservation_slug, f"demo-{u.id}-1", time="20:00")
    assert r.status_code == 200, r.text
    assert r.json()["id"] != str(seeded.id)
    assert str(seeded.id) not in r.text
    assert pubres._prior_for_key(db, u, f"demo-{u.id}-1") is None
    db.expire_all()
    mine = db.query(Reservation).filter(Reservation.id == uuid.UUID(r.json()["id"])).one()
    assert mine.idempotency_key is None                  # the namespace is dropped
    assert db.get(Reservation, seeded.id).idempotency_key == f"demo-{u.id}-1"


def test_a_row_without_purge_after_is_never_replayed(client, db, outbox):
    """Every booking the public door writes has purge_after; one without it
    (seeded, imported) is never handed back on a key."""
    u, p, _ = restaurant(db)
    odd = _seeded(db, u, key="tap-x")
    assert pubres._prior_for_key(db, u, "tap-x") is None
    r = _post(client, p.reservation_slug, "tap-x", time="20:00")
    assert r.status_code in (200, 409), r.text
    assert str(odd.id) not in r.text
    # Control: the guest's own booking on a key is still replayed.
    first = _post(client, p.reservation_slug, "tap-y", time="21:00")
    again = _post(client, p.reservation_slug, "tap-y", time="21:00")
    assert again.json()["id"] == first.json()["id"]
