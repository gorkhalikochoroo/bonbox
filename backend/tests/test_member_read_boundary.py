"""Which owner-financial prefixes a delegated seat may NOT read.

These pin a boundary that a role audit found open in two places at once, and
both were the same shape: a surface everyone ASSUMED was owner-only because
the UI never offered it, while the endpoint answered anyone with a token.

  • /api/exports is the bookkeeping export — every sale and every expense for
    the period, in Dinero / Billy / e-conomic format. routers/exports.py gates
    it on the custom_export_templates TIER only; its own "Multi-layer defense"
    comment lists tier, format validation, date bounds and range cap, and no
    role layer at all. It was in neither deny-list, so a cashier on Starter
    could download the whole ledger — one tap from "Send til revisor" in their
    own More menu.

  • The manager list additionally feeds _SHARED_DEVICE_DENY_PREFIXES, so the
    same gap meant "Delt enhed" hid the revenue hero on a handed-over tablet
    while the full ledger stayed one tap away.

The subset invariant is asserted here too, because main.py's fast path
(_is_sensitive_member_read_path) screens the UNION before any DB lookup — if
manager ever gained a prefix members lack, that path would stop catching it
and the guard would silently weaken.
"""
import app.main as _main
from app.main import (
    _MANAGER_READ_DENY_PREFIXES,
    _MEMBER_READ_DENY_PREFIXES,
    _SHARED_DEVICE_DENY_PREFIXES,
    _is_manager_denied_path,
    _is_sensitive_member_read_path,
)


class TestTheBooksAreOwnerOnly:
    def test_exports_is_denied_to_members(self):
        assert "/api/exports" in _MEMBER_READ_DENY_PREFIXES

    def test_exports_is_denied_to_managers_too(self):
        # A shift manager has no more business exporting the books than a
        # cashier does — and this list is what the shared-device curtain reuses.
        assert "/api/exports" in _MANAGER_READ_DENY_PREFIXES

    def test_a_real_export_url_is_classified_sensitive(self):
        # The guard matches on prefix, so the concrete URL must be caught, not
        # just the bare prefix string.
        assert _is_sensitive_member_read_path("/api/exports/dinero") is True
        assert _is_sensitive_member_read_path("/api/exports/e-conomic?start=2026-01-01") is True


class TestTheOwnerFinancialCornerStaysShut:
    """The prefixes that were already right. Here so a future edit that
    'tidies' the list has to do it on purpose."""

    def test_member_denied_the_documented_set(self):
        for prefix in (
            "/api/staff/payroll",
            "/api/tax",
            "/api/bank-connect",
            "/api/bank-connections",
            "/api/bank-import",
            "/api/cashflow",
            "/api/reports",
        ):
            assert prefix in _MEMBER_READ_DENY_PREFIXES, prefix

    def test_payroll_stays_denied_to_low_privilege_members(self):
        assert "/api/staff/payroll" in _MEMBER_READ_DENY_PREFIXES


class TestPayrollIsOwnerOnly:
    """The manager payroll exemption is GONE (Manoj, 18 Sep 2026).

    It was wrong twice. First in SCOPE: written for "the wage-cost estimate" —
    singular, and there is literally a /payroll/estimate route — but expressed
    as "omit /api/staff/payroll from the deny list", which also handed over
    /payroll/csv and /payroll/loenseddel: every colleague's payslip PDF, with
    net_pay, am_bidrag, a_skat and the tax-card type and rate. That was fixed by
    inverting to deny-by-default plus a one-route allow-list.

    Then in SUBSTANCE: the one route left was not the aggregate it was defended
    as. /payroll/estimate returns per-person gross + AM-bidrag + A-skat + ATP +
    feriepenge, so gross ÷ hours is a named colleague's hourly rate — the very
    figure the wage-privacy block hides everywhere else. A manager reached it
    from the Løn tab of /staff/hours, which is not an ownerOnly destination.

    So: the whole prefix, every role. The allow-list mechanism is deleted
    rather than emptied to (), so re-opening costs a deliberate re-write.
    """

    def test_the_payslip_pdf_is_denied(self):
        assert _is_manager_denied_path("/api/staff/payroll/loenseddel") is True

    def test_the_payroll_csv_is_denied(self):
        assert _is_manager_denied_path("/api/staff/payroll/csv") is True

    def test_the_wage_cost_estimate_is_denied_too(self):
        assert _is_manager_denied_path("/api/staff/payroll/estimate") is True

    def test_a_future_payroll_route_is_denied_by_default(self):
        # The point of the inversion — fail closed on the ones nobody has
        # thought about yet.
        assert _is_manager_denied_path("/api/staff/payroll/whatever-ships-next") is True

    def test_there_is_no_allow_list_to_widen(self):
        """Asserted by ABSENCE. `= ()` would keep a one-line path back in with
        no new reasoning attached, and reads as "nothing is restricted" above a
        deny list. The mechanism has to be re-written to be re-used."""
        assert not hasattr(_main, "_MANAGER_READ_ALLOW_PREFIXES")

    def test_denying_payroll_did_not_reopen_the_owner_financials(self):
        for denied in (
            "/api/tax/filing",
            "/api/bank-connect/start",
            "/api/cashflow",
            "/api/reports/monthly",
            "/api/exports/dinero",
        ):
            assert _is_manager_denied_path(denied) is True, denied

    def test_a_manager_still_reads_their_ordinary_work(self):
        for ok in ("/api/sales", "/api/staff/hours", "/api/reservations", "/api/dashboard/batch"):
            assert _is_manager_denied_path(ok) is False, ok

    def test_the_fast_path_still_screens_every_manager_denied_payroll_route(self):
        """main.py screens the MEMBER union before any DB lookup. If the payroll
        paths were not caught there, the manager branch would never be reached
        and this whole fix would be dead code."""
        for path in ("/api/staff/payroll/loenseddel", "/api/staff/payroll/csv"):
            assert _is_sensitive_member_read_path(path) is True, path


class TestTheCurtainedTabletHidesWageDataToo:
    """_SHARED_DEVICE_DENY_PREFIXES reuses the manager deny set. On a
    handed-over tablet the actor is the OWNER, so the reveal-PIN is the only
    gate, and colleagues' wage costs are exactly what it exists to hide."""

    def test_all_payroll_is_behind_the_pin_including_the_estimate(self):
        assert any(
            "/api/staff/payroll/estimate".startswith(p)
            for p in _SHARED_DEVICE_DENY_PREFIXES
        )


class TestManagerIsTheMemberSet:
    def test_the_two_deny_sets_are_the_same_set(self):
        """main.py screens the UNION on the fast path before any DB lookup, so
        a manager-only prefix would slip past it — and since the carve-out
        closed there is no difference left to express in the other direction
        either."""
        assert set(_MANAGER_READ_DENY_PREFIXES) == set(_MEMBER_READ_DENY_PREFIXES)

    def test_a_non_financial_path_is_not_swept_up(self):
        # The guard must stay narrow — a member's ordinary work must not 403.
        for ok in ("/api/sales", "/api/staff/hours", "/api/dashboard/summary", "/api/reservations"):
            assert _is_sensitive_member_read_path(ok) is False, ok
