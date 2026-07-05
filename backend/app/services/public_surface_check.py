"""
public_surface_check — detect SILENT quality defects on public booking pages.

The crash monitor (prod_healthcheck / client-error beacon) catches errors; these
defects throw nothing — a booking page dead for two weeks, or a page whose tab
title is still the app default. A diner just bounces and we never hear about it.

Pure + read-only + fail-soft. Per-detector try/except so one bad read never
sinks the scan. NO headless browser and NO HTTP — everything is computed from
the same DB the public API reads, so it can't disagree with what a diner sees.

FALSE-ALARM DOCTRINE (the whole point — the operator must never be cried wolf):
  • dead_on_arrival fires ONLY when there is ZERO availability across the full
    14-day horizon (a genuinely dead page) — NOT when today is merely closed.
    After the page auto-advances to the next open day, "closed today" resolves
    itself, so it must never alarm; the 14-day-all-empty threshold guarantees
    that structurally, not by heuristic.
  • stale_meta reads the NAME the page resolves from (owner.business_name or
    profile.company_name) — the SPA always serves the app-default <title>, so
    scraping the HTML would false-alarm on 100% of slugs forever.
"""
from app.services import reservation_service as rsvc

_HORIZON_DAYS = 14
_PROBE_PARTY = 2


def check_slug(db, *, profile, owner, now) -> dict:
    """Run the detectors for one slug. Returns
    {codes, detail, severity, healthy, summary}. Never raises."""
    codes: list[str] = []
    detail: dict = {}

    # dead_on_arrival — 0 availability for the whole horizon (real defect).
    try:
        summary = rsvc.summarize_days(
            db, profile=profile, user_id=owner.id, start_date=now.date(),
            days=_HORIZON_DAYS, party_size=_PROBE_PARTY, now=now,
        )
        open_days = sum(1 for d in summary["days"] if d["has_slots"])
        detail["open_days_count"] = open_days
        detail["first_open_day"] = summary.get("next_open_day")
        if open_days == 0:
            codes.append("dead_on_arrival")
    except Exception as e:  # inconclusive — do NOT flag on our own probe error
        detail["dead_check_error"] = str(e)[:160]

    # stale_meta — the venue name resolves to empty or the app default, so the
    # tab/link preview falls back to "BonBox — The AI manager …". Data-source
    # read only (never scrapes the SPA HTML — see doctrine above).
    biz = (getattr(owner, "business_name", None)
           or getattr(profile, "company_name", None) or "").strip()
    detail["resolved_name"] = biz
    if not biz or biz.lower() == "bonbox":
        codes.append("stale_meta")

    # no_bookable_resources — structurally un-bookable (explains a dead page).
    try:
        n = len(rsvc.active_resources(db, owner.id))
        detail["resource_count"] = n
        if n == 0:
            codes.append("no_bookable_resources")
    except Exception as e:
        detail["resource_check_error"] = str(e)[:160]

    severity = ("urgent" if "dead_on_arrival" in codes
                else "warn" if codes else None)
    healthy = not codes
    summary = (
        f"open {detail.get('open_days_count', '?')}/{_HORIZON_DAYS}"
        if healthy else f"{','.join(codes)} · open {detail.get('open_days_count', '?')}/{_HORIZON_DAYS}"
    )
    return {"codes": codes, "detail": detail, "severity": severity,
            "healthy": healthy, "summary": summary}
