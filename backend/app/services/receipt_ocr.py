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
    """Parse a Danish-format amount string like '1.234,50' or '1234,50' to float."""
    # Match Danish amounts: optional thousands separator (dot), comma decimal
    m = re.search(r"([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})", text)
    if m:
        raw = m.group(1)
        return float(raw.replace(".", "").replace(",", "."))
    # Try plain integer or simple decimal
    m = re.search(r"([0-9]+(?:,[0-9]{2})?)", text)
    if m:
        raw = m.group(1)
        return float(raw.replace(",", "."))
    # Try English-format as fallback
    m = re.search(r"([0-9]+(?:\.[0-9]{2})?)", text)
    if m:
        return float(m.group(1))
    return None


def _find_amount_near_keyword(lines: list[str], keyword_pattern: str) -> float | None:
    """Search lines for a keyword and extract the amount on that line or the next."""
    for i, line in enumerate(lines):
        if re.search(keyword_pattern, line, re.IGNORECASE):
            # Try the same line first
            amount = _parse_danish_amount(line.split(re.search(keyword_pattern, line, re.IGNORECASE).group())[-1])
            if amount is not None and amount > 0:
                return amount
            # Also try parsing the whole line after the keyword
            after_kw = re.split(keyword_pattern, line, flags=re.IGNORECASE)[-1]
            amount = _parse_danish_amount(after_kw)
            if amount is not None and amount > 0:
                return amount
            # Try the next line
            if i + 1 < len(lines):
                amount = _parse_danish_amount(lines[i + 1])
                if amount is not None and amount > 0:
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


def _upload_to_supabase(file_bytes: bytes, safe_name: str) -> str | None:
    """Upload image to Supabase Storage and return public URL."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    supabase_key = os.environ.get("SUPABASE_ANON_KEY", "")

    if not supabase_url or not supabase_key:
        print("[Storage] No Supabase credentials set")
        return None

    upload_url = f"{supabase_url}/storage/v1/object/receipts/{safe_name}"
    req = Request(
        upload_url,
        data=file_bytes,
        headers={
            "Authorization": f"Bearer {supabase_key}",
            "apikey": supabase_key,
            "Content-Type": "image/jpeg",
            "x-upsert": "true",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as resp:
            resp.read()
            public_url = f"{supabase_url}/storage/v1/object/public/receipts/{safe_name}"
            print(f"[Storage] Uploaded to Supabase: {safe_name}")
            return public_url
    except Exception as e:
        print(f"[Storage] Supabase upload error: {e}")
        if hasattr(e, 'read'):
            try:
                print(f"[Storage] Error details: {e.read().decode()[:300]}")
            except Exception:
                pass
        return None


def save_receipt_photo(file_bytes: bytes, filename: str, user_id: str) -> str:
    """
    Save uploaded receipt photo. Uploads to Supabase Storage for persistence,
    falls back to local disk for OCR processing.

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

    # Upload to Supabase Storage for persistent display
    public_url = _upload_to_supabase(jpeg_bytes, safe_name)
    if public_url:
        return public_url

    # Fallback: return local path
    return str(filepath)
