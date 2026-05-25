"""
Bank CSV Parser — auto-detect and parse Danish bank CSV exports.

Supported formats (DK-first):
  • Banks: Danske Bank, Nordea, Jyske Bank, Lunar, Revolut
  • Wallets: MobilePay Erhverv (Vipps MobilePay Business app CSV export)

Why MobilePay Erhverv lives here (not in services/payment_providers.py):
  The Vipps MobilePay Report API requires developer-portal API keys
  (Client ID / Secret / Subscription Key / Merchant Serial Number).
  Realistically ~80% of DK small organizers never enable developer
  access — they just export the CSV from the MobilePay Business app
  (Settings → Transactions → Export). For that population the CSV
  path is the actual workflow. By parsing the MobilePay CSV in the
  same engine that already handles the four Danish banks, /bank-import
  becomes the single "I have a CSV, import it" entry point — no
  separate wallet upload UI needed, no duplicate dedup logic, no
  separate booking_match wiring. The existing reconciliation engine
  + bilagsnummer chain + audit row trail all just work.
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
    # ─── MobilePay Erhverv (Vipps MobilePay Business CSV export) ─────
    # Owner exports from the MobilePay Business app:
    #   Settings → Transactions → Export period → CSV
    # or from portal.vippsmobilepay.com → Transactions → Download CSV.
    #
    # Real-world column shape (Aug 2024 export, verified against multiple
    # café exports — MobilePay tweaks column ORDER between releases but
    # the names are stable):
    #
    #   "Dato";"Tid";"Type";"Modtagernavn";"Afsendernavn";
    #   "Reference";"Besked";"Beløb";"Beløb i alt";"Valuta";"Status"
    #
    # Field semantics:
    #   Dato            — settlement date, DD-MM-YYYY
    #   Type            — "Modtaget" (received) / "Sendt" (sent) /
    #                     "Refusion" (refund) / "Gebyr" (fee)
    #   Modtagernavn    — receiver name (for outgoing payments)
    #   Afsendernavn    — sender name (for incoming payments)  ← key signal
    #   Reference       — MobilePay's internal txn ref (used for dedup)
    #   Besked          — the customer's "besked" / message field
    #                      (often contains booking ref like NMN14-A47B)
    #                      ← KEY signal for booking_match HIGH-confidence
    #   Beløb           — gross amount (positive = received, negative = sent)
    #   Beløb i alt     — net amount after MobilePay fee
    #   Valuta          — currency (always "DKK" for DK Erhverv)
    #   Status          — "Gennemført" (completed) / "Annulleret" (cancelled)
    #
    # We use "Beløb i alt" (net) as the amount when present, falling
    # back to "Beløb" — this matches what lands in the owner's bank.
    # Description is composed from Afsendernavn + Besked so the
    # downstream booking_match has both signals available without
    # changes to that service.
    "mobilepay_erhverv": {
        "label": "MobilePay Erhverv",
        "delimiter": ";",
        "date_col": "Dato",
        "desc_col": "Besked",
        "amount_col": "Beløb i alt",     # net (after fee); falls back below
        "balance_col": "",
        "date_fmt": "%d-%m-%Y",
        "danish_amounts": True,
        # "Afsendernavn" + "Modtagernavn" are unique to MobilePay's
        # Erhverv CSV — neither Danske/Nordea/Jyske nor Lunar/Revolut
        # ship these columns. Detector uses them as the discriminator
        # so we never accidentally re-route a bank CSV here.
        "header_markers": ["afsendernavn", "modtagernavn", "besked", "beløb"],
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
    """Auto-detect which bank/wallet exported this CSV by reading headers.

    Probe order matters: MobilePay Erhverv must run before the generic
    Danish-bank fingerprint (which keys off "dato;tekst;beløb") because
    a MobilePay CSV also has "Dato" + "Beløb" — only the presence of
    "Afsendernavn"/"Modtagernavn" disambiguates."""
    lines = text.strip().split("\n")
    if not lines:
        return None

    # Try first 5 lines for header (some banks have metadata rows)
    for line in lines[:5]:
        lower = line.lower().strip()

        # MobilePay Erhverv: unique "Afsendernavn"/"Modtagernavn" + "Besked"
        # signature. Check FIRST so we don't fall through to the generic
        # Danish-bank heuristic which would mis-tag MobilePay as Danske.
        if "afsendernavn" in lower or "modtagernavn" in lower:
            if "besked" in lower or "beløb" in lower:
                return "mobilepay_erhverv"

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

        # ── MobilePay Erhverv: filter + fallback handling ─────────
        # 1) Skip non-Gennemført rows (Annulleret/Pending). These
        #    never landed in the bank and shouldn't book to Sale.
        # 2) Fall back to gross "Beløb" if "Beløb i alt" (net) is
        #    blank — happens for refunds + fee-only rows.
        # 3) Description = "<Afsendernavn> · <Besked>" so the
        #    downstream booking_match service has BOTH the sender
        #    name (MED-confidence fuzzy signal) and the besked
        #    (HIGH-confidence reference substring signal) — without
        #    changes to booking_match itself, which reads the
        #    composed description as both signals.
        if bank_format == "mobilepay_erhverv":
            status = (_get_col(row, "Status") or "").strip().lower()
            # "Gennemført" = completed. Anything else (Annulleret,
            # Afventer, Refunderet midt-i-flow) skipped — only fully
            # settled lines should book to a Sale.
            if status and status not in ("gennemført", "gennemfort", "completed"):
                continue
            if not amount_raw or not parse_amount(amount_raw):
                # Try gross "Beløb" when net "Beløb i alt" is blank
                amount_raw = _get_col(row, "Beløb")
            sender = (_get_col(row, "Afsendernavn") or "").strip()
            receiver = (_get_col(row, "Modtagernavn") or "").strip()
            besked = (desc_raw or "").strip()
            # Income rows usually have Afsendernavn (customer paying us).
            # Expense rows have Modtagernavn (we paid out). Compose so
            # booking_match sees the customer name on income rows.
            counterparty = sender or receiver
            parts = [p for p in (counterparty, besked) if p]
            desc_raw = " · ".join(parts) if parts else besked

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

        # Generate ref hash for dedup. For MobilePay, prefer the
        # provider's stable Reference column when present — it
        # survives re-exports of the same range, which the
        # date+desc+amount hash does not (Besked may get edited
        # in MobilePay's app).
        if bank_format == "mobilepay_erhverv":
            mp_ref = (_get_col(row, "Reference") or "").strip()
            if mp_ref:
                ref_str = f"mp_{mp_ref}"
            else:
                ref_str = f"{date_iso}_{description}_{amount}"
        else:
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
