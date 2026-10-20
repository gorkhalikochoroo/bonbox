"""venue_identity — what a guest may see about a venue (booking push p3).

The ONE place that decides the venue's public name and contact, read by the
public booking page (routers/public_reservations.public_page), every guest
and owner reservation mail (reservation_emails.venue_context) and the public
surface monitor (public_surface_check), so the three can never disagree.

Two rules, both "never claim an identity that isn't the venue's":
  * the name is never our own product name and never the demo seeder's
    sample company: when nothing usable is left the answer is None, and each
    surface words a nameless venue itself ("Book et bord") — there is no
    "BonBox" fallback here;
  * the demo seeder's sample contact (the street "Vestergade 1", the city
    "København K", the phone "+45 33 11 22 33", which rings a stranger) is
    withheld per field, only while that field still holds the seeded value
    AND the identity is the demo's (revisor_mail.is_demo_identity). The
    demo tag can outlive a partial edit (business_profile clears it only when
    the name and the CVR change), so an owner who corrected just the phone
    keeps their real phone on the page.

Pure: no DB, no clock. Every read is a getattr with a default, so a partial
object (the monitor's) never raises here for a missing attribute.
"""
from __future__ import annotations

import re
from typing import Any

# Our product name, as the surface monitor's stale_meta has always defined it.
_PRODUCT_NAME = "bonbox"


def _collapse(value: Any) -> str:
    return " ".join(str(value or "").split())


def _is_product_name(name: str) -> bool:
    return name.casefold() == _PRODUCT_NAME


def public_venue_name(owner: Any, profile: Any) -> str | None:
    """The name a guest sees: the owner's trading name (users.business_name),
    then the company name (business_profiles.company_name), each
    whitespace-collapsed. A candidate is skipped when it is empty, our own
    product name, or the demo sample company:
      * the account name, while it is still "Mirabelle ApS" with no own
        register-verified CVR (revisor_mail.signup_name_is_sample);
      * the company name, while it is the sample's AND the identity is the
        demo's (a real "Mirabelle ApS" that typed itself in is not caught).
    None when nothing is left — never "BonBox"."""
    from app.services import revisor_mail

    trading = _collapse(getattr(owner, "business_name", None))
    if trading and not _is_product_name(trading) and not revisor_mail.signup_name_is_sample(profile, owner):
        return trading
    company = _collapse(getattr(profile, "company_name", None)) if profile is not None else ""
    if company and not _is_product_name(company) and not (
            revisor_mail.seeded_company_name(profile)
            and revisor_mail.is_demo_identity(profile, owner)):
        return company
    return None


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _seeded_phone_digits() -> str:
    # Lazy: demo_seed imports half the app (as archetype_defaults does).
    from app.services.demo_seed import _seeded_profile_values
    return _digits(_seeded_profile_values()["phone"])


def public_venue_contact(owner: Any, profile: Any, settings: dict | None) -> dict:
    """{"address", "city", "phone"} as a guest may see them (each None when
    unset or withheld). Precedence as the page has always used:
      * phone: the reservations "call us" number (settings.contact_phone,
        owner-typed, never seeded), else the Profile phone;
      * address: the public address (never seeded), else the bookkeeping
        address;
      * city: the Profile city.
    A Profile value is withheld only while the identity is the demo's and the
    field still holds what the seeder wrote."""
    from app.services import revisor_mail

    settings = settings if isinstance(settings, dict) else {}
    if profile is None:
        return {"address": None, "city": None, "phone": settings.get("contact_phone") or None}
    demo = revisor_mail.is_demo_identity(profile, owner)

    phone = settings.get("contact_phone") or None
    if not phone:
        phone = getattr(profile, "phone", None) or None
        if phone and demo and _digits(phone) == _seeded_phone_digits():
            phone = None

    address = getattr(profile, "public_address", None) or None
    if not address:
        address = getattr(profile, "address", None) or None
        if address and demo and revisor_mail.seeded_street(profile):
            address = None

    city = getattr(profile, "city", None) or None
    if city and demo and _collapse(city).casefold() == revisor_mail.DEMO_SEEDED_CITY.casefold():
        city = None

    return {"address": address, "city": city, "phone": phone}
