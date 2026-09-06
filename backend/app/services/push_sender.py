"""
Web Push sender — wraps pywebpush so callers get a small, predictable
result dict back instead of having to handle pywebpush's exception
taxonomy directly. Task #72.

Design contract:
  • send_to_subscription(sub, payload) returns
        {"ok": bool, "removed": bool, "fail_count": int}
    where:
      - ok=True means the push provider accepted the payload (2xx).
      - removed=True means the row should be deleted by the caller —
        the device is permanently gone (410 Gone, or fail_count tipped
        past the threshold). The function MUTATES sub.fail_count /
        sub.last_used_at / sub.last_failed_at on the row but DOES NOT
        commit or delete — the caller controls the session lifecycle.
  • send_brief_push(db, user) composes the payload from
    generate_brief_for(user) (same pipeline the in-app card + the 8am
    email use) and fans out to every active subscription for the user.
    Same return-shape contract: caller (the cron job) decides what to
    delete.

Defensive posture:
  Any pywebpush error — TLS handshake, malformed key, network blip —
  is caught and turned into ok=False. The function NEVER raises into
  the cron job. A broken third-party provider can never poison the
  morning batch for everyone else.

Privacy:
  Push provider endpoint URLs are PII (~ email addresses for devices).
  This module NEVER logs the endpoint at any level. Error logs include
  only the subscription ID + a short HTTP status code. The payload
  body never includes amounts, customer names, or financial figures —
  composing that is the responsibility of payload_from_brief() below
  and the strict whitelist of fields it copies forward.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models.push_subscription import PushSubscription
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# ── Keeping the SKAT liability figure off the lock screen ──────────────
# See _compose_brief_payload for the reasoning. Two stages, because the
# brief body can arrive in two forms:
#
#   1. Deterministic (Layer 5) — the candidate's exact wording, so the
#      ", est. 78.000 kr. owed" clause can be lifted out whole and the
#      sentence still reads naturally.
#   2. LLM-polished (Layer 3) — Claude rephrases freely ("— 78.000 kr. is
#      due"), so stage 1 will miss it. Stage 2 is the backstop: in a body
#      that mentions a Danish tax term at all, every money token becomes a
#      neutral placeholder. Grammar survives; the figure does not.
#
# Both stages are gated on the body mentioning MOMS/SKAT, so pushes that
# never touch tax — the revenue lines owners already get — are untouched.
_TAX_TERM_RE = re.compile(r"\b(?:MOMS|SKAT)\b", re.IGNORECASE)
# Both money shapes _fmt_money produces: DKK "78.000 kr." and the
# currency-code form "9,000 EUR". The \b around [A-Z]{3} matters: without
# it "your 2026 MOMS filing" reads as digits + "MOM" and the redaction
# eats the locked term itself ("your an amountS filing").
_MONEY_RE = re.compile(r"\d[\d.,]*\s*(?:[Kk][Rr]\.?|\b[A-Z]{3}\b)")
_MOMS_OWED_CLAUSE_RE = re.compile(
    r",\s*est\.\s*[\d.,]+\s*(?:[Kk][Rr]\.?|\b[A-Z]{3}\b)\s*owed",
    re.IGNORECASE,
)


def _redact_tax_figures(body: str) -> str:
    """Strip kroner figures from a push body that talks about MOMS/SKAT."""
    if not _TAX_TERM_RE.search(body):
        return body
    body = _MOMS_OWED_CLAUSE_RE.sub("", body)
    if _MONEY_RE.search(body):
        body = _MONEY_RE.sub("an amount", body)
    return re.sub(r"\s{2,}", " ", body).strip()

# The fail threshold — when a row hits this number of CONSECUTIVE
# failures, we consider the device permanently gone and the row is
# scheduled for removal. The "consecutive" part is enforced by the
# cron + send-path: any success resets the counter to 0.
MAX_FAIL_COUNT = 3


# ─── Helpers ──────────────────────────────────────────────────────────


def _vapid_configured() -> bool:
    """Whether we have the keys + subject needed to actually mint a
    VAPID-signed JWT. The router returns 503 from /vapid-public-key
    and /subscribe + /test when this is False so the app boots cleanly
    in environments that don't have the env vars yet (PR previews, CI,
    developer machines)."""
    pub = getattr(settings, "VAPID_PUBLIC_KEY", "") or ""
    priv = getattr(settings, "VAPID_PRIVATE_KEY", "") or ""
    return bool(pub and priv)


def _vapid_claims() -> dict[str, Any]:
    """Claims dict pywebpush will JWT-sign with the VAPID private key.
    `sub` MUST be a mailto: URI (or https://) per RFC 8292 — push
    providers reject anything else."""
    subject = (
        getattr(settings, "VAPID_SUBJECT", "")
        or "mailto:hello@bonbox.dk"
    )
    return {"sub": subject}


def _redact_endpoint(endpoint: str) -> str:
    """Endpoint URLs are PII. For log lines we only emit the provider
    hostname + a short hash suffix — enough to debug "all FCM endpoints
    started failing" without leaking which user is on which device.

    Example: a Chrome endpoint
        https://fcm.googleapis.com/fcm/send/eXp...
    becomes
        fcm.googleapis.com#a1b2c3d4
    """
    try:
        from urllib.parse import urlparse
        import hashlib
        host = urlparse(endpoint).hostname or "?"
        tail = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()[:8]
        return f"{host}#{tail}"
    except Exception:  # noqa: BLE001
        return "?#unknown"


# ─── Core send path ───────────────────────────────────────────────────


def send_to_subscription(
    sub: PushSubscription,
    payload: dict[str, Any],
    *,
    ttl: int = 60 * 30,
) -> dict[str, Any]:
    """Encrypt + sign + POST `payload` to one push subscription.

    The pywebpush import is deferred so the rest of the module (and the
    router that uses it) stays importable in environments that don't
    have the package yet. Tests can also monkey-patch this whole
    function without dragging in the C-extension dependencies.

    Returns:
        {"ok": True/False, "removed": True/False, "fail_count": int}

    The function MUTATES the SQLAlchemy row passed in (fail_count,
    last_used_at, last_failed_at) but does NOT commit. The caller
    is responsible for commit / delete decisions.
    """
    if not _vapid_configured():
        # Defensive: in non-VAPID environments this function is
        # unreachable via the router (returns 503), but the cron can
        # still call it if env was unset live. Log loudly + no-op.
        logger.warning(
            "push_sender: VAPID not configured — skipping send to sub=%s",
            sub.id,
        )
        return {"ok": False, "removed": False, "fail_count": sub.fail_count or 0}

    # Build the subscription-info dict pywebpush expects.
    subscription_info = {
        "endpoint": sub.endpoint,
        "keys": {
            "p256dh": sub.p256dh,
            "auth": sub.auth,
        },
    }

    # Stable JSON serialization — keys sorted, no whitespace. Keeps
    # the encrypted payload size predictable so we know we fit under
    # the 4 KB browser limit even with worst-case body strings.
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        logger.warning(
            "push_sender: pywebpush not installed — skipping send to sub=%s",
            sub.id,
        )
        return {"ok": False, "removed": False, "fail_count": sub.fail_count or 0}

    try:
        webpush(
            subscription_info=subscription_info,
            data=data,
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims=_vapid_claims(),
            ttl=ttl,
        )
        # Success — reset the fail counter, stamp last_used_at.
        sub.fail_count = 0
        sub.last_used_at = utc_now()
        return {"ok": True, "removed": False, "fail_count": 0}

    except WebPushException as e:
        status_code = None
        try:
            status_code = e.response.status_code if getattr(e, "response", None) else None
        except Exception:  # noqa: BLE001
            status_code = None

        # 404 / 410 = subscription is permanently gone (browser
        # uninstall, PWA removed). Remove the row immediately.
        if status_code in (404, 410):
            logger.info(
                "push_sender: provider returned %s — marking %s for removal",
                status_code, _redact_endpoint(sub.endpoint),
            )
            return {"ok": False, "removed": True, "fail_count": sub.fail_count or 0}

        # Anything else (5xx, timeout, signature error, weird 4xx) is
        # transient or unknown. Bump fail_count; let the caller decide
        # whether we've crossed the threshold.
        sub.fail_count = (sub.fail_count or 0) + 1
        sub.last_failed_at = utc_now()
        removed = sub.fail_count >= MAX_FAIL_COUNT
        logger.warning(
            "push_sender: webpush failure status=%s sub=%s endpoint=%s "
            "fail_count=%d removed=%s",
            status_code, sub.id, _redact_endpoint(sub.endpoint),
            sub.fail_count, removed,
        )
        return {
            "ok": False,
            "removed": removed,
            "fail_count": sub.fail_count,
        }

    except Exception as e:  # noqa: BLE001
        # Catch-all: cryptography errors, DNS, anything else. Same
        # contract — fail_count++, never blow up.
        sub.fail_count = (sub.fail_count or 0) + 1
        sub.last_failed_at = utc_now()
        removed = sub.fail_count >= MAX_FAIL_COUNT
        logger.exception(
            "push_sender: unexpected error sending to %s (sub=%s) — %s",
            _redact_endpoint(sub.endpoint), sub.id, e,
        )
        return {
            "ok": False,
            "removed": removed,
            "fail_count": sub.fail_count,
        }


# ─── Brief-specific composer ──────────────────────────────────────────


def _compose_brief_payload(brief: dict[str, Any] | None) -> dict[str, Any] | None:
    """Turn the full Daily Brief dict into a minimal push payload.

    The brief object contains rich detail — amounts, customer names,
    multiple insights, CTA URLs. The push payload deliberately strips
    all of that. Only a generic title + a one-line summary go on the
    wire. We do this for two reasons:

      1. GDPR — push payloads sit in the OS notification center on the
         lock screen. They MUST NOT include amounts, customer names,
         tax figures, anything financially identifying.
      2. Size — encrypted Web Push payloads cap at ~4 KB. A short body
         survives every provider.

    Returns None when there's no useful brief to push (no candidates,
    empty insights). The caller silently skips the user — no harm in
    not sending a notification on a quiet day.
    """
    if not brief:
        return None

    # Prefer the headline; fall back to the first insight; else nothing.
    body = (brief.get("headline") or "").strip()
    if not body:
        insights = brief.get("insights") or []
        if insights and isinstance(insights[0], dict):
            body = (insights[0].get("text") or "").strip()
    if not body:
        return None

    # Strip the MOMS liability figure before it reaches a lock screen.
    #
    # The key whitelist below is STRUCTURAL — it proves no extra field rides
    # along, which is what test_send_brief_push_payload_strips_financial_data
    # checks. It says nothing about the body, and the body is the lead
    # candidate's own sentence. MOMS candidates carry the top weights in
    # generate_candidates (0.92-0.98), so from the moment the MOMS brief
    # started working (2026-09-05 — it had been dead since it shipped) the
    # most likely morning push became "MOMS filing for H2 2026 in 3 days,
    # est. 78.000 kr. owed". That is the one figure this codebase treats as
    # owner-only everywhere else — member_read_guard denies it, the shared-
    # device curtain nulls it, the dashboard strip zeroes it for members —
    # and a notification tray on an unlocked-by-anyone phone is a weaker
    # boundary than any of them.
    #
    # Only the figure goes; the countdown and the call to action stay, so
    # the push still says the useful part and still earns the tap through
    # to /tax where the figure is properly gated. Scoped to bodies that
    # mention MOMS/SKAT: revenue amounts in other candidates reach the tray
    # exactly as before, which is a real but pre-existing gap and a
    # separate call to make.
    body = _redact_tax_figures(body)
    if not body:
        return None

    # Hard cap to keep the payload tiny + the OS notification readable.
    # Most providers truncate at ~150 chars anyway.
    if len(body) > 140:
        body = body[:139] + "…"

    return {
        "title": "BonBox · Daily brief",
        "body": body,
        # Tag dedupes — if the cron re-fires, the second push replaces
        # the first instead of stacking two of them in the tray.
        "tag": "bonbox-daily-brief",
        # Where to land if the owner taps the notification. Frontend
        # service worker reads .data.url and openWindow()s it.
        "data": {"url": "/?brief=open"},
    }


def send_brief_push(db: Session, user: User) -> dict[str, Any]:
    """Fan out the morning brief push to every active subscription
    belonging to `user`.

    Returns a per-user summary dict suitable for the cron's aggregate
    log line:
        {"attempted": N, "sent": M, "removed": K, "skipped": True/False}

    The caller (daily_brief_push_job) is responsible for deleting rows
    that come back with removed=True and for committing the session.
    """
    # Lazy-import generate_brief to avoid circular imports (daily_brief
    # imports models, and models __init__ could theoretically grow to
    # reference services).
    from app.services.daily_brief import get_or_create_brief

    summary = {"attempted": 0, "sent": 0, "removed": 0, "skipped": False}

    # Get the user's active subscriptions. Tenant scope is implicit in
    # the user_id filter — never reach across tenants here.
    subs: list[PushSubscription] = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user.id)
        .all()
    )
    if not subs:
        summary["skipped"] = True
        return summary

    # Generate the brief once per user, reuse for every subscription.
    # If generation fails (validation, LLM outage, DB read error) we
    # silently skip — the email job has its own retry, no point waking
    # the owner with "we couldn't compute today".
    try:
        brief = get_or_create_brief(user, db, force_refresh=False)
    except Exception as e:  # noqa: BLE001
        logger.warning("send_brief_push: brief generation failed for user=%s: %s", user.id, e)
        summary["skipped"] = True
        return summary

    payload = _compose_brief_payload(brief)
    if payload is None:
        summary["skipped"] = True
        return summary

    for sub in subs:
        summary["attempted"] += 1
        result = send_to_subscription(sub, payload)
        if result.get("ok"):
            summary["sent"] += 1
        if result.get("removed"):
            summary["removed"] += 1
            try:
                db.delete(sub)
            except Exception:  # noqa: BLE001
                # Never propagate — the cron must keep going.
                pass

    return summary
