"""Payment provider API integrations.

Supported providers:
- Vipps MobilePay (Denmark + Norway) — merged platform since 2023
- eSewa (Nepal)
- Khalti (Nepal)

Each provider function takes credentials dict + date range,
returns a list of normalized transaction dicts.
"""
import hashlib
import base64
from datetime import date, timedelta

import httpx

TIMEOUT = httpx.Timeout(15.0)


# ════════════════════════════════════════════════════════════
# Provider registry
# ════════════════════════════════════════════════════════════

PROVIDERS = {
    "vipps_mobilepay": {
        "name": "Vipps MobilePay",
        "countries": ["DK", "NO"],
        "description": "Import MobilePay (DK) and Vipps (NO) transactions automatically via the Vipps MobilePay API",
        "logo_emoji": "📱",
        "fields": [
            {"key": "client_id", "label": "Client ID", "type": "text", "placeholder": "From Vipps MobilePay portal"},
            {"key": "client_secret", "label": "Client Secret", "type": "password", "placeholder": "Client secret"},
            {"key": "subscription_key", "label": "Ocp-Apim-Subscription-Key", "type": "password", "placeholder": "API subscription key"},
            {"key": "merchant_serial", "label": "Merchant Serial Number", "type": "text", "placeholder": "MSN from portal"},
        ],
    },
    "esewa": {
        "name": "eSewa",
        "countries": ["NP"],
        "description": "Import eSewa merchant transactions — Nepal's most popular digital wallet",
        "logo_emoji": "💚",
        "fields": [
            {"key": "merchant_code", "label": "Merchant Code", "type": "text", "placeholder": "Your eSewa merchant code"},
            {"key": "api_key", "label": "API Key", "type": "password", "placeholder": "eSewa merchant API key"},
        ],
    },
    "khalti": {
        "name": "Khalti",
        "countries": ["NP"],
        "description": "Import Khalti merchant transactions — digital wallet for Nepal",
        "logo_emoji": "💜",
        "fields": [
            {"key": "secret_key", "label": "Secret Key", "type": "password", "placeholder": "Khalti merchant secret key"},
        ],
    },
}


def get_providers():
    """Return list of all supported payment providers with their fields."""
    return [
        {"id": pid, **{k: v for k, v in info.items() if k != "fields"}, "fields": info["fields"]}
        for pid, info in PROVIDERS.items()
    ]


def get_providers_for_country(country: str):
    """Return providers available for a specific country."""
    return [
        {"id": pid, **info}
        for pid, info in PROVIDERS.items()
        if country.upper() in info["countries"]
    ]


def _ref_hash(date_str: str, desc: str, amount: float) -> str:
    """Generate dedup hash matching bank import pattern."""
    raw = f"{date_str}_{desc}_{amount}"
    return hashlib.sha256(raw.encode()).hexdigest()[:10]


# ════════════════════════════════════════════════════════════
# Vipps MobilePay (Denmark + Norway)
# Docs: https://developer.vippsmobilepay.com/docs/APIs/report-api/
#
# Important: Report API is production-only (no test environment).
# Auth: POST /accesstoken/get with client_id, client_secret,
#        Ocp-Apim-Subscription-Key headers.
# Flow: Get token → List ledgers → Fetch funds per date.
# ════════════════════════════════════════════════════════════

VIPPS_BASE = "https://api.vipps.no"


async def _vipps_get_token(creds: dict) -> str:
    """Get access token via POST /accesstoken/get."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{VIPPS_BASE}/accesstoken/get",
            headers={
                "Content-Type": "application/json",
                "client_id": creds["client_id"],
                "client_secret": creds["client_secret"],
                "Ocp-Apim-Subscription-Key": creds["subscription_key"],
                "Merchant-Serial-Number": creds.get("merchant_serial", ""),
                "Vipps-System-Name": "bonbox",
                "Vipps-System-Version": "1.0.0",
                "Vipps-System-Plugin-Name": "bonbox-dashboard",
                "Vipps-System-Plugin-Version": "1.0.0",
            },
            content="",
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _vipps_get_ledger_id(client: httpx.AsyncClient, headers: dict) -> str:
    """GET /settlement/v1/ledgers — discover the merchant's ledger ID."""
    resp = await client.get(
        f"{VIPPS_BASE}/settlement/v1/ledgers",
        headers=headers,
    )
    resp.raise_for_status()
    ledgers = resp.json()

    # Use first available ledger (most merchants have one)
    items = ledgers if isinstance(ledgers, list) else ledgers.get("items", ledgers.get("ledgers", []))
    if not items:
        raise ValueError("No ledgers found for this merchant. Check your API keys and merchant serial number.")

    # Return the ledger ID (field may be 'ledgerId' or 'id')
    first = items[0]
    return first.get("ledgerId", first.get("id", str(first)))


async def fetch_vipps_mobilepay(creds: dict, date_from: date, date_to: date) -> list[dict]:
    """Fetch settlement transactions from Vipps MobilePay Report API.

    1. Authenticate via /accesstoken/get
    2. Discover ledger ID via /settlement/v1/ledgers
    3. For each date in range, GET /report/v2/ledgers/{id}/funds/dates/{date}
    """
    try:
        token = await _vipps_get_token(creds)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 401:
            raise ValueError("Authentication failed. Check your client_id, client_secret, and subscription key.") from e
        raise ValueError(f"Authentication failed: {e.response.status_code}") from e
    except Exception as e:
        raise ValueError(f"Authentication failed: {e}") from e

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Ocp-Apim-Subscription-Key": creds["subscription_key"],
        "Merchant-Serial-Number": creds.get("merchant_serial", ""),
        "Vipps-System-Name": "bonbox",
        "Vipps-System-Version": "1.0.0",
    }

    transactions = []

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Step 1: Discover ledger ID
        try:
            ledger_id = await _vipps_get_ledger_id(client, headers)
        except Exception as e:
            raise ValueError(f"Could not find ledger: {e}") from e

        # Step 2: Fetch funds for each date in range
        # The API uses per-date endpoints: /report/v2/ledgers/{id}/funds/dates/{YYYY-MM-DD}
        current = date_from
        while current <= date_to:
            date_str = current.isoformat()
            try:
                # Paginate within each date using cursor
                cursor = None
                for _ in range(20):  # safety limit per date
                    url = f"{VIPPS_BASE}/report/v2/ledgers/{ledger_id}/funds/dates/{date_str}"
                    params = {}
                    if cursor:
                        params["cursor"] = cursor

                    resp = await client.get(url, headers=headers, params=params)

                    if resp.status_code == 404:
                        # No data for this date — skip
                        break
                    resp.raise_for_status()
                    data = resp.json()

                    items = data if isinstance(data, list) else data.get("items", [])
                    if not items:
                        break

                    for txn in items:
                        # Amount in minor units (øre/cents) → major units (kr)
                        gross = txn.get("grossAmount", txn.get("amount", {}))
                        if isinstance(gross, dict):
                            amount = float(gross.get("value", 0)) / 100
                        else:
                            amount = float(gross) / 100

                        txn_type = txn.get("transactionType", "payment")
                        reference = txn.get("reference", txn.get("orderId", ""))
                        desc = f"MobilePay {txn_type}"
                        if reference:
                            desc += f" (ref: {reference})"

                        transactions.append({
                            "date": date_str,
                            "description": desc,
                            "amount": abs(amount),
                            "type": "income" if amount >= 0 else "expense",
                            "ref_hash": _ref_hash(date_str, reference or desc, amount),
                            "payment_method": "mobilepay",
                            "provider": "vipps_mobilepay",
                        })

                    cursor = data.get("cursor") if isinstance(data, dict) else None
                    if not cursor:
                        break

            except httpx.HTTPStatusError:
                pass  # Skip dates with errors (404 = no data)

            current += timedelta(days=1)

    return transactions


# ════════════════════════════════════════════════════════════
# eSewa (Nepal)
# ════════════════════════════════════════════════════════════

async def fetch_esewa(creds: dict, date_from: date, date_to: date) -> list[dict]:
    """Fetch merchant transactions from eSewa's API.

    eSewa merchant API provides transaction history for verified merchants.
    Docs: https://developer.esewa.com.np/
    """
    headers = {
        "Content-Type": "application/json",
        "merchant-code": creds["merchant_code"],
        "Authorization": f"Bearer {creds['api_key']}",
    }

    transactions = []
    page = 1

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for _ in range(20):  # safety limit
            resp = await client.get(
                "https://esewa.com.np/api/merchant/v2/transactions",
                headers=headers,
                params={
                    "fromDate": date_from.strftime("%Y-%m-%d"),
                    "toDate": date_to.strftime("%Y-%m-%d"),
                    "page": page,
                    "pageSize": 100,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            items = data.get("transactions", data.get("data", []))
            if not items:
                break

            for txn in items:
                amount = float(txn.get("totalAmount", txn.get("amount", 0)))
                txn_date = txn.get("transactionDate", txn.get("date", date_from.isoformat()))
                # Normalize date format
                if "T" in txn_date:
                    txn_date = txn_date[:10]
                desc = txn.get("purpose", txn.get("remarks", "eSewa payment"))
                ref = txn.get("transactionUuid", txn.get("referenceId", ""))

                transactions.append({
                    "date": txn_date,
                    "description": f"eSewa: {desc}" + (f" (ref: {ref})" if ref else ""),
                    "amount": amount,
                    "type": "income" if amount > 0 else "expense",
                    "ref_hash": _ref_hash(txn_date, ref or desc, amount),
                    "payment_method": "esewa",
                    "provider": "esewa",
                })

            # Check pagination
            if len(items) < 100:
                break
            page += 1

    return transactions


# ════════════════════════════════════════════════════════════
# Khalti (Nepal)
# ════════════════════════════════════════════════════════════

async def fetch_khalti(creds: dict, date_from: date, date_to: date) -> list[dict]:
    """Fetch merchant transactions from Khalti's API.

    Khalti merchant API provides transaction lookup for verified merchants.
    Docs: https://docs.khalti.com/
    """
    headers = {
        "Authorization": f"Key {creds['secret_key']}",
        "Content-Type": "application/json",
    }

    transactions = []
    page = 1

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for _ in range(20):  # safety limit
            resp = await client.get(
                "https://khalti.com/api/v2/merchant-transaction/",
                headers=headers,
                params={
                    "date_after": date_from.strftime("%Y-%m-%d"),
                    "date_before": date_to.strftime("%Y-%m-%d"),
                    "page": page,
                    "page_size": 100,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            records = data.get("records", data.get("results", []))
            if not records:
                break

            for txn in records:
                # Khalti amounts are in paisa (1/100 of NPR)
                amount = float(txn.get("amount", 0)) / 100
                txn_date = txn.get("created_on", txn.get("date", date_from.isoformat()))
                if "T" in txn_date:
                    txn_date = txn_date[:10]
                purpose = txn.get("purpose", txn.get("product_name", "Khalti payment"))
                idx = txn.get("idx", txn.get("transaction_id", ""))

                transactions.append({
                    "date": txn_date,
                    "description": f"Khalti: {purpose}" + (f" (ref: {idx})" if idx else ""),
                    "amount": amount,
                    "type": "income" if amount > 0 else "expense",
                    "ref_hash": _ref_hash(txn_date, idx or purpose, amount),
                    "payment_method": "khalti",
                    "provider": "khalti",
                })

            if len(records) < 100:
                break
            page += 1

    return transactions


# ════════════════════════════════════════════════════════════
# Dispatcher
# ════════════════════════════════════════════════════════════

FETCH_FUNCTIONS = {
    "vipps_mobilepay": fetch_vipps_mobilepay,
    "esewa": fetch_esewa,
    "khalti": fetch_khalti,
}


async def fetch_transactions(provider: str, creds: dict, date_from: date, date_to: date) -> list[dict]:
    """Fetch transactions from any supported provider."""
    fn = FETCH_FUNCTIONS.get(provider)
    if not fn:
        raise ValueError(f"Unknown provider: {provider}")
    return await fn(creds, date_from, date_to)
