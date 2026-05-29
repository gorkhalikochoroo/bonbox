"""Allergen catalogue — vertical-aware, comprehensive.

Allergy capture is first-class on EVERY reservation, not a restaurant
side-note. Different verticals have different allergen domains, so we
expose a per-vertical tag set plus an always-present free-text + "other".

Tag keys are stable, locale-independent identifiers (stored on
Reservation.allergen_tags). Human labels are resolved in the frontend
i18n layer (en + da), so we keep only the keys + English fallback here.

GDPR: these tags, once attached to a named guest, are Art. 9 health data.
The reservation layer is responsible for retention-bounding them — this
module is just the controlled vocabulary used to VALIDATE incoming tags
(reject arbitrary strings → no free-form health data sprayed into the DB).

Reference: EU FIC Regulation 1169/2011 Annex II (the 14 food allergens).
"""
from __future__ import annotations

# The 14 allergens EU food businesses must declare (Reg. 1169/2011).
FOOD_ALLERGENS_EU14: list[dict] = [
    {"key": "gluten", "en": "Cereals containing gluten"},
    {"key": "crustaceans", "en": "Crustaceans"},
    {"key": "eggs", "en": "Eggs"},
    {"key": "fish", "en": "Fish"},
    {"key": "peanuts", "en": "Peanuts"},
    {"key": "soybeans", "en": "Soybeans"},
    {"key": "milk", "en": "Milk (incl. lactose)"},
    {"key": "nuts", "en": "Tree nuts"},
    {"key": "celery", "en": "Celery"},
    {"key": "mustard", "en": "Mustard"},
    {"key": "sesame", "en": "Sesame"},
    {"key": "sulphites", "en": "Sulphur dioxide / sulphites"},
    {"key": "lupin", "en": "Lupin"},
    {"key": "molluscs", "en": "Molluscs"},
]

# Salon / barber — contact + inhalation allergens common to hair & beauty.
CARE_ALLERGENS: list[dict] = [
    {"key": "ppd_hair_dye", "en": "PPD / hair dye"},
    {"key": "ammonia", "en": "Ammonia / bleach"},
    {"key": "latex", "en": "Latex"},
    {"key": "fragrance", "en": "Fragrance / perfume"},
    {"key": "nickel", "en": "Nickel"},
    {"key": "acrylates", "en": "Acrylates (gel / acrylic nails)"},
    {"key": "formaldehyde", "en": "Formaldehyde"},
]

# Clinic / wellness — medical allergens worth flagging before treatment.
MEDICAL_ALLERGENS: list[dict] = [
    {"key": "penicillin", "en": "Penicillin / antibiotics"},
    {"key": "latex", "en": "Latex"},
    {"key": "local_anaesthetic", "en": "Local anaesthetic"},
    {"key": "nsaids", "en": "NSAIDs (e.g. ibuprofen)"},
    {"key": "iodine", "en": "Iodine / contrast"},
    {"key": "adhesives", "en": "Adhesives / plasters"},
]

# Severity ladder — lets staff triage the dangerous ones at a glance.
SEVERITY_LEVELS = ["preference", "intolerance", "severe"]

# Which catalogue applies to which business vertical. Anything not mapped
# falls back to the food set (restaurants are the primary market).
_VERTICAL_SETS: dict[str, list[dict]] = {
    "restaurant": FOOD_ALLERGENS_EU14,
    "cafe": FOOD_ALLERGENS_EU14,
    "bar": FOOD_ALLERGENS_EU14,
    "bakery": FOOD_ALLERGENS_EU14,
    "food_truck": FOOD_ALLERGENS_EU14,
    "salon": CARE_ALLERGENS,
    "barber": CARE_ALLERGENS,
    "beauty": CARE_ALLERGENS,
    "spa": CARE_ALLERGENS,
    "clinic": MEDICAL_ALLERGENS,
    "wellness": MEDICAL_ALLERGENS,
    "dental": MEDICAL_ALLERGENS,
}


def allergen_set_for(business_type: str | None) -> list[dict]:
    """Return the allergen catalogue for a vertical (food set as fallback)."""
    if not business_type:
        return FOOD_ALLERGENS_EU14
    return _VERTICAL_SETS.get(business_type.strip().lower(), FOOD_ALLERGENS_EU14)


def valid_keys_for(business_type: str | None) -> set[str]:
    return {a["key"] for a in allergen_set_for(business_type)}


def sanitize_tags(tags, business_type: str | None) -> list[str]:
    """Keep only recognised tag keys for the vertical (drop arbitrary
    strings so no free-form health data lands in the DB). Order-preserving,
    de-duplicated, capped at the catalogue size."""
    if not tags or not isinstance(tags, (list, tuple)):
        return []
    allowed = valid_keys_for(business_type)
    seen: set[str] = set()
    out: list[str] = []
    for t in tags:
        if not isinstance(t, str):
            continue
        k = t.strip().lower()
        if k in allowed and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def sanitize_severity(value) -> str | None:
    if isinstance(value, str) and value.strip().lower() in SEVERITY_LEVELS:
        return value.strip().lower()
    return None
