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


def public_slug(value: str | None, fallback: str, max_len: int) -> str:
    """URL slug for a NEW public link — the booking page (bonbox.dk/<slug>),
    the gavekort shop, an event page. Lowercase ASCII with the letters
    transliterated rather than dropped: æ→ae, ø→oe, å→aa, and é/è→e, ü→u,
    ö→o, ä→a and the rest via NFKD (see slugify). Every minter used to strip
    anything outside a-z0-9, so "Café Mirabelle" became caf-mirabelle and
    "Cykelværkstedet" cykelv-rkstedet.

    Only for a slug being MINTED. A slug already stored is a published URL —
    on posters, QR codes, Google profiles — and is never recomputed."""
    s = slugify(value, fallback="")[:max_len].strip("-")
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


# A link a stranger can type into a booking: a scheme or "www." link, or a
# bare domain on a common top-level domain (spam names like "WIN cash.xyz").
# The look-behind keeps an e-mail address whole: "anna@cafe.dk" is not a
# link, and neither is a word glued to a dot or a hyphen.
_LINK_RE = re.compile(
    r"(?i)(?<![@\w.-])(?:(?:https?://|www\.)\S+"
    r"|[\w-]+\.(?:com|net|org|dk|io|ru|xyz|info|biz|top|click|link|shop|online|site|live|app|ly)\b(?:/\S*)?)"
)


def has_link(text: str | None) -> bool:
    """Does the text carry a URL, a www. link or a bare domain?"""
    return bool(text) and _LINK_RE.search(text) is not None


def strip_links(text: str | None) -> str | None:
    """Replace every link in a guest-typed text with "[link]".

    Anonymous booking text reaches the owner's e-mail and the host stand, and
    many mail clients turn a bare URL into a clickable anchor in mail sent from
    the venue. E-mail addresses stay as they are. Text with no link comes back
    unchanged (line breaks in a note included); where a link was replaced,
    runs of spaces left behind are collapsed."""
    if not text:
        return text
    out, n = _LINK_RE.subn("[link]", text)
    if not n:
        return text
    return re.sub(r"[ \t]{2,}", " ", out).strip()
