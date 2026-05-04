"""
Wine List — catalog, stock, margins, staff cheat sheet, selective PDF menu export,
label scanning (Claude Vision), QR public menu, AI sommelier.

Endpoints:
  POST   /api/wines              — add wine
  GET    /api/wines              — list (filters: type, search, low_stock)
  GET    /api/wines/summary      — KPIs
  GET    /api/wines/{id}         — single wine
  PUT    /api/wines/{id}         — update
  POST   /api/wines/{id}/sell    — quick sell (decrement stock, log sale)
  DELETE /api/wines/{id}         — soft delete
  POST   /api/wines/pdf          — selective PDF menu export
  POST   /api/wines/scan         — scan bottle label → AI extracts details
  GET    /api/wines/menu/{token} — public customer wine menu (no auth)
  POST   /api/wines/sommelier    — AI sommelier recommendations
"""

import io
import json
import os
import uuid
import base64
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.models.wine import Wine, WineSale
from app.services.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────

class WineCreate(BaseModel):
    name: str
    menu_name: Optional[str] = None
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
    glass_price: Optional[float] = None
    stock_qty: int = 0
    reorder_level: int = 2
    supplier: Optional[str] = None
    branch_id: Optional[str] = None


class WineUpdate(BaseModel):
    name: Optional[str] = None
    menu_name: Optional[str] = None
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
    glass_price: Optional[float] = None
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
    show_glass: bool = True                    # include glass pricing


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
        "menu_name": w.menu_name,
        "glass_price": float(w.glass_price) if w.glass_price else None,
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
        menu_name=data.menu_name,
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
        glass_price=data.glass_price,
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

    # ── Elegant restaurant wine card styles ──
    burgundy = colors.HexColor("#5c1a2a")
    gold = colors.HexColor("#8b7355")
    charcoal = colors.HexColor("#2c2c2c")
    muted = colors.HexColor("#777777")

    title_style = ParagraphStyle(
        "WineMenuTitle", parent=styles["Title"],
        fontSize=28, spaceAfter=2, alignment=TA_CENTER,
        textColor=charcoal, fontName="Times-Bold", leading=34,
    )
    subtitle_style = ParagraphStyle(
        "WineMenuSub", parent=styles["Normal"],
        fontSize=10, alignment=TA_CENTER,
        textColor=gold, spaceAfter=6, fontName="Times-Italic", leading=14,
    )
    section_style = ParagraphStyle(
        "WineSection", parent=styles["Heading2"],
        fontSize=14, spaceBefore=18, spaceAfter=6,
        textColor=burgundy, fontName="Times-Bold",
        borderWidth=0, leading=18,
    )
    wine_name_style = ParagraphStyle(
        "WineName", parent=styles["Normal"],
        fontSize=11, fontName="Times-Bold",
        textColor=charcoal, spaceAfter=0, leading=14,
    )
    wine_detail_style = ParagraphStyle(
        "WineDetail", parent=styles["Normal"],
        fontSize=8.5, textColor=muted,
        leading=11, spaceAfter=1, fontName="Helvetica",
    )
    wine_notes_style = ParagraphStyle(
        "WineNotes", parent=styles["Normal"],
        fontSize=8, textColor=colors.HexColor("#999999"),
        leading=10, spaceAfter=1, fontName="Times-Italic",
    )
    price_style = ParagraphStyle(
        "WinePrice", parent=styles["Normal"],
        fontSize=10, fontName="Helvetica-Bold",
        textColor=charcoal, alignment=2,  # RIGHT
    )
    price_glass_style = ParagraphStyle(
        "WinePriceGlass", parent=styles["Normal"],
        fontSize=8, fontName="Helvetica",
        textColor=muted, alignment=2,
    )

    elements = []
    currency = user.currency or "DKK"

    # ── Header ──
    menu_title = body.title or (f"{user.business_name}" if user.business_name else "Wine Menu")
    elements.append(Spacer(1, 5 * mm))
    elements.append(Paragraph(menu_title, title_style))
    elements.append(Paragraph("\u2014 wine selection \u2014", subtitle_style))
    elements.append(Spacer(1, 2 * mm))
    elements.append(HRFlowable(width="40%", thickness=0.5, color=gold, spaceAfter=10, hAlign="CENTER"))

    # ── Column header for glass/bottle ──
    show_glass = body.show_glass and any(getattr(w, "glass_price", None) for w in wines)
    if show_glass:
        hdr = Table(
            [["", Paragraph("Glass", price_glass_style), Paragraph("Bottle", price_glass_style)]],
            colWidths=[doc.width * 0.68, doc.width * 0.16, doc.width * 0.16],
        )
        hdr.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        elements.append(hdr)

    # ── Group by type ──
    type_labels = {
        "red": "Red Wines", "white": "White Wines", "ros\u00e9": "Ros\u00e9 Wines",
        "sparkling": "Sparkling & Champagne", "natural": "Natural Wines",
        "dessert": "Dessert Wines", "orange": "Orange Wines",
    }
    grouped = {}
    for w in wines:
        grouped.setdefault(w.wine_type, []).append(w)

    type_order = ["sparkling", "white", "ros\u00e9", "orange", "red", "natural", "dessert"]
    for wtype in type_order:
        if wtype not in grouped:
            continue
        group = grouped[wtype]

        elements.append(Paragraph(type_labels.get(wtype, wtype.title()), section_style))
        elements.append(HRFlowable(width="100%", thickness=0.3, color=burgundy, spaceAfter=6))

        for w in group:
            display_name = getattr(w, "menu_name", None) or w.name
            detail_parts = []
            if w.grape_variety:
                detail_parts.append(w.grape_variety)
            if w.region:
                detail_parts.append(f"{w.region}, {w.country}" if w.country else w.region)
            if w.vintage:
                detail_parts.append(str(w.vintage))

            name_text = display_name
            if w.winery:
                name_text += f"  <font size='8' color='#999'>\u2014 {w.winery}</font>"

            left_content = [Paragraph(name_text, wine_name_style)]
            if detail_parts:
                left_content.append(Paragraph(" \u00b7 ".join(detail_parts), wine_detail_style))
            if body.show_notes and w.tasting_notes:
                left_content.append(Paragraph(f"\u201c{w.tasting_notes}\u201d", wine_notes_style))
            if body.show_pairing and w.food_pairing:
                left_content.append(Paragraph(f"Pairs with {w.food_pairing}", wine_detail_style))

            bottle_text = f"{float(w.sell_price):,.0f}"
            g_price = getattr(w, "glass_price", None)

            if show_glass:
                glass_text = f"{float(g_price):,.0f}" if g_price else "\u2014"
                row_table = Table(
                    [[left_content, Paragraph(glass_text, price_style), Paragraph(bottle_text, price_style)]],
                    colWidths=[doc.width * 0.68, doc.width * 0.16, doc.width * 0.16],
                )
            else:
                row_table = Table(
                    [[left_content, Paragraph(bottle_text, price_style)]],
                    colWidths=[doc.width * 0.80, doc.width * 0.20],
                )

            row_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LINEBELOW", (0, 0), (-1, -1), 0.2, colors.HexColor("#e8e8e8")),
            ]))
            elements.append(row_table)

        elements.append(Spacer(1, 4))

    # ── Footer ──
    elements.append(Spacer(1, 15))
    elements.append(HRFlowable(width="30%", thickness=0.3, color=gold, spaceAfter=6, hAlign="CENTER"))
    footer_style = ParagraphStyle(
        "Footer", parent=styles["Normal"],
        fontSize=7.5, textColor=colors.HexColor("#aaaaaa"), alignment=TA_CENTER, fontName="Helvetica",
    )
    if show_glass:
        elements.append(Paragraph(f"All prices in {currency}", footer_style))
    elements.append(Paragraph(
        f"{len(wines)} wine{'s' if len(wines) != 1 else ''} \u00b7 Ask your server for recommendations",
        footer_style,
    ))

    doc.build(elements)
    buf.seek(0)

    filename = f"wine_menu_{datetime.utcnow().strftime('%Y%m%d')}.pdf"
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Scan Bottle Label (Claude Vision) ───────────────────────

# ─── Wine label scanner ────────────────────────────────────────────────
# The scanner had accuracy issues — model guessed when fields weren't visible
# and sometimes returned tasting notes for the wrong wine. Fix by:
#   1) Anti-hallucination prompt: explicit "use null when not visible"
#   2) Reading ALL visible text first, then mapping to schema
#   3) Strict JSON validation with field-level fallbacks (never propagate junk)
#   4) Wine-type allow-list (typo-tolerant)
#   5) Vintage range sanity (1900..current_year+1)
#   6) Extended model output budget so longer labels aren't truncated mid-JSON

_VALID_WINE_TYPES = {"red", "white", "rosé", "rose", "sparkling", "natural", "dessert", "orange", "fortified"}


def _normalize_wine_type(value):
    """Normalize wine_type to one of our enum values; default to 'red' if junk."""
    if not value or not isinstance(value, str):
        return None
    v = value.strip().lower()
    # Common synonyms
    if v in {"rose", "rosé", "rosado", "rosato"}:
        return "rosé"
    if v in {"red", "rouge", "tinto", "rosso", "rot"}:
        return "red"
    if v in {"white", "blanc", "bianco", "blanco", "weiss", "weiß"}:
        return "white"
    if v in {"sparkling", "spumante", "champagne", "cava", "prosecco", "crémant"}:
        return "sparkling"
    if v in {"orange", "amber", "skin-contact"}:
        return "orange"
    if v in {"natural", "natty"}:
        return "natural"
    if v in {"dessert", "sweet", "passito", "ice wine", "icewine"}:
        return "dessert"
    if v in {"fortified", "port", "porto", "sherry", "madeira"}:
        return "fortified"
    return v if v in _VALID_WINE_TYPES else None


def _validate_scan_output(raw: dict) -> dict:
    """Sanitize the LLM JSON: clamp fields, drop hallucinations, enforce shape.

    Never raises. Returns a dict with the same keys as the prompt schema, with
    invalid fields coerced to null/sensible defaults. This is the multi-layer
    defense — even if the LLM goes off-schema, the frontend gets a clean object.
    """
    from datetime import date as _date
    out = {
        "name": None,
        "winery": None,
        "vintage": None,
        "grape_variety": None,
        "region": None,
        "country": None,
        "wine_type": None,
        "tasting_notes": None,
        "food_pairing": None,
    }
    if not isinstance(raw, dict):
        return out

    def _clean_str(v, max_len=200):
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)
        v = v.strip()
        # Strip common LLM garbage signals
        if v.lower() in {"", "null", "none", "n/a", "unknown", "not visible", "not specified"}:
            return None
        # Truncate to keep DB rows sane
        return v[:max_len] if len(v) > max_len else v

    out["name"] = _clean_str(raw.get("name"))
    out["winery"] = _clean_str(raw.get("winery"))
    out["grape_variety"] = _clean_str(raw.get("grape_variety"))
    out["region"] = _clean_str(raw.get("region"))
    out["country"] = _clean_str(raw.get("country"))
    out["tasting_notes"] = _clean_str(raw.get("tasting_notes"), max_len=400)
    out["food_pairing"] = _clean_str(raw.get("food_pairing"), max_len=300)
    out["wine_type"] = _normalize_wine_type(raw.get("wine_type"))

    # Vintage: int between 1900 and current_year+1 (futures sometimes labelled
    # ahead). Anything else becomes None — never propagate a bogus year.
    v_raw = raw.get("vintage")
    try:
        if v_raw is not None and v_raw != "":
            v_int = int(v_raw) if not isinstance(v_raw, int) else v_raw
            this_year = _date.today().year
            if 1900 <= v_int <= this_year + 1:
                out["vintage"] = v_int
    except (TypeError, ValueError):
        pass

    return out


_WINE_SCAN_PROMPT = (
    "You are a wine catalog assistant for a restaurant POS. Look at this wine "
    "bottle label and extract structured data.\n\n"
    "Step 1: Read EVERY piece of text visible on the label — back AND front if shown.\n"
    "Step 2: Map what you read to the fields below. Do not guess. If a field is "
    "not clearly visible on the label, return null for that field.\n\n"
    "Critical rules to avoid wrong information:\n"
    "  • Never guess the vintage. If no year is printed, return vintage: null.\n"
    "  • Never invent a winery. If you can't identify the producer, return null.\n"
    "  • Never claim a region or country unless it is printed on the label.\n"
    "  • Tasting notes must be neutral and based ONLY on what the label states "
    "(e.g., 'Cabernet Sauvignon from Bordeaux'). Do not invent flavors that aren't "
    "implied by the label.\n"
    "  • If the bottle is not a wine (e.g., spirits, beer, water), return all-null.\n"
    "  • For grape_variety, prefer the exact wording on the label (e.g., 'Sangiovese' "
    "not 'Italian red').\n"
    "  • For wine_type use exactly one of: red | white | rosé | sparkling | natural | "
    "dessert | orange | fortified.\n\n"
    "Return ONLY this JSON, no markdown, no explanation:\n"
    "{\n"
    '  "name": string|null,\n'
    '  "winery": string|null,\n'
    '  "vintage": integer|null,\n'
    '  "grape_variety": string|null,\n'
    '  "region": string|null,\n'
    '  "country": string|null,\n'
    '  "wine_type": "red"|"white"|"rosé"|"sparkling"|"natural"|"dessert"|"orange"|"fortified"|null,\n'
    '  "tasting_notes": string|null (1 short sentence, factual),\n'
    '  "food_pairing": string|null (2-3 dishes, comma-separated)\n'
    "}"
)


@router.post("/scan")
async def scan_bottle_label(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Upload a photo of a wine label → Claude Vision extracts details.

    Multi-layer defense:
      1) File size + type validation
      2) Try/except around the Anthropic call
      3) Strict JSON parsing with markdown-block tolerance
      4) _validate_scan_output() coerces every field to a safe value
      5) On failure: structured error JSON (frontend shows the SoftErrorBanner)
    """
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(400, "AI scanning not configured — add wine manually")

    # Layer 1 — input validation
    image_data = await file.read()
    if len(image_data) > 10 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 10 MB)")
    if len(image_data) < 1024:
        # < 1 KB = almost certainly not a real photo
        raise HTTPException(400, "Image too small — try a clearer photo")

    media_type = file.content_type or "image/jpeg"
    if media_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
        # Anthropic vision accepts these; reject others before the upload round-trip
        raise HTTPException(400, "Unsupported image format — use JPEG, PNG, or WebP")

    b64 = base64.b64encode(image_data).decode()

    raw_text = ""
    try:
        import httpx

        api_key = settings.ANTHROPIC_API_KEY
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 1200,  # bumped from 800 — long labels were truncating mid-JSON
                # Lower temp for deterministic, factual extraction (no creative guesses)
                "temperature": 0.1,
                "messages": [{
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": b64},
                        },
                        {"type": "text", "text": _WINE_SCAN_PROMPT},
                    ],
                }],
            },
            timeout=30.0,
        )

        if resp.status_code != 200:
            logger.warning("Anthropic API non-200: %d %s", resp.status_code, resp.text[:200])
            return {
                "success": False,
                "error": "AI service is busy. Please try again in a moment.",
                "_recoverable": True,
            }

        try:
            raw_text = resp.json()["content"][0]["text"].strip()
        except (KeyError, IndexError, ValueError) as e:
            logger.warning("Anthropic response shape unexpected: %s", e)
            return {
                "success": False,
                "error": "AI returned an unexpected response. Please try again.",
                "_recoverable": True,
            }

        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError:
            logger.warning("Claude returned non-JSON for wine scan: %s", raw_text[:200])
            return {
                "success": False,
                "error": "Could not read the label clearly. Try a sharper, well-lit photo of the front of the bottle.",
                "_recoverable": True,
            }

        # Layer 4 — sanitize and clamp fields. Even if Claude returns junk for
        # one field, the rest survive.
        validated = _validate_scan_output(parsed)

        # Detection: if all fields are null, it almost certainly wasn't a wine
        # bottle (or photo was unreadable). Tell the user explicitly.
        non_null = sum(1 for v in validated.values() if v not in (None, ""))
        if non_null == 0:
            return {
                "success": False,
                "error": (
                    "Couldn't identify a wine on this label. "
                    "Make sure the front label is fully visible and try again."
                ),
                "_recoverable": True,
            }

        return {"success": True, "data": validated}

    except Exception as e:
        logger.exception("Wine scan unexpected error")
        return {
            "success": False,
            "error": "Wine scan failed. Try again or add the wine manually.",
            "_recoverable": True,
        }


# ── Public Customer Wine Menu (no auth) ─────────────────────

def _menu_token(user_id: str) -> str:
    """Deterministic token from user_id — stable URL for QR code."""
    return hashlib.sha256(f"bonbox-wine-{user_id}".encode()).hexdigest()[:16]


@router.get("/menu-token")
def get_menu_token(user: User = Depends(get_current_user)):
    """Get the public menu token + URL for QR code generation."""
    token = _menu_token(str(user.id))
    return {"token": token, "url": f"/api/wines/menu/{token}"}


@router.get("/menu/{token}")
def public_wine_menu(token: str, db: Session = Depends(get_db)):
    """Public-facing HTML wine menu — no auth, shareable via QR."""
    # Find user by token
    from app.models.user import User as UserModel
    users = db.query(UserModel).all()
    owner = None
    for u in users:
        if _menu_token(str(u.id)) == token:
            owner = u
            break
    if not owner:
        raise HTTPException(404, "Menu not found")

    wines = (
        db.query(Wine)
        .filter(Wine.user_id == owner.id, Wine.is_deleted.isnot(True), Wine.stock_qty > 0)
        .order_by(Wine.wine_type, Wine.name)
        .all()
    )

    currency = owner.currency or "DKK"
    biz_name = owner.business_name or "Wine Menu"

    # Group by type
    type_labels = {
        "sparkling": "Sparkling ✨", "white": "White Wines", "rosé": "Rosé",
        "orange": "Orange Wines", "red": "Red Wines", "natural": "Natural Wines",
        "dessert": "Dessert Wines",
    }
    type_order = ["sparkling", "white", "rosé", "orange", "red", "natural", "dessert"]
    grouped = {}
    for w in wines:
        grouped.setdefault(w.wine_type, []).append(w)

    # Build HTML
    sections_html = ""
    for wtype in type_order:
        if wtype not in grouped:
            continue
        sections_html += f'<div class="section"><h2>{type_labels.get(wtype, wtype.title())}</h2>'
        for w in grouped[wtype]:
            detail_parts = []
            if w.grape_variety:
                detail_parts.append(w.grape_variety)
            if w.region:
                detail_parts.append(f"{w.region}, {w.country}" if w.country else w.region)
            if w.vintage:
                detail_parts.append(str(w.vintage))
            detail = " · ".join(detail_parts)
            notes = f'<p class="notes">"{w.tasting_notes}"</p>' if w.tasting_notes else ""
            pairing = f'<p class="pair">Pairs with: {w.food_pairing}</p>' if w.food_pairing else ""
            price = f"{float(w.sell_price):,.0f} {currency}"
            sections_html += f'''
            <div class="wine">
              <div class="wine-header">
                <div><span class="name">{w.name}</span>
                {f'<span class="winery"> — {w.winery}</span>' if w.winery else ''}</div>
                <span class="price">{price}</span>
              </div>
              <p class="detail">{detail}</p>
              {notes}{pairing}
            </div>'''
        sections_html += "</div>"

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{biz_name} — Wine Menu</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#faf8f5;color:#1a1a2e;padding:20px;max-width:600px;margin:0 auto}}
h1{{text-align:center;font-size:28px;margin:20px 0 4px;color:#1a1a2e;letter-spacing:1px}}
.sub{{text-align:center;color:#888;font-size:13px;margin-bottom:28px;font-style:italic}}
.section{{margin-bottom:28px}}
h2{{font-size:15px;color:#722f37;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #e8e0d8;padding-bottom:8px;margin-bottom:14px}}
.wine{{margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f0ebe4}}
.wine:last-child{{border:none}}
.wine-header{{display:flex;justify-content:space-between;align-items:baseline;gap:12px}}
.name{{font-weight:600;font-size:16px;color:#1a1a2e}}
.winery{{font-size:12px;color:#888}}
.price{{font-weight:700;font-size:16px;white-space:nowrap;color:#1a1a2e}}
.detail{{font-size:12px;color:#777;margin-top:3px}}
.notes{{font-size:12px;color:#555;font-style:italic;margin-top:4px}}
.pair{{font-size:11px;color:#888;margin-top:2px}}
.footer{{text-align:center;color:#bbb;font-size:11px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e0d8}}
</style></head><body>
<h1>{biz_name}</h1>
<p class="sub">Wine Selection</p>
{sections_html}
<p class="footer">Powered by BonBox · {len(wines)} wines available</p>
</body></html>"""

    return HTMLResponse(content=html)


# ── AI Sommelier ─────────────────────────────────────────────

class SommelierQuery(BaseModel):
    query: str  # e.g. "Something fruity under 400 DKK"


@router.post("/sommelier")
def ai_sommelier(
    body: SommelierQuery,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """AI sommelier — natural language search across current stock."""
    wines = (
        db.query(Wine)
        .filter(Wine.user_id == user.id, Wine.is_deleted.isnot(True), Wine.stock_qty > 0)
        .all()
    )
    if not wines:
        return {"results": [], "message": "No wines in stock"}

    query = body.query.lower()
    currency = user.currency or "DKK"

    # If Claude API available, use it for smart matching
    if settings.ANTHROPIC_API_KEY:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

            wine_catalog = "\n".join(
                f"- ID:{w.id} | {w.name} ({w.wine_type}) | {w.grape_variety or '?'} | "
                f"{w.region or '?'}, {w.country or '?'} | {float(w.sell_price):.0f} {currency} | "
                f"Stock:{w.stock_qty} | Notes: {w.tasting_notes or 'none'} | Pairs: {w.food_pairing or 'none'}"
                for w in wines
            )

            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=600,
                messages=[{
                    "role": "user",
                    "content": (
                        f"You are a sommelier. A customer asks: \"{body.query}\"\n\n"
                        f"Here are the available wines:\n{wine_catalog}\n\n"
                        "Return a JSON array of the top 3 matching wine IDs with a short reason why "
                        "each is a good match. Format:\n"
                        '[{"id": "...", "reason": "..."}]\n'
                        "Return ONLY the JSON array."
                    ),
                }],
            )

            raw = resp.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            matches = json.loads(raw)

            wine_map = {str(w.id): _wine_dict(w) for w in wines}
            results = []
            for m in matches:
                w = wine_map.get(m.get("id"))
                if w:
                    results.append({**w, "recommendation": m.get("reason", "")})

            return {"results": results, "ai": True}

        except Exception as e:
            logger.warning("Sommelier AI failed, using keyword fallback: %s", e)

    # Keyword-based fallback
    results = _keyword_sommelier(wines, query, currency)
    return {"results": [_wine_dict(w) for w in results[:5]], "ai": False}


def _keyword_sommelier(wines: list, query: str, currency: str) -> list:
    """Simple keyword matching when Claude API isn't available."""
    import re

    # Extract price constraint
    max_price = None
    price_match = re.search(r"under\s+(\d+)|below\s+(\d+)|max\s+(\d+)|<\s*(\d+)", query)
    if price_match:
        max_price = float(next(g for g in price_match.groups() if g))

    # Keywords for types
    type_hints = {
        "red": ["red", "bold", "tannic", "full-bodied"],
        "white": ["white", "crisp", "light", "refreshing", "citrus"],
        "rosé": ["rosé", "rose", "pink", "summer"],
        "sparkling": ["sparkling", "bubbly", "champagne", "prosecco", "celebration"],
        "natural": ["natural", "organic", "biodynamic", "funky"],
    }

    # Taste keywords
    taste_words = ["fruity", "dry", "sweet", "mineral", "oaky", "smooth", "acidic",
                   "earthy", "floral", "spicy", "buttery", "tropical", "berry"]

    scored = []
    for w in wines:
        score = 0
        searchable = f"{w.name} {w.wine_type} {w.grape_variety or ''} {w.tasting_notes or ''} {w.food_pairing or ''} {w.region or ''}".lower()

        # Price filter
        if max_price and float(w.sell_price or 0) > max_price:
            continue

        # Type matching
        for wtype, hints in type_hints.items():
            if any(h in query for h in hints):
                if w.wine_type == wtype:
                    score += 3

        # Taste matching
        for tw in taste_words:
            if tw in query and tw in searchable:
                score += 2

        # General word overlap
        for word in query.split():
            if len(word) > 2 and word in searchable:
                score += 1

        if score > 0:
            scored.append((score, w))

    scored.sort(key=lambda x: -x[0])
    return [w for _, w in scored]
