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

Existing accounts (Manoj, 10 Oct 2026, decision a): the Terms apply to them
from TERMS_EXISTING_FROM (the deploy day + 15 days, see the dates below);
they are told by an in-app notice only, never by e-mail. terms_notice_due()
says who sees it: every OWNER without an acceptance of the current version
(terms_version NULL or older), whenever the account was created, until
TERMS_EXISTING_FROM. dismiss_terms_notice() records that the owner closed it —
notice, never acceptance (terms_version / terms_accepted_at are not written).

Paid plans are for businesses only (Manoj, 10 Oct 2026, decision 1): a
'personal' (Privatøkonomi) account cannot start a paid checkout —
is_personal_account() below is the one rule the billing router and the
checkout service both read.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.utils.time import utc_now

# ═══════════════════════════════════════════════════════════════════════
#  !!! RELEASE-TIME DATES — PROVISIONAL — SET BOTH ON THE DAY R-e SHIPS !!!
#
#  TERMS_VERSION       = the deploy day (below).
#  TERMS_EXISTING_FROM = the deploy day + 15 days.
#
#  "Deploy day" = the Copenhagen day on which the FRONTEND bundle with the
#  notice is verified live on www.bonbox.dk (check the served bundle's
#  content, not only the push), with this backend already live. The notice is
#  frontend code (Vercel), so the notice period starts when the frontend is
#  live, not when the backend (Render) is. If the frontend goes live on a
#  later day than these dates assume, move BOTH dates (here and in
#  frontend/src/legal/terms.js) before that push. If it is verified live only
#  on a later day than the dates in the files (late push, slow build, stale
#  bundle), move both dates to that day and push again (backend first) the
#  same day.
#
#  The values below (14 Oct / 29 Oct 2026) are a GUESS at the ship day — R-e
#  ships after R-c, R-d/R-f and Manoj's Stripe settings. They are only true
#  if the R-e frontend is verified live on www.bonbox.dk on 14 Oct 2026.
#
#  These two lines and the two in frontend/src/legal/terms.js are the ONLY
#  places the dates live; the Terms page, the in-app notice and every test
#  read them from there. tests/test_terms_notice.py fails if the two files
#  differ or the gap is under TERMS_NOTICE_GAP_DAYS. Gate line in
#  bonbox-lab-state/releases.md ("R-e at push").
#
#  Why +15 and not +14: the live 13 May Terms §14 promise notice "mindst 14
#  dage, før ændringerne træder i kraft". The notice can only appear once the
#  frontend is live, part-way through the deploy day, and the Terms apply from
#  00:00 Copenhagen on TERMS_EXISTING_FROM — so deploy day + 14 would give
#  less than 14 full days.
# ═══════════════════════════════════════════════════════════════════════

# The Terms text (Handelsbetingelser with §8 "Abonnement og betaling"); the
# "Sidst opdateret" date on /terms and the version stamped on an acceptance.
# It is also the date the Terms apply to NEW accounts from (an account that
# accepts them at sign-up is bound at once).
TERMS_VERSION = "2026-10-14"

# The date the Terms apply to EXISTING accounts from (Manoj, 10 Oct 2026,
# decision a): every account without an acceptance of TERMS_VERSION. The
# in-app notice (terms_notice_due below) runs until 00:00 Copenhagen on it.
TERMS_EXISTING_FROM = "2026-10-29"

# The live Terms' promise (§14) ...
TERMS_NOTICE_MIN_DAYS = 14
# ... plus the deploy day, which is only part of a day of notice.
TERMS_NOTICE_GAP_DAYS = TERMS_NOTICE_MIN_DAYS + 1

_DK = ZoneInfo("Europe/Copenhagen")


def dk_midnight_utc(iso_day: str) -> datetime:
    """00:00 Copenhagen time on `iso_day`, as the naive UTC datetime the DB
    columns hold (app.utils.time.utc_now)."""
    d = date.fromisoformat(iso_day)
    local = datetime.combine(d, time(0, 0), tzinfo=_DK)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


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


# ── The in-app notice of new Terms for EXISTING accounts ─────────────────
#
# Manoj, 10 Oct 2026 (decision a): existing accounts are told about new Terms
# by an in-app notice ONLY (no e-mail), and the Terms apply to them from
# TERMS_EXISTING_FROM. The notice is information, not acceptance: closing it
# records only that it was closed (users.terms_notice_dismissed_version) and
# never writes terms_version / terms_accepted_at. Whether continued use after
# TERMS_EXISTING_FROM binds an account is what Terms §14 says — an open point
# for the attorney, not something the notice decides.


def is_account_owner(user) -> bool:
    """The person who owns the account (not a team member with own login)."""
    return (getattr(user, "role", None) or "owner") == "owner" and getattr(user, "owner_id", None) is None


def terms_notice_due(user, now: datetime | None = None) -> bool:
    """Should this account see the "Handelsbetingelser er opdateret" notice?

    True only when ALL hold:
      • the account owner (staff and other roles never see it);
      • no acceptance of the current Terms on record (terms_version NULL or
        older than TERMS_VERSION) — an account that accepted them at sign-up
        or at checkout has nothing to be told. WHEN the account was created
        does not matter (review, 10 Oct): an account created on the deploy
        day before the release went live, or through an app build that sends
        no accept_terms (owner iOS app 2.1), has accepted nothing either and
        is told like any existing account;
      • before TERMS_EXISTING_FROM (00:00 Copenhagen) — the notice stops on
        its own once the Terms apply;
      • not closed by the owner for this TERMS_VERSION.
    Never raises; anything odd reads False.
    """
    try:
        if not is_account_owner(user):
            return False
        accepted = getattr(user, "terms_version", None) or ""
        if accepted >= TERMS_VERSION:
            return False
        if (getattr(user, "terms_notice_dismissed_version", None) or "") == TERMS_VERSION:
            return False
        now = now or utc_now()
        if now >= dk_midnight_utc(TERMS_EXISTING_FROM):
            return False
        return True
    except Exception:  # noqa: BLE001 — a display flag must never cost /auth/me
        return False


def dismiss_terms_notice(user) -> bool:
    """Record that the owner closed the notice for TERMS_VERSION.

    Writes ONLY users.terms_notice_dismissed_version. It is not an
    acceptance: terms_version and terms_accepted_at are never touched here.
    Returns True when the value changed (idempotent)."""
    if getattr(user, "terms_notice_dismissed_version", None) == TERMS_VERSION:
        return False
    user.terms_notice_dismissed_version = TERMS_VERSION
    return True


def _notice_gap_days() -> int:
    """Calendar days between the Terms' date and the date they apply to
    existing accounts (tests pin it at >= TERMS_NOTICE_GAP_DAYS)."""
    return (date.fromisoformat(TERMS_EXISTING_FROM) - date.fromisoformat(TERMS_VERSION)) // timedelta(days=1)
