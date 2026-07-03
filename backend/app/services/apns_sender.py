"""
apns_sender — native push to the BonBox Scheduler iOS app.

The web-push twin of this file is push_sender.py; this one speaks Apple's
APNs HTTP/2 provider API directly (no Firebase, no third-party relay — the
tokens never leave our infra).

Configuration (all via env, ALL optional — unset means every send is a
logged no-op, mirroring the pywebpush fail-soft doctrine; see
[[gotcha_push_deps_prod_install]] for why fail-soft matters on Render):

  APNS_AUTH_KEY   contents of the .p8 auth key from developer.apple.com
                  (literal "\\n" sequences are accepted and normalized,
                  same convention as other PEM envs in this repo)
  APNS_KEY_ID     10-char key id shown next to the .p8 in the portal
  APNS_TEAM_ID    Apple Developer Team ID
  APNS_TOPIC      bundle id, default dk.bonbox.scheduler
  APNS_USE_SANDBOX "1" → api.sandbox.push.apple.com (Xcode dev builds).
                  TestFlight and the App Store use PRODUCTION APNs, so the
                  default is prod.

Multi-barrier:
  L4 fail-soft   any config/network error is caught, logged, returned as
                 {"ok": False}; callers never crash a business action.
  L8 fallback    Apple's authoritative 410 Unregistered deletes the row
                 (web-push 410 Gone twin); 400 BadDeviceToken /
                 DeviceTokenNotForTopic mean PROVIDER misconfig and only
                 log loudly — never mass-prune on our own bad env.
  L10 honesty    returned counts reflect what APNs actually accepted.
"""

import json
import logging
import time
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

_PROD_HOST = "https://api.push.apple.com"
_SANDBOX_HOST = "https://api.sandbox.push.apple.com"

# APNs provider JWTs may be reused for up to an hour; Apple throttles
# providers that mint one per request. Cache and refresh at 45 min.
_JWT_TTL_SECONDS = 45 * 60
_jwt_cache: dict[str, Any] = {"token": None, "issued_at": 0.0}


def _cfg(name: str, default: str = "") -> str:
    return (getattr(settings, name, "") or default).strip()


def apns_configured() -> bool:
    return bool(_cfg("APNS_AUTH_KEY") and _cfg("APNS_KEY_ID") and _cfg("APNS_TEAM_ID"))


def _auth_key_pem() -> str:
    # Render env vars flatten newlines; accept the literal-\n convention.
    return _cfg("APNS_AUTH_KEY").replace("\\n", "\n")


def _provider_jwt() -> str:
    now = time.time()
    if _jwt_cache["token"] and now - _jwt_cache["issued_at"] < _JWT_TTL_SECONDS:
        return _jwt_cache["token"]

    from jose import jwt  # python-jose[cryptography] — already a dependency

    token = jwt.encode(
        {"iss": _cfg("APNS_TEAM_ID"), "iat": int(now)},
        _auth_key_pem(),
        algorithm="ES256",
        headers={"kid": _cfg("APNS_KEY_ID")},
    )
    _jwt_cache["token"] = token
    _jwt_cache["issued_at"] = now
    return token


def _host() -> str:
    return _SANDBOX_HOST if _cfg("APNS_USE_SANDBOX") == "1" else _PROD_HOST


def send_to_device_token(token: str, payload: dict, client=None) -> dict:
    """POST one alert to one APNs device token.

    `payload` is the SAME shape the web-push path uses —
    {"title", "body", "tag", "data": {"url": ...}} — so fan-out sites
    build it once and hand it to both channels.

    `client` lets a fan-out reuse ONE HTTP/2 connection for the whole
    burst — Apple explicitly warns against rapid connection cycling.

    Returns {"ok": bool, "removed": bool}; removed=True means Apple told
    us the token is dead and the caller should delete the row.
    """
    if not apns_configured():
        logger.info("apns_sender: APNS_* not configured — skipping send")
        return {"ok": False, "removed": False}

    try:
        import httpx  # http2 needs the `h2` extra — in requirements.txt
    except Exception:  # noqa: BLE001
        logger.warning("apns_sender: httpx unavailable — skipping send")
        return {"ok": False, "removed": False}

    body = {
        "aps": {
            "alert": {"title": payload.get("title", ""), "body": payload.get("body", "")},
            "sound": "default",
            # thread-id groups; apns-collapse-id below replaces re-fires of
            # the same tag instead of stacking — mirrors the web-push `tag`.
            "thread-id": payload.get("tag", "bonbox"),
        },
        # Consumed by the shell's tap handler to deep-link into the portal.
        "url": (payload.get("data") or {}).get("url", "/"),
    }
    headers = {
        "authorization": f"bearer {_provider_jwt()}",
        "apns-topic": _cfg("APNS_TOPIC", "dk.bonbox.scheduler"),
        "apns-push-type": "alert",
        "apns-priority": "10",
    }
    tag = payload.get("tag")
    if tag:
        # Apple caps collapse ids at 64 bytes.
        headers["apns-collapse-id"] = tag[:64]

    try:
        if client is not None:
            resp = client.post(
                f"{_host()}/3/device/{token}",
                headers=headers,
                content=json.dumps(body),
            )
        else:
            with httpx.Client(http2=True, timeout=10.0) as one_off:
                resp = one_off.post(
                    f"{_host()}/3/device/{token}",
                    headers=headers,
                    content=json.dumps(body),
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning("apns_sender: send failed transport-level: %s", exc)
        return {"ok": False, "removed": False}

    if resp.status_code == 200:
        return {"ok": True, "removed": False}

    reason = ""
    try:
        reason = resp.json().get("reason", "")
    except Exception:  # noqa: BLE001
        pass
    # Prune ONLY on the authoritative 410 Unregistered. Every token in the
    # table came from a real device via the bounds-checked registration, so
    # a 400 BadDeviceToken / DeviceTokenNotForTopic on it almost always
    # means WE are misconfigured (wrong APNS_TOPIC, sandbox/prod flip) —
    # deleting rows then would silently unsubscribe the whole fleet on one
    # bad env deploy. Those get an error-level log instead.
    dead = resp.status_code == 410
    log = logger.error if reason in ("BadDeviceToken", "DeviceTokenNotForTopic") else logger.warning
    log(
        "apns_sender: APNs answered %s reason=%s (token suffix …%s)%s",
        resp.status_code, reason or "?", token[-6:],
        " — check APNS_TOPIC / APNS_USE_SANDBOX, NOT pruning the token"
        if reason in ("BadDeviceToken", "DeviceTokenNotForTopic") else "",
    )
    return {"ok": False, "removed": dead}


def send_to_staff_devices(db: Session, user_id, staff_id, payload: dict) -> dict:
    """Fan one payload out to every native device of (tenant, staffer).

    Tenant scope on BOTH columns — never reach across tenants. Dead tokens
    are deleted inline (L8). Returns {"attempted", "sent", "removed"}.
    The caller owns the commit (rows ride the surrounding transaction).
    """
    result = {"attempted": 0, "sent": 0, "removed": 0}
    if not apns_configured():
        return result

    from app.models.staff import StaffLink
    from app.models.staff_device_token import StaffDeviceToken

    # Join on the ACTIVE link — the revocation doctrine. An owner who
    # deactivates/rotates a departed staffer's link must silence that
    # phone immediately; the row itself stays until re-register or 410.
    rows = (
        db.query(StaffDeviceToken)
        .join(StaffLink, StaffLink.id == StaffDeviceToken.link_id)
        .filter(
            StaffDeviceToken.user_id == user_id,
            StaffDeviceToken.staff_id == staff_id,
            StaffLink.active.is_(True),
        )
        .all()
    )
    try:
        import httpx
        shared = httpx.Client(http2=True, timeout=10.0)
    except Exception:  # noqa: BLE001
        shared = None  # send_to_device_token falls back to one-off clients

    try:
        for row in rows:
            result["attempted"] += 1
            try:
                outcome = send_to_device_token(row.token, payload, client=shared)
            except Exception as exc:  # noqa: BLE001
                logger.warning("apns_sender: device send threw: %s", exc)
                outcome = {"ok": False, "removed": False}
            if outcome.get("ok"):
                result["sent"] += 1
            if outcome.get("removed"):
                result["removed"] += 1
                try:
                    db.delete(row)
                except Exception:  # noqa: BLE001
                    pass
    finally:
        if shared is not None:
            try:
                shared.close()
            except Exception:  # noqa: BLE001
                pass
    return result
