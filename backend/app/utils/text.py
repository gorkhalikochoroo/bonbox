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


def portal_path(token: str, business_name: str | None,
                staff_name: str | None = None) -> str:
    """Relative staff-portal path with cosmetic, named prefixes:
    ``/s/<business-slug>/<staff-slug>/<token>`` (or ``/s/<business-slug>/<token>``
    when no staff name is given). The token is the capability key; the slugs are
    purely decorative so a shared link reads as "<business>/<staff>" — they are
    IGNORED when resolving the link. The frontend route accepts ``/s/<token>``,
    ``/s/<slug>/<token>`` AND ``/s/<slug>/<name>/<token>``, so every historical
    link keeps working."""
    biz = slugify(business_name, fallback="bonbox")
    staff = slugify(staff_name, fallback="") if staff_name else ""
    if staff:
        return f"/s/{biz}/{staff}/{token}"
    return f"/s/{biz}/{token}"
