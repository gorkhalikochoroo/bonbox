"""
An upgrade wall may not quote a number PLAN_CAPS disagrees with.

THE DEFECT
----------
The 402 a Free owner hits at their 10th receipt scan said:

    "You've used your 10 receipt scans this month. Upgrade to Starter for
     200 / month."

PLAN_CAPS["starter"]["expense_receipt_scans_per_month"] has been 300 since the
2026-05-28 recalibration, and the public pricing table advertises 300. So the
product undersold its own paid tier by a third — at the single strongest upgrade
moment it has, to an owner who had just read 300 on the pricing page. Two BonBox
surfaces quoted different numbers to the same person in the same session.

It went stale because the number was TYPED INTO PROSE next to a cap that lives
in code. The fix reads the cap; this test stops the pattern coming back.

Deliberately a source scan, not a behaviour test: the failure mode is a literal
in an f-string, which no request-level assertion would notice as long as the
gate still returns 402.

Run:
  cd backend && python3 -m pytest tests/test_upgrade_copy_matches_caps.py -x -q
"""

import re
from pathlib import Path

import pytest

from app.services.billing import PLAN_CAPS

_ROUTERS = Path(__file__).resolve().parent.parent / "app" / "routers"

# Every number a paid tier is advertised at, anywhere in PLAN_CAPS. A literal
# equal to one of these, sitting in an upgrade string, is either correct today
# and fragile forever, or already wrong.
_PAID_PLANS = ("starter", "pro")


def _paid_cap_values() -> set[int]:
    """Every positive cap a paid plan actually grants. A literal in upgrade
    prose is only suspicious when it equals one of these — that is what makes
    it a restatement of a cap rather than an HTTP status or a price."""
    out: set[int] = set()
    for plan in _PAID_PLANS:
        for v in PLAN_CAPS[plan].values():
            if isinstance(v, int) and v > 1:
                out.add(v)
    return out


def _upgrade_lines():
    """(file, lineno, text) for every line that pitches a paid plan by number.

    Comments and docstrings are skipped — they describe the cap for a reader,
    they are not shown to an owner, and flagging them trains people to ignore
    this test. Docstring state is tracked rather than guessed, because the
    invoices.py nudge that first tripped this lives inside one.
    """
    for path in sorted(_ROUTERS.glob("*.py")):
        in_doc = False
        for i, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
            stripped = line.strip()
            fences = stripped.count('"""') + stripped.count("'''")
            was_in_doc = in_doc
            if fences % 2 == 1:
                in_doc = not in_doc
            if was_in_doc or in_doc or stripped.startswith("#"):
                continue
            if "Upgrade to" not in line and "Opgrader til" not in line:
                continue
            yield path.name, i, line


def test_no_upgrade_string_hardcodes_a_cap_number():
    """A cap quoted in prose must be interpolated, never typed.

    Precise by construction: only a literal that MATCHES a real paid-plan cap
    is flagged, so HTTP status codes (402/403/409) and prices (129/199/249/349)
    in the same sentence are not noise. The consequence is that a number which
    is merely wrong today still slips through — that is what the pricing audit
    is for; this guard exists to stop a CORRECT number going stale later.
    """
    caps = _paid_cap_values()
    offenders = []
    for fname, lineno, line in _upgrade_lines():
        # An interpolated cap is the correct shape — skip those.
        if "PLAN_CAPS" in line or "{cap" in line or "get_cap" in line:
            continue
        for n in re.findall(r"\b(\d{2,4})\b", line):
            if int(n) in caps:
                offenders.append(
                    f"{fname}:{lineno} restates cap {n} → {line.strip()}"
                )
    assert not offenders, (
        "Upgrade copy must read the cap from PLAN_CAPS, not restate it. "
        "A typed number goes stale silently the next time a cap is retuned — "
        "that is exactly how the receipt-OCR wall spent months telling owners "
        "Starter gave 200 scans when it gave 300:\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.parametrize("plan", _PAID_PLANS)
def test_every_advertised_cap_is_a_real_plan_caps_key(plan):
    """Guards the other direction — the caps the walls point at must exist."""
    caps = PLAN_CAPS[plan]
    assert caps["expense_receipt_scans_per_month"] > 0
    assert "reservations_per_month" in caps
    assert "modules" in caps


def test_the_specific_regression_is_gone():
    """The exact string that shipped. Named so a future reader sees the case."""
    text = (_ROUTERS / "expenses.py").read_text()
    assert "Upgrade to Starter for 200 / month" not in text, (
        "the stale 200 is back — Starter's OCR cap is "
        f"{PLAN_CAPS['starter']['expense_receipt_scans_per_month']}"
    )
    assert PLAN_CAPS["starter"]["expense_receipt_scans_per_month"] == 300, (
        "Starter's OCR cap moved — check the public pricing table "
        "(PricingV2.jsx) says the same number before changing this test"
    )
