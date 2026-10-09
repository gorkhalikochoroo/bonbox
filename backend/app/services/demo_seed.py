"""Demo account seeder — populates demo@bonbox.dk with realistic data.

Goal: a salesperson, investor, or curious owner who logs into
demo@bonbox.dk sees a fully-populated, believable Danish restaurant
("Mirabelle ApS, Vesterbro, København") instead of an empty app.

What gets seeded:
  • BusinessProfile — fully verified (CVR + accountant + DAWA stamp)
  • 30 days of DailyClose with realistic weekday/weekend patterns
  • ~24 inventory items mixing the canonical Danish brands
  • ~12 expenses across the past 14 days
  • A sample smart-import history entry
  • One unlocked draft close so the Edit flow is demoable

Idempotency:
  • Seeds only if demo user exists AND has zero DailyClose rows
  • Day-2 startups skip silently (closes exist → don't touch)
  • A dedicated reset_demo_account() wipes + re-seeds for staging
    refresh; not invoked on automatic startup

Realism rules:
  • Mon = slow (≈14k DKK), Tue/Wed = medium, Thu = solid, Fri/Sat
    = peak (≈28k+), Sun = medium
  • Payment mix: ~58% card, ~28% cash, ~12% mobilepay, 2% gift card
  • Revenue mix: ~62% food, ~28% drinks, ~10% takeaway
  • MOMS auto-calc'd at DK 25% (gross input mode)
  • Cash variance: most days ±0-50 DKK, one day −180 DKK to make the
    insights "Cash short streak" alert demoable
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.bookable_resource import BookableResource
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.sale import Sale
from app.models.user import User
from app.services.tz_utils import business_today_local
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


_DEMO_EMAIL = "demo@bonbox.dk"

# Deterministic seed so the demo data is consistent across deploys.
# Same date inputs → same numbers → reliable for screen recordings
# and customer demos.
_RNG = random.Random(42)


# ─── Day-of-week revenue model ────────────────────────────────────────
#
# Tuple of (food_base, drinks_base, takeaway_base) per weekday.
# Real distribution drawn from anonymized DK restaurant data Manoj has
# referenced — Friday/Saturday roughly 2x Monday/Sunday on the food
# axis. Drinks scale slightly more aggressively on weekends.
#
# Index 0 = Monday (Python date.weekday()).
_REV_BY_DOW = [
    (8500,  3200,  900),   # Mon
    (10200, 4100,  1100),  # Tue
    (11800, 4800,  1300),  # Wed
    (13500, 5800,  1600),  # Thu
    (16800, 8400,  2200),  # Fri
    (18200, 9900,  2500),  # Sat
    (12400, 5200,  1800),  # Sun
]


def _close_for_day(d: date, *, force_draft: bool, with_short_cash: bool) -> dict:
    """Build a believable close payload for the given date.

    Returns a dict ready for splat into DailyClose(**…).
    Currency is DKK; MOMS = 25% extracted from gross.
    """
    food_base, drinks_base, take_base = _REV_BY_DOW[d.weekday()]
    # Add ±10% jitter to avoid suspiciously identical weeks
    jitter = lambda x: int(x * _RNG.uniform(0.90, 1.10))
    food = jitter(food_base)
    drinks = jitter(drinks_base)
    takeaway = jitter(take_base)
    revenue = food + drinks + takeaway

    moms_total = round(revenue * 0.25 / 1.25, 2)  # 25% gross extract
    revenue_ex_moms = round(revenue - moms_total, 2)

    # Payment split: ~58% card / ~28% cash / ~12% mobilepay / ~2% gift
    card = int(revenue * 0.58)
    cash_expected = int(revenue * 0.28)
    mobilepay = int(revenue * 0.12)
    gift = revenue - card - cash_expected - mobilepay  # remainder absorbs rounding
    payment_breakdown = {
        "cash": cash_expected,
        "card": card,
        "mobilepay": mobilepay,
        "gift_card": gift,
    }

    # Cash variance — usually small, occasionally larger
    if with_short_cash:
        cash_diff = -180.0          # makes the cash-short alert demoable
        cash_counted = cash_expected + cash_diff
    else:
        cash_diff = float(_RNG.choice([-25, -10, 0, 0, 0, 15, 25, 40]))
        cash_counted = cash_expected + cash_diff

    # Tips — heavier on weekend nights
    if d.weekday() in (4, 5):       # Fri / Sat
        tips_total = float(_RNG.randint(800, 1400))
        tips_staff = _RNG.choice([4, 5, 6])
    elif d.weekday() == 6:          # Sun
        tips_total = float(_RNG.randint(400, 800))
        tips_staff = _RNG.choice([3, 4])
    else:
        tips_total = float(_RNG.randint(300, 600))
        tips_staff = _RNG.choice([3, 4])
    tips_per_person = round(tips_total / tips_staff, 2)

    closer_name = _RNG.choice(["Lars", "Anna", "Mette", "Nikolaj", "Sofie"])
    status = "draft" if force_draft else "confirmed"
    closed_at = None if force_draft else datetime.combine(
        d, datetime.min.time().replace(hour=23, minute=_RNG.randint(15, 55)),
    )

    return {
        "id": uuid.uuid4(),
        "date": d,
        "revenue_categories": encode_breakdown({
            "Food": food, "Drinks": drinks, "Takeaway": takeaway,
        }),
        "revenue_total": Decimal(str(revenue)),
        "payment_categories": encode_breakdown(payment_breakdown),
        "payment_total": Decimal(str(revenue)),
        "moms_total": Decimal(str(moms_total)),
        "revenue_ex_moms": Decimal(str(revenue_ex_moms)),
        "moms_mode": "auto",
        "cash_expected": Decimal(str(cash_expected)),
        "cash_counted": Decimal(str(cash_counted)),
        "cash_difference": Decimal(str(cash_diff)),
        "tips_total": Decimal(str(tips_total)),
        "tips_staff_count": tips_staff,
        "tips_per_person": Decimal(str(tips_per_person)),
        "status": status,
        "closed_by": closer_name,
        "closed_at": closed_at,
        "is_deleted": False,
    }


# ─── Inventory items — Danish brands the categorizer recognizes ───────
#
# (name, category, quantity, unit, cost_per_unit, sell_price,
#  is_perishable, expiry_offset_days)

_INVENTORY_SEED = [
    # Beer
    ("Tuborg Pilsner 33cl",   "Beer",     48,  "flasker", 4.50, 35.00, False, None),
    ("Carlsberg Hof 33cl",    "Beer",     36,  "flasker", 4.50, 35.00, False, None),
    ("Mikkeller IPA 33cl",    "Beer",     24,  "flasker", 14.00, 65.00, False, None),
    ("Faxe Premium 33cl",     "Beer",     30,  "flasker", 4.20, 32.00, False, None),
    # Wine
    ("Rødvin husets 75cl",    "Wine",     18,  "flasker", 45.00, 295.00, False, None),
    ("Sauvignon Blanc 75cl",  "Wine",     12,  "flasker", 55.00, 325.00, False, None),
    ("Rosé Provence 75cl",    "Wine",     8,   "flasker", 65.00, 365.00, False, None),
    # Spirits
    ("Aalborg Akvavit 70cl",  "Spirits",  3,   "flasker", 165.00, 1200.00, False, None),
    ("Bombay Sapphire 70cl",  "Spirits",  2,   "flasker", 195.00, 1350.00, False, None),
    ("Absolut Vodka 70cl",    "Spirits",  4,   "flasker", 175.00, 1250.00, False, None),
    # Soft drinks
    ("Coca-Cola 33cl",        "Soft Drinks", 60, "flasker", 6.00, 32.00, False, None),
    ("Faxe Kondi 33cl",       "Soft Drinks", 36, "flasker", 5.50, 30.00, False, None),
    ("Schweppes Tonic 33cl",  "Soft Drinks", 30, "flasker", 7.50, 35.00, False, None),
    # Coffee
    ("Møstings kaffe 1kg",    "Coffee",   3,   "kg",      280.00, None, False, None),
    ("La Cabra kaffe 250g",   "Coffee",   4,   "pak",     85.00,  None, False, None),
    # Dairy (perishable!)
    ("Lurpak smør 250g",      "Dairy",    8,   "pak",     22.00, None, True, 14),
    ("Sødmælk 1l",            "Dairy",    12,  "liter",   12.00, None, True, 6),
    ("Mozzarella 125g",       "Dairy",    10,  "stk",     18.00, None, True, 8),
    # Seafood (perishable, short window)
    ("Royal Greenland laks fersk 1kg", "Seafood", 2.5, "kg", 120.00, None, True, 3),
    ("Skagerak rødspætte filet 1kg",   "Seafood", 1.8, "kg", 145.00, None, True, 2),
    # Meat
    ("Danish Crown svinekød 1kg",      "Meat",    4,   "kg", 88.00,  None, True, 4),
    ("Tulip Bacon 200g",               "Meat",    8,   "pak", 28.00, None, True, 18),
    ("Kylling brystfilet 1kg",         "Meat",    3,   "kg", 95.00,  None, True, 4),
    # Bakery + produce
    ("Rugbrød grovskåret 1kg", "Bakery",  6,   "stk",     22.00, None, True, 3),
    ("Tomater rød 1kg",       "Produce",  5,   "kg",      28.00, None, True, 7),
    ("Citroner stk",          "Produce",  20,  "stk",     3.50,  None, True, 14),
]


# ─── Expense categories + sample expenses (last 14 days) ──────────────
_EXPENSE_CATEGORIES = [
    ("Råvarer",    "#10b981"),  # ingredients
    ("Drikkevarer", "#3b82f6"), # beverages
    ("Husleje",    "#8b5cf6"),  # rent
    ("Lønninger",  "#f59e0b"),  # wages
    ("El & vand",  "#ef4444"),  # utilities
    ("Rengøring",  "#06b6d4"),  # cleaning
]

_EXPENSE_SAMPLES = [
    # (category_idx, days_ago, amount, description)
    (0,  1,  4250.00,   "Hørkram - kød + fisk levering"),
    (0,  2,  2180.00,   "BC Catering - grøntsager"),
    (0,  4,  3650.00,   "Hørkram - protein + dairy"),
    (0,  7,  4100.00,   "BC Catering + Hørkram blandet"),
    (0,  9,  1850.00,   "Skagerak - frisk fisk"),
    (1,  3,  2950.00,   "Sailing - vin + spiritus"),
    (1,  6,  1280.00,   "Inco - øl"),
    (1,  10, 1650.00,   "Sailing - sommerleverance"),
    (5,  5,  385.00,    "Vaskeriservice"),
    (5,  12, 420.00,    "Rengøringsmidler - DR Group"),
    (4,  3,  1425.00,   "El - DTU Energi"),
]


# ─── The sample company on the business profile ───────────────────────
#
# The seeder writes the sample company (Mirabelle ApS) into the owner's
# business profile so the demo looks fully set up. It must never cost the
# owner anything they typed there themselves:
#   • a CVR-verified identity is never touched;
#   • before it writes, it snapshots what the owner had in every field it is
#     about to overwrite (`demo_snapshot_json`), and "Ryd demodata" puts that
#     back (see _reset_seeded_profile);
#   • it fills the revisor slot only when it is empty — an owner's own revisor
#     stays (it is never mailed while the identity is the sample's:
#     revisor_mail.is_demo_identity);
#   • bank, MobilePay, logo and every other field it does not seed are left
#     alone.

def _seeded_profile_values() -> dict:
    """field → the value the seeder writes. ONE table, read by the seeder, the
    clear and the Profile save, so they cannot drift."""
    from app.services.revisor_mail import (
        DEMO_SEEDED_BUSINESS_EMAIL, DEMO_SEEDED_CITY, DEMO_SEEDED_COMPANY_NAME,
        DEMO_SEEDED_CVR, DEMO_SEEDED_STREET, DEMO_SEEDED_ZIPCODE,
    )
    return {
        "company_name": DEMO_SEEDED_COMPANY_NAME,
        "org_number": DEMO_SEEDED_CVR,
        "vat_number": "DK" + DEMO_SEEDED_CVR,
        "country": "DK",
        "address": DEMO_SEEDED_STREET,
        "city": DEMO_SEEDED_CITY,
        "zipcode": DEMO_SEEDED_ZIPCODE,
        "industry": "Restauranter",
        "industry_code": "56.10.10",
        "company_type": "Anpartsselskab",
        "phone": "+45 33 11 22 33",
        # Only RESERVED, non-deliverable addresses (RFC 2606 ".example"): a
        # seeded address at a real domain was mailed on a real lock once.
        "email": DEMO_SEEDED_BUSINESS_EMAIL,
        "day_cutoff_hour": 4,  # night-shift cutoff
        "source": "cvrapi.dk",
        "founded": "2018-03-12",
        "dawa_address_id": "0a3f50ad-2b4f-32b8-e044-0003ba298018",
        "vat_registered": True,
        "status_flags": None,  # no warnings
    }


# The company block — what "the business identity" means on Profile. The
# seeder's other field (day_cutoff_hour) is an operations setting.
_IDENTITY_FIELDS = (
    "company_name", "org_number", "vat_number", "country", "address", "city",
    "zipcode", "industry", "industry_code", "company_type", "phone", "email",
    "source", "founded", "dawa_address_id", "vat_registered", "status_flags",
)
_STAMP_FIELDS = ("cvr_verified_at", "cvr_verified_source")
_REVISOR_FIELDS = ("accountant_email", "accountant_name", "accountant_auto_send")


def _to_json_value(v):
    if isinstance(v, datetime):
        return {"__dt__": v.isoformat()}
    if isinstance(v, Decimal):
        return float(v)
    return v


def _from_json_value(v):
    if isinstance(v, dict) and "__dt__" in v:
        try:
            return datetime.fromisoformat(v["__dt__"])
        except (TypeError, ValueError):
            return None
    return v


def _load_snapshot(profile) -> dict | None:
    import json
    raw = getattr(profile, "demo_snapshot_json", None)
    if not raw:
        return None
    try:
        snap = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return snap if isinstance(snap, dict) else None


# The sample company's own contact details. No real owner shares them, so a
# save that merely echoes them (the company form sends every field) still
# resets them — unlike, say, an industry the register can return for the
# owner's own company too.
_SAMPLE_CONTACT_FIELDS = (
    "address", "city", "zipcode", "phone", "email", "vat_number", "founded",
    "dawa_address_id",
)


def _restore_field(profile, field: str, before: dict) -> None:
    """One seeded field back to what the owner had before the seed (the
    snapshot's value), else empty — NULL, or the column's own default."""
    if field in before:
        setattr(profile, field, _from_json_value(before[field]))
        return
    col = BusinessProfile.__table__.columns[field]
    d = getattr(col.default, "arg", None) if col.default is not None else None
    setattr(profile, field, None if (d is None or callable(d)) else d)


def _seeded_identity_fields(profile, *, street_guard: bool = False) -> list[str]:
    """The identity fields that still hold what the demo seeder wrote. With
    `street_guard` the city and zipcode count only beside the sample street
    (an owner's own street in "København K" keeps its city)."""
    import re
    from app.services.revisor_mail import (
        DEMO_SEEDED_BUSINESS_ADDRESSES, DEMO_SEEDED_CVR, seeded_street,
    )
    values = _seeded_profile_values()
    street = seeded_street(profile)
    out = []
    for f in _IDENTITY_FIELDS:
        v = getattr(profile, f, None)
        if f == "email":
            # The old seeds wrote info@mirabelle.dk.
            seeded = (v or "").strip().lower() in DEMO_SEEDED_BUSINESS_ADDRESSES
        elif f == "vat_number":
            seeded = re.sub(r"\D", "", v or "") == DEMO_SEEDED_CVR
        elif street_guard and f == "address":
            seeded = street
        elif street_guard and f in ("city", "zipcode"):
            seeded = street and v == values[f]
        else:
            seeded = v == values[f]
        if seeded:
            out.append(f)
    return out


def restore_seeded_identity(profile, *, keep=(), street_guard: bool = False) -> list[str]:
    """Every identity field that still holds the seeded value goes back to
    what the owner had there before the seed (demo_snapshot_json), else
    empty. ONE rule for "Ryd demodata" and for the Profile save that replaces
    the sample company with the owner's own — the second used to set the
    owner's pre-seed address, phone and e-mail to NULL (and keep the sample's
    company type and VAT flag), and the clear after it then dropped the
    snapshot that still held them.

    `keep`: fields the owner just saved. A seeded-looking value there is the
    owner's (an industry the register returned for their own company) — the
    sample company's contact details excepted. Returns the fields reset."""
    snap = _load_snapshot(profile)
    before = (snap or {}).get("fields") or {}
    fields = [f for f in _seeded_identity_fields(profile, street_guard=street_guard)
              if f not in keep or f in _SAMPLE_CONTACT_FIELDS]
    for f in fields:
        _restore_field(profile, f, before)
    return fields


def _seed_business_profile(db: Session, user: User, *, mark_demo: bool = False) -> None:
    """Set up the BusinessProfile to look fully verified.

    Safety rules (Audit P1 — Task #74, and the revisor round 6):
      • If the user already has a CVR-verified BusinessProfile whose
        verification source does NOT carry the " · demo" sentinel,
        refuse to touch it.  A real Mirabelle ApS-replacement
        represents the owner's actual verified Danish company and
        must NEVER be silently overwritten with the demo
        CVR/VAT/accountant fields.
      • An existing row that is NOT CVR-verified (an empty signup, or one
        the owner typed into) is seeded in place — after a snapshot of
        every value the owner had in the fields the seeder writes, kept in
        demo_snapshot_json for "Ryd demodata" to restore.
      • The revisor slot is filled only when it is empty.
      • Otherwise we insert a fresh row.
      • When `mark_demo` is True (per-user demo path), the
        cvr_verified_source is tagged with " · demo" so the row
        is later distinguishable from a real verified profile —
        both by `_count_non_demo_rows` and by the clear path.
    """
    import json
    from app.services.revisor_mail import (
        DEMO_SEEDED_REVISOR_EMAIL, DEMO_SEEDED_REVISOR_NAME, is_demo_profile,
        saved_revisor_address,
    )
    existing = db.query(BusinessProfile).filter_by(user_id=user.id).first()
    if (
        existing
        and existing.cvr_verified_at is not None
        and not (existing.cvr_verified_source or "").endswith(" · demo")
    ):
        # Defense-in-depth: callers (seed_for_user) already gate on
        # _count_non_demo_rows but if anyone bypasses that, this stops
        # the overwrite cold.  Real CVR-verified profile → don't touch.
        return
    values = _seeded_profile_values()
    if existing:
        # Update in place — don't dup the row
        profile = existing
        # Snapshot what the OWNER had — once. A row already carrying the
        # sample (tagged, or snapshotted by an earlier seed) keeps the
        # snapshot it has: a second one would only record the sample.
        if not is_demo_profile(existing) and _load_snapshot(existing) is None:
            fields = {}
            for f in (*values.keys(), *_STAMP_FIELDS, *_REVISOR_FIELDS):
                v = getattr(existing, f, None)
                if v is not None and v != "":
                    fields[f] = _to_json_value(v)
            existing.demo_snapshot_json = json.dumps({
                "created": False, "fields": fields,
                "user_business_name": getattr(user, "business_name", None),
            }, ensure_ascii=False)
    else:
        profile = BusinessProfile(id=uuid.uuid4(), user_id=user.id)
        db.add(profile)
        profile.demo_snapshot_json = json.dumps({
            "created": True, "fields": {},
            "user_business_name": getattr(user, "business_name", None),
        }, ensure_ascii=False)

    for field, value in values.items():
        setattr(profile, field, value)
    # The sample revisor only into an EMPTY slot: an owner who saved their own
    # revisor keeps them (never mailed under the sample company). The seeded
    # one is reserved, non-deliverable and auto-send is off.
    if not saved_revisor_address(profile):
        profile.accountant_email = DEMO_SEEDED_REVISOR_EMAIL
        profile.accountant_name = DEMO_SEEDED_REVISOR_NAME
        profile.accountant_auto_send = False
    # Verification stamps — make the green "Verified" banner appear
    profile.cvr_verified_at = utc_now() - timedelta(days=2)
    # When mark_demo is True the source carries the " · demo" sentinel
    # so the row is recognisably-fake to `_count_non_demo_rows` and
    # any other auditor.  When False (shared demo@bonbox.dk account)
    # we keep the clean "cvrapi.dk" source for screen-recording realism.
    profile.cvr_verified_source = "cvrapi.dk · demo" if mark_demo else "cvrapi.dk"


def _column_is_blank(profile, col) -> bool:
    """A column holds nothing the owner put there: empty, or its default."""
    v = getattr(profile, col.key, None)
    if v is None or v == "":
        return True
    d = getattr(col.default, "arg", None) if col.default is not None else None
    if d is None or callable(d):
        return False
    try:
        if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
            return float(v) == float(d)
    except (TypeError, ValueError):
        return False
    return v == d


def _profile_is_blank(profile) -> bool:
    skip = {"id", "user_id", "created_at", "updated_at", "demo_snapshot_json"}
    return all(_column_is_blank(profile, c)
               for c in BusinessProfile.__table__.columns if c.key not in skip)


def _reset_seeded_profile(db: Session, user: User) -> dict:
    """"Ryd demodata" for the business profile. Resets ONLY what still holds
    the seeded values — to what the owner had before the seed (the snapshot),
    else empty. The revisor, bank and identity fields the owner typed
    survive. The row is deleted only when nothing of the owner's is left on
    it (the untouched demo: a clean slate, as before).

    Returns {"business_profile_reset": 0|1, "kept": [...]} — "kept" names
    what survived ("identity", "revisor", "bank") so the page can say so."""
    from app.services.revisor_mail import (
        DEMO_SEEDED_COMPANY_NAME, DEMO_SEEDED_REVISOR_ADDRESSES, is_demo_identity,
        is_demo_profile, is_demo_revisor, saved_revisor_address,
    )
    out = {"business_profile_reset": 0, "kept": []}
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    if profile is None:
        return out
    snap = _load_snapshot(profile)
    tagged = is_demo_profile(profile)
    if not tagged and snap is None:
        return out  # never seeded here (or seeded before snapshots, and fixed)
    before = (snap or {}).get("fields") or {}
    values = _seeded_profile_values()
    # Decided BEFORE the stamp goes: the " · demo" tag is what fences the old
    # deliverable seed address (anna@revisor.dk) beside a name the owner
    # typed. Read after the restore, that address counted as "your revisor"
    # and the next lock mailed it.
    demo_rev = is_demo_revisor(profile)

    # The sample company — only while the identity IS still the sample's. An
    # owner who saved their own company keeps all of it (a register lookup can
    # return "Restauranter" or "cvrapi.dk" too: those are theirs now).
    if is_demo_identity(profile):
        restore_seeded_identity(profile)
    # The " · demo" verification stamp — back to what the owner had.
    if tagged:
        for f in _STAMP_FIELDS:
            _restore_field(profile, f, before)
    # The sample revisor — back to the owner's, else empty.
    if demo_rev:
        for f in _REVISOR_FIELDS:
            _restore_field(profile, f, before)
    # A seeded address never survives the clear as "your revisor", whatever
    # name sits beside it (a snapshot can never hold the sample either).
    if saved_revisor_address(profile) in DEMO_SEEDED_REVISOR_ADDRESSES:
        profile.accountant_email = None
        profile.accountant_auto_send = None
        profile.accountant_name = None
    # The night-shift cutoff the demo set.
    if getattr(profile, "day_cutoff_hour", None) == values["day_cutoff_hour"]:
        _restore_field(profile, "day_cutoff_hour", before)
    profile.demo_snapshot_json = None

    # The signup name the echoed sample company overwrote.
    prev_name = (snap or {}).get("user_business_name")
    if (prev_name and (getattr(user, "business_name", None) or "").strip().casefold()
            == DEMO_SEEDED_COMPANY_NAME.casefold()
            and prev_name.strip().casefold() != DEMO_SEEDED_COMPANY_NAME.casefold()):
        user.business_name = prev_name

    out["business_profile_reset"] = 1
    if _profile_is_blank(profile):
        db.delete(profile)
        return out
    if (profile.company_name or "").strip():
        out["kept"].append("identity")
    if (profile.accountant_email or "").strip():
        out["kept"].append("revisor")
    if any((getattr(profile, f, None) or "") for f in
           ("bank_reg_number", "bank_account_number", "mobilepay_number", "iban", "bic")):
        out["kept"].append("bank")
    return out


def _seed_branch(db: Session, user: User) -> Branch | None:
    """One branch — Mirabelle Vesterbro. Returns the row for FKs."""
    existing = db.query(Branch).filter_by(user_id=user.id).first()
    if existing:
        return existing
    b = Branch(
        id=uuid.uuid4(),
        user_id=user.id,
        name="Mirabelle Vesterbro",
        address="Vestergade 1, 1456 København K",
        is_active=True,
    )
    db.add(b)
    db.flush()
    return b


def _seed_daily_closes(db: Session, user: User, branch_id, *, mark_demo: bool = False) -> int:
    """30 days of closes back from yesterday. Today is intentionally
    left empty so the closer can demo "creating today's close".

    When ``mark_demo`` is True, every close gets a ``notes`` value
    ending in " · demo" so the per-user clear can safely target only
    seeded rows (Task #68).
    """
    today = date.today()
    inserted = 0
    # 30 days back; the "yesterday" entry is left as a draft so the
    # Edit flow is demoable; one day mid-range gets the cash-short
    # variance for the insights alert.
    for offset in range(1, 31):
        d = today - timedelta(days=offset)
        force_draft = (offset == 1)             # yesterday = draft
        with_short_cash = (offset in (3, 4, 5))  # 3-day cash-short streak
        payload = _close_for_day(
            d, force_draft=force_draft, with_short_cash=with_short_cash,
        )
        dc = DailyClose(
            user_id=user.id,
            branch_id=branch_id,
            **payload,
        )
        if mark_demo:
            # Tag for the clear path. Owner won't usually see notes; if
            # they edit the close, they can clear the suffix freely.
            dc.notes = "sample · demo"
        db.add(dc)
        inserted += 1
    return inserted


def _seed_inventory(db: Session, user: User, branch_id, *, mark_demo: bool = False) -> int:
    """24 items across Beer / Wine / Spirits / Soft Drinks / Coffee /
    Dairy / Seafood / Meat / Bakery / Produce.

    When ``mark_demo`` is True every item's name ends in " · demo" so
    per-user clear can target only seeded rows (Task #68).
    """
    today = date.today()
    inserted = 0
    for name, cat, qty, unit, cost, sell, is_perish, expiry_off in _INVENTORY_SEED:
        display_name = f"{name} · demo" if mark_demo else name
        item = InventoryItem(
            id=uuid.uuid4(),
            user_id=user.id,
            branch_id=branch_id,
            name=display_name,
            category=cat,
            quantity=qty,
            unit=unit,
            cost_per_unit=Decimal(str(cost)),
            sell_price=Decimal(str(sell)) if sell is not None else None,
            is_perishable=bool(is_perish),
            expiry_date=(today + timedelta(days=expiry_off)) if expiry_off else None,
        )
        db.add(item)
        inserted += 1
    return inserted


def _seed_expenses(db: Session, user: User, branch_id, *, mark_demo: bool = False) -> int:
    """Categories + 11 expenses spread across last ~14 days.

    When ``mark_demo`` is True every expense description AND category
    name ends with the " · demo" marker so the per-user clear path
    cleans up after itself (Task #68).
    """
    # Build categories first, capture by name
    cats_by_name: dict[str, ExpenseCategory] = {}
    for name, color in _EXPENSE_CATEGORIES:
        cat_name = f"{name} · demo" if mark_demo else name
        cat = ExpenseCategory(
            id=uuid.uuid4(),
            user_id=user.id,
            name=cat_name,
            color=color,
        )
        db.add(cat)
        cats_by_name[name] = cat
    db.flush()

    today = date.today()
    inserted = 0
    cat_list = [cats_by_name[name] for name, _ in _EXPENSE_CATEGORIES]
    for cat_idx, days_ago, amount, desc in _EXPENSE_SAMPLES:
        display_desc = f"{desc} · demo" if mark_demo else desc
        e = Expense(
            id=uuid.uuid4(),
            user_id=user.id,
            category_id=cat_list[cat_idx].id,
            branch_id=branch_id,
            date=today - timedelta(days=days_ago),
            amount=Decimal(str(amount)),
            description=display_desc,
            payment_method="card",
            is_personal=False,
        )
        db.add(e)
        inserted += 1
    return inserted


# ─── Public entrypoints ───────────────────────────────────────────────

def seed_demo_account(db: Session) -> dict:
    """Idempotent demo seed.

    Returns:
      {"skipped": True, "reason": ...} when nothing happened
      {"skipped": False, "closes": N, "inventory": N, "expenses": N}
        when the seed ran
    """
    user = db.query(User).filter(User.email == _DEMO_EMAIL).first()
    if not user:
        return {"skipped": True, "reason": "demo user does not exist yet"}

    # ── Plan / trial tidy-up — runs every startup, idempotent ──
    # Demo lives in active-trial state so walkthroughs naturally
    # showcase the trial countdown chip in the sidebar AND the full
    # Pro feature set (effective_plan returns "trial" → full Pro
    # entitlements via PLAN_CAPS["trial"]).
    #
    # Refresh policy: bump trial_ends_at to now + 14 days IF it would
    # expire within the next 7 days. That way:
    #   • New demo signups see 14 days remaining at start.
    #   • Mid-trial restarts don't reset the countdown — chip
    #     decreases naturally day by day.
    #   • Once trial nears expiry (≤7 days), next app restart pushes
    #     it back to 14 — keeps demo perpetually "in trial" for
    #     sales walkthroughs without manual intervention.
    plan_dirty = False
    # Demo plan stays as "free" so effective_plan() resolves to
    # "trial" while trial_ends_at is in the future (full Pro feats).
    # Bump back from any accidentally-set paid plan so the demo
    # consistently shows the trial chip.
    if (user.plan or "free") not in ("free", None, ""):
        # User was bumped to paid in a prior version — reset to free
        # so the trial chip shows. Pro entitlements still apply via
        # the active-trial path.
        user.plan = "free"
        plan_dirty = True
    # Refresh trial only when it's missing or about to expire.
    needs_trial_refresh = (
        user.trial_ends_at is None
        or user.trial_ends_at < utc_now() + timedelta(days=7)
    )
    if needs_trial_refresh:
        user.trial_ends_at = utc_now() + timedelta(days=14)
        plan_dirty = True
    if plan_dirty:
        db.commit()

    # Skip if there are already DailyClose rows — don't touch live demo
    # data the team might be using or have customized.
    existing_count = db.query(DailyClose).filter_by(
        user_id=user.id, is_deleted=False,
    ).count()
    if existing_count > 0:
        return {"skipped": True, "reason": f"already has {existing_count} closes"}

    _seed_business_profile(db, user)
    branch = _seed_branch(db, user)
    branch_id = branch.id if branch else None
    closes = _seed_daily_closes(db, user, branch_id)
    inventory = _seed_inventory(db, user, branch_id)
    expenses = _seed_expenses(db, user, branch_id)
    db.commit()

    return {
        "skipped": False,
        "user_id": str(user.id),
        "closes": closes,
        "inventory": inventory,
        "expenses": expenses,
    }


def reset_demo_account(db: Session) -> dict:
    """CLI-only — wipes the demo user's data + re-seeds.

    Not invoked on automatic startup. Use sparingly: kills any data
    the team added since the last seed.
    """
    user = db.query(User).filter(User.email == _DEMO_EMAIL).first()
    if not user:
        return {"skipped": True, "reason": "demo user does not exist"}

    deleted = {}
    deleted["closes"] = db.query(DailyClose).filter_by(user_id=user.id).delete()
    deleted["inventory"] = db.query(InventoryItem).filter_by(user_id=user.id).delete()
    deleted["expenses"] = db.query(Expense).filter_by(user_id=user.id).delete()
    deleted["expense_cats"] = db.query(ExpenseCategory).filter_by(user_id=user.id).delete()
    deleted["branches"] = db.query(Branch).filter_by(user_id=user.id).delete()
    db.commit()

    seed_result = seed_demo_account(db)
    return {"reset": True, "deleted": deleted, "seeded": seed_result}


# ─── Per-user demo seed (Task #68) ──────────────────────────────────
# The functions above target the shared demo@bonbox.dk account. New
# owners need their OWN sample data on their OWN account — "Try BonBox
# with sample data" on the empty Dashboard. We reuse the same helpers
# (_seed_business_profile, _seed_daily_closes, _seed_inventory,
# _seed_expenses) since they already accept `user` as an arg.
#
# Marker contract: every demo-created row carries " · demo" in its
# description (the existing _seed_* helpers already do this). Clear
# uses that marker so we never wipe a real entry the owner has typed
# in by hand. Multi-layer safety: clear only runs when the user has
# AT MOST a small number of non-demo rows — better to be paranoid.

def _count_non_demo_rows(db: Session, user_id, *, include_verified_profile: bool = True) -> int:
    """How many rows of real (non-demo) data does the user have?

    Used as a safety gate for both seeding (don't pollute a working
    account) and clearing (don't accidentally nuke real work).

    Counts (Audit P1 — Task #74):
      • Expense rows whose description does NOT end with " · demo"
      • DailyClose rows whose notes does NOT end with " · demo"
      • InventoryItem rows whose name does NOT end with " · demo"
      • All Sale rows (no demo marker exists for sales — any sale
        is presumed real)
      • BusinessProfile rows with cvr_verified_at IS NOT NULL — a
        verified Danish CVR signals the owner has done real
        Erhvervsstyrelsen setup; we MUST NOT touch that account.
    """
    from sqlalchemy import or_
    # Expense.description doesn't have an "ends with" Pythonic shortcut;
    # use LIKE '% · demo' which is universally portable.
    real_expense = (
        db.query(Expense)
        .filter(Expense.user_id == user_id, Expense.is_deleted.isnot(True))
        .filter(or_(Expense.description.is_(None),
                    ~Expense.description.like("% · demo")))
        .count()
    )
    # Daily closes use notes for the marker
    real_close = (
        db.query(DailyClose)
        .filter(DailyClose.user_id == user_id, DailyClose.is_deleted.isnot(True))
        .filter(or_(DailyClose.notes.is_(None),
                    ~DailyClose.notes.like("% · demo")))
        .count()
    )
    # Inventory uses the name for the marker
    real_inventory = (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == user_id)
        .filter(~InventoryItem.name.like("% · demo"))
        .count()
    )
    # Sales have no demo marker — every sale row counts as real
    real_sales = (
        db.query(Sale)
        .filter(Sale.user_id == user_id, Sale.is_deleted.isnot(True))
        .count()
    )
    # A verified BusinessProfile is the most sensitive signal — the
    # owner has done a real CVR/Erhvervsstyrelsen lookup.  Skip rows
    # whose cvr_verified_source carries the " · demo" sentinel since
    # those are seeded.
    # `include_verified_profile=False` (seed_for_user's keep_profile mode):
    # the profile is not touched at all, so a verified one is no reason to
    # refuse — the other rows still are.
    verified_profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user_id,
                BusinessProfile.cvr_verified_at.isnot(None))
        .filter(or_(BusinessProfile.cvr_verified_source.is_(None),
                    ~BusinessProfile.cvr_verified_source.like("% · demo")))
        .count()
    ) if include_verified_profile else 0
    return int(
        real_expense + real_close + real_inventory + real_sales + verified_profile
    )


def _count_in_use_rows(db: Session, user_id) -> int:
    """Signs a venue is already running on BonBox even with no closes or
    expenses: its own (non-demo) bookings, its own bookable tables, and a staff
    roster. seed_for_user's keep_profile mode refuses on any of them — it no
    longer has the CVR-verified gate, and sample tables (is_active, so real
    capacity for the public booking page) and tonight's sample bookings must
    never land on a live host stand. Kept out of _count_non_demo_rows so the
    default seed and "Ryd demodata" rules are unchanged."""
    from sqlalchemy import or_
    from app.models.staff import StaffMember
    real_bookings = (
        db.query(Reservation)
        .filter(Reservation.user_id == user_id, Reservation.is_deleted.isnot(True))
        .filter(or_(Reservation.idempotency_key.is_(None),
                    ~Reservation.idempotency_key.like("demo-%")))
        .count()
    )
    real_tables = (
        db.query(BookableResource)
        .filter(BookableResource.user_id == user_id,
                BookableResource.is_deleted.isnot(True))
        .filter(~BookableResource.label.like("% · demo"))
        .count()
    )
    # Every staff member, active or not: staff are only ever deactivated, and
    # a roster at all means the venue has used BonBox for real.
    staff = (
        db.query(StaffMember)
        .filter(StaffMember.user_id == user_id,
                StaffMember.is_deleted.isnot(True))
        .count()
    )
    return int(real_bookings + real_tables + staff)


def _seed_reservations(db: Session, user: User, mark_demo: bool = True) -> dict:
    """Seed a believable *tonight's service* so the Reservations timeline
    isn't a blank screen on a fresh/demo account.

    Four tables + seven bookings on the owner's LOCAL business day, shaped so
    every part of the host-stand view has something to render: a party already
    **seated**, a later turn on the same 4-top, a **combinable** 6-top, one
    **overlapping** pair on Bord 1 (so the timeline collision reads), and one
    unassigned **walk-in** in 'requested' (so the Unassigned lane isn't empty).

    Reservation.starts_at is stored as NAIVE business-local wall-clock (see
    tz_utils.business_day_window_local), so we combine today's local date with
    a wall-clock time directly — no UTC conversion.

    Seeded as plain Reservation rows (no reservation_occupancy hold): they
    populate the owner's timeline without touching the public availability
    engine — a demo account takes no real public bookings, so a hold would be
    pointless machinery. Demo markers (removed by clear_for_user):
      • tables       → label carries the " · demo" suffix
      • reservations → idempotency_key = "demo-<user>-<n>" (invisible, so the
        guest names on the bars still read like a real service)
    """
    suffix = " · demo" if mark_demo else ""
    today = business_today_local(user)

    # (label, seats, zone, combinable)
    table_specs = [
        ("Bord 1", 2, "Indendørs", False),
        ("Bord 2", 2, "Indendørs", False),
        ("Bord 3", 4, "Indendørs", False),
        ("Vindue 1", 6, "Vindue", True),
    ]
    tables: list[BookableResource] = []
    for i, (label, seats, zone, comb) in enumerate(table_specs):
        row = BookableResource(
            user_id=user.id, kind="table", label=f"{label}{suffix}",
            capacity_seats=seats, zone=zone, combinable=comb,
            sort_order=i, is_active=True,
        )
        db.add(row)
        db.flush()
        tables.append(row)

    def _at(hour: int, minute: int) -> datetime:
        return datetime.combine(today, datetime.min.time()).replace(
            hour=hour, minute=minute,
        )

    # (table_index | None, guest, party, (h, m), duration_min, status, source)
    booking_specs = [
        (0, "Anders Jensen", 2, (18, 0), 90, "seated", "manual"),
        (1, "Sofie Holm", 2, (18, 30), 90, "confirmed", "public"),
        (2, "Familien Berg", 4, (19, 0), 120, "confirmed", "public"),
        (3, "Selskab Lund", 6, (19, 30), 150, "confirmed", "public"),
        (0, "Line Krog", 2, (19, 15), 90, "confirmed", "public"),   # overlaps Bord 1 → collision
        (2, "Mikkel Sø", 4, (21, 0), 120, "confirmed", "public"),   # later turn, same 4-top
        (None, "Walk-in", 3, (20, 0), 90, "requested", "walk_in"),  # unassigned lane
    ]
    made = 0
    for n, (ti, guest, party, (hh, mm), dur, status, source) in enumerate(booking_specs):
        start = _at(hh, mm)
        db.add(Reservation(
            user_id=user.id,
            resource_id=(tables[ti].id if ti is not None else None),
            guest_name=guest,
            party_size=party,
            starts_at=start,
            ends_at=start + timedelta(minutes=dur),
            duration_min=dur,
            status=status,
            source=source,
            seated_at=(utc_now() if status == "seated" else None),
            idempotency_key=(f"demo-{user.id}-{n}" if mark_demo else None),
        ))
        made += 1

    return {"tables": len(tables), "bookings": made}


def seed_for_user(db: Session, user: User, *, keep_profile: bool = False) -> dict:
    """Materialize sample data on the CURRENT user's account.

    Safety rules:
      1. Refuse if the user already has ANY real (non-demo) rows —
         we never overwrite a working account.
      2. Refuse if the user has already-seeded demo rows — they
         should clear first.
      3. Tenant-scoped end-to-end — only writes for this user_id.

    `keep_profile` (the onboarding wizard's "Udforsk med eksempeldata"): the
    owner has just typed their OWN business in — name, CVR, address, day
    rollover, revisor. The sample days, stock, expenses, tables and bookings
    are added (each carrying the demo marker, cleared by "Ryd demodata"), but
    the business profile is not touched at all: no sample company, no sample
    revisor, no sample cutoff. No sample branch either — "Mirabelle Vesterbro"
    at the sample address would put the sample company back on the owner's
    documents (and the clear does not remove branches); an existing branch is
    used as is. Because the profile is left alone, a CVR-verified one is not a
    reason to refuse here (it still is in the default mode, which writes the
    profile) — but an account already IN USE still is: real bookings, real
    tables or staff (_count_in_use_rows) refuse it, so a live venue
    re-running the welcome wizard never gets sample tables on its host stand
    or in its public availability.

    What fences the sample days under the owner's real identity: a sample
    close's kasserapport is titled EKSEMPEL and is never mailed to a revisor
    (skip "demo_close"); the momsangivelse mail refuses a period holding sample
    rows (demo_in_period), and so do the momsangivelse PDF download and the
    bookkeeping exports that carry closes and expenses
    (revisor_mail.demo_rows_under_own_identity) until "Ryd demodata".
    """
    if user is None:
        return {"ok": False, "reason": "no user"}

    # Block when there's any real data. keep_profile drops the verified-
    # profile signal (the profile is not touched) and adds the account-in-use
    # one instead (bookings, tables, staff — what a live venue has even with
    # no closes or expenses yet).
    real_count = _count_non_demo_rows(
        db, user.id, include_verified_profile=not keep_profile,
    )
    if keep_profile:
        real_count += _count_in_use_rows(db, user.id)
    if real_count > 0:
        return {
            "ok": False,
            "reason": "user has real data",
            "real_row_count": real_count,
        }

    # Block when demo data is already present
    existing_demo = (
        db.query(Expense)
        .filter(Expense.user_id == user.id,
                Expense.description.like("% · demo"),
                Expense.is_deleted.isnot(True))
        .count()
    )
    if existing_demo > 0:
        return {
            "ok": False,
            "reason": "demo data already seeded",
            "demo_row_count": int(existing_demo),
        }

    if keep_profile:
        branch = db.query(Branch).filter_by(user_id=user.id).first()
    else:
        _seed_business_profile(db, user, mark_demo=True)
        branch = _seed_branch(db, user)
    branch_id = branch.id if branch else None
    closes = _seed_daily_closes(db, user, branch_id, mark_demo=True)
    inventory = _seed_inventory(db, user, branch_id, mark_demo=True)
    expenses = _seed_expenses(db, user, branch_id, mark_demo=True)
    reservations = _seed_reservations(db, user, mark_demo=True)
    db.commit()

    return {
        "ok": True,
        "closes": closes,
        "inventory": inventory,
        "expenses": expenses,
        "reservations": reservations,
        "profile_kept": bool(keep_profile),
    }


def clear_for_user(db: Session, user: User) -> dict:
    """Remove demo rows from the current user's account.

    Only rows tagged with " · demo" are removed. Anything the owner
    has typed by hand stays put. Safe to call repeatedly — idempotent
    once the rows are gone.

    We also remove demo expense categories that have no remaining
    expenses, and demo-tagged inventory items. Closes are matched on
    notes ending " · demo".
    """
    if user is None:
        return {"ok": False, "reason": "no user"}

    deleted = {
        "expenses": 0,
        "closes": 0,
        "inventory": 0,
        "reservations": 0,
        "tables": 0,
        "expense_cats": 0,
        "business_profile_reset": 0,
    }

    # Reservations (invisible "demo-<user>-<n>" idempotency-key marker) —
    # deleted BEFORE the tables they point at (resource_id FK).
    demo_reservations = (
        db.query(Reservation)
        .filter(Reservation.user_id == user.id,
                Reservation.idempotency_key.like("demo-%"))
        .all()
    )
    for r in demo_reservations:
        db.delete(r)
        deleted["reservations"] += 1
    # Flush the deletes before the tables ask "is a booking still seated
    # here?": the app's sessions run with autoflush=False, so the query below
    # still saw the sample bookings and every sample table was kept as
    # "still referenced" — "Ryd demodata" left Bord 1–3 and Vindue 1 behind.
    db.flush()

    # Bookable resources (tables) — " · demo" label marker. A table the owner
    # renamed/added by hand carries no suffix and is left untouched.
    demo_tables = (
        db.query(BookableResource)
        .filter(BookableResource.user_id == user.id,
                BookableResource.label.like("% · demo"))
        .all()
    )
    for tbl in demo_tables:
        # If a REAL (non-demo) booking was seated at this demo table, its
        # reservation/occupancy FK would make the delete raise IntegrityError
        # and abort the whole clear (500). Skip such a table so clear degrades
        # gracefully — the owner can delete it by hand once it's freed.
        still_referenced = (
            db.query(Reservation.id)
              .filter(Reservation.resource_id == tbl.id).first() is not None
            or db.query(ReservationOccupancy.id)
                 .filter(ReservationOccupancy.resource_id == tbl.id).first() is not None
        )
        if still_referenced:
            continue
        db.delete(tbl)
        deleted["tables"] += 1

    # Expenses
    demo_expenses = (
        db.query(Expense)
        .filter(Expense.user_id == user.id,
                Expense.description.like("% · demo"))
        .all()
    )
    for e in demo_expenses:
        db.delete(e)
        deleted["expenses"] += 1

    # Closes (notes-based marker)
    demo_closes = (
        db.query(DailyClose)
        .filter(DailyClose.user_id == user.id,
                DailyClose.notes.like("% · demo"))
        .all()
    )
    for c in demo_closes:
        db.delete(c)
        deleted["closes"] += 1

    # Inventory: per-user seed appends " · demo" to every item name
    # (see _seed_inventory with mark_demo=True). We rely on that
    # marker — anything the owner has typed by hand keeps their
    # chosen name and is untouched here.
    demo_inv = (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == user.id,
                InventoryItem.name.like("% · demo"))
        .all()
    )
    for i in demo_inv:
        db.delete(i)
        deleted["inventory"] += 1

    # Demo BusinessProfile — reset ONLY the seeded values (to the owner's
    # own, from the pre-seed snapshot) and drop the " · demo" stamp, so the
    # owner gets a clean slate to enter their real CVR. It used to delete the
    # whole tagged row — and with it the real revisor and bank details the
    # owner had saved on it, against this function's own promise. The row
    # goes only when nothing of the owner's is left on it.
    prof = _reset_seeded_profile(db, user)
    deleted["business_profile_reset"] = prof["business_profile_reset"]
    kept = prof["kept"]

    # Demo-named expense categories — only remove if no expenses
    # reference them. Safer than blanket cascade.
    demo_cats = (
        db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user.id,
                ExpenseCategory.name.like("% · demo"))
        .all()
    )
    for c in demo_cats:
        ref_count = db.query(Expense).filter_by(category_id=c.id).count()
        if ref_count == 0:
            db.delete(c)
            deleted["expense_cats"] += 1

    db.commit()
    return {"ok": True, "deleted": deleted, "kept": kept}


# What the owner can have typed into their business profile: the company
# block and the revisor. (country / source / cutoff are defaults or settings,
# not "the owner's details".)
_OWNER_DETAIL_FIELDS = (
    "company_name", "org_number", "vat_number", "address", "city", "zipcode",
    "phone", "email", "accountant_email",
)


def profile_has_owner_details(db: Session, user_id) -> bool:
    """The business profile holds details the OWNER put there — not the
    sample company, not an empty signup row. The dashboard's "Prøv med
    eksempeldata" then seeds with keep_profile, so those details are never
    overwritten (release gate R-b, 9 Oct)."""
    from app.services.revisor_mail import is_demo_profile
    p = db.query(BusinessProfile).filter_by(user_id=user_id).first()
    if p is None or is_demo_profile(p) or _load_snapshot(p) is not None:
        return False
    return any(str(getattr(p, f, None) or "").strip() for f in _OWNER_DETAIL_FIELDS)


def status_for_user(db: Session, user: User, *, scope: str | None = None) -> dict:
    """Lightweight status read — frontend asks 'should I show the
    Seed button or the Clear button?'

    scope="has_demo" (the sample-data banner, read on every dashboard
    load): has_demo only — one query, not the real-row counts."""
    if user is None:
        return {"has_demo": False} if scope == "has_demo" else {"has_demo": False, "has_real": False}
    has_demo = (
        db.query(Expense)
        .filter(Expense.user_id == user.id,
                Expense.description.like("% · demo"),
                Expense.is_deleted.isnot(True))
        .count()
    ) > 0
    if scope == "has_demo":
        return {"has_demo": bool(has_demo)}
    has_real = _count_non_demo_rows(db, user.id) > 0
    return {"has_demo": bool(has_demo), "has_real": bool(has_real)}


def seed_choice_for_user(db: Session, user: User, status: dict | None = None) -> dict:
    """Which seed the app sends, and whether it would be accepted (release
    gate R-b, 9 Oct — the dashboard card wrote the sample company over the
    owner's typed details):

      own_profile: the profile holds the owner's own details — the seed is
        keep_profile (never the sample company over them).
      seedable: that seed would be accepted. keep_profile also refuses an
        account in use (staff, its own tables or bookings).

    `status` is status_for_user's answer when the caller already has it."""
    if user is None:
        return {"own_profile": False, "seedable": False}
    st = status if status is not None else status_for_user(db, user)
    own_profile = profile_has_owner_details(db, user.id)
    if st.get("has_demo") or st.get("has_real"):
        seedable = False
    elif own_profile:
        # No real rows (has_real is False, a verified profile included): only
        # the keep_profile in-use gate is left to refuse.
        seedable = _count_in_use_rows(db, user.id) == 0
    else:
        seedable = True
    return {"own_profile": bool(own_profile), "seedable": bool(seedable)}
