"""
Seed demo data for BonBox dashboard.
Run: python seed_demo_data.py

This populates the deployed app with realistic café data via the API.
"""
import json
import random
from datetime import date, timedelta
from urllib.request import Request, urlopen

# === CONFIGURATION ===
API_URL = "https://bonbox-api.onrender.com/api"
EMAIL = input("Enter your BonBox email: ")
PASSWORD = input("Enter your BonBox password: ")


def api(method, path, data=None, token=None):
    """Make API request."""
    url = f"{API_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, headers=headers, method=method)

    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        if hasattr(e, 'read'):
            print(f"  Error: {e.read().decode()[:200]}")
        else:
            print(f"  Error: {e}")
        return None


# === LOGIN ===
print("\n🔐 Logging in...")
login_payload = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
req = Request(
    f"{API_URL}/auth/login",
    data=login_payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
resp = urlopen(req, timeout=30)
token_data = json.loads(resp.read().decode())
TOKEN = token_data["access_token"]
print(f"  ✅ Logged in as {EMAIL}")


# === SET DAILY GOAL ===
print("\n🎯 Setting daily goal to 5,000 DKK...")
api("PATCH", "/auth/daily-goal?goal=5000", token=TOKEN)
print("  ✅ Done")


# === CREATE EXPENSE CATEGORIES ===
print("\n📂 Creating expense categories...")
categories = [
    {"name": "Ingredients", "color": "#EF4444"},
    {"name": "Rent", "color": "#8B5CF6"},
    {"name": "Wages", "color": "#F59E0B"},
    {"name": "Utilities", "color": "#10B981"},
    {"name": "Supplies", "color": "#3B82F6"},
    {"name": "Equipment", "color": "#EC4899"},
    {"name": "Marketing", "color": "#F97316"},
    {"name": "Other", "color": "#6B7280"},
]

category_ids = {}
for cat in categories:
    result = api("POST", "/expenses/categories", cat, TOKEN)
    if result:
        category_ids[cat["name"]] = result["id"]
        print(f"  ✅ {cat['name']}")
    else:
        print(f"  ⚠️  {cat['name']} (may already exist)")

# If categories already existed, fetch them
if not category_ids:
    existing = api("GET", "/expenses/categories", token=TOKEN)
    if existing:
        for cat in existing:
            category_ids[cat["name"]] = cat["id"]
        print(f"  📂 Found {len(category_ids)} existing categories")


# === CREATE SALES DATA ===
print("\n💰 Creating sales data for March 2026...")
today = date.today()
start_of_month = today.replace(day=1)

payment_methods = ["cash", "card", "mobilepay", "mixed", "dankort"]
notes_options = [
    "Lunch rush", "Morning coffee crowd", "Evening takeaway",
    "Catering order", "Regular customers", "Weekend brunch",
    "Birthday party catering", "Office lunch delivery",
    "Quiet morning", "Busy afternoon", None,
]

sales_created = 0
for day_offset in range((today - start_of_month).days + 1):
    current_date = start_of_month + timedelta(days=day_offset)
    weekday = current_date.weekday()

    # Skip some days randomly (closed days)
    if weekday == 6 and random.random() < 0.3:  # Sometimes closed Sunday
        continue

    # Revenue varies by day of week
    if weekday in (4, 5):  # Fri/Sat = busy
        base = random.randint(5500, 9000)
    elif weekday == 6:  # Sunday = quieter
        base = random.randint(2000, 4500)
    else:  # Weekdays
        base = random.randint(3000, 6500)

    sale_data = {
        "date": str(current_date),
        "amount": base,
        "payment_method": random.choice(payment_methods),
        "notes": random.choice(notes_options),
    }
    result = api("POST", "/sales", sale_data, TOKEN)
    if result:
        sales_created += 1

print(f"  ✅ Created {sales_created} sales entries")


# === CREATE EXPENSES ===
print("\n📊 Creating expenses for March 2026...")
expenses_data = [
    # Rent (1st of month)
    {"cat": "Rent", "date": str(start_of_month), "amount": 12000, "desc": "Monthly rent", "recurring": True},
    # Wages (weekly)
    {"cat": "Wages", "date": str(start_of_month + timedelta(days=6)), "amount": 8500, "desc": "Weekly wages - Week 1", "recurring": True},
    {"cat": "Wages", "date": str(start_of_month + timedelta(days=13)), "amount": 8500, "desc": "Weekly wages - Week 2", "recurring": True},
    # Utilities
    {"cat": "Utilities", "date": str(start_of_month + timedelta(days=4)), "amount": 2200, "desc": "Electricity bill", "recurring": True},
    {"cat": "Utilities", "date": str(start_of_month + timedelta(days=8)), "amount": 800, "desc": "Water bill", "recurring": True},
    {"cat": "Utilities", "date": str(start_of_month + timedelta(days=10)), "amount": 450, "desc": "Internet & phone", "recurring": True},
    # Ingredients (multiple times)
    {"cat": "Ingredients", "date": str(start_of_month + timedelta(days=1)), "amount": 3200, "desc": "Weekly grocery order - Metro", "recurring": False},
    {"cat": "Ingredients", "date": str(start_of_month + timedelta(days=4)), "amount": 1800, "desc": "Fresh produce - local market", "recurring": False},
    {"cat": "Ingredients", "date": str(start_of_month + timedelta(days=7)), "amount": 2900, "desc": "Weekly grocery order - Metro", "recurring": False},
    {"cat": "Ingredients", "date": str(start_of_month + timedelta(days=10)), "amount": 1500, "desc": "Dairy & bakery supplies", "recurring": False},
    {"cat": "Ingredients", "date": str(start_of_month + timedelta(days=14)), "amount": 3100, "desc": "Weekly grocery order - Metro", "recurring": False},
    # Supplies
    {"cat": "Supplies", "date": str(start_of_month + timedelta(days=2)), "amount": 950, "desc": "Takeaway containers & bags", "recurring": False},
    {"cat": "Supplies", "date": str(start_of_month + timedelta(days=9)), "amount": 650, "desc": "Cleaning supplies", "recurring": False},
    {"cat": "Supplies", "date": str(start_of_month + timedelta(days=12)), "amount": 380, "desc": "Napkins & paper goods", "recurring": False},
    # Equipment
    {"cat": "Equipment", "date": str(start_of_month + timedelta(days=5)), "amount": 1200, "desc": "New blender", "recurring": False},
    # Marketing
    {"cat": "Marketing", "date": str(start_of_month + timedelta(days=3)), "amount": 500, "desc": "Instagram ads", "recurring": False},
    {"cat": "Marketing", "date": str(start_of_month + timedelta(days=11)), "amount": 300, "desc": "Flyer printing", "recurring": False},
    # Other
    {"cat": "Other", "date": str(start_of_month + timedelta(days=6)), "amount": 250, "desc": "Accounting software subscription", "recurring": True},
]

expenses_created = 0
for exp in expenses_data:
    cat_id = category_ids.get(exp["cat"])
    if not cat_id:
        print(f"  ⚠️  Skipping {exp['desc']} — category '{exp['cat']}' not found")
        continue

    expense_data = {
        "category_id": cat_id,
        "date": exp["date"],
        "amount": exp["amount"],
        "description": exp["desc"],
        "is_recurring": exp["recurring"],
    }
    result = api("POST", "/expenses", expense_data, TOKEN)
    if result:
        expenses_created += 1

print(f"  ✅ Created {expenses_created} expense entries")


# === CREATE INVENTORY ===
print("\n📦 Creating inventory items...")
inventory_items = [
    {"name": "Coffee Beans (Arabica)", "quantity": 8, "unit": "kg", "cost_per_unit": 120, "min_threshold": 3},
    {"name": "Whole Milk", "quantity": 15, "unit": "liters", "cost_per_unit": 12, "min_threshold": 5},
    {"name": "Oat Milk", "quantity": 2, "unit": "liters", "cost_per_unit": 25, "min_threshold": 4},  # Below threshold!
    {"name": "All-Purpose Flour", "quantity": 12, "unit": "kg", "cost_per_unit": 15, "min_threshold": 5},
    {"name": "White Sugar", "quantity": 6, "unit": "kg", "cost_per_unit": 12, "min_threshold": 3},
    {"name": "Butter", "quantity": 1, "unit": "kg", "cost_per_unit": 85, "min_threshold": 2},  # Below threshold!
    {"name": "Takeaway Cups (Large)", "quantity": 150, "unit": "pieces", "cost_per_unit": 2.5, "min_threshold": 100},
    {"name": "Takeaway Cups (Small)", "quantity": 80, "unit": "pieces", "cost_per_unit": 1.8, "min_threshold": 100},  # Below threshold!
    {"name": "Chocolate Powder", "quantity": 3, "unit": "kg", "cost_per_unit": 65, "min_threshold": 2},
    {"name": "Paper Napkins", "quantity": 500, "unit": "pieces", "cost_per_unit": 0.3, "min_threshold": 200},
    {"name": "Sandwich Bread", "quantity": 4, "unit": "boxes", "cost_per_unit": 35, "min_threshold": 2},
    {"name": "Fresh Eggs", "quantity": 3, "unit": "boxes", "cost_per_unit": 45, "min_threshold": 2},
]

inventory_created = 0
for item in inventory_items:
    result = api("POST", "/inventory", item, TOKEN)
    if result:
        inventory_created += 1

print(f"  ✅ Created {inventory_created} inventory items ({sum(1 for i in inventory_items if i['quantity'] <= i['min_threshold'])} below threshold)")


# === CREATE WASTE LOGS ===
print("\n🗑️  Creating waste logs...")
waste_logs = [
    {"date": str(start_of_month + timedelta(days=2)), "item_name": "Croissants", "quantity": 5, "unit": "pieces", "estimated_cost": 75, "reason": "expired", "notes": "End of day leftover"},
    {"date": str(start_of_month + timedelta(days=5)), "item_name": "Milk", "quantity": 2, "unit": "liters", "estimated_cost": 24, "reason": "expired", "notes": "Past expiry date"},
    {"date": str(start_of_month + timedelta(days=7)), "item_name": "Sandwich filling", "quantity": 0.5, "unit": "kg", "estimated_cost": 120, "reason": "expired", "notes": "Chicken salad gone bad"},
    {"date": str(start_of_month + timedelta(days=9)), "item_name": "Coffee (burnt)", "quantity": 0.3, "unit": "kg", "estimated_cost": 36, "reason": "overcooked", "notes": "Left on too long"},
    {"date": str(start_of_month + timedelta(days=11)), "item_name": "Cake slices", "quantity": 3, "unit": "pieces", "estimated_cost": 90, "reason": "damaged", "notes": "Dropped tray"},
    {"date": str(start_of_month + timedelta(days=14)), "item_name": "Salad greens", "quantity": 1, "unit": "kg", "estimated_cost": 45, "reason": "expired", "notes": "Wilted lettuce"},
]

waste_created = 0
for waste in waste_logs:
    result = api("POST", "/waste", waste, TOKEN)
    if result:
        waste_created += 1

print(f"  ✅ Created {waste_created} waste log entries")


# === CREATE STAFFING RULES ===
print("\n👥 Creating staffing rules...")
staffing_rules = [
    {"label": "Slow Day", "revenue_min": 0, "revenue_max": 3000, "recommended_staff": 2},
    {"label": "Normal Day", "revenue_min": 3000, "revenue_max": 6000, "recommended_staff": 3},
    {"label": "Busy Day", "revenue_min": 6000, "revenue_max": 15000, "recommended_staff": 5},
]

staffing_created = 0
for rule in staffing_rules:
    result = api("POST", "/staffing/rules", rule, TOKEN)
    if result:
        staffing_created += 1

print(f"  ✅ Created {staffing_created} staffing rules")


# === SUMMARY ===
print("\n" + "=" * 50)
print("🎉 DEMO DATA SEEDED SUCCESSFULLY!")
print("=" * 50)
print(f"  💰 {sales_created} sales entries")
print(f"  📊 {expenses_created} expenses")
print(f"  📂 {len(category_ids)} expense categories")
print(f"  📦 {inventory_created} inventory items")
print(f"  🗑️  {waste_created} waste logs")
print(f"  👥 {staffing_created} staffing rules")
print(f"\n  Go to https://bonbox.dk and check your dashboard!")
print("=" * 50)
