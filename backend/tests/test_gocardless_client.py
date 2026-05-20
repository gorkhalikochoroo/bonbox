"""
GoCardless client smoke tests — task #104.

Covers the happy path + the known failure modes (auth failure,
unauthorized requisition, rejected SCA, malformed bank slug). We
mock the httpx layer rather than hitting GoCardless so the suite
stays hermetic + fast.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import patch

import httpx
import pytest

from app.services.gocardless_client import (
    GoCardlessClient,
    GoCardlessClientError,
)


# ─── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def client():
    return GoCardlessClient(
        base_url="https://example.test/api/v2",
        secret_id="test_secret_id",
        secret_key="test_secret_key",
    )


def _mock_response(status_code: int, body: dict | None = None) -> httpx.Response:
    request = httpx.Request("POST", "https://example.test/api/v2/")
    content = json.dumps(body or {}).encode() if body is not None else b""
    return httpx.Response(
        status_code=status_code,
        content=content,
        request=request,
        headers={"content-type": "application/json"} if body is not None else {},
    )


# ─── Auth / token cache ───────────────────────────────────────────────


def test_token_minted_once_per_window(client):
    """First call mints; second within TTL reuses the cached token."""
    calls = []

    def stub_request(self, method, url, **kwargs):
        calls.append((method, url))
        if "/token/new/" in url:
            return _mock_response(200, {
                "access": "TOK_A", "access_expires": 86400,
                "refresh": "REFRESH_A", "refresh_expires": 2592000,
            })
        return _mock_response(200, {"requisitions": []})

    with patch.object(httpx.Client, "request", new=stub_request):
        # First call: triggers /token/new
        token1 = client._ensure_access_token()
        # Second call: served from cache
        token2 = client._ensure_access_token()

    assert token1 == "TOK_A"
    assert token2 == "TOK_A"
    # Exactly ONE token mint.
    assert sum(1 for m, u in calls if "/token/new/" in u) == 1


def test_token_refreshes_on_401(client):
    """If GoCardless 401s during a request, the client invalidates
    the cached token, re-mints, and retries."""
    state = {"token_mints": 0, "requisition_attempts": 0}

    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            state["token_mints"] += 1
            return _mock_response(200, {
                "access": f"TOK_{state['token_mints']}",
                "access_expires": 86400,
                "refresh": "REFRESH_X", "refresh_expires": 2592000,
            })
        if "/requisitions/" in url:
            state["requisition_attempts"] += 1
            if state["requisition_attempts"] == 1:
                return _mock_response(401, {"summary": "stale token"})
            return _mock_response(200, {"id": "req_1", "link": "https://bank/sca"})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        url = client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_aaa",
            bank_slug="danske_bank",
        )

    assert url == "https://bank/sca"
    assert state["token_mints"] == 2  # initial + post-401 refresh
    assert state["requisition_attempts"] == 2


def test_token_auth_failure_raises_cleanly(client):
    """Bad credentials → GoCardlessClientError with kind='auth', no
    secret leakage in the message."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(401, {"summary": "invalid credentials"})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        with pytest.raises(GoCardlessClientError) as exc_info:
            client._ensure_access_token()

    assert exc_info.value.kind == "auth"
    # No secret_id / secret_key in the surfaced message.
    msg = str(exc_info.value)
    assert "test_secret_id" not in msg
    assert "test_secret_key" not in msg


# ─── init_consent ──────────────────────────────────────────────────────


def test_init_consent_happy_path_returns_bank_link_and_callbacks_ids(client):
    """init_consent returns the bank SCA URL AND surfaces the
    requisition_id + institution_id via on_provider_ids."""
    captured: dict = {}

    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {
                "access": "TOK", "access_expires": 86400,
            })
        if method == "POST" and "/requisitions/" in url:
            return _mock_response(200, {
                "id": "req_uuid_123",
                "link": "https://bank.dk/sca/abc",
            })
        return _mock_response(500)

    def on_provider_ids(*, requisition_id: str, institution_id: str) -> None:
        captured["req"] = requisition_id
        captured["inst"] = institution_id

    with patch.object(httpx.Client, "request", new=stub_request):
        url = client.init_consent(
            redirect_uri="https://api.bonbox.dk/api/bank-connect/callback",
            state="csrf_state_xyz",
            bank_slug="danske_bank",
            on_provider_ids=on_provider_ids,
        )

    assert url == "https://bank.dk/sca/abc"
    assert captured["req"] == "req_uuid_123"
    assert captured["inst"] == "DANSKEBANK_DABADKKK"


def test_init_consent_unknown_bank_slug_raises_helpfully(client):
    with pytest.raises(GoCardlessClientError) as exc_info:
        client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_aaa",
            bank_slug="not_a_real_bank",
        )
    assert exc_info.value.kind == "unknown_bank"
    # Helpful list of valid slugs in the error.
    assert "danske_bank" in str(exc_info.value)


def test_init_consent_sandbox_routes_to_sandbox_institution(client):
    """When the router asks for sandbox mode, we always go to the
    SANDBOXFINANCE_SFIN0000 test bank regardless of bank_slug."""
    captured: dict = {}

    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if method == "POST" and "/requisitions/" in url:
            body = kwargs.get("json") or {}
            captured["institution_id"] = body.get("institution_id")
            return _mock_response(200, {"id": "req_1", "link": "https://sb/sca"})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        client.init_consent(
            redirect_uri="https://example.test/cb",
            state="state_aaa",
            bank_slug="danske_bank",  # ignored when sandbox=True
            sandbox=True,
        )

    assert captured["institution_id"] == "SANDBOXFINANCE_SFIN0000"


# ─── exchange_code ─────────────────────────────────────────────────────


def test_exchange_code_requires_requisition_id(client):
    """Aiia has `code`; GoCardless has only `requisition_id`. Missing
    it is a router bug, surfaced loud."""
    with pytest.raises(GoCardlessClientError) as exc_info:
        client.exchange_code("ignored")  # no requisition_id kwarg
    assert exc_info.value.kind == "missing_requisition"


def test_exchange_code_happy_path(client):
    """Linked requisition → first account, label fetched from /details."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if "/requisitions/req_123/" in url:
            return _mock_response(200, {
                "id": "req_123",
                "status": "LN",
                "accounts": ["acct_uuid_a", "acct_uuid_b"],
            })
        if "/accounts/acct_uuid_a/details/" in url:
            return _mock_response(200, {
                "account": {"name": "Erhverv driftskonto", "ownerName": "Manoj"},
            })
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        result = client.exchange_code("ignored", requisition_id="req_123")

    assert result["account_id"] == "acct_uuid_a"  # first account picked
    assert result["account_label"] == "Erhverv driftskonto"
    assert result["refresh_token"] == "req_123"  # requisition_id stored here
    assert result["expires_in"] == 7776000


def test_exchange_code_rejected_status_raises(client):
    """User cancelled the SCA at their bank → status RJ → 400."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if "/requisitions/req_rej/" in url:
            return _mock_response(200, {"status": "RJ", "accounts": []})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        with pytest.raises(GoCardlessClientError) as exc_info:
            client.exchange_code("", requisition_id="req_rej")

    assert exc_info.value.kind == "auth_rejected"
    assert exc_info.value.status == 400


def test_exchange_code_label_fallback_when_details_404(client):
    """When the bank doesn't return a label, we still succeed with
    a placeholder instead of failing the whole connect."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if "/requisitions/req_x/" in url:
            return _mock_response(200, {
                "status": "LN", "accounts": ["acct_x"],
            })
        if "/accounts/acct_x/details/" in url:
            return _mock_response(404, {"summary": "no details"})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        result = client.exchange_code("", requisition_id="req_x")

    assert result["account_id"] == "acct_x"
    assert result["account_label"] == "Erhverv driftskonto"  # placeholder


# ─── list_transactions ────────────────────────────────────────────────


def test_list_transactions_maps_to_aiia_transaction_dataclass(client):
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if "/accounts/acct_x/transactions/" in url:
            return _mock_response(200, {
                "transactions": {
                    "booked": [
                        {
                            "transactionId": "txn_1",
                            "bookingDate": "2026-05-15",
                            "transactionAmount": {"amount": "1250.00", "currency": "DKK"},
                            "creditorName": "Lyngby Storkunde ApS",
                            "remittanceInformationUnstructured": "Faktura 2026-0042",
                        },
                        {
                            "transactionId": "txn_2",
                            "bookingDate": "2026-05-14",
                            "transactionAmount": {"amount": "-18000.00", "currency": "DKK"},
                            "debtorName": "Storgade Ejendomme A/S",
                            "remittanceInformationUnstructured": "Husleje maj",
                        },
                    ],
                    "pending": [],
                },
            })
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        txns = client.list_transactions("acct_x", since=None)

    assert len(txns) == 2
    assert txns[0].amount == 1250.00
    assert txns[0].counterparty == "Lyngby Storkunde ApS"
    assert txns[1].amount == -18000.00
    assert txns[1].counterparty == "Storgade Ejendomme A/S"


def test_list_transactions_skips_malformed_rows_instead_of_failing(client):
    """One bad row shouldn't poison the whole sync."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if "/accounts/acct_x/transactions/" in url:
            return _mock_response(200, {
                "transactions": {
                    "booked": [
                        {
                            "transactionId": "good",
                            "bookingDate": "2026-05-15",
                            "transactionAmount": {"amount": "100.00", "currency": "DKK"},
                        },
                        # Malformed — transactionAmount.amount triggers ValueError
                        {"transactionId": "bad", "transactionAmount": {"amount": "abc"}},
                    ],
                    "pending": [],
                },
            })
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        txns = client.list_transactions("acct_x", since=None)

    # Good row kept, bad row dropped.
    assert len(txns) == 1
    assert txns[0].aiia_txn_id == "good"


# ─── revoke ───────────────────────────────────────────────────────────


def test_revoke_requisition_handles_already_deleted(client):
    """Idempotent: DELETE on already-gone requisition returns silently."""
    def stub_request(self, method, url, **kwargs):
        if "/token/new/" in url:
            return _mock_response(200, {"access": "TOK", "access_expires": 86400})
        if method == "DELETE" and "/requisitions/req_gone/" in url:
            return _mock_response(404, {"summary": "not found"})
        return _mock_response(500)

    with patch.object(httpx.Client, "request", new=stub_request):
        # Should not raise.
        client.revoke_requisition("req_gone")
