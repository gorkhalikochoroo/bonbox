"""Every session-mint site must embed the user's `token_version` as the `tv`
claim — otherwise the minted JWT can NEVER be revoked by "sign out all devices"
(get_current_user only enforces `tv` when it's present). This guards the five
non-/auth-login mint sites that previously called create_access_token(str(id))
with NO version:

  • team.py            — invite-accept (team member)
  • accountants.py     — revisor invite-accept
  • auth_oauth.py x2   — Apple + Google OAuth sign-in
  • auth_magic_link.py — magic-link verify

Two complementary checks per flow:
  1. Behavioural — mint the token exactly as the site does (passing the user's
     token_version) and assert the decoded JWT carries `tv` == that version.
  2. Source-level regression — assert each call site actually passes a second
     argument, so a future edit that drops it fails here, not silently in prod.

Run:
  cd backend && python3 -m pytest tests/test_mint_token_version.py -x -q
"""
import re
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.user import User
from app.services.auth import _decode_token, create_access_token, hash_password

# Distinct non-zero version so a passing test proves the VALUE is propagated,
# not merely that some `tv` claim exists.
_TV = 7

_BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


def _user(db, role="owner", email="u@bonbox.dk"):
    u = User(
        email=email,
        password_hash=hash_password("pw12345678"),
        business_name="Bon",
        currency="DKK",
        plan="starter",
        role=role,
        token_version=_TV,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _assert_tv(token, expected):
    payload = _decode_token(token)
    assert "tv" in payload, "minted JWT is missing the `tv` claim — not revocable"
    assert int(payload["tv"]) == int(expected)
    assert payload.get("sub")  # sanity: still a normal session token


# ── Behavioural: each flow mints a token with the right `tv` ─────────────

def test_team_invite_accept_mints_tv(db):
    # Mirrors team.py: create_access_token(str(invitee.id), invitee.token_version)
    invitee = _user(db, role="cashier", email="member@bonbox.dk")
    tok = create_access_token(str(invitee.id), invitee.token_version)
    _assert_tv(tok, _TV)


def test_accountant_invite_accept_mints_tv(db):
    # Mirrors accountants.py: create_access_token(str(user.id), user.token_version)
    user = _user(db, role="accountant", email="revisor@bonbox.dk")
    tok = create_access_token(str(user.id), user.token_version)
    _assert_tv(tok, _TV)


def test_oauth_apple_mints_tv(db):
    # Mirrors auth_oauth.py:318 (Apple)
    user = _user(db, email="apple@bonbox.dk")
    tok = create_access_token(str(user.id), user.token_version)
    _assert_tv(tok, _TV)


def test_oauth_google_mints_tv(db):
    # Mirrors auth_oauth.py:450 (Google)
    user = _user(db, email="google@bonbox.dk")
    tok = create_access_token(str(user.id), user.token_version)
    _assert_tv(tok, _TV)


def test_magic_link_mints_tv(db):
    # Mirrors auth_magic_link.py: create_access_token(str(user.id), user.token_version)
    user = _user(db, email="magic@bonbox.dk")
    tok = create_access_token(str(user.id), user.token_version)
    _assert_tv(tok, _TV)


def test_default_token_version_is_zero_and_carried(db):
    # New-user default (column default 0) must still embed tv=0 (revocable),
    # never omit the claim.
    u = User(
        email="default@bonbox.dk",
        password_hash=hash_password("pw12345678"),
        business_name="Bon",
        currency="DKK",
        plan="free",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    assert int(u.token_version) == 0
    _assert_tv(create_access_token(str(u.id), u.token_version), 0)


# ── Source-level regression: the call sites still pass a 2nd argument ─────

_SITES = [
    ("app/routers/team.py", r"create_access_token\(\s*str\(invitee\.id\)\s*,\s*invitee\.token_version\s*\)"),
    ("app/routers/accountants.py", r"create_access_token\(\s*str\(user\.id\)\s*,\s*user\.token_version\s*\)"),
    ("app/routers/auth_magic_link.py", r"create_access_token\(\s*str\(user\.id\)\s*,\s*user\.token_version\s*\)"),
]


@pytest.mark.parametrize("rel, pattern", _SITES)
def test_call_site_passes_token_version(rel, pattern):
    src = (_BACKEND / rel).read_text()
    assert re.search(pattern, src), f"{rel}: mint site no longer passes token_version"


def test_oauth_has_two_versioned_mint_sites():
    # Apple (:318) + Google (:450) both pass token_version.
    src = (_BACKEND / "app/routers/auth_oauth.py").read_text()
    versioned = len(re.findall(
        r"create_access_token\(\s*str\(user\.id\)\s*,\s*user\.token_version\s*\)", src
    ))
    assert versioned == 2, f"expected 2 versioned OAuth mint sites, found {versioned}"
    # No bare mint (str(user.id) only) should remain in this file.
    bare = re.findall(r"create_access_token\(\s*str\(user\.id\)\s*\)", src)
    assert not bare, "an OAuth mint site still omits token_version"
