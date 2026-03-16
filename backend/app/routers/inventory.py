from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem, InventoryLog
from app.schemas.inventory import (
    InventoryItemCreate, InventoryItemUpdate, InventoryItemResponse,
    InventoryLogCreate, InventoryLogResponse,
)
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[InventoryItemResponse])
def list_items(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return db.query(InventoryItem).filter(InventoryItem.user_id == user.id).all()


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
