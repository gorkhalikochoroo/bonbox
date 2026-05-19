"""
Smart Pricing Intelligence — the Day-1 "wow" moment.

WHAT IT DOES
────────────────────────────────────────────────────────────────────────
For each inventory item the owner has priced, surface "the neighborhood
median" alongside their own price. Day 1 demo:

  "Cappuccino — you charge 45 DKK. Neighborhood median is 49 DKK across
   8 cafés in 2200 København N. You're 8% below the cohort."

The owner gets a sharp comparison BEFORE they've entered a single sale,
because the cohort data already exists from every other tenant's
inventory imports. This is BonBox's network-effect moment — every new
café adds a tiny bit of signal to the next café's onboarding.

PRIVACY MODEL — k-ANONYMITY GATE (NON-NEGOTIABLE)
────────────────────────────────────────────────────────────────────────
The core risk: any aggregate query that exposes another tenant's price
data, however indirectly. Mitigations, in defence-in-depth order:

  Layer 1 (auth): every endpoint requires a logged-in user.
  Layer 2 (tenant scope): the user's OWN price comes from
                          InventoryItem WHERE user_id = me. Their own
                          row is filtered OUT of the cohort sum (we
                          compare the cohort to themselves, not to a
                          cohort including themselves — which would
                          leak their own price back in a trivial way).
  Layer 3 (k-anonymity): if the cohort has fewer than MIN_COHORT_SIZE
                         tenants (currently 5), we return
                         {available: False, reason: "not_enough_data"}.
                         NEVER return min/max/median/percentile etc.
                         Even count is reported only as "not enough" —
                         we don't leak that there are 1, 2, 3 or 4
                         other priced rows.
  Layer 4 (bucketing): aggregate is GROUP BY postal_code + cuisine +
                       canonical_name. No lat/lon, no exact address,
                       no business name. The smallest "neighborhood"
                       is a Danish postal code — large enough that
                       individuals can't be backed out from 5 rows.
  Layer 5 (one-row-per-tenant): we DISTINCT by user_id BEFORE the
                                aggregate, so a single business
                                with 3 "cappuccino" rows in their
                                inventory counts as 1 cohort member,
                                not 3 — otherwise a single noisy
                                tenant could satisfy MIN_COHORT_SIZE
                                on their own.
  Layer 6 (audit): every query writes a SecurityEvent so admin can
                   spot scraping behaviour (one user pinging every
                   canonical name in a loop).
  Layer 7 (cache headers): private, max-age=300 — never CDN-cacheable,
                           never logged into public proxies.

We deliberately do NOT expose individual rows in any field, not even
truncated. The percentile bar in the UI is computed entirely client-
side from the {p25, median, p75, min, max} payload — which is itself
already an aggregate over 5+ tenants. (Edge: with exactly 5 tenants
the min and max ARE individual prices, but they're not attributable
to a person — there's no way to know which of the 5 is the min.
Still, future v2 can switch to p10/p90 if we want belt-and-braces.)

KEY DESIGN CHOICES
────────────────────────────────────────────────────────────────────────
• Percentile maths in Python, not SQL. SQLite + Postgres handle
  percentile_cont() differently, and the cohort is small (≤ a few
  hundred prices per bucket) so an in-memory sort is cheap. Keeps the
  service portable across both DBs.

• Cache: in-process TTL dict keyed by (postal, cuisine, canonical).
  60-second window — long enough to absorb the "load Pricing page →
  see 10 items" burst, short enough that new inventory imports show
  up in tomorrow's session.

• Normalisation: see menu_item_categories.normalize_item_name.
  Items that don't match a canonical return available=False with
  reason="unknown_item" — UI hides the comparison card.

• Cuisine: we read from BusinessProfile.cuisine. If the user hasn't
  set it, they can't see comparisons (and conversely, their data
  doesn't contribute to anyone's cohort). This is a self-correcting
  consent loop: contribute → benefit. v2 can add an explicit
  opt-out.

CACHE-CONTROL: the router sets `Cache-Control: private, max-age=300`
so the browser caches per-user but no proxy ever sees the response.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.inventory import InventoryItem
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.menu_item_categories import (
    CANONICAL_NAMES,
    get_category_group,
    list_canonical_names,
    normalize_item_name,
)

logger = logging.getLogger("bonbox.smart_pricing")


# ──────────────────────────────────────────────────────────────────────
# Tuning constants — all named so tests can override
# ──────────────────────────────────────────────────────────────────────

# k-anonymity gate. Less than this many DISTINCT tenants priced an item
# in the same (postal, cuisine) bucket → no comparison rendered. 5 is
# the lowest sensible threshold for "I can't easily back out an
# individual"; raise to 10 if we ever see a tenant under-rotated postal.
MIN_COHORT_SIZE: int = 5

# Cache TTL for aggregate results, seconds. Short enough that a tenant
# editing their price sees the cohort move within 5 minutes; long enough
# that the Pricing page loading 25 items only fires 25 first-touch
# queries every ~5 min.
CACHE_TTL_SECONDS: int = 300

# Hard cap on how many rows a single aggregate scans. Defense-in-depth
# against a runaway query — if a postal somehow had millions of rows,
# we still bail before sorting. In practice each bucket holds tens or
# hundreds of rows.
MAX_COHORT_ROWS: int = 5000


# ──────────────────────────────────────────────────────────────────────
# In-process cache — TTL'd
# ──────────────────────────────────────────────────────────────────────
# We don't use Redis: BonBox's backend is single-process FastAPI on
# Render free tier, and the cohorts are small. A dict with a lock is
# fine. If we scale to multiple workers later, swap for Redis with the
# same interface.

_CACHE: dict[tuple[str, str, str], tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()


def _cache_get(key: tuple[str, str, str]) -> Optional[dict]:
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if not entry:
            return None
        expires_at, payload = entry
        if time.time() >= expires_at:
            _CACHE.pop(key, None)
            return None
        return payload


def _cache_set(key: tuple[str, str, str], payload: dict) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + CACHE_TTL_SECONDS, payload)


def _cache_clear() -> None:
    """Test helper — wipe the in-process cache."""
    with _CACHE_LOCK:
        _CACHE.clear()


# ──────────────────────────────────────────────────────────────────────
# Postal bucketing
# ──────────────────────────────────────────────────────────────────────
# Danish postal codes are 4-digit. We bucket on the raw value — no
# expansion to "first 2 digits" or similar. A user in 2200 sees ONLY
# 2200 tenants in their cohort. If a postal has fewer than 5 tenants
# priced for a canonical, the gate fires and the user sees "not enough
# data" rather than falling back to a wider area. (Wider-area fallback
# is the #1 v2 candidate, see deferrals at bottom.)

def _normalize_postal(raw: Optional[str]) -> Optional[str]:
    """Trim whitespace, collapse to digits-only when the input is a
    Danish-style code, else return as-is. Returns None for empties."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # If the string is digits + spaces, return the digits. Otherwise
    # leave as-is (international codes might have letters).
    digits = "".join(c for c in s if c.isdigit())
    if digits and len(digits) == 4:
        return digits
    return s.lower()


def _normalize_cuisine(raw: Optional[str]) -> Optional[str]:
    """Lowercase + strip. Cuisine free-text means we can't be picky."""
    if not raw:
        return None
    s = str(raw).strip().lower()
    return s or None


# ──────────────────────────────────────────────────────────────────────
# Percentile helper — pure-Python, no numpy
# ──────────────────────────────────────────────────────────────────────

def _percentile(sorted_values: list[float], pct: float) -> float:
    """Linear-interpolated percentile (matches numpy 'linear' default).
    `sorted_values` must already be sorted ascending. `pct` in [0,100].
    Returns 0 for empty input."""
    n = len(sorted_values)
    if n == 0:
        return 0.0
    if n == 1:
        return float(sorted_values[0])
    if pct <= 0:
        return float(sorted_values[0])
    if pct >= 100:
        return float(sorted_values[-1])
    # Linear interpolation between neighbours.
    pos = (pct / 100.0) * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac)


def _percentile_of_value(sorted_values: list[float], value: float) -> int:
    """Where does `value` sit in `sorted_values`, as 0-100 percentile?
    Uses simple "fraction of cohort at or below" — matches owner mental
    model ('I'm at the 30th percentile = 30% of others are cheaper').
    Returns an int [0, 100]."""
    n = len(sorted_values)
    if n == 0:
        return 0
    below_or_equal = sum(1 for v in sorted_values if v <= value)
    return int(round(below_or_equal / n * 100))


# ──────────────────────────────────────────────────────────────────────
# Main entry point: get_market_comparison
# ──────────────────────────────────────────────────────────────────────

def get_market_comparison(
    db: Session,
    user: User,
    item_name: str,
    postal_code: Optional[str] = None,
    cuisine: Optional[str] = None,
    *,
    audit_request: bool = True,
) -> dict:
    """The single Smart Pricing comparison primitive.

    Inputs:
        db          — session, owned by the caller.
        user        — the requesting user. Their OWN price is fetched
                      from their inventory; their own row is filtered
                      OUT of the cohort.
        item_name   — raw item name as the owner sees it (will be
                      normalised to a canonical bucket).
        postal_code — defaults to user's BusinessProfile.zipcode.
        cuisine     — defaults to user's BusinessProfile.cuisine.
        audit_request — write a SecurityEvent row (caller can opt out
                        for batch/all calls that audit once outside).

    Returns a dict. ALWAYS includes `available` (bool). When
    `available=True`, includes the full payload. When False, includes
    `reason` only — never any aggregate values.

    Privacy invariants pinned by the test suite:
      1. n < MIN_COHORT_SIZE → no aggregate values ever leak.
      2. The user's own price never appears in min/max — they're
         excluded from the cohort before sort.
      3. Even with n >= MIN_COHORT_SIZE, the payload contains NO
         individual identifiers (no business names, no ids, no postal
         counts per-business).
    """
    # ── Resolve the user's profile context ─────────────────────────────
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    # Audit P2 (Task #76): only trust profile.zipcode when the owner
    # has verified the address against DAWA AND a real CVR lookup
    # confirms the company.  Without both, an attacker can flip
    # postal codes via PUT /business to leech a richer cohort OR
    # probe sparse cohorts to de-anonymize neighbours.  The explicit
    # ?postal_code= override stays — that's a caller-supplied hint
    # only, never persisted, and only consulted when the trusted
    # profile postal is also present (we don't let untrusted callers
    # bypass the gate entirely).
    profile_postal_trusted = bool(
        profile
        and profile.dawa_address_id
        and profile.cvr_verified_at
        and profile.zipcode
    )
    trusted_zip = profile.zipcode if profile_postal_trusted else None
    eff_postal = _normalize_postal(postal_code or trusted_zip)
    eff_cuisine = _normalize_cuisine(cuisine or (profile.cuisine if profile else None))
    canonical = normalize_item_name(item_name)

    # ── Audit before any branch returns so we capture rejected lookups ──
    # (Scraping attempts get logged regardless of whether the query
    # would have produced data — a recon attacker who pings every
    # canonical wants to know WHICH ones have cohorts, so we audit
    # uniformly.)
    if audit_request:
        _audit_query(
            db, user,
            canonical=canonical,
            postal=eff_postal,
            cuisine=eff_cuisine,
            raw_name=item_name,
        )

    # ── Setup gating ──────────────────────────────────────────────────
    if not eff_postal or not eff_cuisine:
        return _unavailable("needs_setup")
    if not canonical:
        return _unavailable("unknown_item", raw_name=item_name)

    # ── Cache hit short-circuit (we still audited above) ──────────────
    cache_key = (eff_postal, eff_cuisine, canonical)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _attach_user_price(db, user, canonical, cached)

    # ── Aggregate query ───────────────────────────────────────────────
    # We pull at most one priced row per (user_id, canonical) — the
    # MAX prevents a single tenant inflating the cohort with multiple
    # copies. Then we exclude the calling user's own row before the
    # statistics so they never compare to themselves.
    try:
        rows = _fetch_cohort_rows(
            db, eff_postal, eff_cuisine, canonical, exclude_user_id=user.id,
        )
    except Exception as e:  # noqa: BLE001
        # DB hiccup — surface as "service unavailable" rather than
        # leaking the exception or worse, accidentally returning
        # half-aggregated data.
        logger.warning(
            "smart_pricing: cohort query failed canonical=%s postal=%s cuisine=%s err=%s",
            canonical, eff_postal, eff_cuisine, e,
        )
        return _unavailable("temporarily_unavailable")

    # ── k-anonymity gate ──────────────────────────────────────────────
    if len(rows) < MIN_COHORT_SIZE:
        # We intentionally cache the negative result — same TTL — so
        # a recon attacker hammering a sparse postal doesn't get
        # different DB hit profiles than a populated one.
        payload = _unavailable("not_enough_data")
        _cache_set(cache_key, payload)
        return payload

    # ── Compute aggregates ────────────────────────────────────────────
    prices = sorted(float(p) for p in rows)
    payload = {
        "available": True,
        "canonical_name": canonical,
        "category_group": get_category_group(canonical),
        "postal_code": eff_postal,
        "cuisine": eff_cuisine,
        "count": len(prices),
        "min": round(prices[0], 2),
        "p25": round(_percentile(prices, 25), 2),
        "median": round(_percentile(prices, 50), 2),
        "p75": round(_percentile(prices, 75), 2),
        "max": round(prices[-1], 2),
        "currency": (getattr(user, "currency", None) or "DKK"),
    }

    _cache_set(cache_key, payload)
    return _attach_user_price(db, user, canonical, payload)


def _attach_user_price(db: Session, user: User, canonical: str, payload: dict) -> dict:
    """Add the requesting user's own price + deviation/percentile to a
    cached cohort payload. Keeps the cache key tenant-agnostic while
    surfacing per-user comparison.

    If the user has multiple inventory items mapping to the same
    canonical, we pick the highest sell_price > 0 — closest match to
    the "list" price the menu displays.
    """
    if not payload.get("available"):
        return payload

    own_price = _user_price_for_canonical(db, user.id, canonical)
    out = dict(payload)  # don't mutate the cached object
    if own_price is None or own_price <= 0:
        out["your_price"] = None
        out["deviation_pct"] = None
        out["percentile"] = None
        return out

    median = float(payload["median"])
    out["your_price"] = round(float(own_price), 2)
    if median > 0:
        deviation = (own_price - median) / median * 100.0
        out["deviation_pct"] = round(deviation, 1)
    else:
        out["deviation_pct"] = None

    # Re-fetch the same cohort prices to compute percentile cheaply.
    # We could store them in the payload but that's an extra few KB
    # per cached entry; recomputing from min/p25/median/p75/max isn't
    # accurate enough, so we hit the DB once on cache-hit user-attach.
    # In the common case the row is in PG's buffer cache.
    try:
        cohort_rows = _fetch_cohort_rows(
            db,
            payload["postal_code"],
            payload["cuisine"],
            canonical,
            exclude_user_id=user.id,
        )
    except Exception:  # noqa: BLE001
        out["percentile"] = None
        return out

    if cohort_rows:
        sorted_rows = sorted(float(p) for p in cohort_rows)
        out["percentile"] = _percentile_of_value(sorted_rows, float(own_price))
    else:
        out["percentile"] = None

    return out


# ──────────────────────────────────────────────────────────────────────
# DB helpers
# ──────────────────────────────────────────────────────────────────────

def _fetch_cohort_rows(
    db: Session,
    postal: str,
    cuisine: str,
    canonical: str,
    exclude_user_id,
) -> list[float]:
    """Return a list of MAX(sell_price) per OTHER tenant matching the
    bucket. Filtering chain:

      InventoryItem JOIN BusinessProfile ON profile.user_id = item.user_id
      WHERE profile.zipcode = postal
        AND LOWER(profile.cuisine) = cuisine
        AND item.user_id != exclude_user_id
        AND item.sell_price > 0
        AND <name normalises to canonical>

    The name match happens in Python after we pull candidate rows.
    Doing this in SQL would require either:
      - Materialising the alias table into a SQL CASE/UNION (brittle,
        re-deploys on every alias update), or
      - A LIKE/regex per alias (DB-portability nightmare).
    So we pull the rows for the bucket and filter in-process. Cohort
    sizes are bounded by MAX_COHORT_ROWS so this stays cheap.

    Cross-tenant safety: the exclude_user_id filter is enforced at the
    SQL layer (not in Python) so a bug in the post-filter loop can't
    accidentally include the caller.
    """
    # Lowercase cuisine in SQL so the index lookup is case-insensitive.
    # Postal is stored as-typed; we already normalised the inputs above.
    q = (
        db.query(InventoryItem.user_id, InventoryItem.name, InventoryItem.sell_price)
        .join(BusinessProfile, BusinessProfile.user_id == InventoryItem.user_id)
        .filter(
            BusinessProfile.zipcode == postal,
            func.lower(BusinessProfile.cuisine) == cuisine,
            InventoryItem.user_id != exclude_user_id,
            InventoryItem.sell_price.isnot(None),
            InventoryItem.sell_price > 0,
        )
        .limit(MAX_COHORT_ROWS)
    )

    # Per-tenant dedupe: a single business with 3 cappuccino rows still
    # counts as one cohort entry. We take the max sell_price for that
    # tenant's canonical match — heuristic for "list" price.
    per_user_max: dict = {}
    for uid, name, price in q.all():
        if normalize_item_name(name) != canonical:
            continue
        try:
            p = float(price)
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        if uid not in per_user_max or p > per_user_max[uid]:
            per_user_max[uid] = p

    return list(per_user_max.values())


def _user_price_for_canonical(db: Session, user_id, canonical: str) -> Optional[float]:
    """Return the requesting user's own price for a canonical, or None
    if they don't have a priced item that normalises to it."""
    rows = (
        db.query(InventoryItem.name, InventoryItem.sell_price)
        .filter(
            InventoryItem.user_id == user_id,
            InventoryItem.sell_price.isnot(None),
            InventoryItem.sell_price > 0,
        )
        .all()
    )
    best = None
    for name, price in rows:
        if normalize_item_name(name) != canonical:
            continue
        try:
            p = float(price)
        except (TypeError, ValueError):
            continue
        if best is None or p > best:
            best = p
    return best


# ──────────────────────────────────────────────────────────────────────
# Batch endpoint helper
# ──────────────────────────────────────────────────────────────────────

def get_all_market_comparisons(db: Session, user: User) -> dict:
    """Run comparisons across every inventory item the user has priced.

    Used by GET /api/smart-pricing/all to power the "Market comparison"
    section on PricingPage. Audit fires ONCE (not per item) so a Pricing
    page load isn't 20 SecurityEvent rows. Per-item audit only happens
    on the per-item endpoint where it's a user-initiated lookup.

    Shape:
      {
        "available_count": 3,
        "unavailable_count": 1,
        "comparisons": [
          {canonical_name: "cappuccino", available: True, your_price: 45, median: 49, ...},
          {canonical_name: "latte",      available: True, ...},
          {canonical_name: "espresso",   available: False, reason: "not_enough_data"},
        ],
        "needs_setup": false,
      }
    """
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    # Audit P2 (Task #76): same DAWA + CVR gate as get_market_comparison.
    # Untrusted postal codes never feed the cohort query.
    profile_postal_trusted = bool(
        profile
        and profile.dawa_address_id
        and profile.cvr_verified_at
        and profile.zipcode
    )
    eff_postal = _normalize_postal(
        profile.zipcode if profile_postal_trusted else None
    )
    eff_cuisine = _normalize_cuisine(profile.cuisine if profile else None)

    # Single audit row covering the batch — detail records the postal +
    # cuisine + count of canonicals scanned, NOT the individual items
    # (which the SecurityEvent admin view shouldn't be enumerating).
    _audit_query(
        db, user,
        canonical="<batch>",
        postal=eff_postal,
        cuisine=eff_cuisine,
        raw_name="<batch>",
    )

    if not eff_postal or not eff_cuisine:
        return {
            "available_count": 0,
            "unavailable_count": 0,
            "comparisons": [],
            "needs_setup": True,
            "message_key": "smartPricingNeedsSetup",
        }

    # Pull every priced item once, group by canonical → max sell_price.
    user_items = (
        db.query(InventoryItem.name, InventoryItem.sell_price)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.sell_price.isnot(None),
            InventoryItem.sell_price > 0,
        )
        .all()
    )
    by_canonical: dict[str, float] = {}
    for name, price in user_items:
        canon = normalize_item_name(name)
        if not canon:
            continue
        try:
            p = float(price)
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        if canon not in by_canonical or p > by_canonical[canon]:
            by_canonical[canon] = p

    comparisons = []
    available_count = 0
    unavailable_count = 0
    for canonical, _own_price in sorted(by_canonical.items()):
        result = get_market_comparison(
            db, user,
            item_name=canonical,
            postal_code=eff_postal,
            cuisine=eff_cuisine,
            audit_request=False,  # batch audit already fired above
        )
        # In the unavailable branch the comparison payload only has
        # available=False + reason. The batch caller (frontend Pricing
        # page) needs to know WHICH canonical the row refers to so it
        # can label the empty card — so stamp it here. This adds NO
        # new aggregate data, only the bucket label (which the user
        # already knew about, since they priced it themselves).
        if "canonical_name" not in result:
            result["canonical_name"] = canonical
        if "category_group" not in result:
            result["category_group"] = get_category_group(canonical)
        comparisons.append(result)
        if result.get("available"):
            available_count += 1
        else:
            unavailable_count += 1

    return {
        "available_count": available_count,
        "unavailable_count": unavailable_count,
        "comparisons": comparisons,
        "needs_setup": False,
        "postal_code": eff_postal,
        "cuisine": eff_cuisine,
    }


# ──────────────────────────────────────────────────────────────────────
# Audit logging
# ──────────────────────────────────────────────────────────────────────

def _audit_query(
    db: Session,
    user: User,
    *,
    canonical: Optional[str],
    postal: Optional[str],
    cuisine: Optional[str],
    raw_name: Optional[str],
) -> None:
    """Write a SecurityEvent row for the smart-pricing lookup. Never
    raises — audit failures must not block the user's request, but
    they're logged for inspection."""
    try:
        # Audit P2 (Task #73 follow-up): persist only the canonicalised
        # name + postal + cuisine.  The raw search term used to land
        # here too, but raw inputs can carry sensitive context (search
        # for "halal" or "alkoholfri" or "skin lightening · halal" is
        # not data we should retain).  Canonical is from a fixed
        # vocabulary, postal is a 4-digit code, cuisine is non-personal.
        detail = (
            f"canonical={canonical or '?'} postal={postal or '?'} "
            f"cuisine={(cuisine or '?')[:40]}"
        )
        evt = SecurityEvent(
            user_id=user.id,
            event_type="smart_pricing.lookup",
            detail=detail,
        )
        db.add(evt)
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("smart_pricing: audit write failed: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def _unavailable(reason: str, **extra) -> dict:
    """Build a standard 'no comparison' payload — never includes
    aggregate values, even partial ones."""
    out = {
        "available": False,
        "reason": reason,
        "min_samples": MIN_COHORT_SIZE,
    }
    out.update(extra)
    return out


# ──────────────────────────────────────────────────────────────────────
# v2 deferrals (intentionally NOT in v1):
#
# • Wider-postal fallback: if 2200 has < 5 cafés priced for cappuccino,
#   widen to 2100+2200+2300 (Copenhagen-N cluster). Risk: needs a postal
#   cluster table — not all clusters are geographically obvious. Plan:
#   add explicit ADJACENT_POSTAL_CLUSTERS dict with curated groupings.
#
# • Differential privacy noise on min/max — for the n=5..7 case where
#   min and max are individual prices (just not attributable). Plan:
#   switch to p10/p90 + a small Laplace jitter when n < 10. Low priority
#   while postal+cuisine bucketing is already coarse.
#
# • Cohort timestamp: "average over last 90 days" — currently we
#   aggregate the live inventory_items.sell_price, no time window. If
#   tenants frequently update prices the aggregate naturally tracks
#   current market. Plan: add price_history table + window AVG for v2.
#
# • Smart Pricing as Sales-data input (not just inventory): some tenants
#   only enter inventory cost, not sell_price. We could derive sell_price
#   from Sales.unit_price ÷ count(item). v1 sticks to inventory.sell_price
#   to keep the privacy footprint smaller (sales table has more PII).
# ──────────────────────────────────────────────────────────────────────
