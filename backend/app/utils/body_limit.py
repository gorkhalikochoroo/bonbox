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

The overflow is raised as an HTTPException(413) from ``receive`` so
FastAPI's body reader re-raises it as-is (any other exception there turns
into a generic 400); if it escapes the app instead, the middleware sends
the 413 itself, provided no response has started.
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
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.max_urlencoded_bytes = max_urlencoded_bytes

    def _limit_for(self, headers: Headers) -> int:
        ctype = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if ctype == "application/x-www-form-urlencoded":
            return min(self.max_body_bytes, self.max_urlencoded_bytes)
        return self.max_body_bytes

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        limit = self._limit_for(headers)

        # Cheap path: the client declared a size over the limit.
        cl = headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > limit:
            await _too_large_response(limit)(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> dict:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > limit:
                    raise BodyTooLarge(limit)
            return message

        response_started = False

        async def tracking_send(message: dict) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLarge:
            if response_started:
                raise
            await _too_large_response(limit)(scope, receive, send)
