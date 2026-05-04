"""
Waitlist endpoint — capture interest in paid tiers before payment is wired.

Lightweight, deduped per (email, tier). Logged-in users are auto-linked.
Anonymous users can join too (just email + tier).
"""

import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.waitlist import WaitlistEntry
from app.services.auth import get_current_user

router = APIRouter()


_VALID_TIERS = {"starter", "pro", "business"}


class JoinBody(BaseModel):
    email: EmailStr
    tier: str
    source: str | None = None
    notes: str | None = None

    @field_validator("tier")
    @classmethod
    def _v(cls, v: str) -> str:
        if v not in _VALID_TIERS:
            raise ValueError("Invalid tier")
        return v

    @field_validator("notes")
    @classmethod
    def _notes(cls, v: str | None) -> str | None:
        if v is None:
            return v
        # Bound length + strip control chars
        clean = re.sub(r"[\x00-\x1f]", "", v).strip()
        return clean[:500] if clean else None


def _try_get_user(request: Request, db: Session) -> User | None:
    """Best-effort current user — None if no token / invalid token."""
    try:
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return None
        # Reuse get_current_user via a manual call — but we need a dependency-style
        # call here. Simpler: extract token and look up.
        from jose import jwt, JWTError
        from app.config import settings
        token = auth.split(" ", 1)[1]
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        except JWTError:
            return None
        uid = payload.get("sub")
        if not uid:
            return None
        return db.query(User).filter(User.id == uid).first()
    except Exception:  # noqa: BLE001
        return None


# Naive in-memory rate limit per IP — slowapi handles app-wide; this is a
# small extra safety net specific to waitlist signup to deter scripted spam.
_recent: dict[str, list[float]] = {}
_LIMIT_PER_MIN = 5


def _ip_rate_check(request: Request) -> bool:
    import time
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    arr = _recent.setdefault(ip, [])
    arr[:] = [t for t in arr if t > now - 60]
    if len(arr) >= _LIMIT_PER_MIN:
        return False
    arr.append(now)
    return True


@router.post("/join", status_code=201)
def join_waitlist(
    body: JoinBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """Add an entry. Idempotent on (email, tier) — duplicate calls return ok."""
    if not _ip_rate_check(request):
        raise HTTPException(status_code=429, detail="Too many requests, please try again shortly.")

    email = body.email.lower().strip()
    user = _try_get_user(request, db)

    # Dedup: same (email, tier) within 30 days = treat as already-joined
    cutoff = datetime.utcnow() - timedelta(days=30)
    existing = (
        db.query(WaitlistEntry)
        .filter(
            WaitlistEntry.email == email,
            WaitlistEntry.tier == body.tier,
            WaitlistEntry.created_at >= cutoff,
        )
        .first()
    )
    if existing:
        return {"ok": True, "already_joined": True}

    entry = WaitlistEntry(
        user_id=user.id if user else None,
        email=email,
        tier=body.tier,
        source=(body.source or "")[:64] or None,
        notes=body.notes,
    )
    db.add(entry)
    db.commit()
    return {"ok": True, "already_joined": False}


@router.get("/status")
def my_waitlist_status(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Which tiers has the current user already joined the waitlist for?"""
    entries = (
        db.query(WaitlistEntry.tier, WaitlistEntry.created_at)
        .filter(
            (WaitlistEntry.user_id == user.id)
            | (WaitlistEntry.email == user.email.lower())
        )
        .all()
    )
    return [
        {"tier": t, "joined_at": (c.isoformat() if c else None)}
        for t, c in entries
    ]
