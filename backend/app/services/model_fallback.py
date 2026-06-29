"""Opus-for-accuracy → Sonnet-fallback wrapper for money-critical OCR.

A single, tight helper used by the number-extraction OCR services
(kasserapport_extractor, claude_vision_ocr, inventory_ocr) where a
misread digit means wrong money. It runs the Anthropic Messages call
twice at most:

  1. ACCURACY_MODEL  (claude-opus-4-8) — the premium accuracy tier.
  2. DEFAULT_MODEL   (claude-sonnet-4-6) — on ANY exception from step 1,
     log a warning and retry the EXACT same call once.

So a model outage / 404 / rate-limit on Opus degrades to today's exact
Sonnet behavior — it never breaks the OCR pipeline harder than a single
all-Sonnet call would. If the Sonnet retry ALSO raises, that exception
propagates unchanged so each caller's existing try/except (which returns
None → fallback chain / manual entry) keeps working exactly as before.

Design constraints honored:
  • Only the `model` kwarg changes between the two attempts. Prompt,
    images, tools, tool_choice, system, max_tokens, temperature and every
    other kwarg are forwarded verbatim — passed straight through to
    client.messages.create(**kwargs).
  • The caller passes a ready-built `client` (anthropic.Anthropic(...))
    so SDK init, api_key and timeout stay owned by the call site.
  • No new retry/backoff semantics beyond the single model-swap retry —
    callers that already wrap this in their own transient-retry loop keep
    that behavior layered on top of the all-Sonnet fallback.
"""
from __future__ import annotations

import logging
from typing import Any

from app.config import settings

logger = logging.getLogger("bonbox.model_fallback")


def call_with_fallback(
    client: Any,
    *,
    _label: str = "ocr",
    _primary: str | None = None,
    _fallback: str | None = None,
    **kwargs: Any,
) -> Any:
    """Run client.messages.create twice at most: ACCURACY_MODEL, then on
    any exception fall back ONCE to DEFAULT_MODEL.

    Args:
        client: an anthropic.Anthropic instance (already constructed with
            api_key + timeout by the caller).
        _label: short tag for the warning log so we can tell which OCR
            service degraded in production logs.
        **kwargs: forwarded verbatim to client.messages.create. Any
            `model` key the caller passes is ignored — the accuracy /
            default models are sourced from Settings so the tier is
            governed centrally.

    Returns:
        The anthropic Message response object from whichever model
        succeeded.

    Raises:
        Whatever client.messages.create raises on the DEFAULT_MODEL
        retry. The caller's existing exception handling (return None →
        graceful fallback) is therefore preserved unchanged.
    """
    # Default tier = accuracy (Opus 4.8) → default (Sonnet 4.5). Callers
    # can override with _primary / _fallback — e.g. the premium assistant
    # tier passes PREMIUM_MODEL → DEFAULT_MODEL. Existing OCR callers pass
    # neither, so their behavior is 100% unchanged.
    primary = _primary or getattr(settings, "ACCURACY_MODEL", "claude-opus-4-8")
    fallback = _fallback or getattr(settings, "DEFAULT_MODEL", "claude-sonnet-4-6")

    # Never let a stray caller-supplied model override the tier policy.
    kwargs.pop("model", None)

    try:
        return client.messages.create(model=primary, **kwargs)
    except Exception as e:  # noqa: BLE001 — fall back on ANY failure
        logger.warning(
            "[%s] primary model %r failed (%s: %s) — falling back to %r",
            _label, primary, type(e).__name__, e, fallback,
        )
        # Single retry with the fallback model. If THIS raises, it
        # propagates to the caller's own try/except (→ None → fallback).
        return client.messages.create(model=fallback, **kwargs)
