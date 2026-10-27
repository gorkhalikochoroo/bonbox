"""Blocked and spam-marked contacts at the anonymous booking door (R2, 27 Oct
2026).

Booking needs no account. When a stranger keeps booking anyway, the owner has
two tools, both on the booking's drawer:

  • SPAM marks the booking's contact. The next online booking from the same
    phone or mailbox is HELD quietly (booking_screen reason `marked_spam`,
    robot-like: no mail to the typed address, no ping of its own) for the
    owner to look at. Soft on purpose: a real guest marked by mistake still
    gets in, as a request the owner can confirm.
  • BLOKER blocks the contact. An online booking from it is refused with the
    venue's generic 409 `not_accepting` — the page then says the venue is not
    taking online bookings and offers the phone. Never "you are blocked".

STORE THE MINIMUM (GDPR). No address and no number is stored here. An entry:
  - `h`: HMAC-SHA256 of the venue, the kind and the NORMALISED contact — the
    mailbox (services/mailbox.canonical_mailbox: "+tags" and Gmail dots are
    one) or the phone's last 8 digits — keyed with a key derived from the
    server's SECRET_KEY, cut to 128 bits. With the database alone it cannot
    be turned back into a number by trying all 10^8 of them. Pseudonymous
    personal data still: kept as little and as short as the job needs;
  - `hint`: a masked form the owner recognises ("•• •• •• 78",
    "s•••@gmail.com") — the only readable trace, for the list and the undo;
  - `kind` (phone | email), `mode` (block | spam), `at` and `until` (dates),
    a random `id`.
RETENTION: an entry ends at `until` = `at` + BOOKING_CONTACT_MARK_DAYS (180)
and is ignored from then on; expired entries are dropped on every owner read
and write. ERASE: the owner removes one; a data subject's request is met by
contact (erase_contact: every entry for that phone or mailbox goes, without
the owner having to find it); the whole list goes with the business profile
when the account is erased. At most BOOKING_CONTACT_MARKS_MAX (200) a venue:
the oldest spam marks go first, then the oldest blocks.

A SECRET_KEY rotation makes old entries stop matching — they fail OPEN, so
nobody is ever blocked by a stale entry; SECRET_KEY_PREVIOUS is tried too
during the rotation's grace period.

Pure functions over the settings list; the routers store it in
business_profiles.reservation_settings_json under KEY. Never raises on junk.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets as _secrets_mod
from datetime import date, timedelta

from app.config import settings as app_config
from app.services.mailbox import canonical_mailbox

KEY = "contact_blocks"
KINDS = ("phone", "email")
MODES = ("block", "spam")
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_ID = re.compile(r"^[0-9a-f]{8}$")
_DOMAIN_SAFE = re.compile(r"[^a-z0-9.\-]")


def retention_days() -> int:
    try:
        n = int(app_config.BOOKING_CONTACT_MARK_DAYS)
    except Exception:  # noqa: BLE001
        n = 180
    return max(1, min(n, 3650))


def max_entries() -> int:
    try:
        n = int(app_config.BOOKING_CONTACT_MARKS_MAX)
    except Exception:  # noqa: BLE001
        n = 200
    return max(1, min(n, 1000))


# ── Normalising and hashing ─────────────────────────────────────────────

def norm_email(email: str | None) -> str | None:
    """The mailbox the address delivers to (+tags and Gmail dots folded),
    or None when it is not an address."""
    canon = canonical_mailbox(email)
    local, sep, domain = canon.rpartition("@")
    if not sep or not local or not domain or " " in canon:
        return None
    return canon


def norm_phone(phone: str | None) -> str | None:
    """The phone's last 8 digits, separators and a country code ignored —
    the same reading as the screen's same-guest rule (booking_screen
    _contact_match). None under 6 digits."""
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) < 6:
        return None
    return digits[-8:]


def _secrets() -> list[str]:
    out = []
    for s in (getattr(app_config, "SECRET_KEY", "") or "",
              getattr(app_config, "SECRET_KEY_PREVIOUS", "") or ""):
        s = str(s)
        if s and s not in out:
            out.append(s)
    return out


def _digest(owner_id, kind: str, norm: str, secret: str) -> str:
    key = hmac.new(secret.encode("utf-8"), b"bonbox.contact-mark.v1", hashlib.sha256).digest()
    msg = f"{owner_id}|{kind}|{norm}".encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]


def _contacts(email, phone) -> list[tuple[str, str]]:
    out = []
    p = norm_phone(phone)
    if p:
        out.append(("phone", p))
    e = norm_email(email)
    if e:
        out.append(("email", e))
    return out


def _candidate_hashes(owner_id, email, phone) -> set[str]:
    """Every hash this contact could be stored under (the current key and,
    during a rotation, the previous one)."""
    out = set()
    for kind, norm in _contacts(email, phone):
        for s in _secrets():
            out.add(_digest(owner_id, kind, norm, s))
    return out


def hint_phone(norm: str) -> str:
    """"•• •• •• 78" — the last two digits, always the same shape."""
    return "•• •• •• " + (norm or "")[-2:]


def hint_email(canon: str) -> str:
    """"s•••@gmail.com" — the first letter and the domain."""
    local, _, domain = (canon or "").rpartition("@")
    first = local[:1] if local else ""
    dom = _DOMAIN_SAFE.sub("", domain.lower())[:40]
    return f"{first}•••@{dom}"


# ── The list ────────────────────────────────────────────────────────────

def _date(v) -> date | None:
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def clean(raw, today: date) -> list[dict]:
    """The stored list as every reader and writer must see it: well-formed
    entries only, none expired, one per hash (a block wins over a spam mark,
    the later end wins), at most max_entries() — the oldest spam marks go
    first, then the oldest blocks. Newest first."""
    by_h: dict[str, dict] = {}
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        h = str(e.get("h") or "")
        kind, mode = e.get("kind"), e.get("mode")
        at, until = _date(e.get("at")), _date(e.get("until"))
        if not _HEX32.match(h) or kind not in KINDS or mode not in MODES:
            continue
        if at is None or until is None or until < today:
            continue
        eid = str(e.get("id") or "")
        if not _ID.match(eid):
            eid = _secrets_mod.token_hex(4)
        hint = str(e.get("hint") or "")[:60]
        entry = {"id": eid, "kind": kind, "h": h, "hint": hint, "mode": mode,
                 "at": at.isoformat(), "until": until.isoformat()}
        prev = by_h.get(h)
        if prev is None:
            by_h[h] = entry
            continue
        if prev["mode"] != "block" and mode == "block":
            prev["mode"] = "block"
        if entry["until"] > prev["until"]:
            prev["until"] = entry["until"]
        if entry["at"] > prev["at"]:
            prev["at"] = entry["at"]
    entries = list(by_h.values())
    cap = max_entries()
    if len(entries) > cap:
        newest = lambda e: (e["at"], e["until"])  # noqa: E731
        blocks = sorted((e for e in entries if e["mode"] == "block"), key=newest, reverse=True)
        marks = sorted((e for e in entries if e["mode"] == "spam"), key=newest, reverse=True)
        entries = blocks[:cap] + marks[:max(0, cap - len(blocks))]
    entries.sort(key=lambda e: (e["at"], e["id"]), reverse=True)
    return entries


def match(entries, owner_id, *, email=None, phone=None, today: date) -> str | None:
    """"block" when the contact is blocked here, "spam" when it was marked as
    spam, else None. Reads the stored list as it is (expired entries are
    ignored, nothing is written). Never raises: a broken read is no match —
    a broken guard must never turn away a real guest."""
    try:
        if not entries or not isinstance(entries, list):
            return None
        cand = _candidate_hashes(owner_id, email, phone)
        if not cand:
            return None
        found = None
        for e in entries:
            if not isinstance(e, dict) or e.get("h") not in cand:
                continue
            until = _date(e.get("until"))
            if until is None or until < today:
                continue
            if e.get("mode") == "block":
                return "block"
            if e.get("mode") == "spam":
                found = "spam"
        return found
    except Exception:  # noqa: BLE001
        return None


def add(entries, owner_id, *, email=None, phone=None, mode: str, today: date
        ) -> tuple[list[dict], list[str], list[str]]:
    """Mark (mode "spam") or block (mode "block") a contact's phone and
    mailbox. → (the new list, ids CREATED, ids UPGRADED from a spam mark to a
    block). An entry already there is renewed (its end moves out); a block
    is never turned into a mark by a later "spam". Only the current key is
    used to write."""
    if mode not in MODES:
        raise ValueError("mode")
    current = clean(entries, today)
    secret = (_secrets() or [""])[0]
    until = (today + timedelta(days=retention_days())).isoformat()
    created, upgraded = [], []
    for kind, norm in _contacts(email, phone):
        cand = {_digest(owner_id, kind, norm, s) for s in _secrets()}
        h = _digest(owner_id, kind, norm, secret)
        existing = next((e for e in current if e["h"] in cand), None)
        if existing is not None:
            if mode == "block" and existing["mode"] != "block":
                existing["mode"] = "block"
                upgraded.append(existing["id"])
            existing["h"] = h          # re-keyed under the current key
            existing["at"] = today.isoformat()
            if until > existing["until"]:
                existing["until"] = until
            continue
        e = {"id": _secrets_mod.token_hex(4), "kind": kind, "h": h,
             "hint": hint_phone(norm) if kind == "phone" else hint_email(norm),
             "mode": mode, "at": today.isoformat(), "until": until}
        current.append(e)
        created.append(e["id"])
    out = clean(current, today)
    ids = {e["id"] for e in out}
    return out, [i for i in created if i in ids], [i for i in upgraded if i in ids]


def remove(entries, entry_id: str, *, today: date, keep_mark: bool = False
           ) -> tuple[list[dict], bool]:
    """Remove one entry by id (or, with `keep_mark`, turn a block back into a
    spam mark — the undo of a block that upgraded an earlier mark).
    → (the new list, whether anything changed)."""
    current = clean(entries, today)
    out, changed = [], False
    for e in current:
        if e["id"] != entry_id:
            out.append(e)
            continue
        changed = True
        if keep_mark and e["mode"] == "block":
            out.append({**e, "mode": "spam"})
    return out, changed


def erase_contact(entries, owner_id, *, email=None, phone=None, today: date
                  ) -> tuple[list[dict], int]:
    """GDPR erasure by contact: drop every entry stored for this phone or
    mailbox (either key). → (the new list, how many went)."""
    current = clean(entries, today)
    cand = _candidate_hashes(owner_id, email, phone)
    if not cand:
        return current, 0
    keep = [e for e in current if e["h"] not in cand]
    return keep, len(current) - len(keep)


def public_list(entries) -> list[dict]:
    """What the owner's app is shown: never the hash."""
    out = []
    for e in entries or []:
        if isinstance(e, dict):
            out.append({k: e.get(k) for k in ("id", "kind", "hint", "mode", "at", "until")})
    return out


def entries_for(entries, owner_id, *, email=None, phone=None) -> list[dict]:
    """The entries stored for this contact (either key), as the app sees
    them — what the owner's "Markeret som spam" / "Blokeret" line names."""
    cand = _candidate_hashes(owner_id, email, phone)
    if not cand:
        return []
    return public_list([e for e in (entries or []) if isinstance(e, dict) and e.get("h") in cand])
