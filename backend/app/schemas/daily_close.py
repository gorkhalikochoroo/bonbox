"""Pydantic schemas for Daily Close (Kasserapport)."""

import uuid
import datetime
from pydantic import BaseModel, Field

# Length limits for the informational text on a close. The router cuts to
# these (it never refuses); the close form's inputs carry the same maxLength.
CLOSED_BY_MAX = 80
NOTES_MAX = 4000


class DailyCloseCreate(BaseModel):
    date: datetime.date
    branch_id: uuid.UUID | None = None
    status: str = "confirmed"               # "draft" (auto-save) | "confirmed" (final submit)
    revenue_breakdown: dict | None = None   # {"food": 12400, "drinks": 5800, ...}
    payment_breakdown: dict | None = None   # {"cash": 4200, "card": 13500, ...}
    # Override for the breakdown-sum. Set when the OCR detected only the
    # bottom-line total but couldn't split into food/drinks/takeaway.
    # The router uses this when revenue_breakdown is empty so the close
    # still saves the real revenue (instead of the previous 0 DKK bug).
    revenue_total_override: float | None = Field(None, ge=0, le=1_000_000_000)
    # True when the OWNER typed the total (corrected the scanned figure). Then
    # it is the day's revenue exactly — max(breakdown, override) is for the
    # OCR case only, and it ignored a correction downward.
    revenue_total_owner_set: bool = False
    moms_total: float | None = None         # VAT amount — auto-calculated or from receipt
    moms_mode: str | None = None            # "auto" | "manual"
    # Per-close override for the user's prices_include_moms preference.
    # Set when the OCR scan UI offered a "with MOMS / without MOMS" toggle
    # and the owner picked one. Lets B2C (gross input) and B2B (net
    # input) modes coexist on the same account day-by-day.
    prices_include_moms_override: bool | None = None
    tips_total: float | None = None
    tips_staff_count: int | None = None
    cash_counted: float | None = None
    # Free text; a Z-report scan also appends to it. Cut to NOTES_MAX by the
    # router (_clip_text), never refused — informational text must not 422 a
    # lock (an offline-queued lock would be dead-lettered over a long note).
    notes: str | None = None
    # A first name, typed by staff, printed on the kasserapport and put into
    # the revisor's mail. Cut to CLOSED_BY_MAX by the router, same rule.
    closed_by: str | None = None
    # Z-report photo URL — set when the owner used "Snap report" in the
    # close flow. Backend persists it on DailyClose.receipt_photo so
    # the photo can be re-viewed later. 2000-char cap is well above
    # signed-URL length (~700) but keeps payload bombs out.
    receipt_photo: str | None = Field(None, max_length=2000)
    # Detective control acknowledgement. Default False → the router runs
    # the close_sanity anomaly check before committing a *confirmed* close
    # and, if today's total is far off the recent same-weekday baseline,
    # returns {requires_confirmation: true} WITHOUT saving so the frontend
    # can show a soft "double-check" dialog. The owner either fixes the
    # numbers or re-submits with this set True to skip the guard and lock.
    acknowledge_anomaly: bool = False
    # The byttepenge the form took off the drawer count (counted = drawer −
    # float). Printed on the kasserapport so "Optalt (uden byttepenge)" can be
    # checked. None = not sent (older clients) — the row keeps what it had.
    # No bounds here on purpose: an out-of-range float is dropped by the router
    # (_clean_cash_float). An informational number must never 422 a lock.
    cash_float: float | None = None
    # Where the figures came from — see DailyClose.source_meta. A small dict;
    # the router keeps only the known keys and bounds them.
    source_meta: dict | None = None
    # The day's MOMS-free sales the page took off the taxable base. Read only
    # to tell the page's own auto MOMS from a stale one (see the router); not
    # stored. No bounds — an informational number must never 422 a lock.
    exempt_sales_total: float | None = None
    # The version of the stored draft this save was built on: the updated_at
    # the page last read for the day (opened, or answered by its own save).
    # A live draft stored LATER than this was changed elsewhere since, and is
    # not overwritten: 412 with detail.code "draft_changed" (round 21). None —
    # an older app build — saves as before. A date-time far in the past says
    # "the page knew of no row for this day".
    base_updated_at: datetime.datetime | None = None
    # The page's own id for this save (kept on its audit row), and — a save
    # sent while the page was going away, with another of its saves still on
    # its way — that save's id: the version that save wrote is the page's own
    # and does not refuse this one. Anyone else's version still does.
    save_id: str | None = Field(None, max_length=64)
    base_save_id: str | None = Field(None, max_length=64)


class DailyCloseUnlock(BaseModel):
    reason: str                             # required — "Accountant found error", etc.


class DailyCloseResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    branch_id: uuid.UUID | None = None
    revenue_breakdown: dict | None = None
    revenue_total: float
    payment_breakdown: dict | None = None
    payment_total: float
    moms_total: float | None = None
    revenue_ex_moms: float | None = None
    moms_mode: str | None = None
    cash_expected: float | None = None
    cash_counted: float | None = None
    cash_difference: float | None = None
    tips_total: float | None = None
    tips_staff_count: int | None = None
    tips_per_person: float | None = None
    status: str = "confirmed"
    notes: str | None = None
    closed_by: str | None = None
    closed_at: datetime.datetime | None = None
    unlock_reason: str | None = None
    unlocked_by: str | None = None
    unlocked_at: datetime.datetime | None = None
    is_deleted: bool = False
    created_at: datetime.datetime | None = None
    receipt_photo: str | None = None

    model_config = {"from_attributes": True}
