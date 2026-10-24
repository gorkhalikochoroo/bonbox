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
#   • a scheme or "www." link — whatever it carries, an "@" included
#     ("https://secure-refund.com/claim?u=@me" is a link, not an address);
#   • a host with a sub-domain ("login.bonbox-refund.com", "my.evil.dk") —
#     any letter-only top-level domain, labels of two characters or more;
#   • a bare domain ("winner-dk.eu") on a common or a European top-level
#     domain;
#   • any domain with a path after it ("t.me/x", "wa.me/45…", "goo.gl/x",
#     "evil.com/claim@x");
#   • an IP address with a port or a path ("1.2.3.4/login") — a bare
#     "12.34.56.78" is a Danish phone number, not a link.
# Before matching, look-alike dots ("。", "．", "․", "[.]", "(.)") are folded
# to ".". Scheme and "www." links are found FIRST, on the text as typed; only
# then are e-mail addresses set aside, and only STRICT ones ("anna@cafe.dk",
# never a token that runs on into a path or another "@"): an address mask
# that swallowed any "\S+@\S+" hid every URL with an "@" in it (recheck,
# 24 Oct: such names were confirmed and reached the owner's e-mail as links).
# Labels of two characters or more keep "bl.a.", "f.eks." and "kl.19" text.
_TLDS = (
    "com|net|org|dk|io|ru|xyz|info|biz|top|click|link|shop|online|site|live|app|ly"
    "|eu|de|co|me|se|no|uk|cc|to|us|nl|fr|it|es|pl|ch|at|be|fi|is|ie|pt|cz|lt|lv|ee"
    "|gl|fo|tk|ml|ga|cf|gq|pw|ws|su|cn|in|br|ua|tv|gg|ai|sh|im|la|vip|win|bid|loan"
    "|work|club|store|tech|space|website|fun|icu|cyou|buzz|rest|bar|today|news|email"
    "|support|help|page|pro|cloud|digital|network|services|life|world|zone|mobi|name"
    "|dev|ca|gov|edu|np"
)
# A hostname label: letters/digits, hyphens inside. _SUB_LABEL (two or more
# characters) is for the sub-domain form, where any letter-only TLD counts —
# so "bl.a.glutenfri" and "f.eks.nødder" stay text.
_LABEL = r"[^\W_](?:[\w-]*[^\W_])?"
_SUB_LABEL = r"[^\W_][\w-]*[^\W_]"
_SCHEME_RE = re.compile(r"(?i)(?<![\w-])(?:https?://|www\.)\S+")
_LINK_RE = re.compile(
    r"(?i)(?<![\w-])(?:"
    # a host with a sub-domain: two+ labels, then a letter-only TLD
    r"(?:" + _SUB_LABEL + r"\.){2,}[^\W\d_]{2,24}\b(?:[:/]\S*)?"
    # a domain followed by a path ("t.me/x")
    r"|" + _LABEL + r"\.[^\W\d_]{2,24}/\S*"
    # a bare domain on a known TLD ("x.com", "winner-dk.eu")
    r"|" + _LABEL + r"\.(?:" + _TLDS + r")\b(?:[:/]\S*)?"
    # an IP address with a port or a path
    r"|\d{1,3}(?:\.\d{1,3}){3}[:/]\S*"
    r")"
)
# A STRICT e-mail address: not glued to a path, a scheme or another "@" on
# either side ("evil.com/claim@x" and "user@evil.com/login" are not
# addresses — the link match sees them).
_EMAIL_RE = re.compile(r"(?<![\w/:@.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w/@])")
_DOT_LOOKALIKES = re.compile(r"\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s*|[。．․｡]", re.I)


def _normalise(text: str) -> str:
    """NFKC (full-width letters, ligatures) and look-alike dots folded."""
    return _DOT_LOOKALIKES.sub(".", unicodedata.normalize("NFKC", text))


def _mask_emails(text: str) -> tuple[str, list[str]]:
    """Strict e-mail addresses out of the way of the link match, kept for
    restoring. Run AFTER the scheme/www links are out of the text."""
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
    norm = _normalise(text)
    if _SCHEME_RE.search(norm):
        return True
    masked, _ = _mask_emails(norm)
    return _LINK_RE.search(masked) is not None


def strip_links(text: str | None) -> str | None:
    """Replace every link in a text with "[link]".

    Used for the owner's own closure note (services/reservation_service.
    clean_closure_note), shown on the public booking page. NEVER for what a
    guest typed into a booking: a guest's name, notes, allergy note and
    occasion are stored exactly as typed (R1a fix round, 24 Oct: this rewrite
    turned "Glutenfri.Laktosefri.Nøddeallergi" into "[link]" and the allergy
    vanished from the book) — they are made harmless where they are SHOWN,
    by defang_links(). E-mail addresses stay as they are. Text with no link
    comes back unchanged (line breaks in a note included); where a link was
    replaced, runs of spaces left behind are collapsed."""
    if not text:
        return text
    out, n1 = _SCHEME_RE.subn("[link]", _normalise(text))
    masked, kept = _mask_emails(out)
    out, n2 = _LINK_RE.subn("[link]", masked)
    if not (n1 or n2):
        return text
    return re.sub(r"[ \t]{2,}", " ", _unmask(out, kept)).strip()


# ── A guest's booking text: kept as typed, defanged where it is shown ──
# R1a fix round (24 Oct 2026). What a guest types into a booking (name,
# notes, allergy note, occasion) is STORED EXACTLY AS TYPED — the AI allergy
# reading and the kitchen read the guest's own words. A link in it is made
# harmless only where it is SHOWN: every e-mail (guest and owner) passes it
# through defang_links(), and the owner's screens do the same in the browser
# (frontend/src/utils/guestText.js, the same rules).

_EXPLICIT_LINK_RE = re.compile(r"(?i)https?://|www\.")


def has_explicit_link(text: str | None) -> bool:
    """Does the text carry an EXPLICIT link: "http://", "https://" or
    "www." — any case, after Unicode NFKC (full-width "ｗｗｗ．" counts)?

    The booking screen's robot-like-name rule (booking_screen rule 3) reads
    only this. A bare dotted word is a normal name: "Anne.Marie.Jensen",
    "Hans.Chr.Andersen", "J.P.Hansen" (the R1a verify found such names held
    silently as links)."""
    if not text:
        return False
    return _EXPLICIT_LINK_RE.search(unicodedata.normalize("NFKC", text)) is not None


# A host on a domain ending mail clients turn into a link. Wider than _TLDS:
# a false match here only shows "[.]" (display, never stored), a miss shows a
# tappable link — so the endings the R1a verify got past (.zip, .lol, .nu …)
# are in. A dotted run of words needs a KNOWN ending (or a path after it), so
# "Glutenfri.Laktosefri.Nøddeallergi" and "Anne.Marie.Jensen" are shown as
# typed; endings that are everyday Danish words ("men", "by", "si") are left
# out. frontend/src/utils/guestText.js carries the same list (a backend
# test compares the two).
_DISPLAY_TLDS = _TLDS + (
    "|zip|mov|nu|casa|lol|sbs|fyi|st|ac|gle|ink|lat|mom|quest|cam|bond|cfd"
    "|hair|beauty|skin|makeup|boats|autos|homes|motorcycles|yachts|rocks|monster"
    "|wtf|host|press|global|party|review|trade|stream|download|racing|faith"
    "|science|accountant|cricket|webcam|xin|ren|wang|nz|au|jp|kr|tr|gr|hu|ro"
    "|bg|rs|mk|md|kz|il|ae|ir|pk|bd|ph|th|vn|sg|hk|mx|cl|ve|za|ng|ke|eg|tn"
)
_DISPLAY_TLD_SET = frozenset(_DISPLAY_TLDS.split("|"))
# A dotted token and what follows it (a port or a path). Linear: the dots
# separate the parts, so nothing backtracks over a long note (a regex that
# tried every ending at every label took 0.7 s on "a.a.a.…").
_HOST_TOKEN_RE = re.compile(r"(?<![\w.-])([\w-]+(?:\.[\w-]+)+)((?:[:/]\S*)?)")


def _is_ending(label: str) -> bool:
    low = label.lower()
    return low in _DISPLAY_TLD_SET or (low.startswith("xn--") and len(low) > 4)


def _link_labels(labels: list[str], suffix: str) -> int:
    """How many leading labels of a dotted token make a link: 0 for none.
    An IP address with a port or a path ("1.2.3.4/login" — a bare
    "12.34.56.78" is a phone number); any domain with a path ("t.me/x",
    "evil.lol/claim"); else up to the last label that is a known ending
    ("login.evil.com", "evil.com.Glutenfri" → "evil.com")."""
    if (suffix and len(labels) == 4
            and all(x.isdigit() and len(x) <= 3 for x in labels)):
        return 4
    last = labels[-1]
    if suffix.startswith("/") and last.isalpha() and 2 <= len(last) <= 24:
        return len(labels)
    for i in range(len(labels) - 1, 0, -1):
        if _is_ending(labels[i]):
            return i + 1
    return 0


def _defang_hosts(text: str) -> tuple[str, int]:
    """Every link-like dotted token defanged; (text, how many)."""
    n = 0

    def _one(m):
        nonlocal n
        labels = m.group(1).split(".")
        k = _link_labels(labels, m.group(2) or "")
        if not k:
            return m.group(0)
        n += 1
        host = "[.]".join(labels[:k])
        rest = "".join("." + x for x in labels[k:])
        return host + rest + (m.group(2) or "")

    return _HOST_TOKEN_RE.sub(_one, text), n


def _defang_token(token: str) -> str:
    """"https://evil.com/x" → "hxxps://evil[.]com/x": no mail client or
    phone turns it into a link, and the owner still reads what was typed."""
    token = re.sub(r"(?i)^h(tt)(ps?)(?=:)", lambda m: m.group(0)[0] + "xx" + m.group(2), token)
    return token.replace(".", "[.]")


def defang_links(text: str | None) -> str | None:
    """A guest's text as it is SHOWN: every link-like token kept as plain
    text with its dots defanged ("example[.]com", "hxxps://…"). The stored
    value is never changed — call this only on the way to an e-mail or a
    screen. Text with no link comes back exactly as given (line breaks
    included); e-mail addresses ("anna@cafe.dk") are never touched. When a
    link is found the text is shown NFKC-folded (full-width letters, look-
    alike dots), so a disguised link is defanged too."""
    if not text:
        return text
    norm = _normalise(text)
    out, n1 = _SCHEME_RE.subn(lambda m: _defang_token(m.group(0)), norm)
    masked, kept = _mask_emails(out)
    masked, n2 = _defang_hosts(masked)
    if not (n1 or n2):
        return text
    return _unmask(masked, kept)
