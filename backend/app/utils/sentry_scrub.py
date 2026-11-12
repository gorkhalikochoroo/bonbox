"""What an error report may carry to Sentry (only when SENTRY_DSN is set).

/privacy says BonBox uses a clock-in's coordinates only for the distance check
and does not save them, and the staff app's location prompt says the location
is never stored. error_logs keeps no link token (log_redact). Sentry is a
third party that stores what it gets, so an error report must keep the same
promises. With the SDK defaults it did not: a 500 in
POST /api/portal/<token>/clock-in sent

  • the JSON body {lat, lng, accuracy} as request.data. FastApiIntegration
    attaches the body whatever send_default_pii says;
  • the local variables of every frame, and portal_clock_in holds lat, lng
    and body;
  • the staff link token in the request URL, the Referer, the logged
    "Unhandled exception in POST /api/portal/<token>/…" line and the frames.

SENTRY_PRIVACY_OPTIONS turns off the body and the local variables, and
scrub_event (before_send and before_send_transaction) drops request.data and
frame variables again and redacts tokens in every string, whatever an
integration adds. If scrubbing fails, the event is dropped, not sent raw.
Pinned by tests/test_sentry_scrub.py.

Address lookups (services/address_lookup.py): Sentry's httpx integration
records each outbound call as a breadcrumb / span whose `http.query` is the
raw query string — the owner's address, and KDS's token. The token there is
the FIRST parameter of nothing we control, so `http.query` is scrubbed with a
leading "?" (redact_text only matches "?token=" / "&token="), and for the two
geo hosts the address values (adresse, tekst, vejnavn, husnummer,
postnummer, q, street, postalcode, city) are dropped wherever a URL or query
to them appears.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from app.utils.log_redact import redact_text

_GEO_HOSTS = frozenset({"adressevaelger.dk", "nominatim.openstreetmap.org"})
_GEO_PARAMS = frozenset({"adresse", "tekst", "vejnavn", "husnummer", "postnummer",
                         "q", "street", "postalcode", "city"})
_GEO_URL = re.compile(
    r"(?i)(https?://(?:adressevaelger\.dk|nominatim\.openstreetmap\.org)[^\s?#\"']*\?)([^\s#\"']*)"
)


def _drop_geo_values(query: str) -> str:
    """"adresse=Vestergade+1&token=x" -> "adresse=:redacted&token=x"."""
    out = []
    for part in query.split("&"):
        key, sep, _val = part.partition("=")
        out.append(f"{key}=:redacted" if sep and key.lower() in _GEO_PARAMS else part)
    return "&".join(out)


def _scrub_geo_text(text: str) -> str:
    return _GEO_URL.sub(lambda m: m.group(1) + _drop_geo_values(m.group(2)), text)


def _is_geo_url(url: Any) -> bool:
    try:
        return (urlparse(str(url or "")).hostname or "").lower() in _GEO_HOSTS
    except ValueError:
        return False


def _scrub_http_query(value: Any) -> None:
    """Breadcrumb / span data dicts: `http.query` carries no "?", so a token
    in first place escaped redact_text; and a geo host's query is an address."""
    if isinstance(value, dict):
        q = value.get("http.query")
        if isinstance(q, str) and q:
            if _is_geo_url(value.get("url")):
                q = _drop_geo_values(q)
            value["http.query"] = redact_text("?" + q)[1:]
        for v in value.values():
            _scrub_http_query(v)
    elif isinstance(value, list):
        for v in value:
            _scrub_http_query(v)


def _redact_strings(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(_scrub_geo_text(value))
    if isinstance(value, dict):
        return {k: _redact_strings(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_strings(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_strings(v) for v in value)
    return value


def _drop_frame_vars(value: Any) -> None:
    """Remove "vars" (a frame's local variables) wherever a frame list sits."""
    if isinstance(value, dict):
        frames = value.get("frames")
        if isinstance(frames, list):
            for frame in frames:
                if isinstance(frame, dict):
                    frame.pop("vars", None)
        for v in value.values():
            _drop_frame_vars(v)
    elif isinstance(value, list):
        for v in value:
            _drop_frame_vars(v)


def scrub_event(event: dict, hint: dict | None = None) -> dict | None:
    """before_send / before_send_transaction: no request body, no frame
    variables, no link token. Returns None (drop the event) if it cannot."""
    try:
        request = event.get("request")
        if isinstance(request, dict):
            request.pop("data", None)
            qs = request.get("query_string")
            if isinstance(qs, str) and qs:  # "t=<token>&x=1", no leading "?"
                request["query_string"] = redact_text("?" + qs)[1:]
        _drop_frame_vars(event)
        _scrub_http_query(event)
        return _redact_strings(event)
    except Exception:  # noqa: BLE001 — never send an event we could not scrub
        return None


SENTRY_PRIVACY_OPTIONS: dict[str, Any] = {
    "send_default_pii": False,           # no IPs, cookies or user ids
    "max_request_body_size": "never",    # no request body (clock-in lat/lng)
    "include_local_variables": False,    # no frame locals (lat, lng, token)
    "before_send": scrub_event,
    "before_send_transaction": scrub_event,
}
