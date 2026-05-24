"""Tests for `app.services.tz_utils` — business-day windowing.

These tests pin down the SINGLE definition of "today" that powers the
dashboard, property report, and live KPIs. If any of these flip, the
report-coherence drift the audit (#148) caught will return.

Multi-barrier coverage:
  • Pre-cutoff vs post-cutoff (the 2am-CEST drift case).
  • DST transition (Europe/Copenhagen falls back at the end of October).
  • Missing BusinessProfile / null cutoff → default 6 (restaurant convention).
  • Explicit cutoff_hour = 0 (no shift) honoured.
  • Invalid timezone string → silent UTC fallback (zoneinfo).
  • Cutoff value outside [0, 23] clamped (junk-row defence).

The helper deliberately reads cutoff from either the BusinessProfile
relationship OR a flat attribute on the user — these tests cover both
paths so router code that stashes the cutoff on `user` keeps working.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app.services import tz_utils
from app.services.tz_utils import (
    business_day_window,
    business_today_local,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _user(tz: str = "Europe/Copenhagen", *, cutoff=None, profile_cutoff=None):
    """Build a User-shaped object good enough for the helpers.

    Two ways to specify cutoff:
      • `cutoff` — flat attribute on the user (mirrors what router code
        stashes per-request after reading BusinessProfile once).
      • `profile_cutoff` — under `user.business_profile.day_cutoff_hour`
        (mirrors a future eager-loaded relationship — the helper reads it
        when present).

    Pass neither → no cutoff configured → helper falls back to 6.
    """
    profile = None
    if profile_cutoff is not None:
        profile = SimpleNamespace(day_cutoff_hour=profile_cutoff)
    return SimpleNamespace(
        timezone=tz,
        day_cutoff_hour=cutoff,
        business_profile=profile,
    )


def _freeze(monkeypatch, when: datetime) -> None:
    """Pin `datetime.now(tz)` inside tz_utils to a fixed instant.

    The helper calls `datetime.now(_user_zone(user))` — we replace the
    class used inside the module so every now() returns our frozen time
    while normal datetime arithmetic (timedelta, combine, etc.) keeps
    working unchanged.
    """
    real_dt = datetime

    class _Frozen(real_dt):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return when.astimezone(None)
            return when.astimezone(tz)

    monkeypatch.setattr(tz_utils, "datetime", _Frozen)


# ─── 1. Pre-cutoff: 03:00 Copenhagen → yesterday's business day ─────────


def test_business_today_local_pre_cutoff_returns_yesterday(monkeypatch):
    """At 03:00 Copenhagen with cutoff=6, the in-progress shift began
    YESTERDAY. The owner asking 'today's revenue' means the late-night
    shift, not the empty calendar day that started 3 hours ago."""
    user = _user(profile_cutoff=6)
    # 2026-05-24 03:00 Copenhagen (CEST = UTC+2)
    _freeze(monkeypatch, datetime(2026, 5, 24, 1, 0, tzinfo=timezone.utc))

    assert business_today_local(user) == date(2026, 5, 23)


def test_business_day_window_pre_cutoff_starts_24h_ago(monkeypatch):
    """The window for the in-progress shift should start at 06:00 the
    PREVIOUS day in local time, 24 hours before the next 06:00 cutoff."""
    user = _user(profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 5, 24, 1, 0, tzinfo=timezone.utc))  # 03:00 CEST

    start, end = business_day_window(user)
    cph = ZoneInfo("Europe/Copenhagen")

    # Start = 06:00 CEST on May 23
    assert start.astimezone(cph) == datetime(2026, 5, 23, 6, 0, tzinfo=cph)
    # End = 06:00 CEST on May 24 (24 hours later)
    assert end.astimezone(cph) == datetime(2026, 5, 24, 6, 0, tzinfo=cph)
    # And both are tz-aware UTC datetimes — callers rely on this for
    # `Sale.created_at` filter compatibility.
    assert start.tzinfo == timezone.utc
    assert end.tzinfo == timezone.utc


# ─── 2. Post-cutoff: 08:00 Copenhagen → today's business day ────────────


def test_business_today_local_post_cutoff_returns_today(monkeypatch):
    """After 06:00 local, the new business day has started — same as
    the calendar day."""
    user = _user(profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 5, 24, 6, 0, tzinfo=timezone.utc))  # 08:00 CEST

    assert business_today_local(user) == date(2026, 5, 24)


def test_business_day_window_post_cutoff_starts_at_06_today(monkeypatch):
    """At 08:00 Copenhagen, the window is [06:00 today, 06:00 tomorrow)."""
    user = _user(profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 5, 24, 6, 0, tzinfo=timezone.utc))  # 08:00 CEST

    start, end = business_day_window(user)
    cph = ZoneInfo("Europe/Copenhagen")

    assert start.astimezone(cph) == datetime(2026, 5, 24, 6, 0, tzinfo=cph)
    assert end.astimezone(cph) == datetime(2026, 5, 25, 6, 0, tzinfo=cph)


# ─── 3. DST transition — last Sunday in October 2026 ────────────────────


def test_business_day_window_spans_dst_fall_back(monkeypatch):
    """The night Europe/Copenhagen falls back from CEST (+02:00) to
    CET (+01:00) happens at 03:00 local on the last Sunday of October.
    In 2026 that's the night of Oct 24→25: clocks roll back at 03:00
    CEST → 02:00 CET. The business day that STARTS at 06:00 CEST on
    Oct 24 ENDS at 06:00 CET on Oct 25 — which is a 25-hour interval in
    UTC. Naive `start + timedelta(days=1)` would produce a 24h window
    and silently swallow 1h of late-night sales twice a year. This is
    exactly the drift the helper exists to prevent."""
    user = _user(profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc))

    start, end = business_day_window(user, target_date=date(2026, 10, 24))

    delta = end - start
    assert delta.total_seconds() == 25 * 3600, (
        f"Expected 25h DST-fall-back window, got {delta}"
    )


def test_business_day_window_spans_dst_spring_forward(monkeypatch):
    """Spring-forward — clocks jump from 02:00 CET → 03:00 CEST on the
    last Sunday of March. In 2026 that's 2026-03-29. The business day
    starting 06:00 CET on Mar 28 ends at 06:00 CEST on Mar 29: 23
    hours in UTC. Same drift class as the fall-back test."""
    user = _user(profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 3, 28, 10, 0, tzinfo=timezone.utc))

    start, end = business_day_window(user, target_date=date(2026, 3, 28))

    delta = end - start
    assert delta.total_seconds() == 23 * 3600, (
        f"Expected 23h DST-spring-forward window, got {delta}"
    )


# ─── 4. Missing BusinessProfile / null cutoff → default 6 ───────────────


def test_business_today_local_no_profile_uses_default_cutoff(monkeypatch):
    """No profile attached, no cutoff stashed on user → fall back to 6.
    This is the brand-new-signup case: the owner hasn't filled in the
    BusinessProfile wizard yet but already has the dashboard open."""
    user = _user()  # neither profile nor flat cutoff
    # 04:00 Copenhagen — pre-cutoff under the default 6.
    _freeze(monkeypatch, datetime(2026, 5, 24, 2, 0, tzinfo=timezone.utc))

    # Default cutoff is 6, current time 04:00 < 6 → yesterday.
    assert business_today_local(user) == date(2026, 5, 23)


def test_business_today_local_null_profile_cutoff_uses_default(monkeypatch):
    """BusinessProfile exists but the field is None (NULL in DB) →
    same fallback path. Some legacy users have profiles created before
    the day_cutoff_hour migration."""
    user = _user(profile_cutoff=None)
    _freeze(monkeypatch, datetime(2026, 5, 24, 2, 0, tzinfo=timezone.utc))

    assert business_today_local(user) == date(2026, 5, 23)


# ─── 5. Explicit cutoff_hour = 0 (midnight, no shift) ───────────────────


def test_business_today_local_cutoff_zero_no_shift(monkeypatch):
    """A retail owner with cutoff=0 expects the business day to roll
    over at local midnight — no shift offset. A 03:00 sale is TODAY
    by that owner's accounting (not yesterday's)."""
    user = _user(profile_cutoff=0)
    # 2026-05-24 03:00 Copenhagen
    _freeze(monkeypatch, datetime(2026, 5, 24, 1, 0, tzinfo=timezone.utc))

    # With cutoff=0, current hour 3 >= 0 → today.
    assert business_today_local(user) == date(2026, 5, 24)


def test_business_day_window_cutoff_zero_aligned_to_midnight(monkeypatch):
    """Cutoff=0 window matches local midnight-to-midnight."""
    user = _user(profile_cutoff=0)
    _freeze(monkeypatch, datetime(2026, 5, 24, 10, 0, tzinfo=timezone.utc))

    start, end = business_day_window(user, target_date=date(2026, 5, 24))
    cph = ZoneInfo("Europe/Copenhagen")

    assert start.astimezone(cph) == datetime(2026, 5, 24, 0, 0, tzinfo=cph)
    assert end.astimezone(cph) == datetime(2026, 5, 25, 0, 0, tzinfo=cph)


# ─── 6. Invalid timezone string → UTC fallback ──────────────────────────


def test_business_today_local_invalid_tz_falls_back_to_utc(monkeypatch):
    """A corrupted user.timezone (typo, deleted IANA zone, etc.) must
    not crash — fall back to UTC. The whole helper is a defence-in-depth
    surface: never let bad data take down the dashboard."""
    user = _user(tz="Mars/Olympus_Mons", profile_cutoff=6)
    # 04:00 UTC — under UTC interpretation, hour 4 < 6 → yesterday.
    _freeze(monkeypatch, datetime(2026, 5, 24, 4, 0, tzinfo=timezone.utc))

    # If TZ fallback didn't work, the helper would raise. It does work,
    # so the answer is "yesterday in UTC" = 2026-05-23.
    assert business_today_local(user) == date(2026, 5, 23)


def test_business_day_window_invalid_tz_falls_back_to_utc(monkeypatch):
    """Same defence on the window-builder path."""
    user = _user(tz="Atlantis/Lost_City", profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 5, 24, 10, 0, tzinfo=timezone.utc))

    start, end = business_day_window(user, target_date=date(2026, 5, 24))

    # Window anchored at UTC 06:00 since TZ degraded to UTC.
    assert start == datetime(2026, 5, 24, 6, 0, tzinfo=timezone.utc)
    assert end == datetime(2026, 5, 25, 6, 0, tzinfo=timezone.utc)


# ─── 7. Cutoff value clamping ───────────────────────────────────────────


def test_cutoff_clamped_above_23(monkeypatch):
    """A junk cutoff (e.g. 99) gets clamped to 23 instead of raising.
    Junk values shouldn't exist (validator on the route), but defensive
    in case a legacy DB row smuggled one in."""
    user = _user(cutoff=99)
    _freeze(monkeypatch, datetime(2026, 5, 24, 21, 0, tzinfo=timezone.utc))  # 23:00 CEST

    # cutoff clamped to 23 → 23:00 is exactly at the cutoff → today.
    # (Helper uses `now.hour < cutoff` so equality is post-cutoff.)
    assert business_today_local(user) == date(2026, 5, 24)


def test_cutoff_clamped_below_zero(monkeypatch):
    """Negative cutoff → clamped to 0 → behaves like midnight cutoff."""
    user = _user(cutoff=-5)
    _freeze(monkeypatch, datetime(2026, 5, 24, 1, 0, tzinfo=timezone.utc))  # 03:00 CEST

    # cutoff clamped to 0 → hour 3 >= 0 → today.
    assert business_today_local(user) == date(2026, 5, 24)


def test_cutoff_non_integer_falls_back_to_default(monkeypatch):
    """Garbage type (e.g. a string from a corrupted JSON import) falls
    back to the default 6 rather than crashing."""
    user = _user(cutoff="not-an-int")
    _freeze(monkeypatch, datetime(2026, 5, 24, 2, 0, tzinfo=timezone.utc))  # 04:00 CEST

    # Bad value → default 6 → hour 4 < 6 → yesterday.
    assert business_today_local(user) == date(2026, 5, 23)


# ─── 8. Profile-vs-flat-attr priority ───────────────────────────────────


def test_profile_cutoff_wins_over_flat_attr(monkeypatch):
    """When both are set, the profile relationship takes priority — it's
    the source of truth in the DB schema, the flat attr is just a
    request-scoped cache. (Currently router code stashes from profile
    onto the flat attr, but if both are present for any reason we want
    deterministic behaviour.)"""
    user = _user(cutoff=0, profile_cutoff=6)
    _freeze(monkeypatch, datetime(2026, 5, 24, 2, 0, tzinfo=timezone.utc))  # 04:00 CEST

    # Profile says 6, flat says 0. Profile wins → hour 4 < 6 → yesterday.
    assert business_today_local(user) == date(2026, 5, 23)


# ─── 9. business_day_window with explicit target_date ───────────────────


def test_explicit_target_date_ignores_now(monkeypatch):
    """When the caller passes a date, the helper builds the window
    around THAT date regardless of wall-clock — used by property report
    when an accountant requests a closed prior day."""
    user = _user(profile_cutoff=6)
    # Frozen time is in May, but ask for January.
    _freeze(monkeypatch, datetime(2026, 5, 24, 10, 0, tzinfo=timezone.utc))

    start, end = business_day_window(user, target_date=date(2026, 1, 15))
    cph = ZoneInfo("Europe/Copenhagen")

    # CET in January (no DST). 06:00 CET = 05:00 UTC.
    assert start.astimezone(cph) == datetime(2026, 1, 15, 6, 0, tzinfo=cph)
    assert end.astimezone(cph) == datetime(2026, 1, 16, 6, 0, tzinfo=cph)
