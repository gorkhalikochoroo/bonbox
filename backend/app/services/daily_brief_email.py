"""Daily Brief — morning email digest (Task #54).

Strategic role: turns BonBox from "an app you open" into "an advisor
that arrives". At 06:30 UTC every day (≈ 07:30–08:30 Copenhagen
depending on CET/CEST) the SAME brief that's on /dashboard lands in
the owner's inbox — same insights, same CTA buttons (deep-linked back
to the app), same shareable footer. The forward-to-co-founder viral
moment now happens in their mail client, not just in-app.

Architectural invariants:
  • Brief content comes from get_or_create_brief() — the EXACT same
    pipeline the in-app card uses. Screen and email cannot drift.
  • HTML is inline-styled. <style> tags get stripped by most clients
    (Gmail web in particular); inline `style="…"` survives everywhere
    we've tested (Apple Mail iOS/macOS, Gmail web/iOS, Outlook).
  • Idempotency lives on the User row (last_brief_emailed_at). The
    cron and the manual /send-now endpoint both honour it — same-day
    re-sends are skipped silently.
  • Per-user errors are isolated. One bad row never poisons the batch.
  • Audit trail via audit_service.record (action='daily_brief.email_sent'
    or 'daily_brief.email_failed') — system actor, no IP.
  • Free tier IS included. This is a retention lever, not an upsell.
    has_feature(user, 'daily_brief_email') gates it so we can later
    flip Free off via the matrix without code changes here.
"""
from __future__ import annotations

import html as _html
import logging
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.user import User
from app.services import audit_service
from app.services.billing import has_feature
from app.services.daily_brief import get_or_create_brief
from app.services.email_service import send_email
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# Public-app base URL — used to deep-link CTAs to the live web app
# ─────────────────────────────────────────────────────────────────
# Read at call time (not module import) so tests can monkey-patch the
# env after this module has been imported. Default to bonbox.dk.
def _app_base_url() -> str:
    import os
    return (os.getenv("PUBLIC_APP_URL") or "https://app.bonbox.dk").rstrip("/")


# ─────────────────────────────────────────────────────────────────
# Palette — warm-stone + emerald, matches the app's brand
# ─────────────────────────────────────────────────────────────────
# Inline-styled hex codes. No CSS variables (clients strip them).
_PALETTE = {
    "bg": "#fafaf9",            # stone-50
    "card_bg": "#ffffff",
    "border": "#e7e5e4",        # stone-200
    "ink": "#1c1917",           # stone-900
    "muted": "#78716c",         # stone-500
    "subtle": "#a8a29e",        # stone-400
    "brand": "#059669",         # emerald-600
    "brand_dark": "#047857",    # emerald-700
    "brand_bg": "#ecfdf5",      # emerald-50
    "win": "#22c55e",
    "watch": "#f59e0b",
    "action": "#3b82f6",
}


def _dot_color(insight_type: str | None) -> str:
    if insight_type == "win":
        return _PALETTE["win"]
    if insight_type == "watch":
        return _PALETTE["watch"]
    if insight_type == "action":
        return _PALETTE["action"]
    return _PALETTE["subtle"]


def _safe(s: Any) -> str:
    """HTML-escape any string we render. Brief content is server-
    generated + validated (no user-supplied free text reaches here)
    but defense-in-depth: escape anyway in case a candidate text ever
    grows to include a < character (e.g. inventory item name with a
    typo). Same posture as our PDF templates."""
    if s is None:
        return ""
    return _html.escape(str(s), quote=True)


def _safe_cta_path(url: Any) -> str | None:
    """Mirror of DailyBriefCard's _safeCtaPath — only allow in-app
    paths starting with a single slash. Defense vs. malformed candidate
    rows (none today; future-proofing). Returns None for anything
    that isn't a safe relative path so we can omit the button."""
    if not isinstance(url, str):
        return None
    if not url.startswith("/") or url.startswith("//"):
        return None
    if "javascript:" in url.lower() or "data:" in url.lower():
        return None
    return url


# ─────────────────────────────────────────────────────────────────
# Localized date label
# ─────────────────────────────────────────────────────────────────
# We reuse brief['date_label'] from the brief payload when present;
# fallback to today's UTC date so the email always has SOMETHING.
def _subject_date_label(brief: dict | None) -> str:
    if brief and brief.get("date_label"):
        return str(brief["date_label"])
    # Fallback — server's UTC date in a friendly format.
    today = date.today()
    return f"{today.strftime('%A')} · {today.day} {today.strftime('%b')}"


# ─────────────────────────────────────────────────────────────────
# HTML render
# ─────────────────────────────────────────────────────────────────

def _button(label: str, href: str, *, primary: bool = True) -> str:
    """Inline-styled button. We use a <table> wrapper because Outlook
    on Windows treats CSS borders on <a> as 0px in some renders; a
    table cell with bgcolor + padding is bulletproof."""
    bg = _PALETTE["brand"] if primary else _PALETTE["card_bg"]
    fg = "#ffffff" if primary else _PALETTE["brand_dark"]
    border = _PALETTE["brand"] if primary else _PALETTE["border"]
    return (
        f'<table role="presentation" cellspacing="0" cellpadding="0" border="0" '
        f'style="display:inline-block;margin:0;"><tr>'
        f'<td bgcolor="{bg}" style="background-color:{bg};border:1px solid {border};'
        f'border-radius:8px;padding:10px 18px;">'
        f'<a href="{_safe(href)}" target="_blank" '
        f'style="color:{fg};text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'
        f'Segoe UI,Roboto,sans-serif;font-size:14px;font-weight:600;line-height:1;display:inline-block;">'
        f'{_safe(label)}</a>'
        f'</td></tr></table>'
    )


def _insight_li(ins: dict, app_url: str) -> str:
    text = _safe(ins.get("text") or "")
    color = _dot_color(ins.get("type"))
    cta_path = _safe_cta_path(ins.get("cta_url"))
    cta_label = _safe(ins.get("cta_label") or "Open")

    cta_html = ""
    if cta_path:
        cta_html = (
            f'<div style="margin-top:6px;">'
            f'<a href="{_safe(app_url + cta_path)}" target="_blank" '
            f'style="color:{_PALETTE["brand_dark"]};text-decoration:none;font-weight:600;'
            f'font-size:13px;">{cta_label} →</a>'
            f"</div>"
        )

    return (
        f'<tr><td style="padding:8px 0;vertical-align:top;">'
        f'<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">'
        f'<tr>'
        f'<td valign="top" width="14" style="padding-top:7px;">'
        f'<div style="width:8px;height:8px;border-radius:50%;background-color:{color};"></div>'
        f"</td>"
        f'<td valign="top" style="padding-left:10px;color:{_PALETTE["ink"]};'
        f'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
        f'font-size:15px;line-height:1.55;">{text}{cta_html}</td>'
        f"</tr></table></td></tr>"
    )


def _build_unsubscribe_url(user: User) -> str:
    """Mint a signed one-click unsubscribe URL for this user + the
    daily_brief topic.  Task #108.

    Routes to the BACKEND host (api.bonbox.dk) so the public endpoint
    handles it without a frontend hop — Gmail's one-click POST goes
    straight to the same URL.  Token has a 30-day TTL.
    """
    import os
    from app.config import settings
    from app.utils.email_unsubscribe_token import make_unsubscribe_token
    # Prefer an explicit API base URL when set; otherwise reuse the
    # AIIA_REDIRECT_URI host (which we know points at the API), and
    # finally fall back to FRONTEND_URL (dev/local).  This keeps
    # operators from needing yet another env var in prod when the
    # rest of the API URL config is already correct.
    api_base = (
        os.environ.get("PUBLIC_API_URL")
        or _api_base_from_redirect()
        or settings.FRONTEND_URL
    ).rstrip("/")
    token = make_unsubscribe_token(str(user.id), "daily_brief")
    return f"{api_base}/api/email/unsubscribe?token={token}"


def _api_base_from_redirect() -> str | None:
    """Derive the API host from AIIA_REDIRECT_URI if it's set — saves
    one env var in production.  Returns None when no helpful hint."""
    import os
    from urllib.parse import urlparse
    redirect = os.environ.get("AIIA_REDIRECT_URI") or ""
    if not redirect:
        return None
    try:
        parsed = urlparse(redirect)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:  # noqa: BLE001
        pass
    return None


def build_brief_html(brief_payload: dict, user: User) -> str:
    """Render the brief payload as an HTML email body.

    Mobile-first, inline-styled. ~120 lines. Keeps the same visual
    language as DailyBriefCard so the email feels like the same product.
    """
    app_url = _app_base_url()
    greeting = _safe(brief_payload.get("greeting") or "Today's brief")
    date_label = _safe(brief_payload.get("date_label") or "")
    headline = _safe(brief_payload.get("headline") or "")
    business_name = _safe(getattr(user, "business_name", "") or "")
    # Task #108: signed one-click unsubscribe URL.  Replaces the old
    # /profile#notifications anchor that required login (and a hash-
    # scroll that didn't always work).
    unsubscribe_url = _build_unsubscribe_url(user)

    # Headline CTA — same logic as the card
    headline_cta_path = _safe_cta_path(brief_payload.get("headline_cta_url"))
    headline_cta_label = brief_payload.get("headline_cta_label") or "Open"

    # Defensive dedup mirror — drop insights whose text matches the headline.
    # Backend already does this in _validate_llm_output but we mirror it here
    # so any cached brief generated before that fix shipped still renders clean.
    def _norm(s: str) -> str:
        return " ".join((s or "").lower().split())

    head_norm = _norm(brief_payload.get("headline") or "")
    raw_insights = brief_payload.get("insights") or []
    visible = [ins for ins in raw_insights if _norm(ins.get("text") or "") != head_norm]

    insights_rows = "".join(_insight_li(ins, app_url) for ins in visible)

    headline_cta_block = ""
    if headline_cta_path:
        headline_cta_block = (
            '<div style="margin:8px 0 18px 0;">'
            f'{_button(headline_cta_label, app_url + headline_cta_path, primary=False)}'
            "</div>"
        )

    # Insights table is omitted entirely on empty-state — same as the card
    insights_block = ""
    if insights_rows:
        insights_block = (
            '<table role="presentation" cellspacing="0" cellpadding="0" border="0" '
            'width="100%" style="margin-top:10px;">'
            f"{insights_rows}"
            "</table>"
        )

    open_app_button = _button("Open BonBox", app_url + "/dashboard", primary=True)

    # ── Footer (share + unsubscribe) ────────────────────────────────
    # We keep this minimal — the strategic value is the inbox arrival,
    # not aggressive CTAs. The unsubscribe deep-link uses a hash so the
    # profile page can scroll to the notifications section.
    footer = (
        f'<div style="margin-top:24px;padding-top:18px;border-top:1px solid {_PALETTE["border"]};'
        f'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
        f'font-size:12px;line-height:1.6;color:{_PALETTE["muted"]};">'
        f'<p style="margin:0 0 6px 0;">Forward this to your co-founder or accountant — '
        f"it's the same brief you'd see in BonBox this morning.</p>"
        f'<p style="margin:0;">'
        f'You\'re getting this because you turned on Daily Brief emails. '
        f'<a href="{_safe(unsubscribe_url)}" target="_blank" '
        f'style="color:{_PALETTE["brand_dark"]};text-decoration:underline;">Manage email preferences</a>.'
        "</p>"
        "</div>"
    )

    # ── Assemble document ──────────────────────────────────────────
    # The outer wrapper sets the page background; the inner table is
    # 600px wide max (the email-design standard since Outlook 2007).
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Today at BonBox</title>
</head>
<body style="margin:0;padding:0;background-color:{_PALETTE["bg"]};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="{_PALETTE["bg"]}" style="background-color:{_PALETTE["bg"]};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;width:100%;background-color:{_PALETTE["card_bg"]};border:1px solid {_PALETTE["border"]};border-radius:12px;">
      <tr><td style="padding:24px 24px 20px 24px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td valign="middle" style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:13px;font-weight:600;color:{_PALETTE["brand_dark"]};letter-spacing:0.06em;text-transform:uppercase;">BonBox</td>
            <td align="right" valign="middle" style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:12px;color:{_PALETTE["muted"]};">{date_label}</td>
          </tr>
        </table>
        <h1 style="margin:18px 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:22px;line-height:1.3;color:{_PALETTE["ink"]};font-weight:700;">{greeting}{(", " + business_name) if business_name else ""}</h1>
        <p style="margin:14px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.55;color:{_PALETTE["ink"]};">{headline}</p>
        {headline_cta_block}
        {insights_block}
        <div style="margin-top:24px;">
          {open_app_button}
        </div>
        {footer}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""


# ─────────────────────────────────────────────────────────────────
# Plain-text fallback — not all clients render HTML, and Resend
# attaches a text part automatically when set; we don't pass `text=`
# to Resend (the wrapper doesn't support it today). A future
# enhancement could add it — for now most clients render the HTML.
# ─────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────
# Idempotency helper
# ─────────────────────────────────────────────────────────────────

def _same_calendar_day_utc(a: datetime | None, b: datetime) -> bool:
    """True iff two datetimes fall on the same calendar day (UTC).
    Used by the idempotency check. `a` may be naive (legacy rows)
    in which case we treat it as UTC."""
    if a is None:
        return False
    a_aware = a if a.tzinfo else a.replace(tzinfo=timezone.utc)
    b_aware = b if b.tzinfo else b.replace(tzinfo=timezone.utc)
    return a_aware.date() == b_aware.date()


# ─────────────────────────────────────────────────────────────────
# Public API — send_brief_to_user
# ─────────────────────────────────────────────────────────────────

def send_brief_to_user(
    db: Session,
    user: User,
    *,
    force: bool = False,
) -> dict:
    """Send today's brief to the user via Resend.

    Pipeline (mirrors the in-app card):
      1. Entitlement check — has_feature(user, 'daily_brief_email')
      2. Preference check — user.daily_brief_email_enabled
      3. Idempotency — skip if last_brief_emailed_at is today (UTC).
         force=True bypasses (used by the /send-now test button so
         owners can verify the email looks right).
      4. get_or_create_brief(user, db) → identical payload to /dashboard
      5. build_brief_html → inline-styled HTML body
      6. send_email via Resend
      7. Stamp last_brief_emailed_at + audit log

    Returns a dict so callers (cron + endpoint) can aggregate metrics.
    Shape: {ok: bool, sent_at: iso8601|None, reason: str|None, error: str|None}

    Never raises — wrap in try/except internally so a single bad user
    can't crash the cron batch.
    """
    now = utc_now()
    result: dict[str, Any] = {
        "ok": False,
        "sent_at": None,
        "reason": None,
        "error": None,
    }
    try:
        # 1. Entitlement gate
        if not has_feature(user, "daily_brief_email"):
            result["reason"] = "feature_not_entitled"
            return result

        # 2. Preference gate
        if not getattr(user, "daily_brief_email_enabled", True):
            result["reason"] = "user_opted_out"
            return result

        # 2.5. Recipient sanity
        if not user.email or "@" not in user.email:
            result["reason"] = "invalid_email"
            return result

        # 3. Idempotency (skipped on force=True)
        if not force and _same_calendar_day_utc(getattr(user, "last_brief_emailed_at", None), now):
            result["reason"] = "already_sent_today"
            return result

        # 4. Brief payload — SAME pipeline as the screen
        brief = get_or_create_brief(user, db, force_refresh=False)

        # 5. Render
        html = build_brief_html(brief, user)
        date_label = _subject_date_label(brief)
        subject = f"Today at BonBox · {date_label}"

        # 6. Send — Task #108: include RFC 8058 List-Unsubscribe
        # headers so Gmail / Yahoo / Outlook 2024 inbox UIs can offer
        # one-click unsubscribe.  Without these, Gmail will degrade
        # sender reputation and eventually spam-folder the brief.
        unsubscribe_url = _build_unsubscribe_url(user)
        list_unsubscribe = f"<{unsubscribe_url}>, <mailto:unsubscribe@bonbox.dk>"
        unsubscribe_headers = {
            "List-Unsubscribe": list_unsubscribe,
            # RFC 8058: tells the inbox provider that POSTing the URL
            # with body "List-Unsubscribe=One-Click" will unsubscribe
            # — they'll show the inline Unsubscribe button.
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
        sent_ok = send_email(
            user.email, subject, html, headers=unsubscribe_headers,
        )
        if not sent_ok:
            result["error"] = "send_failed"
            audit_service.record(
                db,
                user=user.id,
                action="daily_brief.email_failed",
                entity_type="user",
                entity_id=user.id,
                after={"reason": "resend_returned_false", "to": user.email},
                actor_type="system.daily_brief_email",
            )
            db.commit()
            return result

        # 7. Stamp + audit. We persist BEFORE returning so the
        # idempotency check on a retry sees the success.
        user.last_brief_emailed_at = now
        audit_service.record(
            db,
            user=user.id,
            action="daily_brief.email_sent",
            entity_type="user",
            entity_id=user.id,
            after={
                "to": user.email,
                "subject": subject,
                "insight_count": len(brief.get("insights") or []),
                "ai_polished": bool(brief.get("ai_polished")),
                "tier": brief.get("tier"),
                "forced": bool(force),
            },
            actor_type="system.daily_brief_email",
        )
        db.commit()

        result["ok"] = True
        result["sent_at"] = now.isoformat()
        return result

    except Exception as e:  # noqa: BLE001
        # Never crash — log loudly, write a failed-audit row if we can,
        # and return a structured error. The caller (cron or endpoint)
        # decides whether to surface this to the user.
        logger.exception("daily_brief_email.send_brief_to_user failed: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        try:
            audit_service.record(
                db,
                user=user.id,
                action="daily_brief.email_failed",
                entity_type="user",
                entity_id=user.id,
                after={"error": type(e).__name__, "msg": str(e)[:200]},
                actor_type="system.daily_brief_email",
            )
            db.commit()
        except Exception:  # noqa: BLE001
            pass
        result["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        return result
