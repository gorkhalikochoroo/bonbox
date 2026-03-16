import re
import os
from pathlib import Path

from PIL import Image

UPLOAD_DIR = Path("uploads/receipts")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def extract_amount_from_image(image_path: str) -> dict:
    """Try to extract total amount from a receipt photo using OCR."""
    try:
        import pytesseract
        img = Image.open(image_path)

        # Preprocess: convert to grayscale for better OCR
        img = img.convert("L")

        text = pytesseract.image_to_string(img)

        # Look for common total patterns in receipt text
        amounts = []

        # Pattern: "Total: 1,234.56" or "TOTAL 1234.56" or "Sum: 5000"
        patterns = [
            r"(?:total|sum|amount|subtotal|grand\s*total|i\s*alt)[:\s]*[DKK\s]*([0-9.,]+)",
            r"([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2})?)\s*(?:DKK|kr|dkk)",
            r"(?:DKK|kr)\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2})?)",
        ]

        for pattern in patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                cleaned = match.replace(",", "").replace(" ", "")
                try:
                    val = float(cleaned)
                    if val > 0:
                        amounts.append(val)
                except ValueError:
                    continue

        # Also grab all standalone numbers as fallback
        all_numbers = re.findall(r"\b(\d{2,6}(?:\.\d{1,2})?)\b", text)
        all_numbers = [float(n) for n in all_numbers if float(n) > 10]

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
