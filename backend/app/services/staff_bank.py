"""
Staff bank account (registreringsnummer + kontonummer) — validation, storage
and masking.

WHY THIS EXISTS AT ALL. The staff module was deliberately scoped as workforce
tracking, NOT payroll — no CPR, no konto, no pay maths. The owner reversed the
konto half of that on 2026-08-01: staff enter their own account in the portal so
the owner has it for the payroll export, without chasing people over SMS. Pay is
still not computed here and CPR is still out of scope.

WHAT THAT COSTS, AND HOW IT IS PAID:

  1. It is financial personal data, so it is ENCRYPTED AT REST with the existing
     MultiFernet helper (app/utils/crypto.py). Not a second crypto path — that
     helper already carries key rotation via APP_SECRET_KEY_PREVIOUS.
     CAVEAT, verified 2026-08-01: when APP_SECRET_KEY is unset the helper does
     NOT fail loud — it logs critical and derives the key from SECRET_KEY, the
     JWT signing secret. That couples session forgery and offline decryption of
     every kontonummer into one leaked value, and a JWT rotation done by the
     documented procedure (SECRET_KEY_PREVIOUS) never enters the Fernet chain,
     so the data becomes permanently unreadable. The router therefore refuses
     to STORE an account at all unless a dedicated APP_SECRET_KEY is set.
  2. The staff member NEVER sees more than the last 4 back, and only after the
     PIN. The owner sees the full number, because paying someone requires it.
  3. Every read of a full number is audited by the caller.
  4. The staffer can delete it themselves at any time (clear_bank), and the
     owner can clear it from the roster. It is deliberately NOT wiped on
     deactivate: staff are only ever deactivated, never soft-deleted, and a
     deactivated staffer is often seasonal or still owed a final salary.
     ⚠️ Account-level GDPR erasure does NOT currently reach this row — see the
     erasure note in app/models/staff.py. Do not rely on it.

DANISH FORMAT. A Danish account is a 4-digit registreringsnummer identifying the
bank branch plus a kontonummer of up to 10 digits. Humans write it as
"1234 5678901234", "1234-5678901234" or with dots, so normalise before storing.
Short account numbers are LEFT-PADDED to 10 with zeros, which is what banks do —
"1234 567" and "1234 0000000567" are the same account, and storing them
differently would show one person two different accounts on two screens.

We deliberately do NOT verify the reg-nr against a bank registry: the list moves,
a stale copy would reject valid accounts, and a wrong-but-well-formed number is
caught by the human who reads the payroll export. Format validation only.
"""

from __future__ import annotations

import re

from app.utils.crypto import decrypt, encrypt

# A kontonummer is at most 10 digits; a registreringsnummer is exactly 4.
REG_NR_LEN = 4
ACCOUNT_MAX_LEN = 10

# ...and at least this many, which is a SAFETY rule, not a format rule.
#
# Danish accounts are 10 digits and are written with leading zeros dropped, so
# zero-padding a short entry is right. But padding with no floor turns a typo
# into a real-looking account: "1234" + "5" would become 0000000005, and a
# reg-nr typed with one extra digit ("53011") would split into 5301/0000000001.
# Both are payable numbers that belong to someone else. Nobody downstream can
# catch it either — the owner reading the payroll export cannot tell 0000000001
# is a slip. Six digits is comfortably below any real kontonummer while
# rejecting every single- and double-keypress accident.
ACCOUNT_MIN_LEN = 6

_NON_DIGIT = re.compile(r"[^0-9]")


class BankValidationError(ValueError):
    """Raised for a malformed reg-nr / account number.

    Carries a machine-readable `code` so the router can map it to a
    translation key rather than shipping an English sentence to a Danish
    staff member.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _digits(raw: str | None) -> str:
    """Strip everything that is not a digit. Users paste spaces, dots and
    dashes straight out of their banking app; none of it is meaningful."""
    return _NON_DIGIT.sub("", raw or "")


def normalise(reg_nr: str | None, account: str | None) -> tuple[str, str]:
    """Validate and canonicalise a Danish account.

    Returns (reg_nr, account) as digit strings, account zero-padded to 10.
    Raises BankValidationError with a stable `code` on anything malformed.
    """
    reg = _digits(reg_nr)
    acct = _digits(account)

    if not reg and not acct:
        raise BankValidationError("empty", "No account given.")

    # Whole-account paste into the first field. People copy "1234-5678901" out
    # of their banking app and drop it in the box their cursor is already in.
    # Rejecting that teaches nothing and costs a support message, so split it:
    # the first 4 digits are the registreringsnummer, the rest the konto.
    #
    # Two guards, both load-bearing:
    #   • only when the account field is genuinely EMPTY — if the staffer filled
    #     both, we must not silently reinterpret what they typed;
    #   • only when the remainder is long enough to BE an account. Without this,
    #     "53011" (a reg-nr with one extra keypress) splits into 5301/…0001 and
    #     the server invents a payable account. A too-long reg-nr is a typo, not
    #     a paste, and must fail loudly.
    if not acct and len(reg) > REG_NR_LEN:
        rest = reg[REG_NR_LEN:]
        if ACCOUNT_MIN_LEN <= len(rest) <= ACCOUNT_MAX_LEN:
            reg, acct = reg[:REG_NR_LEN], rest

    if len(reg) != REG_NR_LEN:
        raise BankValidationError(
            "reg_nr_length", f"Registreringsnummer must be {REG_NR_LEN} digits."
        )
    if not acct:
        raise BankValidationError("account_missing", "Kontonummer is required.")
    if len(acct) > ACCOUNT_MAX_LEN:
        raise BankValidationError(
            "account_length", f"Kontonummer must be at most {ACCOUNT_MAX_LEN} digits."
        )
    # The floor that stops a slip becoming someone else's account number.
    if len(acct) < ACCOUNT_MIN_LEN:
        raise BankValidationError(
            "account_too_short", f"Kontonummer must be at least {ACCOUNT_MIN_LEN} digits."
        )
    # All-zero is never a real account and is the most common paste artefact.
    if not any(c != "0" for c in acct):
        raise BankValidationError("account_zero", "Kontonummer cannot be all zeros.")

    return reg, acct.zfill(ACCOUNT_MAX_LEN)


def mask(account_plain: str | None) -> str:
    """Last-4 display form: '•••• 4471'. Empty input → empty string.

    This is the ONLY form that ever reaches the staff member's phone.
    """
    acct = _digits(account_plain)
    if not acct:
        return ""
    return f"•••• {acct[-4:]}"


def encrypt_pair(reg_nr: str, account: str) -> tuple[bytes, bytes]:
    """Encrypt a normalised pair for storage. Call normalise() first."""
    return encrypt(reg_nr), encrypt(account)


def decrypt_account(ciphertext: bytes | str | None) -> str:
    """Decrypt a stored value, returning '' when unset.

    Deliberately does NOT swallow InvalidToken: a decrypt failure means the
    key rotated without APP_SECRET_KEY_PREVIOUS, and silently rendering an
    empty account would look like "the staff member never entered one" —
    the owner would pay nobody and never know why.
    """
    if not ciphertext:
        return ""
    return decrypt(ciphertext)


def storage_available() -> bool:
    """True only when a DEDICATED APP_SECRET_KEY is configured.

    Guards the write path. Without it, app/utils/crypto derives the at-rest key
    from SECRET_KEY — the JWT signing secret — which has two consequences we
    must not accept for bank data:

      • one leaked value gives both session forgery AND offline decryption of
        every kontonummer from a DB dump, which is precisely the threat the
        module exists to separate;
      • rotating the JWT secret by the documented procedure sets
        SECRET_KEY_PREVIOUS, which the Fernet chain never reads — so every
        stored account becomes permanently undecryptable and nobody gets paid.

    Refusing the write is the honest failure: never accept a number you cannot
    promise to give back. Reads are deliberately NOT gated — anything already
    stored must stay retrievable so it can be paid out or deleted.
    """
    import os

    return bool((os.environ.get("APP_SECRET_KEY") or "").strip())


def has_bank(member) -> bool:
    """True when the member has an account on file. Cheap — no decrypt."""
    return bool(getattr(member, "bank_account_enc", None))


def clear_bank(member) -> None:
    """Wipe the account. Called when the staffer removes it themselves.

    NOT called on deactivate — see the retention note in the module docstring.
    """
    member.bank_reg_nr_enc = None
    member.bank_account_enc = None
    member.bank_updated_at = None
