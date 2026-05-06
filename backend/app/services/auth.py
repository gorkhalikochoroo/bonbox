from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
# auto_error=False: don't 401 here when the Authorization header is missing —
# we have a fallback path that reads the same token from an HttpOnly cookie.
# get_current_user enforces the 401 itself if neither source has a token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# HttpOnly cookie name. Set on /auth/login alongside returning token in body.
# Reading order in get_current_user: Authorization header first (existing
# clients), then this cookie (newer clients that opt in via withCredentials).
AUTH_COOKIE_NAME = "bonbox_session"

# Double-submit CSRF cookie. Issued alongside the auth cookie on login/register/
# google. NON-HttpOnly so the frontend JS can read it and echo it back as the
# X-CSRF-Token header on state-changing requests; the CSRF middleware verifies
# the header equals the cookie. An attacker on another origin can't read the
# cookie (Same-Origin Policy) so they can't forge the header.
CSRF_COOKIE_NAME = "bonbox_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def _decode_token(token: str) -> dict:
    """Decode a JWT, supporting key rotation grace period.

    Multi-layer defense:
      1. Try the current SECRET_KEY first — fast path, ~all tokens.
      2. If JWTError AND SECRET_KEY_PREVIOUS is set, try that. Lets
         operators rotate keys without invalidating active sessions.
      3. Either way, payload validation is identical — sig is the only
         thing that changes between keys.
    """
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        if settings.SECRET_KEY_PREVIOUS:
            return jwt.decode(token, settings.SECRET_KEY_PREVIOUS, algorithms=[settings.ALGORITHM])
        raise


def get_current_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from either:
      • Authorization: Bearer <token>  (existing clients)
      • Cookie: bonbox_session=<token>  (HttpOnly, set on login)

    Bearer wins if both present — frontend can migrate at its own pace.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    raw_token = token or request.cookies.get(AUTH_COOKIE_NAME)
    if not raw_token:
        raise credentials_exception

    try:
        payload = _decode_token(raw_token)
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception
    return user
