import re
import os
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

UPLOAD_DIR = Path("uploads/receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def extract_amount_from_image(image_path: str) -> dict:
    """Try to extract total amount from a receipt photo using OCR."""
    try:
        import pytesseract
        img = Image.open(image_path)

        # Preprocess for better OCR accuracy
        img = img.convert("L")  # Grayscale
        img = img.filter(ImageFilter.SHARPEN)  # Sharpen text
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(2.0)  # Increase contrast

        # Try Danish + English OCR
        try:
            text = pytesseract.image_to_string(img, lang="dan+eng")
        except Exception:
            text = pytesseract.image_to_string(img)

        amounts = []

        # Patterns for Danish receipts (comma as decimal separator)
        patterns = [
            # "I alt: 1.234,56" or "Total: 1234,56" or "SUM: 456,00"
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt|beløb|betalt|at\s*betale)[:\s]*(?:DKK|kr\.?\s*)?([0-9]+(?:\.[0-9]{2})?)",
            # "1.234,56 DKK" or "456,00 kr"
            r"([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\s*(?:DKK|kr\.?)",
            r"(?:DKK|kr\.?)\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})",
            # English format: "Total: 1,234.56" or "1234.56 DKK"
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt)[:\s]*[DKK\s]*([0-9.,]+)",
            r"([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:DKK|kr|dkk)",
            r"(?:DKK|kr)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)",
        ]

        for pattern in patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                try:
                    # Handle Danish format: 1.234,56 → 1234.56
                    cleaned = match.strip()
                    if "," in cleaned and "." in cleaned:
                        # Could be Danish (1.234,56) or English (1,234.56)
                        if cleaned.index(",") > cleaned.index("."):
                            # Danish: dots are thousands, comma is decimal
                            cleaned = cleaned.replace(".", "").replace(",", ".")
                        else:
                            # English: commas are thousands, dot is decimal
                            cleaned = cleaned.replace(",", "")
                    elif "," in cleaned:
                        # Danish: comma is decimal (456,50 → 456.50)
                        cleaned = cleaned.replace(",", ".")
                    else:
                        cleaned = cleaned.replace(" ", "")

                    val = float(cleaned)
                    if val > 0:
                        amounts.append(val)
                except ValueError:
                    continue

        # Also grab all standalone numbers as fallback
        # Match both "123.45" and "123,45" formats
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

        # Pick the largest "total-like" amount, or largest number
        suggested_amount = max(amounts) if amounts else (max(all_numbers) if all_numbers else None)

        return {
            "raw_text": text[:500],
            "suggested_amount": suggested_amount,
            "all_amounts_found": sorted(set(amounts + all_numbers), reverse=True)[:5],
            "ocr_available": True,
        }
    except ImportError:
        return {
            "raw_text": "",
            "suggested_amount": None,
            "all_amounts_found": [],
            "ocr_available": False,
        }
    except Exception as e:
        return {
            "raw_text": str(e),
            "suggested_amount": None,
            "all_amounts_found": [],
            "ocr_available": True,
        }


def save_receipt_photo(file_bytes: bytes, filename: str, user_id: str) -> str:
    """Save uploaded receipt photo and return the file path."""
    ext = Path(filename).suffix or ".jpg"
    safe_name = f"{user_id}_{int(__import__('time').time())}{ext}"
    filepath = UPLOAD_DIR / safe_name
    filepath.write_bytes(file_bytes)
    return str(filepath)
