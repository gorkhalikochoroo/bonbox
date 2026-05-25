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
            POST /connect_sessions/create → returns connect_url
            Salt Edge's UI walks the owner through bank + MitID SCA.
  /cb     → Salt Edge appends `?connection_id=<uuid>&customer_id=<uuid>`
            to our return_to.  We also pre-set ?state=<our state> in
            return_to so CSRF validation works regardless.
  exchange→ Salt Edge connection_id arrives via URL.  We GET
            /accounts?connection_id=… to discover linked accounts.

Security: same posture as the GoCardless client.  Secrets in env
only, never logged.  HTTPS-only with verify=True + 10s timeout.
All errors mapped to AiiaClientError with kind hints.  Idempotent
revoke (DELETE /connections/{id}).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
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
        """
        try:
            data = response.json() if response.content else {}
        except ValueError:
            data = {}
        error_obj = data.get("error") or {}
        klass = error_obj.get("class") or ""
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

    def _ensure_customer(self, identifier: str) -> str:
        """Find-or-create a Salt Edge customer keyed by our identifier.

        Salt Edge POST /customers is idempotent on `identifier` —
        returns the existing customer if the identifier was used before.
        We use our consent_state token as the identifier so each
        consent flow can be traced back without ever exposing user_id
        to Salt Edge.
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
                items = (lookup.get("data") or [])
                if not items:
                    raise SaltEdgeClientError(
                        "Salt Edge: CustomerAlreadyExists but lookup empty",
                        status=502, kind="protocol",
                    ) from e
                return items[0]["id"]
            raise
        customer_id = (data.get("data") or {}).get("id")
        if not customer_id:
            # Diagnostic: include the actual Salt Edge response body so we
            # can tell whether this is Pending-mode gating, a v6 schema
            # change, or an empty `data` array. Body is capped at 400 chars.
            body_str = str(data)[:400] if data else "empty"
            logger.warning(
                "saltedge._ensure_customer: 2xx but no data.id. body=%s",
                body_str,
            )
            raise SaltEdgeClientError(
                f"Salt Edge POST /customers returned no id. "
                f"Response body: {body_str}",
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
                    "scopes": ["account_details", "transactions_details"],
                    # 90-day SCA window — matches DK PSD2 max.
                    "from_date": None,  # Salt Edge defaults to provider's max history
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
        result = self._request(
            "POST", "/connect_sessions/create", json_body=body,
        )
        session = result.get("data") or {}
        connect_url = session.get("connect_url")
        # session_id and expires_at exist too but we don't need them —
        # connection_id will arrive on the callback URL once SCA completes.
        if not connect_url:
            raise SaltEdgeClientError(
                "Salt Edge POST /connect_sessions returned no connect_url",
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
        conn = conn_data.get("data") or {}
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
        accounts = accounts_data.get("data") or []
        if not accounts:
            raise SaltEdgeClientError(
                "Salt Edge connection is active but lists no accounts",
                status=502, kind="protocol",
            )
        primary = accounts[0]
        return {
            "account_id": primary.get("id") or "",
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
            rows = data.get("data") or []
            for raw in rows:
                try:
                    out.append(self._txn_from_raw(raw))
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "saltedge: skipping malformed txn raw=%s",
                        repr(raw)[:200],
                    )
            meta = data.get("meta") or {}
            next_id = meta.get("next_id")
            if not next_id:
                break
        return out

    def _txn_from_raw(self, raw: dict) -> AiiaTransaction:
        # Salt Edge transaction shape:
        # {id, mode, status, made_on, amount, currency_code, description,
        #  category, duplicated, extra: {original_amount, ...}, ...}
        amount = float(raw.get("amount") or 0.0)
        currency = raw.get("currency_code") or "DKK"
        txn_id = raw.get("id") or ""
        made_on = raw.get("made_on") or ""
        try:
            booked_date = date.fromisoformat(made_on) if made_on else date.today()
        except ValueError:
            booked_date = date.today()
        description = raw.get("description") or ""
        # Salt Edge doesn't always populate counterparty; fall back to
        # parsing the description's first line.
        extra = raw.get("extra") or {}
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
            connection_id = (data.get("data") or {}).get("connection_id")
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
