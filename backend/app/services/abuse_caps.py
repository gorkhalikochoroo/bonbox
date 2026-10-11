"""Ceilings that hold when an attacker rotates IP addresses (R-sec).

Per-IP limits stop one noisy address; a caller with many addresses walks past
them. These counts are fleet-wide (every address together), so they bound
what BonBox sends no matter how the traffic is spread. Counts only — nothing
here logs or returns an address, e-mail or IP.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import case, func

from app.config import settings
from app.models.magic_link_token import MagicLinkToken
from app.models.user import User
from app.utils.time import utc_now


def magic_link_counts(db, domain: str | None = None) -> tuple[int, int]:
    """(last hour, last 24 hours) sign-in link rows — fleet-wide, or for one
    e-mail domain. One query (conditional aggregation). Raises if the count
    fails; the caller decides."""
    now = utc_now()
    q = db.query(
        func.count(MagicLinkToken.id),
        func.sum(case((MagicLinkToken.created_at >= now - timedelta(hours=1), 1), else_=0)),
    ).filter(MagicLinkToken.created_at >= now - timedelta(days=1))
    if domain is not None:
        # autoescape: a "_" or "%" in the domain is a literal, not a wildcard.
        q = q.filter(MagicLinkToken.email.endswith("@" + domain, autoescape=True))
    day, hour = q.one()
    return int(hour or 0), int(day or 0)


def _over(hour: int, day: int, max_hour: int, max_day: int) -> bool:
    return (max_hour > 0 and hour >= max_hour) or (max_day > 0 and day >= max_day)


def magic_link_ceiling(db, email: str) -> str | None:
    """"fleet" or "domain" when a sign-in mail ceiling is reached, else None.

    fleet  — sign-in link rows in the last hour / 24 h, every address;
    domain — the same for this e-mail's domain (the part after the last "@").
    Settings are read at call time; a setting <= 0 is skipped, and with all
    four off no query runs. Raises if a count fails — the caller decides
    (the magic-link router then sends nothing, like deliver()'s
    cap_check_error)."""
    s = settings
    fh, fd = s.MAGIC_LINK_FLEET_MAX_PER_HOUR, s.MAGIC_LINK_FLEET_MAX_PER_DAY
    if fh > 0 or fd > 0:
        if _over(*magic_link_counts(db), fh, fd):
            return "fleet"
    dh, dd = s.MAGIC_LINK_DOMAIN_MAX_PER_HOUR, s.MAGIC_LINK_DOMAIN_MAX_PER_DAY
    email = (email or "").strip().lower()
    domain = email.rsplit("@", 1)[-1] if "@" in email else ""
    if domain and (dh > 0 or dd > 0):
        if _over(*magic_link_counts(db, domain), dh, dd):
            return "domain"
    return None


def has_account(db, email: str) -> bool:
    """Does a CONFIRMED BonBox account use this (lower-cased) e-mail?

    Only email_verified counts. POST /auth/register makes an unconfirmed
    account for any address (5/min per IP), so counting those would let an
    IP-rotating caller pre-register victims and then mail each one past every
    ceiling. Magic-link, Google and Apple accounts are confirmed when they are
    created; an unconfirmed password account still signs in with its
    password. A failed lookup answers False: over a ceiling, "couldn't check"
    means "send nothing"."""
    try:
        return (
            db.query(User.id)
            .filter(func.lower(User.email) == (email or "").strip().lower(),
                    User.email_verified.is_(True))
            .first()
            is not None
        )
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False
