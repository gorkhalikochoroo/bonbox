"""
GoCardless Bank Account Data client — task #104.

Real EU PSD2 bank access via GoCardless (formerly Nordigen).  Free tier,
no commercial agreement required — operator signs up at
https://bankaccountdata.gocardless.com/ and drops `secret_id` +
`secret_key` into Render env vars.  Covers Danske Bank, Nordea, Jyske
Bank, Lunar, Revolut + ~2400 other EU banks with real MitID / SCA.

Implements the same `AiiaClient` Protocol as `aiia_client.py` so the
existing `/api/bank-connect/*` routes don't care which provider is
active.  Selection happens in `get_aiia_client()` via the
`BANK_PROVIDER=gocardless` env var.

GoCardless flow differs slightly from Aiia OAuth:

  ┌─ Aiia ──────────────────────────────────────────────┐
  │  /init     → consent URL at user's bank             │
  │  callback  → ?code=…&state=…                        │
  │  exchange  → POST /token with code → tokens         │
  │  list      → GET /accounts/{id}/transactions        │
  └─────────────────────────────────────────────────────┘

  ┌─ GoCardless ────────────────────────────────────────┐
  │  /init     → 1) POST /token/new   (service tokens)  │
  │              2) POST /requisitions (with reference) │
  │              → user redirected to bank for SCA       │
  │  callback  → ?ref=<our reference>  (NO code)        │
  │  resolve   → GET /requisitions/{id} → account ids   │
  │  list      → GET /accounts/{id}/transactions        │
  └─────────────────────────────────────────────────────┘

To bridge the two, our Protocol's `exchange_code(code)` accepts an
optional `requisition_id` keyword arg.  Aiia ignores it; GoCardless
uses it (the bank_connect router threads it from the BankConnection
row stored at /init time).

Security:
  • All calls over HTTPS (httpx default; we set verify=True explicitly
    and a 10s timeout to avoid resource exhaustion).
  • Service-level access token cached in process memory with a small
    skew; refreshed on 401 or 60s before declared expiry.  Never
    logged.
  • Secret_id + secret_key never logged; redacted in any HTTP error
    detail we surface.
  • Requisition reference uses our state token verbatim so the
    backend can verify the round-trip ownership.
  • All errors raise GoCardlessClientError (re-export of
    AiiaClientError for callsite compatibility) with status hint so
    the router maps to the right HTTP code.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from app.services.aiia_client import AiiaClientError, AiiaTransaction

logger = logging.getLogger(__name__)


# ─── Re-export AiiaClientError so callsites have a stable name ────────
# (Keeping a typedef under a more descriptive name in case we ever
# want provider-specific error subclasses; today they're identical.)
GoCardlessClientError = AiiaClientError


# ─── Bank slug → GoCardless institution_id ────────────────────────────
# GoCardless identifies banks by uppercased BIC-ish strings.  This map
# covers the 5 we ship in the bank picker today.  Operators can extend
# via the `bank_slug_overrides` constructor kwarg (used by tests +
# config-driven additions without redeploy).
_DK_INSTITUTION_MAP: dict[str, str] = {
    "danske_bank": "DANSKEBANK_DABADKKK",
    "nordea": "NORDEA_NDEADKKK",
    "jyske_bank": "JYSKE_BANK_JYBADKKK",
    "lunar": "LUNAR_LUNADK22",
    "revolut": "REVOLUT_REVOGB21",
    # Sandbox bank lives outside the map under SANDBOXFINANCE_SFIN0000
    # — we route to it when sandbox_mode is requested.
    "sandbox": "SANDBOXFINANCE_SFIN0000",
}


# ─── Client ────────────────────────────────────────────────────────────


class GoCardlessClient:
    """HTTP client for GoCardless Bank Account Data.

    One instance per process is fine — the access token cache uses an
    instance-level lock so concurrent requests share a single refresh.

    Constructor takes the API base URL + service-account credentials
    explicitly so tests can inject a stub via dependency injection.
    """

    # Tokens last ~24h (access) and ~30d (refresh) per GoCardless docs.
    # We refresh 60s before declared expiry to avoid edge-case 401s.
    _ACCESS_TOKEN_SKEW_S = 60
    _DEFAULT_TIMEOUT_S = 10.0

    def __init__(
        self,
        base_url: str,
        secret_id: str,
        secret_key: str,
        *,
        bank_slug_overrides: dict[str, str] | None = None,
        timeout_s: float | None = None,
    ):
        if not (base_url and secret_id and secret_key):
            raise GoCardlessClientError(
                "GoCardless client requires GOCARDLESS_BASE_URL, "
                "GOCARDLESS_SECRET_ID, and GOCARDLESS_SECRET_KEY env vars.",
                status=500, kind="config",
            )
        self.base_url = base_url.rstrip("/")
        self.secret_id = secret_id
        self.secret_key = secret_key
        self.timeout_s = timeout_s or self._DEFAULT_TIMEOUT_S
        self._institution_map = {
            **_DK_INSTITUTION_MAP,
            **(bank_slug_overrides or {}),
        }
        # Token cache.  Held under _token_lock so a stampede of
        # concurrent requests only does ONE refresh.
        self._access_token: str | None = None
        self._access_token_expires_at: float = 0.0  # epoch seconds
        self._refresh_token: str | None = None
        self._token_lock = threading.Lock()

    # ─── HTTP helpers ──────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        """Issue an HTTP call to GoCardless and return the parsed body.

        Maps non-2xx responses to GoCardlessClientError with a sensible
        status code.  Refreshes the service-level access token once on
        401.  Never logs secrets or token values.
        """
        url = f"{self.base_url}{path}"
        headers: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": "BonBox/1.0 (+https://bonbox.dk)",
        }
        if authenticated:
            headers["Authorization"] = f"Bearer {self._ensure_access_token()}"
        try:
            with httpx.Client(
                timeout=self.timeout_s, verify=True, follow_redirects=False,
            ) as client:
                response = client.request(
                    method, url, headers=headers, json=json_body, params=params,
                )
        except httpx.TimeoutException as e:
            raise GoCardlessClientError(
                f"GoCardless timeout calling {method} {path}",
                status=504, kind="timeout",
            ) from e
        except httpx.HTTPError as e:
            raise GoCardlessClientError(
                f"GoCardless transport error calling {method} {path}: "
                f"{type(e).__name__}",
                status=502, kind="transport",
            ) from e

        # Auto-refresh on a stale token (e.g. service-account rotation).
        if response.status_code == 401 and authenticated:
            logger.info(
                "gocardless: 401 on %s %s — invalidating cached token",
                method, path,
            )
            self._invalidate_cached_token()
            headers["Authorization"] = f"Bearer {self._ensure_access_token()}"
            try:
                with httpx.Client(
                    timeout=self.timeout_s, verify=True, follow_redirects=False,
                ) as client:
                    response = client.request(
                        method, url, headers=headers,
                        json=json_body, params=params,
                    )
            except httpx.HTTPError as e:
                raise GoCardlessClientError(
                    f"GoCardless re-auth retry failed: {type(e).__name__}",
                    status=502, kind="transport",
                ) from e

        if response.status_code >= 400:
            self._raise_for_response(response, method, path)

        # Some endpoints (DELETE /requisitions) return 204 No Content.
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as e:
            raise GoCardlessClientError(
                f"GoCardless returned non-JSON body for {method} {path}",
                status=502, kind="protocol",
            ) from e

    def _raise_for_response(
        self, response: httpx.Response, method: str, path: str,
    ) -> None:
        """Map a 4xx/5xx response to a GoCardlessClientError.

        GoCardless returns errors as JSON with `{"summary": ..., "detail":
        ...}`.  We surface the summary line (capped) so the SPA can show
        something useful, and log the body for ops.  No request bodies
        are echoed back — they may contain the reference (which equals
        our CSRF state).
        """
        body_text = response.text[:500] if response.content else ""
        try:
            data = response.json() if response.content else {}
        except ValueError:
            data = {}
        summary = data.get("summary") or data.get("detail") or body_text[:200]
        # Logged at WARNING — these are upstream errors, not our bug.
        logger.warning(
            "gocardless: %d on %s %s — %s",
            response.status_code, method, path,
            (summary or "no body")[:200],
        )
        # Map common upstream codes to clean HTTP-ish hints.
        status_hint = {
            400: 400,  # client error from us (e.g. wrong body shape)
            401: 502,  # invalid creds — our config bug, but caller can't fix
            403: 502,  # scope / institution not enabled
            404: 404,  # requisition / account not found
            409: 409,  # already exists
            429: 429,  # rate-limited
            500: 502,
            502: 502,
            503: 503,
            504: 504,
        }.get(response.status_code, 502)
        kind_hint = {
            401: "auth", 403: "scope", 404: "not_found",
            409: "conflict", 429: "rate_limit",
        }.get(response.status_code, "upstream")
        raise GoCardlessClientError(
            f"GoCardless {response.status_code} on {method} {path}: "
            f"{summary or 'no details'}",
            status=status_hint, kind=kind_hint,
        )

    # ─── Auth / token cache ────────────────────────────────────────────

    def _ensure_access_token(self) -> str:
        now = time.time()
        with self._token_lock:
            if (
                self._access_token
                and now < self._access_token_expires_at - self._ACCESS_TOKEN_SKEW_S
            ):
                return self._access_token
            # Need a (re)fresh.  Always go via /token/new — we don't
            # exploit /token/refresh because the secret_id+secret_key
            # path is just as fast and avoids a second cached token.
            url = f"{self.base_url}/token/new/"
            try:
                with httpx.Client(timeout=self.timeout_s, verify=True) as client:
                    resp = client.post(
                        url,
                        json={
                            "secret_id": self.secret_id,
                            "secret_key": self.secret_key,
                        },
                        headers={
                            "Accept": "application/json",
                            "User-Agent": "BonBox/1.0 (+https://bonbox.dk)",
                        },
                    )
            except httpx.HTTPError as e:
                raise GoCardlessClientError(
                    f"GoCardless token auth transport error: {type(e).__name__}",
                    status=502, kind="transport",
                ) from e
            if resp.status_code >= 400:
                # Credentials wrong / revoked — log without echoing the
                # secret.  This is operator misconfig.
                logger.error(
                    "gocardless: token auth failed status=%d (check "
                    "GOCARDLESS_SECRET_ID / GOCARDLESS_SECRET_KEY)",
                    resp.status_code,
                )
                raise GoCardlessClientError(
                    "GoCardless authentication failed — check secret_id/secret_key",
                    status=502, kind="auth",
                )
            try:
                data = resp.json()
            except ValueError as e:
                raise GoCardlessClientError(
                    "GoCardless /token/new returned non-JSON body",
                    status=502, kind="protocol",
                ) from e
            access = data.get("access")
            access_expires = int(data.get("access_expires") or 86400)
            refresh = data.get("refresh")
            if not access:
                raise GoCardlessClientError(
                    "GoCardless /token/new missing 'access' field",
                    status=502, kind="protocol",
                )
            self._access_token = access
            self._refresh_token = refresh  # kept for future use
            self._access_token_expires_at = now + access_expires
            return access

    def _invalidate_cached_token(self) -> None:
        with self._token_lock:
            self._access_token = None
            self._access_token_expires_at = 0.0

    # ─── Bank slug ↔ institution_id ────────────────────────────────────

    def _institution_id(self, bank_slug: str | None, *, sandbox: bool = False) -> str:
        if sandbox:
            return self._institution_map["sandbox"]
        if not bank_slug:
            raise GoCardlessClientError(
                "bank_slug is required for GoCardless init_consent",
                status=400, kind="missing_bank",
            )
        inst = self._institution_map.get(bank_slug)
        if not inst:
            raise GoCardlessClientError(
                f"GoCardless: bank '{bank_slug}' is not in the supported "
                f"institution map. Add it via bank_slug_overrides or pick one of: "
                f"{sorted(self._institution_map.keys())}",
                status=400, kind="unknown_bank",
            )
        return inst

    # ─── AiiaClient Protocol methods ───────────────────────────────────

    def init_consent(
        self,
        redirect_uri: str,
        state: str,
        *,
        bank_slug: str | None = None,
        sandbox: bool = False,
        on_provider_ids: Any = None,  # callback to persist requisition_id+institution_id
    ) -> str:
        """Begin the SCA flow.  Returns the URL the owner visits at
        their bank to authorize PSD2 access.

        `on_provider_ids` is an optional callback the router uses to
        persist GoCardless-specific identifiers (`requisition_id`,
        `institution_id`) on the BankConnection row at /init time so
        the callback handler can look them up — see bank_connect.py.
        """
        institution_id = self._institution_id(bank_slug, sandbox=sandbox)

        # We let GoCardless mint the end-user agreement with default
        # scope (balances + details + transactions, 90-day access,
        # 90-day historical).  Skipping the explicit POST /agreements
        # call shaves a round-trip — the requisition POST below can
        # carry the same options inline.

        # Reference == our state token so we can resolve the round-trip
        # at /callback without trusting the URL it came from.
        body = {
            "redirect": redirect_uri,
            "institution_id": institution_id,
            "reference": state,
            "user_language": "DA",  # default Danish; bank's SCA UI matches
            # 90-day SCA window matches DK PSD2 max.
            "agreement": None,  # let GC use default agreement
        }
        # Strip None so GC's strict schema doesn't reject the body.
        body = {k: v for k, v in body.items() if v is not None}
        result = self._request("POST", "/requisitions/", json_body=body)

        requisition_id = result.get("id")
        link = result.get("link")
        if not (requisition_id and link):
            raise GoCardlessClientError(
                "GoCardless POST /requisitions returned no id/link",
                status=502, kind="protocol",
            )
        # Surface the provider-specific identifiers to the router for
        # persistence.  We use a callback rather than returning a tuple
        # so the AiiaClient Protocol contract stays single-value.
        if callable(on_provider_ids):
            try:
                on_provider_ids(
                    requisition_id=requisition_id,
                    institution_id=institution_id,
                )
            except Exception:  # noqa: BLE001 — never let a UI callback break consent
                logger.exception(
                    "gocardless.init_consent: on_provider_ids callback raised",
                )
        return link

    def exchange_code(
        self,
        code: str,
        *,
        requisition_id: str | None = None,
    ) -> dict:
        """Resolve the SCA round-trip → account ids + label.

        GoCardless doesn't do an OAuth code exchange (the requisition
        ID minted at /init time IS the long-lived access grant).  At
        /callback we GET /requisitions/{id} to read the linked accounts
        and verify the requisition was authorized.

        `code` is ignored for GoCardless (kept in the signature for
        Protocol compatibility).  `requisition_id` MUST be provided by
        the caller — it comes from the BankConnection row's
        provider_requisition_id column.
        """
        if not requisition_id:
            raise GoCardlessClientError(
                "GoCardless exchange_code requires requisition_id (the "
                "router must pass it from BankConnection.provider_requisition_id)",
                status=400, kind="missing_requisition",
            )
        data = self._request(
            "GET", f"/requisitions/{requisition_id}/",
        )
        status = (data.get("status") or "").upper()
        accounts = data.get("accounts") or []
        # Status codes per GC docs:
        #   CR (created) | GC (giving consent) | UA (undergoing authentication)
        #   RJ (rejected) | SA (selecting accounts) | GA (granting access)
        #   LN (linked) | SU (suspended) | EX (expired)
        # Anything not LN is a soft failure — the user bailed out of
        # the bank's SCA UI before completion.
        if status != "LN":
            kind = "auth_incomplete"
            if status in ("RJ", "EX"):
                kind = "auth_rejected"
            raise GoCardlessClientError(
                f"GoCardless requisition status={status} (expected LN/linked). "
                f"User may have cancelled at the bank.",
                status=400, kind=kind,
            )
        if not accounts:
            raise GoCardlessClientError(
                "GoCardless requisition is LN but lists no accounts",
                status=502, kind="protocol",
            )
        # We pick the FIRST account today (v1 = single-account per
        # connection).  Multi-account support is a follow-up — the
        # router could iterate `accounts` and write one row each.
        primary_account_id = accounts[0]
        # Fetch the bank-supplied display label so the connections page
        # can show "Erhverv driftskonto" or similar instead of a UUID.
        label = self._fetch_account_label(primary_account_id)
        # Map back to the AiiaClient response shape.  Refresh token
        # isn't a real concept for GoCardless — the requisition_id IS
        # the long-lived consent — but we synthesize one for storage so
        # downstream code (encrypt(), revoke()) keeps working.
        return {
            "account_id": primary_account_id,
            "account_label": label or "Erhverv driftskonto",
            # We re-use refresh_token as the storage slot for the
            # requisition_id — it's the value sync uses to authorize
            # subsequent calls.  Encrypted at rest like any other token.
            "refresh_token": requisition_id,
            "access_token": "",  # GC uses service-level auth, not per-user
            # GC default agreement grants 90 days.
            "expires_in": 7776000,
        }

    def _fetch_account_label(self, account_id: str) -> str | None:
        """Best-effort fetch of the bank-supplied account name.  Some
        institutions return an `ownerName`; others give `name`; many
        return nothing.  We never let this raise — the connection
        still works with a placeholder label."""
        try:
            data = self._request("GET", f"/accounts/{account_id}/details/")
            details = data.get("account") or {}
            return (
                details.get("name")
                or details.get("ownerName")
                or details.get("displayName")
                or None
            )
        except Exception:  # noqa: BLE001 — label is cosmetic
            logger.warning(
                "gocardless: could not fetch label for account %s — "
                "falling back to placeholder",
                account_id[:8] + "…" if len(account_id) > 8 else account_id,
            )
            return None

    def list_transactions(
        self,
        account_id: str,
        since: datetime | None,
    ) -> list[AiiaTransaction]:
        """Fetch booked transactions since `since`.  GoCardless caps
        lookback at the agreement's `max_historical_days` (90 by
        default; we don't tighten further to keep reconciliation
        bootstrap easy)."""
        params: dict[str, str] = {}
        if since is not None:
            # GC accepts YYYY-MM-DD strings.  Drop timezone to avoid
            # off-by-one on locales — GC interprets in the institution's
            # timezone anyway.
            since_d = since.date() if isinstance(since, datetime) else since
            params["date_from"] = since_d.isoformat()
        # date_to = today; without it some institutions return only the
        # last 24h.  Send YYYY-MM-DD in UTC.
        params["date_to"] = datetime.now(timezone.utc).date().isoformat()

        data = self._request(
            "GET", f"/accounts/{account_id}/transactions/", params=params,
        )
        booked = (data.get("transactions") or {}).get("booked") or []
        out: list[AiiaTransaction] = []
        for raw in booked:
            try:
                out.append(self._txn_from_raw(raw))
            except Exception:  # noqa: BLE001
                # Skip malformed rows — never let one corrupt entry
                # nuke the whole sync.  Log once per skip.
                logger.warning(
                    "gocardless: skipping malformed txn raw=%s",
                    repr(raw)[:200],
                )
        return out

    def _txn_from_raw(self, raw: dict) -> AiiaTransaction:
        amount_obj = raw.get("transactionAmount") or {}
        amount = float(amount_obj.get("amount") or 0.0)
        currency = amount_obj.get("currency") or "DKK"
        # GC IDs come in several shapes; pick the most stable.
        txn_id = (
            raw.get("transactionId")
            or raw.get("internalTransactionId")
            or raw.get("entryReference")
            or f"gc_{hash(repr(raw))}"  # last-ditch synthetic
        )
        booking = raw.get("bookingDate") or raw.get("valueDate") or ""
        try:
            booked_date = date.fromisoformat(booking) if booking else date.today()
        except ValueError:
            booked_date = date.today()
        # Direction: positive amount = inflow (Sale), negative = outflow.
        counterparty = (
            raw.get("creditorName")
            if amount >= 0
            else raw.get("debtorName")
        ) or raw.get("remittanceInformationStructured") or "Unknown"
        description = (
            raw.get("remittanceInformationUnstructured")
            or raw.get("additionalInformation")
            or ""
        )
        return AiiaTransaction(
            aiia_txn_id=str(txn_id),
            booked_date=booked_date,
            amount=amount,
            currency=currency,
            description=description[:255],
            counterparty=str(counterparty)[:120],
        )

    def refresh(self, refresh_token: str) -> dict:
        """No-op for GoCardless.  The requisition_id (stored in
        `refresh_token` slot per exchange_code's contract) stays valid
        for 90 days under the SCA agreement; no per-user token refresh.

        We return a stub so the existing /sync code path keeps working.
        """
        return {
            "access_token": "",  # GC uses service-level auth
            "refresh_token": refresh_token,  # unchanged — still the requisition_id
            "expires_in": 7776000,
        }

    def revoke(self, account_id: str) -> None:
        """Tell GoCardless to drop the consent.  We delete the
        requisition (which revokes access to all linked accounts under
        it).  Idempotent — 404 on already-deleted is fine."""
        # The router calls this with the account_id; GoCardless wants
        # the requisition_id.  We can derive one from the other by
        # looking up the account's requisition, but the simpler shape is
        # to expose a separate `revoke_requisition` method the router
        # calls when it knows the requisition_id.  For now: best-effort
        # query.
        try:
            # /accounts/{id}/ returns the parent requisition_id.
            data = self._request("GET", f"/accounts/{account_id}/")
            requisition_id = data.get("requisition")
            if not requisition_id:
                logger.info(
                    "gocardless.revoke: account %s has no parent requisition",
                    account_id,
                )
                return
        except GoCardlessClientError as e:
            if e.kind == "not_found":
                return
            raise
        try:
            self._request("DELETE", f"/requisitions/{requisition_id}/")
        except GoCardlessClientError as e:
            if e.kind == "not_found":
                # Already gone — idempotent.
                return
            raise

    def revoke_requisition(self, requisition_id: str) -> None:
        """Direct revoke when the router already has the requisition_id
        from the BankConnection row.  Saves the /accounts lookup."""
        try:
            self._request("DELETE", f"/requisitions/{requisition_id}/")
        except GoCardlessClientError as e:
            if e.kind == "not_found":
                return
            raise


# ─── Factory ──────────────────────────────────────────────────────────


def get_gocardless_client() -> GoCardlessClient:
    """Construct a GoCardlessClient from settings.  Raises a
    GoCardlessClientError if BANK_PROVIDER=gocardless but creds are
    missing — the factory in `aiia_client.py` falls back to the mock
    when this fires so the rest of the app stays alive."""
    from app.config import settings
    return GoCardlessClient(
        base_url=settings.GOCARDLESS_BASE_URL,
        secret_id=settings.GOCARDLESS_SECRET_ID,
        secret_key=settings.GOCARDLESS_SECRET_KEY,
    )
