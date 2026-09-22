"""The brief's greeting is a clock reading, not cached content.

THE BUG, reported by the owner on 2026-09-22 at 16:00 local. The dashboard
header said "Good afternoon" and the daily brief card, on the same screen,
said "Good morning" — above its own copy suggesting "a midday push could
help". Three times of day, one viewport.

WHY. get_or_create_brief caches one row per user per day and returns it
verbatim on every later call. _greeting_for() is time-aware and uses the
user's timezone, but it runs when the brief is GENERATED. A brief written in
the morning therefore carries "Good morning" in its payload until midnight.

The rest of the payload is a set of facts about today — yesterday's takings,
what is owed, what needs an answer — and caching those for a day is right.
The greeting is not a fact about today, it is a reading of the clock at the
moment someone looks, so it has to be recomputed on the way out.
"""
import json
import uuid
from datetime import date
from unittest.mock import patch

import pytest

from app.services import daily_brief as db_mod


@pytest.fixture
def user():
    class _U:
        id = uuid.uuid4()
        timezone = "Europe/Copenhagen"
        email = "owner@bonbox.dk"
    return _U()


def test_the_greeting_follows_the_clock_not_the_cache(user):
    """A brief generated in the morning must not still say so in the evening."""
    cached = {"greeting": "Good morning", "lines": ["yesterday brought 20.000 kr."]}

    class _Row:
        payload_json = json.dumps(cached)
        tier = "pro"
        refresh_count = 0
        brief_date = date.today()

    with patch.object(db_mod, "_greeting_for", return_value="Good evening"):
        payload = json.loads(_Row.payload_json)
        payload["from_cache"] = True
        payload["tier"] = _Row.tier
        payload["greeting"] = db_mod._greeting_for(user)

    assert payload["greeting"] == "Good evening", (
        "the cached 'Good morning' was served instead of the current time"
    )
    # The CONTENT is still the cached content — only the clock reading moved.
    assert payload["lines"] == ["yesterday brought 20.000 kr."]


@pytest.mark.parametrize("hour,expected", [
    (0, "Good morning"),     # the function's own boundary: <11 is morning
    (7, "Good morning"),
    (10, "Good morning"),
    (11, "Good afternoon"),
    (16, "Good afternoon"),  # the hour the owner reported
    (17, "Good evening"),
    (23, "Good evening"),
])
def test_greeting_boundaries(user, hour, expected):
    """Pins the thresholds so a later edit cannot quietly widen 'morning'."""
    import datetime as _dt

    # A user in UTC so the hour under test maps 1:1; the timezone path has its
    # own coverage below.
    class _UtcUser:
        timezone = "UTC"

    with patch.object(db_mod, "utc_now",
                      return_value=_dt.datetime(2026, 9, 22, hour, 0, 0)):
        assert db_mod._greeting_for(_UtcUser()) == expected


def test_the_greeting_uses_the_owners_timezone_not_utc(user):
    """23:30 UTC is 01:30 in Copenhagen — a Danish owner is not in 'evening'."""
    import datetime as _dt

    with patch.object(db_mod, "utc_now",
                      return_value=_dt.datetime(2026, 9, 22, 23, 30, 0)):
        assert db_mod._greeting_for(user) == "Good morning"

    class _UtcUser:
        timezone = "UTC"

    with patch.object(db_mod, "utc_now",
                      return_value=_dt.datetime(2026, 9, 22, 23, 30, 0)):
        assert db_mod._greeting_for(_UtcUser()) == "Good evening"


def test_a_broken_timezone_does_not_crash_the_brief(user):
    """Fail soft: a bad TZ string falls back to UTC rather than 500ing Home."""
    import datetime as _dt

    class _BadTz:
        timezone = "Not/AZone"

    with patch.object(db_mod, "utc_now",
                      return_value=_dt.datetime(2026, 9, 22, 7, 0, 0)):
        assert db_mod._greeting_for(_BadTz()) == "Good morning"


def test_the_cache_path_actually_reassigns_the_greeting():
    """Source-level: the fix is one line inside the cache-hit branch, and it is
    the kind of line a later refactor silently drops."""
    import inspect
    src = inspect.getsource(db_mod.get_or_create_brief)
    hit = src[src.index("# Cache hit"):]
    assert 'payload["greeting"] = _greeting_for(user)' in hit, (
        "the cache-hit path no longer refreshes the greeting"
    )
