"""
Aiia (Mastercard Open Banking) client abstraction — task #67.

Three implementations behind one Protocol:

  • MockAiiaClient    — hand-crafted in-process responses. Default
                        when AIIA_ENV='mock' (the default). Zero
                        network, deterministic for tests + local dev.
                        Returns 3 synthetic DKK transactions on every
                        list_transactions call (Lyngby invoice match +
                        rent + Wolt) so reconciliation tests have
                        something to chew on.

  • SandboxAiiaClient — points at Aiia's sandbox endpoints (no real
                        bank, simulated accounts). Requires
                        AIIA_CLIENT_ID + AIIA_CLIENT_SECRET +
                        AIIA_BASE_URL env vars. Used when we want to
                        exercise the real HTTP shape without burning
                        production consent.

  • LiveAiiaClient    — production endpoints. Same code path as
                        sandbox, different base URL. Activated when
                        AIIA_ENV='live' AND creds are present.

Defensive design notes:
  • The real Aiia request/response shapes aren't fully documented
    publicly — the spec at docs/aiia-integration-spec.md notes we
    should pull the Postman collection on day 1 of v0.2. For v0.1
    (this implementation), the sandbox + live clients raise
    NotImplementedError on real network calls so we ship a known-
    safe surface. The mock client implements every method end-to-end.
  • All methods return plain dicts so the router doesn't depend on
    SDK objects we'd have to mock in tests.
  • Errors raise AiiaClientError — the router maps to 502 Bad Gateway
    so callers can distinguish "Aiia is broken" from "you gave me bad
    input".
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Protocol

logger = logging.getLogger(__name__)


# ─── Exception ─────────────────────────────────────────────────────────


class AiiaClientError(RuntimeError):
    """Raised on any Aiia API failure. Carries an HTTP-ish status hint
    so the router can map sensibly."""

    def __init__(self, message: str, *, status: int = 502, kind: str = "unknown"):
        super().__init__(message)
        self.status = status
        self.kind = kind


# ─── Response shape ────────────────────────────────────────────────────


@dataclass
class AiiaTransaction:
    """Simplified Aiia transaction. Fields chosen to map directly into
    our Sale / Expense rows during sync."""

    aiia_txn_id: str       # unique per-account txn id from Aiia
    booked_date: date      # the date Aiia booked it ("bookingDate")
    amount: float          # positive = inflow (Sale); negative = outflow (Expense)
    currency: str          # ISO 4217, e.g. "DKK"
    description: str       # bank-supplied free text
    counterparty: str      # name of the other party where Aiia can resolve it

    def to_dict(self) -> dict:
        return {
            "aiia_txn_id": self.aiia_txn_id,
            "booked_date": self.booked_date.isoformat(),
            "amount": self.amount,
            "currency": self.currency,
            "description": self.description,
            "counterparty": self.counterparty,
        }


# ─── Protocol ──────────────────────────────────────────────────────────


class AiiaClient(Protocol):
    """The interface every implementation must honour. Used by the
    router + cron — both stay decoupled from which backend (mock /
    sandbox / live) is wired in."""

    def init_consent(self, redirect_uri: str, state: str, *, bank_slug: str | None = None) -> str:
        """Return the URL the owner must visit at their bank's SCA
        flow. `state` MUST round-trip back to our callback unchanged."""
        ...

    def exchange_code(self, code: str) -> dict:
        """Trade an authorization code for tokens + account info.
        Returns: {
          "account_id": str,
          "account_label": str | None,
          "refresh_token": str,
          "expires_in": int,        # seconds (consent TTL — ~90d / 7776000)
        }"""
        ...

    def list_transactions(
        self, account_id: str, since: datetime | None,
    ) -> list[AiiaTransaction]:
        """Fetch booked transactions since `since` (None = all). Aiia
        caps lookback at ~13 months on most banks."""
        ...

    def refresh(self, refresh_token: str) -> dict:
        """Exchange a refresh token for a fresh access token. Returns
        the same shape as exchange_code minus account_id (already
        known)."""
        ...

    def revoke(self, account_id: str) -> None:
        """Tell Aiia the owner has revoked consent. Idempotent — no-op
        if already revoked."""
        ...


# ─── Mock implementation ───────────────────────────────────────────────


class MockAiiaClient:
    """In-process fake. Hand-crafted responses. Default for tests + local
    dev so contributors can exercise the full flow without Aiia creds.

    State (mock_state dict) is process-local — TestClient + fixtures
    can prime/assert it. Nothing here ever touches the network."""

    # Process-wide state so tests can inspect what was called.
    # `_consents`: state token → {redirect_uri, bank_slug, used}
    # `_revoked`: set of account_ids that have been revoked
    _consents: dict[str, dict] = {}
    _revoked: set[str] = set()
    # Optional override for list_transactions return — tests can monkey-
    # patch this to inject a specific transaction list. Cleared per fixture.
    _txns_override: dict[str, list[AiiaTransaction]] = {}

    def __init__(self, base_url: str = "mock://aiia"):
        self.base_url = base_url

    def init_consent(self, redirect_uri: str, state: str, *, bank_slug: str | None = None) -> str:
        # Stash so exchange_code can replay.
        self._consents[state] = {
            "redirect_uri": redirect_uri,
            "bank_slug": bank_slug,
            "used": False,
            "code": "mock_code_" + secrets.token_hex(8),
        }
        # The mock "consent URL" is a deterministic local-ish URL the
        # frontend can recognize. Tests intercept this anyway.
        return f"{self.base_url}/consent?state={state}&bank={bank_slug or 'unknown'}"

    def exchange_code(self, code: str) -> dict:
        # Find the matching state by stored code. Allows the test
        # client to call /callback?code=...&state=... and we'll match
        # them up. If no state is found (mock client used in a
        # different way), still return a deterministic response.
        matching_state = None
        for st, data in self._consents.items():
            if data.get("code") == code:
                matching_state = st
                data["used"] = True
                break
        if matching_state is None:
            # Test may have called callback with a known-bad code —
            # raise to mirror real-Aiia behavior.
            raise AiiaClientError(
                "exchange_code: no matching consent for this code",
                status=400, kind="invalid_grant",
            )
        bank_slug = self._consents[matching_state].get("bank_slug") or "danske_bank"
        return {
            "account_id": f"mock_acct_{bank_slug}_{secrets.token_hex(4)}",
            "account_label": "Erhverv driftskonto",
            "refresh_token": f"mock_refresh_{secrets.token_hex(16)}",
            "access_token": f"mock_access_{secrets.token_hex(8)}",
            "expires_in": 7776000,  # 90 days, matches DK SCA
        }

    def list_transactions(
        self, account_id: str, since: datetime | None,
    ) -> list[AiiaTransaction]:
        if account_id in self._revoked:
            raise AiiaClientError(
                "list_transactions: account revoked", status=401, kind="revoked",
            )
        # Test override path — explicit txns set by test fixture
        if account_id in self._txns_override:
            return list(self._txns_override[account_id])

        # Default fixture: 3 transactions matching common DK SMB
        # patterns. Recon engine should find a match for the Lyngby
        # one if the test set up the corresponding invoice.
        today = date.today()
        return [
            AiiaTransaction(
                aiia_txn_id="mock_txn_lyngby_001",
                booked_date=today,
                amount=1250.00,
                currency="DKK",
                description="OVF FRA LYNGBY STORKUNDE APS REF 12345",
                counterparty="Lyngby Storkunde ApS",
            ),
            AiiaTransaction(
                aiia_txn_id="mock_txn_rent_001",
                booked_date=today - timedelta(days=2),
                amount=-18000.00,
                currency="DKK",
                description="HUSLEJE MAJ 2026",
                counterparty="Storgade Ejendomme A/S",
            ),
            AiiaTransaction(
                aiia_txn_id="mock_txn_wolt_001",
                booked_date=today - timedelta(days=1),
                amount=4823.50,
                currency="DKK",
                description="WOLT PAYOUT WK20",
                counterparty="Wolt Denmark ApS",
            ),
        ]

    def refresh(self, refresh_token: str) -> dict:
        # Mock always returns a fresh token. Real Aiia would 401 on
        # revoked / expired — we model that via list_transactions
        # raising for revoked accounts.
        return {
            "access_token": f"mock_access_{secrets.token_hex(8)}",
            "refresh_token": refresh_token,  # often unchanged on refresh
            "expires_in": 3600,
        }

    def revoke(self, account_id: str) -> None:
        # Idempotent: revoking an already-revoked account is fine.
        self._revoked.add(account_id)

    # ─── Test helpers ──────────────────────────────────────────────
    # These aren't part of the protocol but tests + dev tools call them
    # directly. They live on MockAiiaClient only.

    @classmethod
    def reset(cls) -> None:
        """Wipe all mock state — call between tests."""
        cls._consents.clear()
        cls._revoked.clear()
        cls._txns_override.clear()

    @classmethod
    def set_transactions(cls, account_id: str, txns: list[AiiaTransaction]) -> None:
        """Prime the list_transactions return for a given account."""
        cls._txns_override[account_id] = list(txns)

    @classmethod
    def force_state_code(cls, state: str, code: str, bank_slug: str | None = None) -> None:
        """Pre-stash a state→code mapping so tests can call /callback
        with a known code without having walked through /init."""
        cls._consents[state] = {
            "redirect_uri": "",
            "bank_slug": bank_slug,
            "used": False,
            "code": code,
        }


# ─── Sandbox + Live (skeletons — v0.1 doesn't wire real HTTP) ────────────


class _HttpAiiaClient:
    """Shared skeleton for sandbox + live. Both speak HTTPS to Aiia
    with OAuth2 + per-endpoint paths from the Mastercard Open Banking
    EU Postman collection. v0.1 ships these as not-yet-wired so we
    have the file structure ready — v0.2 fills in the real calls.
    """

    def __init__(self, base_url: str, client_id: str, client_secret: str):
        if not (base_url and client_id and client_secret):
            raise AiiaClientError(
                "Aiia HTTP client requires AIIA_BASE_URL, AIIA_CLIENT_ID, "
                "and AIIA_CLIENT_SECRET env vars.",
                status=500, kind="config",
            )
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret

    def _not_yet(self, name: str) -> None:
        raise AiiaClientError(
            f"AiiaClient.{name} is not wired for v0.1 — sandbox/live HTTP "
            f"calls land in v0.2. Use MockAiiaClient until then.",
            status=501, kind="not_implemented",
        )

    def init_consent(self, redirect_uri: str, state: str, *, bank_slug: str | None = None) -> str:
        # When the real endpoints are wired (v0.2), this calls
        # POST {base}/users + GET {base}/users/{id}/authorizations to
        # mint a connect URL. For now, raise.
        self._not_yet("init_consent")
        return ""  # unreachable

    def exchange_code(self, code: str) -> dict:
        self._not_yet("exchange_code")
        return {}  # unreachable

    def list_transactions(
        self, account_id: str, since: datetime | None,
    ) -> list[AiiaTransaction]:
        self._not_yet("list_transactions")
        return []  # unreachable

    def refresh(self, refresh_token: str) -> dict:
        self._not_yet("refresh")
        return {}  # unreachable

    def revoke(self, account_id: str) -> None:
        self._not_yet("revoke")


class SandboxAiiaClient(_HttpAiiaClient):
    """Aiia sandbox — same shape as live, simulated banks. Base URL is
    typically `https://api.aiia.eu/v1/sandbox` per Mastercard docs.
    """


class LiveAiiaClient(_HttpAiiaClient):
    """Aiia production. Base URL `https://api.aiia.eu/v1`. Used when we
    have a written quote + signed contract."""


# ─── Factory ────────────────────────────────────────────────────────────


def get_aiia_client() -> AiiaClient:
    """Return the right client for the current env. Default = mock so
    contributors can run tests without setup.

    Env vars:
      AIIA_ENV       — 'mock' (default) | 'sandbox' | 'live'
      AIIA_BASE_URL  — required for sandbox / live
      AIIA_CLIENT_ID
      AIIA_CLIENT_SECRET
    """
    env = (os.environ.get("AIIA_ENV") or "mock").strip().lower()
    if env in ("sandbox", "live"):
        base = os.environ.get("AIIA_BASE_URL", "")
        cid = os.environ.get("AIIA_CLIENT_ID", "")
        sec = os.environ.get("AIIA_CLIENT_SECRET", "")
        try:
            if env == "sandbox":
                return SandboxAiiaClient(base, cid, sec)
            return LiveAiiaClient(base, cid, sec)
        except AiiaClientError as e:
            logger.warning(
                "aiia: %s mode requested but config invalid (%s) — falling back to mock",
                env, e,
            )
            return MockAiiaClient()
    return MockAiiaClient()


def sandbox_mode_default() -> bool:
    """Whether new BankConnection rows should default to sandbox_mode=True.
    True unless we're explicitly in 'live' mode with real creds."""
    return (os.environ.get("AIIA_ENV") or "mock").strip().lower() != "live"
