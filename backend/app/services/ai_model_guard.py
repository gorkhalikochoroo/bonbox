"""The safety net under every Anthropic Messages call (photo/text reading).

Three jobs, all on the request BonBox already builds — prompts, images and
tool schemas are never changed or logged here:

0. Thinking off on Sonnet 5.5. Every Sonnet 5.5 request whose caller left
   ``thinking`` unset goes out with ``thinking: {"type": "between_tools"}``
   (Sonnet 5.5's lowest setting: no extended thinking; it rejects
   ``{"type": "disabled"}``). Its default is adaptive thinking at effort
   "high", and thinking counts toward ``max_tokens`` — the 10/20-token
   classifiers and the JSON reads were sized for an answer only. Opus 4.8
   and the legacy Sonnet 5 requests are sent unchanged.

1. Model-not-found net. DEFAULT_MODEL / PREMIUM_MODEL are ids taken from
   Anthropic's published model list, not probed from this machine. If the
   API ever answers 404 ``not_found_error`` (or a 400 that names the model
   as invalid) for one of those two ids, the SAME call is retried ONCE on
   ``settings.LEGACY_SAFE_MODEL`` (the last id known to work on this
   account), and ONE error_logs row (error_type ``AI:ModelNotFound``,
   method ``AI``, path ``ai:model:<id>``, status_code NULL) is written per
   model per UTC day. The 15-minute ops triage (jobs/ops_triage_job.py)
   reads that table, so the operator gets one digest line about it. Any
   other error is re-raised untouched — callers keep their own handling
   (the accuracy tier's Opus -> Sonnet fallback in model_fallback.py,
   transient retries, "return None -> manual entry").

2. Forced tool use on models that refuse it. Claude Sonnet 5.5 (and Opus
   5.5 / Fable 5.1 / Mythos 5.1) answer 400 to ``tool_choice`` ``{"type":
   "tool"}`` / ``{"type": "any"}``, which every structured read here sends.
   For those models only, the request goes out with ``{"type": "auto"}``
   plus one system line naming the required tool (job 0 adds
   between_tools on Sonnet 5.5). The legacy retry is built from the
   caller's ORIGINAL arguments, so Sonnet 5 still gets the forced call it
   accepts. (Keeping the forced call with thinking off is not an option:
   Anthropic documents the 400 as a model restriction, not a thinking one.)
   ``auto`` does not guarantee the call, so an answer without the required
   tool call is asked ONCE more with the same request (not after a
   refusal); still none -> logged (model, tool name, stop_reason — never
   content) and the caller's existing "no tool_use block" path handles it.

The adapted shapes (jobs 0 and 2) were not tried live from this machine.
A 4xx on an adapted request (not model-not-found, not 408/409/429) is
re-raised as before, after ONE error_logs row ``AI:RequestRejected`` (path
``ai:request:<id>``, status_code NULL) per model per UTC day naming the
changed fields and the API's error text — so the ops triage digest says it.

``anthropic_client()`` (ai_limits.py) wraps every client it builds with
``guard_client``; ``call_with_fallback`` wraps the client it is handed, so
a caller that built its own client is covered too.
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, time as dtime
from typing import Any, Callable

from app.config import settings
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.ai_model_guard")

ALERT_ERROR_TYPE = "AI:ModelNotFound"
REJECTED_ERROR_TYPE = "AI:RequestRejected"
_ALERT_METHOD = "AI"
_ALERT_PATH_PREFIX = "ai:model:"
_REJECTED_PATH_PREFIX = "ai:request:"

# Models that reject tool_choice {"type": "tool"} / {"type": "any"} with a
# 400 ("tool_choice: type "tool" and "any" are not supported for this
# model."). Exact ids (a dated variant "<id>-YYYYMMDD" matches too).
_NO_FORCED_TOOL_CHOICE = (
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
)
# The thinking setting sent on EVERY request to these models when the caller
# left ``thinking`` unset (job 0). Sonnet 5.5 only: it rejects {"type":
# "disabled"}, and every other model rejects "between_tools".
_LOWEST_THINKING = {"claude-sonnet-5-5": {"type": "between_tools"}}
# between_tools is accepted at effort "high" or below only.
_EFFORT_ABOVE_HIGH = ("xhigh", "max")

# A 400 that says the model id itself is bad (not "... for this model").
_INVALID_MODEL_RE = re.compile(
    r"^\s*model:|invalid model|model\b[^.]*\b(not found|does not exist|is not a valid)",
    re.IGNORECASE,
)


# ── model-id helpers ─────────────────────────────────────────────────────

def _model_matches(model: Any, ids: tuple[str, ...] | dict) -> str | None:
    m = (model or "").strip().lower() if isinstance(model, str) else ""
    if not m:
        return None
    for base in ids:
        if m == base or m.startswith(base + "-"):
            return base
    return None


def rejects_forced_tool_choice(model: Any) -> bool:
    return _model_matches(model, _NO_FORCED_TOOL_CHOICE) is not None


def legacy_model_for(model: Any) -> str | None:
    """The model to retry on after a model-not-found answer, or None when
    ``model`` is not DEFAULT_MODEL / PREMIUM_MODEL (or already the legacy)."""
    legacy = (getattr(settings, "LEGACY_SAFE_MODEL", "") or "").strip()
    if not legacy or not isinstance(model, str) or not model or model == legacy:
        return None
    guarded = {
        getattr(settings, "DEFAULT_MODEL", None),
        getattr(settings, "PREMIUM_MODEL", None),
    }
    return legacy if model in guarded else None


def served_model(resp: Any, requested: str | None) -> str | None:
    """The model that actually answered (``Message.model``), else the one
    requested — e.g. after a legacy retry the response names the legacy id."""
    m = getattr(resp, "model", None)
    return m if isinstance(m, str) and m else requested


def first_text(content: Any) -> str | None:
    """Text of the first text block in a Messages ``content`` list (SDK
    objects or raw JSON dicts). A response can begin with a ``thinking``
    block, so never read ``content[0]`` blindly. Blocks without a ``type``
    (test doubles) count as text when they carry one."""
    for block in content or []:
        if isinstance(block, dict):
            btype, text = block.get("type"), block.get("text")
        else:
            btype, text = getattr(block, "type", None), getattr(block, "text", None)
        if btype in (None, "text") and isinstance(text, str):
            return text
    return None


# ── model-not-found detection ────────────────────────────────────────────

def _error_dict(body: Any) -> dict:
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return err
    return {}


def is_model_not_found_response(status: Any, body: Any) -> bool:
    """True for HTTP 404 / ``not_found_error``, or a 400 whose message names
    the model id as invalid. False for everything else (rate limits,
    overload, auth, a 400 about tool_choice / thinking "for this model")."""
    err = _error_dict(body)
    if status == 404 or err.get("type") == "not_found_error":
        return True
    if status == 400 and err.get("type") == "invalid_request_error":
        return bool(_INVALID_MODEL_RE.search(str(err.get("message") or "")))
    return False


def is_model_not_found(exc: BaseException) -> bool:
    """Duck-typed on purpose: tests swap the ``anthropic`` module for fakes,
    so ``anthropic.NotFoundError`` may not exist."""
    return is_model_not_found_response(
        getattr(exc, "status_code", None), getattr(exc, "body", None),
    )


# ── the one ops alert per model per day ──────────────────────────────────

_alert_lock = threading.Lock()
# (error_type, model, UTC date) already recorded
_alerted: set[tuple[str, str, str]] = set()


def _record_daily_row(error_type: str, path_prefix: str, model: str, message: str) -> bool:
    """Write one error_logs row the ops triage reads — at most one per
    (error_type, model) per UTC day (in-process memo + a DB check that
    survives restarts). Returns True when a row was written. Never raises;
    carries model ids and API error text only, never prompt or image
    content."""
    day = utc_now().date()
    key = (error_type, str(model), day.isoformat())
    with _alert_lock:
        if key in _alerted:
            return False
        try:
            from app.utils.off_loop import pool_exhausted

            if pool_exhausted():
                logger.warning("%s row skipped for %s: DB pool exhausted", error_type, model)
                return False
            import app.database as _database
            from app.models.error_log import ErrorLog

            path = f"{path_prefix}{model}"[:500]
            db = _database.SessionLocal()
            try:
                earlier = (
                    db.query(ErrorLog.id)
                    .filter(
                        ErrorLog.error_type == error_type,
                        ErrorLog.path == path,
                        ErrorLog.created_at >= datetime.combine(day, dtime.min),
                    )
                    .first()
                )
                wrote = False
                if earlier is None:
                    db.add(ErrorLog(
                        method=_ALERT_METHOD,
                        path=path,
                        status_code=None,  # the ops triage reads NULL rows
                        error_type=error_type,
                        message=message[:1000],
                    ))
                    db.commit()
                    wrote = True
            finally:
                db.close()
            for k in [k for k in _alerted if k[2] != key[2]]:
                _alerted.discard(k)
            _alerted.add(key)
            return wrote
        except Exception as e:  # noqa: BLE001 — an alert must never cost the read
            logger.warning("%s row not written: %s", error_type, type(e).__name__)
            return False


def record_model_not_found(model: str, retried_on: str | None) -> bool:
    """The AI:ModelNotFound row (job 1) — one per model per UTC day."""
    then = (
        f"retried once on {retried_on!r} (BONBOX_SAFE_MODEL)"
        if retried_on else "not retried"
    )
    return _record_daily_row(
        ALERT_ERROR_TYPE, _ALERT_PATH_PREFIX, model,
        f"Anthropic answered model-not-found for {model!r}; {then}. "
        "Set BONBOX_DEFAULT_MODEL / BONBOX_PREMIUM_MODEL to a working "
        "model id in Render.",
    )


def is_request_rejected_response(status: Any, body: Any) -> bool:
    """A 4xx that rejects the request itself. Not model-not-found (job 1
    has its own row) and not 408 / 409 / 429 (transient; the SDK retries)."""
    return (
        isinstance(status, int) and 400 <= status < 500
        and status not in (408, 409, 429)
        and not is_model_not_found_response(status, body)
    )


def note_rejected(sent: dict, original: dict, status: Any, body: Any) -> bool:
    """When ``sent`` is a request this guard ADAPTED (``adapt_request``
    changed it) and Anthropic rejected it with a 4xx, write one
    AI:RequestRejected row per model per UTC day — the adapted shape was
    never tried live, so the operator must hear if it is refused. Names the
    changed fields and the API's error text, never prompt content. Returns
    True when a row was written; never raises."""
    if sent is original or not is_request_rejected_response(status, body):
        return False
    model = str(original.get("model") or "?")
    changed = sorted(k for k in {*sent, *original} if sent.get(k) != original.get(k))
    err = _error_dict(body)
    return _record_daily_row(
        REJECTED_ERROR_TYPE, _REJECTED_PATH_PREFIX, model,
        f"Anthropic answered {status} {err.get('type') or ''} to a {model!r} request "
        f"BonBox adapted (changed: {', '.join(changed) or '-'}): "
        f"{str(err.get('message') or '')[:300]} — that read failed (not retried). "
        "If every read on this model fails, set BONBOX_DEFAULT_MODEL / "
        "BONBOX_PREMIUM_MODEL to BONBOX_SAFE_MODEL (claude-sonnet-5) in Render.",
    )


# ── request adaptation ───────────────────────────────────────────────────

def _with_system_line(system: Any, line: str) -> Any:
    if system is None or system == "" or system == []:
        return line
    if isinstance(system, str):
        return f"{system}\n\n{line}"
    if isinstance(system, (list, tuple)):
        # After any cache_control block, so the cached prefix is unchanged.
        return [*system, {"type": "text", "text": line}]
    return system


def _effort(kwargs: dict) -> Any:
    oc = kwargs.get("output_config")
    return oc.get("effort") if isinstance(oc, dict) else None


def adapt_request(kwargs: dict) -> dict:
    """The kwargs to send for ``kwargs["model"]``. Returns ``kwargs`` itself
    (same object) when nothing changes. Two adaptations, each only where
    the caller left the field unset:

    * Sonnet 5.5, ANY request: ``thinking: {"type": "between_tools"}`` (no
      extended thinking). Left alone, Sonnet 5.5 thinks adaptively at effort
      "high", and thinking counts toward ``max_tokens`` — a 10-token
      classifier or a 1200-token JSON read can end inside the thinking
      block with no answer. Skipped when the caller set ``thinking`` or an
      effort above "high" (between_tools would 400 there).
    * A model that refuses forced tool use, when the caller forced it:
      ``tool_choice`` auto + one system line naming the tool."""
    model = kwargs.get("model")
    out = kwargs
    lowest = _LOWEST_THINKING.get(_model_matches(model, _LOWEST_THINKING) or "")
    if lowest is not None and "thinking" not in kwargs and _effort(kwargs) not in _EFFORT_ABOVE_HIGH:
        out = {**kwargs, "thinking": dict(lowest)}
    tc = kwargs.get("tool_choice")
    if not (isinstance(tc, dict) and tc.get("type") in ("tool", "any")):
        return out
    if _model_matches(model, _NO_FORCED_TOOL_CHOICE) is None:
        return out
    out = dict(out)
    auto: dict[str, Any] = {"type": "auto"}
    if "disable_parallel_tool_use" in tc:
        auto["disable_parallel_tool_use"] = tc["disable_parallel_tool_use"]
    out["tool_choice"] = auto
    name = tc.get("name") if tc.get("type") == "tool" else None
    if name:
        line = (f"Answer by calling the {name} tool exactly once. That tool call is "
                "required for this request; do not answer in plain text.")
    else:
        line = ("Answer by calling one of the provided tools. A tool call is required "
                "for this request; do not answer in plain text.")
    out["system"] = _with_system_line(kwargs.get("system"), line)
    return out


def _required_tool(kwargs: dict) -> str | None:
    tc = kwargs.get("tool_choice")
    if isinstance(tc, dict) and tc.get("type") == "tool":
        return tc.get("name") or "?"
    if isinstance(tc, dict) and tc.get("type") == "any":
        return "*"
    return None


def _has_tool_call(resp: Any, want: str) -> bool:
    return any(
        getattr(b, "type", None) == "tool_use" and (want == "*" or getattr(b, "name", None) == want)
        for b in getattr(resp, "content", None) or []
    )


def _create_requiring_tool(create: Callable[..., Any], sent: dict, original: dict) -> Any:
    """``create(**sent)``. When the guard turned the caller's FORCED tool
    call into ``auto`` (a model that refuses forced tool use) and the answer
    has no call to the required tool, ask ONCE more with the same request —
    ``auto`` does not guarantee the call. Not after a refusal (it would
    refuse again). Still no call: logged (model, tool, stop_reason — never
    content) and returned; the caller's "no tool_use block" path handles it."""
    resp = create(**sent)
    want = _required_tool(original)
    if want is None or sent.get("tool_choice") == original.get("tool_choice"):
        return resp  # nothing forced, or sent forced as the caller asked
    for attempt in (1, 2):
        if _has_tool_call(resp, want):
            return resp
        stop = getattr(resp, "stop_reason", None)
        retry = attempt == 1 and stop != "refusal"
        logger.warning(
            "[ai_model_guard] %s answered without the required %s tool call "
            "(stop_reason=%s)%s",
            sent.get("model"), want, stop, " — asking once more" if retry else "",
        )
        if not retry:
            return resp
        resp = create(**sent)
    return resp


# ── the guarded call ─────────────────────────────────────────────────────

def guarded_create(create: Callable[..., Any], kwargs: dict) -> Any:
    """``create(**kwargs)`` with the jobs above. Raises whatever the call
    raises, except a model-not-found answer for DEFAULT/PREMIUM, which is
    retried ONCE on LEGACY_SAFE_MODEL (that retry's errors propagate). A
    4xx on a request the guard adapted is re-raised after one ops row
    (``note_rejected``)."""
    model = kwargs.get("model")
    sent = adapt_request(kwargs)
    try:
        return _create_requiring_tool(create, sent, kwargs)
    except Exception as exc:
        legacy = legacy_model_for(model)
        if legacy is None or not is_model_not_found(exc):
            note_rejected(sent, kwargs, getattr(exc, "status_code", None), getattr(exc, "body", None))
            raise
        record_model_not_found(model, legacy)
        logger.warning(
            "[ai_model_guard] model %r not found — retrying once on %r", model, legacy,
        )
        original = {**kwargs, "model": legacy}
        return _create_requiring_tool(create, adapt_request(original), original)


class _GuardedMessages:
    __slots__ = ("_inner",)

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def create(self, **kwargs: Any) -> Any:
        return guarded_create(self._inner.create, kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class GuardedClient:
    """An Anthropic client whose ``messages.create`` runs through
    ``guarded_create``; every other attribute is the wrapped client's own.
    ``messages`` is resolved on each access, so a client that sets it late
    still works."""

    def __init__(self, client: Any) -> None:
        object.__setattr__(self, "_client", client)

    @property
    def messages(self) -> _GuardedMessages:
        return _GuardedMessages(self._client.messages)

    def __getattr__(self, name: str) -> Any:
        if name == "_client":  # not set yet (copy / unpickle): no recursion
            raise AttributeError(name)
        return getattr(self._client, name)


def guard_client(client: Any) -> Any:
    """Wrap ``client`` once (idempotent; None passes through)."""
    if client is None or isinstance(client, GuardedClient):
        return client
    return GuardedClient(client)
