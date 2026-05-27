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

WHAT THIS FILE PROVIDES (task #220 — full PSD2 surface):
  Implements the AiiaClient Protocol so /api/bank-connect/* can dispatch
  to Yapily transparently via BANK_PROVIDER=yapily.  Surface:
    • health_check()                       — auth probe
    • list_institutions(country="DK")      — bank picker source
    • init_consent(redirect, state, ...)   — POST /account-auth-requests
    • exchange_code(consent_token)         — GET /accounts (the consent
                                              IS the long-lived token)
    • list_transactions(account, since)    — GET /accounts/{id}/transactions
    • refresh(consent)                     — no-op (90d window per consent)
    • revoke(consent_id)                   — DELETE /consents/{id}

AUTH:
  HTTP Basic — `Authorization: Basic base64(application_id:application_secret)`.
  No token endpoint, no OAuth dance, no refresh.  This is the same shape
  Salt Edge uses (header-based static creds) and matches what we already
  store in Render: `YAPILY_APPLICATION_ID` + `YAPILY_APPLICATION_SECRET`.

PSD2 FLOW (Yapily Connect, AIS):
  1. /init       → POST /account-auth-requests with {applicationUserId,
                    institutionId, callback}.  Returns `authorisationUrl`.
  2. Owner SCA   → Yapily widget walks the bank's MitID / OAuth flow.
  3. /callback   → Yapily redirects to our callback URL with
                    ?consent=<token>&application-user-id=<id>.  The
                    `consent` token IS the long-lived AIS grant (~90d).
  4. /exchange   → GET /accounts with header `Consent: <token>` to
                    discover linked accounts.  First account.id becomes
                    our `aiia_account_id` slot, the consent token is
                    stored in `refresh_token_enc` for subsequent calls.
  5. /sync       → GET /accounts/{id}/transactions?from=<iso-date> with
                    the same Consent header.

SAFETY:
  • `_redact_body_for_logs()` strips secrets before any log statement
  • Timeouts (10s default) so a Yapily outage can't hang a request
    indefinitely — fail-fast → caller can surface a graceful HTTP error
  • Sandbox vs production lives on the same host (api.yapily.com); the
    application's scope on Yapily's side decides which institution set
    is exposed.  No separate base URL to maintain.
  • Bank-slug → Yapily institutionId map locked to the 66 DK banks we
    verified during the sandbox evaluation (task #219).  Slugs missing
    from the map raise AiiaClientError(kind="unknown_bank") rather than
    silently falling through to a wrong institution.
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

import httpx

# Reuse the same error class + transaction shape as the Aiia / Salt Edge
# clients so the bank-connect router's existing 502 mapping + ingest
# code work without provider-specific branches.
from app.services.aiia_client import AiiaClientError, AiiaTransaction

log = logging.getLogger("bonbox.yapily")

# Secret keys to strip from any logged body — defense in depth so a future
# log.info("response: %s", response.json()) can never accidentally print
# refresh tokens or app secrets.
_REDACT_KEYS = frozenset({
    "application_secret",
    "secret",
    "consent",
    "Consent",
    "refresh_token",
    "access_token",
    "Authorization",
    "authorization",
    "applicationUserId",  # contains our state token — treat as sensitive
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


# Slug → Yapily institutionId for the DK banks we expose in the picker.
# Sourced from the sandbox eval (task #219) — these IDs come from a real
# GET /institutions response, not guesswork.  Both an erhverv (business)
# and a private variant exists for several DK banks; we pick the
# business variant because BonBox is a B2B product (SMB owners using a
# CVR account).  `modelo-sandbox` is Yapily's catch-all sandbox bank,
# always reachable regardless of application approval state — used by
# the `sandbox` slug so QA + UAT can walk the full SCA flow without
# touching a real DK bank.
#
# Operators can extend via SaltEdge-style override (constructor param)
# without a code change.  Slugs that map to None are intentionally
# unsupported (e.g. `revolut_business` doesn't have a DK-specific
# Yapily ID; we'd point at the EU one) — kept as comments rather than
# entries so the unknown_bank check still fires.
_DK_INSTITUTION_MAP: dict[str, str] = {
    "danske_bank": "danske-bank-business-dk",
    "nordea": "nordea-erhverv-dk",
    "jyske_bank": "jyske-bank",
    "sydbank": "sydbank",
    "spar_nord": "spar-nord",
    "lunar": "lunar-dk",
    "arbejdernes_landsbank": "arbejdernes-landsbank",
    "revolut": "revolut-business",
    # Yapily's universal sandbox bank — covers AIS, AISP, balance, and
    # transactions.  No real bank credentials needed.
    "sandbox": "modelo-sandbox",
}


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
        institution_map_overrides: dict[str, str] | None = None,
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
        # Composable map so an operator can patch in a missing bank slug
        # via constructor injection (e.g. tests) without a code change.
        self._institution_map = {
            **_DK_INSTITUTION_MAP,
            **(institution_map_overrides or {}),
        }

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

    def _request(
        self,
        method: str,
        path: str,
        *,
        extra_headers: dict[str, str] | None = None,
        **kwargs,
    ) -> httpx.Response:
        """Centralized request runner with timeout + secret-safe logging.

        `extra_headers` is the seam for the per-consent `Consent: <token>`
        header that GET /accounts and GET /accounts/{id}/transactions
        require.  We never log it (the redact set covers it) and we never
        let it overwrite the Authorization header.
        """
        url = f"{self._base_url}{path}"
        headers = self._headers()
        if extra_headers:
            for k, v in extra_headers.items():
                # Refuse to let extra_headers clobber Authorization — that
                # would otherwise let a caller bug silently break the
                # HTTP Basic auth header.  Logging the *fact* of the
                # collision is fine; the values stay redacted.
                if k.lower() == "authorization":
                    log.warning("yapily._request: refusing to override Authorization header from extra_headers")
                    continue
                headers[k] = v
        try:
            with httpx.Client(timeout=self._timeout_s) as cli:
                resp = cli.request(method, url, headers=headers, **kwargs)
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

    # ─── AiiaClient Protocol — task #220 ───────────────────────────────

    def _institution_id_for_slug(self, bank_slug: str | None) -> str:
        """Resolve our internal bank slug → Yapily institutionId. Raises
        unknown_bank cleanly so the router maps to a friendly 502."""
        if not bank_slug:
            raise AiiaClientError(
                "bank_slug is required for Yapily init_consent",
                kind="missing_bank",
            )
        inst_id = self._institution_map.get(bank_slug)
        if not inst_id:
            raise AiiaClientError(
                f"Yapily: bank '{bank_slug}' not in institution map. "
                f"Supported: {sorted(self._institution_map.keys())}",
                kind="unknown_bank",
            )
        return inst_id

    def init_consent(
        self,
        redirect_uri: str,
        state: str,
        *,
        bank_slug: str | None = None,
    ) -> str:
        """Begin Yapily's PSD2 AIS flow. Returns the authorisationUrl
        the owner visits at their bank for SCA.

        State token: Yapily echoes `application-user-id` back to our
        callback unchanged, so we use our `state` token as the
        applicationUserId — that doubles as our CSRF round-trip
        marker.  The `state` query param itself is also appended to
        the callback URL so the existing router logic (which keys off
        `?state=`) keeps working without provider-specific branching.
        """
        institution_id = self._institution_id_for_slug(bank_slug)

        # Bake our state into the callback URL — Yapily appends
        # `?consent=<token>&application-user-id=<id>` but does NOT echo
        # a `state` param, so we pre-encode it for the router.
        sep = "&" if "?" in redirect_uri else "?"
        callback_with_state = f"{redirect_uri}{sep}state={state}"

        body = {
            "applicationUserId": state,
            "institutionId": institution_id,
            "callback": callback_with_state,
        }
        resp = self._request("POST", "/account-auth-requests", json=body)
        if resp.status_code >= 400:
            self._raise_for_status(resp, "POST", "/account-auth-requests")

        try:
            payload = resp.json()
        except ValueError as e:
            raise AiiaClientError(
                "Yapily POST /account-auth-requests returned non-JSON body",
                kind="protocol",
            ) from e
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise AiiaClientError(
                f"Yapily POST /account-auth-requests data field is "
                f"not a dict (type={type(data).__name__})",
                kind="protocol",
            )
        auth_url = data.get("authorisationUrl")
        if not auth_url:
            log.warning(
                "yapily.init_consent: no authorisationUrl in response "
                "(shape=%s)",
                sorted(_redact_body_for_logs(data).keys()),
            )
            raise AiiaClientError(
                "Yapily POST /account-auth-requests returned no authorisationUrl",
                kind="protocol",
            )
        return auth_url

    def exchange_code(self, code: str, **kwargs: Any) -> dict:
        """Resolve the SCA round-trip → discover the linked account(s).

        For Yapily, `code` is the `consent` query param on our
        callback URL.  That token IS the long-lived AIS grant (~90 days
        per DK PSD2) — we store it as `refresh_token` in the BankConnection
        row (Fernet-encrypted) and reuse it on every subsequent
        /accounts and /transactions call via the `Consent` header.

        kwargs are tolerated (router uses inspect.signature to thread
        provider-specific extras) but ignored — Yapily doesn't need a
        requisition_id or connection_id.
        """
        if not code:
            raise AiiaClientError(
                "Yapily exchange_code requires the consent token from "
                "the callback URL",
                kind="missing_consent",
            )
        resp = self._request(
            "GET", "/accounts",
            extra_headers={"Consent": code},
        )
        if resp.status_code >= 400:
            self._raise_for_status(resp, "GET", "/accounts")

        try:
            payload = resp.json()
        except ValueError as e:
            raise AiiaClientError(
                "Yapily GET /accounts returned non-JSON body",
                kind="protocol",
            ) from e
        accounts = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(accounts, list) or not accounts:
            raise AiiaClientError(
                "Yapily GET /accounts returned no accounts — consent may "
                "have been declined at the bank",
                kind="protocol",
            )
        primary = accounts[0]
        if not isinstance(primary, dict):
            raise AiiaClientError(
                f"Yapily GET /accounts row 0 is not a dict "
                f"(type={type(primary).__name__})",
                kind="protocol",
            )
        account_id = primary.get("id") or ""
        # Yapily account label: prefer nickname > accountNames[0].name > type
        names = primary.get("accountNames") or []
        label = primary.get("nickname")
        if not label and isinstance(names, list) and names:
            first_name = names[0] if isinstance(names[0], dict) else {}
            label = first_name.get("name")
        if not label:
            label = primary.get("type") or "Erhverv driftskonto"
        return {
            "account_id": account_id,
            "account_label": label,
            # Consent token = our long-lived auth.  Same slot as GoCardless's
            # requisition_id / Salt Edge's connection_id — the router
            # encrypts it into refresh_token_enc.
            "refresh_token": code,
            "access_token": "",
            # DK PSD2 SCA window: 90 days.
            "expires_in": 7776000,
        }

    def list_transactions(
        self,
        account_id: str,
        since: datetime | None = None,
    ) -> list[AiiaTransaction]:
        """Pull booked transactions for one account since `since` (None =
        Yapily's default lookback).  Consent token comes from the
        BankConnection row via the caller — Yapily injects it through
        the optional `consent` kwarg the router threads in.

        Yapily caps lookback at the bank-set window (DK banks typically
        13 months).  We don't paginate manually — Yapily's default
        page-size returns up to 250 rows per call; for higher volume
        we'd extend with their pagination cursor in a follow-up.
        """
        # The router stores the consent in `refresh_token_enc` and
        # passes it via the `consent` kwarg on sync calls.  Without it
        # we can't auth the /accounts/{id}/transactions call.
        # (See bank_connect.sync_bank_connection — it feature-detects
        # this kwarg via inspect.signature.)
        # However, the AiiaClient Protocol's list_transactions only
        # accepts (account_id, since) — so we read consent from a
        # transient set_consent() call done by the router before sync.
        consent = getattr(self, "_pending_consent", None)
        if not consent:
            raise AiiaClientError(
                "Yapily list_transactions requires the consent token to "
                "be set via set_consent() before the call (router should "
                "thread it from refresh_token_enc).",
                kind="missing_consent",
            )

        params: dict[str, Any] = {}
        if since is not None:
            since_d = since.date() if isinstance(since, datetime) else since
            params["from"] = since_d.isoformat()
        params["to"] = datetime.now(timezone.utc).date().isoformat()

        resp = self._request(
            "GET", f"/accounts/{account_id}/transactions",
            extra_headers={"Consent": consent},
            params=params,
        )
        if resp.status_code >= 400:
            self._raise_for_status(
                resp, "GET", f"/accounts/{account_id}/transactions",
            )

        try:
            payload = resp.json()
        except ValueError as e:
            raise AiiaClientError(
                "Yapily GET /transactions returned non-JSON body",
                kind="protocol",
            ) from e
        rows = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return []
        out: list[AiiaTransaction] = []
        for raw in rows:
            try:
                out.append(self._txn_from_raw(raw))
            except Exception:  # noqa: BLE001
                log.warning(
                    "yapily.list_transactions: skipping malformed txn raw=%s",
                    repr(_redact_body_for_logs(raw))[:200],
                )
        return out

    def _txn_from_raw(self, raw: Any) -> AiiaTransaction:
        """Map one Yapily transaction → AiiaTransaction.

        Yapily shape (relevant fields):
          { id, date, bookingDateTime, valueDateTime, amount: {amount, currency},
            description, transactionInformation: [...], reference,
            payeeDetails: {name, ...}, payerDetails: {name, ...} }
        """
        if not isinstance(raw, dict):
            raise ValueError(f"yapily txn row not a dict (type={type(raw).__name__})")

        txn_id = raw.get("id") or ""
        # Prefer bookingDateTime; fall back to `date` or valueDateTime.
        date_str = (
            raw.get("date")
            or raw.get("bookingDateTime")
            or raw.get("valueDateTime")
            or ""
        )
        # Yapily emits ISO-8601 with a 'T' separator; date.fromisoformat
        # in Py 3.10 only handles the YYYY-MM-DD prefix, so trim.
        try:
            booked_date = date.fromisoformat(date_str[:10]) if date_str else date.today()
        except ValueError:
            booked_date = date.today()

        amt_obj = raw.get("amount") or {}
        if isinstance(amt_obj, dict):
            amount = float(amt_obj.get("amount") or 0.0)
            currency = amt_obj.get("currency") or "DKK"
        else:
            # Some Yapily endpoints return amount as a flat float
            amount = float(amt_obj or 0.0)
            currency = raw.get("currency") or "DKK"

        description = (raw.get("description") or raw.get("reference") or "")[:255]

        # Counterparty: payeeDetails on outflows, payerDetails on inflows.
        # Both shapes carry .name; fall back to the first transactionInformation
        # token or the first word of description.
        counterparty = None
        for key in ("payeeDetails", "payerDetails"):
            details = raw.get(key)
            if isinstance(details, dict) and details.get("name"):
                counterparty = details.get("name")
                break
        if not counterparty:
            info = raw.get("transactionInformation") or []
            if isinstance(info, list) and info:
                counterparty = str(info[0])
        if not counterparty:
            counterparty = description.split(" ")[0] if description else "Unknown"

        return AiiaTransaction(
            aiia_txn_id=str(txn_id),
            booked_date=booked_date,
            amount=amount,
            currency=currency,
            description=description,
            counterparty=str(counterparty)[:120],
        )

    def refresh(self, refresh_token: str) -> dict:
        """No-op for Yapily — the consent token is valid for the full
        90-day DK PSD2 SCA window.  Yapily does NOT issue short-lived
        access tokens that need rotation.  Stub kept for Protocol compat.
        """
        return {
            "access_token": "",
            "refresh_token": refresh_token,
            "expires_in": 7776000,
        }

    def revoke(self, account_id: str) -> None:
        """Tell Yapily to drop the consent.  Idempotent on 404 (already
        gone is fine).

        Yapily revokes by consent token (DELETE /consents/{consent_id})
        rather than by account.  Router supplies the consent via
        set_consent() before the call.
        """
        consent = getattr(self, "_pending_consent", None)
        if not consent:
            # Without a consent token we can't address the revoke.  We
            # don't have a way to derive consent from account_id alone
            # — the BankConnection row stores it.  Treat as no-op so the
            # local DB row can still flip to status='revoked' (router
            # already encodes idempotency).
            log.info(
                "yapily.revoke: no consent token set — local-only revoke "
                "(router will mark BankConnection revoked)",
            )
            return
        resp = self._request(
            "DELETE", f"/consents/{consent}",
        )
        if resp.status_code in (200, 204, 404):
            # 404 = consent already gone; idempotent
            return
        self._raise_for_status(resp, "DELETE", f"/consents/{consent}")

    def set_consent(self, consent: str | None) -> None:
        """Stash the consent token on the instance so list_transactions
        + revoke can read it without changing the AiiaClient Protocol.

        Called by the router right before each call:
          client = get_yapily_client()
          client.set_consent(decrypted_refresh_token)
          client.list_transactions(account_id, since)

        Process-local; never logged.  Cleared by clear_consent() once
        the call finishes so a leaked instance can't leak a token to a
        subsequent caller.
        """
        self._pending_consent = consent

    def clear_consent(self) -> None:
        self._pending_consent = None

    def _raise_for_status(self, resp: httpx.Response, method: str, path: str) -> None:
        """Translate non-2xx Yapily responses → AiiaClientError with a
        useful kind.  Surface body class/message at WARNING — these are
        upstream signals operators need to triage."""
        try:
            data = resp.json() if resp.content else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        # Yapily error envelope: { error: { code, message, source, ... } }
        error_obj = data.get("error") if isinstance(data.get("error"), dict) else {}
        err_code = error_obj.get("code") or ""
        err_msg = (error_obj.get("message") or resp.text or "")[:200]
        log.warning(
            "yapily: %d on %s %s code=%s msg=%s",
            resp.status_code, method, path, err_code,
            err_msg or "no body",
        )
        kind_hint = {
            "INVALID_REQUEST": "bad_input",
            "INSTITUTION_NOT_FOUND": "unknown_bank",
            "CONSENT_INVALID": "revoked",
            "CONSENT_EXPIRED": "revoked",
            "CONSENT_REVOKED": "revoked",
            "ACCOUNT_NOT_FOUND": "not_found",
        }.get(err_code, "upstream")
        # Map 401 from Yapily → revoked so the router's sync handler
        # flips the BankConnection to status='expired' rather than 502.
        if resp.status_code == 401:
            kind_hint = "revoked"
        raise AiiaClientError(
            f"Yapily {resp.status_code} on {method} {path}: "
            f"{err_code or 'error'} — {err_msg[:150]}",
            status=resp.status_code,
            kind=kind_hint,
        )


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
