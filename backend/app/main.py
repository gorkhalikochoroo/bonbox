from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from sqlalchemy import text

from app.config import settings
from app.routers import auth, sales, expenses, inventory, reports, dashboard, staffing, waste, feedback, cashbook, events, khata, budget, loan, email_settings, whatsapp, weather, agent, bank_import, team, business_profile, payment_import, cashflow, tax, pricing, retention, expiry, outlet, competitor, branch, daily_close, workshop
from app.database import engine, Base
from app.models import *  # noqa: ensure all models are loaded

Base.metadata.create_all(bind=engine)

# Run schema migrations (idempotent — safe to run multiple times)
_migrations = [
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'card'",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS expense_alerts_enabled BOOLEAN DEFAULT true",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS currency VARCHAR(10)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal NUMERIC(12,2) DEFAULT 0",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS bottle_size NUMERIC(10,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pour_size NUMERIC(10,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pour_unit VARCHAR(20)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sell_price_per_pour NUMERIC(12,2)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,6)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,6)",
    # Returns / exchange tracking on sales
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed'",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_reason TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_action VARCHAR(20)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS return_amount NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP",
    # Item-sale columns
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS inventory_item_id VARCHAR(36) REFERENCES inventory_items(id) ON DELETE SET NULL",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS quantity_sold NUMERIC(10,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS cost_at_sale NUMERIC(12,2)",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_name TEXT",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN DEFAULT false",
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_photo VARCHAR(500)",
    # Inventory items — columns that may have been added after initial create
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sell_price NUMERIC(12,2)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS barcode TEXT",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_url TEXT",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN DEFAULT false",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'",
    # Expenses
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN DEFAULT false",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_photo VARCHAR(500)",
    # Inventory logs
    "ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS batch_id TEXT",
    # Users
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type VARCHAR(50) DEFAULT 'restaurant'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_goal NUMERIC(12,2) DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'owner'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_id VARCHAR(36) REFERENCES users(id)",
    # Khata / Loans soft-delete
    "ALTER TABLE khata_customers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    "ALTER TABLE loan_persons ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false",
    # Payment connections — auto-sync
    "ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN DEFAULT true",
    "ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS last_auto_imported INTEGER DEFAULT 0",
    # Branch-based bookkeeping — nullable branch_id on core tables
    "ALTER TABLE sales ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
    "ALTER TABLE waste_logs ADD COLUMN IF NOT EXISTS branch_id VARCHAR(36)",
]

def _run_migrations():
    """Run schema migrations — works with both PostgreSQL and SQLite."""
    from sqlalchemy import inspect as sa_inspect
    is_sqlite = str(engine.url).startswith("sqlite")

    with engine.connect() as conn:
        if is_sqlite:
            # SQLite: no IF NOT EXISTS, so check columns first then add missing ones
            insp = sa_inspect(engine)
            _cache = {}
            def _has_col(table, col):
                if table not in _cache:
                    try:
                        _cache[table] = {c["name"] for c in insp.get_columns(table)}
                    except Exception:
                        _cache[table] = set()
                return col in _cache[table]

            def _add(table, col, typedef):
                if not _has_col(table, col):
                    try:
                        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}"))
                        _cache.setdefault(table, set()).add(col)
                        return True
                    except Exception:
                        pass
                return False

            ok = 0
            # Existing columns
            ok += _add("expenses", "payment_method", "VARCHAR(20) DEFAULT 'card'")
            ok += _add("expenses", "notes", "TEXT")
            ok += _add("sales", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "deleted_at", "TIMESTAMP")
            ok += _add("expenses", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("expenses", "deleted_at", "TIMESTAMP")
            ok += _add("waste_logs", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("waste_logs", "deleted_at", "TIMESTAMP")
            ok += _add("cash_transactions", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("cash_transactions", "deleted_at", "TIMESTAMP")
            ok += _add("cash_transactions", "reference_id", "VARCHAR(100)")
            ok += _add("users", "reset_token", "VARCHAR(100)")
            ok += _add("users", "reset_token_expires", "TIMESTAMP")
            ok += _add("expenses", "is_personal", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "reference_id", "VARCHAR(100)")
            ok += _add("users", "daily_digest_enabled", "BOOLEAN DEFAULT 0")
            ok += _add("users", "expense_alerts_enabled", "BOOLEAN DEFAULT 1")
            ok += _add("users", "currency", "VARCHAR(10)")
            ok += _add("expenses", "reference_id", "VARCHAR(100)")
            ok += _add("users", "monthly_goal", "NUMERIC(12,2) DEFAULT 0")
            ok += _add("inventory_items", "bottle_size", "NUMERIC(10,2)")
            ok += _add("inventory_items", "pour_size", "NUMERIC(10,2)")
            ok += _add("inventory_items", "pour_unit", "VARCHAR(20)")
            ok += _add("inventory_items", "sell_price_per_pour", "NUMERIC(12,2)")
            ok += _add("users", "latitude", "NUMERIC(10,6)")
            ok += _add("users", "longitude", "NUMERIC(10,6)")
            # Item sale columns (may be missing on older SQLite DBs)
            ok += _add("sales", "inventory_item_id", "VARCHAR(36)")
            ok += _add("sales", "quantity_sold", "NUMERIC(10,2)")
            ok += _add("sales", "unit_price", "NUMERIC(12,2)")
            ok += _add("sales", "cost_at_sale", "NUMERIC(12,2)")
            ok += _add("sales", "item_name", "TEXT")
            # Returns / exchange columns
            ok += _add("sales", "status", "VARCHAR(20) DEFAULT 'completed'")
            ok += _add("sales", "return_reason", "TEXT")
            ok += _add("sales", "return_action", "VARCHAR(20)")
            ok += _add("sales", "return_amount", "NUMERIC(12,2)")
            ok += _add("sales", "returned_at", "TIMESTAMP")
            ok += _add("sales", "is_tax_exempt", "BOOLEAN DEFAULT 0")
            ok += _add("sales", "receipt_photo", "VARCHAR(500)")
            # Inventory items — columns that may have been added after initial create
            ok += _add("inventory_items", "sell_price", "NUMERIC(12,2)")
            ok += _add("inventory_items", "barcode", "TEXT")
            ok += _add("inventory_items", "expiry_date", "DATE")
            ok += _add("inventory_items", "image_url", "TEXT")
            ok += _add("inventory_items", "is_perishable", "BOOLEAN DEFAULT 0")
            ok += _add("inventory_items", "category", "TEXT DEFAULT 'General'")
            # Expenses
            ok += _add("expenses", "is_tax_exempt", "BOOLEAN DEFAULT 0")
            ok += _add("expenses", "receipt_photo", "VARCHAR(500)")
            # Inventory logs
            ok += _add("inventory_logs", "batch_id", "TEXT")
            # Users
            ok += _add("users", "business_type", "VARCHAR(50) DEFAULT 'restaurant'")
            ok += _add("users", "daily_goal", "NUMERIC(12,2) DEFAULT 0")
            ok += _add("users", "role", "VARCHAR(20) DEFAULT 'owner'")
            ok += _add("users", "owner_id", "VARCHAR(36)")
            # Khata / Loans soft-delete
            ok += _add("khata_customers", "is_deleted", "BOOLEAN DEFAULT 0")
            ok += _add("loan_persons", "is_deleted", "BOOLEAN DEFAULT 0")
            # Payment connections — auto-sync
            ok += _add("payment_connections", "auto_sync", "BOOLEAN DEFAULT 1")
            ok += _add("payment_connections", "last_auto_imported", "INTEGER DEFAULT 0")
            # Branch-based bookkeeping
            ok += _add("sales", "branch_id", "VARCHAR(36)")
            ok += _add("expenses", "branch_id", "VARCHAR(36)")
            ok += _add("cash_transactions", "branch_id", "VARCHAR(36)")
            ok += _add("inventory_items", "branch_id", "VARCHAR(36)")
            ok += _add("waste_logs", "branch_id", "VARCHAR(36)")
            conn.commit()
            print(f"Schema migrations (SQLite): {ok} new columns added")
        else:
            # PostgreSQL: supports IF NOT EXISTS
            # IMPORTANT: Use SAVEPOINT per migration so one failure
            # doesn't abort the entire transaction (PG behaviour).
            ok = 0
            failed = 0
            for i, sql in enumerate(_migrations):
                sp = f"sp_{i}"
                try:
                    conn.execute(text(f"SAVEPOINT {sp}"))
                    conn.execute(text(sql))
                    conn.execute(text(f"RELEASE SAVEPOINT {sp}"))
                    ok += 1
                except Exception as e:
                    conn.execute(text(f"ROLLBACK TO SAVEPOINT {sp}"))
                    failed += 1
                    print(f"Migration {i} skipped: {e}")
            conn.commit()
            print(f"Schema migrations (PG): {ok} applied, {failed} skipped")

try:
    _run_migrations()
except Exception as e:
    print(f"Migration warning: {e}")

# --- Data migration: fix cashbook auto-synced entries ---
try:
    is_sqlite_db = str(engine.url).startswith("sqlite")
    with engine.connect() as conn:
        if is_sqlite_db:
            # SQLite: use CAST(... AS TEXT) instead of ::text, and UPDATE ... FROM not supported
            conn.execute(text("""
                DELETE FROM cash_transactions
                WHERE reference_id LIKE 'expense_%'
                AND reference_id IN (
                    SELECT 'expense_' || CAST(e.id AS TEXT)
                    FROM expenses e
                    WHERE e.is_personal = 1
                )
            """))
            # SQLite doesn't support UPDATE ... FROM, so use a subquery
            conn.execute(text("""
                UPDATE cash_transactions
                SET category = (
                    SELECT ec.name
                    FROM expenses e
                    JOIN expense_categories ec ON e.category_id = ec.id
                    WHERE cash_transactions.reference_id = 'expense_' || CAST(e.id AS TEXT)
                )
                WHERE category = 'Purchase'
                AND reference_id LIKE 'expense_%'
                AND EXISTS (
                    SELECT 1 FROM expenses e
                    JOIN expense_categories ec ON e.category_id = ec.id
                    WHERE cash_transactions.reference_id = 'expense_' || CAST(e.id AS TEXT)
                )
            """))
        else:
            # PostgreSQL
            conn.execute(text("""
                DELETE FROM cash_transactions
                WHERE reference_id LIKE 'expense_%'
                AND reference_id IN (
                    SELECT 'expense_' || e.id::text
                    FROM expenses e
                    WHERE e.is_personal = true
                )
            """))
            conn.execute(text("""
                UPDATE cash_transactions ct
                SET category = ec.name
                FROM expenses e
                JOIN expense_categories ec ON e.category_id = ec.id
                WHERE ct.reference_id = 'expense_' || e.id::text
                AND ct.category = 'Purchase'
            """))

        conn.commit()
    print("Data migration: cashbook entries fixed")
except Exception as e:
    print(f"Data migration warning: {e}")

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])

# --- App Setup ---
is_prod = settings.ENVIRONMENT == "production"

app = FastAPI(
    title="BonBox",
    description="Din digitale bonkasse — smart analytics for small businesses",
    version="1.0.0",
    docs_url=None if is_prod else "/docs",
    redoc_url=None if is_prod else "/redoc",
    openapi_url=None if is_prod else "/openapi.json",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# --- CORS (tightened) ---
origins = [
    settings.FRONTEND_URL,
    "http://localhost:5173",
    "https://bonbox.vercel.app",
    "https://bonbox.dk",
    "https://www.bonbox.dk",
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# --- Security Headers Middleware ---
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if is_prod:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# --- Routers ---
app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(sales.router, prefix="/api/sales", tags=["Sales"])
app.include_router(expenses.router, prefix="/api/expenses", tags=["Expenses"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(staffing.router, prefix="/api/staffing", tags=["Staffing"])
app.include_router(waste.router, prefix="/api/waste", tags=["Waste"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["Feedback"])
app.include_router(cashbook.router, prefix="/api/cashbook", tags=["Cash Book"])
app.include_router(events.router, prefix="/api/events", tags=["Events"])
app.include_router(khata.router, prefix="/api/khata", tags=["Khata"])
app.include_router(budget.router, prefix="/api/budgets", tags=["Budgets"])
app.include_router(loan.router, prefix="/api/loans", tags=["Loans"])
app.include_router(email_settings.router, prefix="/api/email", tags=["Email"])
app.include_router(whatsapp.router, prefix="/api/whatsapp", tags=["WhatsApp"])
app.include_router(weather.router, prefix="/api/weather", tags=["Weather"])
app.include_router(agent.router, prefix="/api/agent", tags=["AI Agent"])
app.include_router(bank_import.router, prefix="/api/bank-import", tags=["Bank Import"])
app.include_router(payment_import.router, prefix="/api/payment-import", tags=["Payment Import"])
app.include_router(team.router, prefix="/api/team", tags=["Team"])
app.include_router(business_profile.router, prefix="/api/business", tags=["Business Profile"])
app.include_router(cashflow.router, prefix="/api/cashflow", tags=["Cash Flow"])
app.include_router(tax.router, prefix="/api/tax", tags=["Tax Autopilot"])
app.include_router(pricing.router, prefix="/api/pricing", tags=["Price Optimization"])
app.include_router(retention.router, prefix="/api/retention", tags=["Customer Retention"])
app.include_router(expiry.router, prefix="/api/expiry", tags=["Expiry Forecasting"])
app.include_router(outlet.router, prefix="/api/outlets", tags=["Cross-Outlet Intelligence"])
app.include_router(competitor.router, prefix="/api/competitors", tags=["Competitor Scan"])
app.include_router(branch.router, prefix="/api/branches", tags=["Branch Bookkeeping"])
app.include_router(daily_close.router, prefix="/api/daily-close", tags=["Daily Close / Kasserapport"])
app.include_router(workshop.router, prefix="/api/workshop", tags=["Automobile Workshop"])


# --- Protected Uploads (user can only access own receipts) ---
uploads_dir = Path("uploads/receipts")
uploads_dir.mkdir(parents=True, exist_ok=True)


@app.get("/uploads/receipts/{filename}")
def serve_receipt(filename: str, request: Request):
    """Serve receipt images — files are prefixed with user_id so no cross-user access."""
    file_path = uploads_dir / filename
    if not file_path.exists() or not file_path.is_file():
        return JSONResponse(status_code=404, content={"detail": "File not found"})
    # Prevent path traversal
    try:
        file_path.resolve().relative_to(uploads_dir.resolve())
    except ValueError:
        return JSONResponse(status_code=403, content={"detail": "Access denied"})
    return Response(
        content=file_path.read_bytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


# --- Background scheduler: auto-sync payment providers ---
try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.interval import IntervalTrigger
    from app.services.payment_autosync import run_auto_sync

    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        run_auto_sync,
        trigger=IntervalTrigger(hours=6),
        id="payment_autosync",
        name="Auto-sync payment providers",
        replace_existing=True,
    )
    _scheduler.start()
    print("Payment auto-sync scheduler started (every 6 hours)")

    @app.on_event("shutdown")
    def _shutdown_scheduler():
        _scheduler.shutdown(wait=False)

except Exception as e:
    print(f"Scheduler warning: {e}")


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health_check():
    return {"status": "ok"}


@app.get("/api/health/db")
def health_db():
    """Check database connectivity."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception:
        return JSONResponse(status_code=503, content={"status": "error", "database": "unreachable"})
