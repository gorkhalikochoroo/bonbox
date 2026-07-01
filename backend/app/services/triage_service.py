"""AI On-call Triage — first-responder summaries for backend errors.

When new error fingerprints appear in error_logs, this service:
  1. groups occurrences by fingerprint (so 50× the same bug = 1 triage)
  2. SANITIZES messages and tracebacks (no JWTs, emails, API keys, CC
     numbers leak to the LLM provider)
  3. asks Claude for a triage note: probable_cause / blast_radius /
     severity / suggested_actions
  4. writes a TriageNote row + emails the admin once per fingerprint
     per cooldown period (default 24h)

Multi-barrier defense (same 7-layer pattern):

  Layer 1 — INPUT VALIDATION
      ↓ Admin auth on the trigger endpoint. Scan window bounded
        [10 min, 7 days] — defends against pathological inputs.

  Layer 2 — DETERMINISTIC PRECOMPUTE
      ↓ Group rows by fingerprint server-side. The model never queries
        anything; it only sees a sanitized summary of the group.

  Layer 3 — STRUCTURED LLM OUTPUT
      ↓ Tool-use enforces the (probable_cause, blast_radius, severity,
        suggested_actions) JSON schema. Token budget capped.

  Layer 4 — POST-VALIDATION + SANITIZATION
      ↓ Sanitizer strips JWTs, API keys, CC, emails, IPs, UUIDs from
        the LLM input AND output. HTML/script smuggling rejected.
        Severity coerced to enum. Length-capped strings.

  Layer 5 — FALLBACK
      ↓ If the LLM is unreachable, a deterministic note is generated
        from the group stats — admin still gets an email with the
        count, error type, and a "review the recent-errors panel" hint.

  Layer 6 — COOLDOWN (DEDUPE)
      ↓ One triage per fingerprint per 24h. Re-runs bump occurrence
        counts on the existing row instead of creating new rows or
        re-emailing.

  Layer 7 — TIGHT BUDGET
      ↓ Cap of 20 distinct fingerprints triaged per scan run. ~$0.005
        per triage with Sonnet. A scan run that triages 20 brand-new
        bugs costs ~$0.10 — and that's a really bad day.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.config import settings
from app.models.error_log import ErrorLog
from app.models.triage_note import TriageNote
from app.services.email_service import send_email
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# Sanitization (Layer 4) — strip secrets/PII before they touch the LLM
# ─────────────────────────────────────────────────────────────────

# Order matters. Run JWT detection BEFORE generic base64-ish patterns.
_SANITIZER_PATTERNS = [
    # JWTs (three base64 chunks separated by dots) — always replace with [JWT]
    (re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"), "[JWT]"),
    # Anthropic / OpenAI / GitHub / Stripe / Resend keys
    (re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), "[API_KEY]"),
    (re.compile(r"sk_(test|live)_[A-Za-z0-9]{20,}"), "[STRIPE_KEY]"),
    (re.compile(r"pk_(test|live)_[A-Za-z0-9]{20,}"), "[STRIPE_PUB]"),
    (re.compile(r"ghp_[A-Za-z0-9]{30,}"), "[GH_TOKEN]"),
    (re.compile(r"re_[A-Za-z0-9_\-]{20,}"), "[RESEND_KEY]"),
    # Generic Bearer in headers
    (re.compile(r"(?i)Bearer\s+[A-Za-z0-9_\-\.]{20,}"), "Bearer [REDACTED]"),
    # 13-19 digit credit-card-shaped strings
    (re.compile(r"\b\d{13,19}\b"), "[CC?]"),
    # Email addresses
    (re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), "[EMAIL]"),
    # IPv4 addresses
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
    # UUIDs (so "/sales/abc-1234" doesn't leak record IDs to the model;
    # path templating already handles the URL itself, but UUIDs can also
    # appear inside error messages like "ForeignKeyViolation user_id=...").
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "[UUID]"),
    # Danish CPR numbers (DDMMYY-NNNN) — extra precaution given BonBox handles staff data
    (re.compile(r"\b\d{6}-\d{4}\b"), "[CPR]"),
]


def sanitize(text: str | None, max_len: int = 2000) -> str:
    if not text:
        return ""
    s = text
    for pat, repl in _SANITIZER_PATTERNS:
        s = pat.sub(repl, s)
    if len(s) > max_len:
        s = s[: max_len] + "…"
    return s


# ─────────────────────────────────────────────────────────────────
# Fingerprint (Layer 2) — group similar errors together
# ─────────────────────────────────────────────────────────────────

# Replace IDs / numerics in URL paths so /sales/abc-123 and /sales/def-456
# share a fingerprint. Order: longer patterns first.
_PATH_NORMALIZERS = [
    (re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "/{uuid}"),
    (re.compile(r"/[0-9a-f]{16,}", re.I), "/{hex}"),
    (re.compile(r"/\d{2,}"), "/{n}"),
]


def _normalize_path(path: str | None) -> str:
    if not path:
        return ""
    p = path.split("?", 1)[0]
    for pat, repl in _PATH_NORMALIZERS:
        p = pat.sub(repl, p)
    return p[:200]


def _top_traceback_line(traceback: str | None) -> str:
    if not traceback:
        return ""
    # The "raised at" line is usually the deepest frame, which is most
    # specific. Take the LAST line of the traceback that looks like
    # 'File "..."' OR the first line of the trace if no such line.
    lines = [ln.strip() for ln in (traceback or "").splitlines() if ln.strip()]
    file_lines = [ln for ln in lines if ln.startswith("File ")]
    if file_lines:
        candidate = file_lines[-1]
    else:
        candidate = lines[-1] if lines else ""
    # Strip absolute paths so the same code path on two deploys hash the
    # same. Keep just the file basename + line + function.
    candidate = re.sub(r"File \"[^\"]*/(?P<f>[^/\"]+)\"", r'File "\g<f>"', candidate)
    return candidate[:200]


def fingerprint(err: ErrorLog) -> str:
    """16-char hex hash that's stable across user_id / timestamp / IDs."""
    raw = "|".join([
        (err.error_type or ""),
        _normalize_path(err.path),
        _top_traceback_line(err.traceback),
    ])
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────────
# Layer 3 — LLM call
# ─────────────────────────────────────────────────────────────────

_TRIAGE_TOOL = {
    "name": "publish_triage_note",
    "description": (
        "Write a first-responder triage note for the error group. Include a "
        "probable cause (1-2 sentences), blast radius (who is affected and how "
        "broadly), severity, and 1-3 suggested next actions for the operator."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "probable_cause": {"type": "string", "minLength": 10, "maxLength": 600},
            "blast_radius": {"type": "string", "minLength": 5, "maxLength": 400},
            "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
            "suggested_actions": {"type": "string", "minLength": 10, "maxLength": 800},
        },
        "required": ["probable_cause", "blast_radius", "severity", "suggested_actions"],
    },
}


_TRIAGE_SYSTEM = (
    "You are an on-call first responder for a small SaaS (BonBox — analytics "
    "for small businesses). When an error fingerprint fires, you read the "
    "sanitized group summary and write a calm, focused triage note for the "
    "solo operator. Keep each field short. No jargon, no apologies, no emoji. "
    "Suggested actions should be concrete and ranked by impact-vs-effort."
)


@dataclass
class _TriageOutput:
    probable_cause: str
    blast_radius: str
    severity: str
    suggested_actions: str
    polished_by_ai: bool = True


def _try_llm_triage(group_summary: dict) -> Optional[_TriageOutput]:
    try:
        import anthropic
    except ImportError:
        return None
    if not settings.ANTHROPIC_API_KEY or not settings.USE_CLAUDE_API:
        return None

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    model = getattr(settings, "AI_MODEL_TRIAGE", "claude-sonnet-5")

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=900,
            system=[{
                "type": "text",
                "text": _TRIAGE_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[_TRIAGE_TOOL],
            tool_choice={"type": "tool", "name": _TRIAGE_TOOL["name"]},
            messages=[{"role": "user", "content": json.dumps(group_summary, ensure_ascii=False)}],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("triage_service: Claude call failed: %s", e)
        return None

    block = next(
        (b for b in (resp.content or []) if getattr(b, "type", None) == "tool_use"),
        None,
    )
    if not block or block.name != _TRIAGE_TOOL["name"]:
        return None
    raw = block.input or {}

    # Layer 4 validation
    pc = sanitize(raw.get("probable_cause", ""), 600)
    br = sanitize(raw.get("blast_radius", ""), 400)
    sa = sanitize(raw.get("suggested_actions", ""), 800)
    sev = raw.get("severity", "medium")
    if sev not in ("low", "medium", "high", "critical"):
        sev = "medium"

    # No HTML smuggling in any field
    for s in (pc, br, sa):
        if "<" in s or ">" in s or "javascript:" in s.lower():
            logger.info("triage_service: rejecting LLM output (HTML smuggle)")
            return None
    if len(pc) < 10 or len(br) < 5 or len(sa) < 10:
        return None

    return _TriageOutput(
        probable_cause=pc,
        blast_radius=br,
        severity=sev,
        suggested_actions=sa,
        polished_by_ai=True,
    )


# ─────────────────────────────────────────────────────────────────
# Layer 5 — fallback
# ─────────────────────────────────────────────────────────────────

def _fallback_triage(group_summary: dict) -> _TriageOutput:
    """Deterministic note when the LLM is unreachable or rejected."""
    err_type = group_summary.get("error_type") or "Unknown error"
    path = group_summary.get("path_template") or "(no path)"
    count = int(group_summary.get("occurrence_count") or 1)
    affected = int(group_summary.get("affected_users") or 0)
    sev = "high" if count >= 50 else "medium" if count >= 5 else "low"
    return _TriageOutput(
        probable_cause=f"{err_type} firing on {path}. Specific cause not analyzed (AI offline).",
        blast_radius=f"{count} occurrence(s), {affected} affected user(s) within the scan window.",
        severity=sev,
        suggested_actions=(
            "1) Open the recent-errors admin panel to read the full traceback. "
            "2) Reproduce locally if possible. "
            "3) Patch and ship; the cooldown window prevents repeat emails."
        ),
        polished_by_ai=False,
    )


# ─────────────────────────────────────────────────────────────────
# Public scan entry point
# ─────────────────────────────────────────────────────────────────

@dataclass
class TriageRunResult:
    new_notes: list[TriageNote]
    skipped_count: int
    error_count: int
    window_minutes: int


# Cap on distinct fingerprints triaged per run (cost ceiling).
MAX_TRIAGES_PER_RUN = 20

# Cooldown — don't re-triage the same fingerprint or re-email within this window.
COOLDOWN_HOURS = 24


def run_triage(db: Session, *, window_minutes: int = 60, send_emails: bool = True) -> TriageRunResult:
    """Scan the last `window_minutes` of error_logs, fingerprint, triage
    new groups, email admin. Returns counts and the new notes."""
    if window_minutes < 10:
        window_minutes = 10
    if window_minutes > 7 * 24 * 60:
        window_minutes = 7 * 24 * 60
    cutoff = utc_now() - timedelta(minutes=window_minutes)

    rows = (
        db.query(ErrorLog)
        .filter(ErrorLog.created_at >= cutoff)
        .filter((ErrorLog.status_code.is_(None)) | (ErrorLog.status_code >= 500))
        .order_by(ErrorLog.created_at.desc())
        .limit(2000)  # safety bound
        .all()
    )

    # Group by fingerprint
    groups: dict[str, list[ErrorLog]] = {}
    for r in rows:
        fp = fingerprint(r)
        groups.setdefault(fp, []).append(r)

    new_notes: list[TriageNote] = []
    skipped = 0
    error_count = len(rows)

    cooldown_cutoff = utc_now() - timedelta(hours=COOLDOWN_HOURS)

    for fp, occurrences in list(groups.items())[:MAX_TRIAGES_PER_RUN * 4]:
        if len(new_notes) >= MAX_TRIAGES_PER_RUN:
            break

        # Has this fingerprint been triaged recently?
        recent = (
            db.query(TriageNote)
            .filter(
                TriageNote.fingerprint == fp,
                TriageNote.created_at >= cooldown_cutoff,
            )
            .first()
        )
        if recent:
            # Bump counts on the existing row instead of creating a duplicate
            recent.occurrence_count = (recent.occurrence_count or 0) + len(occurrences)
            recent.latest_seen_at = max(
                recent.latest_seen_at or utc_now(),
                max((o.created_at for o in occurrences if o.created_at), default=utc_now()),
            )
            recent.affected_users = max(
                recent.affected_users or 0,
                len({str(o.user_id) for o in occurrences if o.user_id}),
            )
            db.commit()
            skipped += 1
            continue

        # Build sanitized group summary for the LLM
        sample = occurrences[0]
        affected_users = len({str(o.user_id) for o in occurrences if o.user_id})
        summary = {
            "error_type": sample.error_type or "Unknown",
            "path_template": _normalize_path(sample.path),
            "method": sample.method or "",
            "status_code": sample.status_code,
            "occurrence_count": len(occurrences),
            "affected_users": affected_users,
            "first_seen": min((o.created_at.isoformat() for o in occurrences if o.created_at), default=""),
            "latest_seen": max((o.created_at.isoformat() for o in occurrences if o.created_at), default=""),
            "sample_message": sanitize(sample.message, 500),
            "sample_traceback": sanitize(sample.traceback, 2500),
        }

        llm_out = _try_llm_triage(summary)
        if llm_out is None:
            llm_out = _fallback_triage(summary)

        note = TriageNote(
            fingerprint=fp,
            severity=llm_out.severity,
            error_type=summary["error_type"][:100],
            path_template=summary["path_template"][:500] if summary["path_template"] else None,
            sample_message=summary["sample_message"][:1000],
            probable_cause=llm_out.probable_cause,
            blast_radius=llm_out.blast_radius,
            suggested_actions=llm_out.suggested_actions,
            polished_by_ai=llm_out.polished_by_ai,
            sample_error_id=sample.id,
            occurrence_count=len(occurrences),
            affected_users=affected_users,
            first_seen_at=datetime.fromisoformat(summary["first_seen"]) if summary["first_seen"] else utc_now(),
            latest_seen_at=datetime.fromisoformat(summary["latest_seen"]) if summary["latest_seen"] else utc_now(),
            email_sent=False,
        )
        db.add(note)
        db.commit()
        db.refresh(note)
        new_notes.append(note)

        # Email admin (Layer 6 ensures one email per fingerprint per cooldown)
        if send_emails and settings.ADMIN_EMAIL:
            try:
                _send_admin_triage_email(note, summary)
                note.email_sent = True
                db.commit()
            except Exception as e:  # noqa: BLE001
                logger.warning("triage_service: email send failed: %s", e)

    return TriageRunResult(
        new_notes=new_notes,
        skipped_count=skipped,
        error_count=error_count,
        window_minutes=window_minutes,
    )


# ─────────────────────────────────────────────────────────────────
# Email rendering — sanitized at every boundary
# ─────────────────────────────────────────────────────────────────

def _esc(s: str | None) -> str:
    """HTML-escape user/error text for safe inclusion in the email body.
    Even though we sanitize, we still HTML-escape because the LLM output
    could contain ampersands / quotes that confuse mail clients."""
    if not s:
        return ""
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
    )


_SEVERITY_COLOR = {
    "low": "#94a3b8",
    "medium": "#f59e0b",
    "high": "#dc2626",
    "critical": "#7f1d1d",
}


def _send_admin_triage_email(note: TriageNote, summary: dict) -> None:
    color = _SEVERITY_COLOR.get(note.severity, "#94a3b8")
    sev_label = (note.severity or "medium").upper()
    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:22px;border:1px solid #e5e7eb">
    <div style="display:inline-block;background:{color}20;color:{color};font-size:11px;font-weight:700;letter-spacing:0.06em;padding:4px 10px;border-radius:999px;text-transform:uppercase">
      {sev_label} · BonBox Triage
    </div>
    <h2 style="font-size:18px;color:#0f172a;margin:14px 0 6px">{_esc(summary.get('error_type'))}</h2>
    <p style="font-size:13px;color:#64748b;margin:0 0 18px">{_esc(summary.get('method'))} {_esc(summary.get('path_template'))} · {note.occurrence_count} occurrence{'s' if note.occurrence_count != 1 else ''} · {note.affected_users} affected user{'s' if note.affected_users != 1 else ''}</p>

    <h3 style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 4px">Probable cause</h3>
    <p style="font-size:14px;color:#334155;margin:0;line-height:1.55">{_esc(note.probable_cause)}</p>

    <h3 style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 4px">Blast radius</h3>
    <p style="font-size:14px;color:#334155;margin:0;line-height:1.55">{_esc(note.blast_radius)}</p>

    <h3 style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 4px">Suggested actions</h3>
    <p style="font-size:14px;color:#334155;margin:0;line-height:1.55;white-space:pre-line">{_esc(note.suggested_actions)}</p>

    <div style="border-top:1px solid #e5e7eb;margin-top:22px;padding-top:14px;font-size:12px;color:#94a3b8">
      Sample error ID: {_esc(str(note.sample_error_id) if note.sample_error_id else '')}<br>
      Open recent errors: <a href="https://bonbox.dk/admin" style="color:#16a34a;text-decoration:none">bonbox.dk/admin</a><br>
      Cooldown: 24h — duplicates of this fingerprint won't email again until then.
    </div>
  </div>
  <p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px">Generated by BonBox AI Triage · {'AI-polished' if note.polished_by_ai else 'Deterministic fallback'}</p>
</div>"""
    subject = f"[BonBox triage · {sev_label}] {summary.get('error_type', 'Error')} on {summary.get('path_template', '')}"
    send_email(settings.ADMIN_EMAIL, subject, html)


# ─────────────────────────────────────────────────────────────────
# Serialization for the admin endpoint
# ─────────────────────────────────────────────────────────────────

def serialize_note(n: TriageNote) -> dict:
    return {
        "id": str(n.id),
        "fingerprint": n.fingerprint,
        "severity": n.severity,
        "error_type": n.error_type,
        "path_template": n.path_template,
        "probable_cause": n.probable_cause,
        "blast_radius": n.blast_radius,
        "suggested_actions": n.suggested_actions,
        "polished_by_ai": bool(n.polished_by_ai),
        "occurrence_count": n.occurrence_count,
        "affected_users": n.affected_users,
        "sample_error_id": str(n.sample_error_id) if n.sample_error_id else None,
        "first_seen_at": n.first_seen_at.isoformat() if n.first_seen_at else None,
        "latest_seen_at": n.latest_seen_at.isoformat() if n.latest_seen_at else None,
        "email_sent": bool(n.email_sent),
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }
