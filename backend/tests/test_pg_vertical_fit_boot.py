"""Opt-in Postgres test for the vertical-fit boot fixes (Push 8, 12 Oct 2026).

SKIPPED unless the environment names a Postgres database in
BONBOX_TEST_PG_URL. The SQLite half lives in
tests/test_vertical_fit_boot_hardening.py; this file proves what only a real
Postgres can show:

  • L2 — while a live request holds a member row's lock, the alignment gives
    up after the 3 s lock_timeout instead of queueing behind it; the boot
    runner logs the error's type name only, and the module rename (its own
    session, L1) still lands;
  • the SET LOCAL ends with the fix's transaction: the pooled connection
    goes back with Postgres' default lock_timeout;
  • the conditional writes (UPDATE … WHERE … AND EXISTS on the same table)
    behave on Postgres as on SQLite: member roles only, never a personal
    owner, users.updated_at untouched.

How to run:

    docker run -d --name bonbox-pg -e POSTGRES_PASSWORD=<pw> \\
        -p 127.0.0.1:55432:5432 postgres:16
    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/postgres \\
        python -m pytest -q tests/test_pg_vertical_fit_boot.py

It builds its own schema (vf_<random>) with its own engine and drops it at
the end. Never point it at production.
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import timedelta

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres vertical-fit boot test: set BONBOX_TEST_PG_URL "
                "(see the file header)", allow_module_level=True)

import sqlalchemy as sa  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database import Base  # noqa: E402
import app.models  # noqa: E402,F401 — registers every model on Base.metadata
from app.models.user import User  # noqa: E402
from app.services import archetype_defaults as ad  # noqa: E402
from app.utils.time import utc_now  # noqa: E402

_OLD = utc_now().replace(microsecond=0) - timedelta(days=40)


@pytest.fixture(scope="module")
def factory():
    admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    if admin.url.get_backend_name() != "postgresql":
        pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL")
    schema = "vf_" + uuid.uuid4().hex[:12]
    with admin.connect() as c:
        c.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = PG_URL + ("&" if "?" in PG_URL else "?") + f"options=-csearch_path%3D{schema}"
    eng = sa.create_engine(url, pool_size=5)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()
    with admin.connect() as c:
        c.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


@pytest.fixture(autouse=True)
def _clean(factory):
    yield
    s = factory()
    s.execute(text("UPDATE users SET owner_id = NULL"))
    s.execute(text("DELETE FROM users"))
    s.commit()
    s.close()


def _user(s, *, business_type="cafe", role="owner", owner_id=None, enabled_modules=None):
    u = User(
        email=f"{uuid.uuid4().hex[:10]}@pg.bonbox.test",
        password_hash="x",
        business_name="PG Biz",
        business_type=business_type,
        currency="DKK",
        role=role,
        email_verified=True,
        enabled_modules=enabled_modules,
        owner_id=owner_id,
    )
    s.add(u)
    s.commit()
    s.execute(text("UPDATE users SET updated_at = :t WHERE id = :i"), {"t": _OLD, "i": str(u.id)})
    s.commit()
    return str(u.id)


def _row(factory, uid):
    s = factory()
    try:
        return s.execute(
            text("SELECT business_type, enabled_modules, updated_at FROM users WHERE id = :i"),
            {"i": uid},
        ).one()
    finally:
        s.close()


def test_alignment_gives_up_on_a_held_row_lock_and_the_rename_still_lands(factory):
    s = factory()
    owner = _user(s, business_type="salon")
    mgr = _user(s, business_type="cafe", role="manager", owner_id=owner)
    bar = _user(s, business_type="bar", enabled_modules="pour,competitor")
    s.close()

    # A live request holds the member's row (an open transaction that wrote it).
    holder = factory()
    holder.execute(text("SELECT id FROM users WHERE id = :i FOR UPDATE"), {"i": mgr})
    lines: list[str] = []
    try:
        t0 = time.monotonic()
        out = ad.run_vertical_fit_boot_fixes(factory, log=lines.append)
        waited = time.monotonic() - t0
    finally:
        holder.rollback()
        holder.close()

    assert out["members"] is None                    # gave up …
    assert 2.5 <= waited < 15, waited                # … after ~3 s, not "forever"
    assert any("member alignment skipped: OperationalError" in ln for ln in lines), lines
    assert not any("users" in ln.lower() and "update" in ln.lower() for ln in lines), lines
    assert out["modules"] == {"renamed": 1, "kept": 0}   # L1: its own session
    assert _row(factory, bar).enabled_modules == "bar_pour,competitor"
    assert _row(factory, mgr).business_type == "cafe"    # untouched, retried next boot

    # Next boot, no lock held: aligned.
    assert ad.run_vertical_fit_boot_fixes(factory, log=lambda *_: None)["members"] == 1
    assert _row(factory, mgr).business_type == "salon"


def test_the_lock_timeout_does_not_leak_to_the_pooled_connection(factory):
    s = factory()
    ad.align_member_business_types(s)          # SET LOCAL … then COMMIT
    assert s.execute(text("SHOW lock_timeout")).scalar() == "0"
    s.close()
    s = factory()
    assert s.execute(text("SHOW lock_timeout")).scalar() == "0"
    s.close()


def test_postgres_writes_follow_the_same_rules(factory):
    s = factory()
    owner = _user(s, business_type="salon")
    personal = _user(s, business_type="personal")
    mgr = _user(s, business_type="cafe", role="manager", owner_id=owner)
    cashier = _user(s, business_type=None, role="cashier", owner_id=owner)
    acct = _user(s, business_type="cafe", role="accountant", owner_id=owner)
    under_personal = _user(s, business_type="cafe", role="viewer", owner_id=personal)
    assert ad.align_member_business_types(s) == 2
    assert ad.align_member_business_types(s) == 0   # idempotent
    s.close()
    assert _row(factory, mgr).business_type == "salon"
    assert _row(factory, cashier).business_type == "salon"
    assert _row(factory, acct).business_type == "cafe"
    assert _row(factory, under_personal).business_type == "cafe"
    for uid in (mgr, cashier):
        assert _row(factory, uid).updated_at == _OLD

    s = factory()
    o = s.get(User, uuid.UUID(owner))
    o.business_type = "clothing"
    assert ad.sync_team_business_type(s, o) == 2
    s.commit()
    s.close()
    assert _row(factory, mgr).business_type == "clothing"
    assert _row(factory, acct).business_type == "cafe"
    assert _row(factory, mgr).updated_at == _OLD


def test_alignment_skips_a_row_whose_owner_changed_type_meanwhile(factory, monkeypatch):
    s = factory()
    owner = _user(s, business_type="salon")
    mgr = _user(s, business_type="cafe", role="viewer", owner_id=owner)
    s.close()
    real = ad._drifted_members

    def read_then_owner_changes(db):
        rows = real(db)
        other = factory()
        other.execute(text("UPDATE users SET business_type = 'cafe' WHERE id = :i"), {"i": owner})
        other.commit()
        other.close()
        return rows

    monkeypatch.setattr(ad, "_drifted_members", read_then_owner_changes)
    s = factory()
    assert ad.align_member_business_types(s) == 0
    s.close()
    assert _row(factory, mgr).business_type == "cafe"


def test_rename_keeps_a_value_saved_meanwhile(factory, monkeypatch):
    s = factory()
    bar = _user(s, business_type="bar", enabled_modules="pour,competitor")
    s.close()
    real = ad._boot_module_cap

    def cap_then_owner_saves(user):
        other = factory()
        other.execute(text("UPDATE users SET enabled_modules = 'workshop' WHERE id = :i"), {"i": bar})
        other.commit()
        other.close()
        return real(user)

    monkeypatch.setattr(ad, "_boot_module_cap", cap_then_owner_saves)
    s = factory()
    assert ad.rename_legacy_module_ids(s) == {"renamed": 0, "kept": 1}
    s.close()
    assert _row(factory, bar).enabled_modules == "workshop"
