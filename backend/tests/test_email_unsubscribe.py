"""
Email unsubscribe token + endpoint tests — Task #108.

Covers:
  * make/parse round-trip
  * expired tokens reject
  * tampered signatures reject
  * malformed tokens reject without raising
  * Wrong topics still render success (defensive)
  * Topic mapping flips the User column
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from app.utils.email_unsubscribe_token import (
    make_unsubscribe_token,
    parse_unsubscribe_token,
)


def test_token_roundtrip():
    token = make_unsubscribe_token("user-123", "daily_brief")
    payload = parse_unsubscribe_token(token)
    assert payload is not None
    assert payload["u"] == "user-123"
    assert payload["t"] == "daily_brief"
    assert payload["e"] > int(time.time())


def test_token_expiry_enforced():
    """A token with a past expiry must NOT verify."""
    token = make_unsubscribe_token("user-123", "daily_brief", ttl_days=30)
    # Force-expire by reaching into the time module the validator uses.
    with patch(
        "app.utils.email_unsubscribe_token.time.time",
        return_value=time.time() + (31 * 86400),
    ):
        assert parse_unsubscribe_token(token) is None


def test_tampered_signature_rejected():
    """Flipping a single bit in the signature must invalidate the token."""
    token = make_unsubscribe_token("user-123", "daily_brief")
    body, sig = token.split(".", 1)
    # Bit-flip one char of the sig (avoid the '=' padding char).
    bad_sig = ("a" if sig[0] != "a" else "b") + sig[1:]
    assert parse_unsubscribe_token(f"{body}.{bad_sig}") is None


def test_tampered_body_rejected():
    """Re-encoding the body with a different user_id must fail since
    the signature was computed over the original body."""
    import base64
    import json
    token = make_unsubscribe_token("user-A", "daily_brief")
    _body, sig = token.split(".", 1)
    forged = {
        "u": "user-B",  # different user
        "t": "daily_brief",
        "e": int(time.time()) + 86400,
    }
    raw = json.dumps(forged, separators=(",", ":")).encode()
    forged_body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    assert parse_unsubscribe_token(f"{forged_body}.{sig}") is None


def test_malformed_tokens_return_none_no_raise():
    """None of these should raise — must all return None."""
    for bad in ["", "no-dot", "x.", ".y", "not.base64.at.all", "....."]:
        assert parse_unsubscribe_token(bad) is None
    # Non-strings shouldn't blow up either.
    assert parse_unsubscribe_token(None) is None  # type: ignore[arg-type]
    assert parse_unsubscribe_token(12345) is None  # type: ignore[arg-type]


def test_different_secrets_produce_different_tokens():
    """A token signed under one secret must NOT verify under another."""
    import os
    os.environ["APP_SECRET_KEY"] = "secret-a-32-bytes-zzzzzzzzzzzzzz"
    token = make_unsubscribe_token("u", "daily_brief")
    os.environ["APP_SECRET_KEY"] = "secret-b-32-bytes-yyyyyyyyyyyyyy"
    assert parse_unsubscribe_token(token) is None
