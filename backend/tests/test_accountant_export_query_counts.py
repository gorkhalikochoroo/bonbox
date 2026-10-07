"""Accountant exports: a constant number of SQL queries, and the same document.

THE BUG (perf baseline 2026-10-07). The period PDF and Excel fetched each
day's bilagsnummer range with two queries per close, and the PDF did it inside
the story builder that the two-pass render runs twice: a September PDF was 113
queries, 7 days 21, 122 days 129 — growing with the range. The lønseddel PDF
fetched hours one employee at a time and wrote each §10 audit row in its own
round trip: 22 queries at 8 staff, 54 at 24.

WHAT THESE PIN:
  • the query count is the SAME for a 7-, 30- and 120-day period (PDF, Excel,
    CSV) and for 3 and 24 staff (lønseddel, payroll CSV) — counted with
    SQLAlchemy's before_cursor_execute, at the service and at the endpoint;
  • the grouped voucher lookup gives every day exactly the label the per-day
    lookup gives (and the hand-computed one), tenant- and deletion-scoped;
  • the documents are unchanged: the period PDF is byte-identical and the
    workbook cell-identical to the per-day path from the same fixture; the
    lønseddel PDF is byte-identical to the per-employee path;
  • the lønseddel still writes one audit row per employee — in ONE INSERT.
"""
from __future__ import annotations

import io
import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services import daily_close_range_export as rx
from app.services import loenseddel_pdf as lp
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

_db_ready.set()

FIXED_NOW = datetime(2026, 10, 7, 12, 0, 0)
LAST_DAY = date(2026, 8, 28)
FIRST_DAY = LAST_DAY - timedelta(days=119)          # 120 days of closes
RANGES = {
    "7d": (LAST_DAY - timedelta(days=6), LAST_DAY),
    "30d": (LAST_DAY - timedelta(days=29), LAST_DAY),
    "120d": (FIRST_DAY, LAST_DAY),
}


# ─── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def env(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    monkeypatch.setattr("app.services.billing.SessionLocal", SessionLocal, raising=False)
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)
    from app.routers import daily_close as _dc
    _dc._limiter.reset()

    counter = {"n": 0, "stmts": []}

    def _count(conn, cursor, statement, params, context, executemany):
        counter["n"] += 1
        counter["stmts"].append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    counter["SessionLocal"] = SessionLocal
    try:
        yield s, counter
    finally:
        event.remove(engine, "before_cursor_execute", _count)
        s.close()
        app.dependency_overrides.pop(get_db, None)
        _dc._limiter.reset()


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def deterministic(monkeypatch):
    """ReportLab invariant mode (fixed /ID + creation date) and a pinned clock
    for the 'Genereret …' footer, so two renders can be compared byte for byte."""
    from reportlab import rl_config
    monkeypatch.setattr(rl_config, "invariant", 1)
    monkeypatch.setattr("app.utils.time.utc_now", lambda: FIXED_NOW)
    monkeypatch.setattr(lp, "utc_now", lambda: FIXED_NOW)


def _session_per_request(counter):
    """Like production: every request gets its own session. The shared test
    session would carry the previous request's expired objects into the next
    one and add refresh SELECTs that have nothing to do with the export."""
    SessionLocal = counter["SessionLocal"]

    def _get_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db


def _counted(counter, fn, *a, **kw):
    counter["n"] = 0
    counter["stmts"] = []
    out = fn(*a, **kw)
    return out, counter["n"]


# ─── Seed ─────────────────────────────────────────────────────────────


def _owner(db, email="anders@mirabelle.dk"):
    u = User(
        email=email, password_hash=hash_password("x"),
        business_name="Mirabelle Café", business_type="restaurant",
        currency="DKK", plan="pro", email_verified=True,
        created_at=utc_now() - timedelta(days=200),
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(
        user_id=u.id, company_name="Mirabelle ApS", org_number="39842851",
        country="DK", address="Vestergade 1", zipcode="1456", city="København K",
    ))
    db.commit()
    return u


def _auth(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _seed_period(db, owner):
    """120 days of closes plus sales/expenses carrying voucher numbers in every
    shape the Bilag column prints, and the rows the lookup must NOT see.
    Returns {date: (sales_label, expense_label)} computed by hand."""
    other = _owner(db, email="other@tenant.dk")
    cat = ExpenseCategory(user_id=owner.id, name="Varekøb")
    ocat = ExpenseCategory(user_id=other.id, name="Varekøb")
    branch = Branch(user_id=owner.id, name="Mirabelle Nørrebro")
    db.add_all([cat, ocat, branch]); db.commit()

    seq = {"S": 0, "E": 0}

    def _next(kind):
        seq[kind] += 1
        return seq[kind]

    def _label(prefix, nums, year):
        if not nums:
            return ""
        lo, hi = min(nums), max(nums)
        return f"{prefix}-{year}-{lo:04d}" if lo == hi else f"{prefix}-{year}-{lo:04d} → {prefix}-{year}-{hi:04d}"

    expected = {}
    rows = []
    for i in range(120):
        d = FIRST_DAY + timedelta(days=i)
        s_nums, e_nums = [], []
        n_sales = (0, 1, 3, 2)[i % 4]
        for _ in range(n_sales):
            v = _next("S"); s_nums.append(v)
            rows.append(Sale(user_id=owner.id, date=d, amount=100, voucher_number=v))
        # never in a range: no voucher, a deleted sale, another tenant's sale
        rows.append(Sale(user_id=owner.id, date=d, amount=50, voucher_number=None))
        if i % 4 == 3:
            rows.append(Sale(user_id=owner.id, date=d, amount=10, voucher_number=_next("S"), is_deleted=True))
        rows.append(Sale(user_id=other.id, date=d, amount=999, voucher_number=9000 + i))
        if i % 3 == 0:
            for _ in range(2):
                v = _next("E"); e_nums.append(v)
                rows.append(Expense(user_id=owner.id, category_id=cat.id, date=d, amount=40,
                                    description="Varer", voucher_number=v))
        if i % 5 == 0:
            rows.append(Expense(user_id=owner.id, category_id=cat.id, date=d, amount=5,
                                description="Slettet", voucher_number=_next("E"), is_deleted=True))
        rows.append(Expense(user_id=other.id, category_id=ocat.id, date=d, amount=7,
                            description="Andet", voucher_number=8000 + i))
        expected[d] = (_label("S", s_nums, d.year), _label("E", e_nums, d.year))

        rev = 1000.0 + 37 * i
        rows.append(DailyClose(
            user_id=owner.id, branch_id=None, date=d,
            revenue_categories=encode_breakdown({"food": rev}), revenue_total=rev,
            payment_categories=encode_breakdown({"cash": rev / 4, "card": rev * 3 / 4}),
            payment_total=rev, moms_total=round(rev / 5, 2), revenue_ex_moms=round(rev * 4 / 5, 2),
            moms_mode="auto", cash_expected=rev / 4, cash_counted=rev / 4, cash_difference=0.0,
            status="draft" if i % 10 == 5 else "confirmed", closed_by="Lars",
            closed_at=datetime.combine(d, datetime.min.time()) + timedelta(hours=23) if i % 10 != 5 else None,
            is_deleted=False,
        ))
        # A second till/branch on some days (the last day too, so every range
        # has one — the branch-name lookup is one query when any close has a
        # branch and none otherwise): two closes, one date.
        if i % 15 == 0 or i == 119:
            rows.append(DailyClose(
                user_id=owner.id, branch_id=branch.id, date=d,
                revenue_categories=encode_breakdown({"food": 500.0}), revenue_total=500.0,
                payment_categories=encode_breakdown({"card": 500.0}), payment_total=500.0,
                moms_total=100.0, revenue_ex_moms=400.0, moms_mode="auto",
                cash_expected=0.0, cash_counted=0.0, cash_difference=0.0,
                status="confirmed", closed_by="Mia",
                closed_at=datetime.combine(d, datetime.min.time()) + timedelta(hours=22),
                is_deleted=False,
            ))
    db.add_all(rows); db.commit()
    return expected


def _closes(db, owner, f, t):
    return (
        db.query(DailyClose)
        .filter(DailyClose.user_id == owner.id, DailyClose.date >= f, DailyClose.date <= t)
        .order_by(DailyClose.date.asc())
        .all()
    )


def _per_day_voucher_ranges(db, user_id, dates, *, expenses=True):
    """The pre-fix behaviour: the one-day lookup, called once per day."""
    return {d: rx._voucher_ranges(db, user_id, d) for d in dates if d is not None}


def _pdf_kw(owner, f, t, db):
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    return dict(from_date=f, to_date=t, business_name="Mirabelle ApS", currency="DKK",
                profile=profile, db=db, user_id=owner.id, bilagsnummer=f"KRP-{f:%Y%m%d}-{t:%Y%m%d}")


def _xlsx_cells(b: bytes) -> dict:
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(b))
    return {
        ws.title: [[(c.value, c.number_format) for c in row] for row in ws.iter_rows()]
        for ws in wb.worksheets
    }


def _pdf_text(b: bytes) -> str:
    from pypdf import PdfReader
    return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(b)).pages)


# ─── 1. Voucher ranges: grouped == per-day == by hand ─────────────────


def test_grouped_voucher_ranges_equal_the_per_day_lookup_for_every_day(env):
    db, counter = env
    owner = _owner(db)
    expected = _seed_period(db, owner)
    days = sorted(expected)

    grouped, n = _counted(counter, rx._voucher_ranges_by_date, db, owner.id, days)
    assert n == 2, "one grouped query per table, whatever the range"
    per_day, n_old = _counted(counter, _per_day_voucher_ranges, db, owner.id, days)
    assert n_old == 2 * len(days)  # the shape this replaces

    assert grouped == per_day == expected
    # Every shape is actually exercised — this is not a comparison of blanks.
    labels = [s for s, _ in expected.values()]
    assert "" in labels
    assert any("→" in s for s in labels)
    assert any(s and "→" not in s for s in labels)
    assert any(e for _, e in expected.values())

    sales_only, n = _counted(counter, rx._voucher_ranges_by_date, db, owner.id, days, expenses=False)
    assert n == 1
    assert {d: s for d, (s, _) in sales_only.items()} == {d: s for d, (s, _) in expected.items()}

    assert rx._voucher_ranges_by_date(None, owner.id, days) == {}
    assert rx._voucher_ranges_by_date(db, owner.id, [None]) == {}


# ─── 2. Period PDF / Excel / CSV: constant queries, same document ─────


def test_period_pdf_and_xlsx_builders_run_constant_queries_across_7_30_120_days(env):
    db, counter = env
    owner = _owner(db)
    _seed_period(db, owner)
    pdf_counts, xlsx_counts = {}, {}
    for label, (f, t) in RANGES.items():
        closes = _closes(db, owner, f, t)
        _, pdf_counts[label] = _counted(counter, rx.build_daily_close_range_pdf, closes, **_pdf_kw(owner, f, t, db))
        kw = _pdf_kw(owner, f, t, db); kw.pop("bilagsnummer")
        _, xlsx_counts[label] = _counted(counter, rx.build_daily_close_range_xlsx, closes, **kw)
    # PDF: the sales ranges only, once — not once per render pass.
    assert pdf_counts == {"7d": 1, "30d": 1, "120d": 1}, pdf_counts
    assert xlsx_counts == {"7d": 2, "30d": 2, "120d": 2}, xlsx_counts


def test_period_exports_endpoint_query_count_is_flat_across_7_30_120_days(env, client):
    db, counter = env
    _session_per_request(counter)
    owner = _owner(db)
    _seed_period(db, owner)
    hdr = _auth(owner)  # before counting: it reads owner.id from the test session
    from app.routers import daily_close as _dc
    counts = {}
    for fmt in ("pdf", "xlsx", "csv"):
        for label, (f, t) in RANGES.items():
            _dc._limiter.reset()
            counter["n"] = 0
            r = client.get(f"/api/daily-close/export.{fmt}",
                           params={"from": f.isoformat(), "to": t.isoformat()}, headers=hdr)
            assert r.status_code == 200, (fmt, label, r.text[:300])
            counts[(fmt, label)] = counter["n"]
    for fmt in ("pdf", "xlsx", "csv"):
        per_range = {label: counts[(fmt, label)] for label in RANGES}
        assert len(set(per_range.values())) == 1, f"{fmt} grows with the range: {per_range}"
        # Before the fix the September PDF alone was 113.
        assert per_range["120d"] <= 12, per_range


def test_period_pdf_is_byte_identical_to_the_per_day_path(env, deterministic, monkeypatch):
    db, _ = env
    owner = _owner(db)
    expected = _seed_period(db, owner)
    f, t = RANGES["30d"]
    closes = _closes(db, owner, f, t)

    new = rx.build_daily_close_range_pdf(closes, **_pdf_kw(owner, f, t, db))
    with monkeypatch.context() as m:
        m.setattr(rx, "_voucher_ranges_by_date", _per_day_voucher_ranges)
        old = rx.build_daily_close_range_pdf(closes, **_pdf_kw(owner, f, t, db))
    assert new == old

    text = _pdf_text(new)
    single = [s for d, (s, _) in expected.items() if f <= d <= t and s and "→" not in s]
    assert single and all(s in text for s in single), "the Bilag column prints the vouchers"


def test_period_xlsx_cells_are_identical_to_the_per_day_path(env, deterministic, monkeypatch):
    db, _ = env
    owner = _owner(db)
    expected = _seed_period(db, owner)
    f, t = RANGES["120d"]
    closes = _closes(db, owner, f, t)
    kw = _pdf_kw(owner, f, t, db); kw.pop("bilagsnummer")

    new = _xlsx_cells(rx.build_daily_close_range_xlsx(closes, **kw))
    with monkeypatch.context() as m:
        m.setattr(rx, "_voucher_ranges_by_date", _per_day_voucher_ranges)
        old = _xlsx_cells(rx.build_daily_close_range_xlsx(closes, **kw))
    assert new == old

    # And the Salgsbilag / Udgiftsbilag columns hold the hand-computed labels.
    detail = new["Kasserapport"]
    hdr = [c[0] for c in detail[0]]
    si, ei = hdr.index("Salgsbilag"), hdr.index("Udgiftsbilag")
    by_row = [(row[si][0] or "", row[ei][0] or "") for row in detail[1:1 + len(closes)]]
    want = [expected[c.date] for c in sorted(closes, key=lambda c: c.date)]
    assert by_row == want
    assert any("→" in s for s, _ in by_row) and any(e for _, e in by_row)


# ─── 3. Lønseddel: one hours query, one audit INSERT, same PDF ────────


def _seed_staff(db, owner, n, *, tag):
    staff = []
    for k in range(n):
        e = StaffMember(user_id=owner.id, name=f"{tag} {k:02d}", role="barista",
                        contract_type="full", base_rate=180.0 + k, tax_card_type="hovedkort",
                        active=True)
        db.add(e); staff.append(e)
    db.commit()
    rows = []
    for k, e in enumerate(staff):
        for day in range(1, 1 + 3 + k % 4):
            # Logged out of order on purpose: the PDF lists them by date, start.
            for start, end, hrs in (("16:00", "22:00", 6.0), ("08:00", "12:00", 4.0)):
                rate = 180.0 + k
                rows.append(HoursLogged(
                    user_id=owner.id, staff_id=e.id, date=date(2026, 9, day + k % 5),
                    start_time=start, end_time=end, total_hours=hrs, rate_applied=rate,
                    earned=hrs * rate, entry_method="quick",
                ))
    db.add_all(rows); db.commit()
    return staff


def test_loenseddel_builder_runs_one_query_for_3_and_24_staff(env, deterministic):
    db, counter = env
    counts = {}
    for n in (3, 24):
        owner = _owner(db, email=f"owner{n}@cafe.dk")
        staff = _seed_staff(db, owner, n, tag=f"S{n}")
        for o in (owner, *staff):  # loaded, as the router's own query leaves them
            db.refresh(o)
        _, counts[n] = _counted(counter, lp.build_loenseddel_pdf_multi, db, owner, staff,
                                date(2026, 9, 1), date(2026, 9, 30))
    assert counts == {3: 1, 24: 1}, counts


def test_loenseddel_pdf_is_byte_identical_to_the_per_employee_path(env, deterministic, monkeypatch):
    db, counter = env
    owner = _owner(db)
    staff = _seed_staff(db, owner, 24, tag="Medarbejder")
    idle = StaffMember(user_id=owner.id, name="Ingen timer", role="barista", contract_type="full",
                       base_rate=150.0, active=True)
    db.add(idle); db.commit()
    everyone = staff + [idle]
    period = (date(2026, 9, 1), date(2026, 9, 30))

    new_pdf, new_sum = lp.build_loenseddel_pdf_multi(db, owner, everyone, *period)
    with monkeypatch.context() as m:
        m.setattr(lp, "_hours_by_staff", lambda *a, **k: {})  # → per-employee queries
        (old_pdf, old_sum), n_old = _counted(counter, lp.build_loenseddel_pdf_multi, db, owner, everyone, *period)
    assert n_old == len(everyone)  # the shape this replaces
    assert new_pdf == old_pdf
    assert new_sum == old_sum
    assert new_sum["per_employee"][-1]["total_hours"] == 0
    assert all(pe["total_gross"] > 0 for pe in new_sum["per_employee"][:-1])


def test_loenseddel_endpoint_is_flat_across_3_and_24_staff_with_one_audit_insert(env, client):
    db, counter = env
    _session_per_request(counter)
    counts, inserts = {}, {}
    owners = {}
    for n in (3, 24):
        owner = _owner(db, email=f"owner{n}@cafe.dk")
        _seed_staff(db, owner, n, tag=f"S{n}")
        owners[n] = owner
        hdr = _auth(owner)
        counter["n"] = 0
        counter["stmts"] = []
        r = client.get("/api/staff/payroll/loenseddel",
                       params={"period_start": "2026-09-01", "period_end": "2026-09-30"},
                       headers=hdr)
        assert r.status_code == 200, r.text[:300]
        counts[n] = counter["n"]
        inserts[n] = sum(1 for s in counter["stmts"] if s.lstrip().upper().startswith("INSERT INTO AUDIT_LOGS"))
    assert counts[3] == counts[24], counts
    assert counts[24] <= 12, counts  # was 54 at 24 staff
    assert inserts == {3: 1, 24: 1}, inserts
    # Still one §10 row per employee, each naming its own bilagsnummer.
    for n, owner in owners.items():
        rows = db.query(AuditLog).filter(
            AuditLog.user_id == owner.id,
            AuditLog.action == "staff.loenseddel_pdf_generated",
        ).all()
        assert len(rows) == n
        assert len({r.entity_id for r in rows}) == n
        assert all("LON-" in (r.after_state or "") for r in rows)


def test_payroll_csv_endpoint_is_flat_across_3_and_24_staff(env, client):
    db, counter = env
    _session_per_request(counter)
    counts = {}
    for n in (3, 24):
        owner = _owner(db, email=f"pay{n}@cafe.dk")
        _seed_staff(db, owner, n, tag=f"P{n}")
        hdr = _auth(owner)
        counter["n"] = 0
        r = client.get("/api/staff/payroll/csv",
                       params={"period_start": "2026-09-01", "period_end": "2026-09-30"},
                       headers=hdr)
        assert r.status_code == 200, r.text[:300]
        assert r.text.count("\n") >= n + 1
        counts[n] = counter["n"]
    assert counts[3] == counts[24], counts


def test_record_many_is_best_effort_like_record(env, caplog):
    """A failing flush is logged, never raised — the export must still go out."""
    db, _ = env
    from app.services import audit_service
    owner = _owner(db)

    class _Boom:
        def add_all(self, objs):
            raise RuntimeError("db down")

    audit_service.record_many(_Boom(), owner, [{"action": "x.y", "entity_type": "z"}])
    assert "record_many FAILED" in caplog.text
    audit_service.record_many(db, owner, [])  # no rows → no-op
    audit_service.record_many(db, owner, [
        {"action": "a.b", "entity_type": "staff_member", "entity_id": uuid.uuid4(), "after": {"k": 1}},
        {"action": "a.b", "entity_type": "staff_member", "entity_id": uuid.uuid4()},
    ], ip_address="10.0.0.1")
    db.commit()
    rows = db.query(AuditLog).filter(AuditLog.action == "a.b").all()
    assert len(rows) == 2
    assert {r.ip_address for r in rows} == {"10.0.0.1"}
    assert all(str(r.actor_id) == str(owner.id) for r in rows)
