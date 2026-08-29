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
from app.main import (
    _MANAGER_READ_DENY_PREFIXES,
    _MEMBER_READ_DENY_PREFIXES,
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

    def test_manager_keeps_the_wage_cost_estimate(self):
        # Deliberate: the manager set is the member set MINUS payroll, because
        # a manager builds the rota and needs the wage-cost estimate.
        assert "/api/staff/payroll" not in _MANAGER_READ_DENY_PREFIXES
        assert "/api/staff/payroll" in _MEMBER_READ_DENY_PREFIXES


class TestManagerIsASubsetOfMember:
    def test_every_manager_denied_prefix_is_also_member_denied(self):
        """main.py screens the UNION on the fast path before any DB lookup.
        A manager-only prefix would slip past it."""
        extra = set(_MANAGER_READ_DENY_PREFIXES) - set(_MEMBER_READ_DENY_PREFIXES)
        assert not extra, f"manager-denied but member-allowed: {sorted(extra)}"

    def test_a_non_financial_path_is_not_swept_up(self):
        # The guard must stay narrow — a member's ordinary work must not 403.
        for ok in ("/api/sales", "/api/staff/hours", "/api/dashboard/summary", "/api/reservations"):
            assert _is_sensitive_member_read_path(ok) is False, ok
