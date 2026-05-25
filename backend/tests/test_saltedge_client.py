"""Salt Edge client tests — task #105. Mocked httpx, no network."""
from __future__ import annotations

import json
from unittest.mock import patch

import httpx
import pytest

from app.services.saltedge_client import (
    SaltEdgeClient,
    SaltEdgeClientError,
)


@pytest.fixture
def client():
    return SaltEdgeClient(
        base_url="https://example.test/api/v6",
        app_id="test_app_id",
        secret="test_secret",
    )


def _resp(status_code: int, body: dict | None = None) -> httpx.Response:
    request = httpx.Request("POST", "https://example.test/api/v6/")
    content = json.dumps(body or {}).encode() if body is not None else b""
    return httpx.Response(
        status_code=status_code,
        content=content,
        request=request,
        headers={"content-type": "application/json"} if body is not None else {},
    )


# ─── Customer (idempotent) ─────────────────────────────────────────────


def test_ensure_customer_creates_when_new(client):
    captured: list = []

    def stub(self, method, url, **kwargs):
        captured.append((method, url, kwargs.get("json")))
        return _resp(200, {"data": {"id": "cust_123"}})

    with patch.object(httpx.Client, "request", new=stub):
        cid = client._ensure_customer(identifier="state_abc")

    assert cid == "cust_123"
    method, url, body = captured[0]
    assert method == "POST"
    assert "/customers" in url
    assert body == {"data": {"identifier": "state_abc"}}


def test_ensure_customer_returns_existing_on_conflict(client):
    state = {"calls": 0}

    def stub(self, method, url, **kwargs):
        state["calls"] += 1
        if method == "POST":
            return _resp(409, {
                "error": {
                    "class": "CustomerAlreadyExists",
                    "message": "Customer with identifier already exists",
                },
            })
        if method == "GET" and "/customers" in url:
            return _resp(200, {"data": [{"id": "cust_existing"}]})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        cid = client._ensure_customer(identifier="state_xyz")

    assert cid == "cust_existing"
    assert state["calls"] == 2  # POST then GET


# ─── init_consent ──────────────────────────────────────────────────────


def test_init_consent_returns_connect_url_and_callbacks_ids(client):
    captured: dict = {}

    def stub(self, method, url, **kwargs):
        if method == "POST" and url.endswith("/customers"):
            # v6 returns `customer_id` (was `id` in v5).  Test the v6 shape.
            return _resp(200, {"data": {"customer_id": "cust_456"}})
        # v6: /connections/connect (was /connect_sessions/create in v5).
        if method == "POST" and url.endswith("/connections/connect"):
            body = kwargs.get("json") or {}
            captured["body"] = body
            captured["url"] = url
            return _resp(200, {
                "data": {
                    "expires_at": "2026-05-20T12:00:00Z",
                    "connect_url": "https://www.saltedge.com/connect?token=abc",
                    "customer_id": "cust_456",
                },
            })
        return _resp(500)

    captured_cb: dict = {}

    def cb(*, requisition_id, institution_id):
        captured_cb["req"] = requisition_id
        captured_cb["inst"] = institution_id

    with patch.object(httpx.Client, "request", new=stub):
        url = client.init_consent(
            redirect_uri="https://api.bonbox.dk/api/bank-connect/callback",
            state="csrf_state_xyz",
            bank_slug="danske_bank",
            on_provider_ids=cb,
        )

    assert url == "https://www.saltedge.com/connect?token=abc"
    # State embedded in return_to so the callback CSRF check works.
    sess_body = captured["body"]["data"]
    assert "state=csrf_state_xyz" in sess_body["attempt"]["return_to"]
    # v6: provider moved to nested object {"provider": {"code": "..."}}.
    assert sess_body["provider"] == {"code": "danske_bank_dk"}
    # v6: country_code removed from the request body.
    assert "country_code" not in sess_body
    assert "provider_code" not in sess_body  # legacy v5 flat field — gone
    # Lock the v6 path: regression of the May 2026 404 incident where the
    # client kept calling the retired v5 path /connect_sessions/create.
    assert captured["url"].endswith("/api/v6/connections/connect"), (
        f"expected /api/v6/connections/connect, got {captured['url']}"
    )
    # Callback got the customer_id + provider_code for persistence.
    assert captured_cb["req"] == "cust_456"
    assert captured_cb["inst"] == "danske_bank_dk"


def test_init_consent_unknown_bank_slug_raises_helpfully(client):
    with pytest.raises(SaltEdgeClientError) as exc_info:
        client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_aaa",
            bank_slug="not_a_bank",
        )
    assert exc_info.value.kind == "unknown_bank"
    assert "danske_bank" in str(exc_info.value)


def test_init_consent_sandbox_routes_to_fakebank(client):
    captured: dict = {}

    def stub(self, method, url, **kwargs):
        if url.endswith("/customers"):
            return _resp(200, {"data": {"customer_id": "cust_x"}})
        # v6: /connections/connect (renamed from /connect_sessions/create).
        if url.endswith("/connections/connect"):
            captured["body"] = kwargs.get("json")
            return _resp(200, {"data": {"connect_url": "https://sandbox/c"}})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_aaa",
            bank_slug="danske_bank",
            sandbox=True,
        )

    # v6: provider is a nested object, not a flat provider_code string.
    assert captured["body"]["data"]["provider"] == {"code": "fakebank_simple_xf"}


def test_init_consent_v6_body_locks_full_schema_shape(client):
    """Comprehensive v6 contract-lock test (2026-05-25 schema audit).

    Asserts every field of the request body we send to
    POST /connections/connect exactly matches the Salt Edge v6 spec
    documented at:
      - https://docs.saltedge.com/v6/  (migration guide: scopes renamed,
        provider nested, return_to/locale moved under attempt)
      - https://docs.saltedge.com/v6/api_reference/  (endpoint schema)

    The previous incidents (May 2026) peeled v6 drift errors one at a
    time across 5 deploys.  This fixture pins the COMPLETE shape so the
    next drift in either direction (we regress, or v6 deprecates a field
    we still send) fires a single explicit assertion failure.
    """
    captured: dict = {}

    def stub(self, method, url, **kwargs):
        if url.endswith("/customers"):
            return _resp(200, {"data": {"customer_id": "cust_lock"}})
        if url.endswith("/connections/connect"):
            captured["body"] = kwargs.get("json")
            return _resp(200, {"data": {
                "connect_url": "https://www.saltedge.com/connect?token=lock",
                "expires_at": "2026-08-23T00:00:00Z",
                "customer_id": "cust_lock",
            }})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        client.init_consent(
            redirect_uri="https://api.bonbox.dk/api/bank-connect/callback",
            state="lockstate1234",
            bank_slug="danske_bank",
        )

    body = captured["body"]
    data = body["data"]

    # Top-level keys must be exactly these — nothing else, no v5 cruft.
    assert set(data.keys()) == {"customer_id", "consent", "attempt", "provider"}, (
        f"v6 schema drift: unexpected top-level keys {sorted(data.keys())}"
    )

    # customer_id resolved from POST /customers and threaded in.
    assert data["customer_id"] == "cust_lock"

    # consent: scopes renamed in v6, from_date required, period_days kept.
    consent = data["consent"]
    assert set(consent.keys()) == {"scopes", "from_date", "period_days"}
    assert consent["scopes"] == ["accounts", "transactions"], (
        "v6 scopes must be the renamed enum values (was 'account_details' "
        "and 'transactions_details' in v5)"
    )
    # from_date is today - 90d, ISO format (YYYY-MM-DD, 10 chars).
    assert len(consent["from_date"]) == 10
    assert consent["from_date"].count("-") == 2
    assert consent["period_days"] == 90

    # attempt: v6 nests return_to / locale / fetch_scopes inside attempt.
    attempt = data["attempt"]
    assert set(attempt.keys()) == {"return_to", "fetch_scopes", "locale"}
    assert "state=lockstate1234" in attempt["return_to"]
    # v6 separates `balance` from `accounts` in fetch_scopes; v5 implied
    # balance from accounts.  Without explicit "balance" here, the
    # Connection populates with empty balance fields on GET /accounts.
    assert attempt["fetch_scopes"] == ["accounts", "balance", "transactions"]
    # ISO 639-1 lowercase canonical; "da" → Salt Edge widget renders Danish.
    assert attempt["locale"] == "da"

    # provider: v6 nested object, NOT the v5 flat string at data.provider_code.
    assert data["provider"] == {"code": "danske_bank_dk"}, (
        "v6 requires data.provider = {'code': '...'}.  v5 used a flat "
        "data.provider_code string — that shape returns WrongRequestFormat "
        "on a v6 host."
    )

    # Explicitly assert v5 cruft we previously sent is GONE.  These keys
    # appearing in the body have been seen to surface as WrongRequestFormat
    # on strict v6 validators.
    assert "provider_code" not in data, "v5 flat provider_code must be removed"
    assert "country_code" not in data, "v5 country_code must be removed (v6 derives from provider)"


# ─── exchange_code ─────────────────────────────────────────────────────


def test_exchange_code_requires_connection_id(client):
    with pytest.raises(SaltEdgeClientError) as exc_info:
        client.exchange_code("ignored")
    assert exc_info.value.kind == "missing_connection"


def test_exchange_code_happy_path(client):
    def stub(self, method, url, **kwargs):
        if "/connections/conn_a" in url:
            # v6 GET /connections returns connection_id (was `id` in v5).
            return _resp(200, {"data": {
                "connection_id": "conn_a", "status": "active",
            }})
        if "/accounts" in url:
            params = kwargs.get("params") or {}
            if params.get("connection_id") == "conn_a":
                # v6 GET /accounts rows carry account_id (was `id` in v5).
                return _resp(200, {"data": [
                    {"account_id": "acct_1", "name": "Erhverv driftskonto"},
                    {"account_id": "acct_2", "name": "Savings"},
                ]})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        result = client.exchange_code("ignored", connection_id="conn_a")

    assert result["account_id"] == "acct_1"
    assert result["account_label"] == "Erhverv driftskonto"
    assert result["refresh_token"] == "conn_a"
    assert result["expires_in"] == 7776000


def test_exchange_code_inactive_connection_raises(client):
    def stub(self, method, url, **kwargs):
        if "/connections/conn_z" in url:
            return _resp(200, {"data": {"status": "inactive"}})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        with pytest.raises(SaltEdgeClientError) as exc_info:
            client.exchange_code("", connection_id="conn_z")
    assert exc_info.value.kind == "auth_incomplete"


# ─── list_transactions ─────────────────────────────────────────────────


def test_list_transactions_paginates_and_maps(client):
    def stub(self, method, url, **kwargs):
        if "/transactions" in url:
            params = kwargs.get("params") or {}
            if not params.get("from_id"):
                return _resp(200, {
                    "data": [
                        {
                            "id": "tx_1",
                            "made_on": "2026-05-15",
                            "amount": 1250.0,
                            "currency_code": "DKK",
                            "description": "Faktura 2026-0042 Lyngby",
                            "extra": {"payee": "Lyngby Storkunde ApS"},
                        },
                    ],
                    "meta": {"next_id": "tx_2"},
                })
            return _resp(200, {
                "data": [
                    {
                        "id": "tx_2",
                        "made_on": "2026-05-14",
                        "amount": -18000.0,
                        "currency_code": "DKK",
                        "description": "Husleje maj",
                    },
                ],
                "meta": {"next_id": None},
            })
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        txns = client.list_transactions("acct_1", since=None)

    assert len(txns) == 2
    assert txns[0].amount == 1250.0
    assert txns[0].counterparty == "Lyngby Storkunde ApS"
    assert txns[1].amount == -18000.0


def test_list_transactions_skips_malformed_rows(client):
    def stub(self, method, url, **kwargs):
        if "/transactions" in url:
            return _resp(200, {
                "data": [
                    {"id": "good", "made_on": "2026-05-15",
                     "amount": 100, "currency_code": "DKK"},
                    {"id": "bad", "amount": "not_a_number"},
                ],
                "meta": {"next_id": None},
            })
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        txns = client.list_transactions("acct_1", since=None)

    assert len(txns) == 1
    assert txns[0].aiia_txn_id == "good"


# ─── revoke ────────────────────────────────────────────────────────────


def test_revoke_connection_idempotent_on_404(client):
    def stub(self, method, url, **kwargs):
        if method == "DELETE" and "/connections/conn_gone" in url:
            return _resp(404, {
                "error": {"class": "ConnectionNotFound", "message": "gone"},
            })
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        client.revoke_connection("conn_gone")  # should not raise


# ─── Error redaction ───────────────────────────────────────────────────


def test_auth_failure_does_not_leak_secret(client):
    """Bad creds → AiiaClientError, no secret/app_id in the message."""
    def stub(self, method, url, **kwargs):
        return _resp(401, {
            "error": {"class": "InvalidCredentials", "message": "wrong"},
        })

    with patch.object(httpx.Client, "request", new=stub):
        with pytest.raises(SaltEdgeClientError) as exc_info:
            client._request("GET", "/anything")

    msg = str(exc_info.value)
    assert "test_app_id" not in msg
    assert "test_secret" not in msg
    assert exc_info.value.kind == "auth"


# ─── v6 path regression (May 2026 404 incident) ─────────────────────────


def test_init_consent_uses_v6_connections_connect_not_v5_path(client):
    """Lock the v6 endpoint path.  Salt Edge renamed
    `POST /connect_sessions/create` → `POST /connections/connect` in v6
    (see https://docs.saltedge.com/v6/#migration-guide).  The v5 path
    returns 404 on the v6 base URL, which is what the May 2026
    Connect-bank incident hit: POST /customers worked (path unchanged),
    POST /connect_sessions/create 404'd (path renamed).

    Regression: if anyone ever renames it back, this test fires.
    """
    seen_paths: list[str] = []

    def stub(self, method, url, **kwargs):
        seen_paths.append(f"{method} {url}")
        if url.endswith("/customers"):
            return _resp(200, {"data": {"customer_id": "cust_v6"}})
        if url.endswith("/connections/connect"):
            return _resp(200, {"data": {
                "connect_url": "https://www.saltedge.com/connect?token=v6ok",
            }})
        # v5 retired path — if the client ever calls it again the
        # mock returns 404 like real Salt Edge does on a v6 host.
        if url.endswith("/connect_sessions/create"):
            return _resp(404, {"error": {
                "class": "RouteNotFound",
                "message": "Not Found",
            }})
        return _resp(500)

    with patch.object(httpx.Client, "request", new=stub):
        url = client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_v6",
            sandbox=True,
        )

    assert url == "https://www.saltedge.com/connect?token=v6ok"
    # No v5 path should ever be called.
    assert not any("/connect_sessions/create" in p for p in seen_paths), (
        f"client still calls retired v5 path: {seen_paths}"
    )
    assert any("/connections/connect" in p for p in seen_paths)


# ─── Schema-drift hardening (May 2026 incident) ─────────────────────────


def test_raise_for_response_handles_string_error_field(client):
    """Salt Edge in 'Pending' mode has been observed returning bodies
    shaped `{"error": "some string"}` instead of `{"error": {"class":
    ..., "message": ...}}`.  Without the isinstance guard in
    `_raise_for_response`, `error_obj.get("class")` raises
    AttributeError → opaque 500 to the caller.  Lock in the fix."""
    def stub(self, method, url, **kwargs):
        # Drifted shape: top-level dict but `error` is a bare string.
        return _resp(503, {"error": "Service Unavailable — Pending mode"})

    with patch.object(httpx.Client, "request", new=stub):
        with pytest.raises(SaltEdgeClientError) as exc_info:
            client._request("GET", "/anything")

    # Must surface as a clean SaltEdgeClientError, not an AttributeError.
    assert exc_info.value.kind == "upstream"
    # The string payload should be visible to the operator.
    assert "Pending mode" in str(exc_info.value)


def test_raise_for_response_handles_non_dict_body(client):
    """Salt Edge has also been observed returning a bare JSON string as
    the entire body (not even an object).  `data` becomes a `str` —
    same AttributeError risk.  Must downgrade to a clean
    SaltEdgeClientError."""
    request = httpx.Request("POST", "https://example.test/api/v5/")
    # Bare JSON string, not a JSON object.
    response = httpx.Response(
        status_code=502,
        content=b'"Bad Gateway"',
        request=request,
        headers={"content-type": "application/json"},
    )

    def stub(self, method, url, **kwargs):
        return response

    with patch.object(httpx.Client, "request", new=stub):
        with pytest.raises(SaltEdgeClientError) as exc_info:
            client._request("GET", "/anything")

    # No AttributeError — clean upstream error instead.
    assert exc_info.value.status == 502
