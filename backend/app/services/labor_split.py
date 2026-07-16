"""labor_split — split a period's logged labour COST into department buckets.

The owner's one honest question behind /staff/hours: "where is my payroll going —
front of house, kitchen, support?" We already know each staff member's job role
(StaffMember.role) and the shift PLANNER already groups roles into coarse
departments (front_of_house | kitchen | support | specialist, per
business_operating_service.ROLE_CATALOG_BY_VERTICAL). This module reuses that same
category map on the COST side so the two surfaces can never disagree on what
counts as kitchen.

HONESTY (these are the whole point — a wrong split is worse than no split):
  • BY PRIMARY ROLE, not per shift. HoursLogged carries no per-shift role, only
    StaffMember.role. A person's whole cost lands in their primary department. A
    chef who occasionally serves is a rounding error; we label the basis
    "primary_role" so it is never read as per-shift truth.
  • ESTIMATE, inherited. Gross × (1 + ferie_uplift) is the same feriepenge
    estimate the parent cost tile uses — ATP/pension/skat excluded. Never exact
    payroll.
  • UNKNOWN ROLE → "unassigned", never silently dropped or misfiled into a real
    department (that would fabricate a fact about the kitchen).
  • SELF-ACTIVATING GATE. Returns None unless there is real money AND at least two
    departments carry MATERIAL cost (≥1% of payroll each). A venue that never
    assigned roles has every staffer on the default "server" role → one bucket →
    nothing to split; and one dominant department beside a sliver → one material
    bucket → both render nothing rather than a misleading "100% front of house".
    Shares are over the shown set, so a department can never display "0%".
  • NO per-department labour %. Revenue cannot be attributed to FOH vs kitchen, so
    a "kitchen labour %" would have a fabricated denominator. We expose cost and
    share-OF-COST only; the single total labour% stays on the parent tile.
"""

from __future__ import annotations

from typing import Optional

from app.services.business_operating_service import role_category

# Stable render order for the departments. "unassigned" is always last.
_CATEGORY_ORDER = ("front_of_house", "kitchen", "specialist", "support", "unassigned")
_UNASSIGNED = "unassigned"

# A department carrying under this share of payroll is immaterial for a
# "where the money goes" glance — it is omitted so it can never render as a
# misleading "0%" next to real money, and so one dominant department + a sliver
# can't masquerade as a genuine split.
_MATERIALITY_FLOOR = 0.01


def build_labor_split(
    *,
    staff_roles: dict[str, Optional[str]],
    per_staff_hours: dict[str, float],
    per_staff_gross: dict[str, float],
    vertical: Optional[str],
    ferie_uplift: float,
) -> Optional[dict]:
    """Bucket a period's per-staff hours + gross wage into departments.

    Args map staff_id (str) → their role / hours / gross for the period. Returns
    a render-ready dict, or None when there is nothing honest to show (no cost, or
    the cost does not actually split across ≥2 departments).
    """
    if ferie_uplift < 0:
        ferie_uplift = 0.0

    buckets: dict[str, dict[str, float]] = {}
    # Union of everyone who logged hours or earned this period.
    for sid in set(per_staff_hours) | set(per_staff_gross):
        cat = role_category(staff_roles.get(sid)) or _UNASSIGNED
        b = buckets.setdefault(cat, {"hours": 0.0, "gross": 0.0})
        b["hours"] += float(per_staff_hours.get(sid, 0.0) or 0.0)
        b["gross"] += float(per_staff_gross.get(sid, 0.0) or 0.0)

    # Denominator basis = POSITIVE payroll only. A department can only net negative
    # via a correction/reversal entry (rare, but HoursLogged.earned carries no ≥0
    # guard); such anomalies are excluded from BOTH the total and the render, so the
    # shown shares stay internally consistent — they can never sum past 100%, and a
    # department with real activity can't vanish behind an under-counted denominator.
    positive_total = sum(b["gross"] for b in buckets.values() if b["gross"] > 0)
    # Gate 1 — the card is about MONEY. No positive cost basis → the parent tile
    # already says "set wage rates"; an all-zero split here would be noise.
    if positive_total <= 0:
        return None

    # Gate 2 — a department must carry MATERIAL cost (≥ _MATERIALITY_FLOOR of
    # payroll) to count as a real split. Without this floor a 40,000 kr barista + a
    # 130 kr dishwasher would clear a bare ≥2 check and render "front of house 100% ·
    # support 0%" — the exact misleading single-department split the gate exists to
    # prevent. Below the floor → dropped; fewer than two survivors → render nothing.
    material = {
        cat: b
        for cat, b in buckets.items()
        if b["gross"] > 0 and (b["gross"] / positive_total) >= _MATERIALITY_FLOOR
    }
    if len(material) < 2:
        return None

    # Shares + total are computed over the SHOWN set only, so the rows always sum to
    # 100% and the total reconciles with the rows the owner can see.
    shown_total = sum(b["gross"] for b in material.values())

    def _order(cat: str) -> tuple:
        # Cost desc, but "unassigned" pinned last; catalog order breaks ties so
        # the render is deterministic (tests + stable UI).
        idx = _CATEGORY_ORDER.index(cat) if cat in _CATEGORY_ORDER else len(_CATEGORY_ORDER)
        return (cat == _UNASSIGNED, -material[cat]["gross"], idx)

    categories = []
    for cat in sorted(material, key=_order):
        gross = material[cat]["gross"]
        categories.append({
            "category": cat,
            "hours": round(material[cat]["hours"], 1),
            "gross": round(gross, 2),
            "loaded": round(gross * (1.0 + ferie_uplift), 2),
            # share OF SHOWN COST — sums to 100%; never a labour% vs revenue.
            "pct_of_cost": round(gross / shown_total, 4),
        })

    return {
        "basis": "primary_role",  # UI must caption "by primary role · estimate"
        "vertical": vertical,     # frontend picks the vertical-natural label
        "categories": categories,
        "total_loaded": round(shown_total * (1.0 + ferie_uplift), 2),
    }
