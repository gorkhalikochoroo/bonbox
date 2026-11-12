"""Address check against Danmarks Adresseregister (the file keeps its old
name; a later cleanup renames it).

DAWA, the free API this used, closed on 1 Oct 2026. The check now goes to
Klimadatastyrelsen's (KDS, formerly SDFE/SDFI) Adressevask + Adressevælger,
the official successor with the same DAR UUIDs, through
services/address_lookup.py. The register ONLY: OpenStreetMap is a map, not
the register, and the tick and the market-comparison gate must mean
"checked against Danmarks Adresseregister".

Why we cross-check CVR addresses against the register:
  • CVR holds the registered address — usually accurate but can drift
    when a business moves and forgets to update.
  • CVR sometimes returns abbreviated forms ("Vestergade 1, 1456 Kbh K")
    while the register holds the canonical postal form
    ("Vestergade 1, 1456 København K").
  • The register has a stable DAR UUID per address (an adresse id at unit
    level, a husnummer id at building level) — the server stores it in
    business_profiles.dawa_address_id. It is NOT a kvhx key.

Categories (the near-match picker keeps working on them):
  A — verified: the strict check passed (street + exact house number +
      postcode), or exactly one building-level hit.
  B — the register writes it a little differently (phonetic, historic,
      interval): the owner picks.
  Not found and "couldn't check right now" are two different answers
  (verify_address_outcome); verify_address() keeps its old dict|None shape.

The verifier is advisory for the owner: saving is never blocked.
"""
from __future__ import annotations

import anyio

from app.services import address_lookup
from app.services.address_lookup import Outcome, WashResult

__all__ = ["Outcome", "verify_address", "verify_address_outcome", "addresses_match", "clear_cache"]


def _build_betegnelse(address: str | None, zipcode: str | None,
                      city: str | None) -> str:
    """Compose the one-line address from CVR parts:
    "Vestergade 1, 1456 København K". The postcode is not appended twice when
    the address already carries it."""
    return address_lookup._wash_line(address, zipcode, city)


def _as_dict(r: WashResult) -> dict:
    return {
        "id": r.id,                    # DAR UUID (adresse or husnummer)
        "betegnelse": r.betegnelse,    # canonical form
        "category": r.category,        # "A" | "B"
        "level": r.level,              # "unit" | "building"
        "vejnavn": r.vejnavn,
        "husnr": r.husnr,
        "etage": r.etage,
        "doer": r.doer,
        "postnr": r.postnr,
        "postnrnavn": r.postnrnavn,
        # The street part as the register writes it ("Vestergade 1, 1. th"):
        # what the picker copies into the address field.
        "address_line": r.address_line,
    }


def verify_address_outcome(
    address: str | None,
    zipcode: str | None = None,
    city: str | None = None,
    *,
    user_key: str | None = None,
) -> tuple[Outcome, dict | None]:
    """(FOUND, dict) | (NOT_FOUND, None) | (UNAVAILABLE, None). Sync: run it
    from a threadpool route, never on the event loop."""
    outcome, result = address_lookup.wash(address, zipcode, city, user_key=user_key)
    if outcome == Outcome.FOUND and result is not None:
        return Outcome.FOUND, _as_dict(result)
    return (outcome if outcome != Outcome.FOUND else Outcome.NOT_FOUND), None


async def verify_address(
    address: str | None,
    zipcode: str | None = None,
    city: str | None = None,
) -> dict | None:
    """The old shape: the record dict, or None when the register has no
    match OR cannot be reached. Prefer verify_address_outcome, which keeps
    those two apart.

      {"id": "0a3f50ad-…", "betegnelse": "Vestergade 1, …", "category": "A",
       "vejnavn": "Vestergade", "husnr": "1", "postnr": "1456",
       "postnrnavn": "København K", …}
    """
    _outcome, record = await anyio.to_thread.run_sync(
        lambda: verify_address_outcome(address, zipcode, city)
    )
    return record


def addresses_match(cvr_address: dict, dawa_record: dict) -> bool:
    """True if the CVR address basically matches the register's record.

    The PICKER'S DISPLAY HINT only — never trust. Compares the postcode, the
    house number EXACTLY ("Vestergade 1" is not "Vestergade 12"; "3" is not
    "3B") and the street forgivingly (one contains the other, for
    abbreviations). Returns False if either side is empty.
    """
    if not cvr_address or not dawa_record:
        return False

    def _norm(s: str | None) -> str:
        if not s:
            return ""
        return "".join(c.lower() for c in str(s) if c.isalnum())

    cvr_zip = _norm(cvr_address.get("zipcode"))
    dawa_zip = _norm(dawa_record.get("postnr"))
    if cvr_zip and dawa_zip and cvr_zip != dawa_zip:
        return False

    parsed = address_lookup.parse_street_number((cvr_address.get("address") or "").split(",")[0])
    cvr_street = _norm(parsed.street)
    cvr_nr = address_lookup._norm_nr(parsed.number)
    dawa_street = _norm(dawa_record.get("vejnavn"))
    dawa_nr = address_lookup._norm_nr(dawa_record.get("husnr"))
    if not cvr_street or not dawa_street:
        return False
    if (cvr_nr or dawa_nr) and cvr_nr != dawa_nr:
        return False
    # Tolerant street comparison: one must contain the other (abbreviations)
    return cvr_street in dawa_street or dawa_street in cvr_street


def clear_cache():
    """Test helper — drop the address-lookup cache (this module keeps none
    of its own any more: its old 24 h cache also stored outages as 'no
    match')."""
    address_lookup.clear_cache()
