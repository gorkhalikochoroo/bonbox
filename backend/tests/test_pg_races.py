"""Opt-in Postgres race suite for the Daily close writes (R-b, 9 Oct 2026).

SKIPPED unless the environment names a Postgres database in
BONBOX_TEST_PG_URL. Every other run of the backend suite (SQLite) skips it.

What it proves: two REAL requests through the real app (no get_db override),
each on its own thread, TestClient, pooled connection and Session, racing on
one day's close — save/save, save/delete, save/lock, two first saves, unlock/
unlock, resend/unlock, the demo clear/save — with forced interleavings (gates
at pre_claim / post_claim around _claim_draft_version, pre_write before the
first data UPDATE/INSERT of daily_closes, pre_commit at the engine's COMMIT;
"the second request is blocked" read from pg_locks) and barrier-started
same-moment runs. The in-memory SQLite tests cannot express any of this. On
9 Oct it found a save answering 200 while its figures went into a deleted
row, an older build's save rewriting a locked kasserapport, and two first
saves making two live drafts (or a 500); the fix is one writer per day
(services/close_day_lock.py: pg_advisory_xact_lock per user/day/branch).
(h), review 9 Oct: a mail's outcome written after the lock was released
landed on a close unlocked, re-locked or deleted meanwhile (and bumped its
version: the unlocking page's next save got 412) — gated inside the sender.

How to run — ALONE, in its own pytest process (the app binds its engine when
it is first imported; inside a full-suite run this file skips itself):

    # a throwaway Postgres 16, e.g.
    docker run -d --name bonbox-pg -e POSTGRES_PASSWORD=<pw> \\
        -p 127.0.0.1:55432:5432 postgres:16
    # a database of your own in it (CREATE DATABASE bonbox_race), then:
    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/bonbox_race \\
        venv/bin/python -m pytest -q tests/test_pg_races.py

The suite creates its own schema in that database (race_<random>), builds it
through the production startup path (Base.metadata.create_all +
main._run_migrations, with the Postgres-only audit_logs immutability
self-test), runs the app against it with the background scheduler kept off
and the mail sender stubbed, and drops the schema at the end. Never point it
at production. ~2 minutes; 130-odd cases.
"""
from __future__ import annotations

import os
import sys
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres race suite: set BONBOX_TEST_PG_URL (see the file header)",
                allow_module_level=True)
if "app.database" in sys.modules:
    pytest.skip("run tests/test_pg_races.py ALONE, in its own pytest process: the app's "
                "engine is already bound to another database", allow_module_level=True)

import sqlalchemy as _sa  # noqa: E402
from sqlalchemy import text as _text  # noqa: E402

_SCHEMA = "race_" + uuid.uuid4().hex[:12]
_admin = _sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
if _admin.url.get_backend_name() != "postgresql":
    pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL", allow_module_level=True)
with _admin.connect() as _c:
    _c.execute(_text(f'CREATE SCHEMA "{_SCHEMA}"'))
os.environ["DATABASE_URL"] = (
    PG_URL + ("&" if "?" in PG_URL else "?")
    + f"options=-csearch_path%3D{_SCHEMA}&application_name={_SCHEMA}"
)

# The app starts its background scheduler when app.main is imported: never in
# this run (nightly jobs, monitors and mail have no place in a race test).
from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402
BackgroundScheduler.start = lambda self, *a, **k: None

import contextvars  # noqa: E402
import logging  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import date, timedelta  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import event, text  # noqa: E402

import app.main as main  # noqa: E402
from app.main import app, _db_ready  # noqa: E402
from app.database import Base, engine, SessionLocal  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.daily_close import DailyClose  # noqa: E402
from app.models.user import User  # noqa: E402
from app.routers import daily_close as dcr  # noqa: E402
from app.services.auth import hash_password, create_access_token  # noqa: E402
from app.utils.time import utc_now  # noqa: E402

assert engine.url.get_backend_name() == "postgresql", engine.url
# The production schema path, into this run's own schema.
Base.metadata.create_all(bind=engine)
main._run_migrations()


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


_db_ready.set()
IS_PG = True

RACER: contextvars.ContextVar = contextvars.ContextVar("racer", default=None)


class RacerApp:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        tok = None
        if scope["type"] == "http":
            for k, v in scope.get("headers", []):
                if k == b"x-racer":
                    tok = RACER.set(v.decode())
                    break
        try:
            await self.inner(scope, receive, send)
        finally:
            if tok is not None:
                RACER.reset(tok)


# ── gates ─────────────────────────────────────────────────────────────────
class Gates:
    def __init__(self):
        self.points = {}
        self.fault = None          # callable(statement) -> replacement or None
        self.faulted = []
        self.seen = []

    def arm(self, racer, point):
        pair = (threading.Event(), threading.Event())
        self.points[(racer, point)] = pair
        return pair

    def hit(self, point):
        r = RACER.get()
        if r is None:
            return
        pair = self.points.pop((r, point), None)
        if pair:
            pair[0].set()
            if not pair[1].wait(30):
                raise RuntimeError(f"gate {r}:{point} never released")

    def reset(self):
        for reached, release in self.points.values():
            release.set()
        self.points.clear()
        self.fault = None
        self.faulted.clear()
        self.seen.clear()


G = Gates()


@event.listens_for(engine, "before_cursor_execute", retval=True)
def _before(conn, cursor, statement, parameters, context, executemany):
    r = RACER.get()
    if r is not None:
        s = statement.lstrip()
        G.seen.append((r, s[:60]))
        is_claim = s.startswith("UPDATE daily_closes") and "daily_closes.updated_at =" in s
        if (s.startswith("UPDATE daily_closes") and not is_claim) or s.startswith("INSERT INTO daily_closes"):
            G.hit("pre_write")
        if G.fault is not None:
            new = G.fault(r, s)
            if new is not None:
                G.faulted.append((r, s[:120]))
                return new, {} if isinstance(parameters, dict) else ()
    return statement, parameters


@event.listens_for(engine, "commit")
def _on_commit(conn):
    G.hit("pre_commit")


_orig_claim = dcr._claim_draft_version


def _gated_claim(db, existing, data, user):
    G.hit("pre_claim")
    try:
        return _orig_claim(db, existing, data, user)
    finally:
        G.hit("post_claim")


dcr._claim_draft_version = _gated_claim


# ── helpers ───────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    import resend
    monkeypatch.setattr(resend.Emails, "send", lambda payload: {"id": "stub"})
    G.reset()
    _reset_limits()
    yield
    G.reset()


def _reset_limits():
    dcr._limiter.reset()
    try:
        main.limiter.reset()
    except Exception:
        pass
    main._coarse_hits.clear()


def _user():
    s = SessionLocal()
    u = User(
        email=f"race-{uuid.uuid4().hex[:12]}@cafe.dk", password_hash=hash_password("deleteMeNow1"),
        business_name="Race Café", business_type="restaurant", currency="DKK",
        created_at=utc_now() - timedelta(days=2), email_verified=True,
    )
    s.add(u)
    s.commit()
    uid = str(u.id)
    s.close()
    return uid


def _auth(uid):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


_day_counter = [0]


def _new_day():
    _day_counter[0] += 1
    return (date(2026, 3, 1) + timedelta(days=_day_counter[0] % 300)).isoformat()


def _body(day, food, **extra):
    b = {"date": day, "status": "draft", "revenue_breakdown": {"food": food},
         "payment_breakdown": {}, "source_meta": {"kind": "typed"}}
    b.update(extra)
    return b


def _req(racer, method, url, uid, **kw):
    c = TestClient(RacerApp(app), raise_server_exceptions=False)
    headers = {**_auth(uid), "x-racer": racer}
    return c.request(method, url, headers=headers, **kw)


def _post(racer, uid, body):
    return _req(racer, "POST", "/api/daily-close", uid, json=body)


def _delete(racer, uid, close_id, base=None, base_save_id=None):
    params = {}
    if base:
        params["base_updated_at"] = base
    if base_save_id:
        params["base_save_id"] = base_save_id
    return _req(racer, "DELETE", f"/api/daily-close/{close_id}", uid, params=params)


def _rows(uid, day, live_only=False):
    s = SessionLocal()
    try:
        q = s.query(DailyClose).filter(DailyClose.user_id == uid, DailyClose.date == date.fromisoformat(day))
        if live_only:
            q = q.filter(DailyClose.is_deleted.isnot(True))
        return [{"id": str(r.id), "rev": float(r.revenue_total or 0), "status": r.status,
                 "is_deleted": bool(r.is_deleted), "updated_at": r.updated_at} for r in q.all()]
    finally:
        s.close()


class Run(threading.Thread):
    def __init__(self, fn, *a, barrier=None):
        super().__init__(daemon=True)
        self.fn, self.a, self.barrier, self.res, self.err = fn, a, barrier, None, None

    def run(self):
        try:
            if self.barrier:
                self.barrier.wait(10)
            self.res = self.fn(*self.a)
        except Exception as e:  # noqa: BLE001
            self.err = e


def _wait_blocked(timeout=10.0):
    """Until some backend waits on a lock (PG); a fixed pause on SQLite."""
    if not IS_PG:
        time.sleep(1.0)
        return True
    end = time.time() + timeout
    while time.time() < end:
        with engine.connect() as c:
            n = c.execute(text("SELECT count(*) FROM pg_locks WHERE NOT granted")).scalar()
        if n:
            return True
        time.sleep(0.05)
    return False


def _seed_draft(uid, day, food=1000, save_id=None):
    r = _post("seed", uid, _body(day, food, base_updated_at="1970-01-01T00:00:00",
                                  **({"save_id": save_id} if save_id else {})))
    assert r.status_code == 200, r.text
    return r.json()


def _code(r):
    try:
        d = r.json().get("detail")
        if isinstance(d, dict):
            return d.get("code") or d.get("error")
    except Exception:  # noqa: BLE001
        pass
    return None



def _blocked_now():
    if not IS_PG:
        return False
    with engine.connect() as c:
        return bool(c.execute(text("SELECT count(*) FROM pg_locks WHERE NOT granted")).scalar())


def _interleave(first, point, second):
    """Pause `first` (racer, fn, args) at `point`; run `second` in a thread
    until it finishes or waits on a lock; then release `first`."""
    r1, fn1, a1 = first
    reached, release = G.arm(r1, point)
    t1 = Run(fn1, *a1); t1.start()
    assert reached.wait(10), f"{r1} never reached {point}"
    t2 = Run(second[1], *second[2]); t2.start()
    blocked = False
    if IS_PG:
        end = time.time() + 8
        while t2.is_alive() and time.time() < end:
            if _blocked_now():
                blocked = True
                break
            t2.join(0.05)
    else:
        t2.join(1.0)
    release.set()
    t1.join(30); t2.join(30)
    assert not t1.is_alive() and not t2.is_alive()
    assert t1.err is None and t2.err is None, (t1.err, t2.err)
    return t1.res, t2.res, blocked


def _no_500(*rs):
    for r in rs:
        assert r.status_code != 500, r.text[:400]


# ═══ (a) two draft saves, same base, same moment ═════════════════════════
def _check_a(ra, rb, uid, day):
    _no_500(ra, rb)
    assert sorted([ra.status_code, rb.status_code]) == [200, 412], (ra.status_code, ra.text[:200], rb.status_code, rb.text[:200])
    loser = ra if ra.status_code == 412 else rb
    assert _code(loser) == "draft_changed", loser.text[:200]
    winner = 1111 if ra.status_code == 200 else 2222
    live = _rows(uid, day, live_only=True)
    assert len(live) == 1 and live[0]["rev"] == winner, live


@pytest.mark.parametrize("first,point", [("A", "pre_claim"), ("B", "pre_claim"), ("A", "post_claim"), ("A", "pre_commit")])
def test_a_det(first, point):
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    A = ("A", _post, ("A", uid, _body(day, 1111, base_updated_at=v0["updated_at"])))
    B = ("B", _post, ("B", uid, _body(day, 2222, base_updated_at=v0["updated_at"])))
    f, s2 = (A, B) if first == "A" else (B, A)
    r1, r2, _ = _interleave(f, point, s2)
    ra, rb = (r1, r2) if first == "A" else (r2, r1)
    _check_a(ra, rb, uid, day)


@pytest.mark.parametrize("it", range(25))
def test_a_stochastic_same_moment(it):
    _reset_limits()
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    bar = threading.Barrier(2)
    ta = Run(_post, "A", uid, _body(day, 1111, base_updated_at=v0["updated_at"]), barrier=bar)
    tb = Run(_post, "B", uid, _body(day, 2222, base_updated_at=v0["updated_at"]), barrier=bar)
    ta.start(); tb.start(); ta.join(30); tb.join(30)
    _check_a(ta.res, tb.res, uid, day)


# ═══ (b) version-checked DELETE racing a save ════════════════════════════
def _check_b(rs, rd, uid, day, v0):
    _no_500(rs, rd)
    allrows = _rows(uid, day)
    live = _rows(uid, day, live_only=True)
    assert rs.status_code in (200, 412) and rd.status_code in (204, 412), (rs.status_code, rs.text[:200], rd.status_code, rd.text[:200])
    if rs.status_code == 200:
        assert live and live[0]["rev"] == 3333, (
            f"SAVE LOST SILENTLY: save answered 200 (is_deleted={rs.json().get('is_deleted')}), delete {rd.status_code}, "
            f"but no live row holds the save; rows={allrows}")
    orig = [r for r in allrows if r["id"] == v0["id"]][0]
    if rd.status_code == 204:
        assert orig["is_deleted"]
        assert orig["rev"] != 3333 or rs.status_code != 200 or live, \
            f"DELETE REMOVED A ROW NEWER THAN ITS BASE: rows={allrows}"
    else:
        assert _code(rd) == "draft_changed" and live, (rd.text[:200], allrows)


@pytest.mark.parametrize("first,point", [("D", "pre_claim"), ("S", "pre_claim"), ("D", "pre_commit"), ("S", "pre_commit")])
def test_b_det(first, point):
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    S = ("S", _post, ("S", uid, _body(day, 3333, base_updated_at=v0["updated_at"])))
    D = ("D", _delete, ("D", uid, v0["id"], v0["updated_at"]))
    f, s2 = (S, D) if first == "S" else (D, S)
    r1, r2, _ = _interleave(f, point, s2)
    rs, rd = (r1, r2) if first == "S" else (r2, r1)
    print(f"\n[b {first}@{point}] save {rs.status_code} delete {rd.status_code} rows={_rows(uid, day)}")
    _check_b(rs, rd, uid, day, v0)


@pytest.mark.parametrize("it", range(25))
def test_b_stochastic_same_moment(it):
    _reset_limits()
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    bar = threading.Barrier(2)
    ts = Run(_post, "S", uid, _body(day, 3333, base_updated_at=v0["updated_at"]), barrier=bar)
    td = Run(_delete, "D", uid, v0["id"], v0["updated_at"], barrier=bar)
    ts.start(); td.start(); ts.join(30); td.join(30)
    print(f"\n[b stoch] save {ts.res.status_code} delete {td.res.status_code}")
    _check_b(ts.res, td.res, uid, day, v0)


# ═══ (c) a lock racing a draft save ══════════════════════════════════════
def _lock_body(day, food, base):
    b = _body(day, food, status="confirmed", acknowledge_anomaly=True)
    if base is not None:
        b["base_updated_at"] = base
    return b


def _check_c(rs, rl, uid, day):
    if IS_PG:
        _no_500(rs, rl)
    live = _rows(uid, day, live_only=True)
    assert len(live) == 1, live
    if rl.status_code == 200:
        assert live[0]["status"] == "confirmed", f"LOCKED ROW DEMOTED: save {rs.status_code}; row={live}"
        assert live[0]["rev"] == 5000, (f"LOCKED ROW REWRITTEN: lock answered 200 on 5000 (its lock mail/PDF built on "
                                        f"5000) but the locked row holds the draft's figures; save {rs.status_code}; row={live}")
    else:
        assert rl.status_code == 412 and _code(rl) == "draft_changed", (rl.status_code, rl.text[:200])
        assert rs.status_code == 200 and live[0]["status"] == "draft" and live[0]["rev"] == 3333, live


@pytest.mark.parametrize("first,point,save_base,lock_base", [
    ("S", "pre_claim", True, True), ("L", "pre_claim", True, True),
    ("S", "pre_commit", True, True), ("L", "pre_commit", True, True),
    ("S", "pre_write", False, True),      # older build's draft save (no base) vs a lock
    ("S", "pre_commit", True, False),     # older build's lock (no base) vs a draft save
    ("L", "pre_write", True, False),
])
def test_c_det(first, point, save_base, lock_base):
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    sb = _body(day, 3333, **({"base_updated_at": v0["updated_at"]} if save_base else {}))
    S = ("S", _post, ("S", uid, sb))
    L = ("L", _post, ("L", uid, _lock_body(day, 5000, v0["updated_at"] if lock_base else None)))
    f, s2 = (S, L) if first == "S" else (L, S)
    r1, r2, _ = _interleave(f, point, s2)
    rs, rl = (r1, r2) if first == "S" else (r2, r1)
    print(f"\n[c {first}@{point} save_base={save_base} lock_base={lock_base}] save {rs.status_code} lock {rl.status_code} rows={_rows(uid, day)}")
    _check_c(rs, rl, uid, day)


@pytest.mark.parametrize("it", range(25))
def test_c_stochastic_same_moment(it):
    _reset_limits()
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    bar = threading.Barrier(2)
    ts = Run(_post, "S", uid, _body(day, 3333, base_updated_at=v0["updated_at"]), barrier=bar)
    tl = Run(_post, "L", uid, _lock_body(day, 5000, v0["updated_at"]), barrier=bar)
    ts.start(); tl.start(); ts.join(30); tl.join(30)
    _check_c(ts.res, tl.res, uid, day)


@pytest.mark.parametrize("it", range(15))
def test_c_stochastic_legacy_save_no_base(it):
    _reset_limits()
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    bar = threading.Barrier(2)
    ts = Run(_post, "S", uid, _body(day, 3333), barrier=bar)
    tl = Run(_post, "L", uid, _lock_body(day, 5000, v0["updated_at"]), barrier=bar)
    ts.start(); tl.start(); ts.join(30); tl.join(30)
    _check_c(ts.res, tl.res, uid, day)


# ═══ (d) _last_save_id read failing mid-transaction ══════════════════════
def _fault_audit_last_save(racer_wanted):
    def f(r, s):
        if r == racer_wanted and s.startswith("SELECT") and "FROM audit_logs" in s \
                and "ORDER BY audit_logs.created_at DESC" in s:
            return "SELECT no_such_column_xyz FROM audit_logs"
        return None
    return f


def _answer_lost_setup():
    """Seed V0 (save s0); the page's save X (base V0) lands -> V1, its answer
    'lost'. The page's next save follows it: base V0 + base_save_id X."""
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day, save_id="s0")
    r1 = _post("seed", uid, _body(day, 2000, base_updated_at=v0["updated_at"], save_id="X"))
    assert r1.status_code == 200, r1.text
    return uid, day, v0, r1.json()


def test_d_control_follow_succeeds_without_fault():
    uid, day, v0, v1 = _answer_lost_setup()
    r = _post("P", uid, _body(day, 2500, base_updated_at=v0["updated_at"], base_save_id="X", save_id="Y"))
    assert r.status_code == 200, r.text
    assert _rows(uid, day, live_only=True)[0]["rev"] == 2500


def test_d_save_with_failing_last_save_id_query():
    uid, day, v0, v1 = _answer_lost_setup()
    G.fault = _fault_audit_last_save("P")
    r = _post("P", uid, _body(day, 2500, base_updated_at=v0["updated_at"], base_save_id="X", save_id="Y"))
    faulted = list(G.faulted)
    G.fault = None
    live = _rows(uid, day, live_only=True)
    print("\n[d precheck] faulted:", faulted, "\nresp:", r.status_code, r.text[:200], "\nrows:", live)
    assert faulted, "fault never injected"
    _no_500(r)
    if r.status_code == 200:
        assert live[0]["rev"] == 2500
    else:
        assert r.status_code == 412 and live[0]["rev"] == 2000


@pytest.mark.parametrize("fault", [False, True])
def test_d_claim_loop(fault):
    """P passes its pre-check on V0; the page's own lost save X lands before
    P's claim; the follow check runs INSIDE the claim loop (faulted or not)."""
    uid = _user(); day = _new_day()
    v0 = _seed_draft(uid, day, save_id="s0")
    P = ("P", _post, ("P", uid, _body(day, 2500, base_updated_at=v0["updated_at"], base_save_id="X", save_id="Y")))
    X = ("X", _post, ("X", uid, _body(day, 2000, base_updated_at=v0["updated_at"], save_id="X")))
    if fault:
        G.fault = _fault_audit_last_save("P")
    rp, rx, blocked = _interleave(P, "pre_claim", X)
    faulted = list(G.faulted); G.fault = None
    live = _rows(uid, day, live_only=True)
    print(f"\n[d claim-loop fault={fault}] faulted={faulted} P {rp.status_code} X {rx.status_code} blocked={blocked} rows={live}")
    _no_500(rp, rx)
    assert len(live) == 1
    if rx.status_code == 200 and rp.status_code == 200:
        assert live[0]["rev"] == 2500     # P followed X
    elif rp.status_code == 200:
        assert live[0]["rev"] == 2500 and rx.status_code == 412
    else:
        assert rp.status_code == 412 and live[0]["rev"] == 2000
        if not fault:
            pytest.fail("P was refused although it follows its own save X")


def test_d_delete_with_failing_last_save_id_query():
    uid, day, v0, v1 = _answer_lost_setup()
    G.fault = _fault_audit_last_save("P")
    r = _delete("P", uid, v1["id"], v0["updated_at"], base_save_id="X")
    faulted = list(G.faulted); G.fault = None
    live = _rows(uid, day, live_only=True)
    print("\n[d delete] faulted:", faulted, "\nresp:", r.status_code, r.text[:200], "\nrows:", live)
    assert faulted
    _no_500(r)


def test_d_reads_with_failing_audit_query():
    uid, day, v0, v1 = _answer_lost_setup()
    G.fault = _fault_audit_last_save("P")
    r1 = _req("P", "GET", "/api/daily-close", uid, params={"from": day, "to": day, "with_save_id": "true"})
    r2 = _req("P", "GET", f"/api/daily-close/{v1['id']}", uid)
    faulted = list(G.faulted); G.fault = None
    assert len(faulted) >= 2
    assert r1.status_code == 200 and "last_save_id" not in r1.json()[0], r1.text[:300]
    assert r2.status_code == 200 and "last_save_id" not in r2.json(), r2.text[:300]


# ═══ (e) extra probe: two FIRST saves of a day at the same moment ════════
def _check_e(ra, rb, uid, day):
    live = _rows(uid, day, live_only=True)
    assert len(live) == 1, f"DUPLICATE LIVE ROWS for one day: {ra.status_code}/{rb.status_code} rows={live}"


@pytest.mark.parametrize("it", range(10))
def test_e_two_first_saves_no_branch(it):
    _reset_limits()
    uid = _user(); day = _new_day()
    bar = threading.Barrier(2)
    ta = Run(_post, "A", uid, _body(day, 1111, base_updated_at="1970-01-01T00:00:00"), barrier=bar)
    tb = Run(_post, "B", uid, _body(day, 2222, base_updated_at="1970-01-01T00:00:00"), barrier=bar)
    ta.start(); tb.start(); ta.join(30); tb.join(30)
    _check_e(ta.res, tb.res, uid, day)


def test_e_det_two_first_saves_no_branch():
    uid = _user(); day = _new_day()
    A = ("A", _post, ("A", uid, _body(day, 1111, base_updated_at="1970-01-01T00:00:00")))
    B = ("B", _post, ("B", uid, _body(day, 2222, base_updated_at="1970-01-01T00:00:00")))
    rb, ra, _ = _interleave(B, "pre_write", A)
    print(f"\n[e det] A {ra.status_code} B {rb.status_code} rows={_rows(uid, day)}")
    _check_e(ra, rb, uid, day)


def _branch(uid):
    from app.models.branch import Branch
    s = SessionLocal()
    b = Branch(user_id=uid, name="Afdeling 1", business_type="restaurant")
    s.add(b); s.commit(); bid = str(b.id); s.close()
    return bid


def test_e_det_two_first_saves_with_branch():
    uid = _user(); day = _new_day(); bid = _branch(uid)
    A = ("A", _post, ("A", uid, _body(day, 1111, branch_id=bid, base_updated_at="1970-01-01T00:00:00")))
    B = ("B", _post, ("B", uid, _body(day, 2222, branch_id=bid, base_updated_at="1970-01-01T00:00:00")))
    rb, ra, _ = _interleave(B, "pre_write", A)
    live = _rows(uid, day, live_only=True)
    print(f"\n[e det branch] A {ra.status_code} B {rb.status_code} {rb.text[:160]} rows={live}")
    assert len(live) == 1
    _no_500(ra, rb)


# ═══ (f) the other writes of a day take the same lock ════════════════════
def _locked_close(uid, day, food=5000):
    v0 = _seed_draft(uid, day)
    r = _post("seed", uid, _lock_body(day, food, v0["updated_at"]))
    assert r.status_code == 200 and r.json()["status"] == "confirmed", r.text
    return r.json()


def _unlock(racer, uid, close_id, reason="Forkert kortbeløb"):
    return _req(racer, "POST", f"/api/daily-close/{close_id}/unlock", uid, json={"reason": reason})


def _audit_count(close_id, action):
    s = SessionLocal()
    try:
        return s.query(AuditLog).filter(
            AuditLog.entity_id == uuid.UUID(str(close_id)), AuditLog.action == action).count()
    finally:
        s.close()


def test_f_two_unlocks_one_wins():
    """Two phones unlock the same locked close at once: one unlock, one audit
    row — the second reads the day after the first and is told it is not
    locked (400), never a second unlock written over the first."""
    uid = _user(); day = _new_day()
    c = _locked_close(uid, day)
    U1 = ("U1", _unlock, ("U1", uid, c["id"], "Første grund"))
    U2 = ("U2", _unlock, ("U2", uid, c["id"], "Anden grund"))
    r1, r2, blocked = _interleave(U1, "pre_commit", U2)
    print(f"\n[f unlock/unlock] {r1.status_code} {r2.status_code} blocked={blocked}")
    _no_500(r1, r2)
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 400, r2.text
    assert _audit_count(c["id"], "daily_close.unlock") == 1
    live = _rows(uid, day, live_only=True)
    assert len(live) == 1 and live[0]["status"] == "draft"


def _resend(racer, uid, close_id, key):
    return _req(racer, "POST", f"/api/daily-close/{close_id}/resend-email", uid, json={"key": key})


def test_f_resend_waits_for_an_unlock_and_sends_nothing(monkeypatch):
    """"Send igen" while another phone unlocks the close: the resend reads the
    day after the unlock and is refused as not locked — the unlocked draft is
    never mailed as the kasserapport."""
    import resend
    sent = []
    monkeypatch.setattr(resend.Emails, "send", lambda payload: sent.append(payload) or {"id": "stub"})
    uid = _user(); day = _new_day()
    c = _locked_close(uid, day)
    sent.clear()  # the lock's own mail, if the plan sends one
    U = ("U", _unlock, ("U", uid, c["id"]))
    R = ("R", _resend, ("R", uid, c["id"], "resend-race-1"))
    ru, rr, blocked = _interleave(U, "pre_commit", R)
    print(f"\n[f unlock/resend] unlock {ru.status_code} resend {rr.status_code} {rr.text[:120]} blocked={blocked}")
    _no_500(ru, rr)
    assert ru.status_code == 200, ru.text
    assert rr.status_code == 409 and _code(rr) == "not_locked", rr.text[:300]
    assert sent == []
    assert _audit_count(c["id"], "daily_close.resend_email") == 0


def test_f_demo_clear_keeps_a_sample_day_the_owner_just_saved():
    """"Ryd demodata" while the owner saves real figures on a sample day: the
    save makes it the owner's close (the " · demo" marker goes), and the
    clear — locked out of that day until the save commits — reads it again
    and keeps it. Before, its DELETE (keyed on the id alone) removed it."""
    from app.services.demo_seed import clear_for_user
    uid = _user(); day = _new_day()
    s = SessionLocal()
    demo = DailyClose(user_id=uuid.UUID(uid), date=date.fromisoformat(day), status="draft",
                      revenue_total=1000, payment_total=0, moms_total=200, revenue_ex_moms=800,
                      notes="sample · demo")
    s.add(demo); s.commit(); demo_id = str(demo.id); s.close()

    out = {}

    def _clear(*_a):
        cs = SessionLocal()
        try:
            u = cs.query(User).filter(User.id == uuid.UUID(uid)).one()
            out["result"] = clear_for_user(cs, u)
        finally:
            cs.close()
        return out["result"]

    S = ("S", _post, ("S", uid, _body(day, 3333)))   # an owner's save, no " · demo" note
    rs, rc, blocked = _interleave(S, "pre_commit", ("C", _clear, ()))
    print(f"\n[f clear/save] save {rs.status_code} clear {rc} blocked={blocked} rows={_rows(uid, day)}")
    _no_500(rs)
    assert rs.status_code == 200, rs.text
    live = _rows(uid, day, live_only=True)
    assert len(live) == 1 and live[0]["id"] == demo_id and live[0]["rev"] == 3333, (
        f"OWNER'S CLOSE REMOVED BY THE DEMO CLEAR: rows={_rows(uid, day)} clear={rc}")
    assert rc["ok"] and rc["deleted"]["closes"] == 0, rc


def test_f_demo_clear_still_removes_untouched_sample_days():
    from app.services.demo_seed import clear_for_user
    uid = _user(); day = _new_day()
    s = SessionLocal()
    s.add(DailyClose(user_id=uuid.UUID(uid), date=date.fromisoformat(day), status="confirmed",
                     revenue_total=1000, payment_total=0, moms_total=200, revenue_ex_moms=800,
                     notes="sample · demo"))
    s.commit()
    u = s.query(User).filter(User.id == uuid.UUID(uid)).one()
    res = clear_for_user(s, u)
    s.close()
    assert res["ok"] and res["deleted"]["closes"] == 1, res
    assert _rows(uid, day) == []


# ═══ (g) the audit_logs immutability self-test runs on Postgres ══════════
def test_g_audit_log_immutability_self_test_runs(caplog):
    caplog.set_level(logging.WARNING, logger="bonbox.security")
    with engine.connect() as c:
        main._verify_audit_log_immutability(c)
    msgs = [r.getMessage() for r in caplog.records if r.name == "bonbox.security"]
    assert not any("could not run" in m for m in msgs), msgs
    assert not any("CHECK FAILED" in m for m in msgs), msgs
    with engine.connect() as c:
        n = c.execute(text("SELECT count(*) FROM audit_logs WHERE action = 'audit.selftest'")).scalar()
    assert n >= 2, n   # startup's sentinel and this one: the RULE kept both


def test_g_audit_log_self_test_cries_when_the_rule_is_gone(caplog):
    caplog.set_level(logging.WARNING, logger="bonbox.security")
    with engine.begin() as c:
        c.execute(text("DROP RULE audit_logs_no_delete ON audit_logs"))
    try:
        with engine.connect() as c:
            main._verify_audit_log_immutability(c)
    finally:
        with engine.begin() as c:
            c.execute(text("CREATE OR REPLACE RULE audit_logs_no_delete AS "
                           "ON DELETE TO audit_logs DO INSTEAD NOTHING"))
    crit = [r for r in caplog.records if r.name == "bonbox.security" and r.levelno == logging.CRITICAL]
    assert crit and "IMMUTABILITY CHECK FAILED" in crit[0].getMessage()


# ═══ (h) the mail outcome never lands on another version of the day ═════
# Review, 9 Oct: the resend's claim commits (the day lock goes with it), then
# the mail goes and its outcome was written through the ORM — no lock, no
# condition, and a bump of updated_at. An unlock meanwhile answered 200, the
# draft got 'sent' and a newer stamp (the unlocking page's next save: 412
# draft_changed), and an unlock → edit → re-lock meanwhile got the OLD mail's
# outcome on the corrected version ("Sendt til revisor", 'Send igen' →
# already_sent). Fix: unlock waits for a send in flight (409 in_progress); the
# outcome is one conditional UPDATE (still locked, same closed_at, not
# deleted) that keeps the version stamp.

def _gate_mail(monkeypatch, sent, fail_for=()):
    """A mail key (stub sender only) and a sender that stops at gate
    'in_send' for an armed racer; `fail_for` racers' sends raise."""
    import resend
    monkeypatch.setattr(resend, "api_key", "re_stub_only_never_sent")

    def _send(payload):
        G.hit("in_send")
        r = RACER.get()
        if r in fail_for:
            raise RuntimeError("stub send failure")
        sent.append((r, payload))
        return {"id": "stub"}

    monkeypatch.setattr(resend.Emails, "send", _send)


def _paid_user():
    """A Starter account (no Stripe subscription: a granted plan) — the plan
    that mails the kasserapport."""
    uid = _user()
    s = SessionLocal()
    try:
        s.query(User).filter(User.id == uuid.UUID(uid)).update({User.plan: "starter"})
        s.commit()
    finally:
        s.close()
    return uid


def _row(close_id):
    s = SessionLocal()
    try:
        r = s.query(DailyClose).filter(DailyClose.id == uuid.UUID(str(close_id))).one()
        return {k: getattr(r, k) for k in (
            "status", "is_deleted", "updated_at", "closed_at", "email_status",
            "email_sent_to", "email_sent_at", "email_send_key", "revenue_total")}
    finally:
        s.close()


def _iso(dt):
    from app.routers.daily_close import _naive_utc
    return _naive_utc(dt).isoformat() if dt else None


def test_h_unlock_waits_for_a_resend_in_flight(monkeypatch):
    """"Send igen" is mailing; another phone taps Lås op: refused with 409
    in_progress (still locked), the mail's outcome lands on the locked close,
    and once the send is done the unlock goes through and the unlocking
    page's next save on the unlock's version is accepted."""
    sent = []
    uid = _paid_user(); day = _new_day()
    c = _locked_close(uid, day)            # no mail key yet: failed_skipped
    _gate_mail(monkeypatch, sent)
    R = ("R", _resend, ("R", uid, c["id"], "resend-h1-key"))
    U = ("U", _unlock, ("U", uid, c["id"]))
    rr, ru, blocked = _interleave(R, "in_send", U)
    print(f"\n[h resend/unlock] resend {rr.status_code} unlock {ru.status_code} {ru.text[:120]}")
    _no_500(rr, ru)
    assert rr.status_code == 200, rr.text
    assert ru.status_code == 409 and _code(ru) == "in_progress", ru.text[:300]
    assert len(sent) == 1
    row = _row(c["id"])
    assert row["status"] == "confirmed" and row["email_status"] == "sent", row
    assert _audit_count(c["id"], "daily_close.unlock") == 0
    # The send is done: the unlock goes through, and the page saves on it.
    ru2 = _unlock("U", uid, c["id"])
    assert ru2.status_code == 200, ru2.text
    rs = _post("S", uid, _body(day, 6100, base_updated_at=ru2.json()["updated_at"]))
    assert rs.status_code == 200, rs.text


def test_h_lock_mail_never_stamps_a_close_unlocked_meanwhile(monkeypatch):
    """The lock mail (no 'sending' claim) is on its way when another phone
    unlocks: the unlock answers 200, the mail still goes (it is the version
    that was locked), but its outcome is NOT written onto the draft — the
    draft keeps the unlock's version stamp, and the unlocking page's next
    save on that version is accepted (never a false 'saved elsewhere')."""
    sent = []
    uid = _paid_user(); day = _new_day()
    v0 = _seed_draft(uid, day)
    _gate_mail(monkeypatch, sent)
    L = ("L", _post, ("L", uid, _lock_body(day, 5000, v0["updated_at"])))
    U = ("U", _unlock, ("U", uid, v0["id"]))
    rl, ru, blocked = _interleave(L, "in_send", U)
    print(f"\n[h lockmail/unlock] lock {rl.status_code} unlock {ru.status_code}")
    _no_500(rl, ru)
    assert rl.status_code == 200 and ru.status_code == 200, (rl.text[:200], ru.text[:200])
    assert len(sent) == 1                  # the locked version went out …
    assert _audit_count(v0["id"], "close.auto_emailed") == 1   # … and the trail says so
    row = _row(v0["id"])
    assert row["status"] == "draft", row
    assert row["email_status"] is None and row["email_sent_to"] is None, row
    assert _iso(row["updated_at"]) == ru.json()["updated_at"], (row["updated_at"], ru.json()["updated_at"])
    rs = _post("S", uid, _body(day, 5100, base_updated_at=ru.json()["updated_at"]))
    assert rs.status_code == 200, rs.text


def test_h_old_send_never_lands_on_the_corrected_version(monkeypatch):
    """Worst case: a resend whose claim has gone stale (a hung worker) is
    still mailing while the owner unlocks, corrects and re-locks — and the
    re-lock's own mail fails. The old send's 'sent' must not land on the
    corrected version: History keeps the correction's own outcome, and
    'Send igen' sends it (never 'already_sent' for a version nobody got)."""
    sent = []
    uid = _paid_user(); day = _new_day()
    c = _locked_close(uid, day)
    _gate_mail(monkeypatch, sent, fail_for=("L2",))
    monkeypatch.setattr(dcr, "_SENDING_STALE", timedelta(0))   # the claim counts as stale at once
    reached, release = G.arm("R", "in_send")
    t = Run(_resend, "R", uid, c["id"], "resend-h3-key"); t.start()
    try:
        assert reached.wait(10), "resend never reached the sender"
        ru = _unlock("U", uid, c["id"])
        assert ru.status_code == 200, ru.text
        rl = _post("L2", uid, _lock_body(day, 7777, ru.json()["updated_at"]))
        assert rl.status_code == 200 and rl.json()["status"] == "confirmed", rl.text[:300]
        after_relock = _row(c["id"])
        assert after_relock["email_status"] == "send_failed", after_relock
    finally:
        release.set()
        t.join(30)
    assert t.err is None, t.err
    rr = t.res
    print(f"\n[h stale resend/relock] resend {rr.status_code} row={_row(c['id'])}")
    _no_500(rr)
    assert rr.status_code == 200, rr.text
    assert [r for r, _p in sent] == ["R"]          # the old version went out
    row = _row(c["id"])
    assert row["status"] == "confirmed" and float(row["revenue_total"]) == 7777.0
    assert row["closed_at"] == after_relock["closed_at"]
    # The correction's own outcome, untouched by the old send:
    assert row["email_status"] == "send_failed" and row["email_sent_to"] is None, row
    assert row["updated_at"] == after_relock["updated_at"], row
    monkeypatch.setattr(dcr, "_SENDING_STALE", timedelta(minutes=3))
    r2 = _resend("R2", uid, c["id"], "resend-h3-again")
    assert r2.status_code == 200 and r2.json()["replayed"] is False, r2.text[:300]
    assert [r for r, _p in sent] == ["R", "R2"]


def test_h_old_send_never_writes_into_a_deleted_close(monkeypatch):
    """A stale send still mailing while the owner unlocks and starts over
    (the draft is deleted): the deleted row is not written to."""
    sent = []
    uid = _paid_user(); day = _new_day()
    c = _locked_close(uid, day)
    _gate_mail(monkeypatch, sent)
    monkeypatch.setattr(dcr, "_SENDING_STALE", timedelta(0))
    reached, release = G.arm("R", "in_send")
    t = Run(_resend, "R", uid, c["id"], "resend-h4-key"); t.start()
    try:
        assert reached.wait(10), "resend never reached the sender"
        ru = _unlock("U", uid, c["id"])
        assert ru.status_code == 200, ru.text
        rd = _delete("D", uid, c["id"], base=ru.json()["updated_at"])
        assert rd.status_code in (200, 204), rd.text[:300]
        after_delete = _row(c["id"])
        assert after_delete["is_deleted"] is True
    finally:
        release.set()
        t.join(30)
    assert t.err is None, t.err
    _no_500(t.res)
    row = _row(c["id"])
    assert row["is_deleted"] is True and row["updated_at"] == after_delete["updated_at"], row
    assert row["email_sent_to"] is None and row["email_status"] == after_delete["email_status"], row
