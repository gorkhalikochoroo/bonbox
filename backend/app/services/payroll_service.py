"""
Danish payroll calculator — estimates A-skat, AM-bidrag, ATP, feriepenge.

IMPORTANT: this is an ESTIMATE for employer planning, NOT the final lønseddel.
Real A-skat depends on each employee's trækkort (hovedkort vs bikort vs frikort,
personfradrag, deductions). We approximate with a flat marginal rate so
employers can budget and meet the 10th-of-month SKAT deadline; the actual
amount is computed by their lønsystem (or by SKAT directly via eIndkomst).

Multi-layer defense:
- Caller passes period dates explicitly; if HoursLogged column missing, we
  return zero amounts (not a crash).
- Rates are constants here; if an employee's stored rate is null, we use
  base_rate, then 0 — never None into arithmetic.
- All money rounding is .2 decimals at the boundary, integer at display.

References:
  https://skat.dk/erhverv/loen-og-skat
  https://www.atp.dk/satser
  https://www.borger.dk/arbejde-dagpenge-ferie/Ferie-og-feriepenge
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.models.staff import HoursLogged, StaffMember, TipDistribution, Tip

logger = logging.getLogger(__name__)


# ─── Danish payroll rates (constants — update if SKAT changes them) ────

# AM-bidrag (labour-market contribution) — 8% of gross, no personfradrag.
AM_BIDRAG_RATE = 0.08

# A-skat — ESTIMATE only. Real rate is per-employee from trækkort.
# DK marginal A-skat at bottom bracket ≈ bundskat (12.06%) + kommuneskat
# (~24% avg, varies 22.5%–26.3% by kommune). Total ≈ 36% before topskat.
# Topskat adds 15% above 588k DKK/year (2025). For our SMB target market
# most staff are below topskat, so 36% is the safer planning estimate.
# User can override per-staff via tax_card_rate (planned, not yet added).
ESTIMATED_A_SKAT_RATE = 0.36

# Personal allowance (personfradrag) — monthly equivalent.
# 2026 personfradrag ≈ 51,600 kr/year ÷ 12 ≈ 4,300 kr/month.
PERSONFRADRAG_MONTHLY = 4300.0

# ATP (Arbejdsmarkedets Tillægspension) — flat employer contribution,
# 270 kr/quarter for full-time employees split across the 3 months.
# Simplified to monthly 90 kr per full-time employee.
ATP_MONTHLY_FULL_TIME = 90.0

# Feriepenge (holiday allowance) — 12.5% of gross, paid to FerieKonto
# under "ny ferielov" (since 2020). Employers pay quarterly on top of wages.
FERIEPENGE_RATE = 0.125


def calc_employee_period(
    *,
    gross: float,
    contract_type: str = "full",
    include_personfradrag: bool = True,
) -> dict[str, float]:
    """
    Compute one employee's deductions for a single pay period given gross wage.

    Returns dict with keys: gross, am_bidrag, a_skat, atp, feriepenge,
    net_pay, employer_total_cost.

    All values are kr (rounded to 2 decimals). Caller is responsible for
    summing across the period if needed.

    Order of operations matters and matches SKAT's lønsystem rules:
      1. AM-bidrag = 8% of gross (always, no allowance)
      2. Taxable base = gross - AM-bidrag - personfradrag (cannot go negative)
      3. A-skat = taxable_base × ESTIMATED_A_SKAT_RATE
      4. ATP — flat employer contribution (not from gross)
      5. Feriepenge — 12.5% of gross (paid to FerieKonto, not to employee)
      6. Net pay = gross - AM-bidrag - A-skat
      7. Employer total cost = gross + ATP + feriepenge + (any pension)
    """
    gross = max(0.0, float(gross or 0))

    # 1. AM-bidrag
    am_bidrag = round(gross * AM_BIDRAG_RATE, 2)

    # 2. Taxable base
    after_am = gross - am_bidrag
    allowance = PERSONFRADRAG_MONTHLY if include_personfradrag else 0.0
    taxable_base = max(0.0, after_am - allowance)

    # 3. A-skat (estimate)
    a_skat = round(taxable_base * ESTIMATED_A_SKAT_RATE, 2)

    # 4. ATP — only for full-time contracts (part-time get pro-rata, simplified to 0)
    atp = ATP_MONTHLY_FULL_TIME if contract_type == "full" else 0.0

    # 5. Feriepenge
    feriepenge = round(gross * FERIEPENGE_RATE, 2)

    # 6. Net pay (what hits employee's bank)
    net_pay = round(gross - am_bidrag - a_skat, 2)

    # 7. Employer total cost
    employer_total_cost = round(gross + atp + feriepenge, 2)

    return {
        "gross": round(gross, 2),
        "am_bidrag": am_bidrag,
        "a_skat": a_skat,
        "atp": atp,
        "feriepenge": feriepenge,
        "net_pay": net_pay,
        "employer_total_cost": employer_total_cost,
    }


def estimate_period_payroll(
    db: Session,
    user_id: Any,
    period_start: date,
    period_end: date,
) -> dict[str, Any]:
    """
    Estimate total payroll for the user across the period (typically a calendar
    month for monthly A-skat reporting).

    Sums up HoursLogged.earned per staff member, then computes deductions per
    person. Returns aggregate totals + per-staff breakdown.

    If no hours logged: returns zeros (not None — easier to render in UI).
    Defense: wrapped in try/except so a single bad row doesn't break the
    whole estimate.
    """
    try:
        staff_rows = (
            db.query(StaffMember)
            .filter(
                StaffMember.user_id == user_id,
                StaffMember.is_deleted.isnot(True),
                StaffMember.active.is_(True),
            )
            .all()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("payroll: staff query failed: %s", e)
        staff_rows = []

    if not staff_rows:
        return _empty_payroll_summary(period_start, period_end)

    staff_map = {str(s.id): s for s in staff_rows}

    try:
        hours = (
            db.query(HoursLogged)
            .filter(
                HoursLogged.user_id == user_id,
                HoursLogged.date >= period_start,
                HoursLogged.date <= period_end,
                HoursLogged.staff_id.in_(staff_map.keys()),
            )
            .all()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("payroll: hours query failed: %s", e)
        hours = []

    # Aggregate gross per staff
    gross_by_staff: dict[str, float] = {}
    hours_by_staff: dict[str, float] = {}
    for h in hours:
        sid = str(h.staff_id)
        # `earned` is pre-computed by /hours endpoint at log time (rate × hours).
        # If null (legacy rows), fall back to base_rate × total_hours.
        earned = float(h.earned or 0)
        if earned <= 0:
            staff = staff_map.get(sid)
            rate = float(getattr(staff, "base_rate", 0) or 0) if staff else 0
            earned = float(h.total_hours or 0) * rate
        gross_by_staff[sid] = gross_by_staff.get(sid, 0.0) + earned
        hours_by_staff[sid] = hours_by_staff.get(sid, 0.0) + float(h.total_hours or 0)

    # Per-staff breakdown with deductions
    per_staff: list[dict[str, Any]] = []
    totals = {
        "gross": 0.0, "am_bidrag": 0.0, "a_skat": 0.0,
        "atp": 0.0, "feriepenge": 0.0, "net_pay": 0.0,
        "employer_total_cost": 0.0, "hours": 0.0,
    }
    for sid, gross in gross_by_staff.items():
        staff = staff_map[sid]
        deductions = calc_employee_period(
            gross=gross,
            contract_type=str(staff.contract_type or "full"),
        )
        per_staff.append({
            "staff_id": sid,
            "name": staff.name,
            "role": staff.role,
            "contract_type": staff.contract_type,
            "hours": round(hours_by_staff.get(sid, 0.0), 2),
            **deductions,
        })
        for k in totals:
            if k == "hours":
                totals[k] += hours_by_staff.get(sid, 0.0)
            elif k in deductions:
                totals[k] += deductions[k]

    # Round totals
    for k in totals:
        totals[k] = round(totals[k], 2)

    return {
        "period_start": str(period_start),
        "period_end": str(period_end),
        "staff_count": len(per_staff),
        "totals": totals,
        # SKAT-specific subset (what employer must remit)
        "skat_remit": {
            "am_bidrag": totals["am_bidrag"],
            "a_skat": totals["a_skat"],
            "total": round(totals["am_bidrag"] + totals["a_skat"], 2),
        },
        "per_staff": per_staff,
        "rates_used": {
            "am_bidrag": AM_BIDRAG_RATE,
            "a_skat_estimate": ESTIMATED_A_SKAT_RATE,
            "personfradrag_monthly": PERSONFRADRAG_MONTHLY,
            "atp_monthly_full_time": ATP_MONTHLY_FULL_TIME,
            "feriepenge": FERIEPENGE_RATE,
        },
        "is_estimate": True,
        "estimate_note": (
            "A-skat is a flat-rate estimate (38% after personfradrag). Real A-skat "
            "depends on each employee's trækkort and is computed by your lønsystem "
            "or by SKAT directly via eIndkomst. Use this number for planning the "
            "10th-of-month deadline; the official figure comes from your reporting."
        ),
    }


def _empty_payroll_summary(period_start: date, period_end: date) -> dict[str, Any]:
    """Zero-state payroll response — never returns None to keep frontend simple."""
    return {
        "period_start": str(period_start),
        "period_end": str(period_end),
        "staff_count": 0,
        "totals": {k: 0.0 for k in (
            "gross", "am_bidrag", "a_skat", "atp", "feriepenge",
            "net_pay", "employer_total_cost", "hours",
        )},
        "skat_remit": {"am_bidrag": 0.0, "a_skat": 0.0, "total": 0.0},
        "per_staff": [],
        "rates_used": {
            "am_bidrag": AM_BIDRAG_RATE,
            "a_skat_estimate": ESTIMATED_A_SKAT_RATE,
            "personfradrag_monthly": PERSONFRADRAG_MONTHLY,
            "atp_monthly_full_time": ATP_MONTHLY_FULL_TIME,
            "feriepenge": FERIEPENGE_RATE,
        },
        "is_estimate": True,
        "estimate_note": "No staff or hours logged in this period.",
    }
