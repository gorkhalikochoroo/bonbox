"""Signup ref — which door visit (if any) an account came from.

Fieldwork, Oct 2026: Manoj leaves a printed sheet at each venue he visits. Its
QR opens https://www.bonbox.dk/register?ref=<code>, where the code says only
the round, the argument used at the door and the visit number ("r1-a-03"). The
frontend keeps the code until the account exists and sends it with the
register call or the Google/Apple completion; this module decides what is
stored.

Rules (each one is tested in tests/test_signup_ref.py):
  • The code must match [a-z0-9-]{1,24} exactly. Anything else is IGNORED,
    never an error — a bad ref must not cost a signup.
  • It is written once, when the account is created. A sign-in to an existing
    account never adds or replaces one, so the first attribution stands.
  • It carries no personal data: it is a code Manoj printed, not a name, an
    e-mail or a venue. Counts per code are read by the super-admin view and
    the thesis export; no endpoint returns a ref next to a person.
"""
from __future__ import annotations

import re

SIGNUP_REF_MAX_LEN = 24
_SIGNUP_REF_RE = re.compile(r"[a-z0-9-]{1,24}")

# "r1-a-03" → round "r1", argument "a", visit "03". Codes that don't follow
# the fieldwork pattern are still kept (and counted per ref); they just roll
# up under OTHER_PREFIX instead of a round/argument.
_FIELDWORK_RE = re.compile(r"(r\d{1,2})-([a-z])-(\d{1,3})")
OTHER_PREFIX = "other"


def clean_signup_ref(raw) -> str | None:
    """The ref to store, or None when there is nothing valid to store.

    Never raises: a non-string, an empty string, a too-long string or one with
    any character outside [a-z0-9-] all come back as None.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value or len(value) > SIGNUP_REF_MAX_LEN:
        return None
    if not _SIGNUP_REF_RE.fullmatch(value):
        return None
    return value


def apply_signup_ref(user, raw) -> bool:
    """Stamp a NEW account with the ref. Returns True when one was written.

    Never overwrites: an account that already has a ref keeps it.
    """
    if getattr(user, "signup_ref", None):
        return False
    ref = clean_signup_ref(raw)
    if not ref:
        return False
    user.signup_ref = ref
    return True


def ref_prefix(ref: str | None) -> str | None:
    """The round/argument a ref belongs to: "r1-a-03" → "r1-a".

    None for no ref; OTHER_PREFIX for a ref outside the fieldwork pattern.
    """
    if not ref:
        return None
    m = _FIELDWORK_RE.fullmatch(ref)
    if not m:
        return OTHER_PREFIX
    return f"{m.group(1)}-{m.group(2)}"
