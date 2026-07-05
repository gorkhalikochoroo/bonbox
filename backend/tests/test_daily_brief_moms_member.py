"""
MOMS/tax is OWNER-ONLY: an invited staff member (manager/cashier/viewer) whose
session resolves to the owner tenant must NOT see the owner's SKAT liability
figure or filing reminders in the daily brief — the brief is reached via the
unguarded /api/dashboard/daily-brief, so the guard lives in compute_precompute.

An adversarial review found this leak (the nav/route/dashboard-card gates were
in place, but the brief's MOMS candidate still rendered "est. X kr owed" to a
member). Guarantees:
  • the MOMS candidate is dropped entirely when moms_days_left is None
    (the state the member guard produces) — so no figure AND no countdown,
  • compute_precompute nulls the MOMS fields for a member view (_is_member_view),
  • the OWNER (and the read-only accountant, who sets _is_accountant_view not
    _is_member_view) still gets the full MOMS brief.

Run: cd backend && python3 -m pytest tests/test_daily_brief_moms_member.py -q
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.user import User
from app.services.daily_brief import Precompute, generate_candidates, compute_precompute

# 20 neutral Precompute fields so no unrelated candidate interferes.
_REQUIRED = dict(
    business_name="Test", currency="DKK", today="2026-07-06", yesterday="2026-07-05",
    weekday="Monday", today_revenue=0.0, yesterday_revenue=0.0, pct_change_yesterday=0.0,
    week_avg_revenue=0.0, pct_change_week_avg=0.0, month_revenue=0.0, month_expenses=0.0,
    month_profit_margin_pct=0.0, monthly_goal=0.0, monthly_goal_progress_pct=0.0,
    days_left_in_month=10, top_seller_today=None, low_stock_items=[],
    khata_outstanding=0.0, khata_with_balance=0,
)


def _pc(**over):
    return Precompute(**{**_REQUIRED, **over})


def _moms_cands(cands):
    # Every MOMS candidate deep-links to /tax (see generate_candidates).
    return [c for c in cands if c.cta_url == "/tax"]


# ─── Mechanism: nulling moms_days_left drops the whole MOMS candidate ──────
def test_moms_candidate_present_when_days_set():
    c = _moms_cands(generate_candidates(_pc(moms_days_left=10, moms_estimated_owed=45000.0)))
    assert len(c) == 1
    # The owner's SKAT liability figure is in the text for the owner.
    assert "owed" in c[0].text.lower()


def test_moms_candidate_absent_when_days_none():
    # This is exactly the state the member guard produces → no leak.
    assert _moms_cands(generate_candidates(_pc(moms_days_left=None, moms_estimated_owed=45000.0))) == []


# ─── The guard itself: compute_precompute nulls MOMS for a member view ─────
@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


def _owner(db):
    u = User(
        email="owner@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="restaurant", currency="DKK", plan="pro", email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _patch_tax(monkeypatch):
    # A real upcoming MOMS deadline with an owed figure — the sensitive data.
    def _fake(_user, _db):
        return {
            "upcoming_deadlines": [
                {"type": "vat", "date": "2026-12-31", "estimated_amount": 45000.0}
            ],
            "ytd": {"vat_payable": 45000.0},
        }
    monkeypatch.setattr("app.services.tax_service.get_tax_overview", _fake)


def test_compute_precompute_gives_owner_the_moms_figure(db, monkeypatch):
    _patch_tax(monkeypatch)
    owner = _owner(db)  # a normal owner session — no _is_member_view flag
    pc = compute_precompute(owner, db)
    assert pc.moms_days_left is not None
    assert pc.moms_estimated_owed == 45000.0


def test_compute_precompute_hides_moms_from_member(db, monkeypatch):
    _patch_tax(monkeypatch)
    owner = _owner(db)
    # Simulate the resolved member view: the session is the OWNER object with the
    # member-view flag set (as auth._resolve_member_view does for staff roles).
    owner._is_member_view = True
    pc = compute_precompute(owner, db)
    # Owner-only: the member sees neither the figure nor the countdown.
    assert pc.moms_days_left is None
    assert pc.moms_estimated_owed is None
    # And therefore no MOMS candidate is emitted for them.
    assert _moms_cands(generate_candidates(pc)) == []
