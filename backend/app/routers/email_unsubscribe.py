"""
Public email unsubscribe endpoint — Task #108.

GDPR Article 7(3) requires withdrawing consent to be as easy as
giving it.  Our previous footer link went to /profile#notifications
which required logging in first — that's not GDPR-compliant + Gmail
flags it as deceptive.  This router replaces that with:

  GET  /api/email/unsubscribe?token=…  → confirmation landing page
  POST /api/email/unsubscribe?token=…  → actually unsubscribe

Why split GET / POST:

  * Email link previewers (Gmail's link scanner, corporate proxies)
    GET every URL they see to scan for phishing.  If GET unsubscribed
    on its own, every owner would be silently unsubscribed within
    seconds of receiving the email.
  * The POST endpoint also implements RFC 8058 (one-click
    unsubscribe) — Gmail / Yahoo / Outlook will POST it directly
    when the user clicks "Unsubscribe" in their inbox UI.  The
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header in
    the email tells them to use this path.

Auth:
  * Both endpoints are PUBLIC — recipients have no session in their
    inbox.  Authentication = the HMAC signature on the token.
  * Token has 30-day TTL.  A leaked email archive can't be replayed
    forever; older emails get a polite "link expired" page that
    points back to /profile.

Audit:
  * Each successful unsubscribe is recorded in the audit log so an
    operator can trace "why isn't this user getting briefs anymore?"
    without re-deriving from email logs.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.services import audit_service
from app.utils.email_unsubscribe_token import parse_unsubscribe_token

logger = logging.getLogger(__name__)


# ─── Module ────────────────────────────────────────────────────────────


router = APIRouter()


# ─── Topic → User column mapping ──────────────────────────────────────


def _set_user_topic_off(user: User, topic: str) -> bool:
    """Flip the User's flag for `topic` to OFF.  Returns True if a
    row attribute was changed; False if the topic is unknown (we
    still surface a friendly success page in that case — never tell
    a recipient "we couldn't unsubscribe you" because they'll just
    mark as spam)."""
    if topic == "daily_brief":
        user.daily_brief_email_enabled = False
        return True
    # Future topics: extend here without touching the URL/token shape.
    logger.warning(
        "email_unsubscribe: unknown topic '%s' for user_id=%s — "
        "rendering success page anyway",
        topic, user.id,
    )
    return False


# ─── HTML responses ───────────────────────────────────────────────────


_PALETTE = {
    "bg": "#f8fafc",
    "card": "#ffffff",
    "border": "#e2e8f0",
    "muted": "#64748b",
    "ink": "#0f172a",
    "brand": "#10b981",
    "brand_dark": "#047857",
    "danger": "#dc2626",
}


def _page(title: str, body_html: str) -> str:
    """Wrap inner HTML in a clean centered card.  Inline-styled so
    the landing page doesn't need the SPA bundle to look reasonable —
    a recipient on the bus with bad signal still sees a polished
    confirmation, not a blank white screen waiting on JS."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{title} — BonBox</title>
  <link rel="icon" type="image/svg+xml" href="https://www.bonbox.dk/favicon.svg" />
</head>
<body style="margin:0;padding:0;background:{_PALETTE['bg']};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:{_PALETTE['ink']};">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;">
    <main style="background:{_PALETTE['card']};border:1px solid {_PALETTE['border']};border-radius:14px;max-width:480px;width:100%;padding:36px 28px;box-shadow:0 1px 2px rgba(15,23,42,.04);">
      <div style="font-size:13px;font-weight:600;color:{_PALETTE['brand_dark']};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;">BonBox</div>
      {body_html}
    </main>
  </div>
</body>
</html>"""


def _success_page(topic_label: str) -> str:
    return _page(
        "Unsubscribed",
        f"""
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px 0;line-height:1.3;">
          You're unsubscribed.
        </h1>
        <p style="font-size:15px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;">
          We'll stop sending you {topic_label}. The change is already saved on your account — no further action needed.
        </p>
        <p style="font-size:14px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;">
          Changed your mind? You can turn it back on any time from your <a href="https://www.bonbox.dk/profile#notifications" style="color:{_PALETTE['brand_dark']};text-decoration:underline;">profile settings</a>.
        </p>
        <p style="font-size:12px;color:{_PALETTE['muted']};margin:18px 0 0 0;">
          BonBox · GDPR-compliant · Cookies, data, complaint info → <a href="https://www.bonbox.dk/privacy" style="color:{_PALETTE['muted']};text-decoration:underline;">Privacy</a>
        </p>
        """,
    )


def _confirm_page(token: str, topic_label: str) -> str:
    """Shown on GET so link prefetchers don't accidentally unsubscribe.
    The button POSTs to the same endpoint, which actually does the
    deed.  The form action is the same URL with a hidden _method=POST
    so we don't depend on JS."""
    import html as _html
    safe_token = _html.escape(token)
    return _page(
        "Unsubscribe",
        f"""
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px 0;line-height:1.3;">
          Unsubscribe from {topic_label}?
        </h1>
        <p style="font-size:15px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;">
          Click the button below to stop receiving these emails. You'll keep your BonBox account — only the emails go away.
        </p>
        <form method="POST" action="/api/email/unsubscribe?token={safe_token}" style="margin:0 0 18px 0;">
          <button type="submit" style="display:inline-block;background:{_PALETTE['danger']};color:#fff;border:0;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;">
            Yes, unsubscribe me
          </button>
        </form>
        <p style="font-size:13px;color:{_PALETTE['muted']};margin:0;">
          Or <a href="https://www.bonbox.dk/profile#notifications" style="color:{_PALETTE['brand_dark']};text-decoration:underline;">manage all your email preferences</a> instead.
        </p>
        """,
    )


def _expired_page() -> str:
    return _page(
        "Link expired",
        f"""
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px 0;line-height:1.3;">
          This link has expired.
        </h1>
        <p style="font-size:15px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;">
          Unsubscribe links live for 30 days from the email send. To turn off Daily Brief emails, sign in and toggle them off under <a href="https://www.bonbox.dk/profile#notifications" style="color:{_PALETTE['brand_dark']};text-decoration:underline;">Profile → Notifications</a>.
        </p>
        <p style="font-size:13px;color:{_PALETTE['muted']};margin:0;">
          Trouble signing in? Email us at <a href="mailto:hello@bonbox.dk" style="color:{_PALETTE['brand_dark']};text-decoration:underline;">hello@bonbox.dk</a> — we'll unsubscribe you manually.
        </p>
        """,
    )


# ─── Topic labels (UI-facing) ─────────────────────────────────────────


_TOPIC_LABELS = {
    "daily_brief": "the 8am Daily Brief email",
}


def _topic_label(topic: str) -> str:
    return _TOPIC_LABELS.get(topic, "these emails")


# ─── Routes ────────────────────────────────────────────────────────────


@router.get("/unsubscribe", response_class=HTMLResponse)
def unsubscribe_confirm(
    request: Request,
    token: str = Query(...),
):
    """Show a confirmation page.  Does NOT change any state — that
    only happens on POST so link prefetchers can't accidentally
    unsubscribe people."""
    payload = parse_unsubscribe_token(token)
    if not payload:
        return HTMLResponse(content=_expired_page(), status_code=410)
    topic = payload.get("t") or "daily_brief"
    return HTMLResponse(content=_confirm_page(token, _topic_label(topic)))


@router.post("/unsubscribe", response_class=HTMLResponse)
def unsubscribe_action(
    request: Request,
    token: str = Query(...),
):
    """Actually unsubscribe.  Hit by:
      1. Our own confirmation page's submit button
      2. Gmail / Yahoo / Outlook's RFC 8058 one-click endpoint
         (their inbox UI POSTs `List-Unsubscribe=One-Click` to the URL
         in the email's List-Unsubscribe header)

    Returns an HTML success page for browser-direct visits.  The
    inbox-provider clients ignore the response body — they only care
    about a 2xx status code.
    """
    payload = parse_unsubscribe_token(token)
    if not payload:
        return HTMLResponse(content=_expired_page(), status_code=410)

    topic = payload.get("t") or "daily_brief"
    user_id = payload.get("u")
    db: Session = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            changed = _set_user_topic_off(user, topic)
            if changed:
                audit_service.record(
                    db, user, "email.unsubscribed",
                    entity_type="user", entity_id=user.id,
                    after={"topic": topic, "via": "one_click_email"},
                    ip_address=(request.client.host if request.client else None),
                )
                db.commit()
        else:
            # Token verified but user is gone (account deleted).
            # Still render success — recipient doesn't need to know.
            logger.info(
                "email_unsubscribe: valid token for missing user_id=%s topic=%s",
                user_id, topic,
            )
    finally:
        db.close()

    return HTMLResponse(content=_success_page(_topic_label(topic)))
