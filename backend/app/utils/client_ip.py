"""The client's address: a rate-limit key, and an address for audit rows.

WHERE THE ADDRESS COMES FROM
----------------------------
api.bonbox.dk is a CNAME to bonbox-api.onrender.com. Every public request
passes Render's Cloudflare edge, which sets ``CF-Connecting-IP`` (and on some
plans ``True-Client-IP``) to the address it saw and replaces any value the
client sent. BonBox does not own that Cloudflare: it cannot add headers or
rules there, but it can rely on those two.

uvicorn runs with ``--proxy-headers --forwarded-allow-ips='*'`` (still needed
for X-Forwarded-Proto). With ``'*'`` it copies the LEFTMOST
``X-Forwarded-For`` value into ``request.client`` — the value the client
itself wrote. Before R-sec that was the fallback whenever CF-Connecting-IP
was absent, so a caller could rotate X-Forwarded-For per request.

WHAT THIS MODULE DOES
---------------------
* ``valid_ip`` accepts only a single, well-formed address (max 45 chars, no
  IPv6 zone id; an IPv4-mapped IPv6 becomes the IPv4).
* ``edge_ip`` reads CF-Connecting-IP, then True-Client-IP. Never
  X-Forwarded-For.
* ``client_ip`` is the rate-limit KEY used by every Limiter, the coarse
  ceiling, the admin scan-blocker and the waitlist: the edge address (IPv6
  keyed on its /64, which one subscriber usually holds whole), or ONE shared
  ``"no-edge"`` bucket when the edge header is missing. It is not an address:
  do not store it as one.
* ``request_ip`` is the AUDIT address: ``request.client.host`` validated, or
  None. ``EdgeClientIPMiddleware`` (outermost user middleware) has already set
  ``request.client`` from the edge header, or cleared it when only a
  client-written X-Forwarded-For was there.
* ``CLIENT_IP_FAIL_CLOSED=false`` in Render restores the old behaviour for
  requests without the edge header (kill switch, restart only).

RESIDUAL: a service in the same Render private network could reach the port
directly and send its own CF-Connecting-IP. BonBox runs no such service.
"""
from __future__ import annotations

import ipaddress

from slowapi.util import get_remote_address

from app.config import settings

NO_EDGE = "no-edge"

# Render's health probe and the keep-alive pinger reach the origin without the
# edge header; they are not counted as "no-edge" traffic.
HEALTH_PATHS = frozenset(
    {"/", "/api/health", "/api/health/ready", "/api/health/db", "/api/keepalive"}
)

_MAX_IP_LEN = 45  # longest textual IPv6 (IPv4-mapped form); the column width


def valid_ip(raw) -> str | None:
    """One well-formed IP address in canonical form, or None."""
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("latin-1")
    s = str(raw).strip()
    if not s or len(s) > _MAX_IP_LEN:
        return None
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    if ip.version == 6:
        if ip.scope_id is not None:
            return None
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
    return str(ip)


def edge_ip(headers) -> str | None:
    """The address the edge vouches for: CF-Connecting-IP, then
    True-Client-IP. Never X-Forwarded-For (the client writes that)."""
    if headers is None:
        return None
    try:
        return valid_ip(headers.get("cf-connecting-ip")) or valid_ip(headers.get("true-client-ip"))
    except Exception:  # noqa: BLE001 — a key function must never raise
        return None


def rate_key(ip: str) -> str:
    """IPv4 unchanged; IPv6 keyed on its /64 (at most 24 characters)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 4:
        return ip
    return str(ipaddress.ip_network(f"{addr}/64", strict=False))


def client_ip(request) -> str:
    """Rate-limit key: the edge address (IPv6 → /64), else one shared
    ``"no-edge"`` bucket. With CLIENT_IP_FAIL_CLOSED off, the legacy
    ``get_remote_address`` instead."""
    try:
        headers = request.headers
    except Exception:  # noqa: BLE001
        headers = None
    ip = edge_ip(headers)
    if ip:
        return rate_key(ip)
    if settings.CLIENT_IP_FAIL_CLOSED:
        return NO_EDGE
    return get_remote_address(request)


def request_ip(request) -> str | None:
    """Audit address: ``request.client.host`` if it is a valid IP, else None."""
    try:
        client = request.client if request is not None else None
        return valid_ip(client.host) if client else None
    except Exception:  # noqa: BLE001
        return None
