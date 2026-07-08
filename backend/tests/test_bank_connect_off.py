"""Bank-connect is OFF-by-default in production (product decision 2026-07-08).

BonBox does not offer bank-connect; the wedge is the all-in-one suite. In prod
the feature requires a deliberate ENABLE_BANK_CONNECT opt-in ON TOP of provider
creds, so lingering creds can't turn it back on and no PSD2 tokens are created.
"""
from app.utils.features import is_bank_connect_enabled


def _set_gocardless_creds(monkeypatch):
    monkeypatch.setenv("BANK_PROVIDER", "gocardless")
    monkeypatch.setenv("GOCARDLESS_BAD_BASE_URL", "https://bankaccountdata.gocardless.com")
    monkeypatch.setenv("GOCARDLESS_BAD_SECRET_ID", "secret-id")
    monkeypatch.setenv("GOCARDLESS_BAD_SECRET_KEY", "secret-key")


def test_off_by_default_in_prod_even_with_full_creds(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("ENABLE_BANK_CONNECT", raising=False)
    _set_gocardless_creds(monkeypatch)
    assert is_bank_connect_enabled() is False, "creds alone must NOT enable bank-connect"


def test_on_requires_explicit_enable_plus_creds(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ENABLE_BANK_CONNECT", "true")
    _set_gocardless_creds(monkeypatch)
    assert is_bank_connect_enabled() is True


def test_enable_flag_without_creds_stays_off(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ENABLE_BANK_CONNECT", "true")
    monkeypatch.delenv("BANK_PROVIDER", raising=False)
    assert is_bank_connect_enabled() is False


def test_non_production_unchanged(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("ENABLE_BANK_CONNECT", raising=False)
    assert is_bank_connect_enabled() is True
