"""Download headers that survive any file name.

Starlette encodes response headers as latin-1, so a name carrying an en dash
("juli–december") or a letter outside latin-1 made the whole download a 500
— the Ledelsesrapport failed for every period longer than a month. The plain
``filename=`` gets an ASCII fallback; the real name rides in RFC 5987
``filename*=``, which every current browser prefers.
"""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

_DK_FOLD = {"æ": "ae", "ø": "oe", "å": "aa", "Æ": "Ae", "Ø": "Oe", "Å": "Aa",
            "–": "-", "—": "-"}
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def ascii_filename(name: str) -> str:
    folded = "".join(_DK_FOLD.get(c, c) for c in name)
    folded = unicodedata.normalize("NFKD", folded).encode("ascii", "ignore").decode("ascii")
    return _UNSAFE.sub("_", folded).strip("_.") or "download"


def attachment_header(name: str, disposition: str = "attachment") -> dict:
    return {
        "Content-Disposition": (
            f'{disposition}; filename="{ascii_filename(name)}"; '
            f"filename*=UTF-8''{quote(name, safe='')}"
        )
    }
