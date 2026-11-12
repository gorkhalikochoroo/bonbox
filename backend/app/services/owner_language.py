"""Which language a notification is written in.

The app's language is picked per device, and the app saves it to
users.ui_language whenever it differs from what the account has, so the
server can write a push in the language the owner actually reads the app in.

Notifications exist in Danish and English: Danish for "da", English for every
other app language (the app itself falls back to English for those).

Until the app has saved a choice (NULL) the old guess stands — a DKK account
reads Danish — so nobody's notifications switch language before they have
opened the app once.

`venue_language` is the other side: the language a venue's GUESTS see by
default — the public booking page's starting language, and the language of a
guest email when the guest's own choice is unknown.
"""

from __future__ import annotations


def owner_lang(user) -> str:
    """"da" or "en" for notifications addressed to this account holder."""
    chosen = (getattr(user, "ui_language", None) or "").strip().lower()
    if chosen:
        return "da" if chosen == "da" else "en"
    currency = (getattr(user, "currency", None) or "DKK").upper()
    return "da" if currency == "DKK" else "en"


# Timezones of the Danish realm. Only these (or country == "DK") make a
# venue's default guest language Danish — "any Europe/*" would wrongly turn a
# German or French venue Danish.
_DK_TIMEZONES = frozenset({
    "Europe/Copenhagen",   # Denmark
    "Atlantic/Faroe",      # Faroe Islands (DK realm)
    "America/Nuuk",        # Greenland (DK realm, current IANA id)
    "America/Godthab",     # Greenland (legacy IANA alias)
})


def venue_language(profile, owner) -> str:
    """"da" or "en": the language a venue's guests see by default.

    ONLY a genuine DK signal picks "da": profile.country == "DK", or — when
    the country is blank — a Danish-realm timezone on the owner. Everything
    else is English. The public booking page opens in this language (the guest
    can still switch), and guest emails fall back to it when the guest's own
    language is unknown. Tax / receipt / DK-terminology strings are unaffected.
    """
    country = (getattr(profile, "country", None) or "").strip().upper()
    tz = (getattr(owner, "timezone", None) or "").strip()
    is_dk_venue = country == "DK" or (not country and tz in _DK_TIMEZONES)
    return "da" if is_dk_venue else "en"


# Portugal's IANA zones (mainland, Madeira, the Azores).
_PT_TIMEZONES = frozenset({
    "Europe/Lisbon",
    "Atlantic/Madeira",
    "Atlantic/Azores",
})


def venue_country(profile, owner) -> str | None:
    """"DK", "PT" or None: the country a venue's GUESTS dial from — the
    default country code for a phone number typed without one (SMS), and the
    phone formatting the owner app uses.

    profile.country alone cannot say it: the onboarding wizard writes "DK"
    for every venue and the column defaults to "DK". owner.timezone alone
    cannot either: the app re-syncs it to the owner's browser on every login,
    so a Danish owner on holiday in Lisbon reads Lisbon. So:

      • "PT" — profile.country is "PT", or (country blank or the default
        "DK") a Portuguese timezone AND the account counts in EUR (both
        together; a travelling DKK owner never flips to Portugal).
      • "DK" — profile.country is "DK", or a blank country with a Danish-realm
        timezone, or the account counts in DKK. Every existing Danish venue
        lands here, so nothing about them changes.
      • None — anything else; callers keep their legacy Danish-first default.
    """
    country = (getattr(profile, "country", None) or "").strip().upper()
    tz = (getattr(owner, "timezone", None) or "").strip()
    currency = (getattr(owner, "currency", None) or "").strip().upper()
    if country == "PT":
        return "PT"
    # "DK" (or blank) is the wizard's default, not a choice — a Portuguese
    # zone with EUR outweighs it. Any other country the owner set stays theirs.
    if country in ("", "DK") and tz in _PT_TIMEZONES and currency == "EUR":
        return "PT"
    if country == "DK" or (not country and tz in _DK_TIMEZONES) or currency == "DKK":
        return "DK"
    return None
