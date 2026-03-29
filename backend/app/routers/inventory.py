from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem, InventoryLog, InventoryTemplate
from app.schemas.inventory import (
    InventoryItemCreate, InventoryItemUpdate, InventoryItemResponse,
    InventoryLogCreate, InventoryLogResponse,
    TemplateResponse, TemplateLoadRequest, PourRequest,
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


# ── Pour / Bar ─────────────────────────────────────────────

@router.post("/pour", status_code=201)
def record_pour(
    data: PourRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == data.item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if not item.pour_size:
        raise HTTPException(status_code=400, detail="Item has no pour size configured")

    total_ml = float(item.pour_size) * data.pours
    current_ml = float(item.quantity)
    if total_ml > current_ml:
        raise HTTPException(status_code=400, detail=f"Not enough stock. Have {current_ml} {item.pour_unit or 'ml'}, need {total_ml}")

    item.quantity = current_ml - total_ml
    log = InventoryLog(
        item_id=item.id,
        change_qty=-total_ml,
        reason=f"pour:{data.pours}x{item.pour_size}{item.pour_unit or 'ml'}",
        date=data.date or date.today(),
    )
    db.add(log)
    db.commit()
    db.refresh(item)

    remaining_pours = int(float(item.quantity) / float(item.pour_size)) if float(item.pour_size) > 0 else 0
    revenue = float(item.sell_price_per_pour or 0) * data.pours

    return {
        "item_id": str(item.id),
        "name": item.name,
        "poured": data.pours,
        "ml_used": total_ml,
        "remaining_ml": float(item.quantity),
        "remaining_pours": remaining_pours,
        "revenue": revenue,
    }


# ── Templates ──────────────────────────────────────────────

BAR_TEMPLATE_LIST = [
    {"name": "Vodka", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Tequila", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Rum", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Whiskey", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Gin", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Brandy", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Jägermeister", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Red Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "White Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Rosé Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Prosecco", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Champagne", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Draft Beer", "unit": "ml", "category": "Beer", "perishable": True, "reorder": 5000, "bottle_size": 30000, "pour_size": 400, "pour_unit": "ml"},
    {"name": "Bottled Beer", "unit": "pieces", "category": "Beer", "perishable": True, "reorder": 12, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Coca-Cola", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1500, "pour_size": 200, "pour_unit": "ml"},
    {"name": "Tonic Water", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Soda Water", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Orange Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 1000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Cranberry Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 1000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Lime Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 500, "bottle_size": 500, "pour_size": 15, "pour_unit": "ml"},
    {"name": "Simple Syrup", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 500, "bottle_size": 750, "pour_size": 15, "pour_unit": "ml"},
    {"name": "Triple Sec", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Kahlúa", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Baileys", "unit": "ml", "category": "Liqueurs", "perishable": True, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Amaretto", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Lemons", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 10, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Limes", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 10, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Mint", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 5, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Olives", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 20, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Ice", "unit": "kg", "category": "Supplies", "perishable": True, "reorder": 5, "bottle_size": None, "pour_size": None, "pour_unit": None},
]

OTHER_TEMPLATE_LIST = [
    {"name": "Office Supplies", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 10},
    {"name": "Printer Paper", "unit": "boxes", "category": "Supplies", "perishable": False, "reorder": 3},
    {"name": "Pens & Markers", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 10},
    {"name": "Cleaning Supplies", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Trash Bags", "unit": "boxes", "category": "Supplies", "perishable": False, "reorder": 2},
    {"name": "Hand Tools", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 2},
    {"name": "Tape & Glue", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 5},
    {"name": "Batteries", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 10},
    {"name": "Light Bulbs", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 5},
    {"name": "Extension Cords", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 2},
    {"name": "Raw Materials", "unit": "kg", "category": "Materials", "perishable": False, "reorder": 10},
    {"name": "Packaging Boxes", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 20},
    {"name": "Plastic Bags", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 50},
    {"name": "Labels & Stickers", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 50},
    {"name": "Bubble Wrap", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 5},
    {"name": "Delivery Service", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 0},
    {"name": "Repair Parts", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 5},
    {"name": "Fuel / Petrol", "unit": "liters", "category": "Services", "perishable": False, "reorder": 10},
    {"name": "Uniforms", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 2},
    {"name": "Safety Equipment", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 3},
]

@router.get("/templates", response_model=list[TemplateResponse])
def list_templates(
    template_type: str = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    if template_type == "bar":
        return [
            {"id": i + 1, "template_name": "Bar / Cocktail", "template_type": "bar",
             "item_name": t["name"], "default_unit": t["unit"], "default_category": t["category"],
             "is_perishable": t["perishable"], "default_reorder_level": t["reorder"]}
            for i, t in enumerate(BAR_TEMPLATE_LIST)
        ]
    if template_type == "other":
        return [
            {"id": i + 1, "template_name": "Other / Custom", "template_type": "other",
             "item_name": t["name"], "default_unit": t["unit"], "default_category": t["category"],
             "is_perishable": t["perishable"], "default_reorder_level": t["reorder"]}
            for i, t in enumerate(OTHER_TEMPLATE_LIST)
        ]
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
    if data.template_type == "bar":
        created = []
        for t in BAR_TEMPLATE_LIST:
            existing = db.query(InventoryItem).filter(
                InventoryItem.user_id == user.id,
                InventoryItem.name == t["name"],
            ).first()
            if existing:
                continue
            item = InventoryItem(
                user_id=user.id, name=t["name"], quantity=0, unit=t["unit"],
                cost_per_unit=0, min_threshold=t["reorder"], category=t["category"],
                is_perishable=t["perishable"],
                bottle_size=t.get("bottle_size"),
                pour_size=t.get("pour_size"),
                pour_unit=t.get("pour_unit"),
            )
            db.add(item)
            created.append(item)
        db.commit()
        for c in created:
            db.refresh(c)
        return created

    if data.template_type == "other":
        created = []
        for t in OTHER_TEMPLATE_LIST:
            existing = db.query(InventoryItem).filter(
                InventoryItem.user_id == user.id,
                InventoryItem.name == t["name"],
            ).first()
            if existing:
                continue
            item = InventoryItem(
                user_id=user.id, name=t["name"], quantity=0, unit=t["unit"],
                cost_per_unit=0, min_threshold=t["reorder"], category=t["category"],
                is_perishable=t["perishable"],
            )
            db.add(item)
            created.append(item)
        db.commit()
        for c in created:
            db.refresh(c)
        return created

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
