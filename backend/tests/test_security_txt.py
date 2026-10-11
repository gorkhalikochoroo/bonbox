"""frontend/public/.well-known/security.txt (RFC 9116) exists, names a
contact and a canonical URL, and has not expired (OPS-09, R-i).

The Expires window is also the renewal reminder: this test goes red 30 days
before the file expires, and refuses an Expires more than a year out
(RFC 9116 recommends less than a year).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend", "public", ".well-known", "security.txt",
)


def _fields() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    with open(_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            name, value = line.split(":", 1)
            out.setdefault(name.strip(), []).append(value.strip())
    return out


def test_required_fields_present():
    f = _fields()
    assert f.get("Contact") and all(v.startswith(("mailto:", "https://")) for v in f["Contact"])
    assert f.get("Canonical") and all(
        v.startswith("https://") and v.endswith("/.well-known/security.txt") for v in f["Canonical"]
    )
    assert len(f.get("Expires", [])) == 1                     # RFC 9116: exactly once


def test_expires_is_between_30_and_366_days_away():
    raw = _fields()["Expires"][0]
    expires = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    assert expires.tzinfo is not None
    left = expires - datetime.now(timezone.utc)
    assert left >= timedelta(days=30), f"security.txt expires {raw}: renew it now"
    assert left <= timedelta(days=366), f"Expires {raw} is more than a year out"
