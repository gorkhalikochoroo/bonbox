"""
Tests for the MOMS reserve / envelope model (task #350).

Pure — composes a cone + the weekly-rate solver. The envelope is the ring-fence
face: how much to set aside, and the weekly contribution to fund it by the frist.
"""
from datetime import date
from decimal import Decimal

from app.services import foresight_service as fs
from app.services.foresight_service import (
    ENVELOPE_FUNDED,
    ENVELOPE_FUNDING,
    ForesightInputs,
    STATE_INSUFFICIENT_DATA,
)

AS_OF = date(2026, 6, 14)
DEADLINE = date(2026, 9, 1)   # 79 days → 12 weeks


def _cone(balance="300000", realized="100000", projected="40000", deadline=DEADLINE):
    inp = ForesightInputs(
        as_of=AS_OF, deadline=deadline,
        current_balance=Decimal(balance) if balance is not None else None,
        safety_buffer=Decimal("0"),
    )
    rng = fs.build_moms_range(realized_moms=Decimal(realized),
                              projected_remaining_moms=Decimal(projected))
    return fs.build_cone(inp, rng)


def test_envelope_targets_high_end_by_default():
    env = fs.build_envelope(_cone())            # high = 100k + 40k·1.25 = 150k
    assert env.target == Decimal("150000")
    assert env.target_basis == "high"
    assert env.reserved == Decimal("0")
    assert env.remaining == Decimal("150000")
    assert env.funded_pct == 0.0
    assert env.status == ENVELOPE_FUNDING
    assert env.weekly_contribution == Decimal("12500")   # 150000 / 12 weeks


def test_envelope_expected_basis():
    env = fs.build_envelope(_cone(), target_basis="expected")
    assert env.target == Decimal("140000")               # realized + projected


def test_envelope_partial_reserve_progress():
    env = fs.build_envelope(_cone(), reserved=Decimal("75000"))
    assert env.funded_pct == 0.5
    assert env.remaining == Decimal("75000")
    assert env.status == ENVELOPE_FUNDING
    assert env.weekly_contribution > Decimal("0")


def test_envelope_fully_funded():
    env = fs.build_envelope(_cone(), reserved=Decimal("150000"))
    assert env.status == ENVELOPE_FUNDED
    assert env.remaining == Decimal("0")
    assert env.funded_pct == 1.0
    assert env.weekly_contribution == Decimal("0")


def test_envelope_over_reserved_is_clamped():
    env = fs.build_envelope(_cone(), reserved=Decimal("200000"))
    assert env.status == ENVELOPE_FUNDED
    assert env.remaining == Decimal("0")
    assert env.funded_pct == 1.0


def test_envelope_no_moms_is_funded():
    env = fs.build_envelope(_cone(realized="0", projected="0"))
    assert env.target == Decimal("0")
    assert env.status == ENVELOPE_FUNDED
    assert env.funded_pct == 1.0


def test_envelope_works_without_bank_balance():
    # The reserve target + contribution are balance-independent — the envelope
    # is useful BEFORE a bank is connected (only the verdict needs a balance).
    env = fs.build_envelope(_cone(balance=None))
    assert env.status == ENVELOPE_FUNDING
    assert env.target == Decimal("150000")
    assert env.weekly_contribution == Decimal("12500")
    assert env.weeks == 12


def test_envelope_insufficient_only_without_a_future_deadline():
    # No schedulable deadline ⇒ INSUFFICIENT_DATA (can't time contributions),
    # though the target itself is still reported.
    env = fs.build_envelope(_cone(deadline=None))
    assert env.status == STATE_INSUFFICIENT_DATA
    assert env.weeks is None
    assert env.weekly_contribution == Decimal("0")
