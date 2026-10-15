"""
Bank reconciliation — match imported bank transactions to open
fakturaer + expenses, and let the owner confirm in bulk.

Why this layer exists on top of payment_match_service:
  • payment_match_service runs INLINE during CSV import (single Sale →
    single best-fit Invoice). It only fires for HIGH-confidence
    auto-matches and creates suggestions for the rest. It does NOT
    surface a unified review screen and does NOT handle expense
    reconciliation at all.
  • bank_reconciliation runs AFTER import, surfaces ranked candidates
    across BOTH income (Sale → Invoice) and outgoing (Expense ↔ Expense)
    sides, and exposes a bulk-confirm endpoint so the owner can review
    a whole month in one screen. Saves the 1-2 hours/month of manual
    reconciliation that's the original "I need bookkeeping" pain.

Tier: bank_auto_reconcile feature gates the suggestions + confirm
endpoints (Starter+). Free still gets the CSV import → Sale + Expense
flow exactly as before; only the value-add layer is paid.

Matching rules (per task #43):
  • amount tolerance: ±2.00 DKK
  • date tolerance:   ±7 days
  • ranking signals:  (a) exact amount, (b) Jaro-Winkler ≥ 0.7 on
                       counterparty name, (c) CVR or fakturanummer
                       literal in the description text
  • top 3 candidates per txn

Never auto-confirms. The confirm endpoint is the only writer.

Defensive layers:
  1. Auth     — get_current_user dependency on the router
  2. Tier     — has_feature(user, "bank_auto_reconcile")
  3. Tenant   — every query filters user_id explicitly + a tenant check
                on the resolved invoice/expense before any mutation
  4. Bounds   — caller-supplied lists capped via the Pydantic schema;
                this service double-checks UUID parsing
  5. Idempot. — mark_paid is already idempotent; link is also a no-op
                if the bank_txn was already linked to the same target
"""
from __future__ import annotations

import logging
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Iterable
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.expense import Expense, ExpenseCategory
from app.models.invoice import Invoice
from app.models.sale import Sale
from app.models.user import User
from app.services import audit_service
from app.services.invoice_service import InvoiceService
from app.services.voucher_service import format_voucher_number

logger = logging.getLogger("bonbox.bank_reconciliation")


# ─── Tunable constants ────────────────────────────────────────────────
AMOUNT_TOLERANCE_DKK = Decimal("2.00")
DATE_WINDOW_DAYS = 7
TOP_N_PER_TXN = 3
# How far back to look for "unmatched" bank rows when the caller passes
# the open-ended import_id='latest'. 90 days covers most use cases
# (monthly bookkeeping, quarterly Moms) without dragging in years of
# historical data per call. Bounded for performance + memory safety.
DEFAULT_LOOKBACK_DAYS = 90
# Jaro-Winkler threshold — 0.7 is generous enough to catch nicknames
# ("Karl's Kitchen" → "Karls Kitchen") but tight enough to reject most
# coincidental matches ("Lyngby Storkunde" vs "Lunar Money"). Tuned by
# spot-checking real Danish bank descriptions against real customer
# names during the build.
JARO_WINKLER_THRESHOLD = 0.7


# ─── Jaro-Winkler (hand-rolled, no external deps) ─────────────────────
#
# Lifted from the Wikipedia pseudo-code with the Winkler prefix boost.
# We could pull rapidfuzz but the standalone version is ~30 lines and
# avoids adding a transitive C-extension dep to the deployment bundle.
# Returns a float in [0, 1] where 1 = identical, 0 = completely different.

def _jaro(s1: str, s2: str) -> float:
    """Jaro similarity — the proportion of matching chars with
    transposition correction. O(n*m) but n,m are typically <40 chars
    so this is cheap."""
    if s1 == s2:
        return 1.0
    if not s1 or not s2:
        return 0.0

    len1, len2 = len(s1), len(s2)
    # Matching window — half the longer string minus 1
    match_distance = max(len1, len2) // 2 - 1
    if match_distance < 0:
        match_distance = 0

    s1_matches = [False] * len1
    s2_matches = [False] * len2
    matches = 0

    for i in range(len1):
        start = max(0, i - match_distance)
        end = min(i + match_distance + 1, len2)
        for j in range(start, end):
            if s2_matches[j]:
                continue
            if s1[i] != s2[j]:
                continue
            s1_matches[i] = True
            s2_matches[j] = True
            matches += 1
            break

    if matches == 0:
        return 0.0

    # Count transpositions (matching chars in wrong order)
    transpositions = 0
    k = 0
    for i in range(len1):
        if not s1_matches[i]:
            continue
        while not s2_matches[k]:
            k += 1
        if s1[i] != s2[k]:
            transpositions += 1
        k += 1
    transpositions //= 2

    return (
        matches / len1
        + matches / len2
        + (matches - transpositions) / matches
    ) / 3.0


def jaro_winkler(s1: str, s2: str, prefix_scale: float = 0.1) -> float:
    """Jaro-Winkler — Jaro with a small bonus for shared common prefix
    up to 4 chars. Standard prefix_scale=0.1 per Winkler 1990."""
    base = _jaro(s1, s2)
    if base == 0.0:
        return 0.0
    # Common prefix length (max 4)
    prefix = 0
    for a, b in zip(s1[:4], s2[:4]):
        if a == b:
            prefix += 1
        else:
            break
    return base + (prefix * prefix_scale * (1 - base))


def _strip_diacritics(s: str) -> str:
    """Danish banks emit ASCII-only descriptions (no æøå/é). Normalize
    both sides for fair comparison. Reuses the proven approach from
    payment_match_service."""
    if not s:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s)
        if not unicodedata.combining(c)
    )


def _normalize(s: str) -> str:
    """Lowercase + diacritic-strip + collapse whitespace. Used on both
    sides of a name comparison."""
    return " ".join(_strip_diacritics(s or "").lower().split())


# ─── Domain types ─────────────────────────────────────────────────────

@dataclass
class MatchSuggestion:
    """Internal representation. Converted to the Pydantic schema by the
    router before returning to the client."""
    txn_id: str
    txn_type: str           # "income" | "expense"
    target_type: str        # "invoice" | "expense"
    target_id: str
    target_label: str
    confidence: str         # "high" | "medium" | "low"
    amount_diff: float
    days_diff: int
    reason: str


@dataclass
class TxnWithSuggestions:
    txn_id: str
    txn_type: str
    txn_date: date
    amount: float
    description: str
    already_matched: bool
    suggestions: list[MatchSuggestion]
    # A bank expense line already linked to the expense it paid: which one
    # (the page shows it with an "undo" instead of suggestions).
    linked_target_id: str | None = None
    linked_target_label: str | None = None


# ─── Helpers: fetch bank-imported rows scoped to user ─────────────────

def _reference_prefix(import_id: str | None) -> str:
    """Build the SQL LIKE prefix for matching bank-import reference IDs.
    Bank-import rows use `reference_id = 'bank_<bank>_<hash>'`.

      import_id='latest' or None  → 'bank_%'   (all bank-imported rows)
      import_id='danske_bank'     → 'bank_danske_bank_%'

    The import_id is restricted to lowercase alphanumeric + underscore
    via the router; SQL injection would need to bypass that gate first
    AND survive SQLAlchemy's bound-param substitution. Defense-in-depth.
    """
    if not import_id or import_id == "latest":
        return "bank_%"
    # Whitelist enforcement is defensive — router already validates
    safe = "".join(c for c in import_id if c.isalnum() or c == "_")
    return f"bank_{safe}_%"


def _fetch_unmatched_sales(
    db: Session, user_id: UUID, import_id: str | None, lookback_days: int,
) -> list[Sale]:
    """Sales rows imported from bank CSV that aren't yet linked to an
    invoice. Tenant-scoped. Bounded by the lookback window so a hostile
    or sloppy client can't ask us to scan 5 years of history."""
    cutoff = date.today() - timedelta(days=lookback_days)
    prefix = _reference_prefix(import_id)
    return (
        db.query(Sale)
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.is_(False),
            Sale.reference_id.like(prefix),
            Sale.invoice_id.is_(None),  # not yet matched
            Sale.date >= cutoff,
        )
        .order_by(Sale.date.desc())
        # Hard ceiling — even with abuse we won't load >500 rows
        .limit(500)
        .all()
    )


def _fetch_open_invoices(
    db: Session, user_id: UUID, lookback_days: int,
) -> list[Invoice]:
    """Open (sent / overdue) invoices that aren't already paid.
    Tenant-scoped + bounded."""
    cutoff = date.today() - timedelta(days=lookback_days + DATE_WINDOW_DAYS)
    return (
        db.query(Invoice)
        .filter(
            Invoice.user_id == user_id,
            Invoice.status.in_(("sent", "overdue")),
            Invoice.is_credit_note.is_(False),
            Invoice.issue_date >= cutoff,
        )
        .order_by(Invoice.issue_date.desc())
        .limit(500)
        .all()
    )


def _fetch_bank_expenses(
    db: Session,
    user_id: UUID,
    import_id: str | None,
    lookback_days: int,
) -> list[Expense]:
    """Outgoing bank-imported rows. We treat each one as both the
    target side (existing bookkeeping expense to link to) AND the
    source side (the bank line itself). The auto-match for expenses
    looks for cases where the owner pre-recorded an expense (e.g. a
    cash receipt photo) and the bank line should be linked to it.

    For now we surface bank-imported expenses with an empty
    suggestion list — the dominant value is on the income side
    (Sale → Invoice), and expense-to-expense match is dedup-only.
    Future iteration can extend this to receipt-photo matching."""
    cutoff = date.today() - timedelta(days=lookback_days)
    prefix = _reference_prefix(import_id)
    return (
        db.query(Expense)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.is_(False),
            Expense.reference_id.like(prefix),
            Expense.date >= cutoff,
        )
        .order_by(Expense.date.desc())
        .limit(500)
        .all()
    )


def _fetch_open_expenses(
    db: Session, user_id: UUID, lookback_days: int,
) -> list[Expense]:
    """Non-bank-imported expenses (e.g. cash receipt photos, manual
    entries) that haven't been linked to a bank line yet. Tenant-scoped.

    Identification: reference_id is NULL or doesn't start with 'bank_'.
    These are the candidate targets to link a bank Expense to."""
    cutoff = date.today() - timedelta(days=lookback_days + DATE_WINDOW_DAYS)
    return (
        db.query(Expense)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.is_(False),
            or_(
                Expense.reference_id.is_(None),
                ~Expense.reference_id.like("bank_%"),
            ),
            Expense.date >= cutoff,
            ~_paid_by_a_bank_line(Expense.id, user_id),
        )
        .order_by(Expense.date.desc())
        .limit(500)
        .all()
    )


def _paid_by_a_bank_line(expense_id, user_id, *, other_than=None):
    """EXISTS: a live bank line of this owner is linked to `expense_id`
    (optionally: a bank line other than `other_than`)."""
    from sqlalchemy import exists
    from sqlalchemy.orm import aliased

    line = aliased(Expense)
    conds = [
        line.user_id == user_id,
        line.linked_expense_id == expense_id,
        line.is_deleted.isnot(True),
    ]
    if other_than is not None:
        conds.append(line.id != other_than)
    return exists().where(*conds)


# ─── Match scoring ────────────────────────────────────────────────────

def _score_invoice_candidate(
    txn: Sale, inv: Invoice, customer: Customer | None,
) -> tuple[str, str] | None:
    """Score a Sale against an open Invoice. Returns (confidence,
    reason) or None if outside tolerances.

    Confidence ladder (per task #43 spec):
      high   — amount within ±0.01 (exact) AND date within window AND
               counterparty/CVR/fakturanummer signal found in description
      medium — amount within ±0.01 (exact) AND date within window, no
               text signal
      low    — amount within ±2 DKK (tolerance) OR date within window
               but not both tight"""
    amount = Decimal(str(txn.amount))
    target = Decimal(str(inv.total_gross))
    amount_diff = abs(amount - target)
    if amount_diff > AMOUNT_TOLERANCE_DKK:
        return None

    days_diff = abs((txn.date - inv.issue_date).days)
    if days_diff > DATE_WINDOW_DAYS:
        return None

    # Text signals
    desc_norm = _normalize(txn.notes or "")
    fakturanummer_str = format_voucher_number(
        "invoice", inv.issue_date.year, inv.fakturanummer
    )
    has_invoice_num = fakturanummer_str.lower() in desc_norm
    has_cvr = bool(
        customer and customer.cvr
        and customer.cvr in desc_norm.replace(" ", "")
    )
    # Name match — Jaro-Winkler over normalized strings
    name_match = False
    if customer and customer.name:
        cust_norm = _normalize(customer.name)
        if cust_norm:
            # Either substring (cheap) or fuzzy (handles "Lyngby ApS" vs
            # "LYNGBY STORKUNDE")
            if cust_norm[:8] in desc_norm:
                name_match = True
            else:
                # Token-by-token Jaro-Winkler — compares each word in
                # the customer name to each word in the description and
                # takes the best ratio. Two-token check ("Cafe Lyngby"
                # vs "PAYMENT FROM CAFE LYNGBY 25/03") is forgiving.
                cust_tokens = [t for t in cust_norm.split() if len(t) >= 4]
                desc_tokens = [t for t in desc_norm.split() if len(t) >= 4]
                for ct in cust_tokens:
                    for dt in desc_tokens:
                        if jaro_winkler(ct, dt) >= JARO_WINKLER_THRESHOLD:
                            name_match = True
                            break
                    if name_match:
                        break

    has_text_signal = has_invoice_num or has_cvr or name_match
    is_exact_amount = amount_diff <= Decimal("0.01")
    is_close_date = days_diff <= 1

    if is_exact_amount and is_close_date and has_text_signal:
        if has_invoice_num:
            return ("high", f"Fakturanummer {fakturanummer_str} in bank text")
        if has_cvr:
            return ("high", f"CVR {customer.cvr} in bank text")
        return ("high", f"Counterparty name '{customer.name[:24]}' matched")

    if is_exact_amount and is_close_date:
        return ("medium", f"Amount + date match (no text confirmation)")

    if is_exact_amount or has_text_signal:
        return ("low", "Partial match — amount or text signal only")

    return ("low", f"Within tolerance ({amount_diff} DKK, {days_diff}d)")


def _confidence_order(c: str) -> int:
    """Map confidence label → sort key. Higher = better."""
    return {"high": 3, "medium": 2, "low": 1}.get(c, 0)


# ─── Public API ───────────────────────────────────────────────────────

def match_transactions(
    db: Session,
    user_id: UUID,
    import_id: str | None = "latest",
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> list[TxnWithSuggestions]:
    """Find match suggestions for all unmatched bank-imported rows.

    Returns a list of TxnWithSuggestions, one per bank transaction,
    sorted newest-first. Each entry's `suggestions` holds up to
    TOP_N_PER_TXN candidates ranked by (confidence, smaller amount_diff,
    smaller days_diff).

    Tenant-scoped via user_id on every query. Never raises — exceptions
    inside per-txn scoring are swallowed so one bad row doesn't kill
    the whole pass.

    Args:
      import_id: a token identifying which bank import to reconcile.
        'latest' (default) or None → all bank-imported rows.
        Specific bank id (e.g. 'danske_bank') → only that bank's rows.
      lookback_days: cap the search window. Defensive bound; the router
        clamps user input before passing here.
    """
    # Clamp lookback to a sane range
    lookback_days = max(7, min(lookback_days, 366))

    sales = _fetch_unmatched_sales(db, user_id, import_id, lookback_days)
    expenses = _fetch_bank_expenses(db, user_id, import_id, lookback_days)
    open_invoices = _fetch_open_invoices(db, user_id, lookback_days)

    # Pre-fetch customers for all invoices in one query
    customer_ids = {inv.customer_id for inv in open_invoices}
    customers: dict[UUID, Customer] = {}
    if customer_ids:
        for c in (
            db.query(Customer)
            .filter(
                Customer.id.in_(customer_ids),
                Customer.user_id == user_id,  # tenant scope on the join
            )
            .all()
        ):
            customers[c.id] = c

    out: list[TxnWithSuggestions] = []

    # ── Income side: Sale → Invoice ──
    for sale in sales:
        try:
            cands: list[MatchSuggestion] = []
            for inv in open_invoices:
                customer = customers.get(inv.customer_id)
                score = _score_invoice_candidate(sale, inv, customer)
                if not score:
                    continue
                confidence, reason = score
                amount_diff = abs(float(sale.amount) - float(inv.total_gross))
                days_diff = abs((sale.date - inv.issue_date).days)
                label = (
                    f"Faktura {format_voucher_number('invoice', inv.issue_date.year, inv.fakturanummer)}"
                )
                if customer:
                    label += f" — {customer.name}"
                cands.append(MatchSuggestion(
                    txn_id=str(sale.id),
                    txn_type="income",
                    target_type="invoice",
                    target_id=str(inv.id),
                    target_label=label,
                    confidence=confidence,
                    amount_diff=round(amount_diff, 2),
                    days_diff=days_diff,
                    reason=reason,
                ))
            # Rank: confidence DESC, amount_diff ASC, days_diff ASC
            cands.sort(
                key=lambda s: (-_confidence_order(s.confidence), s.amount_diff, s.days_diff)
            )
            out.append(TxnWithSuggestions(
                txn_id=str(sale.id),
                txn_type="income",
                txn_date=sale.date,
                amount=float(sale.amount),
                description=sale.notes or "",
                already_matched=False,
                suggestions=cands[:TOP_N_PER_TXN],
            ))
        except Exception:
            logger.exception(
                "bank_reconciliation.score_sale_failed user=%s sale=%s",
                user_id, sale.id,
            )
            continue

    # ── Outgoing side: bank Expense — surface for review, no
    # heavy matching yet (expense-to-expense is a future feature).
    # Critical to surface them so the owner sees ALL their imported
    # rows in the reconciliation table, even if no candidate exists.
    open_expenses = _fetch_open_expenses(db, user_id, lookback_days)
    linked_ids = {e.linked_expense_id for e in expenses if getattr(e, "linked_expense_id", None)}
    linked_targets: dict = {}
    if linked_ids:
        for t in (
            db.query(Expense)
            .filter(Expense.user_id == user_id, Expense.id.in_(linked_ids))
            .all()
        ):
            linked_targets[t.id] = t
    for exp in expenses:
        linked_to = linked_targets.get(getattr(exp, "linked_expense_id", None))
        if linked_to is not None:
            # Already linked: shown with the expense it paid (and an undo on
            # the page), never offered new suggestions.
            out.append(TxnWithSuggestions(
                txn_id=str(exp.id),
                txn_type="expense",
                txn_date=exp.date,
                amount=float(exp.amount),
                description=exp.description or "",
                already_matched=True,
                suggestions=[],
                linked_target_id=str(linked_to.id),
                # The expense's own words; the page writes the sentence
                # around them in its language ("Koblet til …").
                linked_target_label=(linked_to.description or "")[:60] or None,
            ))
            continue
        try:
            cands: list[MatchSuggestion] = []
            # Simple expense ↔ expense match: same amount within
            # tolerance, date within window. Used when the owner
            # pre-recorded a cash receipt via Snap Receipt and the
            # bank line should be linked to it.
            for target in open_expenses:
                if target.id == exp.id:
                    continue
                amount_diff = abs(float(exp.amount) - float(target.amount))
                if amount_diff > float(AMOUNT_TOLERANCE_DKK):
                    continue
                days_diff = abs((exp.date - target.date).days)
                if days_diff > DATE_WINDOW_DAYS:
                    continue
                is_exact = amount_diff <= 0.01
                is_close_date = days_diff <= 1
                if is_exact and is_close_date:
                    confidence = "medium"
                    reason = "Amount + date match — likely the same payment"
                elif is_exact:
                    confidence = "low"
                    reason = f"Same amount, {days_diff}d apart"
                else:
                    confidence = "low"
                    reason = f"Within ±{AMOUNT_TOLERANCE_DKK} DKK"
                label = (
                    f"Expense — {target.description[:32]}"
                    if target.description else "Expense"
                )
                cands.append(MatchSuggestion(
                    txn_id=str(exp.id),
                    txn_type="expense",
                    target_type="expense",
                    target_id=str(target.id),
                    target_label=label,
                    confidence=confidence,
                    amount_diff=round(amount_diff, 2),
                    days_diff=days_diff,
                    reason=reason,
                ))
            cands.sort(
                key=lambda s: (-_confidence_order(s.confidence), s.amount_diff, s.days_diff)
            )
            out.append(TxnWithSuggestions(
                txn_id=str(exp.id),
                txn_type="expense",
                txn_date=exp.date,
                amount=float(exp.amount),
                description=exp.description or "",
                already_matched=False,
                suggestions=cands[:TOP_N_PER_TXN],
            ))
        except Exception:
            logger.exception(
                "bank_reconciliation.score_expense_failed user=%s expense=%s",
                user_id, exp.id,
            )
            continue

    # Sort the whole output by date DESC, txn_type so the UI shows
    # the most-recent rows at the top.
    out.sort(key=lambda r: (r.txn_date, r.txn_type), reverse=True)
    return out


# ─── Confirmation pipeline ────────────────────────────────────────────

def _parse_uuid(s: str) -> UUID | None:
    """Defensive UUID parse — never raise; return None for the caller
    to bump the `errors` counter and move on."""
    try:
        return UUID(str(s))
    except (ValueError, TypeError, AttributeError):
        return None


# The link guards' codes (confirm_matches → error_codes). The page words each
# one in the owner's language (BankImportPage RECON_ERROR_KEYS, da + en); the
# English message stays in `errors` for logs and older clients.
ERROR_CODES = frozenset({
    "not_a_bank_line",
    "target_is_a_bank_line",
    "bank_line_linked_elsewhere",
    "expense_paid_by_another_bank_line",
})


def confirm_matches(
    db: Session,
    user: User,
    matches: Iterable[dict],
    *,
    ip_address: str | None = None,
) -> dict:
    """Apply a batch of owner-confirmed matches.

    Each `matches` item must be a dict with keys:
      txn_id      — bank Sale/Expense row id
      target_type — "invoice" | "expense"
      target_id   — Invoice/Expense to apply the action to
      action      — "mark_paid" | "link" | "unlink"

    Mutations:
      invoice + mark_paid → InvoiceService.mark_paid(source='bank_csv')
                            + Sale.invoice_id = target.id
      expense + link      → bank Expense.linked_expense_id = target.id (the
                            bank line then counts in no money total while
                            the target is live; nothing deleted) + the
                            "[linked:…]" notes marker
      expense + unlink    → clears both; the bank line counts again

    Writes one audit row per applied confirmation. Tenant-scoped via the
    User dependency + per-row ownership re-check (defense-in-depth).

    Returns: {"confirmed": N, "skipped": N, "errors": [str, ...],
              "error_codes": [str, ...]}
    error_codes is aligned 1:1 with errors: a stable code for the link
    guards the page words in Danish and English (ERROR_CODES), "" for
    every other message.

    Caller (router) commits the transaction after this returns.
    """
    confirmed = 0
    skipped = 0
    errors: list[str] = []
    coded: dict[int, str] = {}  # index in errors -> ERROR_CODES entry

    def _guard(code: str, message: str) -> None:
        coded[len(errors)] = code
        errors.append(message)

    for raw in matches:
        try:
            txn_id_raw = raw.get("txn_id") if isinstance(raw, dict) else getattr(raw, "txn_id", None)
            target_type = raw.get("target_type") if isinstance(raw, dict) else getattr(raw, "target_type", None)
            target_id_raw = raw.get("target_id") if isinstance(raw, dict) else getattr(raw, "target_id", None)
            action = raw.get("action") if isinstance(raw, dict) else getattr(raw, "action", None)

            txn_id = _parse_uuid(txn_id_raw)
            target_id = _parse_uuid(target_id_raw)
            if not (txn_id and target_id and target_type in ("invoice", "expense")
                    and action in ("mark_paid", "link", "unlink")):
                errors.append(f"invalid match: {txn_id_raw} → {target_id_raw}")
                continue

            if target_type == "invoice" and action == "mark_paid":
                # Defense: re-fetch the Sale with tenant scope; the
                # txn_id arrived from the client. Same for Invoice.
                sale = (
                    db.query(Sale)
                    .filter(Sale.id == txn_id, Sale.user_id == user.id)
                    .first()
                )
                if sale is None:
                    errors.append(f"sale {txn_id_raw} not found")
                    continue
                invoice = (
                    db.query(Invoice)
                    .filter(Invoice.id == target_id, Invoice.user_id == user.id)
                    .first()
                )
                if invoice is None:
                    errors.append(f"invoice {target_id_raw} not found")
                    continue

                # Idempotency: already-linked sale to this same invoice
                # is a no-op (skip, no audit).
                if sale.invoice_id == invoice.id and invoice.status == "paid":
                    skipped += 1
                    continue

                if invoice.status not in ("sent", "overdue", "paid"):
                    errors.append(
                        f"faktura {invoice.fakturanummer} is {invoice.status} — cannot mark paid"
                    )
                    continue

                amount = Decimal(str(sale.amount))
                # mark_paid is idempotent + writes its own audit row.
                # We pass source='bank_csv' since this is owner-confirmed
                # from a CSV-import flow, not an automated match.
                try:
                    InvoiceService.mark_paid(
                        db, user, invoice.id, amount,
                        source="bank_csv",
                        paid_reference=sale.notes,
                        ip_address=ip_address,
                    )
                except Exception as e:
                    errors.append(f"faktura {invoice.fakturanummer}: {e}")
                    continue

                # Link the Sale for revenue dedup. Idempotent.
                before_sale_invoice_id = sale.invoice_id
                sale.invoice_id = invoice.id
                db.flush()

                # Top-level reconcile audit — separate from invoice.mark_paid
                # because this row scopes the confirmation as a reconcile
                # action specifically (vs. a manual click).
                audit_service.record(
                    db, user, "bank_reconcile.match_confirmed",
                    entity_type="invoice", entity_id=invoice.id,
                    before={
                        "invoice_id": str(invoice.id),
                        "sale_id": str(sale.id),
                        "sale_invoice_id": (
                            str(before_sale_invoice_id) if before_sale_invoice_id else None
                        ),
                    },
                    after={
                        "invoice_id": str(invoice.id),
                        "sale_id": str(sale.id),
                        "sale_invoice_id": str(invoice.id),
                        "action": "mark_paid",
                        "source": "bank_csv",
                    },
                    ip_address=ip_address,
                )
                confirmed += 1
                continue

            if target_type == "expense" and action in ("link", "unlink"):
                # Expense ↔ expense link: the bank line (txn) IS the payment
                # of the target — the expense the owner already booked (a
                # snapped receipt). Stored on the bank line
                # (linked_expense_id); the shared money gate
                # (expense_status.not_pending) then leaves the bank line out
                # of every total and of købsmoms, so the purchase counts
                # once. Nothing is deleted; "unlink" clears it. The notes
                # marker stays as the human-readable trace.
                bank_exp = (
                    db.query(Expense)
                    .filter(Expense.id == txn_id, Expense.user_id == user.id,
                            Expense.is_deleted.isnot(True))
                    .first()
                )
                if bank_exp is None:
                    errors.append(f"expense {txn_id_raw} not found")
                    continue
                if not (bank_exp.reference_id or "").startswith("bank_"):
                    _guard("not_a_bank_line", f"expense {txn_id_raw} is not a bank line")
                    continue
                link_marker = f"[linked:{target_id}]"

                if action == "unlink":
                    if bank_exp.linked_expense_id != target_id:
                        skipped += 1  # not linked to that expense: nothing to undo
                        continue
                    before = {"id": str(bank_exp.id), "notes": bank_exp.notes,
                              "linked_expense_id": str(target_id)}
                    bank_exp.linked_expense_id = None
                    if bank_exp.notes and link_marker in bank_exp.notes:
                        bank_exp.notes = " ".join(
                            bank_exp.notes.replace(link_marker, " ").split()
                        ) or None
                    db.flush()
                    audit_service.record(
                        db, user, "bank_reconcile.match_unlinked",
                        entity_type="expense", entity_id=bank_exp.id,
                        before=before,
                        after={"id": str(bank_exp.id), "notes": bank_exp.notes,
                               "linked_expense_id": None, "action": "unlink"},
                        ip_address=ip_address,
                    )
                    confirmed += 1
                    continue

                target_exp = (
                    db.query(Expense)
                    .filter(Expense.id == target_id, Expense.user_id == user.id,
                            Expense.is_deleted.isnot(True))
                    .first()
                )
                if target_exp is None:
                    errors.append(f"expense target {target_id_raw} not found")
                    continue
                if (target_exp.reference_id or "").startswith("bank_"):
                    _guard("target_is_a_bank_line",
                           f"expense target {target_id_raw} is itself a bank line")
                    continue

                if bank_exp.linked_expense_id == target_exp.id:
                    skipped += 1  # already linked to this expense
                    continue
                if bank_exp.linked_expense_id is not None:
                    _guard("bank_line_linked_elsewhere",
                           f"expense {txn_id_raw} is already linked to another expense — unlink it first")
                    continue
                if db.query(_paid_by_a_bank_line(target_exp.id, user.id,
                                                 other_than=bank_exp.id)).scalar():
                    _guard("expense_paid_by_another_bank_line",
                           f"expense target {target_id_raw} is already linked to another bank line")
                    continue

                before = {"id": str(bank_exp.id), "notes": bank_exp.notes,
                          "linked_expense_id": None}
                bank_exp.linked_expense_id = target_exp.id
                if not (bank_exp.notes and link_marker in bank_exp.notes):
                    bank_exp.notes = (
                        (bank_exp.notes or "") + (" " if bank_exp.notes else "") + link_marker
                    ).strip()
                db.flush()

                audit_service.record(
                    db, user, "bank_reconcile.match_confirmed",
                    entity_type="expense", entity_id=bank_exp.id,
                    before=before,
                    after={
                        "id": str(bank_exp.id),
                        "linked_expense_id": str(target_exp.id),
                        "action": "link",
                    },
                    ip_address=ip_address,
                )
                confirmed += 1
                continue

            errors.append(
                f"unsupported {target_type}/{action} for txn {txn_id_raw}"
            )

        except Exception as e:
            # Per-row failure isolation — one bad item must not abort
            # the whole batch (otherwise a single corrupt row would
            # block the owner from confirming 20 others).
            logger.exception(
                "bank_reconciliation.confirm_failed user=%s raw=%s",
                user.id, raw,
            )
            errors.append(f"unexpected error: {str(e)[:80]}")
            continue

    return {"confirmed": confirmed, "skipped": skipped, "errors": errors,
            "error_codes": [coded.get(i, "") for i in range(len(errors))]}
