import csv
import io
import os
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from fastapi.responses import FileResponse
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.schemas.sale import SaleCreate, SaleUpdate, SaleResponse
from app.services.auth import get_current_user
from app.services.receipt_ocr import extract_amount_from_image, save_receipt_photo
from app.services.cash_sync import sync_cash_in_for_sale, delete_cash_entry_by_ref, update_cash_entry_for_ref

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("", response_model=list[SaleResponse])
def list_sales(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(Sale).filter(Sale.user_id == user.id).filter(Sale.is_deleted.isnot(True))
    if from_date:
        query = query.filter(Sale.date >= from_date)
    if to_date:
        query = query.filter(Sale.date <= to_date)
    return query.order_by(Sale.date.desc(), Sale.created_at.desc()).all()


@router.get("/recently-deleted", response_model=list[SaleResponse])
def list_deleted_sales(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    return db.query(Sale).filter(Sale.user_id == user.id, Sale.is_deleted == True).order_by(Sale.deleted_at.desc()).all()


@router.put("/{sale_id}/restore", response_model=SaleResponse)
def restore_sale(
    sale_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    sale = db.query(Sale).filter(Sale.id == sale_id, Sale.user_id == user.id, Sale.is_deleted == True).first()
    if not sale:
        raise HTTPException(status_code=404, detail="Deleted sale not found")
    sale.is_deleted = False
    sale.deleted_at = None
    if sale.payment_method == "cash":
        sync_cash_in_for_sale(db, sale)
    db.commit()
    db.refresh(sale)
    return sale


@router.delete("/{sale_id}/permanent", status_code=204)
def permanent_delete_sale(
    sale_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    sale = db.query(Sale).filter(Sale.id == sale_id, Sale.user_id == user.id, Sale.is_deleted == True).first()
    if not sale:
        raise HTTPException(status_code=404, detail="Deleted sale not found")
    db.delete(sale)
    db.commit()


@router.post("", response_model=SaleResponse, status_code=201)
def create_sale(
    data: SaleCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    sale = Sale(user_id=user.id, **data.model_dump())
    db.add(sale)
    db.commit()
    db.refresh(sale)
    if sale.payment_method == "cash":
        sync_cash_in_for_sale(db, sale)
        db.commit()
        db.refresh(sale)
    return sale


@router.put("/{sale_id}", response_model=SaleResponse)
def update_sale(
    sale_id: str,
    data: SaleUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    sale = db.query(Sale).filter(Sale.id == sale_id, Sale.user_id == user.id).first()
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")
    old_method = sale.payment_method
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(sale, field, value)
    ref_id = f"sale_{sale.id}"
    if old_method == "cash" and sale.payment_method != "cash":
        delete_cash_entry_by_ref(db, ref_id, user.id)
    elif old_method != "cash" and sale.payment_method == "cash":
        sync_cash_in_for_sale(db, sale)
    elif sale.payment_method == "cash":
        update_cash_entry_for_ref(db, ref_id, user.id, amount=float(sale.amount), date=sale.date)
    db.commit()
    db.refresh(sale)
    return sale


@router.delete("/{sale_id}", status_code=204)
def delete_sale(
    sale_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    sale = db.query(Sale).filter(Sale.id == sale_id, Sale.user_id == user.id).first()
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")
    if sale.payment_method == "cash":
        delete_cash_entry_by_ref(db, f"sale_{sale.id}", user.id)
    sale.is_deleted = True
    sale.deleted_at = datetime.utcnow()
    db.commit()


@router.post("/repeat-yesterday", response_model=SaleResponse, status_code=201)
def repeat_yesterday(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Copy yesterday's sale as today's entry — one tap."""
    yesterday = date.today() - timedelta(days=1)
    last_sale = (
        db.query(Sale)
        .filter(Sale.user_id == user.id, Sale.date == yesterday)
        .filter(Sale.is_deleted.isnot(True))
        .order_by(Sale.created_at.desc())
        .first()
    )
    if not last_sale:
        raise HTTPException(status_code=404, detail="No sale found for yesterday")

    sale = Sale(
        user_id=user.id,
        date=date.today(),
        amount=last_sale.amount,
        payment_method=last_sale.payment_method,
        notes="Repeated from yesterday",
    )
    db.add(sale)
    db.commit()
    db.refresh(sale)
    if sale.payment_method == "cash":
        sync_cash_in_for_sale(db, sale)
        db.commit()
        db.refresh(sale)
    return sale


@router.post("/import-csv")
@limiter.limit("10/minute")
async def import_csv(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import sales from CSV. Expects columns: date, amount, payment_method (optional)."""
    # Validate file type
    if file.content_type not in ("text/csv", "application/vnd.ms-excel", "text/plain"):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload a CSV file.")

    content = await file.read()

    # Validate file size
    if len(content) > MAX_CSV_SIZE:
        raise HTTPException(status_code=413, detail="CSV too large. Maximum size is 2 MB.")
    text = content.decode("utf-8-sig")  # handles BOM from Excel
    reader = csv.DictReader(io.StringIO(text))

    # Normalize column names (lowercase, strip whitespace)
    imported = 0
    errors = []
    for i, row in enumerate(reader, start=2):
        row = {k.strip().lower(): v.strip() for k, v in row.items() if k}
        try:
            sale_date = row.get("date", "")
            amount = row.get("amount", "") or row.get("revenue", "") or row.get("total", "")
            method = row.get("payment_method", "") or row.get("payment", "") or "mixed"

            if not sale_date or not amount:
                errors.append(f"Row {i}: missing date or amount")
                continue

            sale = Sale(
                user_id=user.id,
                date=date.fromisoformat(sale_date),
                amount=float(amount.replace(",", "")),
                payment_method=method if method in ("cash", "card", "mobilepay", "mixed", "dankort", "kontant") else "mixed",
                notes="CSV import",
            )
            db.add(sale)
            imported += 1
        except Exception as e:
            errors.append(f"Row {i}: {str(e)}")

    db.commit()
    return {"imported": imported, "errors": errors}


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif"}
MAX_UPLOAD_SIZE = 5 * 1024 * 1024  # 5 MB
MAX_CSV_SIZE = 2 * 1024 * 1024  # 2 MB


@router.post("/upload-receipt")
@limiter.limit("10/minute")
async def upload_receipt(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a receipt photo. OCR extracts the total amount for confirmation."""
    # Validate file type
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file.content_type}'. Allowed: JPEG, PNG, GIF, WebP, HEIC",
        )

    content = await file.read()

    # Validate file size
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 5 MB.")
    # save_receipt_photo saves locally + uploads to Supabase, returns URL or local path
    stored_path = save_receipt_photo(content, file.filename, str(user.id))

    # OCR needs local file — find it in uploads dir
    import glob
    local_files = sorted(glob.glob(f"uploads/receipts/{user.id}_*"), key=os.path.getmtime, reverse=True)
    local_path = local_files[0] if local_files else stored_path

    result = extract_amount_from_image(local_path)
    return {
        "filepath": stored_path,
        "suggested_amount": result["suggested_amount"],
        "all_amounts_found": result["all_amounts_found"],
        "ocr_available": result["ocr_available"],
    }


@router.post("/from-receipt", response_model=SaleResponse, status_code=201)
def create_sale_from_receipt(
    amount: float = Query(...),
    receipt_path: str = Query(...),
    payment_method: str = Query("mixed"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a sale from a confirmed receipt upload."""
    sale = Sale(
        user_id=user.id,
        date=date.today(),
        amount=amount,
        payment_method=payment_method,
        receipt_photo=receipt_path,
        notes="From receipt photo",
    )
    db.add(sale)
    db.commit()
    db.refresh(sale)
    if sale.payment_method == "cash":
        sync_cash_in_for_sale(db, sale)
        db.commit()
        db.refresh(sale)
    return sale


@router.get("/weekly-report")
def weekly_report(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Instant weekly summary — ready to screenshot or share."""
    today = date.today()
    week_start = today - timedelta(days=today.weekday())  # Monday
    week_end = week_start + timedelta(days=6)  # Sunday

    # Previous week for comparison
    prev_start = week_start - timedelta(days=7)
    prev_end = week_start - timedelta(days=1)

    # This week's daily breakdown
    daily = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(week_start, week_end))
        .filter(Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    week_total = sum(float(t) for _, t in daily)

    prev_total = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(prev_start, prev_end))
        .filter(Sale.is_deleted.isnot(True))
        .scalar()
    )

    change_pct = 0.0
    if prev_total > 0:
        change_pct = round(((week_total - prev_total) / prev_total) * 100, 1)

    best = max(daily, key=lambda r: float(r.total), default=None)
    worst = min(daily, key=lambda r: float(r.total), default=None)

    day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    return {
        "week_start": str(week_start),
        "week_end": str(week_end),
        "total_revenue": week_total,
        "prev_week_total": prev_total,
        "change_pct": change_pct,
        "daily_avg": round(week_total / max(len(daily), 1), 2),
        "days_recorded": len(daily),
        "best_day": {"date": str(best.date), "day": day_names[best.date.weekday()], "amount": float(best.total)} if best else None,
        "worst_day": {"date": str(worst.date), "day": day_names[worst.date.weekday()], "amount": float(worst.total)} if worst else None,
        "daily_breakdown": [
            {"date": str(d), "day": day_names[d.weekday()], "amount": float(t)}
            for d, t in daily
        ],
        "business_name": user.business_name,
        "currency": user.currency,
    }


@router.get("/latest", response_model=SaleResponse | None)
def get_latest_sale(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the most recent sale for showing in quick-entry."""
    return (
        db.query(Sale)
        .filter(Sale.user_id == user.id)
        .filter(Sale.is_deleted.isnot(True))
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .first()
    )


@router.get("/receipts")
def list_receipt_sales(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List recent sales that have receipt photos attached."""
    sales = (
        db.query(Sale)
        .filter(Sale.user_id == user.id, Sale.receipt_photo.isnot(None))
        .filter(Sale.is_deleted.isnot(True))
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .limit(20)
        .all()
    )
    return [
        {
            "id": str(s.id),
            "date": str(s.date),
            "amount": float(s.amount),
            "payment_method": s.payment_method,
            "receipt_photo": s.receipt_photo,
        }
        for s in sales
    ]
