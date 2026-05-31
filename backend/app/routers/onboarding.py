"""Onboarding endpoints — business-archetype detection.

POST /api/onboarding/detect-archetype takes a free-text business description
(what the owner types in the very first onboarding field, possibly Danish or an
immigrant-community term) and resolves it to a canonical ``business_type`` +
archetype, so the rest of onboarding/nav/dashboard can lead with the right
defaults from ``services/archetype.py``.

Two-stage resolution — cheap first, AI only when needed:

  1. Keyword fast-path — a multilingual term→business_type dict (Danish +
     English + common immigrant-community terms). A confident hit returns
     immediately with source="keyword", NO model call. This covers the vast
     majority of real inputs ("pizza", "frisør", "kiosk", "bageri") for free.
  2. AI fallback — only when no keyword matches. EXACTLY ONE Messages call via
     ``call_with_fallback`` (PREMIUM_MODEL → DEFAULT_MODEL on any error),
     constrained to emit a single token from the allowed business_type set.
     Anything off-list / any error / no API key → business_type="other"
     (source="fallback"). Never loops; at most one paid call per request.

Guards (cost / spam discipline, mirrors the register limiter):
  • Auth — get_current_user (the owner is logged in during onboarding).
  • Rate limit — 10/minute/IP, the same shape register uses, so a script can't
    burn the AI budget by hammering this endpoint.
  • Telemetry — best-effort EventLog row (event="onboarding.detect"); failure
    here never affects the response.

NOTE: this module intentionally does NOT use ``from __future__ import
annotations``. slowapi's ``@limiter.limit`` wraps the handler with
functools.wraps; under stringized annotations FastAPI fails to resolve the
Pydantic body model on the wrapped signature and mis-reads the body param as a
query param (422 "field required: query.data"). Keeping annotations eager —
mirrors the working rate-limited body handler in auth.register.
"""
import json
import logging

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.event_log import EventLog
from app.models.user import User
from app.services.archetype import (
    BUSINESS_TYPE_TO_ARCHETYPE,
    archetype_id_for,
    archetype_summary,
)
from app.services.auth import get_current_user

logger = logging.getLogger("bonbox.onboarding")

router = APIRouter()

# Same limiter shape as auth.register (5–10/min/IP). Detection is a handful-of-
# times human action during onboarding; 10/min is generous for a real user and
# tight enough that a bot can't loop the (at most one) AI call to burn budget.
limiter = Limiter(key_func=get_remote_address)

# The exact set of tokens the AI is allowed to emit + that archetype_id_for
# understands. Sourced live from the canonical mapping so it never drifts.
_ALLOWED_TYPES: frozenset[str] = frozenset(BUSINESS_TYPE_TO_ARCHETYPE.keys())


# ── Multilingual keyword fast-path ──────────────────────────────────────────
# term (already lowercased) → canonical business_type. Danish + English +
# obvious immigrant-community terms. Substring match (longest term wins) so
# "pizzeria på hjørnet" → restaurant and "mobil reparation" → mobile_repair.
# Keys are checked longest-first so multi-word / more-specific terms win over
# a shorter overlapping term (e.g. "online" vs "online clothing", "phone
# repair" vs a bare "phone").
_KEYWORD_MAP: dict[str, str] = {
    # ── food service → restaurant / cafe / bakery / food_truck / tea_shop ──
    "pizzeria": "restaurant",
    "pizza": "restaurant",
    "restaurant": "restaurant",
    "restaurang": "restaurant",
    "spisested": "restaurant",
    "diner": "restaurant",
    "takeaway": "restaurant",
    "take away": "restaurant",
    "grill": "restaurant",
    "shawarma": "restaurant",
    "kebab": "restaurant",
    "sushi": "restaurant",
    "burger": "restaurant",
    "madsted": "restaurant",
    "café": "cafe",
    "cafe": "cafe",
    "kaffe": "cafe",
    "coffee": "cafe",
    "kaffebar": "cafe",
    "te": "tea_shop",
    "tea": "tea_shop",
    "chai": "tea_shop",
    "bager": "bakery",
    "bageri": "bakery",
    "bakery": "bakery",
    "konditori": "bakery",
    "food truck": "food_truck",
    "foodtruck": "food_truck",
    "madvogn": "food_truck",
    # ── bar ────────────────────────────────────────────────────────────────
    "værtshus": "bar",
    "vaertshus": "bar",
    "cocktail": "bar",
    "pub": "bar",
    "bar": "bar",
    "natklub": "bar",
    "nightclub": "bar",
    "vinbar": "bar",
    "ølbar": "bar",
    # ── retail / shop variants ───────────────────────────────────────────────
    "minimarked": "kiosk",
    "købmand": "kiosk",
    "kobmand": "kiosk",
    "kiosk": "kiosk",
    "grønthandler": "grocery",
    "gronthandler": "grocery",
    "supermarked": "grocery",
    "supermarket": "grocery",
    "grocery": "grocery",
    "grønt": "grocery",
    "gront": "grocery",
    "veggie": "veggie_shop",
    "online clothing": "online_clothing",
    "online tøj": "online_clothing",
    "webshop": "online_clothing",
    "web shop": "online_clothing",
    "online": "online_clothing",
    "tøj": "clothing",
    "toj": "clothing",
    "clothing": "clothing",
    "boutique": "clothing",
    "butik": "clothing",
    "mode": "clothing",
    "apotek": "pharmacy",
    "pharmacy": "pharmacy",
    "blomster": "flower_shop",
    "flower": "flower_shop",
    "florist": "flower_shop",
    "smykker": "jewelry",
    "jewelry": "jewelry",
    "jeweller": "jewelry",
    "guld": "jewelry",
    "electronics shop": "electronics",
    "electronics store": "electronics",
    "elektronikbutik": "electronics",
    "elektronik": "electronics",
    "electronics": "electronics",
    "kosmetik": "cosmetics",
    "cosmetics": "cosmetics",
    "makeup": "cosmetics",
    "skønhedsprodukter": "cosmetics",
    "papirhandel": "stationery",
    "stationery": "stationery",
    "byggemarked": "hardware",
    "isenkræmmer": "hardware",
    "hardware store": "hardware",
    "genbrug": "thrift",
    "thrift": "thrift",
    "loppe": "thrift",
    "secondhand": "thrift",
    "second hand": "thrift",
    "engros": "wholesale",
    "wholesale": "wholesale",
    "grossist": "wholesale",
    "butikshandel": "retail",
    "detailhandel": "retail",
    "shop": "retail",
    # ── salon / beauty ───────────────────────────────────────────────────────
    "frisør": "salon",
    "frisor": "salon",
    "salon": "salon",
    "barber": "salon",
    "barbershop": "salon",
    "hair": "salon",
    "hårklinik": "salon",
    "beauty": "salon",
    "skønhedsklinik": "salon",
    "negle": "salon",
    "nail": "salon",
    "spa": "salon",
    # ── services / repair / trades ───────────────────────────────────────────
    "mobil reparation": "mobile_repair",
    "mobilreparation": "mobile_repair",
    "phone repair": "mobile_repair",
    "telefon reparation": "mobile_repair",
    "reparation": "mobile_repair",
    "repair": "mobile_repair",
    "vaskeri": "laundry",
    "renseri": "laundry",
    "laundry": "laundry",
    "dry cleaning": "laundry",
    "værksted": "workshop",
    "vaerksted": "workshop",
    "workshop": "workshop",
    "mekaniker": "workshop",
    "mechanic": "workshop",
    "auto": "workshop",
    "autoværksted": "workshop",
    "bilværksted": "workshop",
    "garage": "workshop",
    "freelancer": "freelancer",
    "freelance": "freelancer",
    "konsulent": "freelancer",
    "consultant": "freelancer",
    "event": "event_organizer",
    "arrangør": "event_organizer",
    "eventbureau": "event_organizer",
    # ── personal finance ─────────────────────────────────────────────────────
    "privat": "personal",
    "personal finance": "personal",
    "personlig": "personal",
}

# Pre-sort terms longest-first so the most specific match wins on substring.
_KEYWORD_TERMS_SORTED: tuple[str, ...] = tuple(
    sorted(_KEYWORD_MAP.keys(), key=len, reverse=True)
)


class DetectArchetypeRequest(BaseModel):
    """Body for POST /api/onboarding/detect-archetype.

    `text` is bounded [1, 120] — a business description, not a document. The
    cap also keeps the (at most one) AI prompt cheap and bounds anything we
    log. `lang` is an optional UI-language hint (e.g. "da" / "en"); detection
    is language-agnostic so it's advisory only today.
    """
    text: str = Field(min_length=1, max_length=120)
    lang: str | None = None


def _keyword_match(text: str) -> str | None:
    """Return the canonical business_type for the first (longest) keyword that
    appears as a substring of the normalised text, else None."""
    for term in _KEYWORD_TERMS_SORTED:
        if term in text:
            return _KEYWORD_MAP[term]
    return None


def _ai_detect(text: str) -> str:
    """ONE Messages call (PREMIUM→DEFAULT fallback) constrained to a single
    allowed business_type token. Returns the token, or "other" on any error /
    off-list output / missing API key. Never raises, never loops."""
    api_key = getattr(settings, "ANTHROPIC_API_KEY", "") or ""
    if not api_key:
        logger.info("onboarding.detect: no ANTHROPIC_API_KEY — fallback to 'other'")
        return "other"

    try:
        import anthropic

        from app.services.model_fallback import call_with_fallback

        allowed = sorted(_ALLOWED_TYPES)
        system = (
            "You classify a short business description (which may be in Danish, "
            "English, or another language) into EXACTLY ONE token from this "
            "allowed list:\n"
            + ", ".join(allowed)
            + "\nReply with ONLY the single token, lowercase, nothing else. "
            "If none clearly fits, reply 'other'."
        )
        client = anthropic.Anthropic(api_key=api_key)
        resp = call_with_fallback(
            client,
            _label="archetype_detect",
            _primary=settings.PREMIUM_MODEL,
            _fallback=settings.DEFAULT_MODEL,
            max_tokens=20,
            system=system,
            messages=[{"role": "user", "content": text}],
        )
        blocks = [
            getattr(b, "text", "") for b in resp.content
            if getattr(b, "type", None) == "text"
        ]
        raw = " ".join(blocks).strip().lower()
        token = raw.split()[0].strip(".,!?:;\"'") if raw else ""
        return token if token in _ALLOWED_TYPES else "other"
    except Exception as e:  # noqa: BLE001 — any failure degrades to 'other'
        logger.warning("onboarding.detect AI step failed: %s: %s", type(e).__name__, e)
        return "other"


@router.post("/detect-archetype")
@limiter.limit("10/minute")
def detect_archetype(
    request: Request,
    data: DetectArchetypeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Resolve a free-text business description to a business_type + archetype.

    Keyword fast-path first (no AI cost); AI fallback (one call) only when no
    keyword matches. Always returns 200 with a stable shape — unknown inputs
    resolve to business_type="other" / archetype="generic".
    """
    normalized = (data.text or "").strip().lower()

    business_type = _keyword_match(normalized)
    if business_type is not None:
        source = "keyword"
        confidence = "high"
    else:
        business_type = _ai_detect(normalized)
        source = "fallback"
        # A real on-list AI hit is "medium"; the catch-all "other" is "low".
        confidence = "low" if business_type == "other" else "medium"

    aid = archetype_id_for(business_type)

    # Best-effort telemetry — never let a logging failure touch the response.
    try:
        if not getattr(current_user, "analytics_opt_out", False):
            db.add(EventLog(
                user_id=current_user.id,
                event="onboarding.detect",
                page="onboarding",
                detail=json.dumps({"source": source, "business_type": business_type}),
            ))
            db.commit()
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass

    return {
        "business_type": business_type,
        "archetype": aid,
        "confidence": confidence,
        "source": source,
        "summary": archetype_summary(business_type),
    }
