"""Team management — invite staff, manage roles, list team members."""
import uuid
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user, hash_password

router = APIRouter()

VALID_ROLES = {"manager", "cashier", "viewer"}

# Permissions per role
ROLE_PERMISSIONS = {
    "owner": {"sales", "expenses", "inventory", "reports", "cashbook", "settings", "team", "budgets", "waste", "khata"},
    "manager": {"sales", "expenses", "inventory", "reports", "cashbook", "budgets", "waste"},
    "cashier": {"sales", "cashbook"},
    "viewer": {"reports"},
}


# ── Schemas ──────────────────────────────────────────────
class InviteRequest(BaseModel):
    email: EmailStr
    role: str = Field(..., pattern="^(manager|cashier|viewer)$")
    name: str = ""

class UpdateRoleRequest(BaseModel):
    role: str = Field(..., pattern="^(manager|cashier|viewer)$")

class TeamMemberResponse(BaseModel):
    id: str
    email: str
    business_name: str
    role: str
    created_at: str

    model_config = {"from_attributes": True}


# ── Helper ───────────────────────────────────────────────
def _get_owner(user: User) -> uuid.UUID:
    """Get the business owner ID (self if owner, otherwise owner_id)."""
    return user.id if (user.role == "owner" or not user.owner_id) else user.owner_id


def require_owner(user: User):
    """Raise 403 if user is not the business owner."""
    if user.role != "owner" and user.owner_id:
        raise HTTPException(403, "Only the business owner can manage the team")


# ── Endpoints ────────────────────────────────────────────
@router.get("/members")
def list_members(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all team members for this business."""
    owner_id = _get_owner(user)
    members = db.query(User).filter(User.owner_id == owner_id).all()
    # Include the owner too
    owner = db.query(User).filter(User.id == owner_id).first()

    result = []
    if owner:
        result.append({
            "id": str(owner.id),
            "email": owner.email,
            "business_name": owner.business_name,
            "role": "owner",
            "created_at": owner.created_at.isoformat() if owner.created_at else "",
        })
    for m in members:
        result.append({
            "id": str(m.id),
            "email": m.email,
            "business_name": m.business_name or m.email,
            "role": m.role or "viewer",
            "created_at": m.created_at.isoformat() if m.created_at else "",
        })
    return result


@router.post("/invite")
def invite_member(
    data: InviteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Invite a staff member by email. Creates an account with a temp password."""
    require_owner(user)

    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        if existing.owner_id == user.id:
            raise HTTPException(400, "This person is already on your team")
        raise HTTPException(400, "This email is already registered with another business")

    # Generate temporary password
    temp_password = secrets.token_urlsafe(10)

    new_user = User(
        id=uuid.uuid4(),
        email=data.email,
        password_hash=hash_password(temp_password),
        business_name=data.name or data.email.split("@")[0],
        business_type=user.business_type,
        currency=user.currency,
        role=data.role,
        owner_id=user.id,
    )
    db.add(new_user)
    db.commit()

    # Try to send invite email
    try:
        from app.services.email_service import send_email
        send_email(
            to_email=data.email,
            subject=f"You've been invited to {user.business_name} on BonBox",
            html=f"""
            <h2>Welcome to BonBox!</h2>
            <p><strong>{user.business_name}</strong> has invited you as a <strong>{data.role}</strong>.</p>
            <p>Your temporary login:</p>
            <ul>
                <li>Email: {data.email}</li>
                <li>Password: <code>{temp_password}</code></li>
            </ul>
            <p>Please change your password after logging in.</p>
            <p><a href="https://bonbox.dk/login">Log in to BonBox</a></p>
            """,
        )
    except Exception:
        pass  # Email is optional — user can share credentials manually

    return {
        "status": "invited",
        "email": data.email,
        "role": data.role,
        "temp_password": temp_password,  # Show to owner so they can share it
    }


@router.patch("/{member_id}/role")
def update_member_role(
    member_id: str,
    data: UpdateRoleRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Change a team member's role."""
    require_owner(user)

    member = db.query(User).filter(User.id == member_id, User.owner_id == user.id).first()
    if not member:
        raise HTTPException(404, "Team member not found")

    member.role = data.role
    db.commit()
    return {"status": "ok", "role": data.role}


@router.delete("/{member_id}")
def remove_member(
    member_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a team member (soft — clears their owner_id)."""
    require_owner(user)

    member = db.query(User).filter(User.id == member_id, User.owner_id == user.id).first()
    if not member:
        raise HTTPException(404, "Team member not found")

    # Don't delete the user — just unlink from this business
    member.owner_id = None
    member.role = "owner"  # They become independent
    db.commit()
    return {"status": "removed"}


@router.get("/permissions")
def get_my_permissions(
    user: User = Depends(get_current_user),
):
    """Get the current user's role and permissions."""
    role = user.role or "owner"
    return {
        "role": role,
        "permissions": sorted(ROLE_PERMISSIONS.get(role, set())),
        "is_owner": role == "owner" and not user.owner_id,
    }
