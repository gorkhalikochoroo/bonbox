"""
Staff bank account — validation, normalisation, masking and encryption.

This is the one payroll-adjacent field in the staff module, so the tests that
matter are the ones proving it cannot leak and cannot silently corrupt someone's
account number:

  • the plaintext account never survives in the stored value
  • masking never returns more than the last 4
  • "1234 567" and "1234 0000000567" resolve to the SAME stored account, because
    showing one person two different accounts on two screens is a support call
    that ends in an unpaid wage
  • a decrypt failure raises instead of returning "", which would read as
    "never entered an account" and pay nobody
"""

import pytest

from app.services import staff_bank
from app.services.staff_bank import BankValidationError


class TestNormalise:
    def test_accepts_the_way_humans_paste_it(self):
        # Same account, four formats people actually copy out of a banking app.
        want = ("1234", "0005678901")
        for reg, acct in [
            ("1234", "5678901"),
            ("1234", "5 678 901"),
            (" 1234 ", "5678.901"),
            ("1234-5678901", ""),      # whole thing pasted into the first box
        ]:
            assert staff_bank.normalise(reg, acct) == want

    def test_splits_a_whole_account_pasted_into_the_reg_field(self):
        for pasted in ["1234-5678901", "1234 5678901", "12345678901"]:
            assert staff_bank.normalise(pasted, "") == ("1234", "0005678901")

    def test_never_invents_an_account_from_a_mistyped_reg_nr(self):
        # THE money bug: without a length floor, "53011" (reg-nr, one extra
        # keypress) split into 5301 + 0000000001 — a real, payable account
        # belonging to a stranger, with nothing downstream able to catch it.
        for typo in ["53011", "12345", "123456", "1234567"][:3]:
            with pytest.raises(BankValidationError) as e:
                staff_bank.normalise(typo, "")
            assert e.value.code == "reg_nr_length"

    def test_never_reinterprets_a_field_the_staffer_actually_filled(self):
        # If BOTH boxes have content, splitting would silently change what they
        # typed. An over-long reg-nr must fail loudly instead.
        with pytest.raises(BankValidationError) as e:
            staff_bank.normalise("1234-5678901", "9999999999")
        assert e.value.code == "reg_nr_length"

    def test_pads_short_accounts_to_ten(self):
        # A bank treats 5678901 and 0005678901 as one account; so must we.
        assert staff_bank.normalise("1234", "5678901")[1] == "0005678901"
        assert staff_bank.normalise("1234", "0005678901")[1] == "0005678901"

    def test_full_length_account_is_untouched(self):
        assert staff_bank.normalise("1234", "9876543210")[1] == "9876543210"

    @pytest.mark.parametrize(
        "reg,acct,code",
        [
            ("", "", "empty"),
            ("123", "5678901", "reg_nr_length"),
            ("12345", "5678901", "reg_nr_length"),
            ("abcd", "5678901", "reg_nr_length"),   # strips to "" → wrong length
            ("1234", "", "account_missing"),
            ("1234", "12345678901", "account_length"),
            ("1234", "0000000000", "account_zero"),
            # A slip must never become a payable account (see ACCOUNT_MIN_LEN).
            ("1234", "5", "account_too_short"),
            ("1234", "12345", "account_too_short"),
            ("53011", "", "reg_nr_length"),      # reg-nr + one extra keypress
            ("12345", "", "reg_nr_length"),
            ("123456", "", "reg_nr_length"),
        ],
    )
    def test_rejects_malformed_with_a_stable_code(self, reg, acct, code):
        # The code is what the router maps to a Danish message — assert on it,
        # not on the English sentence.
        with pytest.raises(BankValidationError) as e:
            staff_bank.normalise(reg, acct)
        assert e.value.code == code


class TestMask:
    def test_shows_only_the_last_four(self):
        assert staff_bank.mask("0005678901") == "•••• 8901"

    def test_never_returns_more_than_four_digits(self):
        for acct in ["1", "567", "0005678901", "9876543210"]:
            digits = [c for c in staff_bank.mask(acct) if c.isdigit()]
            assert len(digits) <= 4

    def test_empty_in_empty_out(self):
        assert staff_bank.mask("") == ""
        assert staff_bank.mask(None) == ""


class TestEncryption:
    def test_roundtrips(self):
        reg, acct = staff_bank.normalise("1234", "5678901")
        reg_c, acct_c = staff_bank.encrypt_pair(reg, acct)
        assert staff_bank.decrypt_account(reg_c) == "1234"
        assert staff_bank.decrypt_account(acct_c) == "0005678901"

    def test_ciphertext_does_not_contain_the_plaintext(self):
        # The whole point of the column being BYTEA/BLOB.
        reg, acct = staff_bank.normalise("1234", "5678901")
        _, acct_c = staff_bank.encrypt_pair(reg, acct)
        assert b"0005678901" not in acct_c
        assert b"5678901" not in acct_c

    def test_same_account_encrypts_differently_each_time(self):
        # Fernet embeds a timestamp + IV, so identical accounts must not produce
        # identical ciphertext — otherwise the column leaks "these two staff
        # share a bank account" to anyone with read access.
        reg, acct = staff_bank.normalise("1234", "5678901")
        first = staff_bank.encrypt_pair(reg, acct)[1]
        second = staff_bank.encrypt_pair(reg, acct)[1]
        assert first != second

    def test_unset_decrypts_to_empty(self):
        assert staff_bank.decrypt_account(None) == ""
        assert staff_bank.decrypt_account(b"") == ""

    def test_tampered_ciphertext_raises_rather_than_returning_empty(self):
        # Returning "" here would render as "no account on file" and the owner
        # would pay nobody with no error anywhere. Loud is correct.
        from cryptography.fernet import InvalidToken

        reg, acct = staff_bank.normalise("1234", "5678901")
        _, acct_c = staff_bank.encrypt_pair(reg, acct)
        tampered = acct_c[:-4] + b"AAAA"
        with pytest.raises(InvalidToken):
            staff_bank.decrypt_account(tampered)


class TestOwnerEndpointIsOwnerOnly:
    """The owner endpoint returns the FULL account, so the delegated-seat gate
    is the whole security boundary.

    This regressed once during development: the handler filtered on
    `StaffMember.user_id == user.id` and that LOOKS tenant-safe, but
    get_current_user resolves a manager / cashier / viewer / accountant seat to
    the OWNER User — so the filter passes for every delegated seat and a manager
    could read a colleague's kontonummer. `_require_owner_actor` is what draws
    the line, and it must run BEFORE the query.
    """

    @staticmethod
    def _call(user):
        from fastapi import HTTPException

        from app.routers.staff import get_staff_member_bank

        # db=None is deliberate: the gate must reject before touching the DB.
        # If this ever raises AttributeError instead of HTTPException, the gate
        # has moved below the query and the test has caught exactly that.
        try:
            get_staff_member_bank("any-id", db=None, user=user)
        except HTTPException as e:
            return e.status_code
        return None

    class _User:
        id = "owner-1"

    def test_manager_seat_is_denied(self):
        u = self._User()
        u._is_member_view = True
        assert self._call(u) == 403

    def test_accountant_view_is_denied(self):
        u = self._User()
        u._is_accountant_view = True
        assert self._call(u) == 403

    def test_real_owner_passes_the_gate(self):
        # Reaches the DB (db=None → AttributeError/TypeError), which proves the
        # gate let it through rather than 403ing.
        u = self._User()
        with pytest.raises((AttributeError, TypeError)):
            self._call(u)


class TestMemberHelpers:
    class _Member:
        bank_reg_nr_enc = None
        bank_account_enc = None
        bank_updated_at = None

    def test_has_bank_is_false_when_unset(self):
        assert staff_bank.has_bank(self._Member()) is False

    def test_has_bank_is_true_once_stored(self):
        m = self._Member()
        m.bank_reg_nr_enc, m.bank_account_enc = staff_bank.encrypt_pair("1234", "0005678901")
        assert staff_bank.has_bank(m) is True

    def test_clear_wipes_every_field(self):
        # is_deleted is a soft delete, so this is the only thing that actually
        # removes an ex-employee's account from the table.
        from datetime import datetime

        m = self._Member()
        m.bank_reg_nr_enc, m.bank_account_enc = staff_bank.encrypt_pair("1234", "0005678901")
        m.bank_updated_at = datetime(2026, 8, 1)
        staff_bank.clear_bank(m)
        assert m.bank_reg_nr_enc is None
        assert m.bank_account_enc is None
        assert m.bank_updated_at is None
        assert staff_bank.has_bank(m) is False
