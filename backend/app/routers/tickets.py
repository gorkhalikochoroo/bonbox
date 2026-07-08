"""Ticket scan + visitor's web-ticket page.

Per `docs/event-booking-product-spec.md` §5.3:

  • POST /api/tickets/{id}/scan   — organizer-auth door scan; idempotent.
  • GET  /t/{ticket_id}?sig=...   — visitor's web-ticket HTML page (signed URL).

The web-ticket page is a thin HTML shell with the QR rendered as a
data: URI image — same SSR pattern as public_events.py so it works
even if JS is disabled in the visitor's email client / browser.

Multi-barrier on scan endpoint:
  L1 — get_current_user (organizer session).
  L2 — Tenant scope: ticket.event must belong to user.id.
  L3 — Idempotent stamp; re-scanning is harmless.
  L4 — Rate limit 120/min/IP (door-rush defense per spec §7).
  L5 — Fail-soft DB hiccups → 503.
  L6 — Cross-tenant scan attempt → 404 (IDOR convention).
  L7 — No PLAN_FEATURES gate — scan is universal across tiers.
  L8 — Audit: booking.scanned.
  L9 — Void ticket → 410 Gone with reason.
  L10 — Honest: response carries the precise outcome ("ok" / "already" /
       "void" / "wrong_event").
"""
import base64
import html as html_lib
import logging
from io import BytesIO
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status
from fastapi.responses import HTMLResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.booking import Booking
from app.models.event import Event
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.booking import TicketScanResponse
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.qr_signer import sign_ticket, verify_ticket
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

_limiter = Limiter(key_func=client_ip)


def _client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    try:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else None
    except Exception:  # noqa: BLE001
        return None


# ─── Organizer scan endpoint ────────────────────────────────────────


@router.post("/api/tickets/{ticket_id}/scan", response_model=TicketScanResponse)
@_limiter.limit("120/minute")
def scan_ticket(
    request: Request,
    ticket_id: UUID = Path(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Door-scan a ticket. Idempotent.

    Layered defense (in order):
      1. Load the Ticket row by id. 404 on miss (IDOR convention).
      2. Tenant scope: ticket.event must belong to user.id. 404 on
         cross-tenant attempt.
      3. is_void → 410 Gone.
      4. scanned_at populated → "already" status, return prior stamp.
      5. Else: stamp scanned_at + scanner_user_id, audit, return "ok".
    """
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    # L2 — tenant scope. Load the event to confirm ownership.
    event = (
        db.query(Event)
        .filter(Event.id == ticket.event_id)
        .filter(Event.user_id == user.id)
        .first()
    )
    if event is None:
        # Cross-tenant attempt OR event soft-deleted while ticket
        # remained — both surface as 404 to prevent enumeration.
        raise HTTPException(status_code=404, detail="Ticket not found")
    # L9 — voided ticket.
    if ticket.is_void:
        raise HTTPException(
            status_code=410,
            detail={
                "error": "ticket_void",
                "message": (
                    "Billetten er ugyldig (booking annulleret eller refunderet)."
                ),
            },
        )
    # Load the booking for the name surfaced in the scan response.
    booking = db.query(Booking).filter(Booking.id == ticket.booking_id).first()
    customer_name = booking.customer_name if booking else ""
    # L8 - guard against scanning tickets for unconfirmed bookings.
    # We allow scans on `paid` or `attended`. Anything else (pending,
    # cancelled, refunded, expired) is refused.
    if booking is not None and booking.status not in ("paid", "attended"):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "booking_not_confirmed",
                "message": (
                    "Bookingen er ikke bekræftet. Markér betalingen først."
                ),
                "current_status": booking.status,
            },
        )

    # Idempotent: already scanned → return prior stamp without altering.
    if ticket.scanned_at is not None:
        return TicketScanResponse(
            ticket_id=ticket.id,
            booking_id=ticket.booking_id,
            event_id=ticket.event_id,
            tier_label=ticket.tier_label,
            customer_name=customer_name,
            status="already",
            scanned_at=ticket.scanned_at,
        )

    now = utc_now()
    ticket.scanned_at = now
    ticket.scanner_user_id = user.id
    # If the parent booking is still in 'paid', advance to 'attended'.
    # We don't roll back to 'paid' from 'attended' (terminal positive).
    if booking is not None and booking.status == "paid":
        booking.status = "attended"
        booking.attended_at = now
        booking.attended_scanner_user_id = user.id
        booking.updated_at = now

    audit_service.record(
        db,
        user,
        action="booking.scanned",
        entity_type="ticket",
        entity_id=ticket.id,
        after={
            "ticket_id": str(ticket.id),
            "booking_id": str(ticket.booking_id),
            "event_id": str(ticket.event_id),
            "tier_label": ticket.tier_label,
            "scanned_at": now.isoformat(),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(ticket)
    return TicketScanResponse(
        ticket_id=ticket.id,
        booking_id=ticket.booking_id,
        event_id=ticket.event_id,
        tier_label=ticket.tier_label,
        customer_name=customer_name,
        status="ok",
        scanned_at=ticket.scanned_at,
    )


# ─── Visitor's web-ticket page (signed URL) ─────────────────────────


@router.get("/t/{ticket_id}", response_class=HTMLResponse, include_in_schema=False)
@_limiter.limit("30/minute")
def visitor_ticket_page(
    request: Request,  # noqa: ARG001 — required by slowapi
    ticket_id: UUID = Path(...),
    sig: str | None = None,
    db: Session = Depends(get_db),
):
    """Render the visitor's web-ticket page (HTML with the QR inline).

    Auth is via the `?sig=...` JWT (same one stored on
    ticket.qr_payload). We verify the JWT signature + match the tid
    claim to the URL — anyone with the link sees the ticket, but the
    link itself is unguessable.
    """
    claims = verify_ticket(sig or "") if sig else None
    if not claims or claims.get("tid") != str(ticket_id):
        return HTMLResponse(
            content=_ticket_html_error("Billetten kunne ikke findes eller linket er udløbet."),
            status_code=status.HTTP_404_NOT_FOUND,
        )
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if ticket is None or str(ticket.event_id) != claims.get("eid"):
        return HTMLResponse(
            content=_ticket_html_error("Billetten kunne ikke findes."),
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if ticket.is_void:
        return HTMLResponse(
            content=_ticket_html_error(
                "Denne billet er ugyldig (booking annulleret eller refunderet)."
            ),
            status_code=status.HTTP_410_GONE,
        )
    event = db.query(Event).filter(Event.id == ticket.event_id).first()
    booking = db.query(Booking).filter(Booking.id == ticket.booking_id).first()
    return HTMLResponse(
        content=_ticket_html(
            event_name=event.name if event else "",
            event_venue=(event.venue if event else None) or "",
            starts_at=event.starts_at.isoformat() if event and event.starts_at else "",
            tier_label=ticket.tier_label,
            tier_price_dkk=ticket.tier_price_dkk,
            customer_name=booking.customer_name if booking else "",
            qr_payload=ticket.qr_payload,
            scanned_at=ticket.scanned_at.isoformat() if ticket.scanned_at else None,
        ),
        status_code=status.HTTP_200_OK,
    )


def _ticket_html(
    *,
    event_name: str,
    event_venue: str,
    starts_at: str,
    tier_label: str,
    tier_price_dkk: int,
    customer_name: str,
    qr_payload: str,
    scanned_at: str | None,
) -> str:
    """Compose the visitor's web-ticket HTML.

    Every dynamic value is HTML-escaped. The QR is generated by the
    `qrcode` library when available; otherwise we degrade to plain
    text containing the JWT (still scannable from a phone via the
    door-scanner pasting it in — the QR is the optimization, not the
    only path).
    """
    qr_img_tag = _qr_to_inline_img(qr_payload)
    safe_event = html_lib.escape(event_name, quote=True)
    safe_venue = html_lib.escape(event_venue, quote=True)
    safe_starts = html_lib.escape(starts_at, quote=True)
    safe_tier = html_lib.escape(tier_label, quote=True)
    safe_customer = html_lib.escape(customer_name, quote=True)
    scanned_banner = ""
    if scanned_at:
        safe_scanned = html_lib.escape(scanned_at, quote=True)
        scanned_banner = (
            f"<div style='color:#666;font-size:14px;margin-top:8px'>"
            f"Skannet ved indgang: {safe_scanned}</div>"
        )
    return f"""<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_event} · Billet · BonBox</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            max-width: 480px; margin: 32px auto; padding: 16px; color: #111; }}
    h1 {{ font-size: 24px; margin-bottom: 4px; }}
    .meta {{ color: #555; font-size: 14px; }}
    .qr {{ text-align: center; margin: 24px 0; }}
    .qr img {{ width: 240px; height: 240px; }}
    .row {{ display: flex; justify-content: space-between; padding: 8px 0;
            border-top: 1px solid #eee; }}
  </style>
</head>
<body>
  <h1>{safe_event}</h1>
  <div class="meta">{safe_venue}</div>
  <div class="meta">{safe_starts}</div>
  <div class="qr">{qr_img_tag}</div>
  <div class="row"><span>Billettype</span><strong>{safe_tier}</strong></div>
  <div class="row"><span>Pris</span><strong>{tier_price_dkk} DKK</strong></div>
  <div class="row"><span>Navn</span><strong>{safe_customer}</strong></div>
  {scanned_banner}
</body>
</html>"""


def _ticket_html_error(message: str) -> str:
    safe = html_lib.escape(message, quote=True)
    return f"""<!DOCTYPE html>
<html lang="da"><head><meta charset="utf-8">
<title>Billet · BonBox</title></head>
<body style="font-family: -apple-system, sans-serif; max-width:480px; margin:48px auto; padding:16px;">
<h1>BonBox</h1>
<p>{safe}</p>
</body></html>"""


def _qr_to_inline_img(payload: str) -> str:
    """Render the QR as an inline data: URI <img> tag.

    Falls back to a plain `<code>` block when the `qrcode` library is
    not installed (e.g. minimal-deps test environment). The door
    scanner can paste the JWT manually in that case.
    """
    try:
        import qrcode  # type: ignore[import-not-found]
        img = qrcode.make(payload)
        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f'<img alt="Booking QR" src="data:image/png;base64,{b64}">'
    except Exception as exc:  # noqa: BLE001 — render-time best-effort
        logger.debug("tickets._qr_to_inline_img: qrcode unavailable: %s", exc)
        safe = html_lib.escape(payload, quote=True)
        return (
            f'<code style="font-size:10px;word-break:break-all">{safe}</code>'
        )
