"""What a stored receipt reference points at — one strict parser.

Expense.receipt_photo holds one of three shapes, depending on where and when
the photo was stored:

  storage  a Supabase signed URL (…/object/sign/<bucket>/<key>?token=…), or
           the bare key '<user_id>/<kind>/<sha>.<ext>' when signing failed
  local    'uploads/receipts/<user_id>_<epoch>_<hex8>.jpg' — the dev / no-
           storage fallback of receipt_ocr.save_receipt_photo_ex
  inbox    'uploads/receipts/<sha256>.enc' — a forwarded e-mail attachment,
           Fernet-encrypted on disk (inbox_service.persist_attachment_blob)

The revisor package READS these files and hands them to a third party, and
"Knyt til eksisterende udgift" lets a client name one. Both go through this
parser, which accepts only these exact shapes — percent-decoded first, no dot
segments, no backslashes — and, for storage keys and local files, only this
owner's (the user id is part of the name). Anything else is None.
"""
from __future__ import annotations

import re
from urllib.parse import unquote

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY_RE = re.compile(rf"^(?P<uid>{_UUID})/(?P<kind>[a-z_]{{2,40}})/[0-9a-f]{{16,64}}\.(?:jpg|jpeg|png|webp|heic|pdf)$")
_LOCAL_RE = re.compile(rf"^uploads/receipts/(?P<uid>{_UUID})_\d{{1,12}}_[0-9a-f]{{8}}\.jpg$")
_INBOX_RE = re.compile(r"^uploads/receipts/[0-9a-f]{64}\.enc$")
_URL_MARKERS = ("/object/sign/", "/object/public/", "/object/authenticated/", "/object/")


def _clean(ref: str) -> str | None:
    s = unquote((ref or "").strip())
    if not s or "\\" in s or "\x00" in s:
        return None
    if any(seg in ("..", ".") for seg in s.split("?", 1)[0].split("/")):
        return None
    return s


def parse_receipt_ref(ref: str | None, user_id=None) -> tuple[str, str] | None:
    """('storage', key) | ('local', path) | ('inbox', path), or None.

    With `user_id`, a storage key or a local file must be that owner's.
    An inbox blob carries no owner in its name; it is only ever reached
    through the owner's own expense row (callers that take a client-supplied
    reference must not accept it — see is_own_upload)."""
    s = _clean(ref or "")
    if s is None:
        return None
    uid = str(user_id).lower() if user_id is not None else None
    if "://" in s:
        path = s.split("?", 1)[0]
        for marker in _URL_MARKERS:
            if marker in path:
                rest = path.split(marker, 1)[1]
                parts = rest.split("/", 1)
                if len(parts) != 2:
                    return None
                key = parts[1]
                m = _KEY_RE.match(key)
                if not m or (uid and m.group("uid") != uid):
                    return None
                return ("storage", key)
        return None
    m = _KEY_RE.match(s)
    if m:
        return ("storage", s) if not uid or m.group("uid") == uid else None
    m = _LOCAL_RE.match(s)
    if m:
        return ("local", s) if not uid or m.group("uid") == uid else None
    if _INBOX_RE.match(s):
        return ("inbox", s)
    return None


def is_own_upload(ref: str | None, user_id) -> bool:
    """A reference /expenses/upload-receipt could have handed THIS owner:
    their storage key under the 'expense' kind, or their local fallback file.
    Never an inbox blob (no owner in its name) and never someone else's."""
    parsed = parse_receipt_ref(ref, user_id)
    if not parsed:
        return False
    kind, value = parsed
    if kind == "storage":
        return value.split("/", 2)[1] == "expense"
    return kind == "local"
