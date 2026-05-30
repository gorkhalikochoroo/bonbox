"""Unit tests for reservation_service.restaurant_windows — the owner-settable
opening/booking-hours precedence that feeds the slot generator.

Source precedence under test:
  1. settings["booking_hours"][weekday]   (owner sets these in Reservations → Settings)
  2. profile.operating_hours_json[weekday]
  3. settings["fallback_open"]/["fallback_close"]
A value of "closed" yields no bookable window for that day.
"""

import json
from datetime import date

from app.services import reservation_service as rsvc


class _Profile:
    """Minimal stand-in — restaurant_windows only reads operating_hours_json."""

    def __init__(self, operating_hours_json=None):
        self.operating_hours_json = operating_hours_json


def _settings(**over):
    s = dict(rsvc.DEFAULT_SETTINGS)
    s.update(over)
    return s


def _key(day: date) -> str:
    return rsvc._WEEKDAY_KEYS[day.weekday()]


# A known Monday — keeps weekday/key derivation explicit and mid-month so the
# midnight-rollover test's day+1 stays in the same month.
DAY = date(2026, 6, 1)


def test_booking_hours_take_precedence_over_operating_and_fallback():
    prof = _Profile(operating_hours_json=json.dumps({_key(DAY): "09:00-17:00"}))
    s = _settings(booking_hours={_key(DAY): "17:00-23:00"})
    windows = rsvc.restaurant_windows(prof, DAY, s)
    assert len(windows) == 1
    assert windows[0].start.hour == 17 and windows[0].start.minute == 0
    assert windows[0].end.hour == 23


def test_booking_hours_closed_returns_no_window():
    s = _settings(booking_hours={_key(DAY): "closed"})
    assert rsvc.restaurant_windows(_Profile(), DAY, s) == []


def test_falls_back_to_operating_hours_when_no_booking_hours():
    prof = _Profile(operating_hours_json=json.dumps({_key(DAY): "08:00-16:00"}))
    windows = rsvc.restaurant_windows(prof, DAY, _settings())
    assert windows[0].start.hour == 8 and windows[0].end.hour == 16


def test_falls_back_to_default_open_close_when_nothing_set():
    # No booking_hours, no operating_hours_json → fallback 11:00-22:00.
    windows = rsvc.restaurant_windows(_Profile(), DAY, _settings())
    assert windows[0].start.hour == 11 and windows[0].end.hour == 22


def test_booking_hours_crossing_midnight_rolls_end_to_next_day():
    s = _settings(booking_hours={_key(DAY): "18:00-02:00"})
    w = rsvc.restaurant_windows(_Profile(), DAY, s)[0]
    assert w.start.hour == 18
    assert w.end.day == DAY.day + 1 and w.end.hour == 2


def test_booking_hours_for_other_weekday_does_not_apply_to_this_day():
    # Hours set only for a DIFFERENT weekday → this day falls through to the
    # fallback window, not the other day's hours.
    other = rsvc._WEEKDAY_KEYS[(DAY.weekday() + 1) % 7]
    s = _settings(booking_hours={other: "10:00-12:00"})
    windows = rsvc.restaurant_windows(_Profile(), DAY, s)
    assert windows[0].start.hour == 11 and windows[0].end.hour == 22
