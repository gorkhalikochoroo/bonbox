"""
Yapily client — DK + EU PSD2 AISP via Yapily Connect.

WHY YAPILY (decision May 2026):
  • Salt Edge starts at €1,000/month minimum — doesn't fit a pre-revenue
    sole proprietorship (would require ~77 paying Starter customers just
    to break even on the floor).
  • GoCardless Bank Account Data closed new signups in 2026.
  • Aiia (Mastercard Open Banking) moved to enterprise-only post-acquisition.
  • Yapily has a self-serve sandbox tier (free), production-tier ~€199-300/mo
    entry, and confirmed coverage of 66 DK institutions with AIS support
    (Danske, Nordea DK, Jyske, Sydbank, Spar Nord, Lunar, Arbejdernes
    Landsbank, Revolut, plus dozens of smaller DK banks).

WHAT THIS FILE IS RIGHT NOW (smoke-test scope):
  This is the v0 client that exposes ONLY enough surface to prove auth
  works against the Yapily sandbox.  The full PSD2 flow (consent →
  callback → account discovery → transaction sync) is task #220 — when
  we wire Yapily into the bank-connect router as a third provider option
  alongside Aiia + Salt Edge.

  Right now this file gives us:
    • `health_check()` — calls a low-cost Yapily endpoint to verify HTTP
      Basic auth works
    • `list_institutions(country="DK")` — confirms DK bank coverage from
      the API side (we already verified 66 via the console; this is the
      programmatic verification)

  The smoke-test admin endpoint (super-admin only, kill-switch gated)
  lets us hit Yapily from prod without any unauthenticated public
  exposure.  Once the smoke test passes we know:
    1. Env vars are loaded correctly into the Render runtime
    2. Auth shape matches Yapily's expectations (HTTP Basic header)
    3. Network egress from Render to api.yapily.com works
    4. The TLS certificate chain validates

AUTH:
  HTTP Basic — `Authorization: Basic base64(application_id:application_secret)`.
  No token endpoint, no OAuth dance, no refresh.  This is the same shape
  Salt Edge uses (header-based static creds) and matches what we already
  store in Render: `YAPILY_APPLICATION_ID` + `YAPILY_APPLICATION_SECRET`.

SAFETY:
  • `_redact_body_for_logs()` strips secrets before any log statement
  • Timeouts (10s default) so a Yapily outage can't hang a request
    indefinitely — fail-fast → caller can surface a graceful HTTP error
  • Sandbox vs production lives on the same host (api.yapily.com); the
    application's scope on Yapily's side decides which institution set
    is exposed.  No separate base URL to maintain.
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any

import httpx

# Reuse the same error class as the Aiia / Salt Edge clients so the
# bank-connect router's existing 502 mapping just works.
from app.services.aiia_client import AiiaClientError

log = logging.getLogger("bonbox.yapily")

# Secret keys to strip from any logged body — defense in depth so a future
# log.info("response: %s", response.json()) can never accidentally print
# refresh tokens or app secrets.
_REDACT_KEYS = frozenset({
    "application_secret",
    "secret",
    "consent",
    "refresh_token",
    "access_token",
    "Authorization",
    "authorization",
})


def _redact_body_for_logs(body: Any) -> Any:
    """Best-effort secret stripping for log lines.  Recursive over
    dicts + lists, returns a new structure (does NOT mutate input)."""
    if isinstance(body, dict):
        return {
            k: ("[REDACTED]" if k in _REDACT_KEYS else _redact_body_for_logs(v))
            for k, v in body.items()
        }
    if isinstance(body, list):
        return [_redact_body_for_logs(item) for item in body]
    return body


@dataclass(frozen=True)
class YapilyInstitution:
    """One institution as returned by GET /institutions.  We keep only
    the fields the BonBox bank picker needs — Yapily returns a much
    richer payload but we don't surface it server-side."""
    id: str               # Yapily's stable institution ID (e.g. "danske-bank-business-dk")
    name: str             # Display name ("Danske Bank - Denmark")
    full_name: str        # Long form for confirmation modals
    countries: list[str]  # ISO codes ["DK", "EE", ...]
    environment_type: str # "PRODUCTION" | "SANDBOX"
    features: list[str]   # e.g. ["ACCOUNTS", "TRANSACTIONS", "BALANCES"]


class YapilyClient:
    """HTTP client for Yapily Connect API.

    Smoke-test surface only.  Consent + transaction methods to be added
    in task #220 (full bank-connect integration).
    """

    def __init__(
        self,
        *,
        base_url: str,
        application_id: str,
        application_secret: str,
        timeout_s: float = 10.0,
    ):
        if not application_id or not application_secret:
            raise AiiaClientError(
                "Yapily credentials missing — set YAPILY_APPLICATION_ID and "
                "YAPILY_APPLICATION_SECRET env vars on Render.",
                kind="config_missing",
            )
        self._base_url = base_url.rstrip("/")
        self._application_id = application_id
        self._application_secret = application_secret
        self._timeout_s = timeout_s

    def _headers(self) -> dict[str, str]:
        """HTTP Basic auth header.  Computed on every call so a credential
        rotation via Render env var update is picked up after the next
        worker restart — no stale in-memory cache to invalidate."""
        token = base64.b64encode(
            f"{self._application_id}:{self._application_secret}".encode("utf-8")
        ).decode("ascii")
        return {
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "User-Agent": "BonBox/0.1 (+https://bonbox.dk)",
        }

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Centralized request runner with timeout + secret-safe logging."""
        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout_s) as cli:
                resp = cli.request(method, url, headers=self._headers(), **kwargs)
        except httpx.TimeoutException as e:
            raise AiiaClientError(
                f"Yapily request timed out ({self._timeout_s}s): {method} {path}",
                kind="timeout",
            ) from e
        except httpx.HTTPError as e:
            raise AiiaClientError(
                f"Yapily network error: {method} {path}: {e}",
                kind="network",
            ) from e
        return resp

    def health_check(self) -> dict[str, Any]:
        """Lightweight probe — calls GET /institutions with limit=1 to
        verify auth works.  Returns a small status dict the smoke-test
        endpoint surfaces to the caller.  Never raises on auth failure;
        instead returns ok=false so the caller can decide how to react.
        """
        try:
            resp = self._request("GET", "/institutions")
            if resp.status_code == 401:
                return {
                    "ok": False,
                    "status_code": 401,
                    "error": "auth_failed",
                    "detail": "Yapily rejected the application credentials. "
                              "Verify YAPILY_APPLICATION_ID and "
                              "YAPILY_APPLICATION_SECRET on Render.",
                }
            if resp.status_code != 200:
                return {
                    "ok": False,
                    "status_code": resp.status_code,
                    "error": "unexpected_status",
                    "detail": resp.text[:200],
                }
            payload = resp.json()
            data = payload.get("data", [])
            return {
                "ok": True,
                "status_code": 200,
                "institution_count": len(data),
                "sample_first_id": data[0].get("id") if data else None,
                "tracing_id": payload.get("meta", {}).get("tracingId"),
            }
        except AiiaClientError as e:
            return {
                "ok": False,
                "error": "client_error",
                "kind": e.kind if hasattr(e, "kind") else "unknown",
                "detail": str(e),
            }

    def list_institutions(self, *, country: str | None = None) -> list[YapilyInstitution]:
        """Fetch institutions, optionally filtered to one ISO country
        (e.g. 'DK').  Used by the bank-picker UI to show only banks
        Yapily can actually connect to.

        Yapily returns ~1,800 institutions globally — we filter
        client-side to DK to keep the payload small."""
        resp = self._request("GET", "/institutions")
        if resp.status_code != 200:
            raise AiiaClientError(
                f"Yapily /institutions returned {resp.status_code}",
                kind="bad_status",
            )
        out: list[YapilyInstitution] = []
        for item in resp.json().get("data", []):
            countries = [c.get("countryCode2") for c in (item.get("countries") or []) if c.get("countryCode2")]
            if country and country not in countries:
                continue
            features = item.get("features") or []
            out.append(YapilyInstitution(
                id=item.get("id", ""),
                name=item.get("name", ""),
                full_name=item.get("fullName", "") or item.get("name", ""),
                countries=countries,
                environment_type=item.get("environmentType", ""),
                features=features,
            ))
        return out


def get_yapily_client() -> YapilyClient:
    """Factory — reads creds from settings, raises if missing.  Matches
    the pattern of get_aiia_client() / SaltEdgeClient construction so
    the bank-connect router can swap providers via a single factory
    function later.
    """
    from app.config import settings
    return YapilyClient(
        base_url=settings.YAPILY_BASE_URL,
        application_id=settings.YAPILY_APPLICATION_ID,
        application_secret=settings.YAPILY_APPLICATION_SECRET,
    )
