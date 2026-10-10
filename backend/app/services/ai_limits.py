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
   at once across the process, and at most ``VISION_MAX_PER_USER`` of them
   for any one account, so one venue can never hold every slot. A read
   that cannot get a slot waits up to ``VISION_WAIT_S`` and then fails
   LOUDLY with ``AIBusyError`` (HTTP 503 "busy, try again" in the owner's
   language) — never a silent drop. Given the route's DB session, the slot
   first hands its pooled connection back (``release_db_connection``), so
   a request waiting for a slot — or holding one through a 30–60 s model
   call — does not also pin one of the pool's 15 connections.
3. ``counted_use()`` — the count-based plan caps (Free: 10 smart scans a
   day, ...) count a row that the route writes AFTER the paid read. While
   the routes ran on the event loop that check → read → write was atomic;
   in the threadpool, parallel requests would all pass the check before
   any of them wrote. ``counted_use`` runs the check under a per-account
   lock and counts the reads still in flight, so the cap holds exactly.
4. (Not here, at the call sites.) Routes that make these calls are plain
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
from typing import Any, AsyncIterator, Callable, Iterator

from sqlalchemy import event
from sqlalchemy.orm import Session

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

#: Photo reads allowed in flight at once, process-wide. Sized for the
#: production instance (1 CPU / 2 GB since 10 Oct, one process). A read is
#: mostly a 30-60 s wait on the vendor, but it starts with a decode, and the
#: decodes are what cost memory: measured under Linux (10 Oct), one read of
#: a 48 MP phone photo peaks at ~390 MB (a 50 MP RGBA PNG / TIFF ~380 MB;
#: WEBP is held to 25 MP by image_guard for the same reason). Next to a
#: steady state of up to ~600 MB, the decodes in flight plus the heaviest
#: other request (the GDPR export, ~70 MB) must stay under ~1.4 GB:
#:   3 x 390 + 70 = ~1.24 GB  (4 x 390 + 70 = ~1.63 GB would not fit).
#: Under glibc's default malloc a freed decode stays in its worker thread's
#: arena, so the steady state itself climbs past 600 MB (10 Oct load test:
#: ~1 GB, peak 1.97 GB); MALLOC_ARENA_MAX / MALLOC_MMAP_THRESHOLD_ on the
#: service keep it down. A 4th read waits (up to ``VISION_WAIT_S``) instead
#: of risking the API.
VISION_MAX_CONCURRENT = 3
#: Photo reads one account may have in flight at once. Below the global
#: limit, so one venue (or one hostile account) always leaves a slot free
#: for every other venue's Z-report and receipt reads.
VISION_MAX_PER_USER = 2
#: How long an extra read waits for a free slot before the 503.
VISION_WAIT_S = 10.0
#: Retry-After header (seconds) on the busy 503.
BUSY_RETRY_AFTER_S = 10

# A threading semaphore (not asyncio): the sync routes hold it from their
# worker thread and the async routes poll it from the event loop, so one
# counter covers both — and it is not bound to any one event loop.
_vision_slots = threading.BoundedSemaphore(VISION_MAX_CONCURRENT)

# Per-account semaphores, created on first use and dropped when the last
# holder / waiter leaves, so the dict only ever holds accounts with a read
# in flight.
_user_slots: dict[str, list] = {}  # account id -> [BoundedSemaphore, refs]
_user_slots_lock = threading.Lock()

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


def _user_key(user: Any) -> str | None:
    if user is None:
        return None
    try:
        uid = getattr(user, "id", None)
    except Exception:  # noqa: BLE001
        return None
    return str(uid) if uid is not None else None


def _user_entry_enter(key: str) -> list:
    with _user_slots_lock:
        entry = _user_slots.get(key)
        if entry is None:
            entry = [threading.BoundedSemaphore(VISION_MAX_PER_USER), 0]
            _user_slots[key] = entry
        entry[1] += 1
        return entry


def _user_entry_leave(key: str, entry: list) -> None:
    with _user_slots_lock:
        entry[1] -= 1
        if entry[1] <= 0 and _user_slots.get(key) is entry:
            del _user_slots[key]


# ── Hand the DB connection back before a long wait ──────────────────────

# A session that has FLUSHED writes (not yet committed) must never be
# committed early by the slot. ``Session.new/dirty/deleted`` are empty
# after a flush, so the flag below remembers it until the transaction ends.
_FLUSHED_KEY = "bonbox_flushed_writes"


@event.listens_for(Session, "after_flush")
def _mark_flushed(session: Session, _ctx: Any) -> None:  # pragma: no cover - trivial
    session.info[_FLUSHED_KEY] = True


@event.listens_for(Session, "after_transaction_end")
def _clear_flushed(session: Session, transaction: Any) -> None:  # pragma: no cover - trivial
    if getattr(transaction, "parent", None) is None:
        session.info.pop(_FLUSHED_KEY, None)


def release_db_connection(db: Any) -> bool:
    """Give the session's pooled connection back before a long wait.

    ``get_current_user`` and the cap count leave a read transaction open,
    which keeps one of the pool's connections checked out until the
    request ends — through the slot wait (up to 10 s) and the model call
    (30–60 s). This ends that read-only transaction WITHOUT expiring the
    loaded objects (``user`` stays readable, no extra query), so the next
    query simply checks a connection out again.

    Does nothing — and returns False — when the session holds pending or
    flushed-but-uncommitted writes: committing those early would change
    what the route commits, so such a session keeps its connection.
    """
    if db is None or not isinstance(db, Session):
        return False
    try:
        if db.new or db.dirty or db.deleted or db.info.get(_FLUSHED_KEY):
            return False
        if not db.in_transaction():
            return True
        prev = db.expire_on_commit
        db.expire_on_commit = False
        try:
            db.commit()
        finally:
            db.expire_on_commit = prev
        return True
    except Exception as e:  # noqa: BLE001 — never fail a read over this
        logger.warning("could not release the DB connection before the vision wait: %s", e)
        return False


@contextlib.contextmanager
def vision_slot(
    user: Any = None, *, wait_s: float | None = None, db: Any = None,
) -> Iterator[None]:
    """Hold one vision slot (blocking; for code running in a worker thread).

    ``user`` — the account the read is for: at most ``VISION_MAX_PER_USER``
    of its reads run at once. ``db`` — the route's session; when given, its
    connection goes back to the pool before the wait (see
    ``release_db_connection``).
    """
    wait = VISION_WAIT_S if wait_s is None else wait_s
    key = _user_key(user)
    if db is not None:
        release_db_connection(db)
    deadline = time.monotonic() + wait
    entry = _user_entry_enter(key) if key is not None else None
    try:
        if entry is not None and not entry[0].acquire(timeout=max(0.0, deadline - time.monotonic())):
            logger.warning(
                "vision busy: account already has %d reads in flight (waited %.1fs)",
                VISION_MAX_PER_USER, wait,
            )
            raise AIBusyError(_lang_of(user))
        try:
            if not _vision_slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
                logger.warning("vision busy: all %d slots taken for %.1fs", VISION_MAX_CONCURRENT, wait)
                raise AIBusyError(_lang_of(user))
            try:
                yield
            finally:
                _vision_slots.release()
        finally:
            if entry is not None:
                entry[0].release()
    finally:
        if entry is not None:
            _user_entry_leave(key, entry)


@contextlib.asynccontextmanager
async def vision_slot_async(user: Any = None, *, wait_s: float | None = None) -> AsyncIterator[None]:
    """Hold one vision slot from the event loop (never blocks the loop)."""
    wait = VISION_WAIT_S if wait_s is None else wait_s
    key = _user_key(user)
    deadline = time.monotonic() + wait
    entry = _user_entry_enter(key) if key is not None else None
    try:
        if entry is not None:
            while not entry[0].acquire(blocking=False):
                if time.monotonic() >= deadline:
                    logger.warning(
                        "vision busy: account already has %d reads in flight (waited %.1fs)",
                        VISION_MAX_PER_USER, wait,
                    )
                    raise AIBusyError(_lang_of(user))
                await asyncio.sleep(0.05)
        try:
            while not _vision_slots.acquire(blocking=False):
                if time.monotonic() >= deadline:
                    logger.warning("vision busy: all %d slots taken for %.1fs", VISION_MAX_CONCURRENT, wait)
                    raise AIBusyError(_lang_of(user))
                await asyncio.sleep(0.05)
            try:
                yield
            finally:
                _vision_slots.release()
        finally:
            if entry is not None:
                entry[0].release()
    finally:
        if entry is not None:
            _user_entry_leave(key, entry)


# ── Count-based caps that hold under concurrency ────────────────────────

#: How long a request waits for another request of the SAME account to
#: finish its cap check / counting commit (both are single DB statements).
CAP_LOCK_WAIT_S = 30.0


class _CapEntry:
    __slots__ = ("lock", "in_flight", "refs")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.in_flight = 0
        self.refs = 0


_cap_entries: dict[tuple[str, str], _CapEntry] = {}
_cap_entries_lock = threading.Lock()


class CapUse:
    """This request's reserved use(s) of one account's cap."""

    def __init__(self, entry: _CapEntry, user: Any) -> None:
        self._entry = entry
        self._user = user
        self.reserved = 0

    def _acquire(self) -> None:
        if not self._entry.lock.acquire(timeout=CAP_LOCK_WAIT_S):
            logger.warning("cap check busy for %.0fs", CAP_LOCK_WAIT_S)
            raise AIBusyError(_lang_of(self._user))

    @contextlib.contextmanager
    def recording(self) -> Iterator[None]:
        """Wrap the write + commit of the row(s) that count toward the cap.

        Runs under the account's cap lock and hands this request's
        reservation back on exit, so the committed row replaces the
        reservation with no moment where the use counts twice (a false
        "limit reached" for a parallel request) or not at all.
        """
        self._acquire()
        try:
            yield
        finally:
            self._entry.in_flight -= self.reserved
            self.reserved = 0
            self._entry.lock.release()


@contextlib.contextmanager
def counted_use(user: Any, cap_key: str, check: Callable[[int], Any]) -> Iterator[CapUse]:
    """Reserve one account's use of a count-based cap for this request.

    ``check(in_flight)`` runs under a per-(account, cap) lock. It counts the
    account's committed uses, adds ``in_flight`` (uses other requests have
    reserved but not yet written) and raises the route's usual 402 / 429
    when the cap is reached. It returns how many uses to reserve (``None``
    means 1; 0 for an unlimited plan). The reservation is held until the
    route commits its counting row inside ``use.recording()`` — or until
    the block exits without one (the read failed / was refused), when it
    is simply given back, exactly as if the request had never come.

    The lock is per process: production runs one uvicorn worker. With more
    workers this would need a DB-level reservation.
    """
    key = (str(getattr(user, "id", "")), cap_key)
    with _cap_entries_lock:
        entry = _cap_entries.get(key)
        if entry is None:
            entry = _CapEntry()
            _cap_entries[key] = entry
        entry.refs += 1
    use = CapUse(entry, user)
    try:
        use._acquire()
        try:
            n = check(entry.in_flight)
            n = 1 if n is None else max(0, int(n))
            entry.in_flight += n
            use.reserved = n
        finally:
            entry.lock.release()
        try:
            yield use
        finally:
            if use.reserved:
                with entry.lock:
                    entry.in_flight -= use.reserved
                    use.reserved = 0
    finally:
        with _cap_entries_lock:
            entry.refs -= 1
            if entry.refs <= 0 and _cap_entries.get(key) is entry:
                del _cap_entries[key]
