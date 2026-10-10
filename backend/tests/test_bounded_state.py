"""R-d memory (10 Oct) — every process-wide per-key dict stays bounded.

Production is one long-lived process (Render 1 CPU / 2 GB). These module-level
dicts gained a key per client IP / e-mail / account / item name and only ever
lost it in special cases, so they grew until the next deploy (a rotating-IP
scanner or a credential-stuffing list grows them without limit):

  main._recent_exception_fingerprints   per IP     (500s)
  main._admin_ip_strikes / _banned       per IP     (4xx on /api/admin)
  main._coarse_hits                      per IP     (had a sweep, no hard cap)
  main._refresh_audit_dedup              per user   (had a sweep, no hard cap)
  waitlist._recent                       per IP
  login_guard._failures / _locked_until  per e-mail
  stripe_billing._LAST_SYNC              per user
  smart_pricing._CACHE                   per (postal, cuisine, item name)

Each now calls app/utils/bounded.py after it writes. What is pinned here, per
dict: it stays at or under its limit under a flood of new keys, the keys that
can no longer decide anything go first, and the decision it exists for (spike
log, ban, 429, lockout, cooldown, cache hit) is unchanged.

Run:
  cd backend && python -m pytest tests/test_bounded_state.py -q
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import timedelta

import pytest
from starlette.requests import Request
from starlette.responses import PlainTextResponse

import app.main as main
from app.routers import waitlist
from app.services import smart_pricing, stripe_billing
from app.utils import login_guard
from app.utils.bounded import bound_stamp_dict, bound_window_dict
from app.utils.time import utc_now

CAP = 50


def _req(path: str, ip: str, method: str = "GET") -> Request:
    return Request({
        "type": "http", "method": method, "path": path, "query_string": b"",
        "headers": [(b"cf-connecting-ip", ip.encode())],
    })


def _ips(n: int, prefix: str = "198.51") -> list[str]:
    return [f"{prefix}.{i // 250}.{i % 250 + 1}" for i in range(n)]


# ─── The two helpers ────────────────────────────────────────────────────

def test_window_helper_is_a_noop_under_the_limit():
    d = {"a": [1.0], "b": []}
    assert bound_window_dict(d, cutoff=10.0, max_keys=2) == 0
    assert d == {"a": [1.0], "b": []}


def test_window_helper_drops_quiet_keys_first_then_the_oldest():
    now = 1000.0
    d = {f"quiet{i}": [now - 120] for i in range(8)}
    d["empty"] = []
    d.update({f"live{i}": [now - 30 + i] for i in range(5)})
    bound_window_dict(d, cutoff=now - 60, max_keys=10)
    assert sorted(d) == [f"live{i}" for i in range(5)]  # quiet + empty gone, every live key kept
    d.update({f"new{i}": [now + i] for i in range(10)})    # 15 live keys > 10
    bound_window_dict(d, cutoff=now - 60, max_keys=10)
    assert len(d) == 9                                     # shrinks to 90%
    assert all(k.startswith("new") for k in d)             # the oldest live keys went


def test_stamp_helper_drops_expired_first_then_the_oldest_and_takes_a_stamp_getter():
    d = {f"old{i}": 5.0 for i in range(6)}
    d.update({f"live{i}": 100.0 + i for i in range(5)})
    bound_stamp_dict(d, stale_before=10.0, max_keys=10)
    assert sorted(d) == [f"live{i}" for i in range(5)]
    t = {f"k{i}": (float(i), {"payload": i}) for i in range(20)}
    bound_stamp_dict(t, stale_before=-1.0, max_keys=10, stamp=lambda v: v[0])
    assert sorted(t, key=lambda k: int(k[1:])) == [f"k{i}" for i in range(11, 20)]


# ─── main.py: 500s per IP ───────────────────────────────────────────────

def test_exception_fingerprints_stay_bounded_and_still_flag_a_spike(monkeypatch, caplog):
    monkeypatch.setattr(main, "_recent_exception_fingerprints", {})
    monkeypatch.setattr(main, "_EXCEPTION_MAX_TRACKED_IPS", CAP)
    stale = time.time() - 600
    main._recent_exception_fingerprints.update({f"quiet{i}": [stale] for i in range(CAP)})
    main._audit_exception_spike("203.0.113.9", "GET:/x:ValueError")
    assert "203.0.113.9" in main._recent_exception_fingerprints
    assert not any(k.startswith("quiet") for k in main._recent_exception_fingerprints)

    for ip in _ips(4 * CAP):
        main._audit_exception_spike(ip, "GET:/x:ValueError")
    assert len(main._recent_exception_fingerprints) <= CAP

    with caplog.at_level(logging.WARNING, logger="bonbox.security"):
        for _ in range(main._EXCEPTION_SPIKE_THRESHOLD):
            main._audit_exception_spike("192.0.2.77", "GET:/scan:KeyError")
    assert any("exception_spike: ip=192.0.2.77" in r.getMessage() for r in caplog.records)


# ─── main.py: /api/admin strikes + bans per IP ──────────────────────────

async def _a_401(_request):
    return PlainTextResponse("no", status_code=401)


def test_admin_strikes_and_bans_stay_bounded_and_a_ban_still_holds(monkeypatch):
    monkeypatch.setattr(main, "_admin_ip_strikes", {})
    monkeypatch.setattr(main, "_admin_ip_banned", {})
    monkeypatch.setattr(main, "_ADMIN_MAX_TRACKED_IPS", CAP)

    async def flood():
        for ip in _ips(4 * CAP):
            await main.admin_scan_blocker(_req("/api/admin/users", ip), _a_401)

    asyncio.run(flood())
    assert len(main._admin_ip_strikes) <= CAP

    # 20 strikes from one scanner still ban it, and the ban is served as a 404
    # without reaching the route.
    async def scanner():
        for _ in range(main._ADMIN_STRIKE_LIMIT):
            await main.admin_scan_blocker(_req("/api/admin/stats", "192.0.2.50"), _a_401)

        async def must_not_run(_r):
            raise AssertionError("a banned IP reached the route")
        return await main.admin_scan_blocker(_req("/api/admin/stats", "192.0.2.50"), must_not_run)

    assert asyncio.run(scanner()).status_code == 404

    # Expired bans are the first to go once the ban dict is full …
    gone = time.time() - 1
    main._admin_ip_banned.update({f"expired{i}": gone for i in range(CAP)})

    async def ban_one_more():
        for _ in range(main._ADMIN_STRIKE_LIMIT):
            await main.admin_scan_blocker(_req("/api/admin/x", "192.0.2.51"), _a_401)

    asyncio.run(ban_one_more())
    assert set(main._admin_ip_banned) == {"192.0.2.50", "192.0.2.51"}

    # … and an expired ban lets the IP through and leaves the dict.
    main._admin_ip_banned["192.0.2.52"] = gone
    seen = []

    async def ok(_r):
        seen.append(1)
        return PlainTextResponse("ok")

    asyncio.run(main.admin_scan_blocker(_req("/api/admin/x", "192.0.2.52"), ok))
    assert seen and "192.0.2.52" not in main._admin_ip_banned


# ─── main.py: the coarse all-paths ceiling per IP ───────────────────────

async def _a_200(_request):
    return PlainTextResponse("ok")


def test_coarse_ceiling_stays_bounded_under_a_flood_of_live_ips(monkeypatch):
    monkeypatch.setattr(main, "_coarse_hits", {})
    monkeypatch.setattr(main, "_COARSE_MAX_TRACKED_IPS", CAP)

    async def flood():
        for ip in _ips(4 * CAP):  # every one of them live inside the window
            await main.coarse_ip_ceiling(_req("/api/sales", ip), _a_200)

    asyncio.run(flood())
    assert len(main._coarse_hits) <= CAP

    monkeypatch.setattr(main, "_COARSE_LIMIT", 3)

    async def one_ip():
        return [
            (await main.coarse_ip_ceiling(_req("/api/sales", "192.0.2.60"), _a_200)).status_code
            for _ in range(4)
        ]

    assert asyncio.run(one_ip()) == [200, 200, 200, 429]


# ─── main.py: refresh-audit dedup per user ──────────────────────────────

def test_refresh_audit_dedup_stays_bounded_and_still_dedups(monkeypatch):
    monkeypatch.setattr(main, "_refresh_audit_dedup", {})
    monkeypatch.setattr(main, "_REFRESH_AUDIT_MAX_USERS", CAP)
    for i in range(4 * CAP):  # all inside the 24 h TTL: the old sweep never got under 5k
        assert main._refresh_audit_should_log(f"user-{i}") is True
    assert len(main._refresh_audit_dedup) <= CAP
    assert main._refresh_audit_should_log(f"user-{4 * CAP - 1}") is False


# ─── waitlist: per-IP join limit ────────────────────────────────────────

def test_waitlist_ip_limit_stays_bounded_and_still_limits(monkeypatch):
    monkeypatch.setattr(waitlist, "_recent", {})
    monkeypatch.setattr(waitlist, "_MAX_TRACKED_IPS", CAP)
    for ip in _ips(4 * CAP):
        assert waitlist._ip_rate_check(_req("/api/waitlist/join", ip, "POST")) is True
    assert len(waitlist._recent) <= CAP
    r = _req("/api/waitlist/join", "192.0.2.70", "POST")
    assert [waitlist._ip_rate_check(r) for _ in range(waitlist._LIMIT_PER_MIN + 1)][-1] is False


# ─── login_guard: per-e-mail failures + locks ───────────────────────────

def test_login_failures_stay_bounded_and_the_lockout_still_holds(monkeypatch):
    monkeypatch.setattr(login_guard, "_failures", {})
    monkeypatch.setattr(login_guard, "_locked_until", {})
    monkeypatch.setattr(login_guard, "_MAX_TRACKED_EMAILS", CAP)
    monkeypatch.setattr(login_guard, "_MAX_LOCKED_EMAILS", CAP)

    # Failures older than the window decide nothing: they go first.
    old = time.time() - login_guard._WINDOW_SECONDS - 5
    login_guard._failures.update({f"stale{i}@x.dk": [old] for i in range(CAP)})
    login_guard.record_failure("fresh@x.dk")
    assert set(login_guard._failures) == {"fresh@x.dk"}

    for i in range(4 * CAP):  # a credential-stuffing list of new e-mails
        login_guard.record_failure(f"random{i}@example.com")
    assert len(login_guard._failures) <= CAP

    for _ in range(login_guard._MAX_FAILURES):
        login_guard.record_failure("owner@cafe.dk")
    assert login_guard.is_locked_out("owner@cafe.dk") is True

    # Locks that have run out go first once the lock dict is full.
    gone = time.time() - 1
    login_guard._locked_until.update({f"expired{i}@x.dk": gone for i in range(CAP)})
    for _ in range(login_guard._MAX_FAILURES):
        login_guard.record_failure("second@cafe.dk")
    assert set(login_guard._locked_until) == {"owner@cafe.dk", "second@cafe.dk"}
    assert login_guard.is_locked_out("owner@cafe.dk") is True


# ─── stripe_billing: per-account sync cooldown ──────────────────────────

def test_stripe_sync_cooldown_stays_bounded_and_still_cools_down(monkeypatch):
    monkeypatch.setattr(stripe_billing, "_LAST_SYNC", {})
    monkeypatch.setattr(stripe_billing, "_LAST_SYNC_MAX_USERS", CAP)
    long_ago = utc_now() - timedelta(hours=2)
    stripe_billing._LAST_SYNC.update({f"old-{i}": long_ago for i in range(CAP)})
    stripe_billing._stamp_sync("acct-new")
    assert set(stripe_billing._LAST_SYNC) == {"acct-new"}
    assert stripe_billing._sync_cooldown_active("acct-new") is True
    assert stripe_billing._sync_cooldown_active("never-synced") is False

    for i in range(4 * CAP):
        stripe_billing._stamp_sync(f"acct-{i}")
    assert len(stripe_billing._LAST_SYNC) <= CAP
    assert stripe_billing._sync_cooldown_active(f"acct-{4 * CAP - 1}") is True


def test_sync_from_stripe_still_skips_inside_the_cooldown(monkeypatch):
    monkeypatch.setattr(stripe_billing, "_LAST_SYNC", {})
    monkeypatch.setattr(stripe_billing, "_stripe", lambda: object())
    user = type("U", (), {"id": "acct-cool"})()
    stripe_billing._stamp_sync("acct-cool")
    assert stripe_billing.sync_user_subscription_from_stripe(user, db=None) == {
        "status": "skipped", "reason": "cooldown",
    }


# ─── smart_pricing: cohort cache per (postal, cuisine, item) ────────────

def test_smart_pricing_cache_stays_bounded_and_still_hits(monkeypatch):
    monkeypatch.setattr(smart_pricing, "_CACHE", {})
    monkeypatch.setattr(smart_pricing, "_CACHE_MAX_ENTRIES", CAP)
    expired = time.time() - 1
    smart_pricing._CACHE.update({("2200", "cafe", f"gone{i}"): (expired, {}) for i in range(CAP)})
    smart_pricing._cache_set(("2200", "cafe", "latte"), {"n": 7})
    assert list(smart_pricing._CACHE) == [("2200", "cafe", "latte")]

    for i in range(4 * CAP):  # a new item name per request
        smart_pricing._cache_set(("2200", "cafe", f"item {i}"), {"n": i})
    assert len(smart_pricing._CACHE) <= CAP
    assert smart_pricing._cache_get(("2200", "cafe", f"item {4 * CAP - 1}")) == {"n": 4 * CAP - 1}
