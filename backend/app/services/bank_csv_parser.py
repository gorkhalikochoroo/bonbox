"""
Bank CSV Parser — auto-detect and parse Danish bank CSV exports.
Supports: Danske Bank, Nordea, Jyske Bank, Lunar, Revolut
"""
import csv
import hashlib
import io
import re
from datetime import datetime

# ═══════════════════════════════════════════════════
# BANK FORMAT DEFINITIONS
# ═══════════════════════════════════════════════════

BANK_FORMATS = {
    "danske_bank": {
        "label": "Danske Bank",
        "delimiter": ";",
        "date_col": "Dato",
        "desc_col": "Tekst",
        "amount_col": "Beløb",
        "balance_col": "Saldo",
        "date_fmt": "%d.%m.%Y",
        "danish_amounts": True,
        "header_markers": ["dato", "tekst", "beløb", "saldo"],
        "exclude_markers": ["bogført", "rentedato"],
    },
    "nordea": {
        "label": "Nordea",
        "delimiter": ";",
        "date_col": "Bogført",
        "desc_col": "Tekst",
        "amount_col": "Beløb",
        "balance_col": "Saldo",
        "date_fmt": "%d.%m.%Y",
        "danish_amounts": True,
        "header_markers": ["bogført", "tekst", "beløb", "saldo"],
    },
    "jyske_bank": {
        "label": "Jyske Bank",
        "delimiter": ";",
        "date_col": "Dato",
        "desc_col": "Tekst",
        "amount_col": "Beløb",
        "balance_col": "Saldo",
        "date_fmt": "%d-%m-%Y",
        "danish_amounts": True,
        "header_markers": ["dato", "tekst", "beløb"],
        "require_markers": ["kontoudtog"],
    },
    "lunar": {
        "label": "Lunar",
        "delimiter": ",",
        "date_col": "Date",
        "desc_col": "Description",
        "amount_col": "Amount",
        "balance_col": "Balance",
        "date_fmt": "%Y-%m-%d",
        "danish_amounts": False,
        "header_markers": ["date", "description", "amount", "balance"],
    },
    "revolut": {
        "label": "Revolut",
        "delimiter": ",",
        "date_col": "Started Date",
        "desc_col": "Description",
        "amount_col": "Amount",
        "balance_col": "Balance",
        "date_fmt": "%Y-%m-%d %H:%M:%S",
        "danish_amounts": False,
        "header_markers": ["type", "product", "started date", "description", "amount"],
    },
}


def parse_danish_amount(text: str) -> float:
    """Parse Danish number format: 1.234,56 → 1234.56"""
    if not text or not text.strip():
        return 0.0
    text = text.strip().replace(" ", "")
    # Remove currency suffixes
    text = re.sub(r"\s*(kr\.?|dkk|eur|usd|nok|sek)$", "", text, flags=re.IGNORECASE)
    # Danish format: period = thousands, comma = decimal
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return 0.0


def parse_international_amount(text: str) -> float:
    """Parse international number format: 1,234.56 → 1234.56"""
    if not text or not text.strip():
        return 0.0
    text = text.strip().replace(" ", "")
    text = re.sub(r"\s*(kr\.?|dkk|eur|usd|nok|sek)$", "", text, flags=re.IGNORECASE)
    text = text.replace(",", "")
    try:
        return float(text)
    except ValueError:
        return 0.0


# ═══════════════════════════════════════════════════
# FORMAT DETECTION
# ═══════════════════════════════════════════════════

def detect_bank_format(text: str) -> str | None:
    """Auto-detect which bank exported this CSV by reading headers."""
    lines = text.strip().split("\n")
    if not lines:
        return None

    # Try first 5 lines for header (some banks have metadata rows)
    for line in lines[:5]:
        lower = line.lower().strip()

        # Revolut: unique "type,product,started date" pattern
        if "started date" in lower and "product" in lower:
            return "revolut"

        # Lunar: English headers with comma delimiter
        if "date" in lower and "description" in lower and "amount" in lower and "," in line and ";" not in line:
            return "lunar"

        # Nordea: has "bogført" column
        if "bogført" in lower and "tekst" in lower:
            return "nordea"

        # Danske Bank vs Jyske Bank — both have dato;tekst;beløb
        if "dato" in lower and "tekst" in lower and "beløb" in lower and ";" in line:
            if "bogført" not in lower:
                # Default to Danske Bank (most common), user can override
                return "danske_bank"

    return None


# ═══════════════════════════════════════════════════
# CSV PARSING
# ═══════════════════════════════════════════════════

def _find_header_row(lines: list[str], fmt: dict) -> int:
    """Find which line number contains the header row."""
    markers = fmt["header_markers"]
    for i, line in enumerate(lines[:10]):
        lower = line.lower()
        if sum(1 for m in markers if m in lower) >= 2:
            return i
    return 0


def _parse_date(text: str, fmt_str: str) -> str | None:
    """Parse date to ISO format YYYY-MM-DD."""
    text = text.strip()
    # Try the format's expected pattern
    for f in [fmt_str, "%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"]:
        try:
            return datetime.strptime(text, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def parse_bank_csv(text: str, bank_format: str | None = None) -> dict:
    """
    Parse a bank CSV and return structured transactions.
    Returns: {bank, transactions: [{date, description, amount, balance, type, ref_hash}], summary}
    """
    # Try multiple encodings
    if isinstance(text, bytes):
        for enc in ["utf-8-sig", "utf-8", "latin-1", "cp1252"]:
            try:
                text = text.decode(enc)
                break
            except (UnicodeDecodeError, AttributeError):
                continue

    if not bank_format:
        bank_format = detect_bank_format(text)
    if not bank_format or bank_format not in BANK_FORMATS:
        return {"bank": None, "transactions": [], "summary": {"error": "Could not detect bank format"}}

    fmt = BANK_FORMATS[bank_format]
    lines = text.strip().split("\n")
    header_idx = _find_header_row(lines, fmt)

    # Parse CSV from header row onward
    csv_text = "\n".join(lines[header_idx:])
    reader = csv.DictReader(
        io.StringIO(csv_text),
        delimiter=fmt["delimiter"],
        skipinitialspace=True,
    )

    # Normalize header names (strip whitespace, BOM)
    if reader.fieldnames:
        reader.fieldnames = [f.strip().lstrip("\ufeff") for f in reader.fieldnames]

    parse_amount = parse_danish_amount if fmt["danish_amounts"] else parse_international_amount
    transactions = []

    for row in reader:
        # Get values with flexible column matching
        date_raw = _get_col(row, fmt["date_col"])
        desc_raw = _get_col(row, fmt["desc_col"])
        amount_raw = _get_col(row, fmt["amount_col"])
        balance_raw = _get_col(row, fmt.get("balance_col", ""))

        if not date_raw or not amount_raw:
            continue

        date_iso = _parse_date(date_raw, fmt["date_fmt"])
        if not date_iso:
            continue

        amount = parse_amount(amount_raw)
        if amount == 0:
            continue

        balance = parse_amount(balance_raw) if balance_raw else None
        description = (desc_raw or "").strip()

        # Revolut: filter out pending/failed
        if bank_format == "revolut":
            state = _get_col(row, "State")
            if state and state.lower() not in ("completed", "settled"):
                continue

        # Generate ref hash for dedup
        ref_str = f"{date_iso}_{description}_{amount}"
        ref_hash = hashlib.sha256(ref_str.encode()).hexdigest()[:10]

        transactions.append({
            "date": date_iso,
            "description": description,
            "amount": round(amount, 2),
            "balance": round(balance, 2) if balance is not None else None,
            "type": "income" if amount > 0 else "expense",
            "ref_hash": ref_hash,
        })

    # Sort by date
    transactions.sort(key=lambda t: t["date"])

    income = [t for t in transactions if t["type"] == "income"]
    expenses = [t for t in transactions if t["type"] == "expense"]
    dates = [t["date"] for t in transactions]

    return {
        "bank": bank_format,
        "bank_label": fmt["label"],
        "transactions": transactions,
        "summary": {
            "total_rows": len(transactions),
            "income_count": len(income),
            "expense_count": len(expenses),
            "income_total": round(sum(t["amount"] for t in income), 2),
            "expense_total": round(sum(t["amount"] for t in expenses), 2),
            "date_from": min(dates) if dates else None,
            "date_to": max(dates) if dates else None,
        },
    }


def _get_col(row: dict, col_name: str) -> str | None:
    """Get column value with flexible matching (case-insensitive)."""
    if not col_name:
        return None
    # Exact match first
    if col_name in row:
        return row[col_name]
    # Case-insensitive
    lower = col_name.lower()
    for k, v in row.items():
        if k.lower().strip() == lower:
            return v
    return None


def get_supported_banks() -> list[dict]:
    """Return list of supported banks for the frontend."""
    return [
        {"id": k, "label": v["label"]}
        for k, v in BANK_FORMATS.items()
    ]
