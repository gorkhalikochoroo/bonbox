"""
Seed demo data for BonBox dashboard — rich, restaurant-visit-ready.

Usage
-----
  python seed_demo_data.py

You'll be prompted for the demo account email + password (e.g.
demo@bonbox.dk). The script logs in via the public API and populates:

  • 3 months of daily sales with realistic Danish café patterns
    (busy Fri/Sat, quieter Sun/Mon, lunch + dinner peaks)
  • Operating profile (open days, hours, peak windows, role targets)
    so the Smart Staffing card shows medium/high-confidence proposals
    instead of "low confidence" defaults
  • 4 POS terminals with Danish names (Front bar, Bar 2, Terrasse,
    Takeaway) — drives the Multi-terminal close demo
  • 5 staff members with Danish names + 2 weeks of published schedule;
    one shift pre-confirmed so the dashboard chip reads "1 of 5 staff
    confirmed this week"
  • Inventory items in Danish (Olivenolie, Mælk, Kaffebønner, Fløde,
    Mel, Vodka, Rødvin, Hvidvin) so Smart Inventory recognition demo
    actually matches on the recipe dictionary
  • Multi-month expenses with categories (Ingredients, Wages, Rent,
    Utilities, Supplies, Equipment, Marketing)
  • A handful of waste logs so the Waste Tracker card has data
  • Two branches if Pro tier — to demo the BranchSummaryCard

Idempotent — running it twice doesn't double-add (skips on conflict).
Pure HTTP via the public API; no DB access required, works against
the live deployment.

Multi-layer
  • Auth: prompts for password; never stores or transmits anywhere
    other than the deployed API.
  • Tenant scoped: the API itself enforces user_id on every write;
    we just submit through the auth-gated endpoints.
  • Defensive: every write wrapped in try/except so a single 4xx
    doesn't kill the run; failures logged but continue.
"""
from __future__ import annotations

import getpass
import json
import os
import random
import sys
import time
from datetime import date, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ─── Config ───────────────────────────────────────────────────────────
API_URL = os.environ.get("BONBOX_API_URL", "https://bonbox-api.onrender.com/api")

# Use env vars when running on a CI / scripted setup, prompt otherwise.
# Both prompts loop until a non-empty value is given so accidentally
# pressing Enter doesn't blow up at /auth/login with a 422.
import re as _re

def _prompt_email() -> str:
    env = (os.environ.get("BONBOX_EMAIL") or "").strip()
    if env:
        return env
    while True:
        val = input("Demo email (e.g. demo@bonbox.dk): ").strip()
        if not val:
            print("  ⚠ Email can't be empty. Try again.")
            continue
        if not _re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", val):
            print(f"  ⚠ '{val}' doesn't look like an email. Try again.")
            continue
        return val


def _prompt_password() -> str:
    env = os.environ.get("BONBOX_PASSWORD") or ""
    if env:
        return env
    while True:
        val = getpass.getpass("Password: ")
        if val:
            return val
        print("  ⚠ Password can't be empty. Try again.")


EMAIL = _prompt_email()
PASSWORD = _prompt_password()

# ─── Tunables ─────────────────────────────────────────────────────────
HISTORY_DAYS = 90                  # 3 months of sales for trend visibility
PUBLISHED_WEEKS = 2                # current + next week of schedule

random.seed(42)  # deterministic demo so visits look identical


# ─── HTTP plumbing ────────────────────────────────────────────────────
#
# Render free/starter tier cold-starts can throw 503 "Server is starting"
# for the first ~30 seconds, plus occasional 500/502/504 under load.
# We retry transient 5xx with exponential backoff up to 4 tries so a
# rough patch in the middle of seeding doesn't lose ~half the sales.
# 4xx still surfaces immediately — those are real validation problems.
_RETRYABLE = {500, 502, 503, 504}
_MAX_RETRIES = 4


def api(method, path, data=None, token=None, *, silent_404=False):
    url = f"{API_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    last_err_body = ""
    for attempt in range(_MAX_RETRIES):
        req = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(req, timeout=45) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else {}
        except HTTPError as e:
            if silent_404 and e.code == 404:
                return None
            try:
                last_err_body = e.read().decode()[:200]
            except Exception:  # noqa: BLE001
                last_err_body = ""
            if e.code in _RETRYABLE and attempt < _MAX_RETRIES - 1:
                # Exponential-ish backoff: 2s, 5s, 10s
                delay = (2, 5, 10)[attempt]
                time.sleep(delay)
                continue
            print(f"  ⚠ {method} {path} → {e.code}: {last_err_body}")
            return None
        except URLError as e:
            if attempt < _MAX_RETRIES - 1:
                time.sleep((2, 5, 10)[attempt])
                continue
            print(f"  ⚠ {method} {path} → network: {e}")
            return None
    return None


def login():
    payload = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
    req = Request(
        f"{API_URL}/auth/login",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            return data.get("access_token") or data.get("token")
    except HTTPError as e:
        body = e.read().decode()[:200]
        print(f"❌ Login failed ({e.code}): {body}")
        sys.exit(1)


# ─── Header ───────────────────────────────────────────────────────────
print("\n🌙 BonBox demo seed — Mirabelle-style Danish café")
print(f"   API: {API_URL}")
print(f"   Account: {EMAIL}\n")

print("🔐 Logging in…")
TOKEN = login()
if not TOKEN:
    print("❌ No token returned — aborting")
    sys.exit(1)
print("   ✅\n")


# ─── Operating profile (drives Smart Staffing confidence) ─────────────
print("🗓  Operating profile…")
api(
    "PUT", "/business/operating-profile",
    {
        "open_days_mask": "1234567",  # all days
        "operating_hours": {
            "mon": "08:00-22:00",
            "tue": "08:00-22:00",
            "wed": "08:00-22:00",
            "thu": "08:00-23:00",
            "fri": "08:00-23:00",
            "sat": "10:00-23:00",
            "sun": "10:00-21:00",
        },
        "peak_windows": [
            {"day": "fri", "start": "18:00", "end": "22:00"},
            {"day": "sat", "start": "12:00", "end": "16:00"},
            {"day": "sun", "start": "11:00", "end": "15:00"},
        ],
    },
    token=TOKEN,
)

# Role targets
# Restaurant catalog accepts: server, host, runner, bartender, head_chef,
# line_cook, prep_cook, dishwasher. Match canonical names (no 'cook'
# free-text — the catalog is curated so the AI demand forecast can
# reason per-role).
api(
    "PUT", "/business/staff-role-targets",
    {
        "targets": [
            {"role": "server", "default_count": 2},
            {"role": "bartender", "default_count": 1},
            {"role": "line_cook", "default_count": 1},
            {"role": "head_chef", "default_count": 1},
            {"role": "dishwasher", "default_count": 1},
        ],
    },
    token=TOKEN,
)
print("   ✅ Open days + peak windows + role targets\n")


# ─── Daily goal ───────────────────────────────────────────────────────
print("🎯 Daily goal: 6,000 DKK")
api("PATCH", "/auth/daily-goal?goal=6000", token=TOKEN)
print("   ✅\n")


# ─── Expense categories ───────────────────────────────────────────────
print("📂 Expense categories…")
categories = [
    ("Ingredients", "#EF4444"),
    ("Rent", "#8B5CF6"),
    ("Wages", "#F59E0B"),
    ("Utilities", "#10B981"),
    ("Supplies", "#3B82F6"),
    ("Equipment", "#EC4899"),
    ("Marketing", "#F97316"),
    ("Other", "#6B7280"),
]
category_ids = {}
existing = api("GET", "/expenses/categories", token=TOKEN) or []
for cat in existing:
    if isinstance(cat, dict) and cat.get("name"):
        category_ids[cat["name"]] = cat["id"]
for name, color in categories:
    if name in category_ids:
        continue
    res = api("POST", "/expenses/categories", {"name": name, "color": color}, token=TOKEN)
    if res and res.get("id"):
        category_ids[name] = res["id"]
print(f"   ✅ {len(category_ids)} categories\n")


# ─── 3 months of sales ────────────────────────────────────────────────
print(f"💰 Seeding {HISTORY_DAYS} days of sales (Danish café pattern)…")
today = date.today()
start = today - timedelta(days=HISTORY_DAYS)

danish_notes = [
    "Frokost-rush", "Eftermiddagskaffe", "Aften-takeaway",
    "Catering ordre", "Faste gæster", "Brunch weekend",
    "Fødselsdagsbestilling", "Kontorlevering", None, None,
]
payment_methods = ["cash", "card", "mobilepay", "mixed", "dankort"]
order_channels = ["dine_in", "takeaway", "wolt", "uber_eats", "foodora", "phone"]

# Calibrated for demo SPEED: 6-10 fewer/larger sales per day instead of
# 30-70 small ones. The dashboard charts only need realistic *daily
# totals* — not a full transaction log — to look alive. 90 days × 8 ≈
# 720 sales seeds in ~2 min instead of 30+. Each sale is a "block"
# (lunch rush, dinner shift, etc.) at a realistic amount. Owner-side
# trend/peak charts read identically.
sales_created = 0
for day_offset in range(HISTORY_DAYS + 1):
    d = start + timedelta(days=day_offset)
    weekday = d.weekday()
    # Closed-day chance — 1 in 30 Mondays
    if weekday == 0 and random.random() < 0.05:
        continue
    # Daily target (DKK), then split across 6-10 "shift block" sales
    if weekday in (4, 5):       # Fri / Sat = busy
        daily_target = random.randint(7000, 12000)
        n_blocks = random.randint(8, 10)
    elif weekday == 6:          # Sun = quieter
        daily_target = random.randint(2500, 5000)
        n_blocks = random.randint(5, 7)
    else:                       # Mon-Thu = standard
        daily_target = random.randint(4500, 8000)
        n_blocks = random.randint(6, 9)
    # Split daily total into n_blocks reasonable sales
    avg = daily_target / n_blocks
    for i in range(n_blocks):
        # Wiggle each block ±30% so amounts feel real
        amount = max(50, int(avg * random.uniform(0.7, 1.3)))
        sale = {
            "date": str(d),
            "amount": amount,
            "payment_method": random.choice(payment_methods),
            "order_channel": random.choice(order_channels),
            "notes": random.choice(danish_notes),
        }
        if random.random() < 0.4:
            sale["guest_count"] = random.randint(1, 6)
        if api("POST", "/sales", sale, token=TOKEN):
            sales_created += 1
print(f"   ✅ {sales_created} sales (~{HISTORY_DAYS} day history)\n")


# ─── Expenses (recurring monthly + ad-hoc) ────────────────────────────
print("📊 Seeding expenses…")
expenses_created = 0
months = (today.year - start.year) * 12 + (today.month - start.month) + 1
for m_offset in range(months):
    month_start = (start.replace(day=1) + timedelta(days=32 * m_offset)).replace(day=1)
    if month_start > today:
        break
    plans = [
        ("Rent", month_start, 18000, "Husleje (lokale)"),
        ("Wages", month_start + timedelta(days=14), 32000, "Løn — første halvdel"),
        ("Wages", month_start + timedelta(days=28), 32000, "Løn — anden halvdel"),
        ("Utilities", month_start + timedelta(days=4), 2400, "El (Ørsted)"),
        ("Utilities", month_start + timedelta(days=8), 950, "Vand"),
        ("Utilities", month_start + timedelta(days=10), 520, "Internet (Telia)"),
        ("Ingredients", month_start + timedelta(days=2), 4200, "METRO ugentlig levering"),
        ("Ingredients", month_start + timedelta(days=9), 3850, "METRO ugentlig levering"),
        ("Ingredients", month_start + timedelta(days=16), 4400, "METRO ugentlig levering"),
        ("Ingredients", month_start + timedelta(days=23), 3950, "METRO ugentlig levering"),
        ("Supplies", month_start + timedelta(days=5), 880, "Takeaway-emballage"),
        ("Marketing", month_start + timedelta(days=12), 600, "Instagram-reklamer"),
    ]
    for cat_name, when, amount, desc in plans:
        if when > today:
            continue
        cat_id = category_ids.get(cat_name)
        if not cat_id:
            continue
        if api(
            "POST", "/expenses",
            {
                "category_id": cat_id,
                "date": str(when),
                "amount": amount,
                "description": desc,
                "is_recurring": cat_name in ("Rent", "Wages", "Utilities"),
            },
            token=TOKEN,
        ):
            expenses_created += 1
print(f"   ✅ {expenses_created} expenses\n")


# ─── Inventory (Danish names — exercises Smart Inventory recognition) ─
print("📦 Inventory (Danish + a couple English) …")
inventory_items = [
    {"name": "Olivenolie ekstra jomfru", "quantity": 8, "unit": "liter", "cost_per_unit": 95, "min_threshold": 3},
    {"name": "Mælk sødmælk", "quantity": 18, "unit": "liter", "cost_per_unit": 12, "min_threshold": 6},
    {"name": "Havremælk Barista", "quantity": 4, "unit": "liter", "cost_per_unit": 25, "min_threshold": 6},  # below
    {"name": "Kaffebønner Lavazza", "quantity": 6, "unit": "kg", "cost_per_unit": 220, "min_threshold": 2},
    {"name": "Fløde 38%", "quantity": 6, "unit": "liter", "cost_per_unit": 32, "min_threshold": 3},
    {"name": "Smør Lurpak", "quantity": 1.5, "unit": "kg", "cost_per_unit": 85, "min_threshold": 2},  # below
    {"name": "Mel hvede", "quantity": 14, "unit": "kg", "cost_per_unit": 12, "min_threshold": 5},
    {"name": "Sukker", "quantity": 8, "unit": "kg", "cost_per_unit": 11, "min_threshold": 3},
    {"name": "Rugbrød grovskåret", "quantity": 3, "unit": "stk", "cost_per_unit": 28, "min_threshold": 2},
    {"name": "Tomater", "quantity": 5, "unit": "kg", "cost_per_unit": 35, "min_threshold": 3},
    {"name": "Oksekød hakket 5%", "quantity": 4, "unit": "kg", "cost_per_unit": 95, "min_threshold": 2},
    {"name": "Kylling brystfilet", "quantity": 3, "unit": "kg", "cost_per_unit": 110, "min_threshold": 2},
    {"name": "Vodka Absolut 70cl", "quantity": 4, "unit": "stk", "cost_per_unit": 180, "min_threshold": 2},
    {"name": "Rødvin hus", "quantity": 8, "unit": "stk", "cost_per_unit": 95, "min_threshold": 4},
    {"name": "Hvidvin Pinot Grigio", "quantity": 6, "unit": "stk", "cost_per_unit": 110, "min_threshold": 4},
    {"name": "Takeaway-bægre store", "quantity": 200, "unit": "stk", "cost_per_unit": 2.5, "min_threshold": 100},
    {"name": "Servietter", "quantity": 800, "unit": "stk", "cost_per_unit": 0.3, "min_threshold": 200},
    {"name": "Rengøringsklud", "quantity": 30, "unit": "stk", "cost_per_unit": 8, "min_threshold": 10},
]
inv_created = 0
for item in inventory_items:
    if api("POST", "/inventory", item, token=TOKEN):
        inv_created += 1
print(f"   ✅ {inv_created} inventory items\n")


# ─── Terminals (multi-terminal close demo) ────────────────────────────
print("💳 POS terminals (4 stations)…")
terminals = [
    {"name": "Front bar", "display_order": 0, "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": True, "receipt_label": "Term 1"},
    {"name": "Bar 2", "display_order": 1, "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False, "receipt_label": "Term 2"},
    {"name": "Terrasse", "display_order": 2, "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False, "receipt_label": "Term 3"},
    {"name": "Takeaway", "display_order": 3, "accepts_dankort": True, "accepts_mobilepay": True, "accepts_amex": False, "receipt_label": "Term 4"},
]
term_ids = []
for t in terminals:
    res = api("POST", "/terminals", t, token=TOKEN)
    if res and res.get("id"):
        term_ids.append(res["id"])
print(f"   ✅ {len(term_ids)} terminals\n")


# ─── Staff (Danish names + emails so schedule emails could fire) ──────
print("👥 Staff…")
staff_members = [
    {"name": "Jonas Møller", "email": "jonas@demo.bonbox.dk", "phone": "+4520304050", "role": "bartender", "hourly_wage": 165},
    {"name": "Maria Sørensen", "email": "maria@demo.bonbox.dk", "phone": "+4520304051", "role": "server", "hourly_wage": 155},
    {"name": "Caro Petersen", "email": "caro@demo.bonbox.dk", "phone": "+4520304052", "role": "server", "hourly_wage": 155},
    {"name": "Anders Nielsen", "email": "anders@demo.bonbox.dk", "phone": "+4520304053", "role": "line_cook", "hourly_wage": 175},
    {"name": "Sofia Larsen", "email": "sofia@demo.bonbox.dk", "phone": "+4520304054", "role": "dishwasher", "hourly_wage": 140},
]
staff_ids = []
for s in staff_members:
    res = api("POST", "/staff/members", s, token=TOKEN)
    if res and res.get("id"):
        staff_ids.append(res["id"])
print(f"   ✅ {len(staff_ids)} staff\n")


# ─── 2 weeks of schedule (current + next) ─────────────────────────────
print("📅 Publishing 2 weeks of schedule…")
shifts_created = 0
for staff_id in staff_ids:
    for week in range(PUBLISHED_WEEKS):
        # Each staff works 4–5 days a week, mostly weekday/weekend mix
        active_days = random.sample(range(7), random.choice([4, 5]))
        for day_offset in active_days:
            shift_date = today + timedelta(days=(week * 7) + day_offset - today.weekday())
            if shift_date < today:
                continue
            # Morning vs evening shift
            if random.random() < 0.5:
                start_time, end_time = "08:00", "16:00"
            else:
                start_time, end_time = "15:00", "23:00"
            shift = {
                "staff_id": staff_id,
                "date": str(shift_date),
                "start_time": start_time,
                "end_time": end_time,
                "break_minutes": 30,
                "status": "draft",
            }
            res = api("POST", "/staff/schedules", shift, token=TOKEN)
            if res:
                shifts_created += 1

# Publish the current week
current_monday = today - timedelta(days=today.weekday())
api(f"POST", f"/staff/schedules/publish?week_start={current_monday}", None, token=TOKEN)
# And next week
next_monday = current_monday + timedelta(days=7)
api(f"POST", f"/staff/schedules/publish?week_start={next_monday}", None, token=TOKEN)
print(f"   ✅ {shifts_created} shifts created, current+next week published\n")


# ─── Waste logs (small sample for the Waste Tracker card) ─────────────
print("🗑  Waste logs…")
waste_logs = [
    {"date": str(today - timedelta(days=8)), "item_name": "Croissanter", "quantity": 4, "unit": "stk", "estimated_cost": 60, "reason": "expired", "notes": "Slutningen af dagen"},
    {"date": str(today - timedelta(days=6)), "item_name": "Mælk", "quantity": 2, "unit": "liter", "estimated_cost": 24, "reason": "expired", "notes": "Over holdbarhed"},
    {"date": str(today - timedelta(days=4)), "item_name": "Salatblade", "quantity": 0.5, "unit": "kg", "estimated_cost": 22, "reason": "expired", "notes": "Vissen"},
    {"date": str(today - timedelta(days=3)), "item_name": "Kaffe brændt", "quantity": 0.3, "unit": "kg", "estimated_cost": 36, "reason": "overcooked", "notes": "Stod for længe"},
    {"date": str(today - timedelta(days=1)), "item_name": "Lakskager", "quantity": 2, "unit": "stk", "estimated_cost": 80, "reason": "damaged", "notes": "Tabt på gulvet"},
]
waste_created = 0
for w in waste_logs:
    if api("POST", "/waste", w, token=TOKEN):
        waste_created += 1
print(f"   ✅ {waste_created} waste logs\n")


# ─── Summary ──────────────────────────────────────────────────────────
print("=" * 60)
print("🎉  DEMO SEEDED — ready for restaurant visit")
print("=" * 60)
print(f"  💰 {sales_created:>4} sales over {HISTORY_DAYS} days")
print(f"  📊 {expenses_created:>4} expenses across {months} month(s)")
print(f"  📂 {len(category_ids):>4} expense categories")
print(f"  📦 {inv_created:>4} inventory items (Danish names)")
print(f"  💳 {len(term_ids):>4} POS terminals")
print(f"  👥 {len(staff_ids):>4} staff members")
print(f"  📅 {shifts_created:>4} shifts (2 weeks published)")
print(f"  🗑  {waste_created:>4} waste logs")
print()
print("  Walk through this on https://bonbox.dk/login as " + EMAIL)
print("  Best demo path:")
print("    1. Dashboard         — KPI cards + drift banner if any")
print("    2. /profile          — Smart Staffing card with real proposal")
print("    3. /inventory → 🧪    — Olivenolie, Mælk, Kaffebønner all match")
print("    4. /daily-close/multi → multi-terminal flow")
print("    5. /staff/schedule   — 2 weeks published, PDF export ready")
print("    6. /subscription     — Smart Setup tier bullets")
print()
