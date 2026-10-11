"""Keep bearer secrets out of stored logs.

Several links are their own credential: a staff portal link (/s/<token>), a
host-stand link, a gavekort or invite link. error_logs stored the raw request
path of every failure, so it held working tokens — a host-stand token opens a
venue's reservation book with guests' phones, emails and allergy notes. Any
path segment that looks like a generated secret is replaced before a row is
written. UUIDs stay: a booking or record id identifies, it does not
authorise.
"""
from __future__ import annotations

import re

# secrets.token_urlsafe(n) and friends: long runs of URL-safe characters.
_SECRET_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Query-string values that carry a credential.
_SECRET_PARAM = re.compile(r"(?i)([?&](?:token|t|code|key|secret|signature|sig)=)[^&#]*")


def redact_path(path: str | None) -> str | None:
    """The same path with every secret-looking segment and credential query
    value replaced by ":redacted"."""
    if not path:
        return path
    base, sep, query = path.partition("?")
    parts = []
    for seg in base.split("/"):
        if seg and _SECRET_SEGMENT.match(seg) and not _UUID.match(seg):
            parts.append(":redacted")
        else:
            parts.append(seg)
    out = "/".join(parts)
    if sep:
        out += "?" + _SECRET_PARAM.sub(r"\1:redacted", "?" + query)[1:]
    return out


# A link token inside free text (a log message, a header value, a full URL):
# a run of 20+ URL-safe characters right after a "/". A run followed by "."
# is a file name (retention_and_patterns.py), not a token.
_SECRET_IN_TEXT = re.compile(r"(?<=/)[A-Za-z0-9_-]{20,}(?![.A-Za-z0-9_-])")
_SECRET_PARAM_IN_TEXT = re.compile(
    r"(?i)([?&](?:token|t|code|key|secret|signature|sig)=)[^&#\s'\"]*"
)


def redact_text(text: str | None) -> str | None:
    """The same text with every path token and credential query value replaced
    by ":redacted" — for strings that are not a bare path (log lines, a
    Referer header, a full URL). UUIDs stay, as in redact_path."""
    if not text or not isinstance(text, str):
        return text
    out = _SECRET_IN_TEXT.sub(
        lambda m: m.group(0) if _UUID.match(m.group(0)) else ":redacted", text
    )
    return _SECRET_PARAM_IN_TEXT.sub(r"\1:redacted", out)


# An e-mail address inside free text (a provider's error message, say). The
# local part and domain stop at whitespace, brackets, quotes and separators,
# so "<owner@x.dk>" and "owner@x.dk," are both caught without their wrapping.
_EMAIL = re.compile(r"[^\s@<>()\[\]\"',;:]+@[^\s@<>()\[\]\"',;:]+\.[A-Za-z]{2,}")


def redact_emails(text: str | None) -> str | None:
    """The same text with every e-mail address replaced by "[e-mail]"."""
    return _EMAIL.sub("[e-mail]", text) if text else text
