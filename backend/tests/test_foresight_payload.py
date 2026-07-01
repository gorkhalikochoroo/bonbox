"""
Tests for the foresight payload composer (task #354).

The two DB-touching dependencies (_calc_vat, detect_recurring_outflows) are
monkeypatched so the composition is deterministic regardless of today's date.
resolve_next_deadline runs for real against tax_service. Verdicts are forced by
extreme balances so they don't depend on the run-rate projection magnitude.
"""
import logging
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.services import foresight_payload as fp


@pytest.fixture
def user():
    return SimpleNamespace(id="u1", currency="DKK",
                           tax_filing_frequency="half_yearly", prices_include_moms=True)


@pytest.fixture
def patched(monkeypatch):
    """Default: 50k realized MOMS, no recurring outflows."""
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 50000})
    monkeypatch.setattr(fp, "detect_recurring_outflows", lambda *a, **k: [])


AS_OF = date(2026, 6, 14)


def test_no_moms_config_unavailable(monkeypatch):
    u = SimpleNamespace(id="u1", currency="ZZZ")
    out = fp.build_foresight_payload(u, db=None, as_of=AS_OF)
    assert out["available"] is False
    assert out["reason"] == "no_moms_config"


def test_covered_when_balance_far_exceeds_moms(user, patched):
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF,
                                     bank_balance=Decimal("10000000"))
    assert out["available"] is True
    assert out["verdict"] == "ON_TRACK"
    assert out["covers_moms"] is True
    assert out["balance_connected"] is True
    assert out["moms"]["expected"] >= 50000      # realized + projected ≥ realized
    assert out["moms"]["high"] >= out["moms"]["expected"]
    assert out["envelope"]["target"] == out["moms"]["high"]   # envelope rings the high bill
    assert out["deadline"]["date"] > AS_OF.isoformat()


def test_short_when_balance_zero_surfaces_action(user, patched):
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=Decimal("0"))
    assert out["verdict"] == "SHORT"
    assert out["covers_moms"] is False
    assert out["action"]["already_covered"] is False
    assert out["action"]["weekly_rate"] > 0


def test_no_bank_balance_is_insufficient_but_still_useful(user, patched):
    # The headline verdict honestly withholds (no balance), yet the deadline,
    # MOMS range, and reserve target still populate — the card works pre-connect.
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=None)
    assert out["verdict"] == "INSUFFICIENT_DATA"
    assert out["covers_moms"] is None
    assert out["balance_connected"] is False
    assert out["balance"]["starting"] is None
    assert out["timeline"] == []
    # …but the reserve plan is fully populated:
    assert out["moms"]["expected"] >= 50000
    assert out["envelope"]["status"] == "FUNDING"
    assert out["envelope"]["target"] > 0
    assert out["envelope"]["weekly_contribution"] > 0


def test_recurring_outflows_counted(user, monkeypatch):
    from app.services.foresight_service import CashEvent
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 50000})
    monkeypatch.setattr(fp, "detect_recurring_outflows",
                        lambda *a, **k: [CashEvent(on=date(2026, 7, 1), amount=Decimal("-12000"),
                                                   label="Husleje", kind="recurring")])
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=Decimal("10000000"))
    assert out["recurring_outflow_count"] == 1


def test_reserved_progress_reflected_in_envelope(user, patched):
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF,
                                     bank_balance=None, reserved=Decimal("1000000"))
    # huge reserve fully funds the envelope regardless of the exact target
    assert out["envelope"]["status"] == "FUNDED"
    assert out["envelope"]["remaining"] == 0


# ── _moms_range_split: the one new piece of money math ─────────────────

def _u():
    return SimpleNamespace(id="u1", currency="DKK", prices_include_moms=True)


def test_moms_split_projects_remaining_mid_period(monkeypatch):
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 50000})
    realized, projected = fp._moms_range_split(
        _u(), None, date(2026, 1, 1), date(2026, 6, 30), date(2026, 3, 31))
    assert realized == Decimal("50000")
    assert projected > 0                      # the not-yet-elapsed period is extrapolated


def test_moms_split_no_projection_once_period_is_over(monkeypatch):
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 50000})
    realized, projected = fp._moms_range_split(
        _u(), None, date(2026, 1, 1), date(2026, 6, 30), date(2026, 7, 15))
    assert realized == Decimal("50000")
    assert projected == Decimal("0")


def test_moms_split_refund_period_clamps_to_zero(monkeypatch):
    # A net-refund period (input VAT > output) isn't a cash outflow at the frist.
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": -20000})
    realized, projected = fp._moms_range_split(
        _u(), None, date(2026, 1, 1), date(2026, 6, 30), date(2026, 3, 31))
    assert realized == Decimal("0")
    assert projected == Decimal("0")


# ── #356 hardening: feature flag, calibration, tenant scoping, honesty ──

def test_feature_flag_off_short_circuits(user, patched, monkeypatch):
    monkeypatch.setattr(fp.settings, "FORESIGHT_ENABLED", False)
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=Decimal("0"))
    assert out == {"available": False, "reason": "disabled"}


def test_calibration_signal_is_logged(user, patched, caplog):
    with caplog.at_level(logging.INFO, logger="app.services.foresight_payload"):
        fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=None)
    assert "foresight.calibration" in caplog.text
    assert "verdict=INSUFFICIENT_DATA" in caplog.text


def test_calibration_never_breaks_payload(user, patched, monkeypatch):
    # _log_calibration swallows logging errors — a dead log sink can't break
    # the payload (fail-soft).
    def _boom(*a, **k):
        raise RuntimeError("log sink down")
    monkeypatch.setattr(fp.logger, "info", _boom)
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=Decimal("0"))
    assert out["available"] is True   # calibration error swallowed, payload intact


def test_tenant_scoped_to_requesting_user(user, monkeypatch):
    # MOMS is computed for the REQUESTING user's id — never another tenant's.
    seen = []
    def spy(db, user_id, *a, **k):
        seen.append(user_id)
        return {"vat_payable": 50000}
    monkeypatch.setattr(fp.tax_service, "_calc_vat", spy)
    monkeypatch.setattr(fp, "detect_recurring_outflows", lambda u, db, **k: [])
    fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=Decimal("0"))
    assert seen and all(uid == "u1" for uid in seen)


def test_honest_no_coverage_claim_without_balance(user, patched):
    out = fp.build_foresight_payload(user, db=None, as_of=AS_OF, bank_balance=None)
    assert out["balance_connected"] is False
    assert out["balance_source"] == "none"
    assert out["covers_moms"] is not True       # never a positive coverage claim w/o a balance
    assert out["verdict"] == "INSUFFICIENT_DATA"


# ── manual bank balance (the no-provider path) ─────────────────────────

def test_manual_balance_seeds_a_real_verdict(patched):
    from datetime import datetime
    u = SimpleNamespace(id="u1", currency="DKK", tax_filing_frequency="half_yearly",
                        prices_include_moms=True, manual_bank_balance=10000000,
                        manual_bank_balance_at=datetime(2026, 6, 14))
    out = fp.build_foresight_payload(u, db=None, as_of=AS_OF)  # no explicit bank_balance
    assert out["balance_source"] == "manual"
    assert out["balance_connected"] is True
    assert out["verdict"] != "INSUFFICIENT_DATA"   # a real verdict from the typed balance
    assert out["covers_moms"] is True
    assert out["balance_stale"] is False           # entered today


def test_manual_balance_goes_stale_after_14_days(patched):
    from datetime import datetime
    u = SimpleNamespace(id="u1", currency="DKK", tax_filing_frequency="half_yearly",
                        prices_include_moms=True, manual_bank_balance=10000000,
                        manual_bank_balance_at=datetime(2026, 5, 1))  # 44 days before AS_OF
    out = fp.build_foresight_payload(u, db=None, as_of=AS_OF)
    assert out["balance_stale"] is True
    assert out["balance_entered_at"].startswith("2026-05-01")
    # Fail-closed (#352): a weeks-old balance must NOT read as "you're covered".
    assert out["verdict"] == "INSUFFICIENT_DATA"
    assert out["covers_moms"] is None


def test_explicit_bank_balance_wins_over_manual(patched):
    from datetime import datetime
    u = SimpleNamespace(id="u1", currency="DKK", tax_filing_frequency="half_yearly",
                        prices_include_moms=True, manual_bank_balance=10000000,
                        manual_bank_balance_at=datetime(2026, 6, 14))
    out = fp.build_foresight_payload(u, db=None, as_of=AS_OF, bank_balance=Decimal("0"))
    assert out["balance_source"] == "bank"   # explicit (future PSD2) takes precedence
    assert out["verdict"] == "SHORT"
