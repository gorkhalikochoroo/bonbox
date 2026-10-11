"""Staff join and stand pairing: a short GLOBAL cool-off after a burst of wrong
codes (R-sec, main.join_failure_brake).

THE GAP. POST /api/portal/join and /api/stand/join allow 8/minute per IP.
With N addresses a guesser gets 8·N guesses a minute against 32^6 codes; the
per-IP cap alone scales with the attacker's pool.

NOW. Wrong codes (404s) from ALL addresses together are counted per door:
JOIN_FAIL_GLOBAL_MAX of them within JOIN_FAIL_WINDOW_SEC pause that door for
everyone for JOIN_COOLOFF_SEC — a 429 {"detail": "Too many requests"} with
Retry-After — and the door stays shut while its window is full, so at most
JOIN_FAIL_GLOBAL_MAX wrong codes reach the handler per window, also under a
concurrent flood (a slot is reserved before the handler runs).
Successes, per-IP 429s, other paths and GETs are not counted.
0 switches it off. Every request here comes from a fresh CF-Connecting-IP, so
the per-IP limits never fire.

Run: cd backend && python -m pytest tests/test_join_global_brake.py -q
"""
from __future__ import annotations

import itertools
import time
from collections import deque

import pytest

import app.main as main
from app.config import settings
from app.utils import abuse_signals
from tests.test_staff_join import (  # noqa: F401 — fixtures + builders
    _owner,
    _override_user,
    _reset_limiters,
    _staff,
    client,
    db,
    engine_and_session,
)
from tests.test_stand_link import _as, _mint, _seed  # helpers only

_counter = itertools.count(1)


def _ip() -> dict:
    n = next(_counter)
    return {"CF-Connecting-IP": f"10.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255 or 1}"}


@pytest.fixture(autouse=True)
def brake(monkeypatch):
    monkeypatch.setattr(settings, "JOIN_FAIL_GLOBAL_MAX", 3)
    monkeypatch.setattr(settings, "JOIN_FAIL_WINDOW_SEC", 600)
    monkeypatch.setattr(settings, "JOIN_COOLOFF_SEC", 60)
    main._join_fail_times.clear()
    main._join_cooloff_until.clear()
    abuse_signals.reset()
    yield
    main._join_fail_times.clear()
    main._join_cooloff_until.clear()


def _staff_code(client, db, owner=None, name="Agnes"):
    owner = owner or _owner(db)
    staff = _staff(db, owner, name=name)
    _override_user(owner)
    code = client.post(f"/api/staff/members/{staff.id}/link", headers=_ip()).json()["join_code"]
    _override_user(None)
    return owner, code


def _stand_code(client, db):
    u = _seed(db)
    _as(u)
    return _mint(client)["code"]


def _join(client, code, door="/api/portal/join"):
    return client.post(door, json={"code": code}, headers=_ip())


def _sig():
    return abuse_signals.drain()


def test_a_burst_of_wrong_staff_codes_pauses_staff_join_for_everyone(client, db):
    _, code = _staff_code(client, db)
    for _ in range(3):
        assert _join(client, "ZZZZZZ").status_code == 404
    r = _join(client, code)                                  # a VALID code, a new address
    assert r.status_code == 429
    assert r.json() == {"detail": "Too many requests"}
    # Retry-After tells the real wait: until the oldest of the three
    # failures (all just now) is older than the 600 s window.
    assert 595 <= int(r.headers["retry-after"]) <= 601
    assert _sig().get("staff_join_cooloff") == 1


def test_after_the_cool_off_the_valid_code_works(client, db):
    _, code = _staff_code(client, db)
    for _ in range(3):
        _join(client, "ZZZZZZ")
    assert _join(client, code).status_code == 429
    main._join_cooloff_until["staff_join"] = time.time() - 1
    # The cool-off is over, but the window still holds the three failures
    # (a true sliding window); once they are older than it, the door is open.
    assert _join(client, code).status_code == 429
    old = time.time() - 601
    main._join_fail_times["staff_join"] = deque([old] * 3, maxlen=3)
    r = _join(client, code)
    assert r.status_code == 200, r.text
    assert r.json()["path"].startswith("/s/")


def test_a_staff_trip_leaves_stand_pairing_alone_and_vice_versa(client, db):
    stand_code = _stand_code(client, db)
    for _ in range(3):
        _join(client, "ZZZZZZ")
    assert _join(client, "ZZZZZZ").status_code == 429       # staff door paused
    r = _join(client, stand_code, door="/api/stand/join")
    assert r.status_code == 200, r.text                      # stand door open

    main._join_cooloff_until.clear()
    main._join_fail_times.clear()       # the staff door's window is full too
    _override_user(None)
    _, staff_code = _staff_code(client, db)
    for _ in range(3):
        assert _join(client, "ZZZZZZ", door="/api/stand/join").status_code == 404
    assert _join(client, "ZZZZZZ", door="/api/stand/join").status_code == 429
    assert _join(client, staff_code).status_code == 200      # staff door open
    sig = _sig()
    assert sig.get("stand_join_cooloff") == 1 and sig.get("staff_join_cooloff") == 1


def test_successes_do_not_count(client, db):
    owner, c1 = _staff_code(client, db)
    _, c2 = _staff_code(client, db, owner=owner, name="Bo")
    assert _join(client, "ZZZZZZ").status_code == 404
    assert _join(client, c1).status_code == 200
    assert _join(client, c2).status_code == 200
    assert _join(client, "ZZZZZZ").status_code == 404        # 2 failures: no pause
    assert _join(client, "ZZZZZZ").status_code == 404        # the 3rd failure trips it
    assert _join(client, "ZZZZZZ").status_code == 429


def test_failures_spread_wider_than_the_window_do_not_trip(client, db):
    old = time.time() - 700
    main._join_fail_times["staff_join"] = deque([old, old], maxlen=3)
    assert _join(client, "ZZZZZZ").status_code == 404        # 3 kept, oldest 700 s back
    assert _join(client, "ZZZZZZ").status_code == 404        # oldest still 700 s back
    assert main._join_cooloff_until == {}
    # Now three recent failures (the two old ones rolled off): this one trips it.
    assert _join(client, "ZZZZZZ").status_code == 404
    assert _join(client, "ZZZZZZ").status_code == 429


def test_other_paths_and_get_are_not_braked_or_counted(client, db):
    for _ in range(5):
        assert client.post("/api/portal/join/extra", json={}, headers=_ip()).status_code == 404
    for _ in range(5):
        assert client.get("/api/portal/join", headers=_ip()).status_code != 429
    assert main._join_fail_times.get("staff_join") is None   # nothing counted
    for _ in range(3):
        _join(client, "ZZZZZZ")
    assert _join(client, "ZZZZZZ").status_code == 429
    assert client.get("/api/portal/join", headers=_ip()).status_code != 429
    assert client.get("/api/config/features", headers=_ip()).status_code == 200


def test_the_signal_is_bumped_once_per_trip(client, db):
    for _ in range(3):
        _join(client, "ZZZZZZ")
    for _ in range(4):
        assert _join(client, "ZZZZZZ").status_code == 429   # paused requests do not count
    assert _sig().get("staff_join_cooloff") == 1


def test_zero_switches_the_brake_off(client, db, monkeypatch):
    monkeypatch.setattr(settings, "JOIN_FAIL_GLOBAL_MAX", 0)
    codes = {_join(client, "ZZZZZZ").status_code for _ in range(10)}
    assert codes == {404}
    assert main._join_cooloff_until == {}
    assert "staff_join_cooloff" not in _sig()


def test_the_default_matches_the_spec():
    from app.config import Settings
    s = Settings()
    assert (s.JOIN_FAIL_GLOBAL_MAX, s.JOIN_FAIL_WINDOW_SEC, s.JOIN_COOLOFF_SEC) == (300, 600, 60)


def test_the_per_ip_limit_still_applies_and_its_429s_are_not_counted(client, db, monkeypatch):
    monkeypatch.setattr(settings, "JOIN_FAIL_GLOBAL_MAX", 20)
    same = {"CF-Connecting-IP": "10.250.250.250"}
    statuses = [client.post("/api/portal/join", json={"code": "ZZZZZZ"}, headers=same).status_code
                for _ in range(12)]
    assert statuses[:8] == [404] * 8 and set(statuses[8:]) == {429}   # 8/minute per IP
    assert len(main._join_fail_times["staff_join"]) == 8             # only the 404s count
    assert main._join_cooloff_until == {}


# ─── The window is a true sliding window (R-sec fix round) ────────────────
#
# A trip used to clear the failure list, so after each 60 s cool-off the next
# JOIN_FAIL_GLOBAL_MAX wrong codes were evaluated at once: MAX per cool-off
# (300 per ~61 s), not MAX per JOIN_FAIL_WINDOW_SEC (300 per 600 s). Now the
# failures stay until they are older than the window, and a door holding MAX
# of them answers 429 until the oldest ages out.

class _Clock:
    def __init__(self, t: float):
        self.t = t

    def time(self) -> float:
        return self.t

    def __getattr__(self, name):
        return getattr(time, name)


@pytest.fixture
def clock(monkeypatch):
    c = _Clock(1_000_000.0)
    monkeypatch.setattr(main, "_time", c)
    return c


def test_no_more_than_max_wrong_codes_reach_the_handler_per_window(client, db, clock):
    start = clock.t
    statuses, retry_at_100 = [], None
    while clock.t - start < 600:
        r = _join(client, "ZZZZZZ")
        statuses.append(r.status_code)
        if r.status_code != 404:
            if clock.t - start == 100:
                retry_at_100 = int(r.headers["retry-after"])
            clock.t += 1                                      # wait a second, try again
    assert statuses.count(404) == 3                          # MAX per window, not per cool-off
    assert set(statuses) == {404, 429}
    # After the 60 s cool-off the window still holds 3 failures: the answer
    # says how long until the oldest ages out.
    assert retry_at_100 == 501
    assert _sig().get("staff_join_cooloff") == 1             # one trip, one signal
    clock.t = start + 601                                     # the three age out
    assert _join(client, "ZZZZZZ").status_code == 404


def test_a_valid_code_waits_for_the_window_too(client, db, clock):
    _, code = _staff_code(client, db)
    start = clock.t
    for _ in range(3):
        assert _join(client, "ZZZZZZ").status_code == 404
    clock.t = start + 61                                      # past the cool-off ...
    assert _join(client, code).status_code == 429             # ... but the window is full
    clock.t = start + 601
    r = _join(client, code)
    assert r.status_code == 200, r.text


# ─── A slot is reserved BEFORE the handler runs (R-sec fix round) ─────────
#
# The cool-off check ran before the handler and a failure was counted only
# when its 404 came back, so every request admitted before the MAX-th 404
# completed was a real guess: under a flood the overshoot grew with the
# arrival rate. Now recent failures plus requests in flight must stay below
# JOIN_FAIL_GLOBAL_MAX for a request to reach the handler.

@pytest.fixture
def file_client(tmp_path):
    """A file database (many threads at once; the in-memory StaticPool one is
    a single shared connection)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.database import Base, get_db

    eng = create_engine(f"sqlite:///{tmp_path}/join.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)

    def _get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    main.app.dependency_overrides[get_db] = _get_db
    yield
    main.app.dependency_overrides.clear()
    eng.dispose()


def test_a_concurrent_burst_reaches_the_handler_at_most_max_times(file_client, monkeypatch):
    import asyncio
    from collections import Counter

    import httpx

    monkeypatch.setattr(settings, "JOIN_FAIL_GLOBAL_MAX", 5)

    async def go():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            rs = await asyncio.gather(*[
                c.post("/api/portal/join", json={"code": "ZZZZZ" + "ABCDEFGHJK"[i % 10]},
                       headers=_ip())
                for i in range(200)
            ])
            return [r.status_code for r in rs]

    codes = Counter(asyncio.run(go()))
    assert codes[404] <= 5, codes                             # guesses evaluated
    assert codes[404] + codes[429] == 200, codes
    assert main._join_in_flight.get("staff_join", 0) == 0     # every slot released


def test_a_slot_is_released_when_the_handler_succeeds_or_fails(client, db):
    _, code = _staff_code(client, db)
    assert _join(client, code).status_code == 200
    assert main._join_in_flight.get("staff_join", 0) == 0
    assert _join(client, "ZZZZZZ").status_code == 404
    assert main._join_in_flight.get("staff_join", 0) == 0
