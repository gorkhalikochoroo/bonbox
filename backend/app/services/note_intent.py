"""
note_intent — rule-based (NOT LLM) classification of a reservation's free-text
note into ONE actionable host-stand intent, so the owner can filter / group the
book by it ("what kind of booking is this?"). Same doctrine as the allergy
detector (see allergy_detector.py): a curated, versioned lexicon —
deterministic, auditable, fail-closed, zero-latency on the synchronous booking
create path.

WHAT IT IS FOR (owner value): a birthday wants a cake + a good table; a
wheelchair guest needs step-free seating + room; a business lunch wants quiet.
Surfacing the intent lets the host PREP — a filter/badge, never a re-sort (the
book stays strictly time-ordered).

HONESTY / SAFETY INVARIANTS:
  • Returns exactly ONE label or None. None means "no keyword matched" — it is
    NOT a claim the note is empty or unimportant; the UI must never render it as
    a definitive classification.
  • It is a HINT, not a fact — the label is a quiet gray badge, never a colored
    alarm, and never overrides / competes with the allergy signal (which is a
    separate, safety-critical channel).
  • Accessibility outranks celebration/business/size, because a mobility/seating
    need is operationally the most important thing to get right.
  • Never infers anything sensitive beyond these operational buckets.

LABELS (priority order, first match wins):
  accessibility · celebration_birthday · celebration_anniversary · business ·
  large_group · (else) None
A party_size threshold ALSO yields large_group even with no text signal.
"""
from __future__ import annotations

import re
import unicodedata

# Danish letters don't NFKD-decompose — fold them explicitly, then strip accents
# so matching is diacritic-insensitive (fødselsdag ≈ foedselsdag). Mirrors the
# allergy detector's _fold so the two stay behaviourally consistent.
_DK_FOLD = str.maketrans({"æ": "ae", "ø": "oe", "å": "aa", "Æ": "ae", "Ø": "oe", "Å": "aa"})

# A party of this size or larger is a large_group even if the note says nothing —
# an operational reality (space + timing) the host wants to see at a glance.
LARGE_GROUP_MIN = 8

VALID_INTENTS = (
    "accessibility",
    "celebration_birthday",
    "celebration_anniversary",
    "business",
    "large_group",
)


def _fold(s: str | None) -> str:
    if not s:
        return ""
    s = s.translate(_DK_FOLD).lower()
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


# Folded surface terms per intent. Terms match as a WORD PREFIX (\b before), so
# "foedselsdag" hits "foedselsdagsmiddag". Ordered by priority in _INTENT_ORDER.
_TERMS: dict[str, list[str]] = {
    # ── accessibility / seating needs (highest priority — operational safety) ──
    "accessibility": [
        "koerestol", "wheelchair", "handicap", "gangbesvaer", "daarligt gaende",
        "svaert ved at ga", "rampe", "trappefri", "step free", "step-free",
        "elevator", "lift", "tilgaengelig", "accessible", "mobility",
        "barnestol", "hoejstol", "high chair", "highchair", "barnevogn",
        "stroller", "pram", "boernestol",
    ],
    # ── birthday ──
    "celebration_birthday": [
        "foedselsdag", "birthday", "bday", "b-day", "fylder", "runde aar",
        "fejre foedselsdag", "boernefoedselsdag",
    ],
    # ── anniversary / wedding-day ──
    "celebration_anniversary": [
        "bryllupsdag", "anniversary", "jubilaeum", "aarsdag", "soelvbryllup",
        "guldbryllup", "bryllup", "wedding", "forlovelse", "engagement",
    ],
    # ── business ──
    "business": [
        "forretningsmoede", "business", "firmamiddag", "firmafrokost",
        "firmajulefrokost", "arbejdsmoede", "kundemoede", "client dinner",
        "work dinner", "konference", "seminar", "erhverv", "kollegaer",
        "firma", "team", "networking",
    ],
    # ── large group (text signal; the size threshold is applied separately) ──
    "large_group": [
        "selskab", "stor gruppe", "large group", "large party", "gruppe pa",
        "group of", "stort bord", "polterabend", "hen party", "stag party",
        "reunion", "sammenkomst",
    ],
}

# First match in this order wins (accessibility before celebration, etc.).
_INTENT_ORDER = [
    "accessibility",
    "celebration_birthday",
    "celebration_anniversary",
    "business",
    "large_group",
]


def _hit(text: str, term: str) -> bool:
    """Word-prefix match: a boundary before `term` (so 'gruppe' hits
    'gruppemiddag' but not '…gruppe' mid-word). Multi-word terms match
    literally."""
    return re.search(r"\b" + re.escape(term), text) is not None


def classify_note_intent(note: str | None,
                         party_size: int | None = None) -> str | None:
    """Classify the reservation note into ONE operational intent (or None).

    party_size, when >= LARGE_GROUP_MIN, yields large_group even with no text
    signal — but a more specific TEXT intent (a birthday for 10) always wins,
    because "it's a birthday" is more actionable than "it's big".
    """
    text = _fold(note)

    if text:
        for intent in _INTENT_ORDER:
            for term in _TERMS[intent]:
                if _hit(text, term):
                    return intent

    # No text signal (or empty note) — fall back to the size-only heuristic.
    try:
        if party_size is not None and int(party_size) >= LARGE_GROUP_MIN:
            return "large_group"
    except (TypeError, ValueError):
        pass

    return None
