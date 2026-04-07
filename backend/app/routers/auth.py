import io
import csv
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem, InventoryLog
from app.models.cashbook import CashTransaction
from app.models.waste import WasteLog
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.budget import Budget
from app.models.loan import LoanPerson, LoanTransaction
from app.models.staffing import StaffingRule
from app.models.feedback import Feedback
from app.models.event_log import EventLog
from app.models.category_mapping import CategoryMapping
from app.models.whatsapp import WhatsAppUser
from app.models.weather import SickCall
from app.models.business_profile import BusinessProfile
from app.models.payment_connection import PaymentConnection
from app.schemas.auth import (
    UserRegister, UserLogin, Token, UserResponse, UserUpdate, PasswordChange,
    ForgotPasswordRequest, ResetPasswordRequest,
)
from app.services.auth import hash_password, verify_password, create_access_token, get_current_user
from app.services.email_service import send_email
from app.config import settings

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


def _welcome_email_html(name: str) -> str:
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:22px;color:#1e293b;margin:12px 0 4px">Welcome to BonBox!</h1>
    <p style="color:#64748b;font-size:14px;margin:0">Your smart business companion</p>
  </div>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Hi <strong>{name}</strong>,
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Your account is ready. Here's what you can do:
  </p>
  <ul style="font-size:14px;color:#475569;line-height:1.8;padding-left:20px">
    <li>Log sales & expenses in seconds</li>
    <li>Track inventory & waste</li>
    <li>Get smart staffing suggestions</li>
    <li>Generate PDF reports</li>
    <li>Snap receipts with your camera</li>
  </ul>
  <div style="text-align:center;margin:28px 0">
    <a href="https://bonbox.dk/dashboard" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Open BonBox →</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
    Questions? Reply to this email or visit <a href="https://bonbox.dk/contact" style="color:#16a34a;text-decoration:none">bonbox.dk/contact</a>
  </p>
</div>"""


def _admin_signup_email_html(email: str, business_name: str, business_type: str) -> str:
    from datetime import datetime
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:20px">
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:20px;color:#1e293b;margin:12px 0 4px">New Signup!</h1>
  </div>
  <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse">
    <tr><td style="padding:8px 0;color:#64748b;width:120px">Email</td><td style="padding:8px 0;font-weight:600">{email}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Business</td><td style="padding:8px 0;font-weight:600;border-top:1px solid #f1f5f9">{business_name or '(not set)'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Type</td><td style="padding:8px 0;border-top:1px solid #f1f5f9">{business_type or '(not set)'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Time</td><td style="padding:8px 0;border-top:1px solid #f1f5f9">{now}</td></tr>
  </table>
  <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px">
    BonBox admin notification
  </p>
</div>"""


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
@limiter.limit("15/minute")
def register(request: Request, data: UserRegister, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        business_name=data.business_name,
        business_type=data.business_type,
        currency=data.currency,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Send welcome email (non-blocking — don't fail registration if email fails)
    try:
        send_email(
            user.email,
            "Welcome to BonBox! 🎉",
            _welcome_email_html(user.business_name or "there"),
        )
    except Exception:
        pass

    # Notify admin about new signup
    if settings.ADMIN_EMAIL:
        try:
            send_email(
                settings.ADMIN_EMAIL,
                f"New BonBox signup: {user.business_name or user.email}",
                _admin_signup_email_html(user.email, user.business_name, user.business_type),
            )
        except Exception:
            pass

    token = create_access_token(str(user.id))
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
def login(request: Request, data: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token(str(user.id))
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/profile", response_model=UserResponse)
def update_profile(
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if data.business_name is not None:
        current_user.business_name = data.business_name
    if data.business_type is not None:
        current_user.business_type = data.business_type
    if data.currency is not None:
        current_user.currency = data.currency
    if data.email is not None and data.email != current_user.email:
        existing = db.query(User).filter(User.email == data.email).first()
        if existing:
            raise HTTPException(status_code=400, detail="Email already in use")
        current_user.email = data.email
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/change-password")
def change_password(
    data: PasswordChange,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(data.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"message": "Password changed successfully"}


@router.post("/forgot-password")
@limiter.limit("5/minute")
def forgot_password(request: Request, data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user:
        # Don't reveal if email exists
        return {"message": "If an account exists with this email, a reset code has been generated."}

    # Generate a short 6-digit code instead of a long token
    code = f"{secrets.randbelow(900000) + 100000}"
    user.reset_token = code
    user.reset_token_expires = datetime.utcnow() + timedelta(minutes=15)
    db.commit()

    email_sent = send_email(
        user.email,
        f"BonBox — Your reset code is {code}",
        f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#2563eb;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:20px;color:#1e293b;margin:12px 0 4px">Password Reset</h1>
  </div>
  <p style="font-size:15px;color:#334155;text-align:center">Your reset code is:</p>
  <div style="text-align:center;margin:20px 0">
    <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:8px;color:#2563eb;background:#eff6ff;padding:16px 32px;border-radius:12px;border:2px dashed #93c5fd">{code}</span>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center">This code expires in 15 minutes.<br>If you didn't request this, ignore this email.</p>
</div>""",
    )
    if not email_sent:
        raise HTTPException(status_code=500, detail="Could not send reset email. Please try again later.")
    return {"message": "We've sent a 6-digit code to your email."}


@router.post("/reset-password")
@limiter.limit("5/minute")
def reset_password(request: Request, data: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not user.reset_token or user.reset_token != data.reset_token:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if user.reset_token_expires and user.reset_token_expires < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Reset code has expired")

    user.password_hash = hash_password(data.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
    return {"message": "Password reset successfully. You can now log in."}


@router.patch("/daily-goal", response_model=UserResponse)
def set_daily_goal(
    goal: float,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current_user.daily_goal = goal
    db.commit()
    db.refresh(current_user)
    return current_user


@router.patch("/monthly-goal", response_model=UserResponse)
def set_monthly_goal(
    goal: float,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current_user.monthly_goal = goal
    db.commit()
    db.refresh(current_user)
    return current_user


# ============================================================
# GDPR: Right to Data Portability (Article 20)
# ============================================================
def _write_csv_section(writer, title: str, headers: list, rows: list):
    """Write a labeled section into the CSV export."""
    writer.writerow([])
    writer.writerow([f"=== {title} ==="])
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)


@router.get("/export-data")
def export_all_data(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 20 — Export all user data as a single CSV file.

    Returns every piece of data BonBox stores about the user:
    profile, sales, expenses, inventory, cash book, waste logs,
    khata, loans, budgets, staffing rules, business profile, etc.
    """
    uid = current_user.id
    buf = io.StringIO()
    w = csv.writer(buf)

    # --- Profile ---
    w.writerow(["BonBox Data Export"])
    w.writerow([f"User: {current_user.email}"])
    w.writerow([f"Exported: {datetime.utcnow().isoformat()}"])
    _write_csv_section(w, "Profile", [
        "id", "email", "business_name", "business_type", "currency",
        "daily_goal", "monthly_goal", "role", "created_at",
    ], [[
        str(current_user.id), current_user.email, current_user.business_name,
        current_user.business_type, current_user.currency,
        current_user.daily_goal, current_user.monthly_goal,
        current_user.role, str(current_user.created_at),
    ]])

    # --- Business Profile ---
    bp = db.query(BusinessProfile).filter(BusinessProfile.user_id == uid).first()
    if bp:
        _write_csv_section(w, "Business Profile", [
            "company_name", "org_number", "vat_number", "country",
            "address", "city", "zipcode", "industry", "phone", "email", "source",
        ], [[
            bp.company_name, bp.org_number, bp.vat_number, bp.country,
            bp.address, bp.city, bp.zipcode, bp.industry, bp.phone, bp.email, bp.source,
        ]])

    # --- Sales ---
    sales = db.query(Sale).filter(Sale.user_id == uid).order_by(Sale.date.desc()).all()
    _write_csv_section(w, "Sales", [
        "date", "amount", "payment_method", "notes", "item_name",
        "quantity_sold", "unit_price", "status", "is_tax_exempt",
    ], [[
        str(s.date), float(s.amount), s.payment_method, s.notes or "",
        s.item_name or "", s.quantity_sold or "", s.unit_price or "",
        s.status or "completed", s.is_tax_exempt,
    ] for s in sales])

    # --- Expense Categories ---
    cats = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == uid).all()
    _write_csv_section(w, "Expense Categories", ["name", "color"], [
        [c.name, c.color] for c in cats
    ])

    # --- Expenses ---
    expenses = db.query(Expense).filter(Expense.user_id == uid).order_by(Expense.date.desc()).all()
    _write_csv_section(w, "Expenses", [
        "date", "amount", "description", "payment_method", "is_personal",
        "is_recurring", "is_tax_exempt", "notes",
    ], [[
        str(e.date), float(e.amount), e.description, e.payment_method,
        e.is_personal, e.is_recurring, e.is_tax_exempt, e.notes or "",
    ] for e in expenses])

    # --- Inventory ---
    items = db.query(InventoryItem).filter(InventoryItem.user_id == uid).all()
    _write_csv_section(w, "Inventory Items", [
        "name", "quantity", "unit", "cost_per_unit", "sell_price",
        "category", "barcode", "min_threshold", "is_perishable", "expiry_date",
    ], [[
        i.name, float(i.quantity), i.unit, float(i.cost_per_unit),
        float(i.sell_price) if i.sell_price else "",
        i.category or "", i.barcode or "", float(i.min_threshold),
        i.is_perishable, str(i.expiry_date) if i.expiry_date else "",
    ] for i in items])

    # --- Inventory Logs (via items) ---
    item_ids = [i.id for i in items]
    if item_ids:
        logs = db.query(InventoryLog).filter(InventoryLog.item_id.in_(item_ids)).order_by(InventoryLog.date.desc()).all()
        _write_csv_section(w, "Inventory Logs", [
            "date", "item_id", "change_qty", "reason", "batch_id",
        ], [[
            str(lg.date), str(lg.item_id), float(lg.change_qty),
            lg.reason, lg.batch_id or "",
        ] for lg in logs])

    # --- Cash Book ---
    cash = db.query(CashTransaction).filter(CashTransaction.user_id == uid).order_by(CashTransaction.date.desc()).all()
    _write_csv_section(w, "Cash Book", [
        "date", "type", "amount", "description", "category", "reference_id",
    ], [[
        str(ct.date), ct.type, float(ct.amount),
        ct.description, ct.category or "", ct.reference_id or "",
    ] for ct in cash])

    # --- Waste Logs ---
    waste = db.query(WasteLog).filter(WasteLog.user_id == uid).order_by(WasteLog.date.desc()).all()
    _write_csv_section(w, "Waste Logs", [
        "date", "item_name", "quantity", "unit", "estimated_cost", "reason", "notes",
    ], [[
        str(wl.date), wl.item_name, float(wl.quantity), wl.unit,
        float(wl.estimated_cost), wl.reason, wl.notes or "",
    ] for wl in waste])

    # --- Khata Customers & Transactions ---
    khata_custs = db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).all()
    _write_csv_section(w, "Khata Customers", ["name", "phone", "address"], [
        [kc.name, kc.phone or "", kc.address or ""] for kc in khata_custs
    ])
    khata_txns = db.query(KhataTransaction).filter(KhataTransaction.user_id == uid).order_by(KhataTransaction.date.desc()).all()
    _write_csv_section(w, "Khata Transactions", [
        "date", "customer_id", "purchase_amount", "paid_amount", "notes",
    ], [[
        str(kt.date), str(kt.customer_id), float(kt.purchase_amount),
        float(kt.paid_amount), kt.notes or "",
    ] for kt in khata_txns])

    # --- Loans ---
    loan_persons = db.query(LoanPerson).filter(LoanPerson.user_id == uid).all()
    _write_csv_section(w, "Loan Contacts", ["name", "phone", "notes"], [
        [lp.name, lp.phone or "", lp.notes or ""] for lp in loan_persons
    ])
    loan_txns = db.query(LoanTransaction).filter(LoanTransaction.user_id == uid).order_by(LoanTransaction.date.desc()).all()
    _write_csv_section(w, "Loan Transactions", [
        "date", "person_id", "type", "amount", "is_repayment", "notes",
    ], [[
        str(lt.date), str(lt.person_id), lt.type, float(lt.amount),
        lt.is_repayment, lt.notes or "",
    ] for lt in loan_txns])

    # --- Budgets ---
    budgets = db.query(Budget).filter(Budget.user_id == uid).all()
    _write_csv_section(w, "Budgets", ["month", "category", "limit_amount"], [
        [b.month, b.category, float(b.limit_amount)] for b in budgets
    ])

    # --- Staffing Rules ---
    rules = db.query(StaffingRule).filter(StaffingRule.user_id == uid).all()
    _write_csv_section(w, "Staffing Rules", [
        "label", "revenue_min", "revenue_max", "recommended_staff",
    ], [[
        sr.label, float(sr.revenue_min), float(sr.revenue_max), sr.recommended_staff,
    ] for sr in rules])

    # --- Sick Calls ---
    sick = db.query(SickCall).filter(SickCall.user_id == uid).all()
    if sick:
        _write_csv_section(w, "Sick Calls", [
            "date", "staff_name", "weather_condition", "notes",
        ], [[
            str(sc.date), sc.staff_name, sc.weather_condition or "", sc.notes or "",
        ] for sc in sick])

    # --- Feedback ---
    fb = db.query(Feedback).filter(Feedback.user_id == uid).all()
    if fb:
        _write_csv_section(w, "Feedback", ["rating", "category", "message", "created_at"], [
            [f.rating, f.category or "", f.message or "", str(f.created_at)] for f in fb
        ])

    # --- Payment Connections ---
    pay_conns = db.query(PaymentConnection).filter(PaymentConnection.user_id == uid).all()
    if pay_conns:
        _write_csv_section(w, "Payment Connections", [
            "provider", "label", "is_active", "last_synced_at", "created_at",
        ], [[
            pc.provider, pc.label, pc.is_active,
            str(pc.last_synced_at) if pc.last_synced_at else "",
            str(pc.created_at),
        ] for pc in pay_conns])

    # Return as downloadable CSV
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=bonbox_export_{current_user.email}_{datetime.utcnow().strftime('%Y%m%d')}.csv"},
    )


# ============================================================
# GDPR: Right to Erasure (Article 17)
# ============================================================
class DeleteAccountRequest(BaseModel):
    password: str


@router.delete("/delete-account")
def delete_account(
    data: DeleteAccountRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 17 — Permanently delete user account and ALL associated data.

    Requires password confirmation. This action is irreversible.
    Deletes: sales, expenses, inventory, cash book, waste logs, khata,
    loans, budgets, staffing rules, business profile, WhatsApp data,
    feedback, event logs, category mappings, sick calls, and the user account.
    """
    # Verify password to prevent accidental/unauthorized deletion
    if not verify_password(data.password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect password")

    uid = current_user.id

    # Check if user has team members — must remove them first
    team_members = db.query(User).filter(User.owner_id == uid).count()
    if team_members > 0:
        raise HTTPException(
            status_code=400,
            detail=f"You have {team_members} team member(s). Remove all team members before deleting your account.",
        )

    # Delete all user data in dependency order (children first)
    # --- Inventory logs (via inventory items) ---
    item_ids = [i.id for i in db.query(InventoryItem.id).filter(InventoryItem.user_id == uid).all()]
    if item_ids:
        db.query(InventoryLog).filter(InventoryLog.item_id.in_(item_ids)).delete(synchronize_session=False)

    # --- Khata transactions, then customers ---
    db.query(KhataTransaction).filter(KhataTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).delete(synchronize_session=False)

    # --- Loan transactions, then persons ---
    db.query(LoanTransaction).filter(LoanTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(LoanPerson).filter(LoanPerson.user_id == uid).delete(synchronize_session=False)

    # --- Expenses (before categories) ---
    db.query(Expense).filter(Expense.user_id == uid).delete(synchronize_session=False)
    db.query(ExpenseCategory).filter(ExpenseCategory.user_id == uid).delete(synchronize_session=False)

    # --- Sales ---
    db.query(Sale).filter(Sale.user_id == uid).delete(synchronize_session=False)

    # --- Everything else (no child dependencies) ---
    db.query(InventoryItem).filter(InventoryItem.user_id == uid).delete(synchronize_session=False)
    db.query(CashTransaction).filter(CashTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(WasteLog).filter(WasteLog.user_id == uid).delete(synchronize_session=False)
    db.query(Budget).filter(Budget.user_id == uid).delete(synchronize_session=False)
    db.query(StaffingRule).filter(StaffingRule.user_id == uid).delete(synchronize_session=False)
    db.query(Feedback).filter(Feedback.user_id == uid).delete(synchronize_session=False)
    db.query(EventLog).filter(EventLog.user_id == uid).delete(synchronize_session=False)
    db.query(CategoryMapping).filter(CategoryMapping.user_id == uid).delete(synchronize_session=False)
    db.query(SickCall).filter(SickCall.user_id == uid).delete(synchronize_session=False)
    db.query(WhatsAppUser).filter(WhatsAppUser.user_id == uid).delete(synchronize_session=False)
    db.query(BusinessProfile).filter(BusinessProfile.user_id == uid).delete(synchronize_session=False)
    db.query(PaymentConnection).filter(PaymentConnection.user_id == uid).delete(synchronize_session=False)

    # --- Finally, delete the user ---
    db.delete(current_user)
    db.commit()

    return {"message": "Account and all data permanently deleted. We're sorry to see you go."}
