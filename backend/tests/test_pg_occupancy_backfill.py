"""Opt-in Postgres test for the reservation-occupancy backfill (10 Oct 2026).

SKIPPED unless the environment names a Postgres database in
BONBOX_TEST_PG_URL. Every other run of the backend suite (SQLite) skips it:
the backfill and the exclusion constraint it runs into exist on Postgres only.

What it proves. The backfill in Migration 055 (list index 398 in
app/main.py `_migrations`) was one all-or-nothing INSERT. Two bookings on one
table that overlap (production: two demo bookings on 16 Aug, 18:00–19:30 and
19:15–20:45) tripped the exclusion constraint `reservation_occupancy_no_overlap`,
the whole statement rolled back, and every boot logged "Migration 398
skipped: ExclusionViolation" with nothing backfilled. Here, through the real
startup path (Base.metadata.create_all + main._run_migrations):

  • two overlapping PAST bookings + one upcoming booking, none with an
    occupancy row → the upcoming one gets its row, the past ones get none, no
    "Migration N skipped" line; a second boot changes nothing;
  • two overlapping UPCOMING bookings → the one booked first keeps the table,
    the other is left out and named by id (no guest name) in the boot log;
  • a booking with an inverted time range does not abort the rest;
  • "ended" is judged on Copenhagen wall-clock, the frame starts_at is in;
  • the sample bookings (idempotency_key "demo-…", written without holds on
    purpose, with a planted overlap) are left alone and not reported.

How to run — ALONE, in its own pytest process (the app binds its engine when
it is first imported; inside a full-suite run this file skips itself):

    # a throwaway Postgres 16+, e.g.
    docker run -d --name bonbox-pg -e POSTGRES_PASSWORD=<pw> \\
        -p 127.0.0.1:55432:5432 postgres:16
    # a database of your own in it (CREATE DATABASE bonbox_occ), then:
    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/bonbox_occ \\
        python -m pytest -q tests/test_pg_occupancy_backfill.py

The file creates its own schema in that database (occ_<random>), builds it
through the production startup path with the background scheduler kept off,
and drops the schema at the end. Never point it at production.
"""
from __future__ import annotations

import os
import sys
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres occupancy-backfill test: set BONBOX_TEST_PG_URL "
                "(see the file header)", allow_module_level=True)
if "app.database" in sys.modules:
    pytest.skip("run tests/test_pg_occupancy_backfill.py ALONE, in its own pytest "
                "process: the app's engine is already bound to another database",
                allow_module_level=True)

import sqlalchemy as _sa  # noqa: E402
from sqlalchemy import text as _text  # noqa: E402

_SCHEMA = "occ_" + uuid.uuid4().hex[:12]
_admin = _sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
if _admin.url.get_backend_name() != "postgresql":
    pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL", allow_module_level=True)
with _admin.connect() as _c:
    _c.execute(_text(f'CREATE SCHEMA "{_SCHEMA}"'))
os.environ["DATABASE_URL"] = (
    PG_URL + ("&" if "?" in PG_URL else "?")
    + f"options=-csearch_path%3D{_SCHEMA}&application_name={_SCHEMA}"
)

# The app starts its background scheduler when app.main is imported: never here.
from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402
BackgroundScheduler.start = lambda self, *a, **k: None

from datetime import datetime, timedelta  # noqa: E402
from zoneinfo import ZoneInfo  # noqa: E402

from sqlalchemy import text  # noqa: E402

import app.main as main  # noqa: E402
from app.database import Base, engine, SessionLocal  # noqa: E402
from app.models.bookable_resource import BookableResource  # noqa: E402
from app.models.reservation import Reservation  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.auth import hash_password  # noqa: E402
from app.utils.time import utc_now  # noqa: E402

assert engine.url.get_backend_name() == "postgresql", engine.url
# Boot 1, on an empty schema: the production schema path.
Base.metadata.create_all(bind=engine)
main._run_migrations()

# The backfill's position in the list — the N in "Migration N skipped".
BACKFILL = next(
    i for i, sql in enumerate(main._migrations)
    if sql.lstrip().startswith("INSERT INTO reservation_occupancy")
)


def teardown_module(module):
    engine.dispose()
    with _admin.connect() as c:
        c.execute(text(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND application_name = :app "
            "AND pid <> pg_backend_pid()"), {"app": _SCHEMA})
        c.execute(text("SET lock_timeout = '5s'"))
        c.execute(text(f'DROP SCHEMA IF EXISTS "{_SCHEMA}" CASCADE'))
    _admin.dispose()


def _cph_now() -> datetime:
    """Naive Copenhagen wall-clock — the frame reservations are stored in."""
    return datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)


def _venue(tables: int = 1):
    s = SessionLocal()
    u = User(
        email=f"occ-{uuid.uuid4().hex[:12]}@cafe.dk", password_hash=hash_password("deleteMeNow1"),
        business_name="Occupancy Café", business_type="restaurant", currency="DKK",
        created_at=utc_now() - timedelta(days=2), email_verified=True,
    )
    s.add(u)
    s.flush()
    ids = []
    for n in range(tables):
        t = BookableResource(user_id=u.id, kind="table", label=f"Bord {n + 1}", capacity_seats=4)
        s.add(t)
        s.flush()
        ids.append(t.id)
    s.commit()
    uid = u.id
    s.close()
    return uid, ids


_order = [0]


def _booking(uid, table, start: datetime, minutes: int = 90, *, status="confirmed",
             guest="Guest", ends_at: datetime | None = None, idempotency_key: str | None = None):
    """A reservation written straight to the table — like the demo seeder and
    the pre-055 rows — so it has NO occupancy row. created_at ascends with
    each call, so the call order is the booking order."""
    _order[0] += 1
    s = SessionLocal()
    r = Reservation(
        user_id=uid, resource_id=table, guest_name=guest, party_size=2,
        starts_at=start, ends_at=ends_at or start + timedelta(minutes=minutes),
        duration_min=minutes, status=status, source="manual",
        created_at=datetime(2026, 1, 1) + timedelta(seconds=_order[0]),
        idempotency_key=idempotency_key,
    )
    s.add(r)
    s.commit()
    rid = str(r.id)
    s.close()
    return rid


def _occupancy(rid):
    with engine.connect() as c:
        return c.execute(text(
            "SELECT resource_id, starts_at, ends_at, active FROM reservation_occupancy "
            "WHERE reservation_id = :r"), {"r": rid}).all()


def _occupancy_total():
    with engine.connect() as c:
        return c.execute(text("SELECT count(*) FROM reservation_occupancy")).scalar()


def _boot(capsys):
    capsys.readouterr()
    main._run_migrations()
    return capsys.readouterr().out


def test_the_constraint_the_backfill_runs_into_is_in_place():
    """Without it every other test here would pass vacuously."""
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM pg_constraint "
            "WHERE conname = 'reservation_occupancy_no_overlap' AND contype = 'x'")).scalar()
    assert n == 1


def test_overlapping_past_bookings_no_longer_stop_an_upcoming_one_being_protected(capsys):
    uid, (table,) = _venue()
    yesterday = (_cph_now() - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    tomorrow = (_cph_now() + timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    past_a = _booking(uid, table, yesterday, status="seated", guest="Past Guest A")
    past_b = _booking(uid, table, yesterday + timedelta(minutes=75), guest="Past Guest B")  # 19:15–20:45
    upcoming = _booking(uid, table, tomorrow, guest="Upcoming Guest C")

    # The old statement on this exact data: the whole INSERT aborts.
    with engine.connect() as c:
        with pytest.raises(_sa.exc.IntegrityError, match="reservation_occupancy_no_overlap"):
            with c.begin():
                c.execute(text(
                    "INSERT INTO reservation_occupancy (id, reservation_id, resource_id, user_id, "
                    "starts_at, ends_at, active, created_at) "
                    "SELECT gen_random_uuid()::text, r.id, r.resource_id, r.user_id, r.starts_at, "
                    "r.ends_at, TRUE, CURRENT_TIMESTAMP FROM reservations r "
                    "WHERE r.user_id = :u AND r.status IN ('requested','confirmed','seated') "
                    "ORDER BY r.created_at"), {"u": str(uid)})
    assert _occupancy(upcoming) == []

    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    rows = _occupancy(upcoming)
    assert len(rows) == 1
    resource_id, starts_at, ends_at, active = rows[0]
    assert str(resource_id) == str(table)
    assert (starts_at, ends_at, active) == (tomorrow, tomorrow + timedelta(minutes=90), True)
    # Ended bookings protect nothing and get no row, and are not reported.
    assert _occupancy(past_a) == [] and _occupancy(past_b) == []
    for rid in (past_a, past_b, upcoming):
        assert rid not in out, out

    # Boot 2: nothing left to do.
    before = _occupancy_total()
    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert _occupancy_total() == before
    assert len(_occupancy(upcoming)) == 1
    for rid in (past_a, past_b, upcoming):
        assert rid not in out, out


def test_two_upcoming_bookings_on_one_table_the_first_keeps_it_the_other_is_named(capsys):
    uid, (table,) = _venue()
    day = (_cph_now() + timedelta(days=2)).replace(hour=12, minute=0, second=0, microsecond=0)
    first = _booking(uid, table, day, guest="Lunch Guest First")
    second = _booking(uid, table, day + timedelta(minutes=60), guest="Lunch Guest Second")
    clear = _booking(uid, table, day + timedelta(minutes=180), guest="Lunch Guest Later")

    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert len(_occupancy(first)) == 1
    assert _occupancy(second) == []
    assert len(_occupancy(clear)) == 1
    report = [ln for ln in out.splitlines() if "not backfilled because they overlap" in ln]
    assert len(report) == 1 and second in report[0], out
    assert first not in out and clear not in out
    # Ids only: no guest field reaches the log.
    assert "Lunch Guest" not in out, out

    # Still a double-booking on the next boot, so still said; nothing else moves.
    before = _occupancy_total()
    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert _occupancy_total() == before
    assert second in out


def test_an_inverted_time_range_does_not_abort_the_rest(capsys):
    uid, (bad_table, good_table) = _venue(tables=2)
    day = (_cph_now() + timedelta(days=3)).replace(hour=19, minute=0, second=0, microsecond=0)
    broken = _booking(uid, bad_table, day, ends_at=day - timedelta(minutes=30), guest="Broken Row")
    good = _booking(uid, good_table, day, guest="Good Row")

    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert len(_occupancy(good)) == 1
    assert _occupancy(broken) == []


def test_ended_is_judged_on_copenhagen_wall_clock(capsys):
    """starts_at/ends_at are naive Copenhagen time. A sitting that ended half
    an hour ago there is over (in UTC, an hour or two behind, it would still
    look upcoming); one ending in half an hour is still at the table."""
    uid, (t1, t2) = _venue(tables=2)
    now = _cph_now().replace(second=0, microsecond=0)
    ended = _booking(uid, t1, now - timedelta(minutes=120), ends_at=now - timedelta(minutes=30),
                     status="seated")
    running = _booking(uid, t2, now - timedelta(minutes=60), ends_at=now + timedelta(minutes=30),
                       status="seated")

    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert _occupancy(ended) == []
    assert len(_occupancy(running)) == 1


def test_sample_bookings_are_left_without_holds_and_not_reported(capsys):
    """demo_seed writes tonight's sample service with no holds on purpose and
    plants an overlapping pair on one table. The backfill must not give them
    holds on whichever day a deploy happens to land, nor report the planted
    pair as a double-booking; a real booking on the same table still gets its
    row."""
    uid, (table, other) = _venue(tables=2)
    day = (_cph_now() + timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    sample_a = _booking(uid, table, day, status="seated", guest="Sample A",
                        idempotency_key=f"demo-{uid}-0")
    sample_b = _booking(uid, table, day + timedelta(minutes=75), guest="Sample B",
                        idempotency_key=f"demo-{uid}-4")
    real = _booking(uid, other, day, guest="Real Guest", idempotency_key="client-key-1")

    out = _boot(capsys)
    assert f"Migration {BACKFILL} skipped" not in out, out
    assert _occupancy(sample_a) == [] and _occupancy(sample_b) == []
    assert len(_occupancy(real)) == 1
    assert sample_a not in out and sample_b not in out, out
