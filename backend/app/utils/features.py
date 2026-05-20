"""
Feature gates for integrations that run against in-process mocks in
dev but need real upstream creds before they're truthful in prod.

Task #106: don't claim "Connect bank automatically" or "Connect
MobilePay Erhverv" in production when both Connect buttons run
against synthetic mocks.  A café owner who clicks Connect and sees
fake transactions loses trust in the whole product.

Each `is_*_enabled()` function returns True when the feature is safe
to expose to a paying customer:

  - In non-production environments, always True.  Contributors and
    test fixtures can exercise the full flow against the in-process
    mocks without needing partner credentials.

  - In production, True ONLY when env vars for a real upstream
    provider are present.  Otherwise False — the frontend hides the
    feature card AND the backend /init endpoint refuses with 503.

These same helpers feed two callers:

  1. GET /api/config/features  → drives frontend conditional render.
  2. POST /api/{bank-connect,mobilepay}/init → defence-in-depth
     reject so a curious user can't bypass the hidden UI by hitting
     the API directly.
"""
from __future__ import annotations

import os


def _is_production() -> bool:
    return os.environ.get("ENVIRONMENT", "development").lower() == "production"


def is_bank_connect_enabled() -> bool:
    """True iff a real PSD2 provider is configured (or we're not in
    production, so the mock counts as 'enabled' for dev/test).

    Recognized providers + the env vars they need:
      BANK_PROVIDER=gocardless → GOCARDLESS_SECRET_ID + GOCARDLESS_SECRET_KEY
      BANK_PROVIDER=saltedge   → SALTEDGE_APP_ID + SALTEDGE_SECRET
      AIIA_ENV=sandbox/live    → AIIA_CLIENT_ID + AIIA_CLIENT_SECRET

    BANK_PROVIDER takes precedence; if it's set but creds are
    missing the feature is OFF in prod (we don't fall back to mock
    silently because then "Connected" badges would mislead).
    """
    if not _is_production():
        return True

    provider = (os.environ.get("BANK_PROVIDER") or "").strip().lower()
    if provider == "gocardless":
        return bool(
            (os.environ.get("GOCARDLESS_SECRET_ID") or "").strip()
            and (os.environ.get("GOCARDLESS_SECRET_KEY") or "").strip()
        )
    if provider == "saltedge":
        return bool(
            (os.environ.get("SALTEDGE_APP_ID") or "").strip()
            and (os.environ.get("SALTEDGE_SECRET") or "").strip()
        )

    aiia_env = (os.environ.get("AIIA_ENV") or "").strip().lower()
    if aiia_env in ("sandbox", "live"):
        return bool(
            (os.environ.get("AIIA_CLIENT_ID") or "").strip()
            and (os.environ.get("AIIA_CLIENT_SECRET") or "").strip()
        )

    return False


def is_mobilepay_enabled() -> bool:
    """True iff a real MobilePay environment is configured.

    Recognized:
      MOBILEPAY_ENV=sandbox/live + MOBILEPAY_CLIENT_ID +
      MOBILEPAY_CLIENT_SECRET + MOBILEPAY_BASE_URL

    Defaults False in prod when MOBILEPAY_ENV is unset or 'mock'.
    """
    if not _is_production():
        return True

    env = (os.environ.get("MOBILEPAY_ENV") or "mock").strip().lower()
    if env not in ("sandbox", "live"):
        return False
    return bool(
        (os.environ.get("MOBILEPAY_CLIENT_ID") or "").strip()
        and (os.environ.get("MOBILEPAY_CLIENT_SECRET") or "").strip()
        and (os.environ.get("MOBILEPAY_BASE_URL") or "").strip()
    )


def feature_flags() -> dict[str, bool]:
    """Bundle the public feature flags for the /api/config/features
    response.  Keep keys snake_case to match the frontend's
    convention."""
    return {
        "bank_connect_enabled": is_bank_connect_enabled(),
        "mobilepay_enabled": is_mobilepay_enabled(),
    }
