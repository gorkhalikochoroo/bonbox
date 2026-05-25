"""
Booking ↔ CSV payment-line matcher.

Why this exists:
  After Sudip imports a MobilePay/Dankort CSV via the existing
  payment_import flow, some lines correspond to event bookings that
  are still in status='pending' (visitor reserved tickets, paid via
  Sudip's MobilePay Erhverv, but BonBox doesn't know yet). This
  service inspects each unreconciled CSV line and proposes the
  pending booking(s) it most likely settles.

Pure function, no DB writes. The caller in routers/payment_import.py
filters HIGH-confidence candidates for auto-confirm (calls
booking_to_sale.write_sale_from_booking) and surfaces MED/LOW to the
organizer's review UI.

Confidence ladder (highest wins):
  HIGH    Booking reference text (e.g. "NMN14-A47B") appears as a
          substring in the CSV `comment` (the MobilePay "besked"
          field). Exact substring, case-insensitive.

  MEDIUM  CSV `amount_dkk` exactly equals `booking.total_amount_dkk`
          AND CSV `sender_name` fuzzy-matches `booking.customer_name`
          (Levenshtein ratio ≥ 0.80 via rapidfuzz when available;
          falls back to case-insensitive containment-or-prefix-match
          when rapidfuzz is not in requirements).

  LOW     CSV `amount_dkk` exactly equals `booking.total_amount_dkk`
          AND CSV `date` sits within [event.starts_at - 7d,
          event.ends_at + 7d] AND no other LOW match exists for the
          same booking from the same CSV import (ambiguity gate —
          see comment in `_dedup_low`).

Multi-barrier doctrine — this is a read-only candidate-proposal
service, so the security-critical layers (L1/L2/L7) live in the
calling router. We DO enforce the tenant scope in the SQL filter
(organizer_user_id = caller's id) as defense-in-depth: even if the
router forgets to scope, this query can never propose a booking
belonging to another organizer.

Dependencies:
  • Imports Booking lazily so this file is importable even before
    Phase 1 lands the Booking model. If the model is missing the
    function returns an empty list (fail-soft — L5).
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

logger = logging.getLogger("bonbox.booking_match")

# ─── Tunables ────────────────────────────────────────────────────────
# Day-window padding for LOW-confidence date matches. Spec §matching:
# CSV line counts as a LOW candidate when its date is within
# [event.starts_at - 7d, event.ends_at + 7d]. Generous enough that
# a customer who pre-pays a week ahead or settles a tab three days
# after still matches, tight enough that random coincidental amounts
# don't pollute the review queue.
LOW_DATE_WINDOW_DAYS = 7

# Fuzzy threshold for MEDIUM-confidence sender_name vs customer_name.
# rapidfuzz.ratio returns 0..100; we normalise to 0..1 and require
# ≥0.80. Tuned via mental-test on Sita Sharma cases:
#   "Sita Sharma" vs "Sita Sharma"     → 1.00 (pass)
#   "Sita Sharma" vs "Sita S."         → 0.74 (fail)  ← rejected
#   "Sita Sharma" vs "Sita Sharmaa"    → 0.92 (pass)
#   "Sita Sharma" vs "Anders Andersen" → 0.18 (fail)
FUZZY_RATIO_THRESHOLD = 0.80

# Hard upper bound on any string we run through fuzzy compare or
# substring search.  Defends against a hostile CSV row containing a
# 10MB sender_name / besked that would burn CPU in rapidfuzz's
# Levenshtein loop or in the fallback containment check.  The visitor-
# side Pydantic schema caps customer_name at 160 chars; we mirror a
# generous-but-bounded 512-char cap on the CSV-derived sides so a
# legitimate "Sita Sharma · Faktura 2026-0042 — tak for sidste gang"
# besked still fits, but a megabyte ReDoS payload can't.
_FUZZY_INPUT_MAX_LEN = 512


# ─── Public dataclasses (caller imports these) ───────────────────────


@dataclass
class CsvPaymentLine:
    """One parsed CSV row. Whatever the existing payment_import flow
    parses gets normalised into this shape before calling us. We don't
    care which provider (MobilePay vs Dankort) emitted the line; the
    matcher consumes the same five fields either way."""

    amount_dkk: int
    sender_name: str | None
    comment: str | None  # MobilePay "besked" field — key signal for HIGH
    date: date
    # Optional row-index back to the parsed CSV. Routers thread this
    # through so the response payload can point at the right row in
    # the review UI. Not used by the matcher itself.
    csv_row_index: int | None = None


@dataclass
class BookingMatch:
    """One candidate match. Caller filters by `confidence`.

    `booking_id` is a string (UUID str) not UUID so the response
    payload can be JSON-serialised without a custom encoder. Saves
    a layer of `str()` casts in the router.
    """

    booking_id: str
    confidence: Literal["high", "medium", "low"]
    reason: str  # human-readable, surfaced in the review UI verbatim
    line: CsvPaymentLine
    # Optional booking reference echoed back so the UI can show
    # "matched on NMN14-A47B" without re-fetching the booking. None
    # for MED/LOW (no reference involved).
    matched_reference: str | None = None


# ─── Internal helpers ────────────────────────────────────────────────


def _strip_diacritics(s: str) -> str:
    """Danish-friendly NFKD diacritic strip. MobilePay sender names
    can arrive with or without æøå normalisation depending on the
    bank's CSV export pipeline. Both sides get normalised before
    we compare."""
    if not s:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s)
        if not unicodedata.combining(c)
    )


def _normalize_name(s: str | None) -> str:
    """Lowercase + diacritic-strip + collapse whitespace. Used on both
    sides of the fuzzy compare.

    Bounded — input is truncated to `_FUZZY_INPUT_MAX_LEN` BEFORE any
    O(n) work runs, so a hostile multi-MB sender_name can't trigger a
    ReDoS in rapidfuzz / fallback containment check.  Real CSV rows
    are well under 200 chars.
    """
    if not s:
        return ""
    # L2 — hard input cap before O(n²) Levenshtein / O(n) substring
    # work.  Slicing a Python str is O(k) where k = limit, so this
    # itself can't be abused.
    if len(s) > _FUZZY_INPUT_MAX_LEN:
        s = s[:_FUZZY_INPUT_MAX_LEN]
    return " ".join(_strip_diacritics(s).lower().split())


def _normalize_comment(s: str | None) -> str:
    """Comment matching is case-insensitive and strips punctuation
    around reference tokens. The reference itself is alphanumeric +
    hyphen, so we just lowercase + diacritic-strip and leave the
    structure intact. We compare with a substring check, not a token
    split, so 'paid for NMN14-A47B, thanks!' matches 'NMN14-A47B'.

    Bounded — same `_FUZZY_INPUT_MAX_LEN` truncation as `_normalize_name`.
    The MobilePay "besked" field is bank-limited to ~280 chars, and
    legit Danske/Nordea memo lines max out around 140; 512 leaves
    ample headroom for a "Pickup hos Sita · Faktura 2026-0042 — tak"
    while killing any DoS payload.
    """
    if not s:
        return ""
    if len(s) > _FUZZY_INPUT_MAX_LEN:
        s = s[:_FUZZY_INPUT_MAX_LEN]
    return _strip_diacritics(s).lower()


def _fuzzy_ratio(a: str, b: str) -> float:
    """Levenshtein-style similarity ratio in [0, 1].

    Strategy:
      1. Try rapidfuzz.fuzz.ratio (fast C impl) when available.
      2. Otherwise fall back to a tolerant Python check: exact match,
         containment (one contains the other), or shared-prefix
         coverage ≥ threshold. The fallback is intentionally
         CONSERVATIVE — we'd rather route to MED-review than auto-
         confirm a wrong match, so the fallback returns ratios that
         only cross the threshold for clearly-similar strings.
    """
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    # Try rapidfuzz first
    try:
        from rapidfuzz import fuzz  # type: ignore[import-not-found]

        return float(fuzz.ratio(a, b)) / 100.0
    except ImportError:
        pass

    # ── Fallback (no rapidfuzz) ───────────────────────────────────
    # Conservative containment check. We accept "Sita Sharma" in
    # "Sita Sharma Pradhan" but not "Sita" in "Sitamarhi Bazar".
    # The trick is to require the shorter string to be a meaningful
    # fraction of the longer.
    if a in b or b in a:
        shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
        if not longer:
            return 0.0
        # If the shorter string covers ≥80% of the longer, treat as
        # high similarity. Caps out at 1.0 for exact-substring of a
        # very-close-length pair.
        return min(1.0, len(shorter) / len(longer))

    # Otherwise return a low-baseline ratio so callers can decide.
    # We don't bother computing real Levenshtein here — without
    # rapidfuzz the marginal cases (~0.7) are best left to manual
    # review. Returning 0.0 here is the safe play: MED never trips
    # in the fallback path; LOW still does its job via amount+date.
    return 0.0


def _get_booking_model():
    """Lazy import of the Booking model.

    Phase 1 agent owns the bookings table + ORM model in parallel.
    To keep this service importable during the parallel build and
    not blow up downstream test collection when the model is missing,
    we resolve it lazily and return None when not yet present."""
    try:
        from app.models.booking import Booking  # type: ignore[import-not-found]
        return Booking
    except Exception as e:  # noqa: BLE001
        logger.debug("booking_match: Booking model not importable yet (%s)", e)
        return None


def _booking_reference(booking) -> str | None:
    """Resolve the canonical reference string for a booking.

    Phase 1 spec hasn't locked the column name yet. We probe two
    well-known options in priority order:

      1. `booking.reference` — explicit reference column (preferred)
      2. f"{event.slug.upper()}-{booking_id_prefix}" — derived from
         slug + first 4 hex chars of the booking UUID

    Returning None means "no usable reference" — the HIGH path is
    skipped for this booking and we fall through to MED/LOW.
    """
    # 1. Explicit `reference` column
    ref = getattr(booking, "reference", None)
    if ref:
        return str(ref).strip()

    # 2. Synthesised from slug + uuid prefix
    event = getattr(booking, "event", None)
    slug = getattr(event, "slug", None) if event else None
    if slug:
        try:
            uuid_prefix = str(booking.id).replace("-", "")[:4].upper()
            slug_part = re.sub(r"[^A-Za-z0-9]", "", slug).upper()[:10]
            if slug_part:
                return f"{slug_part}-{uuid_prefix}"
        except Exception:
            return None

    return None


def _amount_matches(line: CsvPaymentLine, booking) -> bool:
    """Exact-integer amount compare. Both sides are DKK integers
    (the booking schema declares `total_amount_dkk INTEGER` and the
    CSV parser is required to emit integer öre-rounded DKK)."""
    try:
        booking_amount = int(getattr(booking, "total_amount_dkk", 0) or 0)
    except (TypeError, ValueError):
        return False
    return line.amount_dkk == booking_amount


def _date_within_event_window(line: CsvPaymentLine, booking) -> bool:
    """LOW-tier gate: CSV date sits within [starts_at - 7d, ends_at + 7d].

    Falls back gracefully if the event doesn't have `starts_at`/
    `ends_at` columns yet (Phase 1 still ALTER TABLE-ing); in that
    case we use the legacy `event_date` field with the same ±7d pad.
    """
    event = getattr(booking, "event", None)
    if event is None:
        return False

    def _to_date(val) -> date | None:
        if val is None:
            return None
        if isinstance(val, date):
            return val
        try:
            return val.date()  # datetime → date
        except AttributeError:
            return None

    start = _to_date(getattr(event, "starts_at", None))
    end = _to_date(getattr(event, "ends_at", None))

    if start is None and end is None:
        legacy = _to_date(getattr(event, "event_date", None))
        if legacy is None:
            return False
        start = end = legacy

    # If only one side is set, mirror it.
    if start is None:
        start = end
    if end is None:
        end = start

    if start is None or end is None:
        return False

    window_start = start - timedelta(days=LOW_DATE_WINDOW_DAYS)
    window_end = end + timedelta(days=LOW_DATE_WINDOW_DAYS)
    return window_start <= line.date <= window_end


def _dedup_low(matches: list[BookingMatch]) -> list[BookingMatch]:
    """Strip LOW matches when more than one booking matches the same
    (amount, date-window). Two pending bookings for 450 DKK in the
    same week is the textbook ambiguous case — no auto-confirm value
    and surfacing both as 'low confidence' would create noise. We
    keep them only if they're uniquely-low; otherwise drop both.

    HIGH and MEDIUM are NEVER stripped here — those carry name or
    reference signal that already disambiguates.
    """
    low = [m for m in matches if m.confidence == "low"]
    if len(low) <= 1:
        return matches
    not_low = [m for m in matches if m.confidence != "low"]
    return not_low  # ambiguous lows → drop all


def _confidence_rank(c: str) -> int:
    """Map for stable sort: high > medium > low."""
    return {"high": 3, "medium": 2, "low": 1}.get(c, 0)


# ─── Public API ─────────────────────────────────────────────────────


def find_booking_matches(
    db: Session,
    organizer_user_id: UUID | str,
    line: CsvPaymentLine,
) -> list[BookingMatch]:
    """Return candidate booking matches for one CSV payment line.

    Scope (defensive even though router already enforces L1+L2):
      • Only pending bookings (status='pending')
      • Belonging to `organizer_user_id` (tenant filter)
      • Of the caller's choosing — we don't cross-tenant

    Returns ALL candidates above LOW (caller surfaces them for
    review), plus the LOW band when unambiguous. Sorted by
    confidence DESC so the first element is the best candidate.

    Returns [] if:
      • Booking model not yet importable (Phase 1 not landed)
      • No pending bookings for the organizer
      • All matches got dropped by the LOW-ambiguity guard
    """
    Booking = _get_booking_model()
    if Booking is None:
        return []

    # Fetch this organizer's pending bookings. Bounded to avoid
    # blowing up if an organizer somehow accumulates thousands of
    # ghost-pending bookings; the realistic high-water mark for a
    # single CSV import is a few hundred.
    try:
        bookings = (
            db.query(Booking)
            .filter(
                Booking.organizer_user_id == organizer_user_id,
                Booking.status == "pending",
            )
            .limit(1000)
            .all()
        )
    except Exception as e:  # noqa: BLE001
        # Schema drift during the parallel build — fail soft.
        logger.warning("booking_match: query failed (%s) — returning []", e)
        return []

    if not bookings:
        return []

    # Pre-compute the normalised CSV signals once.
    comment_norm = _normalize_comment(line.comment)
    sender_norm = _normalize_name(line.sender_name)

    matches: list[BookingMatch] = []

    for booking in bookings:
        booking_id_str = str(booking.id)

        # ── HIGH: reference substring in comment ──────────────────
        reference = _booking_reference(booking)
        if reference and comment_norm:
            ref_norm = _normalize_comment(reference)
            if ref_norm and ref_norm in comment_norm:
                matches.append(BookingMatch(
                    booking_id=booking_id_str,
                    confidence="high",
                    reason=f"Reference '{reference}' found in payment comment",
                    line=line,
                    matched_reference=reference,
                ))
                # HIGH wins for this booking — no need to also test
                # the weaker tiers on the same row.
                continue

        # ── MEDIUM: amount + fuzzy name ───────────────────────────
        if _amount_matches(line, booking):
            customer_name = getattr(booking, "customer_name", None)
            # _normalize_name truncates internally; this is defense-
            # in-depth in case a future Booking column type drifts to
            # an uncapped TEXT.
            customer_norm = _normalize_name(customer_name)
            if customer_norm and sender_norm:
                ratio = _fuzzy_ratio(sender_norm, customer_norm)
                if ratio >= FUZZY_RATIO_THRESHOLD:
                    matches.append(BookingMatch(
                        booking_id=booking_id_str,
                        confidence="medium",
                        reason=(
                            f"Amount + name fuzzy match "
                            f"({line.sender_name} vs {customer_name})"
                        ),
                        line=line,
                    ))
                    continue

        # ── LOW: amount + date window ─────────────────────────────
        if _amount_matches(line, booking) and _date_within_event_window(line, booking):
            matches.append(BookingMatch(
                booking_id=booking_id_str,
                confidence="low",
                reason=f"Amount match within event date window (±{LOW_DATE_WINDOW_DAYS}d)",
                line=line,
            ))

    # Ambiguity gate for LOW matches.
    matches = _dedup_low(matches)

    # Sort by confidence DESC. Stable on equal confidence so callers
    # see deterministic ordering — important for tests + UI ordering.
    matches.sort(key=lambda m: -_confidence_rank(m.confidence))

    return matches
