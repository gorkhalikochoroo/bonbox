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
from app.utils.client_ip import client_ip
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


# The pages are styled by ONE <style> element (classes, no style="" attributes)
# so a strict CSP can allow exactly that stylesheet by its hash. The API's
# global CSP is default-src 'none', which blocked every inline style: the
# revisor's opt-out page — the one BonBox page a revisor ever sees — rendered
# in Times with a grey default button and no card. PAGE_CSP is applied to this
# route only (main.add_security_headers); every other response keeps the
# strict default.
PAGE_CSS = (
    f"body{{margin:0;padding:0;background:{_PALETTE['bg']};"
    "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;"
    f"color:{_PALETTE['ink']};}}"
    ".wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;"
    "padding:24px 16px;box-sizing:border-box;}"
    f".card{{background:{_PALETTE['card']};border:1px solid {_PALETTE['border']};"
    "border-radius:14px;max-width:480px;width:100%;padding:36px 28px;box-sizing:border-box;"
    "box-shadow:0 1px 2px rgba(15,23,42,.04);}"
    f".brand{{font-size:13px;font-weight:600;color:{_PALETTE['brand_dark']};"
    "letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;}"
    "h1{font-size:22px;font-weight:700;margin:0 0 12px 0;line-height:1.3;}"
    f".lead{{font-size:15px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;}}"
    f".note{{font-size:14px;line-height:1.55;color:{_PALETTE['muted']};margin:0 0 22px 0;}}"
    f".small{{font-size:13px;color:{_PALETTE['muted']};margin:0;}}"
    f".fine{{font-size:12px;color:{_PALETTE['muted']};margin:18px 0 0 0;}}"
    "form{margin:0 0 18px 0;}"
    f"a{{color:{_PALETTE['brand_dark']};text-decoration:underline;}}"
    f".fine a{{color:{_PALETTE['muted']};}}"
    f".btn{{display:inline-block;border-radius:10px;font-weight:600;cursor:pointer;"
    "font-family:inherit;}"
    f".btn-danger{{background:{_PALETTE['danger']};color:#fff;border:0;padding:12px 24px;"
    "font-size:15px;}"
    f".btn-ghost{{background:#fff;color:{_PALETTE['brand_dark']};"
    f"border:1px solid {_PALETTE['brand_dark']};padding:10px 20px;font-size:14px;}}"
)


def _css_hash(css: str) -> str:
    import base64
    import hashlib
    return "sha256-" + base64.b64encode(hashlib.sha256(css.encode("utf-8")).digest()).decode("ascii")


# This page's own policy: its one stylesheet (by hash), its favicon, its form
# posting back to itself — nothing else (no scripts, no frames, no base).
PAGE_CSP = (
    "default-src 'none'; "
    f"style-src '{_css_hash(PAGE_CSS)}'; "
    "img-src https://www.bonbox.dk; "
    "form-action 'self'; "
    "base-uri 'none'; "
    "frame-ancestors 'none'"
)


def _page(title: str, body_html: str, *, lang: str = "en") -> str:
    """Wrap inner HTML in a clean centered card. Styled by PAGE_CSS (one
    <style> element the route's CSP allows by hash) so the landing page
    doesn't need the SPA bundle to look reasonable — a recipient on the bus
    with bad signal still sees a polished confirmation.

    `lang` is the page's language: the revisor's pages are Danish and say so,
    so a screen reader reads them in a Danish voice."""
    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{title} — BonBox</title>
  <link rel="icon" type="image/svg+xml" href="https://www.bonbox.dk/favicon.svg" />
  <style>{PAGE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <main class="card">
      <div class="brand">BonBox</div>
      {body_html}
    </main>
  </div>
</body>
</html>"""


def _success_page(topic_label: str) -> str:
    return _page(
        "Unsubscribed",
        f"""
        <h1>
          You're unsubscribed.
        </h1>
        <p class="lead">
          We'll stop sending you {topic_label}. The change is already saved on your account — no further action needed.
        </p>
        <p class="note">
          Changed your mind? You can turn it back on any time from your <a href="https://www.bonbox.dk/profile#notifications">profile settings</a>.
        </p>
        <p class="fine">
          BonBox · GDPR-compliant · Cookies, data, complaint info → <a href="https://www.bonbox.dk/privacy">Privacy</a>
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
        <h1>
          Unsubscribe from {topic_label}?
        </h1>
        <p class="lead">
          Click the button below to stop receiving these emails. You'll keep your BonBox account — only the emails go away.
        </p>
        <form method="POST" action="/api/email/unsubscribe?token={safe_token}">
          <button type="submit" class="btn btn-danger">
            Yes, unsubscribe me
          </button>
        </form>
        <p class="small">
          Or <a href="https://www.bonbox.dk/profile#notifications">manage all your email preferences</a> instead.
        </p>
        """,
    )


def _expired_page() -> str:
    return _page(
        "Link expired",
        f"""
        <h1>
          This link has expired.
        </h1>
        <p class="lead">
          Unsubscribe links live for 30 days from the email send. To turn off Daily Brief emails, sign in and toggle them off under <a href="https://www.bonbox.dk/profile#notifications">Profile → Notifications</a>.
        </p>
        <p class="small">
          Trouble signing in? Email us at <a href="mailto:hello@bonbox.dk">hello@bonbox.dk</a> — we'll unsubscribe you manually.
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


# ─── The revisor's opt-out (a THIRD party — not a BonBox user) ───────────
#
# The kasserapport mail goes to the owner's revisor. They never signed up for
# BonBox, so they must be told why they get it and be able to stop it in one
# click. The token is minted per owner (u) and bound to a fingerprint of the
# revisor's address (r): it can only switch off the address it was sent to.
# The opt-out is stored on the owner's BusinessProfile; every send path checks
# it (services/revisor_mail.py) and the owner sees it in BonBox.


def _revisor_business_name(user_id) -> str:
    db: Session = SessionLocal()
    try:
        from app.models.business_profile import BusinessProfile
        p = db.query(BusinessProfile).filter(BusinessProfile.user_id == user_id).first()
        u = db.query(User).filter(User.id == user_id).first() if not (p and p.company_name) else None
        return ((p.company_name if p else "") or (u.business_name if u else "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""
    finally:
        db.close()


def _revisor_confirm_page(token: str, biz: str) -> str:
    import html as _html
    safe_token = _html.escape(token)
    b = _html.escape(biz) or "denne virksomhed"
    # The opt-out stops EVERY revisor mail (resolve_revisor_recipient on each
    # path) — the page names all of them, not only the kasserapporter.
    return _page(
        "Afmeld mails fra BonBox",
        f"""
        <h1>
          Afmeld mails fra BonBox om {b}?
        </h1>
        <p class="lead">
          Du får mails fra BonBox, fordi {b} har angivet dig som revisor i BonBox. Afmelder du,
          sender BonBox ikke flere mails til dig om {b} — hverken kasserapporter, momsangivelser
          eller lønlister — og ejeren får besked i BonBox.
        </p>
        <form method="POST" action="/api/email/unsubscribe?token={safe_token}">
          <button type="submit" class="btn btn-danger">
            Ja, afmeld
          </button>
        </form>
        <p lang="en" class="small">
          Unsubscribe from BonBox mail about {b}: press the button above.
        </p>
        """,
        lang="da",
    )


def _revisor_success_page(biz: str, token: str) -> str:
    import html as _html
    b = _html.escape(biz) or "denne virksomhed"
    safe_token = _html.escape(token)
    # The undo is the revisor's own, behind the same signed link: the owner
    # cannot switch a revisor's mail back on (that consent is not theirs),
    # and this page used to send the revisor to the owner for something the
    # owner had no way to do.
    return _page(
        "Afmeldt",
        f"""
        <h1>
          Du er afmeldt.
        </h1>
        <p class="lead">
          BonBox sender ikke flere mails til dig om {b}. Ejeren kan se i BonBox, at du har afmeldt.
          Var det en fejl, eller vil du have mailene igen, kan du fortryde her.
        </p>
        <form method="POST" action="/api/email/unsubscribe?token={safe_token}&amp;undo=1">
          <button type="submit" class="btn btn-ghost">
            Fortryd — send mails til mig igen
          </button>
        </form>
        <p lang="en" class="small">
          You're unsubscribed — BonBox won't mail you about {b} again. Changed your mind? Use the button above.
        </p>
        """,
        lang="da",
    )


def _revisor_resubscribed_page(biz: str) -> str:
    import html as _html
    b = _html.escape(biz) or "denne virksomhed"
    return _page(
        "Tilmeldt igen",
        f"""
        <h1>
          Du får mails igen.
        </h1>
        <p class="lead">
          BonBox sender igen mails til dig om {b} — kasserapporter, momsangivelser og
          lønlister, som ejeren har valgt.
          Hver mail har et link, hvis du vil afmelde igen.
        </p>
        <p lang="en" class="small">
          You'll get BonBox mail about {b} again. Every mail has a link to unsubscribe.
        </p>
        """,
        lang="da",
    )


def _revisor_expired_page(biz: str) -> str:
    """A revisor's link older than its 180 days. It used to land on the Daily
    Brief's English page ("Unsubscribe links live for 30 days … sign in"),
    which is the wrong topic, the wrong lifetime and asks a non-user to log
    in. Danish, about the kasserapport mails, with a way that needs no login."""
    import html as _html
    b = _html.escape(biz) or "virksomheden"
    return _page(
        "Linket er udløbet",
        f"""
        <h1>
          Linket er udløbet.
        </h1>
        <p class="lead">
          Afmeldingslinks i mails fra BonBox virker i 180 dage. Brug linket i en nyere
          mail fra BonBox om {b} — eller skriv til
          <a href="mailto:hello@bonbox.dk">hello@bonbox.dk</a>,
          så stopper vi mails til dig om {b}. Du skal ikke logge ind.
        </p>
        <p lang="en" class="small">
          This link has expired. Use the link in a newer mail from BonBox, or write to hello@bonbox.dk and we will stop them.
        </p>
        """,
        lang="da",
    )


def _expired_for(token: str) -> HTMLResponse:
    """The expired page for THIS token's topic. The topic is read only from a
    token whose signature checks out (it may be past its date); a forged or
    garbled one gets the generic page."""
    from app.utils.email_unsubscribe_token import parse_unsubscribe_token_unexpired_or_not
    payload = parse_unsubscribe_token_unexpired_or_not(token)
    if payload and payload.get("t") == "revisor_mail":
        return HTMLResponse(content=_revisor_expired_page(_revisor_business_name(payload.get("u"))),
                            status_code=410)
    return HTMLResponse(content=_expired_page(), status_code=410)


def _revisor_opt_out(user_id, fingerprint: str | None, request: Request, *, undo: bool = False) -> None:
    """Record (or, with `undo`, withdraw) the opt-out of the address the token
    was minted for. Recorded even when the owner has since saved another
    address: switching back must not restart mail to someone who said stop."""
    from app.models.business_profile import BusinessProfile
    from app.services.revisor_mail import (
        opt_out_fingerprints_for, record_opt_out, remove_opt_out,
    )
    db: Session = SessionLocal()
    try:
        p = db.query(BusinessProfile).filter(BusinessProfile.user_id == user_id).first()
        if not p or not fingerprint:
            return
        # The token's address and, for an older token minted on a "+tag"
        # address, its mailbox too: the opt-out stops the same inbox.
        changed = False
        for fp in opt_out_fingerprints_for(p, fingerprint):
            changed = (remove_opt_out(p, fp) if undo else record_opt_out(p, fp)) or changed
        if not changed:
            return  # idempotent
        owner = db.query(User).filter(User.id == user_id).first()
        if owner:
            audit_service.record(
                db, owner,
                "accountant.mail_resubscribed" if undo else "accountant.mail_opted_out",
                entity_type="business_profile", entity_id=p.id,
                after={"address_fingerprint": fingerprint, "via": "one_click_email"},
                ip_address=(client_ip(request) if request else None),
            )
        db.commit()
    finally:
        db.close()


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
        return _expired_for(token)
    topic = payload.get("t") or "daily_brief"
    if topic == "revisor_mail":
        return HTMLResponse(content=_revisor_confirm_page(
            token, _revisor_business_name(payload.get("u"))))
    return HTMLResponse(content=_confirm_page(token, _topic_label(topic)))


@router.post("/unsubscribe", response_class=HTMLResponse)
def unsubscribe_action(
    request: Request,
    token: str = Query(...),
    undo: int = Query(0),
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
        return _expired_for(token)

    topic = payload.get("t") or "daily_brief"
    user_id = payload.get("u")
    if topic == "revisor_mail":
        biz = _revisor_business_name(user_id)
        if undo:
            _revisor_opt_out(user_id, payload.get("r"), request, undo=True)
            return HTMLResponse(content=_revisor_resubscribed_page(biz))
        _revisor_opt_out(user_id, payload.get("r"), request)
        return HTMLResponse(content=_revisor_success_page(biz, token))
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
                    ip_address=(client_ip(request) if request else None),
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
