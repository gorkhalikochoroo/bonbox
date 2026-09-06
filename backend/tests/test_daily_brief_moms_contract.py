"""Producer/consumer contract for the daily brief's MOMS countdown.

WHY THIS FILE EXISTS
--------------------
`compute_precompute` read `next_vat["date"]` from
`tax_service.get_tax_overview()["upcoming_deadlines"]`. That producer has
never emitted a `date` key — its rows are keyed on `deadline`. So the read
was always None, `moms_days_left` stayed None, and the gate in
`generate_candidates` (`moms_days_left is not None`) dropped the MOMS
candidate from every brief the product has ever generated. The single most
important compliance signal in the app was silently absent for months.

The suite did not catch it because the two tests that touched this path
monkeypatched `get_tax_overview` with a hand-written `{type, date,
estimated_amount}` dict — a shape the producer does not return. They
asserted a fiction, and a fiction is exactly what the consumer was written
against.

So these tests never mock the producer's row shape. They either call the
real producer, or (where the calendar would make an assertion flaky) patch
only the *deadline calendar* underneath it and let the real
`get_tax_overview` → `_calc_vat` → `compute_precompute` →
`generate_candidates` chain run end to end. A key rename on either side
fails here.

Run: cd backend && python3 -m pytest tests/test_daily_brief_moms_contract.py -q
"""
from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services import tax_service
from app.services.daily_brief import compute_precompute, generate_candidates
from app.services.push_sender import _compose_brief_payload

# The keys compute_precompute reads off an upcoming_deadlines row.
_CONSUMED_KEYS = {"deadline", "estimated_amount", "period_label"}


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
        email="contract@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="restaurant", currency="DKK", plan="pro",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _seed_trade(db, owner, days: int = 260):
    """Real turnover, so the MOMS figure is a number and not an incidental
    zero. Without this the amount assertions below pass trivially: an empty
    account has output_vat == input_vat == vat_payable == 0.

    260 days so the 190-day filing period is fully covered whenever in the
    year the suite runs — a short seed leaves most of the period empty and
    the figure unrepresentative."""
    cat = ExpenseCategory(user_id=owner.id, name="Varekøb")
    db.add(cat)
    db.commit()
    db.refresh(cat)
    rng = random.Random(20260905)
    today = date.today()
    for i in range(days):
        d = today - timedelta(days=i)
        for _ in range(rng.randint(12, 25)):
            db.add(Sale(user_id=owner.id, date=d,
                        amount=round(rng.uniform(38, 265), 2)))
        if rng.random() < 0.4:
            db.add(Expense(user_id=owner.id, date=d, category_id=cat.id,
                           amount=round(rng.uniform(420, 4300), 2),
                           description="Leverandør", is_personal=False,
                           status="confirmed"))
    db.commit()


# ── The producer's real row shape ──────────────────────────────────────────
@pytest.mark.parametrize("freq", ["monthly", "quarterly", "half_yearly"])
def test_get_next_deadlines_keys_deadline_not_date(freq):
    """The raw calendar rows key the due date as `deadline`."""
    rows = tax_service._get_next_deadlines("DKK", frequency=freq, count=2)
    assert rows, f"no DKK {freq} deadlines produced"
    for r in rows:
        assert "deadline" in r
        assert "date" not in r, (
            "a `date` key reappeared — daily_brief.compute_precompute reads "
            "`deadline`; reconcile the two before shipping"
        )


def test_get_tax_overview_row_carries_every_key_the_brief_reads(db):
    """The real end-producer emits each key compute_precompute consumes.

    This is the assertion whose absence let the bug ship.
    """
    overview = tax_service.get_tax_overview(_owner(db), db)
    rows = overview.get("upcoming_deadlines") or []
    assert rows, "get_tax_overview produced no upcoming_deadlines"
    missing = _CONSUMED_KEYS - set(rows[0].keys())
    assert not missing, f"upcoming_deadlines row is missing {sorted(missing)}"
    assert "date" not in rows[0]
    # Payroll rides a separate key, so every upcoming_deadlines row is MOMS.
    assert "payroll_deadlines" in overview


# ── End to end, through the real producer ──────────────────────────────────
def _patch_calendar(monkeypatch, days_out: int):
    """Move only the DEADLINE CALENDAR. get_tax_overview, _calc_vat,
    compute_precompute and generate_candidates all still run for real, so
    the row that reaches the brief is one the producer actually built."""
    due = date.today() + timedelta(days=days_out)

    def _fake(currency, frequency=None, count=4, as_of=None):
        return [{
            "deadline": due,
            "period_start": due - timedelta(days=190),
            "period_end": due - timedelta(days=1),
            "period_label": "H2 2026",
        }]
    monkeypatch.setattr(tax_service, "_get_next_deadlines", _fake)
    return due


def test_moms_candidate_reaches_the_owner_through_the_real_producer(db, monkeypatch):
    """The regression itself: an owner 10 days from a frist gets a MOMS line."""
    due = _patch_calendar(monkeypatch, 10)
    owner = _owner(db)
    _seed_trade(db, owner)
    pc = compute_precompute(owner, db)

    assert pc.moms_days_left == 10, "the MOMS countdown never reached the brief"
    assert pc.moms_deadline_date == due.isoformat()
    assert pc.moms_period_label == "H2 2026"
    assert pc.moms_estimated_owed and pc.moms_estimated_owed > 0

    cands = [c for c in generate_candidates(pc) if c.cta_url == "/tax"]
    assert len(cands) == 1
    text = cands[0].text
    assert "MOMS" in text and "Moms" not in text  # locked term, uppercase
    assert "H2 2026" in text                      # window named, see below
    assert "10 days" in text
    # DK money format — "78.000 kr.", never the browser-locale "78,000".
    assert " kr." in text and "owed" in text


def test_moms_amount_comes_from_the_filing_engine_not_a_naive_rate(db, monkeypatch):
    """The kr figure must be _calc_vat's vat_payable for THAT period — the
    same engine compute_filing_data uses for the dashboard MOMS strip — and
    must never fall back to the year-to-date figure, which measures a
    different window and would put a wrong number behind a right deadline."""
    _patch_calendar(monkeypatch, 10)
    owner = _owner(db)
    _seed_trade(db, owner)

    overview = tax_service.get_tax_overview(owner, db)
    row = overview["upcoming_deadlines"][0]
    pc = compute_precompute(owner, db)

    assert row["estimated_amount"] > 0, "seed produced no turnover"
    assert pc.moms_estimated_owed == pytest.approx(row["estimated_amount"])
    # vat_payable is output − input for the period, by construction.
    assert row["estimated_amount"] == pytest.approx(
        row["output_vat"] - row["input_vat"], abs=0.01
    )


def test_absent_amount_yields_no_figure_never_the_ytd_figure(db, monkeypatch):
    """The removed fallback, pinned behaviourally.

    compute_precompute used to fall back to `ytd.vat_payable` when the row
    carried no `estimated_amount`. That is a different window — year to date,
    not the filing period — so it would have put a wrong kroner figure behind
    a right deadline, in an email about a SKAT liability. Correct behaviour is
    a bare countdown with no figure at all.

    Asserted on behaviour rather than by comparing the two windows' totals:
    a comparison is only meaningful when the calendar happens to make them
    differ, and around 30 June the filing period and the year-to-date window
    coincide.
    """
    due = date.today() + timedelta(days=10)

    def _no_amount(_u, _d):
        return {
            "upcoming_deadlines": [{
                "deadline": str(due), "period_label": "H2 2026",
                "period_start": str(due - timedelta(days=190)),
                "period_end": str(due - timedelta(days=1)),
            }],
            "ytd": {"vat_payable": 999_999.0},   # must NOT be picked up
        }
    monkeypatch.setattr(tax_service, "get_tax_overview", _no_amount)

    pc = compute_precompute(_owner(db), db)
    assert pc.moms_days_left == 10          # countdown still shown
    assert pc.moms_estimated_owed is None   # figure withheld, not guessed

    cands = [c for c in generate_candidates(pc) if c.cta_url == "/tax"]
    assert len(cands) == 1
    assert "999" not in cands[0].text and "kr." not in cands[0].text
    assert "MOMS filing for H2 2026 in 10 days" in cands[0].text


def test_no_moms_line_when_the_deadline_is_far_out(db, monkeypatch):
    """Beyond the window the brief stays quiet — no filler, no noise."""
    _patch_calendar(monkeypatch, 200)
    pc = compute_precompute(_owner(db), db)
    assert pc.moms_days_left == 200
    assert [c for c in generate_candidates(pc) if c.cta_url == "/tax"] == []


def test_missing_deadline_key_suppresses_and_warns(db, monkeypatch, caplog):
    """A producer-shape drift must be loud. Silence here is the whole bug."""
    def _fake(currency, frequency=None, count=4, as_of=None):
        return []
    monkeypatch.setattr(tax_service, "_get_next_deadlines", _fake)

    def _no_deadline(_u, _d):
        return {"upcoming_deadlines": [{"period_label": "H2 2026",
                                        "estimated_amount": 45000.0}]}
    monkeypatch.setattr(tax_service, "get_tax_overview", _no_deadline)

    with caplog.at_level("WARNING"):
        pc = compute_precompute(_owner(db), db)
    assert pc.moms_days_left is None          # fail closed, no half-truth
    assert pc.moms_estimated_owed is None
    assert any("no 'deadline' key" in r.message for r in caplog.records)


# ── Delivery: the figure must not ride to a lock screen ────────────────────
def test_push_body_drops_the_moms_amount_but_keeps_the_countdown():
    """MOMS candidates outweigh everything else (0.92-0.98), so enabling them
    made a SKAT liability figure the most likely morning push. That figure is
    owner-only everywhere else in the codebase; a notification tray is a
    weaker boundary than any of those gates. The countdown and the reason to
    tap survive — only the kroner go."""
    payload = _compose_brief_payload({
        "headline": "MOMS filing for H2 2026 in 3 days, est. 78.000 kr. owed "
                    "— review now to avoid the rush.",
        "insights": [],
    })
    assert payload is not None
    body = payload["body"]
    assert "78.000" not in body and "owed" not in body
    assert "MOMS filing for H2 2026 in 3 days" in body
    assert "review now to avoid the rush" in body


def test_push_body_drops_the_moms_amount_for_non_dkk_currencies():
    payload = _compose_brief_payload({
        "headline": "MOMS filing for Q3 2026 in 10 days, est. 9,000 EUR owed.",
        "insights": [],
    })
    assert "9,000" not in payload["body"] and "EUR" not in payload["body"]
    assert "MOMS filing for Q3 2026 in 10 days" in payload["body"]


@pytest.mark.parametrize("headline", [
    # Layer 3 rephrases freely, so the redaction cannot rely on the
    # deterministic clause wording. These are LLM-shaped variants.
    "MOMS for H2 2026 is due in 3 days — 78.000 kr. goes to SKAT.",
    "Set aside 78.000 kr. before the MOMS deadline on 15 September.",
    "Your SKAT filing lands in 3 days; 78.000 kr. is owed.",
    "MOMS filing in 10 days, est. 9,000 EUR owed.",
])
def test_push_body_never_carries_a_figure_alongside_a_tax_term(headline):
    body = _compose_brief_payload({"headline": headline, "insights": []})["body"]
    assert "78.000" not in body and "9,000" not in body
    assert "kr." not in body and "EUR" not in body
    # The reason to tap survives.
    assert "MOMS" in body or "SKAT" in body


@pytest.mark.parametrize("headline", [
    "Your 2026 MOMS filing is due in 3 days.",
    "MOMS for 2026 SKAT reporting in 3 days.",
])
def test_push_redaction_does_not_eat_the_locked_term_itself(headline):
    """A year next to MOMS/SKAT is digits followed by three capitals. Without
    word boundaries the money pattern chews the term into 'an amountS'."""
    body = _compose_brief_payload({"headline": headline, "insights": []})["body"]
    assert body == headline


def test_push_redaction_leaves_non_moms_bodies_untouched():
    """Scoped to tax bodies: revenue amounts in other candidates are a real
    but pre-existing exposure, and not this change's call to make."""
    original = "Yesterday: 9.000 kr. (+12% vs day before)"
    payload = _compose_brief_payload({"headline": original, "insights": []})
    assert payload["body"] == original
