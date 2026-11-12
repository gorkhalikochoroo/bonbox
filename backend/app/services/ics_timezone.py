"""VTIMEZONE blocks for the calendar feeds — the venue's own zone.

A shift is stored as naive wall-clock time at the venue. The feed writes it
under `TZID=<zone>` plus a VTIMEZONE block, so a strict client resolves it
without anything ever being converted to UTC (the naive-UTC bug class).

Until Portugal Stage 0a every feed said Europe/Copenhagen, so a Lisbon shift
at 16:00 landed at 15:00 on a Lisbon phone. Now a non-Danish venue's feed
follows its zone (`feed_zone`: the country first, `users.timezone` only
inside it). A Danish venue, or any DKK owner, gets the exact block it always
had (`CPH_VTIMEZONE`, byte for byte) whatever users.timezone says.

Any other zone is written from the tz database: this year's two transitions
become yearly "nth weekday of the month" rules, checked against next year
before they are trusted. A zone that cannot be written that way (an unknown
name, or more than two changes a year) gets None, and the caller keeps the
old Copenhagen block — never a guessed rule.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZID = "Europe/Copenhagen"

# The block the staff feed has shipped since it was built. Kept as a literal
# so a Danish venue's file stays byte-identical.
CPH_VTIMEZONE = (
    "BEGIN:VTIMEZONE", "TZID:Europe/Copenhagen",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
    "TZNAME:CEST", "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
    "TZNAME:CET", "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
)

_WD = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
_UTC = timezone.utc


def _fmt_offset(td: timedelta) -> str:
    mins = int(td.total_seconds() // 60)
    sign = "+" if mins >= 0 else "-"
    mins = abs(mins)
    return f"{sign}{mins // 60:02d}{mins % 60:02d}"


def _byday(d: date) -> tuple[int, int]:
    """(n, weekday) for d: n = -1 when it is the month's last such weekday."""
    last = calendar.monthrange(d.year, d.month)[1]
    n = -1 if d.day + 7 > last else (d.day - 1) // 7 + 1
    return n, d.weekday()


def _rule_date(year: int, month: int, n: int, wd: int) -> date:
    if n == -1:
        d = date(year, month, calendar.monthrange(year, month)[1])
        while d.weekday() != wd:
            d -= timedelta(days=1)
        return d
    d = date(year, month, 1)
    while d.weekday() != wd:
        d += timedelta(days=1)
    return d + timedelta(days=7 * (n - 1))


def _offset(tz: ZoneInfo, instant: datetime) -> timedelta:
    return instant.astimezone(tz).utcoffset()


def _transitions(tz: ZoneInfo, year: int) -> list[tuple[datetime, timedelta, timedelta]]:
    """Every offset change in `year`: (UTC instant, offset before, after).
    Hourly scan, then narrowed to the minute (some zones change on :30)."""
    out = []
    t = datetime(year, 1, 1, tzinfo=_UTC)
    end = datetime(year + 1, 1, 1, tzinfo=_UTC)
    prev = _offset(tz, t)
    while t < end:
        nxt = t + timedelta(hours=1)
        off = _offset(tz, nxt)
        if off != prev:
            lo, hi = 0, 60  # minutes after t
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if _offset(tz, t + timedelta(minutes=mid)) == prev:
                    lo = mid
                else:
                    hi = mid
            out.append((t + timedelta(minutes=hi), prev, off))
            prev = off
        t = nxt
    return out


@lru_cache(maxsize=64)
def _generated(tzid: str, year: int) -> tuple[str, ...] | None:
    try:
        tz = ZoneInfo(tzid)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    trans = _transitions(tz, year)
    head = ("BEGIN:VTIMEZONE", f"TZID:{tzid}")
    if not trans:
        mid_year = datetime(year, 7, 1, tzinfo=_UTC)
        off = _fmt_offset(_offset(tz, mid_year))
        name = mid_year.astimezone(tz).tzname() or tzid
        return (*head,
                "BEGIN:STANDARD", f"TZOFFSETFROM:{off}", f"TZOFFSETTO:{off}",
                f"TZNAME:{name}", "DTSTART:19700101T000000", "END:STANDARD",
                "END:VTIMEZONE")
    if len(trans) != 2:
        return None
    (_, a_before, a_after), (_, b_before, b_after) = trans
    if not (a_after == b_before and b_after == a_before):
        return None
    parts = []
    for instant, before, after in trans:
        onset = (instant + before).replace(tzinfo=None)  # local wall-clock, old offset
        n, wd = _byday(onset.date())
        # Trust the rule only if next year changes on the same rule, same time.
        nxt_local = datetime.combine(_rule_date(year + 1, onset.month, n, wd), onset.time())
        nxt_instant = (nxt_local - before).replace(tzinfo=_UTC)
        if not (_offset(tz, nxt_instant - timedelta(minutes=1)) == before
                and _offset(tz, nxt_instant) == after):
            return None
        kind = "DAYLIGHT" if after > before else "STANDARD"
        start = datetime.combine(_rule_date(1970, onset.month, n, wd), onset.time())
        parts.append((kind, (
            f"BEGIN:{kind}", f"TZOFFSETFROM:{_fmt_offset(before)}",
            f"TZOFFSETTO:{_fmt_offset(after)}",
            f"TZNAME:{instant.astimezone(tz).tzname() or tzid}",
            f"DTSTART:{start.strftime('%Y%m%dT%H%M%S')}",
            f"RRULE:FREQ=YEARLY;BYMONTH={onset.month};BYDAY={n}{_WD[wd]}",
            f"END:{kind}",
        )))
    parts.sort(key=lambda p: p[0] != "DAYLIGHT")  # DAYLIGHT first, like CPH
    return (*head, *parts[0][1], *parts[1][1], "END:VTIMEZONE")


# A country whose zones we know: (main zone, every zone of the country).
# Portugal: mainland, Madeira, the Azores.
_COUNTRY_ZONES = {
    "PT": ("Europe/Lisbon",
           frozenset({"Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"})),
    "PRT": ("Europe/Lisbon",
            frozenset({"Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"})),
}
_DK_COUNTRIES = frozenset({"", "DK", "DNK"})


def feed_zone(country: str | None, currency: str | None,
              stored_tz: str | None) -> str | None:
    """The zone a venue's staff calendar is written in. None = the
    historical Copenhagen block.

    users.timezone is the owner's BROWSER zone (synced at login), so it says
    where the owner happens to be, not where the venue is: Danish owners
    carry Asia/Kathmandu, Asia/Tokyo, America/Los_Angeles. A Danish venue
    must never follow that. So:
      - a DKK owner, or a venue whose country is DK or unset -> None
        (Copenhagen, byte-identical to the file it always got);
      - Portugal -> the stored zone if it is a Portuguese one (Lisbon,
        Madeira, Azores), otherwise Europe/Lisbon;
      - any other country -> the stored zone (venue_vtimezone still falls
        back to Copenhagen if it can't be written safely).
    """
    cur = (currency or "DKK").strip().upper()
    if cur == "DKK":
        return None
    code = (country or "").strip().upper()
    if code in _DK_COUNTRIES:
        return None
    tz = (stored_tz or "").strip()
    known = _COUNTRY_ZONES.get(code)
    if known:
        main, zones = known
        return tz if tz in zones else main
    return tz or None


def venue_vtimezone(tzid: str | None, *, year: int | None = None) -> tuple[str, tuple[str, ...]]:
    """(TZID, VTIMEZONE lines) for a venue's IANA zone. Danish or unset →
    the historical Copenhagen block. A zone that can't be written safely
    → also Copenhagen (today's behaviour), never a guessed rule."""
    name = (tzid or "").strip() or DEFAULT_TZID
    if name == DEFAULT_TZID:
        return DEFAULT_TZID, CPH_VTIMEZONE
    if year is None:
        year = datetime.now(_UTC).year
    block = _generated(name, year)
    if block is None:
        return DEFAULT_TZID, CPH_VTIMEZONE
    return name, block
