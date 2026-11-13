"""Egenkontrol follows the VENUE's zone, not the owner's browser (release
2026-11-15, merge review M1) — and I dag holds its "Kræver dig" row (S3).

WHY THIS EXISTS. The browser writes its own zone to users.timezone at every
login (useAuth.syncTimezoneIfChanged). Since 12 Nov the business day reads the
VENUE's zone (tz_utils.owner_tz_name: a DKK owner is Europe/Copenhagen,
whatever is stored — see test_venue_timezone). Egenkontrol was written before
that rule and read the raw column, so an owner who logged in from Kathmandu
would have written the kitchen's readings on the wrong business day, with the
wrong late flag, into append-only rows (088) that print in the Kontrolmappe —
and its "Kræver dig" finding would have named another day than I dag.

Locks under test:
  - zone_and_cutoff: a DKK owner with Asia/Katmandu / UTC / America/Los_Angeles
    stored gets Europe/Copenhagen (the one helper every Egenkontrol module —
    records, week, files, PDF, kitchen iPad, the finding — reads);
  - save_entry: business_date, slot_due_at and late follow Copenhagen at 01:30
    Copenhagen (= 06:15 in Kathmandu, which is already the NEXT business day
    there);
  - /api/egenkontrol/today, the egenkontrol_due finding's meta.date and
    /api/today's business_day are the same day;
  - /api/today?part=badges carries the finding's own count + deviations (S3),
    0 for a venue without checks.

Run: cd backend && python3 -m pytest tests/test_egenkontrol_venue_timezone.py -q
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.models.food_check import FoodCheckEntry
from app.services import egenkontrol_service as S
from app.services import tz_utils
from tests._ek_support import T0, env  # noqa: F401 — fixture

CPH = ZoneInfo("Europe/Copenhagen")
ABROAD = ["Asia/Katmandu", "UTC", "America/Los_Angeles"]

# Friday 13 Nov 2026 00:30Z = 01:30 Copenhagen (before the 06:00 cutoff: still
# Thursday the 12th's service) = 06:15 Kathmandu (past ITS cutoff: the 13th).
NIGHT = datetime(2026, 11, 13, 0, 30)


@pytest.fixture(autouse=True)
def _reset_today_limiter():
    from app.routers import today as today_router
    today_router._limiter.reset()
    yield
    today_router._limiter.reset()


def _freeze_tz_utils(monkeypatch, naive_utc: datetime) -> None:
    """Pin datetime.now(tz) inside tz_utils (/api/today's clock) to the same
    instant as the Egenkontrol clock (same trick as test_venue_timezone)."""
    when = naive_utc.replace(tzinfo=timezone.utc)
    real_dt = datetime

    class _Frozen(real_dt):
        @classmethod
        def now(cls, tz=None):
            return when.astimezone(tz) if tz is not None else when.astimezone(None)

    monkeypatch.setattr(tz_utils, "datetime", _Frozen)


def _needs_you(env, owner) -> list:
    r = env.client.get("/api/diagnostics/needs-you", headers=env.h(owner))
    assert r.status_code == 200, r.text
    return r.json()["findings"]


def _ek_finding(env, owner):
    return next((f for f in _needs_you(env, owner) if f["code"] == "egenkontrol_due"), None)


@pytest.mark.parametrize("tz", ABROAD)
def test_the_zone_is_the_venue_zone_not_the_browser_zone(env, tz):
    o = env.owner(tz=tz)
    db = env.SL()
    try:
        u = db.merge(o)
        zone, cutoff, name = S.zone_and_cutoff(db, u)
    finally:
        db.close()
    assert name == "Europe/Copenhagen"
    assert zone == CPH
    assert cutoff == 6


def test_the_cutoff_query_is_kept(env):
    o = env.owner(tz="Asia/Katmandu", cutoff=4)
    db = env.SL()
    try:
        _, cutoff, name = S.zone_and_cutoff(db, db.merge(o))
    finally:
        db.close()
    assert (cutoff, name) == (4, "Europe/Copenhagen")


def test_a_reading_from_kathmandu_lands_on_the_copenhagen_business_day(env):
    o = env.owner(tz="Asia/Katmandu")
    fridge = env.setup(o)["fridge"]["id"]           # 07:30 Copenhagen on the 12th
    env.clock.set(NIGHT)                             # 01:30 Copenhagen / 06:15 Kathmandu
    r = env.save(o, fridge, 3.4)
    assert r.status_code == 201, r.text
    e = r.json()
    # Copenhagen: still Thursday's service, its 08:00 fridge slot long past.
    assert e["business_date"] == "2026-11-12"
    assert e["slot_due_at"] == "2026-11-12T07:00:00Z"      # 08:00 Copenhagen
    assert e["slot_due_local"] == "08:00"
    assert e["late"] is True
    assert e["recorded_local"] == "01:30"
    # The append-only row itself (what the Kontrolmappe prints).
    env.db.expire_all()
    row = env.db.query(FoodCheckEntry).filter(FoodCheckEntry.client_id == e["client_id"]).one()
    assert row.business_date.isoformat() == "2026-11-12"
    assert bool(row.late) is True
    # The test bites: the stored browser zone says another day.
    ktm_day = S.R.business_date_of(NIGHT, ZoneInfo("Asia/Katmandu"), 6)
    assert ktm_day.isoformat() == "2026-11-13"


def test_the_kitchen_today_and_the_finding_name_i_dags_business_day(env, monkeypatch):
    o = env.owner(tz="Asia/Katmandu")
    env.setup(o)
    env.clock.set(NIGHT)
    _freeze_tz_utils(monkeypatch, NIGHT)

    t = env.today_json(o)
    assert t["timezone"] == "Europe/Copenhagen"
    assert t["business_date"] == "2026-11-12"

    today = env.client.get("/api/today", headers=env.h(o))
    assert today.status_code == 200, today.text
    business_day = today.json()["business_day"]
    assert business_day == "2026-11-12"

    f = _ek_finding(env, o)
    assert f is not None
    # The Skjul key (needsYouRenderers.keyFor) and I dag agree on the day.
    assert f["meta"]["date"] == business_day == t["business_date"]


# ── S3: /api/today's badges carry the finding's own counts ──────────────


def test_badges_carry_the_egenkontrol_finding_counts(env, monkeypatch):
    o = env.owner()
    checks = env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))           # 09:30: fridge + freezer overdue
    _freeze_tz_utils(monkeypatch, T0 + timedelta(hours=2))

    f = _ek_finding(env, o)
    body = env.client.get("/api/today", params={"part": "badges"}, headers=env.h(o)).json()
    assert body["business_day"] == f["meta"]["date"] == "2026-11-12"
    assert body["badges"]["egenkontrol"] == f["meta"]["count"] == 2
    assert body["badges"]["egenkontrol_deviations"] == f["meta"]["deviations"] == 0

    # An open deviation: the finding turns urgent, the badges say so too.
    r = env.save(o, checks["fridge"]["id"], 7.1,
                 action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    assert r.status_code == 201, r.text
    f = _ek_finding(env, o)
    assert f["severity"] == "urgent"
    b = env.client.get("/api/today", params={"part": "badges"}, headers=env.h(o)).json()["badges"]
    assert b["egenkontrol"] == f["meta"]["count"]
    assert b["egenkontrol_deviations"] == f["meta"]["deviations"] == 1
    # The full page carries the same badges (expectedLateRows reads them there).
    full = env.client.get("/api/today", headers=env.h(o)).json()
    assert full["badges"]["egenkontrol"] == b["egenkontrol"]
    assert full["badges"]["egenkontrol_deviations"] == 1


def test_no_checks_no_egenkontrol_badge(env, monkeypatch):
    o = env.owner()
    env.clock.set(T0 + timedelta(hours=2))
    _freeze_tz_utils(monkeypatch, T0 + timedelta(hours=2))
    b = env.client.get("/api/today", params={"part": "badges"}, headers=env.h(o)).json()["badges"]
    assert b["egenkontrol"] == 0 and b["egenkontrol_deviations"] == 0
    assert _ek_finding(env, o) is None


def test_nothing_due_yet_is_zero(env, monkeypatch):
    o = env.owner()
    env.setup(o)                                     # 07:30, fridge due 08:00
    _freeze_tz_utils(monkeypatch, T0)
    b = env.client.get("/api/today", params={"part": "badges"}, headers=env.h(o)).json()["badges"]
    assert b["egenkontrol"] == 0
    assert _ek_finding(env, o) is None
