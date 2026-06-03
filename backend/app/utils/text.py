"""Small text helpers."""

from __future__ import annotations

import re
import unicodedata


def slugify(value: str | None, fallback: str = "s") -> str:
    """Cosmetic, URL-safe slug (lowercase ASCII). DK-friendly (æøå → ae/oe/aa).

    Used ONLY for decorative URL segments like /s/<slug>/<token> so a shared
    staff link reads as the restaurant's name. It is NOT a security token — the
    random token that follows it is what authorizes access, and the slug is
    ignored when resolving the link. Never rely on it for auth or uniqueness.
    """
    if not value:
        return fallback
    s = value.lower()
    for a, b in (("æ", "ae"), ("ø", "oe"), ("å", "aa")):
        s = s.replace(a, b)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or fallback


def portal_path(token: str, business_name: str | None) -> str:
    """Relative staff-portal path with a cosmetic, restaurant-named prefix:
    ``/s/<slug>/<token>``. The token is the capability key; the slug is purely
    decorative so the shared link reads as the business. The frontend route
    accepts both ``/s/<token>`` (legacy) and ``/s/<slug>/<token>``."""
    return f"/s/{slugify(business_name, fallback='bonbox')}/{token}"
