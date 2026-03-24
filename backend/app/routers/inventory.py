from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem, InventoryLog, InventoryTemplate
from app.schemas.inventory import (
    InventoryItemCreate, InventoryItemUpdate, InventoryItemResponse,
    InventoryLogCreate, InventoryLogResponse,
    TemplateResponse, TemplateLoadRequest,
)
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[InventoryItemResponse])
def list_items(
    category: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(InventoryItem).filter(InventoryItem.user_id == user.id)
    if category and category != "All":
        query = query.filter(InventoryItem.category == category)
    return query.all()


@router.get("/categories", response_model=list[str])
def list_categories(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        db.query(InventoryItem.category)
        .filter(InventoryItem.user_id == user.id)
        .distinct()
        .all()
    )
    return sorted(set(r[0] or "General" for r in rows))


@router.get("/expiring", response_model=list[InventoryItemResponse])
def get_expiring(
    days: int = Query(3),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cutoff = date.today() + timedelta(days=days)
    return (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.expiry_date != None,
            InventoryItem.expiry_date <= cutoff,
        )
        .all()
    )


@router.post("", response_model=InventoryItemResponse, status_code=201)
def create_item(
    data: InventoryItemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = InventoryItem(user_id=user.id, **data.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}", response_model=InventoryItemResponse)
def update_item(
    item_id: str,
    data: InventoryItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
def delete_item(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.query(InventoryLog).filter(InventoryLog.item_id == item_id).delete()
    db.delete(item)
    db.commit()


@router.get("/alerts", response_model=list[InventoryItemResponse])
def get_alerts(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .all()
    )


@router.post("/logs", response_model=InventoryLogResponse, status_code=201)
def create_log(
    data: InventoryLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == data.item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    log = InventoryLog(**data.model_dump())
    item.quantity = float(item.quantity) + data.change_qty
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


# ── Templates ──────────────────────────────────────────────

@router.get("/templates", response_model=list[TemplateResponse])
def list_templates(
    template_type: str = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    query = db.query(InventoryTemplate)
    if template_type:
        query = query.filter(InventoryTemplate.template_type == template_type)
    return query.all()


@router.post("/templates/load", response_model=list[InventoryItemResponse], status_code=201)
def load_template(
    data: TemplateLoadRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    templates = (
        db.query(InventoryTemplate)
        .filter(InventoryTemplate.template_type == data.template_type)
        .all()
    )
    if not templates:
        raise HTTPException(status_code=404, detail="Template not found")

    created = []
    for t in templates:
        existing = db.query(InventoryItem).filter(
            InventoryItem.user_id == user.id,
            InventoryItem.name == t.item_name,
        ).first()
        if existing:
            continue
        item = InventoryItem(
            user_id=user.id,
            name=t.item_name,
            quantity=0,
            unit=t.default_unit,
            cost_per_unit=0,
            min_threshold=t.default_reorder_level,
            category=t.default_category,
            is_perishable=t.is_perishable,
        )
        db.add(item)
        created.append(item)

    db.commit()
    for item in created:
        db.refresh(item)
    return created
