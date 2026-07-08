"""Trusted client-IP derivation for rate-limiting + audit forensics.

WHY THIS EXISTS
---------------
The API runs behind Cloudflare (verified: responses carry `cf-ray`), and
uvicorn is launched with ``--proxy-headers --forwarded-allow-ips='*'``. With
``trusted_hosts='*'`` uvicorn's ProxyHeadersMiddleware trusts the *leftmost*
``X-Forwarded-For`` hop — which is the value the ORIGINAL CLIENT put there.
So ``request.client.host`` (what slowapi's ``get_remote_address`` returns) is
fully attacker-controlled: a caller can send ``X-Forwarded-For: <anything>``
and rotate it every request to defeat every per-IP rate limit (login
brute-force throttle, OCR/AI cost caps, the admin IP-ban) and to poison every
audit/SecurityEvent IP field.

THE FIX
-------
Cloudflare sets ``CF-Connecting-IP`` to the true client IP and OVERWRITES any
client-supplied value, so a client cannot forge it past the Cloudflare edge.
Prefer it. Fall back to ``get_remote_address`` for local/dev (no Cloudflare)
and any non-proxied path.

RESIDUAL HARDENING (ops, not code): the Render origin should only accept
traffic from Cloudflare (Authenticated Origin Pulls / IP allowlist) so an
attacker can't bypass Cloudflare and hit the origin directly with a forged
``CF-Connecting-IP``. Until then, the per-account login lockout
(``login_guard``) is the spoof-proof backstop.
"""
from slowapi.util import get_remote_address


def client_ip(request) -> str:
    """Best-trusted client IP for rate-limit keys and audit rows.

    Prefers the Cloudflare-set ``CF-Connecting-IP`` (unforgeable past the CF
    edge); falls back to the connection/XFF address for non-proxied requests.
    """
    try:
        cf = request.headers.get("cf-connecting-ip")
    except Exception:
        cf = None
    if cf:
        return cf.strip()
    return get_remote_address(request)
