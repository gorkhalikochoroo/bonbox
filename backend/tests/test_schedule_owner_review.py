"""Vagtplan review round — the schedule findings that were wrong on the server.

  A. Editing a PUBLISHED shift without naming a status keeps it published.
     The PUT bound ScheduleCreate (status defaults to "draft") and the edit
     sheet sent no status, so a note or time change pulled the shift off the
     staffer's portal — while the time change still mailed them about it.
  B. 11-timersreglen is "11 CONSECUTIVE hours of rest in each 24-hour
     period", not "11 hours between two shifts". A legal split day
     (11–15 + 17–22) must not warn; a close followed by an open must.
  C. Copy-week refuses to double-book: a different shift already in the
     target cell blocks the copy, and the response says how many and whose.
  D. The autopilot plans from daily closes (through the revenue resolver),
     returns codes + numbers instead of English sentences, and never stacks
     a proposal on a published shift.
  E. A staffer with no wage is never priced at the 150 kr/t ranking default:
     cost is null and the payload names who is missing a wage.

Run: cd backend && pytest tests/test_schedule_owner_review.py -q
"""
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User
from app.routers import staff as staff_router
from app.routers.staff import _daily_rest_shortfalls
from app.services.auth import get_current_user, hash_password

_db_ready.set()

MONDAY = date(2026, 6, 1)  # a Monday


# ─── Fixtures ─────────────────────────────────────────────────────────


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


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    from app.routers import staff_portal as portal_router

    for mod in (staff_router, portal_router):
        lim = getattr(mod, "_limiter", None) or getattr(mod, "limiter", None)
        if lim is not None:
            lim.reset()
    yield
    for mod in (staff_router, portal_router):
        lim = getattr(mod, "_limiter", None) or getattr(mod, "limiter", None)
        if lim is not None:
            lim.reset()


@pytest.fixture(autouse=True)
def notified(monkeypatch, engine_and_session):
    """Record the per-shift notifications update_schedule hands to
    BackgroundTasks (TestClient runs them after the response), and keep the
    background task off the app's real database. Same signature as the real
    send_single_shift_notification, lang included — a narrower stub would
    raise inside the background task and read as "nothing was sent"."""
    calls: list[dict] = []

    def _fake(bg_db, user_id, staff_id, change, kind, lang="en"):
        calls.append({"staff_id": str(staff_id), "change": change.change_type,
                      "kind": kind, "new_start": change.new_start})

    def _fake_week(bg_db, user_id, changes, week_label, lang="en", week_start=None):
        calls.append({"week": week_label, "changed": sorted(changes)})

    monkeypatch.setattr(staff_router, "send_single_shift_notification", _fake)
    monkeypatch.setattr(staff_router, "send_shift_notifications", _fake_week)
    _, SessionLocal = engine_and_session
    monkeypatch.setattr(staff_router, "SessionLocal", SessionLocal)
    return calls


@pytest.fixture(autouse=True)
def _no_weather(monkeypatch):
    # The autopilot asks Open-Meteo; tests stay offline and deterministic.
    monkeypatch.setattr(
        "app.services.schedule_autopilot._fetch_forecast",
        lambda user, week_start: {},
    )


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


def _as(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, suffix="", *, plan="pro", business_type="cafe") -> User:
    u = User(
        email=f"owner{suffix}@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bistro{suffix}", business_type=business_type,
        currency="DKK", plan=plan, role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, *, name="Anna", rate=180.0, max_week=None) -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name=name, role="server",
        active=True, is_deleted=False, email=f"{name.lower()}@ex.dk",
        base_rate=Decimal(str(rate)) if rate is not None else None,
        max_hours_week=Decimal(str(max_week)) if max_week is not None else None,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _shift(db, owner, staff, on, start, end, *, status="published", brk=0) -> Schedule:
    sh = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id, date=on,
        start_time=start, end_time=end, break_minutes=brk,
        role_on_shift="Server", status=status,
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


def _body(staff, on, start, end, **extra):
    b = {
        "staff_id": str(staff.id), "date": on.isoformat(),
        "start_time": start, "end_time": end, "break_minutes": 0,
        "role_on_shift": "Server",
    }
    b.update(extra)
    return b


def _next_monday() -> date:
    today = date.today()
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)


# ═══ A. An edit keeps the shift's status ══════════════════════════════


def test_editing_a_published_shift_without_status_keeps_it_published(client, db, notified):
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    sh = _shift(db, owner, anna, day, "16:00", "22:00", status="published")
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=anna.id,
                     token="tok-anna-keep", active=True))
    db.commit()
    _as(owner)

    # Exactly what the edit sheet sends: new time + a note, NO status.
    res = client.put(f"/api/staff/schedules/{sh.id}",
                     json=_body(anna, day, "17:00", "23:00", notes="Har nøglen"))
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "published"

    db.expire_all()
    row = db.query(Schedule).filter(Schedule.id == sh.id).first()
    assert row.status == "published"
    assert (row.start_time, row.end_time, row.notes) == ("17:00", "23:00", "Har nøglen")

    # Still on the staffer's phone — with the new time.
    portal = client.get("/api/portal/tok-anna-keep/schedule")
    assert portal.status_code == 200, portal.text
    mine = [s for s in portal.json()["shifts"] if s["id"] == str(sh.id)]
    assert mine and (mine[0]["start_time"], mine[0]["end_time"]) == ("17:00", "23:00")

    # And the message they get is about a shift they can actually see.
    assert [c["change"] for c in notified] == ["modified"]
    assert notified[0]["staff_id"] == str(anna.id)


def test_a_note_only_edit_of_a_published_shift_tells_nobody(client, db, notified):
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=3)
    sh = _shift(db, owner, anna, day, "10:00", "16:00", status="published")
    _as(owner)
    res = client.put(f"/api/staff/schedules/{sh.id}",
                     json=_body(anna, day, "10:00", "16:00", notes="Kasse 2"))
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "published"
    assert notified == []


def test_editing_a_draft_without_status_keeps_it_a_draft(client, db, notified):
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    sh = _shift(db, owner, anna, day, "16:00", "22:00", status="draft")
    _as(owner)
    res = client.put(f"/api/staff/schedules/{sh.id}", json=_body(anna, day, "15:00", "22:00"))
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "draft"
    assert notified == []  # drafts never notify


def test_a_named_status_is_still_honoured(client, db):
    # Drag-to-move and its undo send the shift's own status; that must keep
    # working exactly as before.
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    sh = _shift(db, owner, anna, day, "16:00", "22:00", status="draft")
    _as(owner)
    res = client.put(f"/api/staff/schedules/{sh.id}",
                     json=_body(anna, day, "16:00", "22:00", status="published"))
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "published"


def test_an_unknown_status_is_refused_not_stored(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    sh = _shift(db, owner, anna, day, "16:00", "22:00", status="published")
    _as(owner)
    res = client.put(f"/api/staff/schedules/{sh.id}",
                     json=_body(anna, day, "16:00", "22:00", status="whatever"))
    assert res.status_code == 422, res.text
    db.expire_all()
    assert db.query(Schedule).filter(Schedule.id == sh.id).first().status == "published"


def test_the_overlap_refusal_names_the_person_and_the_shift_they_have(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    _shift(db, owner, anna, day, "16:00", "22:00")
    _as(owner)
    res = client.post("/api/staff/schedules", json=_body(anna, day, "18:00", "23:00"))
    assert res.status_code == 409, res.text
    d = res.json()["detail"]
    assert d["code"] == "shift_overlap"
    assert d["staff_name"] == "Anna"
    assert (d["existing_start"], d["existing_end"]) == ("16:00", "22:00")


# ═══ B. 11-timersreglen ═══════════════════════════════════════════════


def _span(day: date, start: str, end: str):
    sh, sm = (int(x) for x in start.split(":"))
    eh, em = (int(x) for x in end.split(":"))
    s = datetime(day.year, day.month, day.day, sh, sm)
    e = datetime(day.year, day.month, day.day, eh, em)
    if e < s:
        e += timedelta(days=1)
    return (s, e, day)


def test_a_split_day_is_legal():
    mon, tue = MONDAY, MONDAY + timedelta(days=1)
    spans = [_span(mon, "11:00", "15:00"), _span(mon, "17:00", "22:00"),
             _span(tue, "11:00", "15:00"), _span(tue, "17:00", "22:00")]
    # 22:00 → 11:00 is 13 hours of rest inside every 24-hour period.
    assert _daily_rest_shortfalls(spans, 11.0) == []


def test_closing_at_22_and_opening_at_06_is_flagged():
    mon, tue = MONDAY, MONDAY + timedelta(days=1)
    out = _daily_rest_shortfalls(
        [_span(mon, "14:00", "22:00"), _span(tue, "06:00", "14:00")], 11.0)
    assert len(out) == 1
    assert out[0]["start_date"] == mon
    assert out[0]["rest_hours"] == pytest.approx(8.0)


def test_one_fifteen_hour_day_cannot_hold_eleven_hours_of_rest():
    out = _daily_rest_shortfalls([_span(MONDAY, "08:00", "23:00")], 11.0)
    assert len(out) == 1 and out[0]["rest_hours"] == pytest.approx(9.0)


def test_a_normal_week_of_day_shifts_is_clean():
    spans = [_span(MONDAY + timedelta(days=i), "09:00", "17:00") for i in range(5)]
    assert _daily_rest_shortfalls(spans, 11.0) == []


def test_week_load_does_not_warn_on_a_split_day(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    tue = MONDAY + timedelta(days=1)
    _shift(db, owner, anna, MONDAY, "11:00", "15:00")
    _shift(db, owner, anna, MONDAY, "17:00", "22:00")
    _shift(db, owner, anna, tue, "11:00", "15:00")
    _as(owner)
    res = client.get(f"/api/staff/schedules/week-load?week_start={MONDAY.isoformat()}")
    assert res.status_code == 200, res.text
    row = next(s for s in res.json()["staff"] if s["name"] == "Anna")
    # The old pairwise check said "kun 2 t hvile" here.
    assert row["rest_warnings"] == []


def test_week_load_flags_22_to_06(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    tue = MONDAY + timedelta(days=1)
    _shift(db, owner, anna, MONDAY, "14:00", "22:00")
    _shift(db, owner, anna, tue, "06:00", "14:00")
    _as(owner)
    res = client.get(f"/api/staff/schedules/week-load?week_start={MONDAY.isoformat()}")
    row = next(s for s in res.json()["staff"] if s["name"] == "Anna")
    assert len(row["rest_warnings"]) == 1
    w = row["rest_warnings"][0]
    assert w["prev_date"] == MONDAY.isoformat()
    assert w["next_date"] == tue.isoformat()
    assert w["gap_hours"] == pytest.approx(8.0)
    assert w["rest_hours"] == pytest.approx(8.0)
    assert w["window_start"] == f"{MONDAY.isoformat()}T14:00"


def test_week_load_catches_sunday_night_into_monday_morning(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    sunday_before = MONDAY - timedelta(days=1)
    _shift(db, owner, anna, sunday_before, "16:00", "23:00")
    _shift(db, owner, anna, MONDAY, "07:00", "15:00")
    _as(owner)
    res = client.get(f"/api/staff/schedules/week-load?week_start={MONDAY.isoformat()}")
    row = next(s for s in res.json()["staff"] if s["name"] == "Anna")
    assert len(row["rest_warnings"]) == 1
    assert row["rest_warnings"][0]["gap_hours"] == pytest.approx(8.0)


# ═══ C. Copy-week never double-books ══════════════════════════════════


def test_copy_week_skips_a_shift_that_would_overlap_and_says_whose(client, db):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    bo = _staff(db, owner, name="Bo")
    src = MONDAY
    dst = MONDAY + timedelta(days=7)
    # Last week: Anna Friday 17–22, Bo Saturday 10–16.
    _shift(db, owner, anna, src + timedelta(days=4), "17:00", "22:00")
    _shift(db, owner, bo, src + timedelta(days=5), "10:00", "16:00")
    # This week the owner already moved Anna's Friday to 18–23.
    _shift(db, owner, anna, dst + timedelta(days=4), "18:00", "23:00", status="draft")
    _as(owner)

    res = client.post("/api/staff/schedules/copy-week",
                      json={"source_week": src.isoformat(), "target_week": dst.isoformat()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["copied"] == 1          # Bo's Saturday
    assert body["skipped_overlap"] == 1  # Anna's Friday would have doubled her
    assert body["skipped_overlap_names"] == ["Anna"]

    fri = db.query(Schedule).filter(
        Schedule.staff_id == anna.id, Schedule.date == dst + timedelta(days=4)).all()
    assert [(s.start_time, s.end_time) for s in fri] == [("18:00", "23:00")]


def test_copy_week_still_counts_an_exact_duplicate_as_already_there(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    src, dst = MONDAY, MONDAY + timedelta(days=7)
    _shift(db, owner, anna, src, "10:00", "16:00")
    _as(owner)
    first = client.post("/api/staff/schedules/copy-week",
                        json={"source_week": src.isoformat(), "target_week": dst.isoformat()})
    assert first.json()["copied"] == 1
    again = client.post("/api/staff/schedules/copy-week",
                        json={"source_week": src.isoformat(), "target_week": dst.isoformat()})
    assert again.json()["copied"] == 0
    assert again.json()["skipped"] == 1
    assert again.json()["skipped_overlap"] == 0


def test_copy_week_keeps_a_legal_split_day(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    src, dst = MONDAY, MONDAY + timedelta(days=7)
    _shift(db, owner, anna, src, "11:00", "15:00")
    _shift(db, owner, anna, src, "17:00", "22:00")
    _as(owner)
    res = client.post("/api/staff/schedules/copy-week",
                      json={"source_week": src.isoformat(), "target_week": dst.isoformat()})
    assert res.json()["copied"] == 2
    assert res.json()["skipped_overlap"] == 0


# ═══ D. Autopilot plans from daily closes ═════════════════════════════


def _close(db, owner, d, revenue, *, status="confirmed"):
    db.add(DailyClose(
        id=uuid.uuid4(), user_id=owner.id, date=d,
        revenue_total=Decimal(str(revenue)), status=status, is_deleted=False,
    ))
    db.commit()


def test_autopilot_reads_daily_closes_when_there_are_no_sales(client, db):
    owner = _owner(db, business_type="restaurant")
    _staff(db, owner, name="Marie", rate=180.0)
    _staff(db, owner, name="Jonas", rate=160.0)
    target = _next_monday()
    for w in range(1, 9):
        for dow in range(7):
            _close(db, owner, target - timedelta(weeks=w) + timedelta(days=dow), 9000.0)
    _as(owner)

    res = client.post("/api/staff/schedules/autopilot", json={"week_start": target.isoformat()})
    assert res.status_code == 200, res.text
    body = res.json()
    # It used to see eight weeks of 0 kr. and propose nothing at all.
    assert body["confidence"] == "high"
    assert all(d["predicted_revenue"] == pytest.approx(9000.0) for d in body["days"])
    assert sum(len(d["shifts"]) for d in body["days"]) > 0
    assert body["basis"]["signal"] == "revenue"

    fc = client.get(f"/api/staff/schedules/forecast?week_start={target.isoformat()}")
    assert fc.status_code == 200, fc.text
    assert all(d["predicted_demand_hours"] > 0 for d in fc.json()["days"])


def test_a_draft_close_is_not_revenue(client, db):
    owner = _owner(db, business_type="restaurant")
    _staff(db, owner, name="Marie", rate=180.0)
    target = _next_monday()
    for w in range(1, 9):
        _close(db, owner, target - timedelta(weeks=w), 9000.0, status="draft")
    _as(owner)
    body = client.post("/api/staff/schedules/autopilot",
                       json={"week_start": target.isoformat()}).json()
    assert all(d["shifts"] == [] for d in body["days"])
    assert body["basis"]["avg_weekday_samples"] == 0


def test_autopilot_speaks_in_codes_and_numbers(client, db):
    owner = _owner(db, business_type="restaurant")
    _staff(db, owner, name="PartTime", rate=150.0, max_week=10.0)
    target = _next_monday()
    for w in range(1, 9):
        for dow in range(7):
            _close(db, owner, target - timedelta(weeks=w) + timedelta(days=dow), 8000.0)
    # A cheap last week, so the comparison has something to say.
    pt = db.query(StaffMember).filter(StaffMember.name == "PartTime").first()
    _shift(db, owner, pt, target - timedelta(days=7), "11:00", "13:00", status="published")
    _as(owner)

    body = client.post("/api/staff/schedules/autopilot",
                       json={"week_start": target.isoformat()}).json()
    assert body["warnings"], "heavy demand on a 10-hour contract must warn"
    for w in body["warnings"]:
        assert w["code"] in ("unfilled", "over_weekly_cap")
        if w["code"] == "unfilled":
            assert isinstance(w["hours_short"], (int, float)) and w["shift"] in ("lunch", "dinner")
            date.fromisoformat(w["date"])
    cmp_ = body["compared_to_last_week"]
    assert cmp_["direction"] in ("saves", "costs_more", "same")
    assert isinstance(cmp_["delta_kr"], (int, float))


def test_applying_never_stacks_a_proposal_on_a_published_shift(client, db):
    owner = _owner(db, business_type="restaurant")
    marie = _staff(db, owner, name="Marie")
    target = _next_monday()
    _shift(db, owner, marie, target, "17:00", "22:00", status="published")
    _as(owner)
    res = client.post("/api/staff/schedules/autopilot/apply", json={
        "week_start": target.isoformat(),
        "shifts": [
            {"date": target.isoformat(), "staff_id": str(marie.id), "start": "17:00", "end": "22:00"},
            {"date": target.isoformat(), "staff_id": str(marie.id), "start": "11:00", "end": "15:00"},
        ],
    })
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 1
    assert res.json()["skipped_overlap"] == 1
    rows = db.query(Schedule).filter(Schedule.staff_id == marie.id, Schedule.date == target).all()
    assert sorted((r.start_time, r.status) for r in rows) == [
        ("11:00", "draft"), ("17:00", "published")]


# ═══ E. No wage, no invented kroner ═══════════════════════════════════


def test_week_cost_is_unknown_not_invented_when_a_wage_is_missing(client, db):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", rate=200.0)
    bo = _staff(db, owner, name="Bo", rate=None)
    tue = MONDAY + timedelta(days=1)
    _shift(db, owner, anna, MONDAY, "10:00", "15:00")   # 5 h × 200
    _shift(db, owner, bo, tue, "10:00", "16:00")        # 6 h, no wage
    _as(owner)

    res = client.get(f"/api/staff/schedules/week-cost?week_start={MONDAY.isoformat()}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["missing_wage"] == [{"staff_id": str(bo.id), "name": "Bo"}]
    # Hours are still facts.
    assert body["week"]["hours"] == pytest.approx(11.0)
    # The week and Bo's day are unknown — not 6 × 150 = 900 kr. in disguise.
    assert body["week"]["cost_gross"] is None
    assert body["week"]["cost_loaded"] is None
    daily = {d["date"]: d for d in body["daily"]}
    assert daily[tue.isoformat()]["cost_gross"] is None
    # Anna's day is priced from her own wage.
    assert daily[MONDAY.isoformat()]["cost_gross"] == pytest.approx(1000.0)
    per_staff = {p["name"]: p for p in body["per_staff"]}
    assert per_staff["Bo"]["cost_gross"] is None
    assert per_staff["Anna"]["cost_gross"] == pytest.approx(1000.0)


def test_week_cost_with_every_wage_set_is_unchanged(client, db):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", rate=200.0)
    _shift(db, owner, anna, MONDAY, "10:00", "15:00")
    _as(owner)
    body = client.get(f"/api/staff/schedules/week-cost?week_start={MONDAY.isoformat()}").json()
    assert body["missing_wage"] == []
    assert body["week"]["cost_gross"] == pytest.approx(1000.0)
    assert body["week"]["cost_loaded"] == pytest.approx(1125.0)


def test_a_premium_alone_is_a_wage(client, db):
    owner = _owner(db)
    eve = _staff(db, owner, name="Eve", rate=None)
    eve.evening_rate = Decimal("210")
    db.commit()
    _shift(db, owner, eve, MONDAY, "10:00", "14:00")
    _as(owner)
    body = client.get(f"/api/staff/schedules/week-cost?week_start={MONDAY.isoformat()}").json()
    assert body["missing_wage"] == []
    assert body["week"]["cost_gross"] == pytest.approx(840.0)


def test_publish_names_who_was_not_emailed(client, db):
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    bo = _staff(db, owner, name="Bo")
    bo.email = None
    db.commit()
    _shift(db, owner, anna, MONDAY, "10:00", "16:00", status="draft")
    _shift(db, owner, bo, MONDAY + timedelta(days=1), "10:00", "16:00", status="draft")
    _as(owner)
    res = client.post(f"/api/staff/schedules/publish?week_start={MONDAY.isoformat()}&lang=da")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["notify_count"] == 1
    assert body["skipped_no_email_names"] == ["Bo"]


def test_emailing_the_week_names_who_has_no_address(client, db, monkeypatch):
    import app.services.email_service as email_service

    sent_to = []
    monkeypatch.setattr(
        email_service, "send_email_with_attachment",
        lambda addr, *a, **k: (sent_to.append(addr) or True, None),
    )
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    cy = _staff(db, owner, name="Cy")
    cy.email = ""
    db.commit()
    _shift(db, owner, anna, MONDAY, "10:00", "16:00", status="published")
    _as(owner)
    res = client.post("/api/staff/schedules/email",
                      json={"week_start": MONDAY.isoformat(), "lang": "da", "cc_self": False})
    assert res.status_code == 200, res.text
    assert res.json()["sent"] == 1
    assert res.json()["skipped_names"] == ["Cy"]


def test_sharing_links_names_who_has_no_address(client, db, monkeypatch):
    monkeypatch.setattr(staff_router, "send_email", lambda **k: True)
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    dee = _staff(db, owner, name="Dee")
    dee.email = None
    db.commit()
    week = _next_monday()  # the route refuses a week long past
    _shift(db, owner, anna, week, "10:00", "16:00")
    _shift(db, owner, dee, week, "16:00", "22:00")
    _as(owner)
    res = client.post("/api/staff/schedules/share-with-staff",
                      json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert res.status_code == 200, res.text
    assert res.json()["emailed_count"] == 1
    assert res.json()["skipped_names"] == ["Dee"]


def test_autopilot_does_not_price_a_staffer_without_a_wage(client, db):
    owner = _owner(db, business_type="restaurant")
    _staff(db, owner, name="NoWage", rate=None)
    target = _next_monday()
    for w in range(1, 9):
        for dow in range(7):
            _close(db, owner, target - timedelta(weeks=w) + timedelta(days=dow), 9000.0)
    _as(owner)
    body = client.post("/api/staff/schedules/autopilot",
                       json={"week_start": target.isoformat()}).json()
    proposed = [s for d in body["days"] for s in d["shifts"]]
    assert proposed, "the plan itself does not need a wage"
    assert all(s["cost"] is None for s in proposed)
    assert body["week_total_cost"] is None
    assert body["missing_wage_names"] == ["NoWage"]


# ── Staff email budget: a fixed mailer must not become a mail cannon ─────

def _stub_mail(monkeypatch, sent_to):
    import app.services.email_service as email_service
    monkeypatch.setattr(
        email_service, "send_email_with_attachment",
        lambda addr, *a, **k: (sent_to.append(addr) or True, None),
    )
    monkeypatch.setattr(staff_router, "send_email", lambda **k: sent_to.append(k.get("to")) or True)


def test_the_schedule_email_stops_at_the_daily_send_cap(client, db, monkeypatch):
    sent_to = []
    _stub_mail(monkeypatch, sent_to)
    monkeypatch.setattr(staff_router, "_STAFF_EMAIL_CALLS_PER_DAY", 2)
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    _shift(db, owner, anna, MONDAY, "10:00", "16:00", status="published")
    _as(owner)
    body = {"week_start": MONDAY.isoformat(), "lang": "da", "cc_self": False}
    assert client.post("/api/staff/schedules/email", json=body).status_code == 200
    assert client.post("/api/staff/schedules/email", json=body).status_code == 200
    third = client.post("/api/staff/schedules/email", json=body)
    assert third.status_code == 429, third.text
    assert third.json()["detail"]["code"] == "staff_email_daily_cap"
    assert "døgn" in third.json()["detail"]["message"]
    assert len(sent_to) == 2  # nothing left on the refused call


def test_both_staff_mailers_share_one_recipient_budget(client, db, monkeypatch):
    sent_to = []
    _stub_mail(monkeypatch, sent_to)
    monkeypatch.setattr(staff_router, "_STAFF_EMAIL_RECIPIENTS_PER_DAY", 4)
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    bo = _staff(db, owner, name="Bo")
    cy = _staff(db, owner, name="Cy")
    week = _next_monday()
    for p in (anna, bo, cy):
        _shift(db, owner, p, week, "10:00", "16:00")
    _as(owner)
    first = client.post("/api/staff/schedules/email",
                        json={"week_start": week.isoformat(), "lang": "da", "cc_self": False})
    assert first.status_code == 200 and first.json()["sent"] == 3
    # Three more would make six — over the budget of four — on either mailer.
    again = client.post("/api/staff/schedules/email",
                        json={"week_start": week.isoformat(), "lang": "en", "cc_self": False})
    assert again.status_code == 429
    share = client.post("/api/staff/schedules/share-with-staff",
                        json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert share.status_code == 429
    assert len(sent_to) == 3


def test_the_owners_note_is_bounded(client, db, monkeypatch):
    _stub_mail(monkeypatch, [])
    owner = _owner(db)
    _staff(db, owner, name="Anna")
    _as(owner)
    r = client.post("/api/staff/schedules/email",
                    json={"week_start": MONDAY.isoformat(), "lang": "da", "message": "x" * 1001})
    assert r.status_code == 422


def test_moving_a_published_shift_to_another_day_tells_the_staffer(client, db, notified):
    """A drag from Wednesday to Thursday sent nothing — the staffer would have
    turned up on Wednesday."""
    owner = _owner(db)
    anna = _staff(db, owner)
    day = date.today() + timedelta(days=2)
    sh = _shift(db, owner, anna, day, "16:00", "22:00", status="published")
    _as(owner)
    res = client.put(f"/api/staff/schedules/{sh.id}", json=_body(anna, day + timedelta(days=1), "16:00", "22:00"))
    assert res.status_code == 200, res.text
    assert [c["change"] for c in notified] == ["removed", "added"]
    assert {c["staff_id"] for c in notified} == {str(anna.id)}


def test_emailing_a_week_with_nothing_published_is_refused(client, db, monkeypatch):
    """The PDF carries published shifts only — a draft-only week reached staff
    as an empty rota."""
    sent_to = []
    _stub_mail(monkeypatch, sent_to)
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna")
    week = _next_monday()
    _shift(db, owner, anna, week, "10:00", "16:00", status="draft")
    _as(owner)
    r = client.post("/api/staff/schedules/email",
                    json={"week_start": week.isoformat(), "lang": "da", "cc_self": False})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "no_published_shifts"
    assert sent_to == []


# ── Owner-typed names never reach staff mail as raw HTML (review, 8 Oct) ──

_EVIL = '<a href="https://evil.example">Klik</a>'


def test_share_link_mail_escapes_the_business_and_staff_names(client, db, monkeypatch):
    mails = []
    monkeypatch.setattr(staff_router, "send_email", lambda **k: mails.append(k) or True)
    owner = _owner(db)
    owner.business_name = f"Café {_EVIL}\r\nBcc: x@evil.example"
    db.commit()
    anna = _staff(db, owner, name="Anna")
    anna.name = f"{_EVIL} Hansen"
    db.commit()
    week = _next_monday()
    _shift(db, owner, anna, week, "10:00", "16:00")
    _as(owner)
    res = client.post("/api/staff/schedules/share-with-staff",
                      json={"week_start": week.isoformat()}, params={"lang": "da"})
    assert res.status_code == 200, res.text
    assert len(mails) == 1
    html, subject = mails[0]["html"], mails[0]["subject"]
    assert '<a href="https://evil.example">' not in html
    assert "&lt;a href=" in html
    assert "\r" not in subject and "\n" not in subject
    # The portal button itself is still a real link.
    assert '<a href="https://www.bonbox.dk/s/' in html


def test_schedule_pdf_mail_escapes_the_business_name(client, db, monkeypatch):
    import app.services.email_service as email_service

    mails = []
    monkeypatch.setattr(
        email_service, "send_email_with_attachment",
        lambda addr, subject, html, **k: (mails.append((subject, html)) or True, None),
    )
    owner = _owner(db)
    owner.business_name = f"Café {_EVIL}\nBcc: x@evil.example"
    db.commit()
    anna = _staff(db, owner, name="Anna")
    _shift(db, owner, anna, MONDAY, "10:00", "16:00", status="published")
    _as(owner)
    for lang in ("da", "en"):
        res = client.post("/api/staff/schedules/email",
                          json={"week_start": MONDAY.isoformat(), "lang": lang, "cc_self": False})
        assert res.status_code == 200, res.text
    assert len(mails) == 2
    for subject, html in mails:
        assert '<a href="https://evil.example">' not in html
        assert "&lt;a href=" in html
        assert "\n" not in subject and "\r" not in subject
