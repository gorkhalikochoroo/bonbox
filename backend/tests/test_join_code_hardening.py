"""
Join codes as onboarding tokens rather than standing credentials.

A join code is typed by a human off someone else's screen, so it is short — 6
characters — and short means the defences around it carry the weight. Before
this, a code was permanent and infinitely reusable: one written on a staff-room
whiteboard, photographed, or left in an old message thread opened the portal
years later. The portal now holds bank last-4 and employment documents.

The tests that matter:
  • a used code is dead, and an expired code is dead;
  • both are indistinguishable from a code that never existed — anything that
    confirms a code EXISTS is precisely what an enumerator is paying for;
  • codes minted before the change keep working, so nobody mid-onboarding
    loses a code they already shared because of a deploy.
"""

from datetime import timedelta

import pytest

from app.routers.staff import (
    JOIN_CODE_TTL_DAYS,
    _gen_join_code,
    _join_code_live,
    _JOIN_ALPHABET,
)
from app.utils.time import utc_now


class _Link:
    """Minimal stand-in for a StaffLink row."""

    def __init__(self, code="ABC234", used_at=None, expires_at=None):
        self.join_code = code
        self.code_used_at = used_at
        self.code_expires_at = expires_at


class TestCodeGeneration:
    def test_alphabet_excludes_the_confusable_pairs(self):
        # A staffer reads this off a manager's phone, so the alphabet drops
        # both halves of each classic mistype: O/0 and I/1.
        for ch in "O0I1":
            assert ch not in _JOIN_ALPHABET

    def test_l_is_kept_deliberately(self):
        # L survives, and that is correct rather than an oversight: L is only
        # confusable with 1, and 1 is already excluded — so nothing is left for
        # it to collide with. Documented so nobody "fixes" it and shrinks the
        # space to 31 for no gain.
        assert "L" in _JOIN_ALPHABET

    def test_alphabet_is_32_chars(self):
        # 32^6 ≈ 1.07e9. If someone shrinks this, the search space shrinks with
        # it and the rate limit silently becomes the only defence.
        assert len(_JOIN_ALPHABET) == 32

    def test_codes_are_six_chars_from_that_alphabet(self):
        for _ in range(50):
            c = _gen_join_code()
            assert len(c) == 6
            assert all(ch in _JOIN_ALPHABET for ch in c)

    def test_codes_do_not_repeat_in_a_small_sample(self):
        # Not a randomness proof — a canary for someone swapping secrets.choice
        # for something seeded or sequential.
        assert len({_gen_join_code() for _ in range(200)}) > 190


class TestLiveness:
    def test_a_fresh_code_is_live(self):
        link = _Link(expires_at=utc_now() + timedelta(days=1))
        assert _join_code_live(link) is True

    def test_a_used_code_is_dead(self):
        link = _Link(used_at=utc_now(), expires_at=utc_now() + timedelta(days=5))
        assert _join_code_live(link) is False

    def test_an_expired_code_is_dead(self):
        link = _Link(expires_at=utc_now() - timedelta(seconds=1))
        assert _join_code_live(link) is False

    def test_expiry_is_exclusive_at_the_boundary(self):
        # A code expiring exactly now is spent, not live.
        link = _Link(expires_at=utc_now())
        assert _join_code_live(link) is False

    def test_no_code_is_not_live(self):
        assert _join_code_live(_Link(code=None)) is False

    def test_a_legacy_code_without_expiry_still_works(self):
        # Rows minted before migration 072 have no stamp. Treating them as dead
        # would break an owner mid-onboarding on the deploy that shipped this.
        link = _Link(expires_at=None)
        assert _join_code_live(link) is True

    def test_a_legacy_code_that_was_used_is_still_dead(self):
        # No expiry, but redeemed — single-use wins over the legacy grace.
        link = _Link(used_at=utc_now(), expires_at=None)
        assert _join_code_live(link) is False

    def test_ttl_is_days_not_months(self):
        # The point is that a photographed code goes stale. A long TTL quietly
        # undoes that; this fails loudly if someone widens it.
        assert 1 <= JOIN_CODE_TTL_DAYS <= 14


class TestFailuresAreIndistinguishable:
    """Every rejection path must look identical from outside.

    A different status, message or latency for "expired" vs "unknown" confirms
    the code EXISTED — which is the one bit of information a brute-forcer is
    actually buying.
    """

    def test_router_returns_the_same_detail_for_every_failure(self):
        import inspect as _inspect

        from app.routers import staff_portal

        src = _inspect.getsource(staff_portal.portal_join)
        # Count the rejection sites and assert they are all the same 404 + text.
        raises = [ln for ln in src.splitlines() if "HTTPException" in ln]
        assert len(raises) >= 4, "expected malformed / unknown / used / expired"
        for ln in raises:
            assert "404" in ln
        details = [ln for ln in src.splitlines() if "detail=" in ln and "Ukendt" in ln]
        assert len(details) == len(raises), "a rejection path uses different copy"

    def test_no_rejection_path_leaks_a_reason_to_the_client(self):
        import inspect as _inspect

        from app.routers import staff_portal

        src = _inspect.getsource(staff_portal.portal_join)
        for leak in ("expired", "already used", "udløbet", "brugt"):
            # These words may appear in COMMENTS, never in a response body.
            for ln in src.splitlines():
                if "detail=" in ln:
                    assert leak.lower() not in ln.lower()
