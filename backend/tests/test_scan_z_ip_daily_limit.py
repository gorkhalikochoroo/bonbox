"""The per-IP limit on POST /api/daily-close/scan-report never sits below
what the plans themselves allow.

The plan counter (PLAN_CAPS z_report_scans_per_day: Free 3, Starter 20,
Pro 100) is per account. The slowapi limit in front of it is per IP, so a
venue's terminals on one Wi-Fi share it. At 80/day a Pro venue hit the IP
ceiling before its own plan's 100. It is now 6 a minute and 150 a day.
"""
from app.routers import daily_close
from app.services.billing import PLAN_CAPS

_ROUTE = "app.routers.daily_close.scan_z_report"


def _limits():
    return {
        lim.limit.GRANULARITY.name: lim.limit.amount
        for lim in daily_close._limiter._route_limits[_ROUTE]
    }


def test_scan_z_limit_string_is_6_a_minute_and_150_a_day():
    assert _limits() == {"minute": 6, "day": 150}


def test_scan_z_daily_ip_limit_is_never_below_any_plans_daily_cap():
    day = _limits()["day"]
    plans = {p: caps["z_report_scans_per_day"] for p, caps in PLAN_CAPS.items()
             if "z_report_scans_per_day" in caps}
    assert plans.get("pro") == 100, plans
    for plan, cap in plans.items():
        if cap >= 0:  # -1 = unlimited; none of the plans uses it here
            assert day >= cap, (plan, cap, day)
