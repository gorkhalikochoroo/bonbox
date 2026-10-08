import os
import random
import string

from fastapi import APIRouter, Depends, Form, Request, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.whatsapp import WhatsAppUser, WhatsAppMessage
from app.services.auth import get_current_user
from app.services.whatsapp_service import parse_message, handle_message

# WhatsApp inbound integration is HIDDEN by default (reversible).
# It is the Twilio webhook that parses an inbound text and logs a Sale from a
# bot-parsed amount — disabled for now per product decision (phantom-revenue
# surface). Re-enable with WHATSAPP_ENABLED=true (no code change needed); the
# whole router then 404s while off.
WHATSAPP_ENABLED = os.getenv("WHATSAPP_ENABLED", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def _require_whatsapp_enabled():
    if not WHATSAPP_ENABLED:
        raise HTTPException(status_code=404, detail="WhatsApp integration is disabled")


router = APIRouter(dependencies=[Depends(_require_whatsapp_enabled)])

TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WA_NUMBER = os.getenv("TWILIO_WHATSAPP_NUMBER", "+14155238886")


def send_whatsapp(to: str, body: str):
    """Send a WhatsApp message via Twilio."""
    try:
        from twilio.rest import Client
        client = Client(TWILIO_SID, TWILIO_TOKEN)
        client.messages.create(
            from_=f"whatsapp:{TWILIO_WA_NUMBER}",
            to=f"whatsapp:{to}",
            body=body,
        )
    except Exception as e:
        print(f"Twilio send error: {e}")


def _webhook_url() -> str:
    """The exact public URL Twilio posts to — what its signature covers.
    Configured (WHATSAPP_WEBHOOK_URL, else the public API base), never taken
    from the request: behind Cloudflare/Render request.url carries the wrong
    scheme and host, and a forged request must not choose the URL it is
    checked against."""
    configured = (os.getenv("WHATSAPP_WEBHOOK_URL") or "").strip()
    if configured:
        return configured
    from app.services.revisor_mail import public_api_base
    return f"{public_api_base()}/api/whatsapp/webhook"


def _twilio_signature_ok(form_data, signature: str | None) -> bool:
    """True only for a request signed with OUR Twilio auth token. Fails
    closed: no token configured, no X-Twilio-Signature header, or a
    signature that does not match → False."""
    token = (TWILIO_TOKEN or "").strip()
    if not token or not signature:
        return False
    try:
        from twilio.request_validator import RequestValidator
        return bool(RequestValidator(token).validate(_webhook_url(), form_data, signature))
    except Exception:  # noqa: BLE001 — a validator failure is a refusal
        return False


@router.post("/webhook")
async def whatsapp_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    """Receive incoming WhatsApp messages from Twilio.

    The Twilio signature is checked FIRST — before anything is read or
    written. The form's From decides whose books the bot writes to, so an
    unsigned or forged request is refused (403), fail-closed (sweep, 8 Oct)."""
    form_data = await request.form()
    if not _twilio_signature_ok(form_data, request.headers.get("X-Twilio-Signature")):
        raise HTTPException(status_code=403, detail="Invalid or missing Twilio signature")
    body = form_data.get("Body", "").strip()
    from_number = form_data.get("From", "").replace("whatsapp:", "")

    if not body or not from_number:
        return Response(content="<Response></Response>", media_type="application/xml")

    # Log inbound message
    db.add(WhatsAppMessage(phone_number=from_number, direction="inbound", body=body))
    db.commit()

    # Find linked user
    wa_user = db.query(WhatsAppUser).filter(
        WhatsAppUser.phone_number == from_number,
        WhatsAppUser.verified == True,
    ).first()

    if not wa_user:
        # Check if they're trying to verify
        pending = db.query(WhatsAppUser).filter(
            WhatsAppUser.phone_number == from_number,
            WhatsAppUser.verified == False,
        ).first()

        if pending and body.strip() == pending.verification_code:
            pending.verified = True
            db.commit()
            reply = "✅ *Phone verified!* Your WhatsApp is now linked to BonBox.\n\nSend *help* to see available commands."
        elif pending:
            reply = f"❌ Wrong code. Please enter the 6-digit code shown in your BonBox profile."
        else:
            reply = (
                "👋 Welcome to *BonBox*!\n\n"
                "To get started, link your phone:\n"
                "1. Log in to bonbox.dk\n"
                "2. Go to Profile\n"
                "3. Enter your phone number\n"
                "4. Send the verification code here"
            )

        # Log outbound
        db.add(WhatsAppMessage(phone_number=from_number, direction="outbound", body=reply, action_taken="auth"))
        db.commit()

        twiml = f'<Response><Message>{reply}</Message></Response>'
        return Response(content=twiml, media_type="application/xml")

    # User is verified — process the message
    user = db.query(User).filter(User.id == wa_user.user_id).first()
    if not user:
        return Response(content="<Response></Response>", media_type="application/xml")

    parsed = parse_message(body)
    reply = handle_message(parsed, user, db)

    # Log outbound
    db.add(WhatsAppMessage(
        phone_number=from_number,
        direction="outbound",
        body=reply,
        action_taken=parsed.get("action"),
    ))
    db.commit()

    twiml = f'<Response><Message>{reply}</Message></Response>'
    return Response(content=twiml, media_type="application/xml")


# --- Phone linking endpoints (called from frontend) ---

@router.post("/link-phone")
def link_phone(
    phone: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Link a phone number to user's account. Sends verification code via WhatsApp."""
    # Clean phone number
    phone = phone.strip().replace(" ", "")
    if not phone.startswith("+"):
        phone = f"+{phone}"

    # Check if already linked to someone else
    existing = db.query(WhatsAppUser).filter(
        WhatsAppUser.phone_number == phone,
        WhatsAppUser.user_id != user.id,
        WhatsAppUser.verified == True,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="This phone is linked to another account")

    # Generate 6-digit code
    code = "".join(random.choices(string.digits, k=6))

    # Upsert
    wa_user = db.query(WhatsAppUser).filter(WhatsAppUser.phone_number == phone).first()
    if wa_user:
        wa_user.user_id = user.id
        wa_user.verification_code = code
        wa_user.verified = False
    else:
        wa_user = WhatsAppUser(
            user_id=user.id,
            phone_number=phone,
            verification_code=code,
            verified=False,
        )
        db.add(wa_user)
    db.commit()

    # Send verification code via WhatsApp
    send_whatsapp(phone, f"🔐 Your BonBox verification code: *{code}*\n\nReply with this code to link your account.")

    return {"message": "Verification code sent", "phone": phone, "code": code}


@router.get("/status")
def whatsapp_status(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Check if user has linked WhatsApp."""
    wa_user = db.query(WhatsAppUser).filter(
        WhatsAppUser.user_id == user.id,
    ).first()
    if not wa_user:
        return {"linked": False, "phone": None, "verified": False}
    return {
        "linked": True,
        "phone": wa_user.phone_number,
        "verified": wa_user.verified,
    }


@router.delete("/unlink")
def unlink_phone(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Unlink WhatsApp from account."""
    wa_user = db.query(WhatsAppUser).filter(WhatsAppUser.user_id == user.id).first()
    if wa_user:
        db.delete(wa_user)
        db.commit()
    return {"message": "WhatsApp unlinked"}
