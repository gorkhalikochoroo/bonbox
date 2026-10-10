"""Request-body cap that counts the bytes actually received (INFRA-02).

The old cap (an ``@app.middleware("http")`` in main.py) only read the
Content-Length header. A chunked request carries no Content-Length, so it
skipped the cap entirely, and FastAPI parses form bodies BEFORE any auth
check — so a logged-out visitor could make the single worker parse a
body of any size (measured: ~1 s of event-loop CPU per 1.28 MB of
urlencoded fields).

This pure-ASGI middleware:
  * keeps the cheap path — a declared Content-Length over the limit is
    refused at once, same 413 body as before;
  * wraps ``receive`` and counts every body chunk, so a chunked (or
    otherwise undeclared) body is cut off the moment it passes the limit;
  * caps ``application/x-www-form-urlencoded`` bodies at 64 KB. Starlette
    0.41's max_fields limit is not applied to urlencoded forms
    (CVE-2026-54283), and BonBox's only urlencoded senders are small
    machine posts (Twilio webhooks, Apple's form_post sign-in).

The overflow is raised as an HTTPException(413) from ``receive``, which
stops the body read at the cap. Behind the ``@app.middleware("http")``
layers anyio wraps it in an ExceptionGroup, so FastAPI's body reader no
longer recognises it and answers a generic 400 "error parsing the body"
(every JSON / form / multipart route; only routes that read
``request.body()`` themselves, like the Stripe webhook, saw the 413). So
once the cap is crossed the middleware itself owns the answer: whatever
response the app then starts is replaced by the 413, and an exception
that escapes the app is answered with the 413 too — provided no response
had started before the overflow.

One route has its own, larger cap (``route_limits``): Postmark's inbound-mail
webhook (POST /api/inbox/postmark-webhook) carries a forwarded receipt mail
with its attachments base64-encoded, so a mail with ~7 MB of attachments
passed the general 10 MB and got a 413 that never reached the inbox's own
30 MB check — the receipt silently never landed. That route's cap is the
inbox's own limit (routers/inbox.MAX_BODY_BYTES), bytes still counted as
they arrive (chunked included). The handler checks the webhook's Basic Auth
before it reads the body. Every other route, and every other method on that
path, keeps the general cap; an urlencoded body is 64 KB everywhere.
"""

from __future__ import annotations

from typing import Any

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

#: Whole-request cap. Receipt photos are the largest legitimate payload
#: (~5 MB; routes enforce their own lower caps).
MAX_BODY_BYTES = 10 * 1024 * 1024
#: Cap for application/x-www-form-urlencoded bodies.
MAX_URLENCODED_BYTES = 64 * 1024


def _limit_text(limit: int) -> str:
    if limit >= 1024 * 1024:
        return f"{limit // (1024 * 1024)} MB"
    return f"{limit // 1024} KB"


class BodyTooLarge(HTTPException):
    def __init__(self, limit: int):
        self.limit = limit
        super().__init__(
            status_code=413,
            detail=f"Request body too large (max {_limit_text(limit)})",
        )


def _too_large_response(limit: int) -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={
            "detail": f"Request body too large (max {_limit_text(limit)})",
            "_error": True,
            "_recoverable": False,
        },
    )


class BodySizeLimitMiddleware:
    def __init__(
        self,
        app: Any,
        max_body_bytes: int = MAX_BODY_BYTES,
        max_urlencoded_bytes: int = MAX_URLENCODED_BYTES,
        route_limits: dict[tuple[str, str], int] | None = None,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.max_urlencoded_bytes = max_urlencoded_bytes
        #: {(METHOD, exact path): cap} — a route with its own cap in place
        #: of max_body_bytes. Exact match only: no prefix, no trailing slash.
        self.route_limits = {
            (m.upper(), path): int(cap) for (m, path), cap in (route_limits or {}).items()
        }

    def _limit_for(self, headers: Headers, scope: dict | None = None) -> int:
        base = self.max_body_bytes
        if scope is not None and self.route_limits:
            key = (str(scope.get("method") or "").upper(), scope.get("path") or "")
            base = self.route_limits.get(key, base)
        ctype = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if ctype == "application/x-www-form-urlencoded":
            return min(base, self.max_urlencoded_bytes)
        return base

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        limit = self._limit_for(headers, scope)

        # Cheap path: the client declared a size over the limit.
        cl = headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > limit:
            await _too_large_response(limit)(scope, receive, send)
            return

        received = 0
        overflowed = False
        response_started = False
        replaced = False

        async def limited_receive() -> dict:
            nonlocal received, overflowed
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > limit:
                    overflowed = True
                    raise BodyTooLarge(limit)
            return message

        async def _send_413() -> None:
            nonlocal response_started, replaced
            response_started = True
            replaced = True
            await _too_large_response(limit)(scope, receive, send)

        async def tracking_send(message: dict) -> None:
            nonlocal response_started
            if replaced:
                return  # the 413 already went out; drop the app's answer
            if message.get("type") == "http.response.start":
                if overflowed and not response_started:
                    # The app is answering a body it could not finish reading
                    # (FastAPI's 400 "error parsing the body"): send the 413.
                    await _send_413()
                    return
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except Exception:
            if replaced:
                return  # the 413 is complete; nothing left to answer
            if not overflowed or response_started:
                raise
            await _send_413()
