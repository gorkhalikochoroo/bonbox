import hashlib
import re
import os
import io
import base64
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from PIL import Image

# Register HEIF/HEIC support
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    print("[OCR] HEIC/HEIF support loaded")
except ImportError:
    print("[OCR] pillow-heif not available, HEIC files won't be supported")

UPLOAD_DIR = Path("uploads/receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_jpeg(image_path: str) -> str:
    """Convert any image (including HEIC) to JPEG for OCR compatibility.
    Returns path to a JPEG file (may be the original if already JPEG/PNG)."""
    ext = Path(image_path).suffix.lower()

    if ext in (".jpg", ".jpeg", ".png", ".bmp", ".tiff"):
        return image_path  # Already compatible

    # Convert HEIC/HEIF/other formats to JPEG
    try:
        img = Image.open(image_path)
        jpeg_path = str(Path(image_path).with_suffix(".jpg"))
        img = img.convert("RGB")
        img.save(jpeg_path, "JPEG", quality=85)
        print(f"[OCR] Converted {ext} to JPEG")
        return jpeg_path
    except Exception as e:
        print(f"[OCR] Failed to convert {ext}: {e}")
        return image_path


def _image_to_base64_jpeg(image_path: str) -> str:
    """Read any image file and return base64-encoded JPEG data.
    Resizes large images for faster OCR processing."""
    try:
        img = Image.open(image_path)
        img = img.convert("RGB")
        # Resize if too large (keeps quality but speeds up OCR)
        max_dim = 2000
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
            img = img.resize(new_size, Image.LANCZOS)
            print(f"[OCR] Resized image to {new_size}")
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=90)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as e:
        print(f"[OCR] Failed to convert image to JPEG base64: {e}")
        # Fallback: just read raw bytes
        with open(image_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")


def _google_vision_ocr(image_path: str) -> str:
    """Use Google Cloud Vision API for OCR (free 1,000 images/month)."""
    api_key = os.environ.get("GOOGLE_VISION_API_KEY", "")
    if not api_key:
        print("[OCR] No Google Vision API key set")
        return ""

    # Convert to JPEG base64 (handles HEIC, PNG, etc.)
    image_data = _image_to_base64_jpeg(image_path)

    # Call Google Cloud Vision API
    url = f"https://vision.googleapis.com/v1/images:annotate?key={api_key}"
    payload = {
        "requests": [
            {
                "image": {"content": image_data},
                "features": [{"type": "TEXT_DETECTION"}],
            }
        ]
    }

    req = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            responses = result.get("responses", [{}])
            if responses and "error" in responses[0]:
                print(f"[OCR] Google Vision API error: {responses[0]['error']}")
                return ""
            annotations = responses[0].get("textAnnotations", [])
            if annotations:
                text = annotations[0].get("description", "")
                print(f"[OCR] Google Vision found text ({len(text)} chars)")
                return text
    except HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode("utf-8")
        except Exception:
            pass
        print(f"[OCR] Google Vision HTTP {e.code}: {error_body[:500]}")
    except Exception as e:
        print(f"[OCR] Google Vision error: {e}")

    return ""


def _ocrspace_ocr(image_path: str) -> str:
    """Use OCR.space free API as fallback (25,000 requests/month free)."""
    api_key = os.environ.get("OCRSPACE_API_KEY", "")
    if not api_key:
        print("[OCR] No OCR.space API key set")
        return ""

    print("[OCR] Trying OCR.space fallback...")

    # Convert to JPEG base64 (handles HEIC, PNG, etc.)
    image_data = _image_to_base64_jpeg(image_path)

    # Try OCR Engine 2 first (better for receipts), fall back to Engine 1
    import urllib.parse

    for engine in ["2", "1"]:
        data = urllib.parse.urlencode({
            "base64Image": f"data:image/jpeg;base64,{image_data}",
            "language": "eng",
            "isOverlayRequired": "false",
            "detectOrientation": "true",
            "scale": "true",
            "isTable": "true",
            "OCREngine": engine,
        }).encode("utf-8")

        req = Request(
            "https://api.ocr.space/parse/image",
            data=data,
            headers={
                "apikey": api_key,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )

        try:
            with urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("IsErroredOnProcessing"):
                    print(f"[OCR] OCR.space engine {engine} error: {result.get('ErrorMessage', 'unknown')}")
                    continue
                parsed = result.get("ParsedResults", [])
                if parsed:
                    text = parsed[0].get("ParsedText", "")
                    if text.strip():
                        print(f"[OCR] OCR.space engine {engine} found text ({len(text)} chars)")
                        return text
        except Exception as e:
            print(f"[OCR] OCR.space engine {engine} error: {e}")

    return ""


def _extract_amounts_from_text(text: str) -> dict:
    """Extract amounts from OCR text using regex patterns for Danish/English receipts."""
    amounts = []

    # Patterns for Danish receipts (comma as decimal separator)
    patterns = [
        # "I alt: 1.234,56" or "Total: 1234,56" or "SUM: 456,00"
        r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
        r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]+(?:\.[0-9]{2})?)",
        # "1.234,56 DKK" or "456,00 kr"
        r"([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\s*(?:DKK|kr\.?)",
        r"(?:DKK|kr\.?)\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
        # English format: "Total: 1,234.56"
        r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt)[:\s]*[DKK\s]*([0-9.,]+)",
        r"([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:DKK|kr|dkk)",
        r"(?:DKK|kr)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)",
    ]

    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            try:
                cleaned = match.strip()
                if "," in cleaned and "." in cleaned:
                    if cleaned.index(",") > cleaned.index("."):
                        # Danish: 1.234,56 → 1234.56
                        cleaned = cleaned.replace(".", "").replace(",", ".")
                    else:
                        # English: 1,234.56 → 1234.56
                        cleaned = cleaned.replace(",", "")
                elif "," in cleaned:
                    # Danish: 456,50 → 456.50
                    cleaned = cleaned.replace(",", ".")
                else:
                    cleaned = cleaned.replace(" ", "")

                val = float(cleaned)
                if val > 0:
                    amounts.append(val)
            except ValueError:
                continue

    # Fallback: grab all standalone numbers
    all_numbers_raw = re.findall(r"\b(\d{2,6}(?:[.,]\d{1,2})?)\b", text)
    all_numbers = []
    for n in all_numbers_raw:
        cleaned = n.replace(",", ".")
        try:
            val = float(cleaned)
            if val > 10:
                all_numbers.append(val)
        except ValueError:
            continue

    suggested_amount = max(amounts) if amounts else (max(all_numbers) if all_numbers else None)

    return {
        "raw_text": text[:500],
        "suggested_amount": suggested_amount,
        "all_amounts_found": sorted(set(amounts + all_numbers), reverse=True)[:5],
        "ocr_available": True,
    }


def _parse_danish_amount(text: str) -> float | None:
    """Parse a Danish-format amount string like '1.234,50' or '1234,50' to float.

    Danish convention:
      • period (.) = thousands separator
      • comma (,) = decimal separator (followed by 1-2 øre digits)

    Critical disambiguation: '1.820' is NOT 1.82 — it's 1820 (one
    thousand eight hundred twenty). The earlier parser treated '1.820'
    as English decimal and returned 1.82, silently corrupting Z-report
    extractions Manoj caught on a Mirabelle close. The fix: count
    digits after the period. Exactly 3 = thousands separator, 1-2 =
    English decimal (rare in DK receipts but supported as last-resort
    fallback for mixed-locale inputs).

    Order of patterns matters — most-specific first so '1.234,50'
    doesn't get partially captured as '1.234' before the comma is
    seen.
    """
    text = (text or "").strip()
    if not text:
        return None

    # 1. Full Danish format with thousands grouping + decimal comma.
    #    e.g. '1.234,50', '12.345,67', '8.477,20', '1.234.567,89'.
    m = re.search(r"([0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{1,2})", text)
    if m:
        raw = m.group(1)
        return float(raw.replace(".", "").replace(",", "."))

    # 2. Danish thousands ONLY (no decimal comma). Period followed by
    #    EXACTLY 3 digits, with negative lookahead to prevent matching
    #    inside a longer number. e.g. '1.820', '17.030', '1.234.567'.
    m = re.search(r"([0-9]{1,3}(?:\.[0-9]{3})+)(?![\.,]?\d)", text)
    if m:
        raw = m.group(1)
        return float(raw.replace(".", ""))

    # 3. Plain integer with comma decimal (no thousands separator).
    #    e.g. '1234,50', '500,00'.
    m = re.search(r"([0-9]+,[0-9]{1,2})(?!\d)", text)
    if m:
        return float(m.group(1).replace(",", "."))

    # 4. English-format fallback: period followed by 1-2 digits (decimal),
    #    NOT followed by another digit. e.g. '1.50', '1.5' — these are
    #    legitimate sub-kroner amounts when OCR pulled them from a
    #    mixed-locale source. Bounded by lookahead so '1.820' (which
    #    pattern 2 already caught above) cannot reach here.
    m = re.search(r"([0-9]+\.[0-9]{1,2})(?!\d)", text)
    if m:
        return float(m.group(1))

    # 5. Plain integer last.
    m = re.search(r"([0-9]+)", text)
    if m:
        return float(m.group(1))

    return None


# Defense layer 2 — sanity threshold for revenue-context amounts.
# A real Danish kasserapport line for revenue / payment / MOMS is
# essentially never sub-1 DKK; even a single coffee runs 30+ DKK. If
# the parser returns 1.82 (the Manoj-hit bug class), that's almost
# certainly a misread — drop it instead of letting it propagate. The
# downstream max(breakdown_sum, override) logic then keeps the close
# safe. This is layer 2 on top of the parser fix in commit 6a15215.
_MIN_PLAUSIBLE_REVENUE_DKK = 1.0


def _is_implausibly_small(value: float | None) -> bool:
    """Return True for values that can't be a real DKK amount on a
    revenue / payment / MOMS line. Sub-1 kroner is the threshold."""
    return value is not None and 0 < value < _MIN_PLAUSIBLE_REVENUE_DKK


def _find_amount_near_keyword(lines: list[str], keyword_pattern: str) -> float | None:
    """Search lines for a keyword and extract the amount on that line or the next.

    Multi-layer defense:
      L1 — Parser disambiguates Danish thousands vs English decimal
           (commit 6a15215, _parse_danish_amount).
      L2 — Sanity check: if the parsed amount is sub-1 DKK in a
           revenue context, treat as 'not found' so it doesn't
           overwrite a legitimate value. The downstream override-
           protection (max breakdown vs. OCR total) then preserves
           the right number.
    """
    for i, line in enumerate(lines):
        if re.search(keyword_pattern, line, re.IGNORECASE):
            # Try the same line first
            amount = _parse_danish_amount(line.split(re.search(keyword_pattern, line, re.IGNORECASE).group())[-1])
            if amount is not None and amount > 0 and not _is_implausibly_small(amount):
                return amount
            # Also try parsing the whole line after the keyword
            after_kw = re.split(keyword_pattern, line, flags=re.IGNORECASE)[-1]
            amount = _parse_danish_amount(after_kw)
            if amount is not None and amount > 0 and not _is_implausibly_small(amount):
                return amount
            # Try the next line
            if i + 1 < len(lines):
                amount = _parse_danish_amount(lines[i + 1])
                if amount is not None and amount > 0 and not _is_implausibly_small(amount):
                    return amount
    return None


def parse_z_report(image_path: str) -> dict:
    """Parse a Z-report / kasserapport image using OCR and extract structured fields.

    Returns dict with revenue breakdown, payment methods, tips, MOMS, and totals.
    """
    # Run OCR pipeline (same order as extract_amount_from_image)
    raw_text = _ocrspace_ocr(image_path)
    if not raw_text:
        raw_text = _google_vision_ocr(image_path)

    if not raw_text:
        return {
            "revenue": {"food": None, "drinks": None, "takeaway": None},
            "payments": {"cash": None, "card": None, "mobilepay": None},
            "tips": None,
            "moms_total": None,
            "revenue_total": None,
            "raw_text": "",
            "ocr_available": False,
            "confidence": "low",
        }

    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    # ── Revenue categories ──
    food = _find_amount_near_keyword(
        lines, r"(?:mad|food|spisning|køkken|kitchen)"
    )
    drinks = _find_amount_near_keyword(
        lines, r"(?:drikkevarer|drinks|bar|drikke|beverages)"
    )
    takeaway = _find_amount_near_keyword(
        lines, r"(?:takeaway|udbringning|take\s*away|delivery)"
    )

    # ── Payment methods ──
    cash = _find_amount_near_keyword(
        lines, r"(?:kontant|cash)"
    )
    card = _find_amount_near_keyword(
        lines, r"(?:dankort|kort|card|visa|mastercard|credit|debit)"
    )
    mobilepay = _find_amount_near_keyword(
        lines, r"(?:mobilepay|mobile\s*pay|swipp)"
    )

    # ── Tips ──
    tips = _find_amount_near_keyword(
        lines, r"(?:drikkepenge|tips?|gratuity)"
    )

    # ── MOMS / VAT ──
    moms_total = _find_amount_near_keyword(
        lines, r"(?:moms|vat|heraf\s*moms|moms\s*25\s*%)"
    )

    # ── Total revenue ──
    revenue_total = _find_amount_near_keyword(
        lines, r"(?:total|i\s*alt|sum|omsætning|omsaetning|grand\s*total)"
    )

    # ── Confidence calculation ──
    fields_found = sum(1 for v in [food, drinks, takeaway, cash, card, mobilepay, tips, moms_total, revenue_total] if v is not None)
    if fields_found >= 3:
        confidence = "high"
    elif fields_found >= 1:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "revenue": {
            "food": food,
            "drinks": drinks,
            "takeaway": takeaway,
        },
        "payments": {
            "cash": cash,
            "card": card,
            "mobilepay": mobilepay,
        },
        "tips": tips,
        "moms_total": moms_total,
        "revenue_total": revenue_total,
        "raw_text": raw_text[:1000],
        "ocr_available": True,
        "confidence": confidence,
    }


def extract_amount_from_image(image_path: str) -> dict:
    """Extract total amount from a receipt photo.

    Tries OCR.space first (fast, reliable, free 25,000/month).
    Falls back to Google Cloud Vision API (free 1,000/month).
    Returns manual entry mode if nothing works.
    """
    # Try OCR.space first (faster and more reliable currently)
    text = _ocrspace_ocr(image_path)
    if text:
        return _extract_amounts_from_text(text)

    # Fallback: Try Google Cloud Vision API
    text = _google_vision_ocr(image_path)
    if text:
        return _extract_amounts_from_text(text)

    # No OCR available — user enters amount manually
    return {
        "raw_text": "",
        "suggested_amount": None,
        "all_amounts_found": [],
        "ocr_available": False,
    }


# ─── Expense receipt parser ──────────────────────────────────────────
#
# Different from parse_z_report (kasserapport / Z-report from a POS) and
# from extract_amount_from_image (raw-amount-only fallback). This one is
# tuned for ad-hoc supplier receipts owners snap at the counter — a
# Nemlig.com bag, a Wolt invoice email, a Nordic Choice hotel receipt.
#
# We try to extract four fields the expense create form needs:
#   • vendor (string — top-of-receipt brand name)
#   • total amount (float — usually marked "Total" / "I alt" / "At betale")
#   • date (ISO YYYY-MM-DD)
#   • currency (defaults to DKK; flag others if OCR sees them)
#
# Each field returns None when uncertain — the frontend keeps the form
# editable so the owner sees what we parsed and can override.

# Heuristic stopwords that mean "not the vendor name" — these appear on
# every Danish receipt and would mislead the vendor picker.
_VENDOR_STOPWORDS = {
    "kvittering", "receipt", "faktura", "invoice", "bon", "tak",
    "thanks", "thank", "moms", "vat", "subtotal", "total", "i alt",
    "ialt", "at betale", "kontant", "dankort", "mobilepay", "card",
    "cash", "kvit", "ref", "ordre", "order", "kassebon", "kassenote",
    "salg", "sale", "betalt", "paid", "approved", "godkendt", "godkendt.",
    "kunde", "customer", "tid", "time", "dato", "date", "cvr", "cvr.",
    "tlf", "phone", "telephone", "email", "e-mail", "www", "http",
    "https", "merchant", "terminal", "auth", "approval", "exp",
    "valuta", "currency", "dkk", "eur", "usd", "kr", "krs", "kr.",
    "byttepenge", "change", "byt", "afrunding", "rounding",
}


def _extract_date(text: str) -> str | None:
    """Find the receipt date in OCR text. Returns ISO YYYY-MM-DD or None.

    Danish receipts use DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY. International
    POS sometimes prints MM/DD/YYYY. We pick the FIRST plausible match
    (most receipts print the date once, near the top).
    """
    if not text:
        return None
    # DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY  — most common in DK
    m = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b", text)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        try:
            day = int(d); month = int(mo); year = int(y)
            if year < 100:
                year += 2000
            # Guard against MM/DD/YYYY mis-parse — if first number is > 12 and
            # second is <= 12, we're already in DD/MM, perfect. If both are
            # ≤ 12 we can't tell — assume DD/MM since this is a Danish app.
            if day > 31 or month > 12 or day < 1 or month < 1:
                return None
            from datetime import date as _date
            d_obj = _date(year, month, day)
            # Don't allow obviously bad dates (>5 years in past, >1 day future)
            from datetime import timedelta
            today = _date.today()
            if d_obj > today + timedelta(days=1):
                return None
            if (today - d_obj).days > 365 * 5:
                return None
            return d_obj.isoformat()
        except (ValueError, TypeError):
            return None
    # ISO YYYY-MM-DD format
    m = re.search(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b", text)
    if m:
        try:
            from datetime import date as _date
            return _date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None
    return None


def _extract_vendor(text: str) -> str | None:
    """Guess the vendor name from a receipt's OCR text.

    Strategy: walk the first ~10 lines, pick the first one that looks
    like a brand name — at least 3 chars, mostly letters, not in the
    stopword set, not a date/amount/email/url.

    Tradeoff: this is a best-effort guess. Frontend shows the result
    as a pre-filled field the owner can edit before saving.
    """
    if not text:
        return None
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    for line in lines[:10]:
        # Skip lines that are mostly digits/punctuation (dates, amounts, IDs)
        letter_count = sum(c.isalpha() for c in line)
        if letter_count < 3:
            continue
        if letter_count / max(len(line), 1) < 0.5:
            continue
        lower = line.lower()
        # Skip clear non-vendor lines
        if any(sw in lower for sw in _VENDOR_STOPWORDS):
            continue
        # Skip URLs / emails / very long lines
        if "@" in line or "http" in lower or len(line) > 60:
            continue
        # Skip lines that are purely number-amount-currency
        if re.fullmatch(r"[\s\d.,kr\-]+", lower):
            continue
        # Clean up — strip trailing punctuation and trim to reasonable length
        clean = re.sub(r"\s+", " ", line).strip(" .,-:;|")
        if 3 <= len(clean) <= 50:
            return clean
    return None


def parse_expense_receipt(image_path: str) -> dict:
    """Parse a supplier/expense receipt photo into structured fields.

    Returns a dict with: vendor, amount, date (ISO), currency, raw_text,
    confidence ("high" | "medium" | "low" | "none"), ocr_available.

    All fields except `raw_text` may be None when OCR fails or the
    detector isn't confident — the frontend keeps the form editable so
    the owner sees what we found and corrects it before saving.

    Tradeoff vs parse_z_report: Z-reports have predictable headers
    (food / drinks / takeaway / payment-method totals) so we look for
    specific keywords. Supplier receipts are wild — different layouts
    per vendor, mixed languages, sometimes hand-stamped totals. We
    settle for "amount + date + best-guess vendor" and let the owner
    confirm.
    """
    raw_text = _ocrspace_ocr(image_path)
    if not raw_text:
        raw_text = _google_vision_ocr(image_path)

    if not raw_text:
        return {
            "vendor": None,
            "amount": None,
            "date": None,
            "currency": "DKK",
            "raw_text": "",
            "ocr_available": False,
            "confidence": "none",
        }

    # Use the existing amount extractor — it's already tuned for Danish
    # receipts (comma decimal, kr suffix, etc.) and picks the LARGEST
    # number that looks like a total.
    amounts_block = _extract_amounts_from_text(raw_text)
    amount = amounts_block.get("suggested_amount")

    vendor = _extract_vendor(raw_text)
    date_iso = _extract_date(raw_text)

    # Crude currency detection — if "EUR" or "€" appears on the receipt
    # we flag it so the frontend can warn before submitting a non-DKK
    # expense. Otherwise default DKK (covers 99% of Danish café receipts).
    upper = raw_text.upper()
    if "EUR" in upper or "€" in raw_text:
        currency = "EUR"
    elif "USD" in upper or "$" in raw_text:
        currency = "USD"
    elif "GBP" in upper or "£" in raw_text:
        currency = "GBP"
    else:
        currency = "DKK"

    # Confidence — how many of the 3 critical fields did we find?
    found = sum(1 for v in (vendor, amount, date_iso) if v is not None)
    if found >= 3:
        confidence = "high"
    elif found == 2:
        confidence = "medium"
    elif found == 1:
        confidence = "low"
    else:
        confidence = "none"

    return {
        "vendor": vendor,
        "amount": amount,
        "date": date_iso,
        "currency": currency,
        "raw_text": raw_text[:1000],
        "ocr_available": True,
        "confidence": confidence,
    }


def _upload_to_supabase(
    file_bytes: bytes,
    safe_name: str,
    user_id: str | None = None,
    kind: str = "expense",
) -> str | None:
    """Upload image to Supabase Storage and return a signed URL.

    Migrated in 2026-05 from anon-key + public bucket to service-key +
    private bucket (matches the kasserapport storage path). The bucket
    flip means the old `/object/public/...` URL pattern stops working;
    we now generate a 1-year signed URL so existing callers (which
    persist the URL string in DB.receipt_photo) keep working without
    schema changes.

    Returns:
      • Signed URL string when Supabase storage is configured and upload
        succeeds. Frontend uses it directly as <img src=...>.
      • None on failure / no service key — caller falls back to local
        path which still serves via /uploads/receipts/{filename}.
    """
    if not user_id:
        # Receipt has no owner scoping → don't upload to durable store
        # (would corrupt the per-user path invariant). Caller falls back
        # to local-disk save for OCR-only use.
        return None

    try:
        from app.services.storage import compose_key, get_storage
    except Exception as e:  # noqa: BLE001
        print(f"[Storage] storage module import failed: {e}")
        return None

    storage = get_storage()
    if not storage.is_durable:
        # Local backend — no point uploading to non-durable storage,
        # caller already wrote the local copy for OCR.
        return None

    sha = hashlib.sha256(file_bytes).hexdigest()
    try:
        key = compose_key(user_id, kind, sha, "jpg")
    except ValueError as e:
        print(f"[Storage] compose_key rejected inputs: {e}")
        return None

    try:
        storage.put(key, file_bytes, content_type="image/jpeg")
    except Exception as e:  # noqa: BLE001
        print(f"[Storage] Supabase upload error: {e}")
        return None

    # 1-year signed URL — covers the typical receipt-photo viewing
    # window without forcing a schema change. Bogføringsloven §10
    # 5-year retention is satisfied at the storage layer (the bytes
    # persist); the URL just needs occasional regeneration via a
    # follow-up endpoint we'll add when retention becomes a real query.
    one_year = 60 * 60 * 24 * 365
    signed = storage.signed_url(key, ttl_seconds=one_year)
    if signed:
        print(f"[Storage] Uploaded receipt to Supabase: {key}")
        return signed
    # Upload succeeded but signing failed → return the storage key as
    # a fallback marker. Callers store it in receipt_photo; until the
    # backend-proxy endpoint lands, the UI shows a placeholder.
    return key


def save_receipt_photo(
    file_bytes: bytes,
    filename: str,
    user_id: str,
    kind: str = "expense",
) -> str:
    """
    Save uploaded receipt photo. Uploads to Supabase Storage for persistence,
    falls back to local disk for OCR processing.

    `kind` controls the storage path namespace (one of ALLOWED_KINDS in
    services/storage.py). Use:
      • "expense"      — receipts attached to /api/expenses
      • "sale"         — receipts attached to /api/sales (POS receipts)
      • "kasserapport" — Z-report / daily-close photos
    The path becomes `<user_id>/<kind>/<sha>.jpg` so admin browsing of
    the bucket stays organized + retention-policy queries are easy.

    Security: previously the PIL-failure fallback silently persisted RAW
    bytes — meaning a corrupt-image payload (e.g. a renamed script) would
    land on disk verbatim. Even though the upload endpoint validates
    content_type, an attacker can spoof headers. Now we re-raise a
    ValueError on PIL failure so the upload fails fast with 400 instead
    of leaving an arbitrary file.

    Filename uses UUID4 + timestamp so two uploads from the same user
    in the same second don't collide (was: user_id + epoch seconds).
    """
    import time
    import uuid as _uuid

    # Convert to JPEG for compatibility — prevents storing arbitrary content
    safe_name = f"{user_id}_{int(time.time())}_{_uuid.uuid4().hex[:8]}.jpg"

    # Always save locally first (needed for OCR processing). PIL must succeed
    # — its failure means the upload isn't a real image.
    filepath = UPLOAD_DIR / safe_name
    try:
        img = Image.open(io.BytesIO(file_bytes))
        img.verify()  # PIL signature check before re-opening for save
    except Exception as e:
        raise ValueError(f"Uploaded file is not a valid image ({e})")

    try:
        img = Image.open(io.BytesIO(file_bytes))  # re-open after verify()
        img = img.convert("RGB")
        img.save(filepath, "JPEG", quality=85)
        jpeg_bytes = filepath.read_bytes()
    except Exception as e:
        raise ValueError(f"Could not process image ({e})")

    # Upload to durable storage (Supabase) for persistent display.
    # Per-user scoping enforced via compose_key inside _upload_to_supabase.
    public_url = _upload_to_supabase(jpeg_bytes, safe_name, user_id=user_id, kind=kind)
    if public_url:
        return public_url

    # Fallback: return local path. Render free/starter tiers wipe local
    # disk on redeploy, so this is dev-only durable. Production with
    # SUPABASE_SERVICE_KEY set will always go through the path above.
    return str(filepath)
