"""Ceilings that hold when an attacker rotates IP addresses (R-sec).

Per-IP limits stop one noisy address; a caller with many addresses walks past
them. These counts are fleet-wide (every address together), so they bound
what BonBox sends no matter how the traffic is spread. Counts only — nothing
here logs or returns an address, e-mail or IP.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import case, func

from app.models.magic_link_token import MagicLinkToken
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
