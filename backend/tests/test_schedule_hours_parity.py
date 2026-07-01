"""
Shift-hours PARITY guard — the owner grid, the staff portal, the labor-cost
ledger, and payroll must read the SAME hours for the SAME shift.

Root cause it locks: two overnight rules coexisted (`e <= s` rolled end==start
to +24h; `e < s` treated it as 0h), so a fat-fingered 08:00–08:00 shift showed
0h on the owner grid but 24h in the staffer's portal + the labor-cost bar on the
SAME screen — the exact owner↔staff hours contradiction that breaks trust.

Run:
  cd backend && python3 -m pytest tests/test_schedule_hours_parity.py -x -q
"""

import pytest

from app.routers.staff_portal import _calc_hours          # staff portal net_hours
from app.services.schedule_autopilot import _shift_hours   # owner week-cost / labor% / autopilot
from app.routers.staff import _calc_shift_hours            # owner grid persist + payroll


# (start, end, break_minutes, expected_hours)
CASES = [
    ("08:00", "08:00", 0, 0.0),    # equal times → ZERO-length, never 24h
    ("16:00", "16:00", 0, 0.0),
    ("00:00", "00:00", 0, 0.0),
    ("22:00", "06:00", 0, 8.0),    # genuine overnight
    ("23:00", "07:00", 0, 8.0),
    ("09:00", "17:00", 30, 7.5),   # normal day shift with a break
    ("10:00", "18:00", 45, 7.25),
    ("18:00", "02:00", 60, 7.0),   # overnight with a break
]


@pytest.mark.parametrize("start,end,brk,expected", CASES)
def test_all_hours_helpers_agree(start, end, brk, expected):
    portal = round(_calc_hours(start, end, brk), 2)
    ledger = round(_shift_hours(start, end, brk), 2)
    grid = round(_calc_shift_hours(start, end, brk), 2)
    assert portal == ledger == grid == expected, (
        f"{start}-{end} brk={brk}: portal={portal} ledger={ledger} grid={grid} "
        f"(expected {expected}) — owner and staff must read the SAME hours"
    )


def test_equal_times_is_never_a_24h_shift():
    # The specific trust-bug: an equal-time shift must be 0h on EVERY surface.
    for helper in (_calc_hours, _shift_hours, _calc_shift_hours):
        assert helper("12:00", "12:00", 0) == 0.0
