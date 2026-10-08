"""Signup ref — which door visit (if any) an account came from.

Fieldwork, Oct 2026: Manoj leaves a printed sheet at each venue he visits. Its
QR opens https://www.bonbox.dk/register?ref=<code>, where the code says only
the round, the argument used at the door and the visit number ("r1-a-03"). The
frontend keeps the code until the account exists and sends it with the
register call, the Google/Apple completion or the magic-link verify (the
mailed link carries it as &ref=); this module decides what is stored.

Rules (each one is tested in tests/test_signup_ref.py):
  • The code must match [a-z0-9-]{1,24} exactly. Anything else is IGNORED,
    never an error — a bad ref must not cost a signup.
  • It is written once, when the account is created. A sign-in to an existing
    account never adds or replaces one, so the first attribution stands.
  • It is a short code, not a name or e-mail — but once stored on an account
    it is pseudonymous personal data about that account; never return it
    next to an account outside the user's own export. Counts per code are
    read by the super-admin view and the thesis export; no endpoint returns
    a ref next to a person.
  • The frontend keeps only codes matching _FIELDWORK_RE below, or a QR test
    code "test-NN" (utils/signupRef.js); this module's rule stays the wider
    [a-z0-9-]{1,24}, so a test code is stored and rolls up under "other".
  • Retention: the privacy policy says the code is deleted from accounts on
    SIGNUP_REF_DELETE_ON. From that day no new account is stamped, and the
    nightly maintenance (jobs/retention_and_patterns.py) clears every
    account's code with purge_signup_refs().
"""
from __future__ import annotations

import re
from datetime import datetime

SIGNUP_REF_MAX_LEN = 24
_SIGNUP_REF_RE = re.compile(r"[a-z0-9-]{1,24}")

# "r1-a-03" → round "r1", argument "a", visit "03". Codes that don't follow
# the fieldwork pattern are still kept (and counted per ref); they just roll
# up under OTHER_PREFIX instead of a round/argument.
_FIELDWORK_RE = re.compile(r"(r\d{1,2})-([a-z])-(\d{1,3})")
OTHER_PREFIX = "other"

# The planned door rounds (Oct 2026): round 1 = argument A (8–14 Oct), round 2
# = argument B (15–21 Oct). The admin view always lists these two, at zero if
# no account carries their code yet, so an empty round shows as a counted 0
# rather than a missing row. Every count is a LOWER BOUND: a code only reaches
# an account created in the browser that opened the QR (memory, or storage
# with Marketing consent — frontend utils/signupRef.js) or through an e-mail
# link asked for there, and only once the code-keeping build is live.
FIELDWORK_PREFIXES = ("r1-a", "r2-b")

# The door rounds run 8–21 Oct 2026 and the thesis that uses the per-round
# totals is handed in in early January 2027, so the per-account code is kept
# until then and no longer. Promised on /privacy and /cookies (en + da) —
# change those texts together with this date. Naive UTC, like utc_now().
SIGNUP_REF_DELETE_ON = datetime(2027, 1, 31)


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


def apply_signup_ref(user, raw, now: datetime | None = None) -> bool:
    """Stamp a NEW account with the ref. Returns True when one was written.

    Never overwrites: an account that already has a ref keeps it. Nothing is
    written from SIGNUP_REF_DELETE_ON on — the code would only be deleted
    again that night.
    """
    if getattr(user, "signup_ref", None):
        return False
    if now is None:
        from app.utils.time import utc_now

        now = utc_now()
    if now >= SIGNUP_REF_DELETE_ON:
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


def purge_signup_refs(db, now: datetime) -> int:
    """From SIGNUP_REF_DELETE_ON on, clear the code from every account.

    Returns how many accounts lost their code (0 before the date, and 0 once
    nothing is left). The caller commits. Idempotent — the nightly job can
    run it every day.
    """
    if now < SIGNUP_REF_DELETE_ON:
        return 0
    from app.models.user import User

    n = (
        db.query(User)
        .filter(User.signup_ref.isnot(None))
        .update({User.signup_ref: None}, synchronize_session=False)
    )
    return int(n or 0)
