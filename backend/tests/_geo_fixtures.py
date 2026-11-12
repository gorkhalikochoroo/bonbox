"""Recorded REAL replies from KDS Adressevælger/Adressevask and Nominatim,
served through httpx.MockTransport (built in; no new dependency).

Recorded on 11 Nov 2026 (Step 0 of the DAWA replacement plan) for generic
public addresses only — town halls, museums, squares and KDS's own
documentation examples. The token was removed from every request. Hand-written
stubs alone "assert a fiction" (gotcha), so the parsers are tested against
these; a synthetic reply is used only where no real one can exist (a 401, a
timeout, KDS bug 12, which did not reproduce).

    transport = GeoReplay()
    address_lookup.set_transport(transport.mock)
    ...
    transport.calls      -> [(host, path, params-without-token), ...]
    transport.unmatched  -> requests no recording answers (served as 599)
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import httpx

_DIR = Path(__file__).resolve().parent / "geo_fixtures"
KDS = json.loads((_DIR / "kds.json").read_text(encoding="utf-8"))["cases"]
OSM = json.loads((_DIR / "osm.json").read_text(encoding="utf-8"))["cases"]
# 12 Nov 2026, the venue-country lookup: each case names its host.
FOREIGN = json.loads((_DIR / "foreign.json").read_text(encoding="utf-8"))["cases"]

TEST_TOKEN = "test-token-not-real-0000"


def _key(host: str, path: str, params: dict) -> tuple:
    return (host, path, tuple(sorted((k, str(v)) for k, v in params.items())))


_INDEX: dict[tuple, dict] = {}
for _name, _c in KDS.items():
    _INDEX.setdefault(_key("adressevaelger.dk", _c["path"], _c["params"]), _c)
for _name, _c in OSM.items():
    _INDEX.setdefault(_key("nominatim.openstreetmap.org", _c["path"], _c["params"]), _c)
for _name, _c in FOREIGN.items():
    _INDEX.setdefault(_key(_c["host"], _c["path"], _c["params"]), _c)


def kds(name: str) -> dict:
    return KDS[name]


def osm(name: str) -> dict:
    return OSM[name]


def foreign(name: str) -> dict:
    return FOREIGN[name]


def reply(case: dict) -> httpx.Response:
    headers = {}
    if case.get("content_type"):
        headers["content-type"] = case["content_type"]
    return httpx.Response(case["status"], content=case["body"].encode("utf-8"), headers=headers)


class GeoReplay:
    """A MockTransport that answers each request with the recording made for
    exactly that host, path and parameter set.

    `overrides` maps (host, path) or (host, path, frozen params) to a
    callable(request) -> httpx.Response, for synthetic cases.
    """

    def __init__(self, overrides: dict | None = None, *, expect_token: str | None = TEST_TOKEN):
        self.calls: list[tuple] = []
        self.unmatched: list[tuple] = []
        self.token_positions: list[bool] = []
        self.overrides = dict(overrides or {})
        self.expect_token = expect_token
        self.mock = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = urlsplit(str(request.url))
        pairs = parse_qsl(url.query, keep_blank_values=True)
        host = url.hostname
        if host == "adressevaelger.dk":
            # The token is always the LAST parameter (redact_text and the
            # Sentry scrub rely on "&token=").
            self.token_positions.append(bool(pairs) and pairs[-1][0] == "token")
            if self.expect_token is not None:
                assert pairs and pairs[-1] == ("token", self.expect_token)
        params = {k: v for k, v in pairs if k != "token"}
        self.calls.append((host, url.path, params))
        for key in ((host, url.path, tuple(sorted(params.items()))), (host, url.path)):
            if key in self.overrides:
                return self.overrides[key](request)
        case = _INDEX.get(_key(host, url.path, params))
        if case is None:
            self.unmatched.append((host, url.path, params))
            return httpx.Response(599, content=b"no recording")
        return reply(case)

    def paths(self, host: str | None = None) -> list[str]:
        return [p for h, p, _ in self.calls if host is None or h == host]


# ── shared pytest fixture: lookups ON, served by the recordings ──────────

import pytest  # noqa: E402


@pytest.fixture
def geo_on(monkeypatch):
    """Token set, register on, OpenStreetMap on, the replay transport installed and the
    Nominatim spacing sleep skipped. Call it to install a GeoReplay:

        t = geo_on()                       # recordings only
        t = geo_on({(host, path): fn})     # plus synthetic overrides
    """
    from app.config import settings
    from app.services import address_lookup as al

    monkeypatch.setattr(settings, "ADDRESS_REGISTER_TOKEN", TEST_TOKEN)
    monkeypatch.setattr(settings, "ADDRESS_REGISTER_ENABLED", True)
    monkeypatch.setattr(settings, "GEO_OSM_ENABLED", True)
    monkeypatch.setattr(al, "_sleep", lambda s: None)
    al.reset_state()

    def install(overrides=None):
        t = GeoReplay(overrides)
        al.set_transport(t.mock)
        return t

    yield install
    al.set_transport(None)
    al.reset_state()
