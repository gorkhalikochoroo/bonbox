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
