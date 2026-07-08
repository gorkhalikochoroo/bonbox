"""Public-facing event-detail surface (no auth).

Per `docs/event-booking-product-spec.md` §4 + §5.3:

  • GET /e/{slug}                     — SSR HTML with OG/Twitter meta
                                        tags so FB/Messenger unfurl
                                        renders the cover image +
                                        title + description.
  • GET /api/public/events/{slug}     — JSON event detail for the SPA.

Both are unauthenticated. Identity surface = the slug itself; an
event only resolves if `published=True` (L9 fallback: published=False
returns 410 Gone, NOT 404, so the FB scraper doesn't cache "404" for
an event the organizer plans to re-publish later).

Multi-barrier (spec §7):
  L1 — Public, no auth (visitors are guests).
  L2 — Tenant scope inherent in slug lookup (slug is globally UNIQUE).
  L3 — Slug bounded 1..80 chars by the route parameter constraint.
  L4 — Rate limit 60/min/IP on the JSON endpoint (slowapi).
  L5 — Fail-soft: DB hiccup on the JSON path returns 503 with friendly
       Danish copy. SSR path returns a minimal HTML fallback.
  L6 — Tenant scope via slug uniqueness.
  L7 — No PLAN_FEATURES check here (public endpoint — the organizer
       is responsible for publishing).
  L8 — No audit row on read (high-volume public surface).
  L9 — published=False / soft-deleted → 410 Gone (not 404).
  L10 — Honest claims: visitor-facing copy + capacity number only
       when capacity_total is set + sold ≥ 25% (spec §4 layout).
"""
import html as html_lib
import json as _json
import logging
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.booking import Booking
from app.models.event import Event

logger = logging.getLogger(__name__)

router = APIRouter()

_limiter = Limiter(key_func=client_ip)


# Slug pattern guard — keeps the path parameter bounded so a hostile
# input can't expand the SQL pattern (kebab + 4-char hex suffix per
# spec). Pydantic-style regex; FastAPI compiles it once per route.
_SLUG_RE = r"^[a-z0-9][a-z0-9-]{0,79}$"


def _absolute_base_url() -> str:
    """Compose the canonical public URL prefix from FRONTEND_URL.

    Used by the OG meta tags so the FB scraper sees the public-facing
    URL (e.g. https://bonbox.dk), not the API host.
    """
    base = (settings.FRONTEND_URL or "https://bonbox.dk").strip().rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    return base


def _resolve_event_by_slug(db: Session, slug: str) -> Event | None:
    """L9 gateway: returns Event iff published + not soft-deleted.

    Returns None for any other state. Caller maps None to 410 Gone
    (NOT 404) so the FB scraper / search engines don't cache "missing"
    for a slug that may re-publish later.
    """
    return (
        db.query(Event)
        .filter(Event.slug == slug)
        .filter(Event.published.is_(True))
        .filter(Event.is_deleted.isnot(True))
        .first()
    )


def _public_event_payload(db: Session, event: Event) -> dict[str, Any]:
    """Shape the JSON the public SPA expects.

    Includes a capacity hint computed on-the-fly. We intentionally
    don't surface `organizer_user_id` or any field that would leak
    tier / billing state.
    """
    sold = (
        db.query(func.count(Booking.id))
        .filter(Booking.event_id == event.id)
        .filter(Booking.status.in_(("pending", "paid", "attended")))
        .scalar()
        or 0
    )
    capacity = event.capacity_total
    # L10 honest claim — only surface the capacity progress line when
    # we have a known capacity AND sold >= 25% (spec §4). Below the
    # threshold we don't claim demand we don't have.
    capacity_hint: dict[str, Any] | None = None
    if capacity and capacity > 0 and sold >= max(1, capacity // 4):
        capacity_hint = {"sold": int(sold), "total": int(capacity)}
    return {
        "slug": event.slug,
        "name": event.name,
        "subtitle": event.subtitle,
        "venue": event.venue,
        "notes": event.notes,
        "cover_image_url": event.cover_image_url,
        "starts_at": event.starts_at.isoformat() if event.starts_at else None,
        "ends_at": event.ends_at.isoformat() if event.ends_at else None,
        "event_date": event.event_date.isoformat() if event.event_date else None,
        "ticket_tiers": event.ticket_tiers or [],
        "addons": event.addons or [],
        "refund_policy": event.refund_policy,
        "booking_terms_url": event.booking_terms_url,
        "is_tax_exempt": bool(event.is_tax_exempt),
        # Booking-window discipline — visitor SPA can show "Booking
        # closes 12. juni 17:00" or "Booking åbnes 1. juni".
        "bookings_open_at": event.bookings_open_at.isoformat() if event.bookings_open_at else None,
        "bookings_close_at": event.bookings_close_at.isoformat() if event.bookings_close_at else None,
        "capacity_hint": capacity_hint,
    }


# ─── SSR HTML route ──────────────────────────────────────────────────


@router.get("/e/{slug}", response_class=HTMLResponse, include_in_schema=False)
@_limiter.limit("60/minute")
def event_ssr_page(
    request: Request,  # noqa: ARG001 — required by slowapi
    slug: str = Path(..., pattern=_SLUG_RE, min_length=1, max_length=80),
    db: Session = Depends(get_db),
):
    """Server-render the minimal HTML that carries OG/Twitter meta tags.

    The actual interactive React page is served by the SPA at the same
    URL via Vercel rewrites — the FB scraper sees the meta tags from
    this API route; real browsers run the JS redirect into the SPA.

    L9 — published=False / soft-deleted → 410 Gone with the same
    HTML shell + a "this event isn't available" message.
    """
    event = _resolve_event_by_slug(db, slug)
    base = _absolute_base_url()
    if event is None:
        # 410 Gone — distinct from 404 (cf. spec §7 L9).
        html_body = _ssr_html(
            title="Arrangement ikke tilgængeligt · BonBox",
            description=(
                "Dette arrangement er ikke længere tilgængeligt. "
                "Hvis du har en booking, så tjek din email for billetter."
            ),
            cover_image_url=None,
            canonical=f"{base}/e/{html_lib.escape(slug)}",
            slug=slug,
            noscript_visible=True,
        )
        return HTMLResponse(content=html_body, status_code=status.HTTP_410_GONE)

    # First-160-char description from notes (spec §4.5).
    description = (event.notes or "").strip()
    if len(description) > 160:
        description = description[:157].rstrip() + "..."
    if not description:
        description = (
            f"Book billet til {event.name} på BonBox. "
            f"Sikker checkout, kvittering på email."
        )

    return HTMLResponse(
        content=_ssr_html(
            title=f"{event.name} · BonBox",
            description=description,
            cover_image_url=event.cover_image_url,
            canonical=f"{base}/e/{html_lib.escape(slug)}",
            slug=slug,
        ),
        status_code=status.HTTP_200_OK,
    )


def _is_safe_image_url(url: str | None) -> bool:
    """Allowlist check for og:image / twitter:image URLs.

    Even though the og:image meta is consumed by social scrapers (FB,
    LinkedIn, Twitter) and never JS-evaluated by a browser, defense-
    in-depth says we shouldn't blindly accept any scheme.  A future
    refactor might inline the URL into <img src=…> on the SSR page,
    at which point a `javascript:` payload could fire.  Reject anything
    that isn't an absolute https:// (or http:// for dev) URL with a
    non-empty host.
    """
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url.strip())
    except Exception:  # noqa: BLE001
        return False
    if parsed.scheme.lower() not in ("https", "http"):
        return False
    if not parsed.netloc:
        return False
    return True


def _ssr_html(
    *,
    title: str,
    description: str,
    cover_image_url: str | None,
    canonical: str,
    slug: str,
    noscript_visible: bool = False,
) -> str:
    """Compose the OG-meta-bearing HTML shell (spec §4.5).

    Every interpolated value is HTML-escaped before insertion — the
    function never directly inserts unescaped strings into attribute
    or text contexts. Even an organizer with a hostile event.name
    can't break out of the meta tags.

    Two extra defense-in-depth layers added 2026-05-25:
      • `cover_image_url` is allowlisted to https://|http:// schemes
        before being embedded in og:image / twitter:image.  Stops a
        future refactor from accidentally turning og:image into an
        XSS vector if its content ever feeds an <img src=…> on the
        page itself.
      • The redirect script no longer interpolates the slug via HTML
        escape (which is the WRONG encoding for a JS string context —
        HTML-escape leaves \\, /, etc unchanged).  We `_json.dumps` the
        slug instead so the value becomes a properly-quoted JS string
        literal.  Slug regex already restricts to [a-z0-9-] so this is
        belt-and-braces, but it removes a foot-gun for the next dev
        who relaxes the regex.
    """
    safe_title = html_lib.escape(title, quote=True)
    safe_desc = html_lib.escape(description, quote=True)
    safe_canonical = html_lib.escape(canonical, quote=True)
    if _is_safe_image_url(cover_image_url):
        # safe_image is for HTML attribute context — HTML-escape is
        # the right encoding here.
        safe_image = html_lib.escape(cover_image_url, quote=True)  # type: ignore[arg-type]
        og_image = f'<meta property="og:image" content="{safe_image}">'
        twitter_image = f'<meta name="twitter:image" content="{safe_image}">'
    else:
        og_image = ""
        twitter_image = ""

    if not noscript_visible:
        # JS string context — use JSON encoding so the slug becomes a
        # properly-quoted JS string literal regardless of the slug
        # alphabet.  Slug regex already restricts to [a-z0-9-] so this
        # is belt-and-braces, but it removes a foot-gun for the next
        # dev who relaxes the regex.
        slug_js_literal = _json.dumps(slug)
        # json.dumps doesn't escape '/'; replace '</' with '<\\/' so a
        # future change that allows '/' in slugs can't break out of the
        # <script> tag with a synthesised </script> sequence.
        slug_js_literal = slug_js_literal.replace("</", "<\\/")
        # Compose the redirect as a JS string concatenation so the slug
        # value stays inside the JS string literal context end-to-end.
        body_redirect = (
            f'<script>window.location.replace("/e/" + {slug_js_literal} '
            f'+ "#booking");</script>'
        )
    else:
        body_redirect = ""
    return f"""<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_title}</title>
  <meta name="description" content="{safe_desc}">
  <link rel="canonical" href="{safe_canonical}">
  <meta property="og:title" content="{safe_title}">
  <meta property="og:description" content="{safe_desc}">
  <meta property="og:url" content="{safe_canonical}">
  <meta property="og:type" content="event">
  {og_image}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{safe_title}">
  <meta name="twitter:description" content="{safe_desc}">
  {twitter_image}
</head>
<body>
  <noscript>JavaScript er påkrævet. Åbn linket på {safe_canonical}.</noscript>
  {body_redirect}
</body>
</html>"""


# ─── JSON detail route ───────────────────────────────────────────────


@router.get("/api/public/events/{slug}")
@_limiter.limit("60/minute")
def public_event_detail(
    request: Request,  # noqa: ARG001 — required by slowapi key_func
    slug: str = Path(..., pattern=_SLUG_RE, min_length=1, max_length=80),
    db: Session = Depends(get_db),
):
    """JSON detail for the visitor SPA.

    Returns 410 Gone when the slug doesn't resolve to a published
    not-deleted event (consistent with the SSR route).
    """
    try:
        event = _resolve_event_by_slug(db, slug)
    except Exception as exc:  # noqa: BLE001 — L5 fail-soft
        logger.exception("public_event_detail: DB failure: %s", exc)
        return JSONResponse(
            status_code=503,
            content={
                "error": "service_unavailable",
                "message": "BonBox er midlertidigt utilgængelig. Prøv igen om et øjeblik.",
            },
        )
    if event is None:
        raise HTTPException(
            status_code=410,
            detail={
                "error": "event_not_available",
                "message": "Dette arrangement er ikke længere tilgængeligt.",
            },
        )
    return _public_event_payload(db, event)
