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


# A link a stranger can type into a booking. Gmail, Outlook and Apple Mail
# turn more than "www." and ".com" into a clickable link, so this matches:
#   • a scheme or "www." link;
#   • a host with a sub-domain ("login.bonbox-refund.com", "my.evil.dk") —
#     any letter-only top-level domain, labels of two characters or more;
#   • a bare domain ("winner-dk.eu") on a common or a European top-level
#     domain;
#   • any domain with a path after it ("t.me/x", "wa.me/45…", "goo.gl/x");
#   • an IP address with a port or a path ("1.2.3.4/login") — a bare
#     "12.34.56.78" is a Danish phone number, not a link.
# Before matching, look-alike dots ("。", "．", "․", "[.]", "(.)") are folded
# to ".", and an e-mail address is kept whole ("anna@cafe.dk" is not a link).
# Labels of two characters or more keep "bl.a.", "f.eks." and "kl.19" text.
_TLDS = (
    "com|net|org|dk|io|ru|xyz|info|biz|top|click|link|shop|online|site|live|app|ly"
    "|eu|de|co|me|se|no|uk|cc|to|us|nl|fr|it|es|pl|ch|at|be|fi|is|ie|pt|cz|lt|lv|ee"
    "|gl|fo|tk|ml|ga|cf|gq|pw|ws|su|cn|in|br|ua|tv|gg|ai|sh|im|la|vip|win|bid|loan"
    "|work|club|store|tech|space|website|fun|icu|cyou|buzz|rest|bar|today|news|email"
    "|support|help|page|pro|cloud|digital|network|services|life|world|zone|mobi|name"
)
# A hostname label: letters/digits, hyphens inside. _SUB_LABEL (two or more
# characters) is for the sub-domain form, where any letter-only TLD counts —
# so "bl.a.glutenfri" and "f.eks.nødder" stay text.
_LABEL = r"[^\W_](?:[\w-]*[^\W_])?"
_SUB_LABEL = r"[^\W_][\w-]*[^\W_]"
_LINK_RE = re.compile(
    r"(?i)(?<![\w@-])(?:"
    r"(?:https?://|www\.)\S+"
    # a host with a sub-domain: two+ labels, then a letter-only TLD
    r"|(?:" + _SUB_LABEL + r"\.){2,}[^\W\d_]{2,24}\b(?:[:/]\S*)?"
    # a domain followed by a path ("t.me/x")
    r"|" + _LABEL + r"\.[^\W\d_]{2,24}/\S*"
    # a bare domain on a known TLD ("x.com", "winner-dk.eu")
    r"|" + _LABEL + r"\.(?:" + _TLDS + r")\b(?:[:/]\S*)?"
    # an IP address with a port or a path
    r"|\d{1,3}(?:\.\d{1,3}){3}[:/]\S*"
    r")"
)
_EMAIL_RE = re.compile(r"\S+@\S+")
_DOT_LOOKALIKES = re.compile(r"\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s*|[。．․｡]", re.I)


def _normalise(text: str) -> str:
    """NFKC (full-width letters, ligatures) and look-alike dots folded."""
    return _DOT_LOOKALIKES.sub(".", unicodedata.normalize("NFKC", text))


def _mask_emails(text: str) -> tuple[str, list[str]]:
    """E-mail addresses out of the way of the link match, kept for restoring."""
    kept: list[str] = []

    def _keep(m):
        kept.append(m.group(0))
        return f"\x00{len(kept) - 1}\x00"

    return _EMAIL_RE.sub(_keep, text), kept


def _unmask(text: str, kept: list[str]) -> str:
    return re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], text)


def has_link(text: str | None) -> bool:
    """Does the text carry a URL, a www. link, a host or a bare domain?"""
    if not text:
        return False
    masked, _ = _mask_emails(_normalise(text))
    return _LINK_RE.search(masked) is not None


def strip_links(text: str | None) -> str | None:
    """Replace every link in a guest-typed text with "[link]".

    Anonymous booking text reaches the owner's e-mail and the host stand, and
    many mail clients turn a bare URL into a clickable anchor in mail sent from
    the venue. E-mail addresses stay as they are. Text with no link comes back
    unchanged (line breaks in a note included); where a link was replaced,
    runs of spaces left behind are collapsed. The caller cuts the result to
    its column: "[link]" can be longer than the link it replaced."""
    if not text:
        return text
    masked, kept = _mask_emails(_normalise(text))
    out, n = _LINK_RE.subn("[link]", masked)
    if not n:
        return text
    return re.sub(r"[ \t]{2,}", " ", _unmask(out, kept)).strip()
