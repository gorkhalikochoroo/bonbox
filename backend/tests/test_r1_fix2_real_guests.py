"""Booking fix round 2 (24 Oct 2026) — a REAL-GUEST SIMULATION, in CI.

Manoj's rule: on a normal busy night a real guest is confirmed at once; only
bot-like forms, bursts and patterns wait for the owner. The recheck showed
the fix round broke it: the 4th online booking for a busy Friday dinner at a
6-table venue waited for the owner while three tables were free, and an
honest-looking drip spread over future dates put every later guest, on
every date, on hold.

This walks simulated busy weeks through the REAL create path (GET
/availability, then POST /api/public/reservations/{slug}) at 4, 6 and 10
tables, on a simulated clock: every "now" the path reads and every
created_at it writes follow the clock, so nothing is back-dated and every
booking meets the screen at its own minute. Then the attack bursts, on the
same clock. The model of the week (documented, seeded — the evidence run in
bonbox-lab-state/booking-to-8-2026-10-24/fix2/run/sim_real_guests.py walks
30 weeks per size with the same model):

  • a dinner restaurant, Tue–Sun 17:00–22:00, 4-seat tables, 15-min slots,
    90/105/120-min sittings, lead time 30 min;
  • online bookings per date: Fri and Sat 1.5 × tables (≈ 75 % of a
    two-turn evening, online only), Thu 0.9, Wed and Sun 0.6, Tue 0.5;
  • made: same day 22 %, 1 day before 18 %, 2 days 12 %, 3 days 10 %, 4–6
    days 18 %, 7–13 days 15 %, 14–20 days 5 % — at a waking hour (08–23);
  • party 2–6, a wished time 17:00–21:00 (the nearest offered time within
    90 min when it is full, else the guest goes elsewhere); every guest
    their own e-mail, phone and address; a form filled in 25–120 s.

Run: cd backend && python -m pytest tests/test_r1_fix2_real_guests.py -q
"""
from __future__ import annotations

import json
import math
import random
import uuid
from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

import pytest
from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, clock, db, engine_and_session, outbox,
)

CPH = ZoneInfo("Europe/Copenhagen")
SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 4, "minutes": 105},
                        {"up_to": 8, "minutes": 120}],
    "default_duration_min": 120, "lead_time_min": 30, "max_advance_days": 60,
    "max_party_size": 20, "group_request_threshold": 8, "retention_days": 90,
}
HOURS = {"mon": "closed", "tue": "17:00-22:00", "wed": "17:00-22:00", "thu": "17:00-22:00",
         "fri": "17:00-22:00", "sat": "17:00-22:00", "sun": "17:00-22:00"}
PER_DAY = {1: 0.5, 2: 0.6, 3: 0.9, 4: 1.5, 5: 1.5, 6: 0.6}
LEAD = [(0, 22), (1, 18), (2, 12), (3, 10), ((4, 6), 18), ((7, 13), 15), ((14, 20), 5)]
WAKE = {8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 13: 6, 14: 5, 15: 5, 16: 6, 17: 6, 18: 6, 19: 7,
        20: 7, 21: 6, 22: 4, 23: 2}
PARTY = [(2, 55), (3, 10), (4, 25), (5, 5), (6, 5)]
WISH = {17: 1, 17.5: 2, 18: 4, 18.5: 5, 19: 5, 19.5: 4, 20: 3, 20.5: 2, 21: 1}


def _venue(db, tables):
    u = User(email=f"sim-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Sim Bistro", business_type="restaurant", currency="DKK", plan="pro",
             email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    sett = dict(SETTINGS, booking_hours=HOURS)
    p = BusinessProfile(user_id=u.id, company_name="Sim Bistro",
                        reservation_slug=f"sim-{uuid.uuid4().hex[:8]}", reservations_enabled=True,
                        reservation_settings_json=json.dumps(sett),
                        operating_hours_json=json.dumps(HOURS))
    db.add(p)
    for i in range(tables):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                                capacity_seats=4, sort_order=i))
    db.commit()
    return u, p.reservation_slug


_IP = [0]


def _ip():
    _IP[0] += 1
    n = _IP[0]
    return f"{11 + (n >> 16) % 200}.{(n >> 8) & 255}.{n & 255}.{1 + n % 250}"


def _reason(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(rid),
                                   AuditLog.action == "reservation.held_public").first())
    return json.loads(a.after_state).get("reason") if a else None


def _offered(client, slug, day, party):
    import app.routers.public_reservations as pr
    pr._limiter.reset()
    r = client.get(f"/api/public/reservations/{slug}/availability",
                   params={"day": day.isoformat(), "party": party},
                   headers={"CF-Connecting-IP": _ip()})
    assert r.status_code == 200, r.text
    return [s[:5] for s in r.json().get("slots") or []]


def _post(client, db, slug, day, t, *, party=2, form_ms=60000, email=None, phone=None, name="Gæst"):
    import app.routers.public_reservations as pr
    pr._limiter.reset()
    body = {"day": day.isoformat(), "time": t, "party_size": party, "guest_name": name,
            "guest_email": email or f"{uuid.uuid4().hex[:10]}@example.dk", "website": "",
            "form_ms": form_ms}
    if phone:
        body["guest_phone"] = phone
    r = client.post(f"/api/public/reservations/{slug}", json=body,
                    headers={"CF-Connecting-IP": _ip()})
    assert r.status_code == 200, r.text
    j = r.json()
    return j["status"], (_reason(db, j["id"]) if j["status"] == "requested" else None)


def _pick(rng, table):
    items = list(table.items()) if isinstance(table, dict) else table
    x = rng.uniform(0, sum(w for _, w in items))
    for v, w in items:
        x -= w
        if x <= 0:
            return v
    return items[-1][0]


def _friday():
    t = datetime.now(CPH).date() + timedelta(days=12)
    while t.weekday() != 4:
        t += timedelta(days=1)
    return t


def _week(rng, tables, friday):
    """[(created_local, day, wished, party)] — every online booking whose
    creation falls between the Friday a week before and the target Friday."""
    start = datetime.combine(friday - timedelta(days=7), dtime(0, 0))
    end = datetime.combine(friday, dtime(23, 0))
    out = []
    for k in range(-7, 22):
        d = friday + timedelta(days=k)
        mult = PER_DAY.get(d.weekday())
        if not mult:
            continue
        for _ in range(max(0, int(round(mult * tables + rng.uniform(-0.4, 0.4))))):
            party = _pick(rng, PARTY)
            wh = _pick(rng, WISH)
            hh, mm = int(wh), (30 if wh % 1 else 0)
            sit = datetime.combine(d, dtime(hh, mm))
            lead = _pick(rng, LEAD)
            before = rng.randint(*lead) if isinstance(lead, tuple) else lead
            created = None
            for attempt in range(20):
                c = datetime.combine(d - timedelta(days=before), dtime(_pick(rng, WAKE), rng.randint(0, 59)))
                if c <= sit - timedelta(minutes=45):
                    created = c
                    break
                if before == 0 and attempt > 8:
                    before = 1
            if created is not None and start <= created <= end:
                out.append((created, d, f"{hh:02d}:{mm:02d}", party))
    out.sort(key=lambda x: x[0])
    return out


def _nearest(offered, wished):
    if wished in offered:
        return wished
    wm = int(wished[:2]) * 60 + int(wished[3:])
    best = None
    for s in offered:
        gap = abs(int(s[:2]) * 60 + int(s[3:]) - wm)
        if gap <= 90 and (best is None or gap < best[0]):
            best = (gap, s)
    return best[1] if best else None


# ── a busy week of real guests: nobody waits for the owner ────────────────
@pytest.mark.parametrize("tables", [4, 6, 10])
def test_a_busy_week_of_real_guests_is_confirmed_at_once(client, db, outbox, clock, tables):
    friday = _friday()
    posted, held, friday_n = 0, [], 0
    for seed in range(2):
        rng = random.Random(7919 * seed + tables)
        _u, slug = _venue(db, tables)
        for created, day, wished, party in _week(rng, tables, friday):
            clock.local = created
            t = _nearest(_offered(client, slug, day, party), wished)
            if t is None:
                continue                      # full — this guest books elsewhere
            status, reason = _post(client, db, slug, day, t, party=party,
                                   form_ms=rng.randint(25000, 120000),
                                   phone=f"+45 2{rng.randint(0, 9999999):07d}", name="Rigtig Gæst")
            posted += 1
            friday_n += day == friday
            if status != "confirmed":
                held.append((created.isoformat(), day.isoformat(), t, status, reason))
    # Both ways: a busy week really was walked (a Friday near full online),
    # and not one real guest waited for the owner.
    assert posted >= 2 * 3 * tables, posted
    assert friday_n >= 2 * tables, friday_n
    assert held == [], held


# ── the attack bursts are still held ──────────────────────────────────────
@pytest.mark.parametrize("tables", [4, 6, 10])
def test_the_attack_bursts_are_still_held(client, db, outbox, clock, tables):
    friday = _friday()
    base = datetime.combine(friday - timedelta(days=3), dtime(10, 0))
    sit_cap = max(3, math.ceil(tables / 2))
    date_cap = max(6, math.ceil(1.5 * tables))

    # A1 — 20 posts in two minutes for Friday 19:00 (rotating addresses,
    # honest timing): half the tables confirmed, the rest held.
    _u, slug = _venue(db, tables)
    got = []
    for i in range(20):
        clock.local = base + timedelta(seconds=6 * i)
        got.append(_post(client, db, slug, friday, "19:00", form_ms=5000, name=f"Bot {i}"))
    assert [s for s, _ in got].count("confirmed") == sit_cap
    assert {r for s, r in got if s == "requested"} == {"sitting_full"}

    # A2 — a drip on ONE date, 3 an hour for 10 hours: at most the date ceiling.
    _u, slug = _venue(db, tables)
    times = ("17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30")
    got = []
    for h in range(10):
        for j in range(3):
            clock.local = base + timedelta(hours=h, minutes=20 * j)
            got.append(_post(client, db, slug, friday, times[(3 * h + j) % 8], form_ms=5000))
    confirmed = [s for s, _ in got].count("confirmed")
    assert 0 < confirmed <= date_cap
    assert "date_full" in {r for _, r in got}

    # A3 — a drip spread over dates (1 an hour for a day) passes as bookings;
    # what matters: real guests on the other dates are NOT held after it.
    _u, slug = _venue(db, tables)
    for h in range(24):
        clock.local = base + timedelta(hours=h)
        d = friday + timedelta(days=1 + h)
        d += timedelta(days=1) if d.weekday() == 0 else timedelta(0)
        _post(client, db, slug, d, "19:00", form_ms=5000, name=f"Spread {h}")
    real = []
    for k in range(5):
        clock.local = base + timedelta(hours=24, minutes=10 * k)
        d = friday - timedelta(days=1) if k % 2 else friday
        real.append(_post(client, db, slug, d, ("18:00", "18:30", "20:00", "17:30", "19:30")[k]))
    assert real == [("confirmed", None)] * 5

    # A5 — ten forms filled at bot speed: every one held, none confirmed.
    _u, slug = _venue(db, tables)
    got = []
    for i in range(10):
        clock.local = base + timedelta(minutes=i)
        got.append(_post(client, db, slug, friday, times[i % 8], form_ms=300))
    assert got == [("requested", "fast_fill")] * 10
