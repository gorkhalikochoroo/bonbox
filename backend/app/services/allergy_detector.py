"""
allergy_detector — rule-based (NOT LLM) allergy signal detection for free-text
reservation notes. Safety-first (GDPR Art. 9 + life-safety), designed by an
adversarial safety/AI/UX panel.

WHY A LEXICON, NOT AN LLM (the responsible call for a safety signal):
  • Deterministic + auditable — allergens.py is already a curated, versioned
    vocabulary; "why did it fire?" is always a literal matched term, never a
    model's opaque recall that drifts across versions.
  • Fail-closed + zero-latency — booking create is a synchronous write (the
    public path is unauthenticated + high-volume). A regex scan has no network,
    no timeout, no "the call errored → silent missed allergy" failure mode.
  • Recall bias is engineerable — over-match on real allergy language, but
    GATE on allergy context so a food *preference* ("elsker nødder" = loves
    nuts) never cries wolf.

WHAT IT NEVER DOES (honesty / safety invariants):
  • Never writes to the CONFIRMED allergen_tags / allergy_severity / allergy_note
    fields. It only ever produces an UNCONFIRMED suggestion the owner confirms.
  • Never suppresses/downgrades a real structured entry.
  • "ingen allergi" / "no allergies" suppresses only the GENERIC catch-all —
    never a specific matched allergen ("no allergies but allergic to nuts" still
    flags nuts).
  • Unsure ⇒ flag ("mulig allergi — uspecificeret"), never a silent all-clear.
    A false negative is treated as strictly worse than a false positive.
  • suggested_severity only ever ESCALATES to "severe"; never invents a number.
"""
from __future__ import annotations

import re
import unicodedata

from app.services.allergens import valid_keys_for

# Danish letters don't NFKD-decompose, so fold them explicitly before we strip
# accents — this makes matching diacritic-insensitive (nødder ≈ noedder).
_DK_FOLD = str.maketrans({"æ": "ae", "ø": "oe", "å": "aa", "Æ": "ae", "Ø": "oe", "Å": "aa"})


def _fold(s: str | None) -> str:
    if not s:
        return ""
    s = s.translate(_DK_FOLD).lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s


# key → folded surface synonyms. A synonym matches as a WORD PREFIX (\b before),
# so "gluten" hits both "gluten" and the compound "glutenfri", while a boundary
# before it stops "…gluten" mid-word false matches. Deliberately omits bare
# short roots that collide with common words (e.g. Danish "nød" is inside
# "nødvendig"=necessary) — we list the safe longer forms instead.
_SYNONYMS: dict[str, list[str]] = {
    # ── EU-14 food ──
    "gluten": ["gluten", "hvede", "wheat", "rug", "byg", "spelt", "durum"],
    "crustaceans": ["skaldyr", "rejer", "reje", "krebs", "krabbe", "hummer",
                    "shrimp", "prawn", "crab", "lobster", "crustace", "shellfish"],
    "eggs": ["aeg", "aegge", "egg", "eggs"],
    "fish": ["fisk", "fish"],
    "peanuts": ["peanut", "jordnoed"],
    "soybeans": ["soja", "soya", "soybean", "edamame"],
    "milk": ["maelk", "milk", "laktose", "lactose", "dairy"],
    "nuts": ["noedde", "noedder", "hasselnoed", "valnoed", "mandel", "mandler",
             "pistacie", "cashew", "pecan", "macadamia", "almond", "walnut",
             "hazelnut", "nut", "nuts"],
    "celery": ["selleri", "celery"],
    "mustard": ["sennep", "mustard"],
    "sesame": ["sesam", "sesame", "tahin", "tahini"],
    "sulphites": ["sulfit", "sulphite", "sulfite", "svovl"],
    "lupin": ["lupin"],
    "molluscs": ["blaeksprutte", "musling", "muslinger", "oester", "oyster",
                 "mussel", "clam", "squid", "mollusc"],
    # ── care (salon/beauty) ──
    "ppd_hair_dye": ["ppd", "haarfarve", "hair dye", "hairdye"],
    "ammonia": ["ammoniak", "ammonia", "blegemiddel", "bleach"],
    "latex": ["latex"],
    "fragrance": ["parfume", "fragrance", "duft"],
    "nickel": ["nikkel", "nickel"],
    "acrylates": ["akrylat", "acrylate", "akrylnegle", "gelenegle"],
    "formaldehyde": ["formaldehyd", "formaldehyde"],
    # ── medical (clinic) ──
    "penicillin": ["penicillin", "antibiotika", "antibiotic"],
    "local_anaesthetic": ["bedoevelse", "lokalbedoev", "anaesthetic",
                          "anesthetic", "lidocain"],
    "nsaids": ["ibuprofen", "nsaid", "ipren", "aspirin"],
    "iodine": ["jod", "iodine", "kontrast"],
    "adhesives": ["plaster", "adhesive"],
}

# Allergy CONTEXT — a specific allergen word in the general notes only flags
# when the text also reads like a restriction, so a preference ("elsker
# nødder") never fires. The dedicated allergy_note field is context by itself.
_CONTEXT_SUB = ["allerg", "intoleran", "taaler ikke", "kan ikke taale",
                "cannot eat", "cant eat", "can t eat", "undga", "reagerer paa"]
_CONTEXT_WORD = ["ingen", "uden", "without", "avoid", "no", "fri", "free"]

# Negation of the GENERIC allergy word only (not a specific allergen).
_NEG_GENERIC = ["ingen allerg", "no allerg", "uden allerg", "ingen kendte allerg",
                "no known allerg", "ikke allerg", "not allerg"]

# Severity-implying language → escalate the SUGGESTED severity to "severe",
# regardless of (or even without) a specific tag.
_SEVERITY = ["livstruende", "anafylaks", "anaphyla", "epipen", "epi pen",
             "doer af", "alvorlig allerg", "svaer allerg", "severe allerg",
             "serious allerg", "life threat", "life-threat", "deadly"]


def _sub(text: str, term: str) -> bool:
    """Word-prefix match: boundary before `term` (so 'gluten' hits 'glutenfri'
    but not '…gluten' mid-word). Multi-word terms match literally."""
    return re.search(r"\b" + re.escape(term), text) is not None


def _word(text: str, term: str) -> bool:
    return re.search(r"\b" + re.escape(term) + r"\b", text) is not None


def _has_context(text: str) -> bool:
    return (any(c in text for c in _CONTEXT_SUB)
            or any(_word(text, w) for w in _CONTEXT_WORD))


def detect_allergy_signals(guest_notes: str | None,
                           allergy_note: str | None,
                           business_type: str | None) -> dict | None:
    """Scan the two free-text fields for allergy signals. Returns an UNCONFIRMED
    suggestion dict, or None when nothing is found. NEVER decides the guest is
    safe — None means "no keyword matched", which the UI must not render as a
    confirmed all-clear.

    Result shape:
      {"suggested_tags": [...],          # subset of valid_keys_for(business_type)
       "suggested_severity": "severe"|None,
       "generic": bool,                  # allergy language, no specific allergen
       "matched_terms": [...],           # the literal triggers (audit trail)
       "confidence": "keyword_match",    # NEVER a fabricated number
       "unconfirmed": True}
    """
    an = _fold(allergy_note)          # inherently allergy-context
    gn = _fold(guest_notes)
    both = (an + " || " + gn).strip()
    if not both.replace("|", "").strip():
        return None

    valid = valid_keys_for(business_type)
    ctx_in_general = _has_context(both)

    tags: set[str] = set()
    matched: list[str] = []
    for key, syns in _SYNONYMS.items():
        if key not in valid:
            continue
        for s in syns:
            in_note = _sub(an, s)
            # A "-fri"/"-free" compound (glutenfri, mælkefri, nut-free) is a
            # restriction on its own, even with no other context word.
            free_compound = re.search(
                r"\b" + re.escape(s) + r"\w*[- ]?(fri|free)", gn) is not None
            in_general = _sub(gn, s)
            if in_note or free_compound or (in_general and ctx_in_general):
                tags.add(key)
                matched.append(s)
                break

    severe = any(t in both for t in _SEVERITY)
    if severe:
        matched.append("severe")

    neg_generic = any(n in both for n in _NEG_GENERIC)
    # A generic (unspecified) flag when allergy language is present but no
    # specific allergen was recognised — unless it's an explicit "no allergy".
    generic = bool(ctx_in_general and not tags and not neg_generic)
    # Severity language on its own (e.g. "anafylaksi") is a serious signal even
    # with no allergen word — surface it generically rather than stay silent.
    if severe and not tags and not neg_generic:
        generic = True

    if not tags and not generic:
        return None

    return {
        "suggested_tags": sorted(tags),
        "suggested_severity": "severe" if severe else None,
        "generic": generic,
        "matched_terms": sorted(set(matched)),
        "confidence": "keyword_match",
        "unconfirmed": True,
    }
