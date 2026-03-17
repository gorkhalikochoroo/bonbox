import re
import os
import base64
import json
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

UPLOAD_DIR = Path("uploads/receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _google_vision_ocr(image_path: str) -> str:
    """Use Google Cloud Vision API for OCR (free 1,000 images/month)."""
    api_key = os.environ.get("GOOGLE_VISION_API_KEY", "")
    if not api_key:
        return ""

    # Read and base64 encode the image
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

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
        with urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            annotations = result.get("responses", [{}])[0].get("textAnnotations", [])
            if annotations:
                return annotations[0].get("description", "")
    except Exception as e:
        print(f"Google Vision OCR error: {e}")

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


def extract_amount_from_image(image_path: str) -> dict:
    """Extract total amount from a receipt photo.

    Tries Google Cloud Vision API first (best accuracy, free 1,000/month).
    Falls back to Tesseract if available.
    Returns manual entry mode if neither works.
    """
    # Try Google Cloud Vision API first
    text = _google_vision_ocr(image_path)
    if text:
        return _extract_amounts_from_text(text)

    # Fallback: Try Tesseract if installed locally
    try:
        import pytesseract
        img = Image.open(image_path)
        img = img.convert("L")
        try:
            text = pytesseract.image_to_string(img, lang="dan+eng")
        except Exception:
            text = pytesseract.image_to_string(img)

        if text.strip():
            return _extract_amounts_from_text(text)
    except (ImportError, Exception):
        pass

    # No OCR available — user enters amount manually
    return {
        "raw_text": "",
        "suggested_amount": None,
        "all_amounts_found": [],
        "ocr_available": False,
    }


def save_receipt_photo(file_bytes: bytes, filename: str, user_id: str) -> str:
    """Save uploaded receipt photo and return the file path."""
    ext = Path(filename).suffix or ".jpg"
    safe_name = f"{user_id}_{int(__import__('time').time())}{ext}"
    filepath = UPLOAD_DIR / safe_name
    filepath.write_bytes(file_bytes)
    return str(filepath)
