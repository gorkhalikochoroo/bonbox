import re
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.user import User


def get_display_currency(currency: str) -> str:
    if currency and currency.startswith("EUR_"):
        return "EUR"
    return currency or "DKK"


def parse_message(body: str) -> dict:
    """Parse incoming WhatsApp message and determine the action."""
    body = body.strip()
    lower = body.lower()

    # Pure number = log revenue
    cleaned = re.sub(r"[,.\s]", "", body)
    if cleaned.isdigit() and len(cleaned) <= 10:
        return {"action": "log_sale", "amount": float(body.replace(",", "").replace(" ", ""))}

    # "revenue 14500" or "sale 14500" or "salg 14500"
    m = re.match(r"(?:revenue|sale|salg|income|rev)\s+([\d,.]+)", lower)
    if m:
        return {"action": "log_sale", "amount": float(m.group(1).replace(",", ""))}

    # "expense 2500 ingredients" or "udgift 2500 ingredienser"
    m = re.match(r"(?:expense|udgift|exp|cost)\s+([\d,.]+)\s*(.*)", lower)
    if m:
        amount = float(m.group(1).replace(",", ""))
        category = m.group(2).strip() if m.group(2) else "Other"
        return {"action": "log_expense", "amount": amount, "category": category}

    # Summary / status
    if lower in ("summary", "status", "overblik", "today", "i dag", "s"):
        return {"action": "get_summary"}

    # Week summary
    if lower in ("week", "uge", "weekly", "w"):
        return {"action": "get_week_summary"}

    # Inventory / stock
    if lower in ("inventory", "stock", "lager", "inv", "i"):
        return {"action": "get_inventory_alerts"}

    # Help
    if lower in ("help", "hjælp", "h", "?", "commands"):
        return {"action": "show_help"}

    # Profit check
    if lower in ("profit", "overskud", "p", "margin"):
        return {"action": "get_profit"}

    # Unknown — try if it looks like a number with text
    m = re.match(r"([\d,.]+)\s*(.*)", body)
    if m:
        amount = float(m.group(1).replace(",", ""))
        extra = m.group(2).strip().lower()
        if extra and any(kw in extra for kw in ("expense", "udgift", "cost", "exp")):
            return {"action": "log_expense", "amount": amount, "category": "Other"}
        return {"action": "log_sale", "amount": amount}

    return {"action": "unknown", "text": body}


def handle_message(parsed: dict, user: User, db: Session) -> str:
    """Process parsed message and return response text."""
    cur = get_display_currency(user.currency)
    action = parsed["action"]

    if action == "log_sale":
        amount = parsed["amount"]
        sale = Sale(
            user_id=user.id,
            amount=amount,
            date=date.today(),
            payment_method="cash",
            description="WhatsApp",
        )
        db.add(sale)
        db.commit()

        # Get today's total
        today_total = float(
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(Sale.user_id == user.id, Sale.date == date.today(), Sale.is_deleted.isnot(True))
            .scalar()
        )
        today_exp = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(Expense.user_id == user.id, Expense.date == date.today(), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .scalar()
        )
        profit = today_total - today_exp

        return (
            f"✅ *Logged {amount:,.0f} {cur} revenue*\n\n"
            f"📊 Today so far:\n"
            f"Revenue: {today_total:,.0f} {cur}\n"
            f"Expenses: {today_exp:,.0f} {cur}\n"
            f"Profit: {profit:,.0f} {cur}"
        )

    elif action == "log_expense":
        amount = parsed["amount"]
        category_name = parsed.get("category", "Other").title()

        # Find or create category
        cat = db.query(ExpenseCategory).filter(
            ExpenseCategory.user_id == user.id,
            func.lower(ExpenseCategory.name) == category_name.lower(),
        ).first()
        if not cat:
            cat = ExpenseCategory(user_id=user.id, name=category_name)
            db.add(cat)
            db.commit()
            db.refresh(cat)

        expense = Expense(
            user_id=user.id,
            category_id=cat.id,
            amount=amount,
            date=date.today(),
            description=f"WhatsApp: {category_name}",
            payment_method="cash",
        )
        db.add(expense)
        db.commit()

        today_exp = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(Expense.user_id == user.id, Expense.date == date.today(), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .scalar()
        )

        return (
            f"✅ *Logged {amount:,.0f} {cur} expense* ({category_name})\n\n"
            f"Today's total expenses: {today_exp:,.0f} {cur}"
        )

    elif action == "get_summary":
        today = date.today()
        rev = float(
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(Sale.user_id == user.id, Sale.date == today, Sale.is_deleted.isnot(True))
            .scalar()
        )
        exp = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(Expense.user_id == user.id, Expense.date == today, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .scalar()
        )
        profit = rev - exp
        margin = round((profit / rev) * 100) if rev > 0 else 0

        # Low stock count
        low = db.query(func.count(InventoryItem.id)).filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        ).scalar()

        reply = (
            f"📊 *Today's Summary*\n\n"
            f"💰 Revenue: {rev:,.0f} {cur}\n"
            f"💸 Expenses: {exp:,.0f} {cur}\n"
            f"📈 Profit: {profit:,.0f} {cur} ({margin}%)\n"
        )
        if low and low > 0:
            reply += f"\n⚠️ {low} item(s) low on stock"
        return reply

    elif action == "get_week_summary":
        today = date.today()
        week_start = today - timedelta(days=today.weekday())  # Monday
        rev = float(
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(Sale.user_id == user.id, Sale.date >= week_start, Sale.date <= today, Sale.is_deleted.isnot(True))
            .scalar()
        )
        exp = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(Expense.user_id == user.id, Expense.date >= week_start, Expense.date <= today, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .scalar()
        )
        profit = rev - exp
        days = (today - week_start).days + 1

        return (
            f"📊 *This Week ({week_start.strftime('%d/%m')} - {today.strftime('%d/%m')})*\n\n"
            f"💰 Revenue: {rev:,.0f} {cur}\n"
            f"💸 Expenses: {exp:,.0f} {cur}\n"
            f"📈 Profit: {profit:,.0f} {cur}\n"
            f"📅 {days} days | Avg: {rev/days:,.0f} {cur}/day"
        )

    elif action == "get_profit":
        today = date.today()
        month_start = today.replace(day=1)
        rev = float(
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.is_deleted.isnot(True))
            .scalar()
        )
        exp = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .scalar()
        )
        profit = rev - exp
        margin = round((profit / rev) * 100) if rev > 0 else 0

        return (
            f"💰 *Monthly Profit ({today.strftime('%B')})*\n\n"
            f"Revenue: {rev:,.0f} {cur}\n"
            f"Expenses: {exp:,.0f} {cur}\n"
            f"*Net Profit: {profit:,.0f} {cur}*\n"
            f"Margin: {margin}%"
        )

    elif action == "get_inventory_alerts":
        low_stock = (
            db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.unit)
            .filter(
                InventoryItem.user_id == user.id,
                InventoryItem.quantity <= InventoryItem.min_threshold,
            )
            .all()
        )
        if not low_stock:
            return "✅ *All inventory levels are good!*\nNo items below threshold."

        lines = ["⚠️ *Low Stock Items:*\n"]
        for name, qty, unit in low_stock:
            lines.append(f"• {name}: {float(qty):.0f} {unit}")
        return "\n".join(lines)

    elif action == "show_help":
        return (
            "🤖 *BonBox WhatsApp Commands:*\n\n"
            "*Log revenue:*\n"
            "• Send a number: `14500`\n"
            "• Or: `revenue 14500`\n\n"
            "*Log expense:*\n"
            "• `expense 2500 ingredients`\n"
            "• `expense 800 rent`\n\n"
            "*Check data:*\n"
            "• `summary` or `s` — Today's stats\n"
            "• `week` or `w` — This week\n"
            "• `profit` or `p` — Monthly profit\n"
            "• `inventory` or `i` — Stock alerts\n"
            "• `help` — This message\n\n"
            "🇩🇰 Danish: `salg`, `udgift`, `overblik`, `lager`, `hjælp`"
        )

    else:
        return (
            f"🤔 I didn't understand: \"{parsed.get('text', body)}\"\n\n"
            "Send *help* to see available commands."
        )
