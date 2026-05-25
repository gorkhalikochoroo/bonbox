"""Tests for the MobilePay Erhverv CSV format parser.

Pins the v2 contract added 2026-05-25 (DK-only payment-imports reframe):
the bank CSV engine now recognises the MobilePay Business app export
(Settings → Transactions → Export → CSV) so /bank-import is the single
"I have a CSV, import it" entry point for ~80% of DK organizers.

Reference column shape (Aug 2024 export, verified from multiple café
exports — MobilePay tweaks column ORDER between releases but the names
are stable):

  "Dato";"Tid";"Type";"Modtagernavn";"Afsendernavn";
  "Reference";"Besked";"Beløb";"Beløb i alt";"Valuta";"Status"
"""
from __future__ import annotations

from app.services.bank_csv_parser import detect_bank_format, parse_bank_csv


# ─── Detection ──────────────────────────────────────────────────────


def test_detect_mobilepay_erhverv_by_afsendernavn():
    """Unique 'Afsendernavn' header signal — disambiguates from
    the generic dato;tekst;beløb pattern shared with Danske/Jyske."""
    header = (
        "Dato;Tid;Type;Modtagernavn;Afsendernavn;Reference;Besked;"
        "Beløb;Beløb i alt;Valuta;Status"
    )
    assert detect_bank_format(header) == "mobilepay_erhverv"


def test_mobilepay_detect_does_not_clobber_danske_bank():
    """Danske Bank CSV (dato;tekst;beløb;saldo) must STILL detect as
    danske_bank — the MobilePay probe must not over-match."""
    danske_header = "Dato;Tekst;Beløb;Saldo\n22.05.2026;Test;150,00;1500,00"
    assert detect_bank_format(danske_header) == "danske_bank"


def test_mobilepay_detect_does_not_clobber_nordea():
    """Nordea CSV (bogført;tekst;beløb;saldo) must STILL detect as
    nordea — MobilePay never has a 'Bogført' column."""
    nordea_header = "Bogført;Tekst;Beløb;Saldo\n22.05.2026;Test;150,00;1500,00"
    assert detect_bank_format(nordea_header) == "nordea"


# ─── Parsing ────────────────────────────────────────────────────────


_MP_CSV_INCOME = (
    "Dato;Tid;Type;Modtagernavn;Afsendernavn;Reference;Besked;"
    "Beløb;Beløb i alt;Valuta;Status\n"
    # A normal received payment with a booking reference in 'Besked'
    "22-05-2026;13:42;Modtaget;Café Maria;Sita Sharma;mp-001;NMN14-A47B;"
    "150,00;145,50;DKK;Gennemført\n"
    # A second received payment without booking ref
    "23-05-2026;09:17;Modtaget;Café Maria;Anders Andersen;mp-002;Tak;"
    "85,00;82,00;DKK;Gennemført\n"
    # A cancelled row — MUST be skipped (never landed in the bank)
    "23-05-2026;14:00;Modtaget;Café Maria;Test User;mp-003;Refund;"
    "200,00;195,00;DKK;Annulleret\n"
)


def test_mobilepay_parses_income_with_net_amount():
    """Parser uses 'Beløb i alt' (net after fee) — that's what
    actually lands in the bank and what the matcher cares about."""
    result = parse_bank_csv(_MP_CSV_INCOME, bank_format="mobilepay_erhverv")
    assert result["bank"] == "mobilepay_erhverv"
    # 3 rows in input, 1 Annulleret skipped → 2 transactions
    assert len(result["transactions"]) == 2
    first = result["transactions"][0]
    # Date is the FIRST row by date sort (sorted ASC), so 22-05-2026
    assert first["date"] == "2026-05-22"
    # Net amount used
    assert first["amount"] == 145.50
    # Income (positive)
    assert first["type"] == "income"


def test_mobilepay_description_carries_sender_and_besked():
    """Description = '<Afsendernavn> · <Besked>' so the downstream
    booking_match service sees BOTH the customer name (MED-confidence
    fuzzy signal) and the besked text (HIGH-confidence reference
    substring signal)."""
    result = parse_bank_csv(_MP_CSV_INCOME, bank_format="mobilepay_erhverv")
    descs = [t["description"] for t in result["transactions"]]
    # First row: Sita Sharma + booking reference
    assert "Sita Sharma" in descs[0]
    assert "NMN14-A47B" in descs[0]
    # Second row: Anders + 'Tak'
    assert "Anders Andersen" in descs[1]


def test_mobilepay_skips_annulleret_status():
    """Annulleret / Pending rows must be skipped — they never
    landed in the bank, importing them would create a phantom Sale."""
    result = parse_bank_csv(_MP_CSV_INCOME, bank_format="mobilepay_erhverv")
    # The cancelled 195,00 row should NOT appear
    amounts = [t["amount"] for t in result["transactions"]]
    assert 195.00 not in amounts


def test_mobilepay_ref_hash_uses_provider_reference_when_present():
    """When the MobilePay 'Reference' column has a value, the dedup
    hash should be derived from it (stable across re-exports) rather
    than from date+desc+amount (which can drift if the owner edits
    the 'Besked' field after the fact)."""
    csv_a = _MP_CSV_INCOME
    # Same CSV but with a tweaked 'Besked' on row 1
    csv_b = csv_a.replace("NMN14-A47B", "Edited message")
    a = parse_bank_csv(csv_a, bank_format="mobilepay_erhverv")["transactions"][0]
    b = parse_bank_csv(csv_b, bank_format="mobilepay_erhverv")["transactions"][0]
    # Same Reference = same dedup hash, despite different description
    assert a["ref_hash"] == b["ref_hash"]


def test_mobilepay_auto_detect_end_to_end():
    """Caller can omit bank_format — detector picks MobilePay
    from the header signature."""
    result = parse_bank_csv(_MP_CSV_INCOME)
    assert result["bank"] == "mobilepay_erhverv"
    assert result["bank_label"] == "MobilePay Erhverv"
