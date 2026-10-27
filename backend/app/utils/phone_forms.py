"""The spellings ONE phone number can be stored as — for "Glem" (fix round
27 Oct 2026, review2 #3). Pure functions, no imports from the app.

A guest's number reaches a venue three ways: typed on the booking page
("+44 7700 900123"), typed by the owner or a host on the door's free-text
field ("07700 900123", with a no-break space or a direction mark pasted in
from a phone's contact card), or as a Danish 8-digit number with or without
45 / 0045. Erasing "that guest" must find every spelling of the SAME number
and never another number:

  • digits only, after NFKC (full-width digits are digits) — every space,
    no-break space, direction mark, dash or bracket goes (`digits_of`);
  • Danish: 8 digits, or 45 / 0045 + 8 digits — one number;
  • a country that dials a trunk "0" at home (TRUNK0_CCS: the UK, Sweden,
    Germany …) — "+44 7700 900123", "0044 7700 900123", "+44 (0)7700
    900123" and the national "07700 900123" are one number, both ways;
  • any other number: as typed, with or without a leading 00.
Never a tail: a number's last 8 digits are someone else's number abroad.
"""
from __future__ import annotations

import unicodedata

# Country codes whose national numbers carry a trunk "0" that the
# international form drops. E.164 country codes are prefix-free, so at most
# one of these starts a number. Not 45 (Denmark has no trunk prefix), 47
# (Norway), 30, 34, 351, 420 (none either); not 39 (Italy keeps its 0 in the
# international form); not 7 or 36 (their trunk prefixes are 8 and 06).
TRUNK0_CCS = (
    "20", "27", "31", "32", "33", "41", "43", "44", "46", "49", "61", "62", "63",
    "64", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "98",
    "212", "234", "254", "353", "358", "380", "880", "964", "977",
)

# Separators and invisible format characters a pasted number carries, for
# SQL (which cannot drop "every non-digit" portably — one REPLACE each, and
# SQLite's parser allows only so many nested; 22 here): the separators, the
# no-break / thin / figure spaces and the tab, the no-break hyphen and the
# en dash, and the marks phones paste around a number — zero-width space,
# LRM / RLM, the BOM, LRE … PDF (Android's contact card) and LRI … PDI.
# Written as escapes: no invisible character in this file.
SQL_STRIP = (
    " ", "-", "(", ")", ".", "/", "+",
    "\u00a0", "\u202f", "\u2009", "\u2007", "\t",
    "\u2011", "\u2013",
    "\u200b", "\u200e", "\u200f", "\ufeff",
    "\u202a", "\u202c", "\u2066", "\u2069",
)


def digits_of(phone: str | None) -> str:
    """The number's digits — ASCII 0–9 after NFKC, everything else gone."""
    s = unicodedata.normalize("NFKC", phone or "")
    return "".join(ch for ch in s if "0" <= ch <= "9")


def _trunk_cc(core: str) -> str | None:
    for cc in TRUNK0_CCS:
        if core.startswith(cc) and len(core) > len(cc) + 5:
            return cc
    return None


def _parse(phone: str | None):
    """("dk", national) | ("trunk", cc, nsn) | ("national0", nsn) |
    ("other", core) | None under 6 digits."""
    digits = digits_of(phone)
    if len(digits) < 6:
        return None
    core = digits[2:] if digits.startswith("00") else digits
    if len(core) == 10 and core.startswith("45"):
        return ("dk", core[2:])
    if len(core) == 8:
        return ("dk", core)
    if core.startswith("0") and not digits.startswith("00"):
        # Dialled at home with its trunk 0: the country is not written.
        return ("national0", core[1:])
    cc = _trunk_cc(core)
    if cc:
        nsn = core[len(cc):]
        if nsn.startswith("0"):          # "+44 (0)7700 900123"
            nsn = nsn[1:]
        return ("trunk", cc, nsn)
    return ("other", core)


def spellings(phone: str | None) -> list[str]:
    """Every digit string the SAME number can be stored as, for an exact SQL
    match (IN). [] under 6 digits."""
    p = _parse(phone)
    if p is None:
        return []
    kind = p[0]
    if kind == "dk":
        nat = p[1]
        return sorted({nat, "45" + nat, "0045" + nat})
    if kind == "trunk":
        _, cc, nsn = p
        return sorted({cc + nsn, "00" + cc + nsn, cc + "0" + nsn, "00" + cc + "0" + nsn, "0" + nsn})
    if kind == "national0":
        nsn = p[1]
        out = {"0" + nsn}
        for cc in TRUNK0_CCS:
            out |= {cc + nsn, "00" + cc + nsn, cc + "0" + nsn, "00" + cc + "0" + nsn}
        return sorted(out)
    core = p[1]
    return sorted({core, "00" + core})


def keys(phone: str | None) -> set[str]:
    """The number's identity, as a few canonical strings — two spellings of
    one number always share one (the block list's exact keys, which store
    no digits: services/contact_marks). Empty under 6 digits."""
    p = _parse(phone)
    if p is None:
        return set()
    kind = p[0]
    if kind == "dk":
        return {"45" + p[1]}
    if kind == "trunk":
        _, cc, nsn = p
        return {cc + nsn, "0" + nsn}
    if kind == "national0":
        return {"0" + p[1]}
    return {p[1]}
