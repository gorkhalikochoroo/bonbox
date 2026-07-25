"""What the owner has used of what their plan allows.

ONE RULE: the number shown on screen must be the number that stops them.

The obvious way to build a usage panel is to write a query per cap that
counts "roughly the same thing" the gate counts. That is how a screen
ends up saying "3 of 10 scans" while the gate returns 402 — because the
gate counts abandoned drafts and the screen doesn't, or one was changed
and the other wasn't. The owner is then looking at a number the product
itself disagrees with.

So this registry does not count anything. Each entry POINTS AT the
function the gate already calls. Change how a cap is enforced and the
panel follows automatically, because there is only one function.

THIS PANEL IS NOT EVERY CAP, AND MUST NOT CLAIM TO BE
Roughly a dozen consumable caps are enforced across the app
(ai_chat_messages_per_day, sale_parse_per_day, smart_imports_per_day,
published_events_per_month, invoices_per_month...). Each computes its
count inline at the gate, so listing it here means extracting a helper
and changing a live gate — worth doing, one at a time, with the gate's
own tests. Until then the panel names what it covers rather than
implying it covers everything: an owner who reads "your plan usage",
sees six green rows, and then hits a 402 on message 11 has been misled
by omission.

WHAT IS DELIBERATELY NOT LISTED
Only caps whose usage we can honestly measure appear here. Three caps in
PLAN_CAPS are defined but enforced nowhere at all
(billetto_imports_per_month, events_per_month,
foreign_currency_expenses_per_month). Showing "1 of 2 used" for a limit
that does not exist would be a fabricated constraint — worse than
silence, because the owner might pay to lift it. They stay off the panel
until something enforces them.

Caps that are structural rather than consumable (branches, modules,
daily_close_export_days) are also out: "1 of 1 branches" is a fact about
the plan, not usage, and belongs on a pricing page.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.billing import get_cap

# How the window is described to the owner. The gate's period IS the
# period — a monthly cap that resets on the 1st must not be described as
# "last 30 days", or the owner plans around the wrong reset.
PERIOD_MONTH = "month"
PERIOD_DAY = "day"
PERIOD_TOTAL = "total"      # a live count, not a window (e.g. seats in use)


@dataclass(frozen=True)
class UsageMeter:
    cap_key: str
    label_key: str                      # i18n key, never a baked string
    period: str
    counter: Callable[[Session, User], int]
    # True when the counter is a documented PROXY rather than an exact
    # ledger. Surfaced to the UI so the panel can avoid implying a
    # precision it does not have.
    approximate: bool = False


def _receipt_scans(db: Session, user: User) -> int:
    from app.routers.expenses import _count_receipt_scans_this_month
    return _count_receipt_scans_this_month(db, user.id)


def _kasse_extracts(db: Session, user: User) -> int:
    from app.routers.kasserapport import _today_count
    return _today_count(db, user)


def _smart_scan_classifies(db: Session, user: User) -> int:
    from app.routers.smart_scan import _today_classify_count
    return _today_classify_count(db, user)


def _moms_pdf_exports(db: Session, user: User) -> int:
    from app.routers.reports import _count_moms_pdf_exports_this_month
    return _count_moms_pdf_exports_this_month(db, user.id)


def _inbox_messages(db: Session, user: User) -> int:
    from app.services.inbox_service import count_messages_this_month
    return count_messages_this_month(db, user.id)


def _active_staff(db: Session, user: User) -> int:
    from app.routers.staff import count_active_staff
    return count_active_staff(db, user.id)


# Ordered as the owner meets them: what they scan daily, then what they
# file monthly, then the roster. Not alphabetical — the panel reads top
# to bottom and the first row should be the one they actually use.
METERS: tuple[UsageMeter, ...] = (
    UsageMeter(
        "expense_receipt_scans_per_month", "usageReceiptScans", PERIOD_MONTH,
        _receipt_scans,
        # Counts expenses whose receipt_photo was set this month, so a
        # scan the owner abandoned before saving is not counted. It
        # under-counts, which is the owner-friendly direction, but it is
        # still an estimate and the panel says so.
        approximate=True,
    ),
    UsageMeter("kasse_extracts_per_day", "usageKasseExtracts", PERIOD_DAY, _kasse_extracts),
    UsageMeter(
        "smart_scan_classify_per_day", "usageSmartScans", PERIOD_DAY,
        _smart_scan_classifies,
    ),
    UsageMeter(
        "moms_pdf_exports_per_month", "usageMomsExports", PERIOD_MONTH, _moms_pdf_exports,
    ),
    UsageMeter(
        "inbox_messages_per_month", "usageInboxMessages", PERIOD_MONTH, _inbox_messages,
    ),
    UsageMeter("staff_members", "usageStaffMembers", PERIOD_TOTAL, _active_staff),
)


def build_usage(db: Session, user: User) -> list[dict]:
    """Every measurable meter for this owner, with its real cap.

    A counter that raises is reported as `used: None` rather than 0. A
    zero the owner cannot distinguish from "we could not read it" is the
    same dishonesty in a smaller font.
    """
    out: list[dict] = []
    for meter in METERS:
        cap = get_cap(user, meter.cap_key)
        try:
            used = int(meter.counter(db, user))
        except Exception:  # noqa: BLE001 — a broken meter must not 500 the page
            used = None
            # On Postgres a failed statement aborts the transaction, so
            # without this every LATER meter would also fail and the whole
            # panel would read "—". One broken counter must cost one row.
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass

        unlimited = cap is not None and cap < 0
        out.append({
            "key": meter.cap_key,
            "label_key": meter.label_key,
            "period": meter.period,
            "used": used,
            # -1 means unlimited on this tier. Sent as null with the flag
            # set, so a client can never render a progress bar against a
            # negative denominator.
            "cap": None if (cap is None or cap < 0) else cap,
            "unlimited": unlimited,
            "approximate": meter.approximate,
            # 0 caps mean "not on this plan at all" — that is a locked
            # feature, not usage at 0%, and the UI must say so.
            "locked": cap == 0,
        })
    return out
