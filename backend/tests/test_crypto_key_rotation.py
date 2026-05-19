"""Audit P3 (Task #82) — crypto key-rotation safety net.

`assert_can_decrypt_existing_tokens` probes the newest few rows that
carry an encrypted secret.  If decrypt fails AND
APP_SECRET_KEY_PREVIOUS is unset, the function raises
CryptoConfigError so the application refuses to start with an
operator-fixable misconfiguration.  These tests pin that behaviour.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.bank_connection import BankConnection
from app.models.user import User
from app.utils.crypto import (
    CryptoConfigError,
    _get_fernet,
    assert_can_decrypt_existing_tokens,
    encrypt,
)


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def fresh_keys(monkeypatch):
    """Reset the lru_cache so each test gets its own key context."""
    _get_fernet.cache_clear()
    yield monkeypatch
    _get_fernet.cache_clear()


def _make_user(db) -> User:
    u = User(
        email=f"u-{uuid.uuid4()}@x.test",
        password_hash="x",
        business_name="biz",
        business_type="cafe",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _make_bank_row(db, user, token_bytes: bytes) -> BankConnection:
    row = BankConnection(
        id=uuid.uuid4(),
        user_id=user.id,
        provider="aiia",
        status="active",
        refresh_token_enc=token_bytes,
        sandbox_mode=True,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ── Tests ────────────────────────────────────────────────────────────


def test_passes_when_no_rows_exist(db, fresh_keys):
    """Brand-new install: no encrypted rows → nothing to verify."""
    # Should NOT raise
    assert_can_decrypt_existing_tokens(db)


def test_passes_when_tokens_decrypt_cleanly(db, fresh_keys):
    """Token encrypted under the current key decrypts fine."""
    user = _make_user(db)
    token = encrypt("aiia-refresh-token-abc")
    _make_bank_row(db, user, token)

    # Should NOT raise — same key, decrypt succeeds
    assert_can_decrypt_existing_tokens(db)


def test_refuses_when_rotation_without_previous_set(db, fresh_keys, monkeypatch):
    """The headline scenario: operator rotates APP_SECRET_KEY but
    forgets APP_SECRET_KEY_PREVIOUS.  The function must raise."""
    # 1. Encrypt under the current process key.
    user = _make_user(db)
    token = encrypt("aiia-refresh-token-xyz")
    _make_bank_row(db, user, token)

    # 2. "Rotate" — wipe the cache + set a brand-new APP_SECRET_KEY
    #    without APP_SECRET_KEY_PREVIOUS.
    new_key = Fernet.generate_key().decode()
    monkeypatch.setenv("APP_SECRET_KEY", new_key)
    monkeypatch.delenv("APP_SECRET_KEY_PREVIOUS", raising=False)
    _get_fernet.cache_clear()

    # 3. Probe — must refuse to start
    with pytest.raises(CryptoConfigError) as excinfo:
        assert_can_decrypt_existing_tokens(db)
    assert "rotated" in str(excinfo.value).lower()
    assert "previous" in str(excinfo.value).lower()


def test_passes_when_previous_is_set(db, fresh_keys, monkeypatch):
    """Operator did the rotation right: APP_SECRET_KEY_PREVIOUS holds
    the prior key, so MultiFernet can still decrypt old rows."""
    # 1. Capture current key as "previous" and encrypt under it.
    old_key = Fernet.generate_key().decode()
    monkeypatch.setenv("APP_SECRET_KEY", old_key)
    _get_fernet.cache_clear()
    user = _make_user(db)
    token = encrypt("aiia-refresh-token-rotated")
    _make_bank_row(db, user, token)

    # 2. Rotate, but also set APP_SECRET_KEY_PREVIOUS.
    new_key = Fernet.generate_key().decode()
    monkeypatch.setenv("APP_SECRET_KEY", new_key)
    monkeypatch.setenv("APP_SECRET_KEY_PREVIOUS", old_key)
    _get_fernet.cache_clear()

    # 3. Probe — MultiFernet sees the previous key, decrypts cleanly.
    assert_can_decrypt_existing_tokens(db)
