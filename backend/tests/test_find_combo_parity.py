"""
The host stand's table-joining port agrees with the booking engine.

The door's drop-in row says "Ledigt nu" for a party that only joined tables
can seat, and one tap seats them there. It may only do that where the engine
would seat them itself — so the stand runs a port of
availability_engine.find_combo (frontend/src/utils/hostStand.js, findCombo),
not a rule of its own.

A port is a second copy, and copies drift. These cases live in ONE file that
both sides read: this test runs them through the Python original, and
frontend/src/__tests__/hostStand.test.js runs the same file through the port.
Change the engine's rule and this goes red until the cases (and so the port's
test) are brought along.

Run: cd backend && python3 -m pytest tests/test_find_combo_parity.py -q
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.services.availability_engine import ResourceView, find_combo

_CASES = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "__tests__" / "fixtures" / "findComboCases.json"
)
_START = datetime(2026, 10, 16, 19, 0)


def _cases():
    return json.loads(_CASES.read_text())["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_the_engine_joins_tables_as_the_shared_cases_say(case):
    tables = [
        ResourceView(id=t["id"], capacity_seats=t["seats"],
                     combinable=t["combinable"], zone=t["zone"])
        for t in case["tables"]
    ]
    got = find_combo(case["party"], _START, _START + timedelta(minutes=120),
                     tables, [], case["max"])
    assert got == case["expected"]


def test_the_cases_cover_every_rule_the_port_mirrors():
    """Not a vacuous file: at least one joined answer and one refusal, a
    zone split, the table limit and a non-combinable table."""
    cases = _cases()
    assert any(c["expected"] for c in cases)
    assert any(c["expected"] is None for c in cases)
    assert any(len({t["zone"] for t in c["tables"]}) > 1 for c in cases)
    assert any(c["max"] < 2 for c in cases)
    assert any(not t["combinable"] for c in cases for t in c["tables"])
