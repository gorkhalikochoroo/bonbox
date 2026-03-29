from datetime import date
from pydantic import BaseModel


class LocationUpdate(BaseModel):
    latitude: float
    longitude: float


class SickCallCreate(BaseModel):
    staff_name: str
    date: date
    weather_condition: str | None = None
    notes: str | None = None


class SickCallResponse(BaseModel):
    id: str
    staff_name: str
    date: date
    weather_condition: str | None
    notes: str | None

    class Config:
        from_attributes = True
