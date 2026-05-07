from datetime import date
from pydantic import BaseModel, ConfigDict


class LocationUpdate(BaseModel):
    latitude: float
    longitude: float


class SickCallCreate(BaseModel):
    staff_name: str
    date: date
    weather_condition: str | None = None
    notes: str | None = None


class SickCallResponse(BaseModel):
    # Pydantic v2: model_config = ConfigDict(...) replaces the
    # deprecated nested `class Config:` style. from_attributes=True
    # lets the serializer pull fields from SQLAlchemy model instances
    # via attribute access (was orm_mode=True in v1).
    model_config = ConfigDict(from_attributes=True)

    id: str
    staff_name: str
    date: date
    weather_condition: str | None
    notes: str | None
