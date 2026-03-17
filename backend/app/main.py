from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routers import auth, sales, expenses, inventory, reports, dashboard, staffing, waste
from app.database import engine, Base
from app.models import *  # noqa: ensure all models are loaded

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="BonBox",
    description="Din digitale bonkasse — smart analytics for small restaurants and cafes",
    version="1.0.0",
)

from app.config import settings

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
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(sales.router, prefix="/api/sales", tags=["Sales"])
app.include_router(expenses.router, prefix="/api/expenses", tags=["Expenses"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(staffing.router, prefix="/api/staffing", tags=["Staffing"])
app.include_router(waste.router, prefix="/api/waste", tags=["Waste"])


# Serve uploaded receipt photos
uploads_dir = Path("uploads/receipts")
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
