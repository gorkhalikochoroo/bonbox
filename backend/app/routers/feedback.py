from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.feedback import Feedback
from app.schemas.feedback import FeedbackCreate, FeedbackResponse
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[FeedbackResponse])
def list_feedback(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return (
        db.query(Feedback)
        .filter(Feedback.user_id == user.id)
        .order_by(Feedback.created_at.desc())
        .all()
    )


@router.post("", response_model=FeedbackResponse, status_code=201)
def create_feedback(
    data: FeedbackCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    feedback = Feedback(user_id=user.id, **data.model_dump())
    db.add(feedback)
    db.commit()
    db.refresh(feedback)
    return feedback
