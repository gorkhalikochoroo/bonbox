"""Strict e-mail address checks for addresses an OWNER types about someone else.

A staff member's address is typed by the owner and then mailed from BonBox's
own domain (SEC-1, R-f). It has to be ONE ordinary mailbox: no display name,
no second recipient, no header characters, no quoted local part, no
internationalised local part (the mail provider cannot deliver it), a real
domain with a dot. Deliverability (DNS) is not checked: it is slow, and a
mistyped but well-formed address only bounces.
"""
from email_validator import EmailNotValidError, validate_email

_MAX_LEN = 254


def _is_production() -> bool:
    try:
        from app.config import settings
        return (settings.ENVIRONMENT or "").lower() == "production"
    except Exception:  # noqa: BLE001 — unknown counts as production (strict)
        return True


def _validated(value: str):
    return validate_email(
        value,
        check_deliverability=False,
        allow_smtputf8=False,
        allow_quoted_local=False,
        allow_domain_literal=False,
        allow_display_name=False,
        # Outside production the RFC 6761 testing name ("x@cafe.test") is a
        # valid address, so local runs and the test suite can use it. In
        # production every reserved name (.test, .invalid, .local, …) is
        # refused: it can never be delivered.
        test_environment=not _is_production(),
    )


def strict_email(value) -> str | None:
    """The address to STORE: trimmed and normalised (domain lower-cased).

    None for a blank value (clears the field). Raises ValueError for anything
    that is not one ordinary mailbox — the schema turns that into a 422.
    """
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    if len(v) > _MAX_LEN:
        raise ValueError("e-mail address is too long")
    try:
        return _validated(v).normalized
    except EmailNotValidError as e:
        raise ValueError(f"not a valid e-mail address: {e}") from None


def sendable_email(value) -> str | None:
    """The address to SEND to (ASCII form), or None when it is blank or not
    one ordinary mailbox. Never raises — a send path skips the mail instead."""
    if not value:
        return None
    v = str(value).strip()
    if not v or len(v) > _MAX_LEN:
        return None
    try:
        return _validated(v).ascii_email
    except (EmailNotValidError, TypeError, ValueError):
        return None
