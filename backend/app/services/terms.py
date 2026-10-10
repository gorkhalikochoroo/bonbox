"""Terms of Service: the current version and the acceptance record.

TERMS_VERSION names the Terms text that is live on /terms. The frontend shows
the same value as the "Sidst opdateret" date and exports it from
frontend/src/legal/terms.js — tests/test_terms_acceptance.py fails if the two
ever disagree. Change both in the same commit as the Terms text.

The acceptance record (users.terms_version + users.terms_accepted_at):
  • Written once, when an account is CREATED — password register, Google,
    Apple (both routes) and the magic-link verify that creates the account.
    A sign-in to an existing account never writes or replaces it.
  • Written only when the client sent accept_terms=true, i.e. the page the
    person signed up on showed the acceptance line next to the button they
    used — "Ved at oprette en konto accepterer du vores Handelsbetingelser."
    on /register, "Ved at fortsætte accepterer du vores Handelsbetingelser."
    on /login (Google, Apple, e-mail link). Both lines point to the
    Privatlivspolitik as information ("Læs om, hvordan vi behandler dine
    data …"), never as something to accept.
    An older app build that does not send the flag, or a sign-up path that
    shows no such line, leaves both columns NULL. We never record an
    acceptance nobody gave.
  • The version stamped is the SERVER's TERMS_VERSION, never a client value.
  • It is about the account holder, so it is in their own data export.

Also written at the point of purchase (R-e fix-up, 10 Oct 2026) — for the
accounts that never saw a sign-up line: everyone from before R-e, the /login
paths before the line was added there, older app builds. The subscription
page shows "Når du går videre til betaling, accepterer du vores
Handelsbetingelser og bekræfter, at du køber abonnementet til din
virksomhed." beside the Starter/Pro buttons and sends accept_terms=true with
the checkout request; apply_checkout_terms_acceptance() then stamps the
current TERMS_VERSION when the account has none or an older one. The same
happens when Stripe reports a Terms acceptance on its own page
(checkout.session.completed consent.terms_of_service == "accepted", only with
STRIPE_TOS_CONSENT on). A record that already names the current version is
never touched, so the first acceptance time is kept.

Paid plans are for businesses only (Manoj, 10 Oct 2026, decision 1): a
'personal' (Privatøkonomi) account cannot start a paid checkout —
is_personal_account() below is the one rule the billing router and the
checkout service both read.
"""
from __future__ import annotations

from app.utils.time import utc_now

# The Terms text dated 10 October 2026 (Handelsbetingelser with §8
# "Abonnement og betaling"). Same value as frontend/src/legal/terms.js.
TERMS_VERSION = "2026-10-10"


def clean_accept_terms(raw) -> bool | None:
    """True only for a real JSON true. Anything else becomes None.

    Never raises: an odd value from an old or broken client must not cost a
    signup — it simply records no acceptance.
    """
    return True if raw is True else None


def apply_terms_acceptance(user, accepted) -> bool:
    """Stamp a NEW account with the Terms version it accepted.

    Call it only where an account is being created (next to
    apply_signup_ref). Returns True when the record was written. `accepted`
    must be exactly True; None / False / anything else writes nothing.
    """
    if accepted is not True:
        return False
    user.terms_version = TERMS_VERSION
    user.terms_accepted_at = utc_now()
    return True


def apply_checkout_terms_acceptance(user, accepted) -> bool:
    """Stamp the current Terms version at checkout, when the buyer accepted
    them there (`accepted` exactly True) and the account's record is missing
    or names an older version. Returns True when the record was written.

    Unlike apply_terms_acceptance() this may run on an EXISTING account — it
    is the acceptance given beside the buy button (or on Stripe's page), not
    at sign-up. It never replaces a record that already names TERMS_VERSION,
    so the first acceptance time stays.
    """
    if accepted is not True:
        return False
    if getattr(user, "terms_version", None) == TERMS_VERSION:
        return False
    user.terms_version = TERMS_VERSION
    user.terms_accepted_at = utc_now()
    return True


def is_personal_account(user) -> bool:
    """A 'personal' (Privatøkonomi) account — paid plans are not for it.

    Same signal the app uses for personal mode (frontend lib/appMode.js:
    business_type === "personal"). Anything else — a real vertical, or the
    "" Google/Apple sign-up mints before onboarding — is a business.
    """
    return (getattr(user, "business_type", None) or "").strip().lower() == "personal"
