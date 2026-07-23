"""Canonical vendor keys — the single key space for per-vendor memory.

The bug this exists to kill: today `learn_category` is fed
`expense.description` while `suggest_category_for` is fed the OCR's
`vendor` string. Two different key spaces, so what the owner teaches on
save is looked up under a different name on the next scan — the memory
is written and never read. Every writer and every reader now calls
`canonical_vendor_key`, so there is exactly one key space.

Design bias: UNDER-collapse, never over-collapse. Two keys for one
supplier costs the owner a few extra confirmations. One key for two
suppliers silently merges their habits — and since a category carries a
§42 fradrag class, a merged key can move real købsmoms. When in doubt,
keep them separate.

Pure functions, no DB, no I/O — so the table-driven tests are the spec.
"""

from __future__ import annotations

import re
import unicodedata

# Danish letters do not NFKD-decompose into ASCII (ø is not o+diacritic),
# so they need an explicit map. Without this, "Føtex" and "Fotex" — the
# same shop, typed two ways by two OCR providers — become two keys.
_DK_FOLD = {
    "ø": "o", "æ": "ae", "å": "aa",
    "Ø": "o", "Æ": "ae", "Å": "aa",
}

# Danish company-form suffixes. "Føtex A/S" and "Føtex" are one supplier.
_LEGAL_SUFFIXES = (
    "a/s", "aps", "i/s", "ivs", "p/s", "k/s", "amba", "fmba", "smba",
    "as", "ab", "oy", "gmbh", "ltd", "inc", "bv", "nv", "sa", "srl",
)

# Store-number / terminal / payment tails that vary per RECEIPT, not per
# supplier. "NETTO 1284 LYNGBY" and "NETTO 0917 AMAGER" are one vendor.
_NOISE_TOKENS = {
    "butik", "store", "filial", "afd", "afdeling", "nr", "no",
    "dankort", "visa", "mastercard", "terminal", "kasse", "kvittering",
    "bon", "faktura", "cvr", "se", "tlf", "tel",
}

# Legal forms must die BEFORE punctuation stripping, or "A/S" becomes the
# two tokens "a" and "s" and "Føtex A/S" keys as "fotex a" — a different
# key from plain "Føtex", which is exactly the split this module exists
# to prevent.
_LEGAL_SUFFIX_RE = re.compile(
    r"(?:^|\s|,|\.)(?:a\s*/\s*s|i\s*/\s*s|p\s*/\s*s|k\s*/\s*s|aps|ivs|amba|fmba|smba"
    r"|a\.s\.|gmbh|ltd\.?|inc\.?|b\.?v\.?|n\.?v\.?|s\.?a\.?|srl)(?=$|\s|,|\.)",
    re.IGNORECASE,
)

_CVR_RE = re.compile(r"\bcvr[\s.:-]*\d[\d\s]*", re.IGNORECASE)
_STORE_NO_RE = re.compile(r"\b(?:nr|no|afd|butik|store|filial)\.?\s*\d+", re.IGNORECASE)
# Currency/amount fragments the OCR sometimes glues onto the vendor line.
_MONEY_RE = re.compile(r"\b\d+[.,]\d{2}\b|\bkr\.?\b|\bdkk\b", re.IGNORECASE)
_NON_WORD_RE = re.compile(r"[^\w\s-]", re.UNICODE)
_WS_RE = re.compile(r"\s+")

MAX_KEY_LEN = 80
_MAX_TOKENS = 2
_MIN_KEY_LEN = 3


def _fold_danish(text: str) -> str:
    """Collapse every spelling of a Danish vendor name onto one form.

    Two passes, and the second is the one that matters. Pass 1 expands
    the letters to their conventional transliterations (ø→oe, æ→ae,
    å→aa). Pass 2 then squeezes those digraphs down to a single vowel.

    The point is that all three spellings an owner or an OCR might
    produce for the same shop land on the same key:

        Føtex  -> foetex -> fotex
        Foetex -> foetex -> fotex
        Fotex  -> fotex  -> fotex

    Without pass 2, ø→o gives "fotex" while a typed "Foetex" stays
    "foetex" — two keys for one supplier, and the memory never
    accumulates. The cost is that two genuinely different vendors
    differing ONLY by an oe/ae/aa digraph would merge; no such pair
    exists in practice, and the digraph rule is applied consistently in
    both directions so it cannot merge asymmetrically.
    """
    out = "".join(_DK_FOLD.get(ch, ch) for ch in text)
    decomposed = unicodedata.normalize("NFKD", out)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    lowered = stripped.lower()
    for digraph, single in (("oe", "o"), ("ae", "a"), ("aa", "a")):
        lowered = lowered.replace(digraph, single)
    return lowered


def canonical_vendor_key(raw: str | None) -> str | None:
    """Collapse a vendor / description string to a stable lookup key.

    Returns None when there isn't enough signal to key on — a digit-only
    string, a 2-character fragment, or nothing at all. None means "don't
    learn from this", which is the honest outcome: a junk key would
    accrue evidence across unrelated suppliers.
    """
    if not raw or not isinstance(raw, str):
        return None

    text = _fold_danish(raw).lower()

    # Order matters: kill legal forms and CVR/store numbers while their
    # punctuation and labels are still attached, before generic stripping
    # makes them unrecognisable.
    text = _LEGAL_SUFFIX_RE.sub(" ", text)
    text = _CVR_RE.sub(" ", text)
    text = _STORE_NO_RE.sub(" ", text)
    text = _MONEY_RE.sub(" ", text)
    text = _NON_WORD_RE.sub(" ", text)

    tokens = [t for t in _WS_RE.split(text) if t]

    cleaned: list[str] = []
    for tok in tokens:
        if tok in _NOISE_TOKENS:
            continue
        # A bare number is a store/receipt number, never a vendor name.
        if tok.isdigit():
            continue
        # Legal form on its own token ("a s" after punctuation strip).
        if tok in _LEGAL_SUFFIXES:
            continue
        cleaned.append(tok)

    if not cleaned:
        return None

    # Trailing legal suffix that survived as part of the last token.
    while cleaned and cleaned[-1] in _LEGAL_SUFFIXES:
        cleaned.pop()
    if not cleaned:
        return None

    # First two tokens: enough to separate "cafe noir" from "cafe europa",
    # short enough that a trailing city or slogan doesn't fork the key.
    key = " ".join(cleaned[:_MAX_TOKENS])[:MAX_KEY_LEN].strip()

    if len(key) < _MIN_KEY_LEN:
        return None
    if key.isdigit():
        return None
    return key


def display_name_for(raw: str | None, fallback_key: str | None = None) -> str | None:
    """A human-readable label for the memory line ("...hos Netto").

    Uses the owner's own words (trimmed), NOT the canonical key — the key
    is a lookup token and reads like machine output. Falls back to a
    title-cased key so the UI never shows an empty vendor.
    """
    if raw and isinstance(raw, str):
        cleaned = _WS_RE.sub(" ", raw).strip()
        if cleaned:
            return cleaned[:160]
    if fallback_key:
        return fallback_key.title()[:160]
    return None
