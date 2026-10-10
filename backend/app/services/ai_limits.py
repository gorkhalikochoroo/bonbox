"""Keep the single API process answering while AI / OCR calls are in flight.

Production runs ONE uvicorn worker. The Anthropic, Mindee and OCR clients
are synchronous: called from an ``async def`` route they freeze the event
loop for the whole vendor round-trip, so every venue's saves, logins and
booking pages stop with it (OPS-02 / P0-3, reproduced: /api/health 3.7 s
late behind a 4 s call). Three guards live here:

1. ``anthropic_client()`` — the one way to build an Anthropic client: an
   explicit timeout and at most ONE SDK retry. The SDK defaults were a
   600 s timeout and 2 retries, so a hung call could hold a thread for
   half an hour.
2. ``vision_slot()`` / ``vision_slot_async()`` — at most
   ``VISION_MAX_CONCURRENT`` photo reads (Claude vision, Mindee, OCR) run
   at once across the process. A read that cannot get a slot waits up to
   ``VISION_WAIT_S`` and then fails LOUDLY with ``AIBusyError`` (HTTP 503
   "busy, try again" in the owner's language) — never a silent drop.
3. (Not here, at the call sites.) Routes that make these calls are plain
   ``def`` — FastAPI runs them in the threadpool — or hand the blocking
   call to ``starlette.concurrency.run_in_threadpool`` (the Copilot stream,
   the Stripe and Postmark webhooks). tests/test_api_stays_up.py pins it.

Raise ``AIBusyError`` before any side effect (photo stored, counter
written) so the browser's automatic 503 retry cannot double-book anything.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from typing import Any, AsyncIterator, Iterator

from app.config import settings

logger = logging.getLogger("bonbox.ai_limits")

# ── Anthropic client ────────────────────────────────────────────────────

#: Seconds before one Anthropic HTTP attempt is abandoned.
AI_TIMEOUT_S = 30.0
#: SDK-level retries per call (on timeouts, connection errors, 429/5xx).
AI_MAX_RETRIES = 1


def anthropic_client(api_key: str | None = None, *, timeout: float | None = None) -> Any:
    """Build an ``anthropic.Anthropic`` with a bounded timeout and 1 retry.

    ``timeout`` defaults to ``AI_TIMEOUT_S`` (30 s). A caller may pass a
    longer value ONLY where a read legitimately runs longer today (the
    Z-report, menu and supplier-invoice vision reads, 45–60 s) — lowering
    those would turn reads that succeed now into failures.

    ``anthropic`` is imported here, at call time, so tests that swap
    ``sys.modules["anthropic"]`` for a fake keep working.
    """
    import anthropic

    key = api_key if api_key is not None else getattr(settings, "ANTHROPIC_API_KEY", None)
    return anthropic.Anthropic(
        api_key=key,
        timeout=float(AI_TIMEOUT_S if timeout is None else timeout),
        max_retries=AI_MAX_RETRIES,
    )


# ── Vision concurrency ──────────────────────────────────────────────────

#: Photo reads allowed in flight at once, process-wide.
VISION_MAX_CONCURRENT = 4
#: How long an extra read waits for a free slot before the 503.
VISION_WAIT_S = 10.0
#: Retry-After header (seconds) on the busy 503.
BUSY_RETRY_AFTER_S = 10

# A threading semaphore (not asyncio): the sync routes hold it from their
# worker thread and the async routes poll it from the event loop, so one
# counter covers both — and it is not bound to any one event loop.
_vision_slots = threading.BoundedSemaphore(VISION_MAX_CONCURRENT)

_BUSY_TEXT = {
    "da": "BonBox læser mange billeder lige nu. Prøv igen om et øjeblik.",
    "en": "BonBox is reading a lot of photos right now. Please try again in a moment.",
}


def busy_message(lang: str | None) -> str:
    return _BUSY_TEXT["da" if lang == "da" else "en"]


class AIBusyError(Exception):
    """Every vision slot stayed taken for ``VISION_WAIT_S``.

    main.py turns this into HTTP 503 + Retry-After with ``busy_message``
    as ``detail`` (a dedicated handler, so the prod 5xx sanitizer does not
    replace the message with "Something went wrong").
    """

    def __init__(self, lang: str | None = None):
        self.lang = "da" if lang == "da" else "en"
        super().__init__(busy_message(self.lang))


def _lang_of(user: Any) -> str:
    if user is None:
        return "en"
    try:
        from app.services.owner_language import owner_lang

        return owner_lang(user)
    except Exception:  # noqa: BLE001
        return "en"


@contextlib.contextmanager
def vision_slot(user: Any = None, *, wait_s: float | None = None) -> Iterator[None]:
    """Hold one vision slot (blocking; for code running in a worker thread)."""
    wait = VISION_WAIT_S if wait_s is None else wait_s
    if not _vision_slots.acquire(timeout=wait):
        logger.warning("vision busy: all %d slots taken for %.1fs", VISION_MAX_CONCURRENT, wait)
        raise AIBusyError(_lang_of(user))
    try:
        yield
    finally:
        _vision_slots.release()


@contextlib.asynccontextmanager
async def vision_slot_async(user: Any = None, *, wait_s: float | None = None) -> AsyncIterator[None]:
    """Hold one vision slot from the event loop (never blocks the loop)."""
    wait = VISION_WAIT_S if wait_s is None else wait_s
    deadline = time.monotonic() + wait
    while not _vision_slots.acquire(blocking=False):
        if time.monotonic() >= deadline:
            logger.warning("vision busy: all %d slots taken for %.1fs", VISION_MAX_CONCURRENT, wait)
            raise AIBusyError(_lang_of(user))
        await asyncio.sleep(0.05)
    try:
        yield
    finally:
        _vision_slots.release()
