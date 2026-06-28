"""token_version — server-side session revocation ("sign out all devices").

Verifies get_current_user enforces the `tv` claim ONLY when present (so legacy
no-`tv` tokens grace-pass and deploy never mass-logs-out), and that a stale tv
is rejected after a bump.

Run:
  cd backend && python3 -m pytest tests/test_token_revocation.py -x -q
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.database import Base
from app.models.user import User
from app.services.auth import create_access_token, get_current_user, hash_password


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


def _owner(db):
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("pw12345678"),
        business_name="Bon",
        currency="DKK",
        plan="starter",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _request(path="/api/x"):
    return Request({"type": "http", "method": "GET", "path": path, "headers": [], "query_string": b""})


def test_matching_tv_passes(db):
    user = _owner(db)  # token_version defaults 0
    tok = create_access_token(str(user.id), user.token_version)  # tv=0
    assert get_current_user(_request(), token=tok, db=db).id == user.id


def test_stale_tv_is_rejected_after_bump(db):
    user = _owner(db)
    tok = create_access_token(str(user.id), 0)  # tv=0
    user.token_version = 1  # "sign out all devices"
    db.commit()
    with pytest.raises(HTTPException) as ei:
        get_current_user(_request(), token=tok, db=db)
    assert ei.value.status_code == 401


def test_no_tv_claim_grace_passes_even_after_bump(db):
    # Existing 30-day tokens carry NO `tv` claim → must never be force-logged
    # out by the feature landing (or by a later bump). Grace by design.
    user = _owner(db)
    user.token_version = 5
    db.commit()
    tok = create_access_token(str(user.id))  # legacy-style: no tv
    assert get_current_user(_request(), token=tok, db=db).id == user.id


def test_fresh_token_after_bump_passes(db):
    user = _owner(db)
    user.token_version = 1
    db.commit()
    tok = create_access_token(str(user.id), user.token_version)  # tv=1
    assert get_current_user(_request(), token=tok, db=db).id == user.id
