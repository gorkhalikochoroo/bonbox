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
#
# Owner can override per-staff via StaffMember.tax_card_type / tax_card_rate
# (added 2026-05). Defaults below are used when not set:
#   hovedkort  → 36% (main job, includes personfradrag)
#   bikort     → 42% (second job, NO personfradrag)
#   frikort    → 0%  (student under annual income limit)
DEFAULT_A_SKAT_RATE = 0.36
TAX_CARD_DEFAULT_RATES = {
    "hovedkort": 0.36,
    "bikort":    0.42,
    "frikort":   0.00,
}
ESTIMATED_A_SKAT_RATE = DEFAULT_A_SKAT_RATE  # backwards-compat alias

# Personal allowance (personfradrag) — monthly equivalent.
# 2026 personfradrag ≈ 52,800 kr/year ÷ 12 ≈ 4,400 kr/month.
PERSONFRADRAG_MONTHLY = 4400.0

# ATP (Arbejdsmarkedets Tillægspension) — FIXED kroner (not a %), and tiered
# by ATP-pligtige hours worked in the month (monthly-paid satser):
#   ≥117 t → fuldt bidrag · 78–116 t → 2/3 · 39–77 t → 1/3 · <39 t → 0.
# Full monthly contribution ("A-sats") ≈ 284 kr, split 1/3 employee
# (≈94,65 kr, WITHHELD from pay) + 2/3 employer (≈189,30 kr, ON TOP of pay).
ATP_FULL_MONTHLY_TOTAL = 284.0
ATP_EMPLOYEE_FRACTION = 1.0 / 3.0
# Back-compat alias — this used to be the (mislabelled) "full time" constant;
# it is in fact the employee 1/3 share of the full monthly contribution.
ATP_MONTHLY_FULL_TIME = round(ATP_FULL_MONTHLY_TOTAL * ATP_EMPLOYEE_FRACTION, 2)

# Feriepenge — "ny ferielov" (2020+):
#   • Timelønnede (hourly): 12,5% of gross to FerieKonto.
#   • Funktionærer (fast månedsløn): ferie med løn + 1% ferietillæg.
# BonBox pays everyone by logged hours × rate (the timelønnet model), so 12,5%
# is the default; callers pass funktionaer=True to switch to the 1% ferietillæg.
FERIEPENGE_RATE = 0.125
FERIETILLAEG_RATE = 0.01


def _atp_total_for_hours(hours: float) -> float:
    """Full monthly ATP contribution (employee + employer) for the hours
    worked in the month. ATP is hours-tiered, NOT contract-type based."""
    h = float(hours or 0)
    if h >= 117:
        frac = 1.0
    elif h >= 78:
        frac = 2.0 / 3.0
    elif h >= 39:
        frac = 1.0 / 3.0
    else:
        frac = 0.0
    return round(ATP_FULL_MONTHLY_TOTAL * frac, 2)


def _resolve_a_skat_rate(
    tax_card_type: str | None,
    tax_card_rate: float | None,
) -> tuple[float, str, bool]:
    """
    Multi-barrier resolution of the A-skat rate to use, with each layer
    failing-closed to the safe DEFAULT_A_SKAT_RATE if input is bad.

      Layer 1: explicit per-staff rate override (clamped to 0.0-0.6)
      Layer 2: trækkort type default (hovedkort/bikort/frikort)
      Layer 3: fall back to DEFAULT_A_SKAT_RATE (36%, hovedkort default)

    Bikort = no personfradrag — caller must check the second return value
    and pass include_personfradrag accordingly.

    Returns (rate, source_label, include_personfradrag).
    """
    # Layer 1: explicit override
    if tax_card_rate is not None:
        try:
            r = float(tax_card_rate)
            # Sanity-clamp: 0 ≤ r ≤ 0.6 (no Danish A-skat exceeds ~52% incl topskat)
            if 0.0 <= r <= 0.6:
                # Owner-supplied rate. We assume hovedkort (with personfradrag)
                # unless the trækkort type explicitly says otherwise.
                include_pf = (tax_card_type != "bikort")
                return (r, "override", include_pf)
        except (TypeError, ValueError):
            pass  # fall through to layer 2

    # Layer 2: trækkort-type default
    if tax_card_type and isinstance(tax_card_type, str):
        normalized = tax_card_type.strip().lower()
        if normalized in TAX_CARD_DEFAULT_RATES:
            rate = TAX_CARD_DEFAULT_RATES[normalized]
            # Frikort + bikort have no personfradrag; only hovedkort does
            include_pf = (normalized == "hovedkort")
            return (rate, normalized, include_pf)

    # Layer 3: safe default (hovedkort)
    return (DEFAULT_A_SKAT_RATE, "default-hovedkort", True)


def calc_employee_period(
    *,
    gross: float,
    hours: float = 0.0,
    contract_type: str = "full",
    funktionaer: bool = False,
    tax_card_type: str | None = None,
    tax_card_rate: float | None = None,
    include_personfradrag: bool | None = None,  # legacy param; auto-derived if None
) -> dict[str, float]:
    """
    Compute one employee's deductions for a single pay period given gross wage.

    Returns dict with keys: gross, am_bidrag, a_skat, atp, feriepenge,
    net_pay, employer_total_cost, plus tax_card_source (which layer was
    used) so the UI can show "estimat" badges accurately.

    All values are kr (rounded to 2 decimals). Caller is responsible for
    summing across the period if needed.

    Order of operations matches SKAT's lønsystem rules:
      1. AM-bidrag = 8% of gross (always, no allowance)
      2. Resolve A-skat rate from per-staff trækkort (or default)
      3. Taxable base = gross - AM-bidrag - personfradrag (cannot go negative)
         — personfradrag only for hovedkort, NOT for bikort/frikort
      4. A-skat = taxable_base × resolved_rate
      5. ATP — flat employer contribution (not from gross)
      6. Feriepenge — 12.5% of gross (paid to FerieKonto, not to employee)
      7. Net pay = gross - AM-bidrag - A-skat
      8. Employer total cost = gross + ATP + feriepenge + (any pension)
    """
    gross = max(0.0, float(gross or 0))

    # 1. AM-bidrag (8% always, no allowance)
    am_bidrag = round(gross * AM_BIDRAG_RATE, 2)

    # 2. Resolve A-skat rate (multi-barrier defense — see _resolve_a_skat_rate)
    a_skat_rate, rate_source, default_include_pf = _resolve_a_skat_rate(
        tax_card_type, tax_card_rate
    )
    # Honor explicit `include_personfradrag` arg if caller set it (legacy
    # callers / tests). Otherwise derive from trækkort type.
    if include_personfradrag is None:
        include_personfradrag = default_include_pf

    # 3. Taxable base
    after_am = gross - am_bidrag
    allowance = PERSONFRADRAG_MONTHLY if include_personfradrag else 0.0
    taxable_base = max(0.0, after_am - allowance)

    # 4. A-skat
    a_skat = round(taxable_base * a_skat_rate, 2)

    # 5. ATP — fixed kroner, tiered by hours worked this month. Split into the
    #    employee 1/3 (withheld from pay) and employer 2/3 (paid on top).
    atp_total = _atp_total_for_hours(hours)
    atp_employee = round(atp_total * ATP_EMPLOYEE_FRACTION, 2)
    atp_employer = round(atp_total - atp_employee, 2)

    # 6. Feriepenge — 12,5% to FerieKonto (timelønnet) or 1% ferietillæg (funktionær)
    ferie_rate = FERIETILLAEG_RATE if funktionaer else FERIEPENGE_RATE
    feriepenge = round(gross * ferie_rate, 2)

    # 7. Net pay (what hits the employee's bank) — gross minus AM-bidrag, A-skat
    #    AND the employee's own ATP share.
    net_pay = round(gross - am_bidrag - a_skat - atp_employee, 2)

    # 8. Employer total cost — gross + EMPLOYER ATP share + feriepenge
    employer_total_cost = round(gross + atp_employer + feriepenge, 2)

    return {
        "gross": round(gross, 2),
        "am_bidrag": am_bidrag,
        "a_skat": a_skat,
        "a_skat_rate": a_skat_rate,
        "tax_card_source": rate_source,
        "include_personfradrag": include_personfradrag,
        # "atp" = the employer contribution (what shows under Arbejdsgivers
        # bidrag); the splits are exposed separately for the lønseddel.
        "atp": atp_employer,
        "atp_employee": atp_employee,
        "atp_employer": atp_employer,
        "atp_total": atp_total,
        "feriepenge": feriepenge,
        "feriepenge_rate": ferie_rate,
        "feriepenge_is_funktionaer": bool(funktionaer),
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
        # Pull trækkort overrides if present on the staff record. Wrapped in
        # getattr so the service is forward/backward compatible during the
        # migration window — stale rows without these columns just fall back
        # to default-hovedkort (36%, includes personfradrag).
        tax_card_type = getattr(staff, "tax_card_type", None)
        tax_card_rate = getattr(staff, "tax_card_rate", None)
        deductions = calc_employee_period(
            gross=gross,
            hours=hours_by_staff.get(sid, 0.0),
            contract_type=str(staff.contract_type or "full"),
            tax_card_type=tax_card_type,
            tax_card_rate=float(tax_card_rate) if tax_card_rate is not None else None,
        )
        per_staff.append({
            "staff_id": sid,
            "name": staff.name,
            "role": staff.role,
            "contract_type": staff.contract_type,
            "tax_card_type": tax_card_type or "hovedkort",
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
            "A-skat varies per employee — typical hovedkort is ~36% after "
            "personfradrag, bikort is ~42% (no personfradrag), frikort is 0% "
            "until the annual limit. BonBox uses each staff member's trækkort "
            "type when set, otherwise defaults to hovedkort. The official A-skat "
            "comes from each employee's eSkattekort and your lønsystem's "
            "eIndkomst submission — use this estimate for planning the "
            "10th-of-month deadline only."
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
