"""Gavekort (gift card) + its append-only transaction ledger.

The gavekort slice: an owner ISSUES a gift card for a face value, the
card is TRACKED (issued / redeemed / outstanding), and staff REDEEM it
against a sale. DK terminology lock: "gavekort" stays Danish in every UI
language.

Two tables, one invariant:

  • GiftCard            — the card itself. Holds the current `balance_minor`
                          (a CACHE) plus its identity (code_hash, short_code,
                          code_last4), face value, voucher_class, status, and
                          lifecycle timestamps.
  • GiftCardTransaction — the append-only LEDGER. Source of truth. Every
                          issue / redeem / void writes exactly one row.
                          `GiftCard.balance_minor` must always equal
                          face_value_minor + SUM(amount_minor over ledger
                          rows AFTER the issue row) — i.e. the running
                          balance the ledger reconciles to on every write.

MONEY IS INTEGER ØRE everywhere. No floats. The frontend rounds to da-DK
"kr." for display only.

SECURITY — the plaintext code is NEVER stored. We store only:
  • code_hash  = HMAC-SHA256(code, GAVEKORT_SIGNING_KEY) — UNIQUE, the
                 lookup key for a scanned/typed code.
  • short_code = "GK-XXXX-XXXX-C" with a mod-37 check char — UNIQUE, the
                 human-readable handle shown in the owner list.
  • code_last4 = last 4 chars of the high-entropy code, for a "…AB3K"
                 disambiguation hint. Not secret on its own.

REDEEM is DB-enforced single-spend via a CONDITIONAL ATOMIC decrement
(see app/routers/gavekort.py) — never select-then-update. The ledger's
UNIQUE(gift_card_id, idempotency_key) makes a replayed redeem return the
ORIGINAL result, never a second debit.

Soft-delete is intentionally ABSENT: a gavekort is never deleted — it is
VOIDED (status='voided' + a compensating ledger row), preserving the full
transaktionsspor. Mirrors the canonical CREATE TABLE in
app/main.py::_run_migrations() (Migration 027 block) + the
documentation-only alembic 022.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    String, Integer, DateTime, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


# Lifecycle statuses. 'active' = redeemable. 'redeemed' = balance hit 0.
# 'expired' = past expires_at (resolved lazily on read/redeem). 'voided' =
# owner cancelled the card (a compensating ledger row zeroed the balance).
GIFT_CARD_STATUSES = ("active", "redeemed", "expired", "voided")

# Voucher classes. NEVER auto-decided — default "mpv", owner-set, surfaced.
#   mpv = multi-purpose voucher (redeemable against anything).
#   spv = single-purpose voucher (redeemable against one VAT-defined good).
# This slice records the class for later (MOMS-aware) handling but does NOT
# wire it into any tax math — see the daily-close honesty gate.
VOUCHER_CLASSES = ("mpv", "spv")


class GiftCard(Base):
    """A gavekort issued by an owner, tracked by its balance + ledger."""

    __tablename__ = "gift_cards"
    __table_args__ = (
        # Tenant + status is the owner-list query shape.
        Index("ix_gift_cards_user_status", "user_id", "status"),
        # code_hash is the lookup key for a scanned/typed code; UNIQUE so a
        # code maps to exactly one card across the whole platform.
        UniqueConstraint("code_hash", name="uq_gift_cards_code_hash"),
        # short_code is the human handle; UNIQUE so the owner never sees two
        # cards with the same "GK-XXXX-XXXX-C".
        UniqueConstraint("short_code", name="uq_gift_cards_short_code"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Denormalized tenant key — every query filters by this, and the redeem
    # UPDATE's WHERE clause re-checks it (defense-in-depth tenant isolation).
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True, nullable=False)

    # ── Identity (NEVER the plaintext code) ───────────────────────────
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)      # HMAC-SHA256 hex
    short_code: Mapped[str] = mapped_column(String(20), nullable=False)     # GK-XXXX-XXXX-C
    code_last4: Mapped[str] = mapped_column(String(4), nullable=False)

    # ── Money (integer øre) ───────────────────────────────────────────
    # The original loaded amount. Immutable after issue.
    face_value_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    # The current spendable balance — a CACHE reconciled to the ledger on
    # every write. The conditional atomic decrement mutates THIS column.
    balance_minor: Mapped[int] = mapped_column(Integer, nullable=False)

    # ── Classification + lifecycle ────────────────────────────────────
    voucher_class: Mapped[str] = mapped_column(String(8), nullable=False, default="mpv")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active")

    recipient_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(String(280), nullable=True)

    issued_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<GiftCard {self.short_code} {self.balance_minor}/{self.face_value_minor}øre {self.status}>"


class GiftCardTransaction(Base):
    """One append-only ledger row per issue / redeem / void.

    The ledger is the SOURCE OF TRUTH; GiftCard.balance_minor is a cache
    that must always equal face_value_minor + SUM of every ledger row's
    `amount_minor` placed AFTER the issue row. `amount_minor` is SIGNED:
      • issue  → +face_value (or 0; the issue row is the anchor)
      • redeem → NEGATIVE (a debit)
      • void   → NEGATIVE compensating row that zeroes the remaining balance

    `balance_after_minor` snapshots the card balance immediately after this
    row was applied — so the ledger is self-verifying without re-summing.

    Idempotency: UNIQUE(gift_card_id, idempotency_key). A replayed redeem
    with the same key hits the conflict and the router returns the ORIGINAL
    row's result — never a second debit.
    """

    __tablename__ = "gift_card_transactions"
    __table_args__ = (
        Index("ix_gift_card_tx_card_created", "gift_card_id", "created_at"),
        Index("ix_gift_card_tx_user", "user_id"),
        # The idempotency guard. A redeem replay (same card + same key) can
        # never insert a second debit. NULL idempotency_key (issue / void
        # rows) is exempt — SQL UNIQUE treats NULLs as distinct, which is
        # exactly what we want (only redeems carry a key).
        UniqueConstraint("gift_card_id", "idempotency_key", name="uq_gift_card_tx_idem"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    gift_card_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("gift_cards.id"), index=True, nullable=False,
    )
    # Denormalized tenant key — lets the ledger be queried/audited per-tenant
    # without a join, and re-asserts isolation on every ledger read.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True, nullable=False)

    # 'issue' | 'redeem' | 'void'.
    kind: Mapped[str] = mapped_column(String(12), nullable=False)

    # SIGNED integer øre — see class docstring.
    amount_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    # Card balance immediately AFTER this row applied (integer øre).
    balance_after_minor: Mapped[int] = mapped_column(Integer, nullable=False)

    # ── Transaktionsspor — the LINK fields ────────────────────────────
    # Who performed the action (staff member who scanned, owner who voided).
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True,
    )
    # Free-text reference to the sale this redemption paid toward.
    sale_ref: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Nullable FK-ish ref to a daily_close this redemption rolls into. NOT
    # wired into MOMS in this slice — recorded so it can be later.
    daily_close_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)
    # DK business day (06:00 cutoff) the redemption belongs to.
    business_day: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # The idempotency key the redeem caller supplied. NULL for issue/void.
    idempotency_key: Mapped[str | None] = mapped_column(String(120), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    def __repr__(self) -> str:
        return f"<GiftCardTransaction {self.kind} {self.amount_minor}øre →{self.balance_after_minor}>"
