"""
Salt Edge Account Information client — task #105.

Backup PSD2 provider since GoCardless paused new signups.  Self-serve
developer signup at https://www.saltedge.com/dashboard yields an
App-id + Secret pair for the free Customer plan.  Covers DK
banks (Danske, Nordea, Jyske, Lunar) plus the broader EU/UK list.

Implements the same `AiiaClient` Protocol as the GoCardless and
mock clients so `/api/bank-connect/*` doesn't care which provider
is wired in.  Selection happens via `BANK_PROVIDER=saltedge`.

Flow differences vs Aiia / GoCardless:

  /init   → POST /customers (idempotent via our state as identifier)
            POST /connections/connect → returns connect_url
            Salt Edge's UI walks the owner through bank + MitID SCA.
  /cb     → Salt Edge appends `?connection_id=<uuid>&customer_id=<uuid>`
            to our return_to.  We also pre-set ?state=<our state> in
            return_to so CSRF validation works regardless.
  exchange→ Salt Edge connection_id arrives via URL.  We GET
            /accounts?connection_id=… to discover linked accounts.

API version: v6.  Salt Edge renamed several endpoints in v6
(see https://docs.saltedge.com/v6/#migration-guide):

  v5 path                       → v6 path
  POST /connect_sessions/create → POST /connections/connect
  POST /connect_sessions/reconnect → POST /connections/{id}/reconnect
  POST /connect_sessions/refresh   → POST /connections/{id}/refresh

  /customers, /connections, /accounts, /transactions paths unchanged.

Required env vars on Render:

  SALTEDGE_BASE_URL = https://www.saltedge.com/api/v6
                      (no trailing slash; the v5 default in config.py
                       is wrong — Render must override to v6 or POST
                       /customers AND POST /connections/connect both
                       404)
  SALTEDGE_APP_ID
  SALTEDGE_SECRET

Salt Edge 'Pending' mode note: a freshly-registered Salt Edge app
sits in 'Pending' until Salt Edge approves Test access.  In Pending
mode only the sandbox `fakebank_simple_xf` provider is reachable;
real-bank `provider_code`s return ProviderDisabled.  The router
forces sandbox via `sandbox_mode_default()` so this works end-to-end
without waiting for approval — the same API host (www.saltedge.com)
serves both sandbox and production providers, there is NO separate
sandbox subdomain.

Security: same posture as the GoCardless client.  Secrets in env
only, never logged.  HTTPS-only with verify=True + 10s timeout.
All errors mapped to AiiaClientError with kind hints.  Idempotent
revoke (DELETE /connections/{id}).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from app.services.aiia_client import AiiaClientError, AiiaTransaction

logger = logging.getLogger(__name__)

SaltEdgeClientError = AiiaClientError


# Slug → Salt Edge provider_code.  Salt Edge appends `_dk` for Danish
# entities; the canonical list is in their dashboard under
# "Providers".  Operators can extend via constructor override without
# code changes.
_DK_PROVIDER_MAP: dict[str, str] = {
    "danske_bank": "danske_bank_dk",
    "nordea": "nordea_dk",
    "jyske_bank": "jyske_bank_dk",
    "lunar": "lunar_dk",
    "revolut": "revolut_eu",
    "sandbox": "fakebank_simple_xf",
}


class SaltEdgeClient:
    """Salt Edge Account Information HTTP client.

    Salt Edge auth: App-id + Secret in HTTP headers on every call.
    No token endpoint, no expiry — auth headers are static per
    deployment.  (Optional RSA request signing is available on
    higher tiers; we use header auth on Customer plan.)
    """

    _DEFAULT_TIMEOUT_S = 10.0
    _COUNTRY = "DK"  # widen later if we add ROW support

    def __init__(
        self,
        base_url: str,
        app_id: str,
        secret: str,
        *,
        provider_map_overrides: dict[str, str] | None = None,
        timeout_s: float | None = None,
    ):
        if not (base_url and app_id and secret):
            raise SaltEdgeClientError(
                "Salt Edge client requires SALTEDGE_BASE_URL, "
                "SALTEDGE_APP_ID, and SALTEDGE_SECRET env vars.",
                status=500, kind="config",
            )
        self.base_url = base_url.rstrip("/")
        self.app_id = app_id
        self.secret = secret
        self.timeout_s = timeout_s or self._DEFAULT_TIMEOUT_S
        self._provider_map = {**_DK_PROVIDER_MAP, **(provider_map_overrides or {})}

    # ─── HTTP layer ────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "App-id": self.app_id,
            "Secret": self.secret,
            "User-Agent": "BonBox/1.0 (+https://bonbox.dk)",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(
                timeout=self.timeout_s, verify=True, follow_redirects=False,
            ) as client:
                response = client.request(
                    method, url, headers=self._headers(),
                    json=json_body, params=params,
                )
        except httpx.TimeoutException as e:
            raise SaltEdgeClientError(
                f"Salt Edge timeout on {method} {path}",
                status=504, kind="timeout",
            ) from e
        except httpx.HTTPError as e:
            raise SaltEdgeClientError(
                f"Salt Edge transport error on {method} {path}: {type(e).__name__}",
                status=502, kind="transport",
            ) from e

        if response.status_code >= 400:
            self._raise_for_response(response, method, path)
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as e:
            raise SaltEdgeClientError(
                f"Salt Edge non-JSON body on {method} {path}",
                status=502, kind="protocol",
            ) from e

    def _raise_for_response(
        self, response: httpx.Response, method: str, path: str,
    ) -> None:
        """Salt Edge error bodies: {"error":{"class":"ConnectionNotFound",
        "message":"…","documentation_url":"…"}}.  Surface class +
        message capped, log at WARNING — these are upstream issues.

        Type-guarded against schema drift.  Salt Edge in 'Pending' mode
        or under upstream incidents has been observed returning shapes
        like a bare JSON string `"some error"` (`data` becomes a `str`),
        or the documented envelope but with `{"error": "string message"}`
        instead of `{"error": {"class": ..., "message": ...}}`
        (`error_obj` becomes a `str`).  Without these isinstance checks
        the bare `.get()` raises AttributeError → opaque 500 to the
        owner (the May 2026 Connect-bank incident).
        """
        try:
            data = response.json() if response.content else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        raw_error = data.get("error")
        error_obj = raw_error if isinstance(raw_error, dict) else {}
        klass = error_obj.get("class") or ""
        # When Salt Edge returns `{"error": "some string"}`, surface that
        # string as the message rather than discarding it — operators
        # still need the upstream signal even if the envelope drifted.
        if not error_obj and isinstance(raw_error, str):
            message = raw_error[:200]
        else:
            message = error_obj.get("message") or response.text[:200]
        logger.warning(
            "saltedge: %d on %s %s class=%s msg=%s",
            response.status_code, method, path, klass,
            (message or "no body")[:200],
        )
        status_hint = {
            400: 400,
            401: 502,  # bad creds — our config bug
            403: 502,
            404: 404,
            409: 409,
            429: 429,
        }.get(response.status_code, 502)
        kind_hint = {
            "InvalidCredentials": "auth",
            "ConnectionNotFound": "not_found",
            "ProviderDisabled": "scope",
            "TooManyRequests": "rate_limit",
        }.get(klass, "upstream")
        raise SaltEdgeClientError(
            f"Salt Edge {response.status_code} on {method} {path}: "
            f"{klass or 'error'} — {message[:150]}",
            status=status_hint, kind=kind_hint,
        )

    # ─── Bank slug → provider_code ─────────────────────────────────────

    def _provider_code(self, bank_slug: str | None, *, sandbox: bool = False) -> str:
        if sandbox:
            return self._provider_map["sandbox"]
        if not bank_slug:
            raise SaltEdgeClientError(
                "bank_slug is required for Salt Edge init_consent",
                status=400, kind="missing_bank",
            )
        code = self._provider_map.get(bank_slug)
        if not code:
            raise SaltEdgeClientError(
                f"Salt Edge: bank '{bank_slug}' not in provider map. "
                f"Valid: {sorted(self._provider_map.keys())}",
                status=400, kind="unknown_bank",
            )
        return code

    # ─── Customer (idempotent) ─────────────────────────────────────────

    # Keys we redact when diagnostically logging Salt Edge response
    # bodies.  Salt Edge POST /customers returns a per-customer `secret`
    # field; logging or surfacing it in an HTTPException would leak it
    # to operators (logs) AND to the HTTP caller (router maps the
    # exception message into a 502 response body).
    _SE_REDACT_KEYS = ("secret", "access_token", "refresh_token", "token")

    @classmethod
    def _redact_body_for_logs(cls, data: Any) -> str:
        """Render a tiny, secrets-redacted diagnostic string of a
        Salt Edge response.  Never includes raw `secret` fields, never
        embeds the response body verbatim.  Capped length so a hostile
        response can't bloat a log line.

        We intentionally do NOT json-serialise the redacted dict back —
        we emit a tag-style summary (`keys=[...] id_present=False`) so
        even a future Salt Edge response shape change can't sneak a new
        secret-bearing field into our logs.
        """
        if not isinstance(data, dict):
            return f"non_dict_type={type(data).__name__}"
        payload = data.get("data")
        if isinstance(payload, dict):
            keys = sorted(payload.keys())
            keys_redacted = [
                f"{k}=<redacted>" if k in cls._SE_REDACT_KEYS else k
                for k in keys
            ]
            id_present = bool(payload.get("customer_id") or payload.get("id"))
            return f"data.keys=[{','.join(keys_redacted)}] id_present={id_present}"
        if isinstance(payload, list):
            return f"data=list(len={len(payload)})"
        top_keys = sorted(data.keys())
        return f"top_keys=[{','.join(top_keys)}]"

    def _ensure_customer(self, identifier: str) -> str:
        """Find-or-create a Salt Edge customer keyed by our identifier.

        Salt Edge POST /customers is idempotent on `identifier` —
        returns the existing customer if the identifier was used before.
        We use our consent_state token as the identifier so each
        consent flow can be traced back without ever exposing user_id
        to Salt Edge.

        Security: Salt Edge's success response carries a per-customer
        `secret` field.  We never echo the raw response body into logs
        or exception messages — diagnostic info is summarised via
        `_redact_body_for_logs` so a future "no id returned" bug can be
        debugged without leaking the secret to ops dashboards or to the
        HTTP caller (the router maps our exception message into a 502
        response body).
        """
        try:
            data = self._request(
                "POST", "/customers",
                json_body={"data": {"identifier": identifier}},
            )
        except SaltEdgeClientError as e:
            # On "CustomerAlreadyExists", look up the existing one.
            if "CustomerAlreadyExists" in str(e):
                lookup = self._request(
                    "GET", "/customers", params={"identifier": identifier},
                )
                # Type-guard: Salt Edge in non-standard states (Pending mode,
                # account-locked, etc.) can return shapes other than the
                # documented `{"data": [...]}` envelope.  Without these
                # isinstance checks, `lookup.get(...)` or `first.get(...)`
                # raises a bare AttributeError that the global exception
                # handler turns into an opaque 500 — the May 2026 incident
                # that took the Connect-bank button down.
                if not isinstance(lookup, dict):
                    raise SaltEdgeClientError(
                        f"Salt Edge GET /customers returned non-dict body "
                        f"(type={type(lookup).__name__}). Likely an upstream "
                        f"outage or app-permission downgrade.",
                        status=502, kind="protocol",
                    ) from e
                items = lookup.get("data") or []
                if not isinstance(items, list):
                    raise SaltEdgeClientError(
                        f"Salt Edge GET /customers data field has "
                        f"unexpected type ({type(items).__name__})",
                        status=502, kind="protocol",
                    ) from e
                if not items:
                    raise SaltEdgeClientError(
                        "Salt Edge: CustomerAlreadyExists but lookup empty",
                        status=502, kind="protocol",
                    ) from e
                # v6 returns `customer_id`; v5 returned `id`. Defensive read.
                first = items[0]
                if not isinstance(first, dict):
                    raise SaltEdgeClientError(
                        f"Salt Edge GET /customers row 0 is not a dict "
                        f"(type={type(first).__name__})",
                        status=502, kind="protocol",
                    ) from e
                cust_id = first.get("customer_id") or first.get("id")
                if not cust_id:
                    # Don't echo the lookup row — it may contain a secret.
                    logger.warning(
                        "saltedge._ensure_customer: lookup row missing "
                        "customer_id (keys=%s)",
                        sorted(first.keys()),
                    )
                    raise SaltEdgeClientError(
                        "Salt Edge: lookup hit but no customer_id",
                        status=502, kind="protocol",
                    ) from e
                return cust_id
            raise
        # v6 returns `data.customer_id`; v5 returned `data.id`. Verified from
        # a live response on 2026-05-25 — root cause of the original "returned
        # no id" error. Defensive: try v6 name first, fall back to legacy `id`.
        if not isinstance(data, dict):
            # Salt Edge in Pending mode (or during an upstream incident) has
            # been observed returning bare strings instead of the documented
            # JSON envelope.  Without this guard, `data.get(...)` raises a
            # bare AttributeError and the user sees an opaque 500.
            raise SaltEdgeClientError(
                f"Salt Edge POST /customers returned non-dict body "
                f"(type={type(data).__name__}). Likely the app is still in "
                f"'Pending' mode — request Test access in the Salt Edge "
                f"dashboard to enable real-bank providers.",
                status=502, kind="protocol",
            )
        payload = data.get("data") or {}
        if not isinstance(payload, dict):
            raise SaltEdgeClientError(
                f"Salt Edge POST /customers data field is not a dict "
                f"(type={type(payload).__name__}). Likely Salt Edge is "
                f"returning an error envelope rather than the customer "
                f"object — check the Salt Edge dashboard for app status.",
                status=502, kind="protocol",
            )
        customer_id = payload.get("customer_id") or payload.get("id")
        if not customer_id:
            # Redact before logging — Salt Edge's 2xx response body
            # contains a per-customer `secret` field we must not surface.
            logger.warning(
                "saltedge._ensure_customer: 2xx but no customer_id. shape=%s",
                self._redact_body_for_logs(data),
            )
            # Generic exception message — the redacted shape stays in
            # logs only.  Router re-raises this as a 502 HTTP response
            # so the response body must NOT carry the raw body.
            raise SaltEdgeClientError(
                "Salt Edge POST /customers returned no customer_id "
                "(see server logs for redacted response shape)",
                status=502, kind="protocol",
            )
        return customer_id

    # ─── AiiaClient Protocol ───────────────────────────────────────────

    def init_consent(
        self,
        redirect_uri: str,
        state: str,
        *,
        bank_slug: str | None = None,
        sandbox: bool = False,
        on_provider_ids: Any = None,
    ) -> str:
        """Begin the SCA flow.  Returns the Salt Edge Connect URL
        the owner visits to pick their bank + authenticate via MitID.

        We pre-encode our state token into the return_to URL so the
        callback handler's CSRF validation works the same way it does
        for Aiia + GoCardless.  Salt Edge appends `connection_id` and
        `customer_id` to that URL on the way back.
        """
        provider_code = self._provider_code(bank_slug, sandbox=sandbox)
        customer_id = self._ensure_customer(identifier=state)

        # Bake the state token into return_to so the callback has it
        # even though Salt Edge doesn't echo arbitrary custom fields.
        sep = "&" if "?" in redirect_uri else "?"
        return_to = f"{redirect_uri}{sep}state={state}"

        body = {
            "data": {
                "customer_id": customer_id,
                "consent": {
                    # v6 renamed the consent scope tokens (verified live
                    # 2026-05-25 via WrongRequestFormat from Salt Edge):
                    #   v5 "account_details"      → v6 "accounts"
                    #   v5 "transactions_details" → v6 "transactions"
                    # Salt Edge v6 also accepts "holder_info" for the
                    # account-owner identity surface; we don't need it
                    # for invoice/MOMS reconciliation so leave it off
                    # (smaller consent ask = better UX on the SCA page).
                    "scopes": ["accounts", "transactions"],
                    # 90-day SCA window — matches DK PSD2 max.  v6 now
                    # REQUIRES `from_date` to be a real ISO date; passing
                    # None or omitting it returns
                    # "data.consent.from_date parameter must be filled"
                    # (verified live 2026-05-25).  Compute today minus 90d
                    # at call time so the consent always asks for the
                    # PSD2 maximum lookback.  We deliberately don't cap
                    # at 89d — Salt Edge enforces its own DK provider
                    # limits and the user gets the most history possible.
                    "from_date": (
                        date.today() - timedelta(days=90)
                    ).isoformat(),
                    "period_days": 90,
                },
                "attempt": {
                    "return_to": return_to,
                    "fetch_scopes": ["accounts", "transactions"],
                    "locale": "da",
                },
                "provider_code": provider_code,
                "country_code": self._COUNTRY,
            },
        }
        # v6: POST /connections/connect (was /connect_sessions/create in v5).
        # The v5 path returns 404 on a v6 base URL; the v6 path is the only
        # one that exists on `https://www.saltedge.com/api/v6`.  See the
        # migration guide at https://docs.saltedge.com/v6/#migration-guide.
        result = self._request(
            "POST", "/connections/connect", json_body=body,
        )
        # Type-guard the response shape.  Salt Edge in 'Pending' mode rejects
        # real-bank providers (anything other than the fake-bank slug) and has
        # been observed returning non-standard shapes that crash a naive
        # `result.get(...)` with AttributeError.  Replace any such crash with
        # a clean SaltEdgeClientError so the router maps it to 502 with an
        # actionable message.
        if not isinstance(result, dict):
            raise SaltEdgeClientError(
                f"Salt Edge POST /connections/connect returned non-dict "
                f"body (type={type(result).__name__}). Likely the app is "
                f"still in 'Pending' mode and rejects real-bank providers — "
                f"request Test access in the Salt Edge dashboard, or pass "
                f"sandbox=True to use the fakebank provider.",
                status=502, kind="protocol",
            )
        session = result.get("data") or {}
        if not isinstance(session, dict):
            raise SaltEdgeClientError(
                f"Salt Edge POST /connections/connect data field is "
                f"not a dict (type={type(session).__name__})",
                status=502, kind="protocol",
            )
        connect_url = session.get("connect_url")
        # session_id and expires_at exist too but we don't need them —
        # connection_id will arrive on the callback URL once SCA completes.
        if not connect_url:
            raise SaltEdgeClientError(
                "Salt Edge POST /connections/connect returned no connect_url",
                status=502, kind="protocol",
            )
        if callable(on_provider_ids):
            try:
                # We don't have connection_id yet (that's minted post-SCA),
                # but stash the customer_id + provider_code so the router
                # can persist them and look up by them later if needed.
                on_provider_ids(
                    requisition_id=customer_id,
                    institution_id=provider_code,
                )
            except Exception:  # noqa: BLE001
                logger.exception("saltedge.init_consent: on_provider_ids raised")
        return connect_url

    def exchange_code(
        self,
        code: str,
        *,
        requisition_id: str | None = None,
        connection_id: str | None = None,
    ) -> dict:
        """Resolve the SCA round-trip → account_id + label.

        For Salt Edge, the live consent ID is `connection_id`, which
        arrives on the callback URL — NOT the customer_id stored at
        /init.  The router passes it as the `connection_id` kwarg.

        `code` is ignored for Salt Edge (kept in signature for
        Protocol compatibility).
        """
        if not connection_id:
            raise SaltEdgeClientError(
                "Salt Edge exchange_code requires connection_id from the "
                "callback URL (router must thread the query param through)",
                status=400, kind="missing_connection",
            )

        # Verify the connection actually authenticated successfully.
        conn_data = self._request("GET", f"/connections/{connection_id}")
        if not isinstance(conn_data, dict):
            raise SaltEdgeClientError(
                f"Salt Edge GET /connections returned non-dict body "
                f"(type={type(conn_data).__name__})",
                status=502, kind="protocol",
            )
        conn = conn_data.get("data") or {}
        if not isinstance(conn, dict):
            raise SaltEdgeClientError(
                f"Salt Edge GET /connections data field is not a dict "
                f"(type={type(conn).__name__})",
                status=502, kind="protocol",
            )
        status = (conn.get("status") or "").lower()
        if status != "active":
            raise SaltEdgeClientError(
                f"Salt Edge connection status={status} (expected active). "
                f"User may have cancelled at the bank.",
                status=400, kind="auth_incomplete",
            )

        accounts_data = self._request(
            "GET", "/accounts", params={"connection_id": connection_id},
        )
        if not isinstance(accounts_data, dict):
            raise SaltEdgeClientError(
                f"Salt Edge GET /accounts returned non-dict body "
                f"(type={type(accounts_data).__name__})",
                status=502, kind="protocol",
            )
        accounts = accounts_data.get("data") or []
        if not isinstance(accounts, list):
            raise SaltEdgeClientError(
                f"Salt Edge GET /accounts data field is not a list "
                f"(type={type(accounts).__name__})",
                status=502, kind="protocol",
            )
        if not accounts:
            raise SaltEdgeClientError(
                "Salt Edge connection is active but lists no accounts",
                status=502, kind="protocol",
            )
        primary = accounts[0]
        if not isinstance(primary, dict):
            raise SaltEdgeClientError(
                f"Salt Edge GET /accounts row 0 is not a dict "
                f"(type={type(primary).__name__})",
                status=502, kind="protocol",
            )
        # v6 returns `account_id`; v5 returned `id`. Same drift pattern as
        # /customers — defensive read.
        acc_id = primary.get("account_id") or primary.get("id") or ""
        return {
            "account_id": acc_id,
            "account_label": primary.get("name") or "Erhverv driftskonto",
            # Same trick as GoCardless: requisition_id slot holds the
            # long-lived consent identifier (connection_id here).  At
            # sync + revoke time we read this from the encrypted column.
            "refresh_token": connection_id,
            "access_token": "",
            # Salt Edge consents follow PSD2's 90-day window.
            "expires_in": 7776000,
        }

    def list_transactions(
        self,
        account_id: str,
        since: datetime | None,
    ) -> list[AiiaTransaction]:
        params: dict[str, Any] = {"account_id": account_id}
        if since is not None:
            since_d = since.date() if isinstance(since, datetime) else since
            params["from_date"] = since_d.isoformat()
        params["to_date"] = datetime.now(timezone.utc).date().isoformat()

        # Salt Edge paginates via `next_id` cursor; fetch up to 5 pages
        # (5000 txns) per sync to bound demo runtime.
        out: list[AiiaTransaction] = []
        next_id: str | None = None
        for _page in range(5):
            page_params = dict(params)
            if next_id:
                page_params["from_id"] = next_id
            data = self._request("GET", "/transactions", params=page_params)
            # Type-guard: if Salt Edge returns a non-dict body we still
            # want to bail cleanly rather than AttributeError → 500.
            if not isinstance(data, dict):
                raise SaltEdgeClientError(
                    f"Salt Edge GET /transactions returned non-dict body "
                    f"(type={type(data).__name__})",
                    status=502, kind="protocol",
                )
            rows = data.get("data") or []
            if not isinstance(rows, list):
                rows = []
            for raw in rows:
                try:
                    out.append(self._txn_from_raw(raw))
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "saltedge: skipping malformed txn raw=%s",
                        repr(raw)[:200],
                    )
            meta = data.get("meta") or {}
            if not isinstance(meta, dict):
                meta = {}
            next_id = meta.get("next_id")
            if not next_id:
                break
        return out

    def _txn_from_raw(self, raw: dict) -> AiiaTransaction:
        # Salt Edge transaction shape:
        # {id, mode, status, made_on, amount, currency_code, description,
        #  category, duplicated, extra: {original_amount, ...}, ...}
        # Type-guard the row itself so a string/list row from a drifted
        # response shape can't crash this with AttributeError — the
        # list_transactions caller will then log + skip via its
        # except-Exception malformed-row handler.
        if not isinstance(raw, dict):
            raise ValueError(f"saltedge txn row not a dict (type={type(raw).__name__})")
        amount = float(raw.get("amount") or 0.0)
        currency = raw.get("currency_code") or "DKK"
        # v6 returns `transaction_id`; v5 returned `id`. Same drift pattern.
        txn_id = raw.get("transaction_id") or raw.get("id") or ""
        made_on = raw.get("made_on") or ""
        try:
            booked_date = date.fromisoformat(made_on) if made_on else date.today()
        except ValueError:
            booked_date = date.today()
        description = raw.get("description") or ""
        # Salt Edge doesn't always populate counterparty; fall back to
        # parsing the description's first line.  `extra` has been observed
        # as null or a string on edge cases — guard so a non-dict can't
        # crash us with AttributeError.
        raw_extra = raw.get("extra")
        extra = raw_extra if isinstance(raw_extra, dict) else {}
        counterparty = (
            extra.get("payee")
            or extra.get("merchant_name")
            or (description.split(" ")[0] if description else "Unknown")
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
        """No-op: Salt Edge connections stay active for 90 days under
        SCA agreement; no per-call refresh needed.  Stub for Protocol
        compat."""
        return {
            "access_token": "",
            "refresh_token": refresh_token,
            "expires_in": 7776000,
        }

    def revoke(self, account_id: str) -> None:
        """Best-effort revoke from account_id.  We need connection_id;
        derive it via GET /accounts/{id}.  Idempotent on 404."""
        try:
            data = self._request("GET", f"/accounts/{account_id}")
            # Type-guard against drift — a non-dict body or a string
            # `data` field would otherwise crash with AttributeError.
            if not isinstance(data, dict):
                return
            payload = data.get("data")
            if not isinstance(payload, dict):
                return
            connection_id = payload.get("connection_id")
            if not connection_id:
                return
        except SaltEdgeClientError as e:
            if e.kind == "not_found":
                return
            raise
        self.revoke_connection(connection_id)

    def revoke_connection(self, connection_id: str) -> None:
        """Direct revoke when the router has the connection_id from
        the BankConnection row.  Idempotent on 404."""
        try:
            self._request("DELETE", f"/connections/{connection_id}")
        except SaltEdgeClientError as e:
            if e.kind == "not_found":
                return
            raise


def get_saltedge_client() -> SaltEdgeClient:
    """Construct a SaltEdgeClient from settings.  Raises on missing
    config so the factory can fall back to mock."""
    from app.config import settings
    return SaltEdgeClient(
        base_url=settings.SALTEDGE_BASE_URL,
        app_id=settings.SALTEDGE_APP_ID,
        secret=settings.SALTEDGE_SECRET,
    )
