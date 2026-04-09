"""
Wine List — catalog, stock, margins, staff cheat sheet, selective PDF menu export.

Endpoints:
  POST   /api/wines              — add wine
  GET    /api/wines              — list (filters: type, search, low_stock)
  GET    /api/wines/summary      — KPIs
  GET    /api/wines/{id}         — single wine
  PUT    /api/wines/{id}         — update
  POST   /api/wines/{id}/sell    — quick sell (decrement stock, log sale)
  DELETE /api/wines/{id}         — soft delete
  POST   /api/wines/pdf          — selective PDF menu export
"""

import io
import uuid
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.wine import Wine, WineSale
from app.services.auth import get_current_user

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────

class WineCreate(BaseModel):
    name: str
    winery: Optional[str] = None
    vintage: Optional[int] = None
    grape_variety: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    wine_type: str = "red"
    tasting_notes: Optional[str] = None
    food_pairing: Optional[str] = None
    staff_description: Optional[str] = None
    cost_price: float = 0
    sell_price: float = 0
    stock_qty: int = 0
    reorder_level: int = 2
    supplier: Optional[str] = None
    branch_id: Optional[str] = None


class WineUpdate(BaseModel):
    name: Optional[str] = None
    winery: Optional[str] = None
    vintage: Optional[int] = None
    grape_variety: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    wine_type: Optional[str] = None
    tasting_notes: Optional[str] = None
    food_pairing: Optional[str] = None
    staff_description: Optional[str] = None
    cost_price: Optional[float] = None
    sell_price: Optional[float] = None
    stock_qty: Optional[int] = None
    reorder_level: Optional[int] = None
    supplier: Optional[str] = None


class PdfExportRequest(BaseModel):
    wine_ids: Optional[List[str]] = None       # specific wines
    wine_type: Optional[str] = None            # filter by type
    max_price: Optional[float] = None          # filter by price
    title: Optional[str] = None                # custom menu title
    show_pairing: bool = True                  # include food pairing
    show_notes: bool = True                    # include tasting notes


# ── Helpers ──────────────────────────────────────────────────

def _calc_margin(cost: float, sell: float) -> float:
    if sell <= 0:
        return 0
    return round((sell - cost) / sell * 100, 1)


def _wine_dict(w: Wine) -> dict:
    return {
        "id": str(w.id),
        "name": w.name,
        "winery": w.winery,
        "vintage": w.vintage,
        "grape_variety": w.grape_variety,
        "region": w.region,
        "country": w.country,
        "wine_type": w.wine_type,
        "tasting_notes": w.tasting_notes,
        "food_pairing": w.food_pairing,
        "staff_description": w.staff_description,
        "cost_price": float(w.cost_price or 0),
        "sell_price": float(w.sell_price or 0),
        "margin_pct": float(w.margin_pct or 0),
        "stock_qty": w.stock_qty,
        "reorder_level": w.reorder_level,
        "supplier": w.supplier,
        "branch_id": str(w.branch_id) if w.branch_id else None,
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }


# ── CRUD ─────────────────────────────────────────────────────

@router.post("")
def create_wine(
    data: WineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    margin = _calc_margin(data.cost_price, data.sell_price)
    wine = Wine(
        user_id=user.id,
        branch_id=uuid.UUID(data.branch_id) if data.branch_id else None,
        name=data.name,
        winery=data.winery,
        vintage=data.vintage,
        grape_variety=data.grape_variety,
        region=data.region,
        country=data.country,
        wine_type=data.wine_type,
        tasting_notes=data.tasting_notes,
        food_pairing=data.food_pairing,
        staff_description=data.staff_description,
        cost_price=data.cost_price,
        sell_price=data.sell_price,
        margin_pct=margin,
        stock_qty=data.stock_qty,
        reorder_level=data.reorder_level,
        supplier=data.supplier,
    )
    db.add(wine)
    db.commit()
    db.refresh(wine)
    return _wine_dict(wine)


@router.get("")
def list_wines(
    wine_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    low_stock: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(Wine).filter(Wine.user_id == user.id, Wine.is_deleted.isnot(True))

    if wine_type:
        q = q.filter(Wine.wine_type == wine_type)
    if search:
        like = f"%{search}%"
        q = q.filter(
            (Wine.name.ilike(like)) | (Wine.winery.ilike(like)) |
            (Wine.region.ilike(like)) | (Wine.grape_variety.ilike(like))
        )
    if low_stock:
        q = q.filter(Wine.stock_qty <= Wine.reorder_level)

    wines = q.order_by(Wine.wine_type, Wine.name).all()
    return [_wine_dict(w) for w in wines]


@router.get("/summary")
def wine_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    base = db.query(Wine).filter(Wine.user_id == user.id, Wine.is_deleted.isnot(True))
    wines = base.all()

    if not wines:
        return {
            "total_wines": 0, "total_bottles": 0, "low_stock_count": 0,
            "avg_margin": 0, "total_value_cost": 0, "total_value_sell": 0,
            "type_breakdown": {}, "low_margin_wines": [], "low_stock_wines": [],
        }

    total_bottles = sum(w.stock_qty for w in wines)
    low_stock = [w for w in wines if w.stock_qty <= w.reorder_level]
    low_margin = [w for w in wines if float(w.margin_pct or 0) < 30 and float(w.sell_price or 0) > 0]
    avg_margin = round(sum(float(w.margin_pct or 0) for w in wines) / len(wines), 1)
    total_cost = sum(float(w.cost_price or 0) * w.stock_qty for w in wines)
    total_sell = sum(float(w.sell_price or 0) * w.stock_qty for w in wines)

    type_counts = {}
    for w in wines:
        type_counts[w.wine_type] = type_counts.get(w.wine_type, 0) + 1

    # Top sellers (last 30 days)
    thirty_ago = datetime.utcnow() - timedelta(days=30)
    top_sales = (
        db.query(WineSale.wine_id, func.sum(WineSale.quantity).label("qty"))
        .filter(WineSale.user_id == user.id, WineSale.sold_at >= thirty_ago)
        .group_by(WineSale.wine_id)
        .order_by(func.sum(WineSale.quantity).desc())
        .limit(5)
        .all()
    )
    wine_map = {str(w.id): w for w in wines}
    top_sellers = []
    for sale in top_sales:
        w = wine_map.get(str(sale.wine_id))
        if w:
            top_sellers.append({"name": w.name, "wine_type": w.wine_type, "qty_sold": int(sale.qty)})

    return {
        "total_wines": len(wines),
        "total_bottles": total_bottles,
        "low_stock_count": len(low_stock),
        "avg_margin": avg_margin,
        "total_value_cost": round(total_cost, 2),
        "total_value_sell": round(total_sell, 2),
        "type_breakdown": type_counts,
        "low_margin_wines": [{"name": w.name, "margin": float(w.margin_pct)} for w in low_margin[:5]],
        "low_stock_wines": [{"name": w.name, "qty": w.stock_qty} for w in low_stock[:5]],
        "top_sellers": top_sellers,
    }


@router.get("/{wine_id}")
def get_wine(
    wine_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    wine = db.query(Wine).filter(
        Wine.id == wine_id, Wine.user_id == user.id, Wine.is_deleted.isnot(True),
    ).first()
    if not wine:
        raise HTTPException(404, "Wine not found")
    return _wine_dict(wine)


@router.put("/{wine_id}")
def update_wine(
    wine_id: str,
    data: WineUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    wine = db.query(Wine).filter(
        Wine.id == wine_id, Wine.user_id == user.id, Wine.is_deleted.isnot(True),
    ).first()
    if not wine:
        raise HTTPException(404, "Wine not found")

    updates = data.model_dump(exclude_unset=True)
    for k, v in updates.items():
        setattr(wine, k, v)

    # Recalculate margin if prices changed
    cost = float(updates.get("cost_price", wine.cost_price) or 0)
    sell = float(updates.get("sell_price", wine.sell_price) or 0)
    wine.margin_pct = _calc_margin(cost, sell)

    db.commit()
    db.refresh(wine)
    return _wine_dict(wine)


@router.post("/{wine_id}/sell")
def sell_wine(
    wine_id: str,
    quantity: int = Query(1, ge=1),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    wine = db.query(Wine).filter(
        Wine.id == wine_id, Wine.user_id == user.id, Wine.is_deleted.isnot(True),
    ).first()
    if not wine:
        raise HTTPException(404, "Wine not found")
    if wine.stock_qty < quantity:
        raise HTTPException(400, f"Only {wine.stock_qty} bottles in stock")

    wine.stock_qty -= quantity

    sale = WineSale(
        user_id=user.id,
        wine_id=wine.id,
        branch_id=wine.branch_id,
        quantity=quantity,
        sale_price=float(wine.sell_price or 0) * quantity,
    )
    db.add(sale)
    db.commit()

    return {
        "message": f"Sold {quantity} bottle(s) of {wine.name}",
        "remaining": wine.stock_qty,
        "low_stock": wine.stock_qty <= wine.reorder_level,
    }


@router.delete("/{wine_id}")
def delete_wine(
    wine_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    wine = db.query(Wine).filter(
        Wine.id == wine_id, Wine.user_id == user.id, Wine.is_deleted.isnot(True),
    ).first()
    if not wine:
        raise HTTPException(404, "Wine not found")

    wine.is_deleted = True
    wine.deleted_at = datetime.utcnow()
    db.commit()
    return {"message": f"'{wine.name}' deleted"}


# ── Selective PDF Menu Export ────────────────────────────────

@router.post("/pdf")
def export_wine_pdf(
    body: PdfExportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a beautiful wine menu PDF from selected wines or filters."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_LEFT

    # ── Fetch wines ──
    q = db.query(Wine).filter(Wine.user_id == user.id, Wine.is_deleted.isnot(True))

    if body.wine_ids:
        q = q.filter(Wine.id.in_(body.wine_ids))
    if body.wine_type:
        q = q.filter(Wine.wine_type == body.wine_type)
    if body.max_price:
        q = q.filter(Wine.sell_price <= body.max_price)

    wines = q.order_by(Wine.wine_type, Wine.name).all()
    if not wines:
        raise HTTPException(400, "No wines match your selection")

    # ── Build PDF ──
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=30 * mm, bottomMargin=20 * mm,
                            leftMargin=25 * mm, rightMargin=25 * mm)

    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        "WineMenuTitle", parent=styles["Title"],
        fontSize=26, spaceAfter=4, alignment=TA_CENTER,
        textColor=colors.HexColor("#1a1a2e"), fontName="Helvetica-Bold",
    )
    subtitle_style = ParagraphStyle(
        "WineMenuSub", parent=styles["Normal"],
        fontSize=10, alignment=TA_CENTER,
        textColor=colors.HexColor("#666666"), spaceAfter=20,
    )
    section_style = ParagraphStyle(
        "WineSection", parent=styles["Heading2"],
        fontSize=16, spaceBefore=20, spaceAfter=8,
        textColor=colors.HexColor("#722f37"), fontName="Helvetica-Bold",
        borderWidth=0,
    )
    wine_name_style = ParagraphStyle(
        "WineName", parent=styles["Normal"],
        fontSize=12, fontName="Helvetica-Bold",
        textColor=colors.HexColor("#1a1a2e"), spaceAfter=1,
    )
    wine_detail_style = ParagraphStyle(
        "WineDetail", parent=styles["Normal"],
        fontSize=9, textColor=colors.HexColor("#555555"),
        leading=13, spaceAfter=2,
    )
    wine_notes_style = ParagraphStyle(
        "WineNotes", parent=styles["Normal"],
        fontSize=8.5, textColor=colors.HexColor("#777777"),
        leading=12, spaceAfter=2, fontName="Helvetica-Oblique",
    )
    price_style = ParagraphStyle(
        "WinePrice", parent=styles["Normal"],
        fontSize=12, fontName="Helvetica-Bold",
        textColor=colors.HexColor("#1a1a2e"), alignment=2,  # RIGHT
    )

    elements = []

    # Title
    menu_title = body.title or f"{user.business_name} Wine Menu" if user.business_name else "Wine Menu"
    elements.append(Paragraph(menu_title, title_style))
    elements.append(Paragraph("— curated selection —", subtitle_style))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#ddd"), spaceAfter=12))

    # Group by type
    type_labels = {
        "red": "Red Wines", "white": "White Wines", "rosé": "Rosé Wines",
        "sparkling": "Sparkling", "natural": "Natural Wines",
        "dessert": "Dessert Wines", "orange": "Orange Wines",
    }
    grouped = {}
    for w in wines:
        grouped.setdefault(w.wine_type, []).append(w)

    # Render type order
    type_order = ["sparkling", "white", "rosé", "orange", "red", "natural", "dessert"]
    for wtype in type_order:
        if wtype not in grouped:
            continue
        group = grouped[wtype]

        elements.append(Paragraph(type_labels.get(wtype, wtype.title()), section_style))
        elements.append(HRFlowable(width="100%", thickness=0.3, color=colors.HexColor("#722f37"), spaceAfter=8))

        for w in group:
            # Wine name + vintage + price row
            detail_parts = []
            if w.grape_variety:
                detail_parts.append(w.grape_variety)
            if w.region:
                region_str = f"{w.region}, {w.country}" if w.country else w.region
                detail_parts.append(region_str)
            if w.vintage:
                detail_parts.append(str(w.vintage))

            currency = user.currency or "DKK"
            price_text = f"{float(w.sell_price):,.0f} {currency}"

            # Build as a two-column table: name+details on left, price on right
            name_text = w.name
            if w.winery:
                name_text += f"  <font size='9' color='#888'>— {w.winery}</font>"

            left_content = [Paragraph(name_text, wine_name_style)]
            if detail_parts:
                left_content.append(Paragraph(" · ".join(detail_parts), wine_detail_style))
            if body.show_notes and w.tasting_notes:
                left_content.append(Paragraph(f'"{w.tasting_notes}"', wine_notes_style))
            if body.show_pairing and w.food_pairing:
                left_content.append(Paragraph(f"Pairs with: {w.food_pairing}", wine_detail_style))

            row_table = Table(
                [[left_content, Paragraph(price_text, price_style)]],
                colWidths=[doc.width * 0.78, doc.width * 0.22],
            )
            row_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]))
            elements.append(row_table)

        elements.append(Spacer(1, 6))

    # Footer
    elements.append(Spacer(1, 20))
    elements.append(HRFlowable(width="100%", thickness=0.3, color=colors.HexColor("#ccc"), spaceAfter=8))
    footer_style = ParagraphStyle(
        "Footer", parent=styles["Normal"],
        fontSize=8, textColor=colors.HexColor("#999999"), alignment=TA_CENTER,
    )
    elements.append(Paragraph(
        f"Generated on {datetime.utcnow().strftime('%d %b %Y')} · {len(wines)} wine{'s' if len(wines) != 1 else ''}",
        footer_style,
    ))

    doc.build(elements)
    buf.seek(0)

    filename = f"wine_menu_{datetime.utcnow().strftime('%Y%m%d')}.pdf"
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
