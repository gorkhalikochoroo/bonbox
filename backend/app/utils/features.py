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
from datetime import datetime, timezone


def _is_production() -> bool:
    return os.environ.get("ENVIRONMENT", "development").lower() == "production"


# ─── Activation-gated disclosure (CONSERVATIVE v1) ──────────────────────
#
# The "break-existing-owners firewall". Activation disclosure (a dormant,
# relevant, never-used pillar drops out of the dense nav and becomes a one-tap
# "Sæt op" tile) is gated to NEW accounts ONLY: an account is in-scope
# (gateable) iff it completed onboarding at-or-after this fixed cutoff. Every
# account that onboarded before the cutoff — i.e. all ~70 current owners — is
# EXEMPT, so they see the EXACT nav they see today. A NULL onboarding timestamp
# is also EXEMPT (established / never-stamped accounts must never lose a
# surface). This constant is the single firewall line; do NOT move it forward
# without re-confirming the existing-owners-unbroken invariant.
ACTIVATION_DISCLOSURE_LAUNCH_AT = datetime(2026, 6, 19, 0, 0, 0, tzinfo=timezone.utc)


def is_activation_disclosure_enabled() -> bool:
    """Single kill-switch for activation-gated disclosure.

    Default TRUE — it is safe by construction: new-accounts-only (cohort
    firewall), fail-open everywhere (any query error → pillar treated as
    activated → visible), and fully reversible (flip OFF → today's nav
    exactly). The activation endpoint returns ``enabled=false`` when this is
    off, and the frontend then treats every pillar as activated.

    Override via the ``ACTIVATION_DISCLOSURE_ENABLED`` env var (any of
    0/false/no/off → disabled). Absent / unrecognized → default TRUE.
    """
    raw = (os.environ.get("ACTIVATION_DISCLOSURE_ENABLED") or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return True


def is_bank_connect_enabled() -> bool:
    """True iff a real PSD2 provider is configured (or we're not in
    production, so the mock counts as 'enabled' for dev/test).

    Recognized providers + the env vars they need:
      BANK_PROVIDER=gocardless → GOCARDLESS_BASE_URL + GOCARDLESS_SECRET_ID
                                 + GOCARDLESS_SECRET_KEY (all three)
      BANK_PROVIDER=saltedge   → SALTEDGE_BASE_URL + SALTEDGE_APP_ID
                                 + SALTEDGE_SECRET (all three)
      BANK_PROVIDER=yapily     → YAPILY_BASE_URL + YAPILY_APPLICATION_ID
                                 + YAPILY_APPLICATION_SECRET (all three)
      AIIA_ENV=sandbox/live    → AIIA_CLIENT_ID + AIIA_CLIENT_SECRET

    BANK_PROVIDER takes precedence; if it's set but ANY required cred is
    missing the feature is OFF in prod (we don't fall back to mock silently
    because then "Connected" badges would mislead — RED audit finding #127:
    partial creds caused the Connect Bank button to stay visible while the
    factory silently returned MockAiiaClient).
    """
    if not _is_production():
        return True

    provider = (os.environ.get("BANK_PROVIDER") or "").strip().lower()
    if provider == "gocardless":
        # Task #104: accept either env-var family.  GOCARDLESS_BAD_*
        # is the vendor's official 'Bank Account Data' prefix (what
        # Manoj configures in Render).  GOCARDLESS_* is the legacy
        # alias.  Either set of all three suffices.
        base = (
            (os.environ.get("GOCARDLESS_BAD_BASE_URL") or "").strip()
            or (os.environ.get("GOCARDLESS_BASE_URL") or "").strip()
        )
        sec_id = (
            (os.environ.get("GOCARDLESS_BAD_SECRET_ID") or "").strip()
            or (os.environ.get("GOCARDLESS_SECRET_ID") or "").strip()
        )
        sec_key = (
            (os.environ.get("GOCARDLESS_BAD_SECRET_KEY") or "").strip()
            or (os.environ.get("GOCARDLESS_SECRET_KEY") or "").strip()
        )
        return bool(base and sec_id and sec_key)
    if provider == "saltedge":
        return bool(
            (os.environ.get("SALTEDGE_BASE_URL") or "").strip()
            and (os.environ.get("SALTEDGE_APP_ID") or "").strip()
            and (os.environ.get("SALTEDGE_SECRET") or "").strip()
        )
    if provider == "yapily":
        return bool(
            (os.environ.get("YAPILY_BASE_URL") or "").strip()
            and (os.environ.get("YAPILY_APPLICATION_ID") or "").strip()
            and (os.environ.get("YAPILY_APPLICATION_SECRET") or "").strip()
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


def is_inbox_enabled() -> bool:
    """True iff the receipt-forwarding email inbox is wired in.

    Three signals must all be present (matches the
    `mobilepay`/`bank-connect` honesty pattern):
      • `INBOX_ENABLED=true` env var (or settings flag)
      • `POSTMARK_INBOUND_USER` populated
      • `POSTMARK_INBOUND_PASS` populated

    In non-production we still require the flag itself (False by
    default) so dev environments don't accidentally answer 200 to
    spoofed Postmark hits during a local Stripe/MobilePay test.
    Returning False makes:
      • GET /api/inbox/me  → infra_enabled=false (UI shows "Coming soon")
      • POST /api/inbox/postmark-webhook → 503 with honest reason
    """
    # Defer to env over the pydantic-settings cache so tests can flip
    # the var with monkeypatch.setenv without re-importing settings.
    raw = (os.environ.get("INBOX_ENABLED") or "").strip().lower()
    if raw in ("", "0", "false", "no", "off"):
        # No override → fall through to settings (so .env still works).
        try:
            from app.config import settings  # local import avoids cycle
            if not getattr(settings, "INBOX_ENABLED", False):
                return False
        except Exception:  # noqa: BLE001
            return False
    elif raw not in ("1", "true", "yes", "on"):
        return False

    user = (os.environ.get("POSTMARK_INBOUND_USER") or "").strip()
    pwd = (os.environ.get("POSTMARK_INBOUND_PASS") or "").strip()
    if not user or not pwd:
        try:
            from app.config import settings
            user = user or (getattr(settings, "POSTMARK_INBOUND_USER", "") or "").strip()
            pwd = pwd or (getattr(settings, "POSTMARK_INBOUND_PASS", "") or "").strip()
        except Exception:  # noqa: BLE001
            pass
    return bool(user and pwd)


def feature_flags() -> dict[str, bool]:
    """Bundle the public feature flags for the /api/config/features
    response.  Keep keys snake_case to match the frontend's
    convention."""
    return {
        "bank_connect_enabled": is_bank_connect_enabled(),
        "mobilepay_enabled": is_mobilepay_enabled(),
        "inbox_enabled": is_inbox_enabled(),
        # Activation-gated disclosure kill-switch. Default TRUE (safe:
        # new-accounts-only + fail-open + reversible). When OFF the activation
        # endpoint reports enabled=false and the frontend treats every pillar
        # as activated → today's nav exactly.
        "activation_disclosure_enabled": is_activation_disclosure_enabled(),
    }
