"""client_ip(): the rate-limit key holds when a caller rotates X-Forwarded-For.

THE DEFECT (before R-sec). uvicorn runs with --forwarded-allow-ips='*', so it
copies the LEFTMOST X-Forwarded-For value — written by the client — into
request.client. client_ip() fell back to that whenever CF-Connecting-IP was
missing, and returned CF-Connecting-IP unvalidated. A caller rotating
X-Forwarded-For got a fresh allowance on every per-IP limit.

NOW. Only the edge headers (CF-Connecting-IP, then True-Client-IP) count, and
only a single valid address. Without one, every request shares ONE "no-edge"
bucket. IPv6 is keyed on its /64. CLIENT_IP_FAIL_CLOSED=false restores the
legacy fallback (kill switch).
"""
from __future__ import annotations

import pytest
from starlette.requests import Request

from app.config import settings
from app.utils.client_ip import (
    HEALTH_PATHS,
    NO_EDGE,
    client_ip,
    edge_ip,
    rate_key,
    request_ip,
    valid_ip,
)


def _req(headers: dict | None = None, client=("10.0.0.1", 0), path: str = "/api/x") -> Request:
    raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
    return Request({
        "type": "http", "method": "GET", "path": path, "query_string": b"",
        "headers": raw, "client": client,
    })


# ─── valid_ip ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, expected", [
    ("203.0.113.5", "203.0.113.5"),
    (" 203.0.113.5 ", "203.0.113.5"),
    ("2001:DB8::1", "2001:db8::1"),
    ("::ffff:203.0.113.5", "203.0.113.5"),
    ("10.1.2.3", "10.1.2.3"),          # private addresses are allowed
    ("127.0.0.1", "127.0.0.1"),
])
def test_valid_ip_accepts_one_address_in_canonical_form(raw, expected):
    assert valid_ip(raw) == expected


@pytest.mark.parametrize("raw", [
    "fe80::1%eth0",
    "fe80::1%" + "x" * 80,
    "1.2.3.4, 5.6.7.8",
    "not-an-ip",
    "",
    "   ",
    "1" * 46,
    None,
    "testclient",
])
def test_valid_ip_rejects_everything_else(raw):
    assert valid_ip(raw) is None


def test_a_46_character_string_is_refused_before_parsing():
    s = "2001:0db8:0000:0000:0000:0000:0000:0001" + "0" * 7
    assert len(s) == 46
    assert valid_ip(s) is None


# ─── client_ip: which header wins ─────────────────────────────────────

def test_a_valid_cf_connecting_ip_wins_over_true_client_ip():
    r = _req({"CF-Connecting-IP": "203.0.113.5", "True-Client-IP": "198.51.100.7"})
    assert client_ip(r) == "203.0.113.5"


def test_an_invalid_cf_connecting_ip_falls_to_true_client_ip():
    r = _req({"CF-Connecting-IP": "garbage, 1.2.3.4", "True-Client-IP": "198.51.100.7"})
    assert client_ip(r) == "198.51.100.7"


def test_x_forwarded_for_alone_is_never_the_key():
    r = _req({"X-Forwarded-For": "6.6.6.6"}, client=("6.6.6.6", 0))
    assert client_ip(r) == NO_EDGE
    assert client_ip(r) != "6.6.6.6"


def test_rotating_x_forwarded_for_shares_one_bucket():
    keys = {client_ip(_req({"X-Forwarded-For": f"6.6.6.{i}"}, client=(f"6.6.6.{i}", 0)))
            for i in range(1, 20)}
    assert keys == {NO_EDGE}


def test_no_headers_is_the_no_edge_bucket():
    assert client_ip(_req()) == NO_EDGE
    assert client_ip(_req(client=None)) == NO_EDGE


def test_cf_value_is_stripped_and_canonical():
    assert client_ip(_req({"CF-Connecting-IP": "  203.0.113.5 "})) == "203.0.113.5"


def test_two_addresses_in_one_ipv6_64_share_a_key():
    a = client_ip(_req({"CF-Connecting-IP": "2001:db8:1:2::5"}))
    b = client_ip(_req({"CF-Connecting-IP": "2001:db8:1:2:ffff::9"}))
    assert a == b == "2001:db8:1:2::/64"
    assert len(a) <= 24


def test_different_ipv6_64s_get_different_keys():
    a = client_ip(_req({"CF-Connecting-IP": "2001:db8:1:2::5"}))
    b = client_ip(_req({"CF-Connecting-IP": "2001:db8:1:3::5"}))
    assert a != b


def test_rate_key_leaves_ipv4_alone_and_caps_ipv6_length():
    assert rate_key("203.0.113.5") == "203.0.113.5"
    widest = rate_key("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
    assert widest == "ffff:ffff:ffff:ffff::/64" and len(widest) == 24


def test_kill_switch_restores_the_legacy_address(monkeypatch):
    monkeypatch.setattr(settings, "CLIENT_IP_FAIL_CLOSED", False)
    r = _req({"X-Forwarded-For": "6.6.6.6"}, client=("6.6.6.6", 0))
    assert client_ip(r) == "6.6.6.6"            # what get_remote_address returns
    # The edge header still wins with the switch off.
    assert client_ip(_req({"CF-Connecting-IP": "203.0.113.5"})) == "203.0.113.5"


def test_edge_ip_never_reads_x_forwarded_for():
    assert edge_ip(_req({"X-Forwarded-For": "203.0.113.5"}).headers) is None
    assert edge_ip(None) is None


def test_client_ip_never_raises_on_an_odd_request():
    class _Odd:
        @property
        def headers(self):
            raise RuntimeError("boom")
        client = None
    assert client_ip(_Odd()) == NO_EDGE


# ─── request_ip: the audit address ────────────────────────────────────

def test_request_ip_refuses_the_testclient_placeholder():
    assert request_ip(_req(client=("testclient", 50000))) is None


def test_request_ip_returns_a_valid_host():
    assert request_ip(_req(client=("10.0.0.1", 0))) == "10.0.0.1"


def test_request_ip_none_safe():
    assert request_ip(None) is None
    assert request_ip(_req(client=None)) is None


# ─── one list of health paths ─────────────────────────────────────────

def test_health_paths_match_the_coarse_and_origin_guard_exemptions():
    import app.main as main
    assert HEALTH_PATHS == main._COARSE_EXEMPT == main._ORIGIN_GUARD_EXEMPT
