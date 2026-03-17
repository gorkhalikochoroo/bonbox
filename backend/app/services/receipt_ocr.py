import re
import os
from pathlib import Path

from PIL import Image

UPLOAD_DIR = Path("uploads/receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def extract_amount_from_image(image_path: str) -> dict:
    """Try to extract total amount from a receipt photo using OCR.

    Falls back gracefully if Tesseract is not installed (e.g. on Render free tier).
    The receipt photo is still saved — user just enters the amount manually.
    """
    try:
        import pytesseract
        img = Image.open(image_path)

        # Preprocess for better OCR accuracy
        img = img.convert("L")  # Grayscale

        # Try Danish + English OCR
        try:
            text = pytesseract.image_to_string(img, lang="dan+eng")
        except Exception:
            text = pytesseract.image_to_string(img)

        amounts = []

        # Patterns for Danish receipts (comma as decimal separator)
        patterns = [
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]+(?:\.[0-9]{2})?)",
            r"([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\s*(?:DKK|kr\.?)",
            r"(?:DKK|kr\.?)\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
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
                            cleaned = cleaned.replace(".", "").replace(",", ".")
                        else:
                            cleaned = cleaned.replace(",", "")
                    elif "," in cleaned:
                        cleaned = cleaned.replace(",", ".")
                    else:
                        cleaned = cleaned.replace(" ", "")

                    val = float(cleaned)
                    if val > 0:
                        amounts.append(val)
                except ValueError:
                    continue

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
    except (ImportError, Exception):
        # Tesseract not installed or other error — graceful fallback
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
