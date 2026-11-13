"""I dag's badge part and Egenkontrol (release 2026-11-15).

GET /api/today?part=badges runs on every rail poll (5 min) and after every
write. Its Egenkontrol count is the needs-you finding's (egenkontrol_due), and
that finding used to build the whole Egenkontrol page to get two numbers
(build_today: zone, checks, revisions, readings, photos, settings, plus an
active-check count first). Measured here, the whole request warm:

    before   7 statements without checks, 13 with Egenkontrol on
    after    7 without checks,             8 with Egenkontrol on

(ek.due_counts: the checks and their revisions in one statement, the
readings in one more, the cutoff from the profile row the route already read.)

Two things are pinned:
  1. the statement count of the badge part (≤ 8 with Egenkontrol on);
  2. the badge says what the finding says, and both say what the Egenkontrol
     page says (build_today's summary) — through a day: nothing due, overdue,
     a deviation open, handled, a follow-up, another day, a non-default cutoff.
"""
from datetime import timedelta

from sqlalchemy import event

from app.models.business_profile import BusinessProfile
from app.services import diagnostics_service as ds
from app.services import egenkontrol_service as S
from tests._ek_support import T0, env  # noqa: F401 — fixture

BADGES_BUDGET = 8          # measured 13 Nov 2026: 8 (13 before ek.due_counts)
BADGES_NO_CHECKS = 7       # unchanged: one query says "no active check"


def _statements(env, fn):
    seen = []

    def _on(conn, cursor, statement, params, context, executemany):
        seen.append(statement.split("\n")[0][:120])

    event.listen(env.engine, "before_cursor_execute", _on)
    try:
        out = fn()
    finally:
        event.remove(env.engine, "before_cursor_execute", _on)
    return seen, out


def _badges(env, owner):
    r = env.client.get("/api/today", params={"part": "badges"}, headers=env.h(owner))
    assert r.status_code == 200, r.text
    return r.json()["badges"]


def _finding(env, owner):
    db = env.SL()
    try:
        u = db.merge(owner)
        return next((f for f in ds.run_diagnostics(db, u) if f["code"] == "egenkontrol_due"), None)
    finally:
        db.close()


def _page_summary(env, owner):
    db = env.SL()
    try:
        return S.build_today(db, db.merge(owner))["summary"]
    finally:
        db.close()


def _agree(env, owner, label):
    """Badge == finding == page, and returns the badge."""
    b = _badges(env, owner)
    f = _finding(env, owner)
    page = _page_summary(env, owner)
    meta = (f or {}).get("meta") or {}
    assert b["egenkontrol"] == int(meta.get("count") or 0), (label, b, f)
    assert b["egenkontrol_deviations"] == int(meta.get("deviations") or 0), (label, b, f)
    assert b["egenkontrol"] == page["missing"] + page["open_deviations"], (label, b, page)
    assert b["egenkontrol_deviations"] == page["open_deviations"], (label, b, page)
    if f is not None:
        assert meta["missing"] == page["missing"], (label, f, page)
    return b


# ── 1. the statement count ──────────────────────────────────────────────

def test_badge_part_statement_count_without_checks(env):
    o = env.owner()
    _badges(env, o)                      # warm: the first request stamps last_seen
    seen, _ = _statements(env, lambda: _badges(env, o))
    assert len(seen) <= BADGES_NO_CHECKS, seen


def test_badge_part_statement_count_with_egenkontrol_on(env):
    o = env.owner()
    checks = env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))            # 09:30: fridge + freezer overdue
    r = env.save(o, checks["fridge"]["id"], 7.1, action_code="thermostat_adjusted",
                 fate_code="awaiting_recheck")
    assert r.status_code == 201, r.text
    env.save(o, checks["receiving"]["id"], 4.0, product_type="chilled")
    _badges(env, o)
    seen, b = _statements(env, lambda: _badges(env, o))
    assert b["egenkontrol"] == 2 and b["egenkontrol_deviations"] == 1, b
    assert len(seen) <= BADGES_BUDGET, seen
    # The Egenkontrol part itself: the checks (with their revisions) and the
    # readings — never photos, settings or a second check query.
    ek = [s for s in seen if "food_check" in s]
    assert len(ek) == 2, ek
    assert not [s for s in seen if "food_check_photos" in s or "food_check_settings" in s], seen


def test_the_finding_itself_got_cheaper_too(env):
    """needs-you (no profile handed in) pays one more for the cutoff: 3, was 7."""
    o = env.owner()
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))
    db = env.SL()
    try:
        u = db.merge(o)
        u.business_name  # noqa: B018 — load the row before counting
        seen, f = _statements(env, lambda: ds._detect_egenkontrol_due(db, u, None))
    finally:
        db.close()
    assert f["meta"]["count"] == 2
    assert len(seen) <= 3, seen


# ── 2. the badge says what the finding and the page say ─────────────────

def test_badge_equals_the_finding_through_a_day(env):
    o = env.owner()
    b = _agree(env, o, "no checks")
    assert b["egenkontrol"] == 0 and b["egenkontrol_deviations"] == 0
    checks = env.setup(o)
    fridge, freezer = checks["fridge"]["id"], checks["freezer"]["id"]

    assert _agree(env, o, "07:30 nothing due")["egenkontrol"] == 0

    env.clock.set(T0 + timedelta(hours=2))                       # 09:30
    assert _agree(env, o, "overdue")["egenkontrol"] == 2

    r = env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    assert r.status_code == 201, r.text
    b = _agree(env, o, "deviation open")
    assert b["egenkontrol"] == 2 and b["egenkontrol_deviations"] == 1

    env.save(o, freezer, -19.4)
    assert _agree(env, o, "freezer read")["egenkontrol"] == 1

    env.clock.tick(minutes=35)                                   # the re-check
    r = env.save(o, fridge, 4.0, fate_code="moved")
    assert r.status_code == 201, r.text
    b = _agree(env, o, "follow-up closes it")
    assert b["egenkontrol_deviations"] == 0

    env.clock.set(T0 + timedelta(hours=6))                       # 13:30, hot holding
    _agree(env, o, "afternoon")

    env.clock.set(T0 + timedelta(days=1, hours=3))               # tomorrow 10:30
    _agree(env, o, "next day")


def test_an_open_deviation_from_yesterday_still_counts(env):
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(T0 + timedelta(hours=2))
    env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="awaiting_recheck")
    env.clock.set(T0 + timedelta(days=2, hours=1))
    b = _agree(env, o, "two days on")
    assert b["egenkontrol_deviations"] == 1


def test_badge_follows_the_venues_cutoff(env):
    """A 04:00 cutoff (the profile row the route reads, handed to due_counts)
    gives the same business day and counts as the page."""
    o = env.owner(cutoff=4)
    env.setup(o)
    for hours in (-2, 0, 2, 20, 22):                              # 05:30 … next 05:30
        env.clock.set(T0 + timedelta(hours=hours))
        _agree(env, o, f"cutoff 4, +{hours}h")


def test_an_owner_without_a_profile_row(env):
    o = env.owner()
    env.db.query(BusinessProfile).filter(BusinessProfile.user_id == o.id).delete()
    env.db.commit()
    env.setup(o)
    env.clock.set(T0 + timedelta(hours=2))
    assert _agree(env, o, "no profile")["egenkontrol"] == 2


def test_another_owners_profile_is_never_used_for_the_cutoff(env):
    a = env.owner(cutoff=4)
    b = env.owner()
    db = env.SL()
    try:
        prof_a = db.query(BusinessProfile).filter(BusinessProfile.user_id == a.id).one()
        _, cutoff, _ = S.zone_and_cutoff(db, db.merge(b), profile=prof_a)
    finally:
        db.close()
    assert cutoff == 6
