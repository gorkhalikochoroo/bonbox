"""
reservation_ai — apply the rule-based AI signals (allergy suggestion +
note intent) onto a freshly-built Reservation, in ONE fail-soft place that every
create path calls. Keeping it here (not inline in each router) means the four
create paths — owner table, owner provider, public table, public provider — all
get identical, identically-safe behaviour.

INVARIANTS (see allergy_detector.py + note_intent.py for the why):
  • Reads the reservation's OWN free-text (guest_notes / allergy_note / occasion)
    and party_size — never trusts a caller to pass the right thing.
  • Writes ONLY the allergy_ai_* + note_intent columns. It NEVER touches the
    confirmed allergen_tags / allergy_severity / allergy_note — the AI suggestion
    is a separate, additive channel the owner confirms or dismisses.
  • Fail-soft: ANY error is swallowed. A detector hiccup must NEVER break the
    booking the guest/owner just made (the sync create path is high-volume and
    the public one is unauthenticated).
"""
from __future__ import annotations

import logging

from app.services.allergy_detector import detect_allergy_signals
from app.services.note_intent import classify_note_intent

logger = logging.getLogger("bonbox.reservation_ai")


def apply_ai_signals(reservation, business_type: str | None) -> None:
    """Mutate `reservation` in place with the unconfirmed allergy suggestion +
    the note intent. No return value; safe to call on any create path right
    after the Reservation object is constructed and before commit."""
    try:
        guest_notes = getattr(reservation, "guest_notes", None)
        allergy_note = getattr(reservation, "allergy_note", None)
        occasion = getattr(reservation, "occasion", None)
        party_size = getattr(reservation, "party_size", None)

        # ── Allergy suggestion (unconfirmed) ──────────────────────────────
        detection = detect_allergy_signals(guest_notes, allergy_note, business_type)
        if detection:
            tags = detection.get("suggested_tags") or []
            matched = detection.get("matched_terms") or []
            reservation.allergy_ai_tags = tags or None
            reservation.allergy_ai_severity = detection.get("suggested_severity")
            reservation.allergy_ai_generic = bool(detection.get("generic"))
            reservation.allergy_ai_matched = matched or None
            reservation.allergy_ai_confirmed = False

        # ── Note intent (operational bucket) ──────────────────────────────
        # Reads occasion + guest_notes (the allergy channel is separate). A
        # birthday named in the occasion field is caught alongside the note.
        note_text = " ".join(x for x in (occasion, guest_notes) if x)
        reservation.note_intent = classify_note_intent(note_text or None, party_size)
    except Exception as exc:  # noqa: BLE001
        # Never let signal detection break a booking write.
        logger.warning("reservation_ai.apply_ai_signals skipped: %s", exc)
