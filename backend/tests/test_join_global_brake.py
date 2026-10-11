"""Staff join and stand pairing: a short GLOBAL cool-off after a burst of wrong
codes (R-sec, main.join_failure_brake).

THE GAP. POST /api/portal/join and /api/stand/join allow 8/minute per IP.
With N addresses a guesser gets 8·N guesses a minute against 32^6 codes; the
per-IP cap alone scales with the attacker's pool.

NOW. Wrong codes (404s) from ALL addresses together are counted per door:
JOIN_FAIL_GLOBAL_MAX of them within JOIN_FAIL_WINDOW_SEC pause that door for
everyone for JOIN_COOLOFF_SEC — a 429 {"detail": "Too many requests"} with
Retry-After. Successes, per-IP 429s, other paths and GETs are not counted.
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
    assert 1 <= int(r.headers["retry-after"]) <= 61
    assert _sig().get("staff_join_cooloff") == 1


def test_after_the_cool_off_the_valid_code_works(client, db):
    _, code = _staff_code(client, db)
    for _ in range(3):
        _join(client, "ZZZZZZ")
    assert _join(client, code).status_code == 429
    main._join_cooloff_until["staff_join"] = time.time() - 1
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
