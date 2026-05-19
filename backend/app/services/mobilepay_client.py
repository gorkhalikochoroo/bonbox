"""
MobilePay Business (Vipps MobilePay) client abstraction — task #71.

Mirrors the Aiia client pattern at app.services.aiia_client. Three
implementations behind one Protocol:

  * MockMobilePayClient    -- hand-crafted in-process responses. Default
                              when MOBILEPAY_ENV='mock' (the default).
                              Zero network, deterministic for tests +
                              local dev. Returns 3 synthetic DKK
                              payments on every list_payments call
                              (one CVR-matching Lyngby payment + a
                              walk-in coffee tap + a takeaway pickup) so
                              reconciliation tests have something to chew
                              on.

  * SandboxMobilePayClient -- points at MobilePay's sandbox endpoints
                              (developer.vippsmobilepay.com sandbox).
                              Requires MOBILEPAY_CLIENT_ID +
                              MOBILEPAY_CLIENT_SECRET + MOBILEPAY_BASE_URL.
                              v0.1 raises NotImplementedError (501) on
                              real HTTP calls — v0.2 wires actual REST
                              shapes once the partner agreement closes.

  * LiveMobilePayClient    -- production endpoints. Same code path as
                              sandbox, different base URL. Activated
                              when MOBILEPAY_ENV='live' AND creds are
                              present. v0.1 also raises 501.

Defensive design notes:
  * The real MobilePay request/response shapes aren't fully verifiable
    from this environment (developer.vippsmobilepay.com was blocked
    during spec drafting). For v0.1 the sandbox + live clients raise
    NotImplementedError on real network calls so we ship a known-safe
    surface. The mock client implements every method end-to-end.
  * All methods return plain dicts / dataclasses so the router doesn't
    depend on SDK objects we'd have to mock in tests.
  * Errors raise MobilePayClientError — the router maps to 502 Bad
    Gateway so callers can distinguish "MobilePay is broken" from "you
    gave me bad input".
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

logger = logging.getLogger(__name__)


# --- Exception ---------------------------------------------------------


class MobilePayClientError(RuntimeError):
    """Raised on any MobilePay API failure. Carries an HTTP-ish status
    hint so the router can map sensibly."""

    def __init__(self, message: str, *, status: int = 502, kind: str = "unknown"):
        super().__init__(message)
        self.status = status
        self.kind = kind


# --- Response shape ----------------------------------------------------


@dataclass
class MobilePayPayment:
    """Simplified MobilePay payment. Fields chosen to map directly into
    our Sale rows during sync + give the matcher what it needs to find
    the corresponding open faktura."""

    mp_payment_id: str          # unique per-merchant payment id
    booked_at: datetime         # when MobilePay booked the payment (UTC)
    amount: float               # always positive (MobilePay direction == inflow)
    currency: str               # ISO 4217, e.g. "DKK"
    description: str            # merchant-supplied reference / "Faktura 2026-0042"
    payer_name: str             # name MobilePay surfaces for the payer

    def to_dict(self) -> dict:
        return {
            "mp_payment_id": self.mp_payment_id,
            "booked_at": self.booked_at.isoformat(),
            "amount": self.amount,
            "currency": self.currency,
            "description": self.description,
            "payer_name": self.payer_name,
        }


# --- Protocol ----------------------------------------------------------


class MobilePayClient(Protocol):
    """The interface every implementation must honour. Used by the
    router + cron — both stay decoupled from which backend (mock /
    sandbox / live) is wired in."""

    def init_connection(self, redirect_uri: str, state: str) -> str:
        """Return the URL the owner must visit to grant MitID Business
        consent at MobilePay. `state` MUST round-trip back to our
        callback unchanged."""
        ...

    def complete_callback(self, code: str, state: str) -> dict:
        """Exchange an authorization code for tokens + merchant info.
        Returns: {
          "mp_merchant_id": str,
          "merchant_name": str | None,
          "access_token": str,
          "refresh_token": str,
          "scopes": str,
          "expires_in": int,       # access-token TTL in seconds
          "consent_expires_in": int | None,  # consent TTL in seconds
        }"""
        ...

    def list_payments(
        self, mp_merchant_id: str, access_token: str, since: datetime | None,
    ) -> list[MobilePayPayment]:
        """Fetch booked MobilePay payments since `since` (None = all
        within MobilePay's default window). v0.1 surfaces individual
        payments; v0.2 may also expose settlement-level aggregates."""
        ...

    def refresh_token(self, refresh_token: str) -> dict:
        """Exchange a refresh token for a fresh access token. Returns:
        {
          "access_token": str,
          "refresh_token": str,   # often unchanged
          "expires_in": int,
        }"""
        ...

    def disconnect(self, mp_merchant_id: str, access_token: str) -> None:
        """Tell MobilePay the owner has revoked consent. Best-effort —
        idempotent. Callers always proceed to mark the local row
        disconnected regardless of MobilePay's response."""
        ...


# --- Mock implementation -----------------------------------------------


class MockMobilePayClient:
    """In-process fake. Hand-crafted responses. Default for tests +
    local dev so contributors can exercise the full flow without
    MobilePay sandbox credentials.

    State (mock_state dict) is process-local — TestClient + fixtures
    can prime/assert it. Nothing here ever touches the network."""

    # Process-wide state so tests can inspect what was called.
    # `_consents`: state token -> {redirect_uri, used, code, merchant_id}
    # `_disconnected`: set of mp_merchant_ids that have been disconnected
    _consents: dict[str, dict] = {}
    _disconnected: set[str] = set()
    # Optional override for list_payments — tests can monkey-patch this
    # to inject a specific payment list. Cleared per fixture.
    _payments_override: dict[str, list[MobilePayPayment]] = {}

    def __init__(self, base_url: str = "mock://mobilepay"):
        self.base_url = base_url

    def init_connection(self, redirect_uri: str, state: str) -> str:
        # Stash so complete_callback can replay.
        code = "mock_mp_code_" + secrets.token_hex(8)
        self._consents[state] = {
            "redirect_uri": redirect_uri,
            "used": False,
            "code": code,
            "merchant_id": f"mock_mp_merchant_{secrets.token_hex(4)}",
        }
        # Mock redirect URL must be navigable so the owner's click in
        # MOBILEPAY_ENV=mock actually completes the round-trip.  See
        # the matching comment in aiia_client.MockAiiaClient.init_consent.
        # Bounces the browser straight to our /callback with state +
        # code pre-filled — the demo connect completes in one click.
        sep = "&" if "?" in redirect_uri else "?"
        return f"{redirect_uri}{sep}state={state}&code={code}"

    def complete_callback(self, code: str, state: str) -> dict:
        # Mock is forgiving by design. Real (sandbox/live) clients still
        # enforce strict OAuth replay rules upstream — the strictness
        # belongs to MobilePay, not the in-process mock. For the mock we
        # make the demo flow robust against:
        #   - Render free-tier dyno restart wiping `_consents` between
        #     /init and /callback (state would look "unknown" otherwise).
        #   - React useEffect double-fire from translation-ref changes
        #     (we now ref-guard the client side, but defense in depth).
        #   - Owners clicking Connect twice in rapid succession.
        # We log at WARNING so the unusual paths show up in production
        # logs without breaking the user flow.
        data = self._consents.get(state)

        if data is None:
            # State unknown — most likely the dyno restarted between
            # /init and /callback, wiping the class-level dict. Treat
            # this as a fresh consent and proceed. The backend router
            # already validated `conn.consent_state == body.state`, so
            # we know the state was minted by *this* deployment at some
            # point — we're not letting a random attacker in.
            logger.warning(
                "mock_mobilepay.complete_callback: unknown state %s — "
                "treating as fresh (dyno likely restarted between init "
                "and callback)",
                (state[:8] + "…") if len(state) > 8 else state,
            )
            data = {
                "redirect_uri": "",
                "used": False,
                "code": code,
                "merchant_id": f"mock_mp_merchant_{secrets.token_hex(4)}",
            }
            self._consents[state] = data

        # Idempotent replay: if the same state was already consumed and
        # we cached the response, return it verbatim. The cached_response
        # path also covers React effect double-fire that slipped through
        # the frontend ref-guard.
        if data.get("used") and data.get("cached_response"):
            logger.info(
                "mock_mobilepay.complete_callback: replay of consumed "
                "state %s — returning cached response (idempotent demo)",
                (state[:8] + "…") if len(state) > 8 else state,
            )
            return dict(data["cached_response"])

        # Note: we intentionally DO NOT verify code-vs-state matching in
        # the mock. The real MobilePay sandbox does. The mock is for
        # demos, and the navigable redirect URL we return from
        # init_connection embeds the code we minted — they always match
        # in practice. If they ever drift (e.g. an old browser tab with
        # stale code) we still succeed rather than confuse the demo.

        merchant_id = data.get("merchant_id") or f"mock_mp_merchant_{secrets.token_hex(4)}"
        response = {
            "mp_merchant_id": merchant_id,
            "merchant_name": "Bon Bakery Erhverv (sandbox)",
            "access_token": f"mock_mp_access_{secrets.token_hex(8)}",
            "refresh_token": f"mock_mp_refresh_{secrets.token_hex(16)}",
            "scopes": "payments:read merchant:read",
            "expires_in": 3600,         # 1h access token
            "consent_expires_in": 7776000,  # 90 days, matches DK SCA pattern
        }
        data["used"] = True
        data["cached_response"] = response
        return dict(response)

    def list_payments(
        self, mp_merchant_id: str, access_token: str, since: datetime | None,
    ) -> list[MobilePayPayment]:
        if mp_merchant_id in self._disconnected:
            raise MobilePayClientError(
                "list_payments: merchant disconnected",
                status=401, kind="revoked",
            )
        if mp_merchant_id in self._payments_override:
            return list(self._payments_override[mp_merchant_id])

        # Default fixture: 3 payments that look like a real café day —
        # one B2B faktura settlement (matches the Lyngby invoice fixture
        # the tests pre-seed) and two walk-in MobilePay taps. The
        # reconciler should auto-match the Lyngby one.
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        return [
            MobilePayPayment(
                mp_payment_id="mock_mp_pay_lyngby_001",
                booked_at=now,
                amount=1250.00,
                currency="DKK",
                description="Faktura 2026-0042 Lyngby Storkunde ApS",
                payer_name="Lyngby Storkunde ApS",
            ),
            MobilePayPayment(
                mp_payment_id="mock_mp_pay_walkin_001",
                booked_at=now - timedelta(hours=2),
                amount=68.00,
                currency="DKK",
                description="Cappuccino",
                payer_name="Mette J.",
            ),
            MobilePayPayment(
                mp_payment_id="mock_mp_pay_walkin_002",
                booked_at=now - timedelta(hours=1),
                amount=145.50,
                currency="DKK",
                description="Frokost takeaway",
                payer_name="Jonas H.",
            ),
        ]

    def refresh_token(self, refresh_token: str) -> dict:
        # Mock always returns a fresh token. Real MobilePay would 401
        # on revoked / expired — we model that via list_payments
        # raising for disconnected merchants.
        return {
            "access_token": f"mock_mp_access_{secrets.token_hex(8)}",
            "refresh_token": refresh_token,   # unchanged on refresh
            "expires_in": 3600,
        }

    def disconnect(self, mp_merchant_id: str, access_token: str) -> None:
        # Idempotent: disconnecting an already-disconnected merchant is fine.
        self._disconnected.add(mp_merchant_id)

    # --- Test helpers ------------------------------------------------
    # Not part of the protocol but tests + dev tools call them directly.

    @classmethod
    def reset(cls) -> None:
        """Wipe all mock state — call between tests."""
        cls._consents.clear()
        cls._disconnected.clear()
        cls._payments_override.clear()

    @classmethod
    def set_payments(cls, mp_merchant_id: str, payments: list[MobilePayPayment]) -> None:
        """Prime the list_payments return for a given merchant."""
        cls._payments_override[mp_merchant_id] = list(payments)

    @classmethod
    def force_state_code(
        cls, state: str, code: str, merchant_id: str | None = None,
    ) -> None:
        """Pre-stash a state->code mapping so tests can call /callback
        with a known code without having walked through /init."""
        cls._consents[state] = {
            "redirect_uri": "",
            "used": False,
            "code": code,
            "merchant_id": merchant_id or f"mock_mp_merchant_{secrets.token_hex(4)}",
        }


# --- Sandbox + Live (skeletons — v0.1 doesn't wire real HTTP) ---------


class _HttpMobilePayClient:
    """Shared skeleton for sandbox + live. Both speak HTTPS to MobilePay
    with OAuth2 + per-endpoint paths from developer.vippsmobilepay.com.
    v0.1 ships these as not-yet-wired so we have the file structure
    ready — v0.2 fills in the real calls once the partner agreement
    closes.
    """

    def __init__(
        self,
        base_url: str,
        client_id: str,
        client_secret: str,
    ):
        if not (base_url and client_id and client_secret):
            raise MobilePayClientError(
                "MobilePay HTTP client requires MOBILEPAY_BASE_URL, "
                "MOBILEPAY_CLIENT_ID, and MOBILEPAY_CLIENT_SECRET env vars.",
                status=500, kind="config",
            )
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret

    def _not_yet(self, name: str) -> None:
        raise MobilePayClientError(
            f"MobilePayClient.{name} is not wired for v0.1 — sandbox/live "
            f"HTTP calls land in v0.2. Use MockMobilePayClient until then.",
            status=501, kind="not_implemented",
        )

    def init_connection(self, redirect_uri: str, state: str) -> str:
        # When the real endpoints are wired (v0.2), this builds a
        # merchant-authorization URL with the right scopes
        # ("payments:read merchant:read") + state JWT.
        self._not_yet("init_connection")
        return ""  # unreachable

    def complete_callback(self, code: str, state: str) -> dict:
        self._not_yet("complete_callback")
        return {}  # unreachable

    def list_payments(
        self, mp_merchant_id: str, access_token: str, since: datetime | None,
    ) -> list[MobilePayPayment]:
        self._not_yet("list_payments")
        return []  # unreachable

    def refresh_token(self, refresh_token: str) -> dict:
        self._not_yet("refresh_token")
        return {}  # unreachable

    def disconnect(self, mp_merchant_id: str, access_token: str) -> None:
        self._not_yet("disconnect")


class SandboxMobilePayClient(_HttpMobilePayClient):
    """MobilePay sandbox — same shape as live, simulated merchants.
    Base URL typically `https://api.sandbox.vippsmobilepay.com` per the
    developer portal. v0.1 raises 501 on every method."""


class LiveMobilePayClient(_HttpMobilePayClient):
    """MobilePay production. Base URL `https://api.vippsmobilepay.com`.
    Used only when MOBILEPAY_ENV='live' AND the partner agreement +
    production credentials are in place. v0.1 raises 501."""


# --- Factory ----------------------------------------------------------


def get_mobilepay_client() -> MobilePayClient:
    """Return the right client for the current env. Default = mock so
    contributors can run tests without setup.

    Env vars:
      MOBILEPAY_ENV            'mock' (default) | 'sandbox' | 'live'
      MOBILEPAY_BASE_URL       required for sandbox / live
      MOBILEPAY_CLIENT_ID      required for sandbox / live
      MOBILEPAY_CLIENT_SECRET  required for sandbox / live
    """
    env = (os.environ.get("MOBILEPAY_ENV") or "mock").strip().lower()
    if env in ("sandbox", "live"):
        base = os.environ.get("MOBILEPAY_BASE_URL", "")
        cid = os.environ.get("MOBILEPAY_CLIENT_ID", "")
        sec = os.environ.get("MOBILEPAY_CLIENT_SECRET", "")
        try:
            if env == "sandbox":
                return SandboxMobilePayClient(base, cid, sec)
            return LiveMobilePayClient(base, cid, sec)
        except MobilePayClientError as e:
            logger.warning(
                "mobilepay: %s mode requested but config invalid (%s) — "
                "falling back to mock",
                env, e,
            )
            return MockMobilePayClient()
    return MockMobilePayClient()
