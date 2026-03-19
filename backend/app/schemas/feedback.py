import uuid
import datetime
from pydantic import BaseModel, Field


class FeedbackCreate(BaseModel):
    rating: int = Field(ge=1, le=5)
    category: str
    message: str


class FeedbackResponse(BaseModel):
    id: uuid.UUID
    rating: int
    category: str
    message: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}
