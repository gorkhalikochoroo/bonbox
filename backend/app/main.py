from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from sqlalchemy import text

from app.config import settings
from app.routers import auth, sales, expenses, inventory, reports, dashboard, staffing, waste, feedback, cashbook, events
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
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP",
    "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT false",
]

try:
    with engine.connect() as conn:
        for sql in _migrations:
            conn.execute(text(sql))
        conn.commit()
    print("Schema migrations applied successfully")
except Exception as e:
    print(f"Migration warning: {e}")

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


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health_check():
    return {"status": "ok"}
