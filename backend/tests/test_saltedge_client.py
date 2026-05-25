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
        base_url="https://example.test/api/v5",
        app_id="test_app_id",
        secret="test_secret",
    )


def _resp(status_code: int, body: dict | None = None) -> httpx.Response:
    request = httpx.Request("POST", "https://example.test/api/v5/")
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
        if method == "POST" and "/customers" in url:
            return _resp(200, {"data": {"id": "cust_456"}})
        if method == "POST" and "/connect_sessions/create" in url:
            body = kwargs.get("json") or {}
            captured["body"] = body
            return _resp(200, {
                "data": {
                    "session_id": "sess_uuid",
                    "expires_at": "2026-05-20T12:00:00Z",
                    "connect_url": "https://www.saltedge.com/connect?token=abc",
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
    assert sess_body["provider_code"] == "danske_bank_dk"
    assert sess_body["country_code"] == "DK"
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
        if "/customers" in url:
            return _resp(200, {"data": {"id": "cust_x"}})
        if "/connect_sessions/create" in url:
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

    assert captured["body"]["data"]["provider_code"] == "fakebank_simple_xf"


# ─── exchange_code ─────────────────────────────────────────────────────


def test_exchange_code_requires_connection_id(client):
    with pytest.raises(SaltEdgeClientError) as exc_info:
        client.exchange_code("ignored")
    assert exc_info.value.kind == "missing_connection"


def test_exchange_code_happy_path(client):
    def stub(self, method, url, **kwargs):
        if "/connections/conn_a" in url:
            return _resp(200, {"data": {"id": "conn_a", "status": "active"}})
        if "/accounts" in url:
            params = kwargs.get("params") or {}
            if params.get("connection_id") == "conn_a":
                return _resp(200, {"data": [
                    {"id": "acct_1", "name": "Erhverv driftskonto"},
                    {"id": "acct_2", "name": "Savings"},
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
