"""
Automobile Workshop — Vehicles, Job Cards, Parts, Labor, KPIs, Mechanic Insights.

Endpoints:
  Vehicles:
    POST   /api/workshop/vehicles
    GET    /api/workshop/vehicles
    GET    /api/workshop/vehicles/search?plate=
    GET    /api/workshop/vehicles/{id}/history

  Job Cards:
    POST   /api/workshop/jobs
    GET    /api/workshop/jobs
    GET    /api/workshop/jobs/{id}
    PATCH  /api/workshop/jobs/{id}/status
    POST   /api/workshop/jobs/{id}/parts
    POST   /api/workshop/jobs/{id}/labor
    DELETE /api/workshop/jobs/{id}

  Dashboard:
    GET    /api/workshop/summary
    GET    /api/workshop/mechanics
"""

import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.user import User
from app.models.workshop import Vehicle, JobCard, JobCardPart, JobCardLabor
from app.models.inventory import InventoryItem
from app.services.auth import get_current_user

router = APIRouter()


# ═══════════════════════════════════════════════════════════
#  SCHEMAS
# ═══════════════════════════════════════════════════════════

class VehicleCreate(BaseModel):
    plate_number: str
    make: str | None = None
    model: str | None = None
    year: int | None = None
    color: str | None = None
    customer_name: str | None = None
    customer_phone: str | None = None
    customer_address: str | None = None
    customer_type: str = "individual"
    notes: str | None = None
    branch_id: uuid.UUID | None = None

class JobCardCreate(BaseModel):
    vehicle_id: uuid.UUID
    assigned_mechanic: str | None = None
    complaint_description: str | None = None
    estimated_cost: float | None = None
    estimated_completion: date | None = None
    branch_id: uuid.UUID | None = None

class StatusUpdate(BaseModel):
    status: str  # received/diagnosing/waiting_parts/in_progress/completed/delivered/invoiced
    payment_status: str | None = None
    payment_method: str | None = None
    amount_paid: float | None = None
    diagnosis: str | None = None

class PartAdd(BaseModel):
    inventory_item_id: uuid.UUID | None = None
    part_name: str
    part_number: str | None = None
    quantity: float = 1
    unit_cost: float = 0
    is_from_stock: bool = True

class LaborAdd(BaseModel):
    description: str
    mechanic_name: str | None = None
    hours: float = 0
    hourly_rate: float = 0


# ═══════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════

def _vehicle_dict(v: Vehicle) -> dict:
    return {
        "id": v.id, "plate_number": v.plate_number, "make": v.make, "model": v.model,
        "year": v.year, "color": v.color, "customer_name": v.customer_name,
        "customer_phone": v.customer_phone, "customer_address": v.customer_address,
        "customer_type": v.customer_type, "notes": v.notes, "branch_id": v.branch_id,
        "created_at": v.created_at,
    }

def _job_dict(j: JobCard, include_items=False) -> dict:
    d = {
        "id": j.id, "job_number": j.job_number, "vehicle_id": j.vehicle_id,
        "assigned_mechanic": j.assigned_mechanic, "status": j.status,
        "complaint_description": j.complaint_description, "diagnosis": j.diagnosis,
        "estimated_cost": float(j.estimated_cost) if j.estimated_cost else None,
        "final_cost": float(j.final_cost) if j.final_cost else None,
        "received_date": str(j.received_date) if j.received_date else None,
        "estimated_completion": str(j.estimated_completion) if j.estimated_completion else None,
        "completed_date": str(j.completed_date) if j.completed_date else None,
        "delivered_date": str(j.delivered_date) if j.delivered_date else None,
        "invoiced_date": str(j.invoiced_date) if j.invoiced_date else None,
        "payment_status": j.payment_status, "payment_method": j.payment_method,
        "amount_paid": float(j.amount_paid) if j.amount_paid else None,
        "notes": j.notes, "branch_id": j.branch_id, "created_at": j.created_at,
    }
    if include_items:
        d["parts"] = [{
            "id": p.id, "part_name": p.part_name, "part_number": p.part_number,
            "quantity": float(p.quantity), "unit_cost": float(p.unit_cost),
            "total_cost": float(p.total_cost), "is_from_stock": p.is_from_stock,
            "inventory_item_id": p.inventory_item_id,
        } for p in (j.parts or [])]
        d["labor"] = [{
            "id": l.id, "description": l.description, "mechanic_name": l.mechanic_name,
            "hours": float(l.hours), "hourly_rate": float(l.hourly_rate),
            "total_cost": float(l.total_cost),
        } for l in (j.labor or [])]
        d["parts_total"] = round(sum(float(p.total_cost) for p in (j.parts or [])), 2)
        d["labor_total"] = round(sum(float(l.total_cost) for l in (j.labor or [])), 2)
        d["grand_total"] = d["parts_total"] + d["labor_total"]
    # Include vehicle info if loaded
    if j.vehicle:
        d["vehicle"] = {
            "plate_number": j.vehicle.plate_number, "make": j.vehicle.make,
            "model": j.vehicle.model, "color": j.vehicle.color,
            "customer_name": j.vehicle.customer_name, "customer_phone": j.vehicle.customer_phone,
        }
    return d

def _next_job_number(db: Session, user_id) -> str:
    last = (
        db.query(JobCard.job_number)
        .filter(JobCard.user_id == user_id)
        .order_by(JobCard.created_at.desc())
        .first()
    )
    if last and last[0]:
        try:
            num = int(last[0].split("-")[-1]) + 1
        except ValueError:
            num = 1
    else:
        num = 1
    return f"JOB-{num:04d}"


# ═══════════════════════════════════════════════════════════
#  VEHICLES
# ═══════════════════════════════════════════════════════════

@router.post("/vehicles")
def create_vehicle(
    data: VehicleCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    existing = db.query(Vehicle).filter(
        Vehicle.user_id == user.id, Vehicle.plate_number == data.plate_number.upper(),
        Vehicle.is_deleted.isnot(True),
    ).first()
    if existing:
        raise HTTPException(400, f"Vehicle with plate {data.plate_number} already exists")

    v = Vehicle(user_id=user.id, **data.model_dump())
    v.plate_number = v.plate_number.upper()
    db.add(v)
    db.commit()
    db.refresh(v)
    return _vehicle_dict(v)


@router.get("/vehicles")
def list_vehicles(
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    vehicles = db.query(Vehicle).filter(
        Vehicle.user_id == user.id, Vehicle.is_deleted.isnot(True),
    ).order_by(Vehicle.created_at.desc()).limit(100).all()
    return [_vehicle_dict(v) for v in vehicles]


@router.get("/vehicles/search")
def search_vehicles(
    plate: str = Query(""), q: str = Query(""),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    search = (plate or q).upper().strip()
    if not search:
        return []
    vehicles = db.query(Vehicle).filter(
        Vehicle.user_id == user.id, Vehicle.is_deleted.isnot(True),
        Vehicle.plate_number.contains(search),
    ).limit(10).all()
    return [_vehicle_dict(v) for v in vehicles]


@router.get("/vehicles/{vehicle_id}/history")
def vehicle_history(
    vehicle_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.user_id == user.id).first()
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")

    jobs = (
        db.query(JobCard)
        .options(joinedload(JobCard.parts), joinedload(JobCard.labor))
        .filter(JobCard.vehicle_id == vehicle_id, JobCard.user_id == user.id, JobCard.is_deleted.isnot(True))
        .order_by(JobCard.received_date.desc())
        .all()
    )
    return {
        "vehicle": _vehicle_dict(vehicle),
        "service_history": [_job_dict(j, include_items=True) for j in jobs],
        "total_jobs": len(jobs),
        "total_spent": round(sum(
            sum(float(p.total_cost) for p in j.parts) + sum(float(l.total_cost) for l in j.labor)
            for j in jobs
        ), 2),
    }


# ═══════════════════════════════════════════════════════════
#  JOB CARDS
# ═══════════════════════════════════════════════════════════

@router.post("/jobs")
def create_job(
    data: JobCardCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    vehicle = db.query(Vehicle).filter(Vehicle.id == data.vehicle_id, Vehicle.user_id == user.id).first()
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")

    job = JobCard(
        user_id=user.id,
        job_number=_next_job_number(db, user.id),
        vehicle_id=data.vehicle_id,
        branch_id=data.branch_id,
        assigned_mechanic=data.assigned_mechanic,
        complaint_description=data.complaint_description,
        estimated_cost=data.estimated_cost,
        estimated_completion=data.estimated_completion,
        received_date=date.today(),
        status="received",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    job.vehicle = vehicle
    return _job_dict(job, include_items=True)


@router.get("/jobs")
def list_jobs(
    status: str = Query(None), mechanic: str = Query(None),
    from_date: date = Query(None, alias="from"), to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    q = (
        db.query(JobCard)
        .options(joinedload(JobCard.vehicle), joinedload(JobCard.parts), joinedload(JobCard.labor))
        .filter(JobCard.user_id == user.id, JobCard.is_deleted.isnot(True))
    )
    if status:
        q = q.filter(JobCard.status == status)
    if mechanic:
        q = q.filter(JobCard.assigned_mechanic.ilike(f"%{mechanic}%"))
    if from_date:
        q = q.filter(JobCard.received_date >= from_date)
    if to_date:
        q = q.filter(JobCard.received_date <= to_date)

    jobs = q.order_by(JobCard.created_at.desc()).limit(100).all()
    return [_job_dict(j, include_items=True) for j in jobs]


@router.get("/jobs/{job_id}")
def get_job(
    job_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    job = (
        db.query(JobCard)
        .options(joinedload(JobCard.vehicle), joinedload(JobCard.parts), joinedload(JobCard.labor))
        .filter(JobCard.id == job_id, JobCard.user_id == user.id)
        .first()
    )
    if not job:
        raise HTTPException(404, "Job card not found")
    return _job_dict(job, include_items=True)


@router.patch("/jobs/{job_id}/status")
def update_job_status(
    job_id: str, data: StatusUpdate,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    job = db.query(JobCard).filter(JobCard.id == job_id, JobCard.user_id == user.id).first()
    if not job:
        raise HTTPException(404, "Job card not found")

    job.status = data.status
    today = date.today()
    if data.status == "completed" and not job.completed_date:
        job.completed_date = today
    elif data.status == "delivered" and not job.delivered_date:
        job.delivered_date = today
    elif data.status == "invoiced" and not job.invoiced_date:
        job.invoiced_date = today
        # Calculate final cost
        parts_total = sum(float(p.total_cost) for p in job.parts) if job.parts else 0
        labor_total = sum(float(l.total_cost) for l in job.labor) if job.labor else 0
        job.final_cost = round(parts_total + labor_total, 2)

    if data.diagnosis:
        job.diagnosis = data.diagnosis
    if data.payment_status:
        job.payment_status = data.payment_status
    if data.payment_method:
        job.payment_method = data.payment_method
    if data.amount_paid is not None:
        job.amount_paid = data.amount_paid

    db.commit()
    db.refresh(job)
    return {"status": job.status, "id": job.id}


@router.post("/jobs/{job_id}/parts")
def add_part(
    job_id: str, data: PartAdd,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    job = db.query(JobCard).filter(JobCard.id == job_id, JobCard.user_id == user.id).first()
    if not job:
        raise HTTPException(404, "Job card not found")

    total = round(data.quantity * data.unit_cost, 2)
    part = JobCardPart(
        job_card_id=job.id,
        inventory_item_id=data.inventory_item_id,
        part_name=data.part_name,
        part_number=data.part_number,
        quantity=data.quantity,
        unit_cost=data.unit_cost,
        total_cost=total,
        is_from_stock=data.is_from_stock,
    )
    db.add(part)

    # Deduct from inventory if from stock
    if data.is_from_stock and data.inventory_item_id:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == data.inventory_item_id, InventoryItem.user_id == user.id,
        ).first()
        if item:
            item.quantity = max(0, float(item.quantity or 0) - data.quantity)

    db.commit()
    return {"id": part.id, "total_cost": total}


@router.post("/jobs/{job_id}/labor")
def add_labor(
    job_id: str, data: LaborAdd,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    job = db.query(JobCard).filter(JobCard.id == job_id, JobCard.user_id == user.id).first()
    if not job:
        raise HTTPException(404, "Job card not found")

    total = round(data.hours * data.hourly_rate, 2)
    labor = JobCardLabor(
        job_card_id=job.id,
        description=data.description,
        mechanic_name=data.mechanic_name or job.assigned_mechanic,
        hours=data.hours,
        hourly_rate=data.hourly_rate,
        total_cost=total,
    )
    db.add(labor)
    db.commit()
    return {"id": labor.id, "total_cost": total}


@router.delete("/jobs/{job_id}", status_code=204)
def delete_job(
    job_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    job = db.query(JobCard).filter(JobCard.id == job_id, JobCard.user_id == user.id).first()
    if not job:
        raise HTTPException(404, "Job card not found")
    job.is_deleted = True
    job.deleted_at = datetime.utcnow()
    db.commit()


# ═══════════════════════════════════════════════════════════
#  WORKSHOP SUMMARY / KPIs (Step 3)
# ═══════════════════════════════════════════════════════════

@router.get("/summary")
def workshop_summary(
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    today = date.today()
    week_ago = today - timedelta(days=7)
    month_ago = today - timedelta(days=30)

    # Only load jobs from the last 90 days + anything still in workshop
    cutoff = today - timedelta(days=90)
    all_active = (
        db.query(JobCard)
        .options(joinedload(JobCard.vehicle), joinedload(JobCard.parts), joinedload(JobCard.labor))
        .filter(
            JobCard.user_id == user.id,
            JobCard.is_deleted.isnot(True),
            (JobCard.status.notin_(["delivered", "invoiced"])) | (JobCard.created_at >= cutoff),
        )
        .all()
    )

    # Vehicles currently in workshop
    in_workshop = [j for j in all_active if j.status not in ("delivered", "invoiced")]
    status_counts = defaultdict(int)
    for j in in_workshop:
        status_counts[j.status] += 1

    # Jobs completed today/week
    completed_today = sum(1 for j in all_active if j.completed_date == today)
    completed_week = sum(1 for j in all_active if j.completed_date and j.completed_date >= week_ago)

    # Revenue this week (invoiced jobs)
    week_invoiced = [j for j in all_active if j.invoiced_date and j.invoiced_date >= week_ago]
    week_revenue = sum(float(j.final_cost or 0) for j in week_invoiced)

    # Parts vs labor revenue (last 30 days)
    month_jobs = [j for j in all_active if j.invoiced_date and j.invoiced_date >= month_ago]
    parts_revenue = sum(sum(float(p.total_cost) for p in j.parts) for j in month_jobs)
    labor_revenue = sum(sum(float(l.total_cost) for l in j.labor) for j in month_jobs)

    # Avg job value (last 30 days)
    month_completed = [j for j in all_active if j.completed_date and j.completed_date >= month_ago]
    avg_job_value = round(
        sum(sum(float(p.total_cost) for p in j.parts) + sum(float(l.total_cost) for l in j.labor) for j in month_completed) / max(len(month_completed), 1), 2
    )

    # Outstanding payments
    unpaid_jobs = [j for j in all_active if j.status == "invoiced" and j.payment_status != "paid"]
    outstanding = sum(float(j.final_cost or 0) - float(j.amount_paid or 0) for j in unpaid_jobs)

    # Avg turnaround
    turnaround_days = []
    for j in all_active:
        if j.received_date and j.delivered_date:
            turnaround_days.append((j.delivered_date - j.received_date).days)
    avg_turnaround = round(sum(turnaround_days) / max(len(turnaround_days), 1), 1) if turnaround_days else None

    # Alerts
    alerts = []
    three_days_ago = today - timedelta(days=3)
    stale_waiting = [j for j in in_workshop if j.status == "waiting_parts" and j.received_date and j.received_date <= three_days_ago]
    if stale_waiting:
        alerts.append({
            "type": "stale_parts", "icon": "⚠️",
            "title": f"{len(stale_waiting)} job(s) waiting for parts over 3 days",
            "jobs": [j.job_number for j in stale_waiting[:5]],
        })
    if outstanding > 0:
        alerts.append({
            "type": "outstanding", "icon": "💸",
            "title": f"Outstanding payments: {outstanding:,.0f}",
            "count": len(unpaid_jobs),
        })

    return {
        "vehicles_in_workshop": len(in_workshop),
        "status_breakdown": dict(status_counts),
        "completed_today": completed_today,
        "completed_this_week": completed_week,
        "week_revenue": round(week_revenue, 2),
        "parts_revenue_30d": round(parts_revenue, 2),
        "labor_revenue_30d": round(labor_revenue, 2),
        "avg_job_value": avg_job_value,
        "outstanding_payments": round(outstanding, 2),
        "avg_turnaround_days": avg_turnaround,
        "total_jobs": len(all_active),
        "alerts": alerts,
    }


# ═══════════════════════════════════════════════════════════
#  MECHANIC PERFORMANCE (Step 5)
# ═══════════════════════════════════════════════════════════

@router.get("/mechanics")
def mechanic_insights(
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    month_ago = date.today() - timedelta(days=30)

    labor_entries = (
        db.query(JobCardLabor)
        .join(JobCard)
        .filter(JobCard.user_id == user.id, JobCard.is_deleted.isnot(True), JobCardLabor.created_at >= month_ago)
        .all()
    )

    by_mechanic = defaultdict(lambda: {"hours": 0, "revenue": 0, "jobs": set()})
    for l in labor_entries:
        name = l.mechanic_name or "Unknown"
        by_mechanic[name]["hours"] += float(l.hours)
        by_mechanic[name]["revenue"] += float(l.total_cost)
        by_mechanic[name]["jobs"].add(l.job_card_id)

    result = []
    for name, data in by_mechanic.items():
        jobs = len(data["jobs"])
        hours = round(data["hours"], 1)
        revenue = round(data["revenue"], 2)
        result.append({
            "name": name,
            "total_jobs": jobs,
            "total_hours": hours,
            "total_revenue": revenue,
            "revenue_per_hour": round(revenue / max(hours, 1), 2),
            "avg_hours_per_job": round(hours / max(jobs, 1), 1),
        })

    result.sort(key=lambda x: x["total_revenue"], reverse=True)

    # Generate insight text
    insight = None
    if len(result) >= 2:
        top = result[0]
        bottom = result[-1]
        if bottom["revenue_per_hour"] > 0:
            mult = round(top["revenue_per_hour"] / bottom["revenue_per_hour"], 1)
            insight = (
                f"{top['name']} completed {top['total_jobs']} jobs this month "
                f"(avg {top['avg_hours_per_job']}h each). "
                f"{bottom['name']} completed {bottom['total_jobs']} jobs "
                f"(avg {bottom['avg_hours_per_job']}h each). "
                f"{top['name']} generates {mult}x more revenue per hour."
            )

    return {"mechanics": result, "insight": insight, "period": "last_30_days"}
