import uuid
import datetime
from pydantic import BaseModel, field_validator

# Upper bound for a stored receipt URL. Sized for a Supabase 1-year signed
# URL (597 chars today) with headroom for a longer bucket path or token,
# NOT for the old VARCHAR(500) that no longer exists in the database.
RECEIPT_PHOTO_MAX_LEN = 2000


class ExpenseCategoryCreate(BaseModel):
    name: str
    color: str = "#3B82F6"


class ExpenseCategoryResponse(BaseModel):
    id: uuid.UUID
    name: str
    color: str

    model_config = {"from_attributes": True}


class ExpenseCreate(BaseModel):
    # Optional on purpose. The receipt-scan flow only knows a category
    # when the vendor→category guess hits; when it misses, the owner
    # still has a real amount + date + photo in front of them and the
    # expense MUST save. The router files an uncategorised scan under
    # the "Andet" fallback rather than 422-ing the save away.
    category_id: uuid.UUID | None = None
    date: datetime.date
    amount: float
    description: str
    is_recurring: bool = False
    # No default. This used to be "card", which meant every caller that
    # didn't ask the owner how a purchase was paid booked it as card —
    # and sync_cash_out_for_expense only fires on "cash", so a cash
    # purchase never left the drawer in the books and kassebeholdning
    # drifted up by its amount. A method nobody chose is not data; the
    # honest value is NULL, exactly as the scan paths already store it
    # when the receipt doesn't say (#139, #146). Every UI that posts an
    # expense asks for the method; the ones that legitimately can't
    # (personal quick entries) leave it unknown rather than inventing
    # one. ExpenseResponse and the DB column have always been nullable.
    payment_method: str | None = None
    notes: str | None = None
    is_personal: bool = False
    is_tax_exempt: bool = False
    # Optional receipt photo path returned by /expenses/upload-receipt.
    # When set, the expense row carries the URL so the user can re-view
    # the receipt after save (matches Sale.receipt_photo behaviour).
    # Bounded by RECEIPT_PHOTO_MAX_LEN (see above).
    receipt_photo: str | None = None
    # ── Foreign-currency capture (migration 014) ──────────────────────
    # All three are nullable. The router enforces the all-or-nothing
    # rule (if currency is non-null and differs from the user's account
    # currency, fx_rate and original_amount must also be populated).
    # `amount` above remains in the user's account currency so MOMS
    # math and dashboards stay correct.
    currency: str | None = None
    fx_rate: float | None = None
    original_amount: float | None = None
    # ── Per-vendor memory ─────────────────────────────────────────────
    # The OCR's raw vendor line. Kept separate from `description` because
    # description is owner-editable free text — keying memory on it is
    # what made the existing learn/suggest loop write and read different
    # names. Never persisted as-is; it is canonicalised into vendor_key.
    vendor_hint: str | None = None
    # What BonBox PROPOSED before the owner touched anything, e.g.
    # {"payment_method": "card", "category_name": "Vareforbrug"}. Lets
    # the server tell a confirmation from an override: saving a value
    # different from what we proposed is a CORRECTION, and recording it
    # as agreement is how a wrong habit cements itself.
    autofill: dict[str, str] | None = None
    # "Yes, I really did buy the same thing twice just now." Set by the
    # UI after the owner confirms a flagged repeat, so a false positive
    # can never cost them an expense — the replay guard is a convenience,
    # never a wall.
    allow_duplicate: bool = False
    # ── The receipt's own MOMS ────────────────────────────────────────
    # Sent only when the OCR read it off the paper. Stored for the
    # cross-check against what the filing derives — never used as the
    # filing basis without the owner's revisor deciding that.
    vat_amount: float | None = None
    vat_rate: float | None = None

    @field_validator("vat_amount", mode="before")
    @classmethod
    def validate_vat_amount(cls, v):
        if v is None or v == "":
            return None
        try:
            av = float(v)
        except (TypeError, ValueError):
            raise ValueError("vat_amount must be a number")
        if av < 0:
            raise ValueError("vat_amount must be non-negative")
        return av

    @field_validator("vat_rate", mode="before")
    @classmethod
    def validate_vat_rate(cls, v):
        if v is None or v == "":
            return None
        try:
            rv = float(v)
        except (TypeError, ValueError):
            raise ValueError("vat_rate must be a number")
        # A DECIMAL rate (0.25), never a percentage. Anything above 1
        # is a unit mix-up, and silently accepting 25 would store a
        # 2500% rate against a bilag.
        if not 0 <= rv <= 1:
            raise ValueError("vat_rate must be a decimal between 0 and 1")
        return rv

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v

    @field_validator("receipt_photo", mode="before")
    @classmethod
    def cap_receipt_photo_length(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, str) and len(v) > RECEIPT_PHOTO_MAX_LEN:
            # Still bounded — this is request input — but the old 500-char
            # limit was based on a column width that isn't real: the
            # expenses.receipt_photo column is TEXT in production.
            #
            # Storage moved to a private bucket in 2026-05 and now hands
            # back a 1-YEAR SIGNED URL carrying a JWT. Every one of those
            # measures 597 chars, so this validator rejected literally
            # every scanned receipt: the upload succeeded, the owner saw
            # the photo and the amount, and then POST /expenses 422'd. It
            # was invisible because a 422 `detail` is a LIST, so the
            # frontend's string-only error path fell through to a generic
            # "couldn't save" with nothing to act on.
            raise ValueError(
                f"receipt_photo path too long (max {RECEIPT_PHOTO_MAX_LEN} chars)"
            )
        return v

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, v):
        # ISO 4217 = 3 letters, uppercase. Empty string => null
        # (frontend sends "" when the toggle is closed).
        if v is None or v == "":
            return None
        if not isinstance(v, str):
            raise ValueError("currency must be an ISO 4217 string")
        v = v.strip().upper()
        if len(v) != 3 or not v.isalpha():
            raise ValueError("currency must be a 3-letter ISO 4217 code")
        return v

    @field_validator("fx_rate", mode="before")
    @classmethod
    def validate_fx_rate(cls, v):
        if v is None or v == "":
            return None
        try:
            rv = float(v)
        except (TypeError, ValueError):
            raise ValueError("fx_rate must be a number")
        # Reject obviously bogus rates. 0.0001 ≤ rate ≤ 100000 covers
        # every realistic ISO 4217 pair (DKK-NPR ≈ 0.05, DKK-IDR ≈ 0.0004
        # if anyone ever needs it, NPR-DKK ≈ 16, IDR-DKK ≈ 2500).
        if rv <= 0 or rv > 100000:
            raise ValueError("fx_rate out of plausible range")
        return rv

    @field_validator("original_amount", mode="before")
    @classmethod
    def validate_original_amount(cls, v):
        if v is None or v == "":
            return None
        try:
            ov = float(v)
        except (TypeError, ValueError):
            raise ValueError("original_amount must be a number")
        if ov < 0:
            raise ValueError("original_amount must be non-negative")
        return ov


class ExpenseUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    date: datetime.date | None = None
    amount: float | None = None
    description: str | None = None
    is_recurring: bool | None = None
    payment_method: str | None = None
    notes: str | None = None
    is_personal: bool | None = None
    is_tax_exempt: bool | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v


class ExpenseResponse(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    date: datetime.date
    amount: float
    description: str
    is_recurring: bool
    payment_method: str | None
    notes: str | None
    is_personal: bool = False
    is_tax_exempt: bool = False
    receipt_photo: str | None = None
    # ── Foreign-currency capture (migration 014) ──────────────────────
    # All three are null for single-currency entries — backward compat.
    currency: str | None = None
    fx_rate: float | None = None
    original_amount: float | None = None
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None
    # Godkend-kø: 'approved' = booked; 'pending' = unapproved draft (excluded
    # from every money total until the owner approves). NULL/legacy → approved.
    status: str | None = None

    model_config = {"from_attributes": True}


class ExpenseApproveBatch(BaseModel):
    """Bulk-approve request — the ids the owner tapped 'Godkend alle klar' on."""
    ids: list[str]
