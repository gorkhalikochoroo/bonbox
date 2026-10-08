"""Where a close's figures came from, and what happened to it after the lock.

Two facts a revisor needs and no artifact printed:

* **History.** Re-locking a close clears the row's own unlock fields, so the
  only lasting record of "låst op 29.09 af …, årsag: …, låst igen …" is the
  append-only audit trail (`daily_close.unlock` / `daily_close.lock`). These
  helpers read it — tenant-scoped — so the kasserapport PDF, the Excel, the CSV
  and the correction e-mail can all print the same history.
* **Source.** Whether the figures were read off a Z-bon photo or typed, whether
  the owner corrected the scan, and the tills when two were added together.
"""
from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from app.services.daily_close_range_export import dk_datetime


def close_history_events(db, user, closes) -> dict[str, list[dict]]:
    """{str(close_id): [{"kind": "unlock"|"relock"|"lock", "at", "by", "reason"}]}
    in time order, for closes that were ever unlocked. Empty dict on any error —
    history is a side channel and must never break an artifact."""
    ids = [c.id for c in closes if getattr(c, "id", None) is not None]
    if not ids or db is None or user is None:
        return {}
    try:
        from app.models.audit_log import AuditLog
        rows = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.entity_type == "daily_close",
                AuditLog.entity_id.in_(ids),
                AuditLog.action.in_(("daily_close.unlock", "daily_close.lock")),
            )
            .order_by(AuditLog.created_at.asc())
            .all()
        )
    except Exception:  # noqa: BLE001
        return {}
    per: dict[str, list] = defaultdict(list)
    for r in rows:
        per[str(r.entity_id)].append(r)
    out: dict[str, list[dict]] = {}
    for cid, evs in per.items():
        if not any(e.action == "daily_close.unlock" for e in evs):
            continue
        events: list[dict] = []
        seen_unlock = False
        for e in evs:
            try:
                after = json.loads(e.after_state or "{}") or {}
            except Exception:  # noqa: BLE001
                after = {}
            if e.action == "daily_close.unlock":
                seen_unlock = True
                events.append({
                    "kind": "unlock", "at": e.created_at,
                    "by": after.get("unlocked_by") or None,
                    "reason": after.get("unlock_reason") or None,
                })
            else:
                events.append({
                    "kind": "relock" if seen_unlock else "lock",
                    "at": e.created_at, "by": after.get("closed_by") or None,
                    "reason": None,
                })
        out[cid] = events
    return out


_ROLE_WORDS = {
    "owner": ("ejeren", "the owner"),
    "manager": ("lederen", "the manager"),
}


def actor_display(by: Any, *, danish: bool = True) -> str | None:
    """Who unlocked a close, as a document a REVISOR receives may name them:
    the role ('ejeren') or a person's name — never a login e-mail. Older rows
    stored the owner's sign-in address; they read 'ejeren' too (an unlock is
    owner-only). The address itself stays in the audit trail."""
    s = str(by or "").strip()
    if not s:
        return None
    role = _ROLE_WORDS.get(s.lower())
    if role:
        return role[0] if danish else role[1]
    if "@" in s:
        return _ROLE_WORDS["owner"][0] if danish else _ROLE_WORDS["owner"][1]
    return s


def format_history(events: list[dict], *, danish: bool = True, tz=None) -> str:
    """One line: 'Låst 25.09.2026 kl. 23:28 · Låst op 29.09.2026 kl. 09:00 af
    ejeren — årsag: Forkert kortbeløb · Låst igen 29.09.2026 kl. 09:12'."""
    parts = []
    for ev in events or []:
        when = dk_datetime(ev.get("at"), tz, danish=danish)
        if ev["kind"] == "unlock":
            who = actor_display(ev.get("by"), danish=danish)
            reason = ev.get("reason") or "—"
            if danish:
                parts.append(f"Låst op {when}" + (f" af {who}" if who else "") + f" — årsag: {reason}")
            else:
                parts.append(f"Unlocked {when}" + (f" by {who}" if who else "") + f" — reason: {reason}")
        elif ev["kind"] == "relock":
            parts.append(("Låst igen " if danish else "Locked again ") + when)
        else:
            parts.append(("Låst " if danish else "Locked ") + when)
    return " · ".join(parts)


def close_history_lines(db, user, closes, *, danish: bool = True, tz=None) -> dict[str, str]:
    return {
        cid: format_history(evs, danish=danish, tz=tz)
        for cid, evs in close_history_events(db, user, closes).items()
    }


# ─── Source ───────────────────────────────────────────────────────────────

def source_meta_of(dc: Any) -> dict:
    raw = getattr(dc, "source_meta", None)
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def source_line(dc: Any, *, danish: bool = True, currency: str = "DKK") -> str:
    """'Z-bon (scannet) · 2 terminaler lagt sammen: 12.000,00 kr. + 16.469,00 kr.
    · rettet af ejeren: Kort, Mad' — or 'Indtastet' for a typed close."""
    from app.services.bonbox_pdf_kit import money_dk
    from app.services.close_category_labels import payment_method_label, revenue_category_label
    meta = source_meta_of(dc)
    kind = meta.get("kind")
    if not kind:
        # Closes saved before the source was recorded: the photo is the only
        # evidence. Say what is known and no more.
        if getattr(dc, "receipt_photo", None):
            return "Z-bon-foto gemt" if danish else "Z-report photo on file"
        return ""
    edited = bool(meta.get("edited_after_unlock"))
    edited_txt = ("rettet af ejeren efter oplåsning" if danish
                  else "corrected by the owner after unlocking")
    if kind == "typed":
        typed = "Indtastet af kasseansvarlig" if danish else "Typed in by the closer"
        return f"{typed} · {edited_txt}" if edited else typed
    parts = ["Z-bon (scannet)" if danish else "Z-report (scanned)"]
    totals = [t for t in (meta.get("terminal_totals") or []) if isinstance(t, (int, float))]
    # A till list is only printed while it still adds up to the stated revenue:
    # "5.000 + 7.500" beside a corrected 13.000 contradicts the page.
    rev = getattr(dc, "revenue_total", None)
    if totals and rev is not None and abs(sum(totals) - float(rev)) > 0.5:
        totals = []
    # Tills the owner typed rather than scanned (a Z-bon added to a typed
    # close or a reopened draft) — never presented as a scanned till.
    typed_tills = {t for t in (meta.get("typed_tills") or []) if isinstance(t, int) and not isinstance(t, bool)}
    typed_mark = " (indtastet)" if danish else " (typed in)"
    # The owner typed the day's total on a day of several tills: each till's
    # own figure (the bon's read total, or the typed one) and the correction,
    # named separately — "Z-bon 1: 17.030,00 kr. · Z-bon 2: 4.000,00 kr. ·
    # rettet af ejeren til 21.500,00 kr.". The till list alone put the
    # correction on one till ("4.470,00 kr." for a bon that read 4.000).
    read = [t for t in (meta.get("read_totals") or [])
            if isinstance(t, (int, float)) and not isinstance(t, bool)]
    corrected_to = (len(totals) >= 2 and len(read) == len(totals) and rev is not None
                    and abs(sum(read) - float(rev)) >= 0.005)
    if corrected_to:
        scanned = [i for i in range(len(read)) if i not in typed_tills]
        parts.append(f"{len(totals)} terminaler lagt sammen" if danish else f"{len(totals)} tills added together")
        for i, t in enumerate(read):
            if i in typed_tills:
                label = "indtastet" if danish else "typed in"
            else:
                bon = "Z-bon" if danish else "Z-report"
                label = bon if len(scanned) == 1 else f"{bon} {scanned.index(i) + 1}"
            parts.append(f"{label}: {money_dk(t, currency)}")
        parts.append(("rettet af ejeren til " if danish else "corrected by the owner to ")
                     + money_dk(float(rev), currency))
    elif len(totals) >= 2:
        amounts = " + ".join(money_dk(t, currency) + (typed_mark if i in typed_tills else "")
                             for i, t in enumerate(totals))
        parts.append(
            (f"{len(totals)} terminaler lagt sammen: {amounts}") if danish
            else (f"{len(totals)} tills added together: {amounts}")
        )
    elif typed_tills:
        parts.append("lagt sammen med indtastede tal" if danish else "added to figures typed in")

    def _labels(keys):
        labels = []
        for k in keys[:8]:
            if k == "revenue_total":
                labels.append("Omsætning i alt" if danish else "Total revenue")
            elif k == "moms":
                labels.append("MOMS" if danish else "VAT")
            elif k == "tips":
                labels.append("Drikkepenge" if danish else "Tips")
            elif k.startswith("pay:"):
                labels.append(payment_method_label(k[4:], danish=danish))
            elif k.startswith("rev:"):
                labels.append(revenue_category_label(k[4:], danish=danish))
            else:
                labels.append(k)
        return ", ".join(labels)

    typed = [str(k) for k in (meta.get("typed") or []) if k]
    if typed:
        parts.append(("indtastet af ejeren: " if danish else "typed in by the owner: ") + _labels(typed))
    corrected = [str(k) for k in (meta.get("corrected") or []) if k]
    if corrected_to:
        # Said above, with the figure: "rettet af ejeren til 21.500,00 kr.".
        corrected = [k for k in corrected if k != "revenue_total"]
    if corrected:
        parts.append(
            ("rettet af ejeren efter scanning: " if danish else "corrected by the owner after the scan: ")
            + _labels(corrected)
        )
    if edited:
        parts.append(edited_txt)
    return " · ".join(parts)


def source_lines(closes, *, danish: bool = True, currency: str = "DKK") -> dict[str, str]:
    return {str(c.id): source_line(c, danish=danish, currency=currency) for c in closes}
