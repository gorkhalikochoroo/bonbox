"""The single-close kasserapport PDF — ONE builder for every copy of it.

It used to live inline in the GET /daily-close/{id}/pdf route, so nothing else
could call it: the lock mail attached a different document (the one-day range
export) with the opposite readiness verdict. History's download, the lock mail
and the explicit resend now all render through here, so the revisor receives
exactly the document the owner reviewed — same figures, same verdict, same
document id.

What a revisor needs on it, and now gets:
  · identity — business, address, CVR, the branch when there is one, the day,
    a bilag number (KR-…), who closed it and when it was LOCKED (venue time);
  · traceability — a document id derived from the close's content (stable:
    the downloaded copy and the mailed copy carry the same id), "Side x af y"
    on every page and a running header on page 2+;
  · source and history — Z-bon scan vs typed, tills added together, figures the
    owner corrected, and every unlock/relock (who, when, why) from the audit
    trail;
  · the cash count as the app shows it — byttepenge, "Optalt (uden
    byttepenge)", and the difference in words;
  · the retention note.

Every assertion is derived in services/kasserapport_claims.py and only drawn
here. Everything a person typed is escaped at the Paragraph boundary.
"""
from __future__ import annotations

import hashlib
import json

from sqlalchemy import func

from app.models.business_profile import BusinessProfile
from app.services.bonbox_pdf_kit import escape_pdf_text


def close_filename(business_name: str, d, *, locked: bool = True,
                   branch: str | None = None) -> str:
    """'Kasserapport Mirabelle ApS 2026-09-25.pdf' — business + date, safe
    characters. A draft says so in its name: a kladde mailed on and opened a
    week later is identified by its filename alone. Two branches closing the
    same day get two names ('… Mirabelle ApS Vesterbro 2026-09-04.pdf'), never
    one name a revisor reads as a duplicate."""
    from app.services.revisor_mail import safe_name_part
    lead = "Kasserapport" if locked else "Kasserapport KLADDE"
    who = safe_name_part(business_name)
    if branch:
        who = f"{who} {safe_name_part(branch, 30)}"
    return f"{lead} {who} {d.isoformat()}.pdf"


def branch_code(branch_name: str | None, branch_id) -> str:
    """A short, unique tag for a branch in a bilag number: up to 3 letters of
    the name (æ/ø/å folded) + 4 hex of the branch id — 'VES3F2A'. The letters
    say which shop; the id part keeps 'Vesterbro' and 'Vestergade' apart."""
    import re as _re
    name = (branch_name or "").upper()
    for a, b in (("Æ", "AE"), ("Ø", "OE"), ("Å", "AA"), ("Ü", "U"), ("Ö", "O"), ("Ä", "A")):
        name = name.replace(a, b)
    letters = _re.sub(r"[^A-Z0-9]", "", name)[:3] or "AFD"
    hexpart = _re.sub(r"[^0-9A-Fa-f]", "", str(branch_id or ""))[:4].upper()
    return f"{letters}{hexpart}"


def close_bilagsnummer(dc, branch_name: str | None = None) -> str:
    """The single kasserapport's bilag number: KR-YYYYMMDD, plus the branch
    code when the close belongs to a branch — two branches locking the same
    day used to share one number. One day, so the date is printed once (it
    read 'KR-20260925-20260925-…'), short enough for the period exports'
    Bilag column, where every row now carries it."""
    base = f"KR-{dc.date.strftime('%Y%m%d')}"
    if getattr(dc, "branch_id", None):
        return f"{base}-{branch_code(branch_name, dc.branch_id)}"
    return base


def generated_local(tz=None, *, danish: bool = True) -> str:
    """'07.10.2026 kl. 23:19' — the generation time on the SAME clock as the
    lock time beside it (the footer said '… 21:19 UTC' next to a local lock
    time)."""
    try:
        from app.services.kasserapport_claims import local_dt
        from app.utils.time import utc_now
        loc = local_dt(utc_now(), tz)
        return loc.strftime("%d.%m.%Y kl. %H:%M") if danish else loc.strftime("%d %b %Y %H:%M")
    except Exception:  # noqa: BLE001
        return ""


def band_line_markup(check: dict, *, ink: str = "#171717", ok: str = "#065f46",
                     muted: str = "#6b7280") -> str:
    """One line of the readiness band. A FAILING line is the one a revisor
    must act on, so it is the darkest on the page — ink, bold, with the ×
    mark — and survives black-and-white print; colour is only a second cue.
    It used to be amber at 8 pt, the faintest line in a grayscale print.
    Passing lines are regular weight; information is a muted '·'."""
    from app.services.kasserapport_claims import MARK_FAIL, MARK_PASS
    text = check["text"]
    if check.get("info"):
        return f"<font color='{muted}' size='8'>· {text}</font>"
    if check["ok"]:
        return f"<font color='{ok}' size='8'>{MARK_PASS} {text}</font>"
    return (f"<font name='Helvetica-Bold' color='{ink}' size='8.5'>"
            f"{MARK_FAIL} {text}</font>")


def close_document_id(dc) -> str:
    """A stable 16-hex id for THIS version of the close: a digest of what the
    document states (figures, lines, status, lock time, closer, notes, source).
    The same close in the same state gives the same id on every download and in
    the lock mail — unlike a hash of the bytes, which changes with the
    generation timestamp printed in the footer. A re-lock with new figures gets
    a new id."""
    def _n(v):
        return None if v is None else round(float(v), 2)
    canon = {
        "id": str(getattr(dc, "id", "")),
        "date": dc.date.isoformat() if getattr(dc, "date", None) else None,
        "status": getattr(dc, "status", None) or "confirmed",
        "rev": getattr(dc, "revenue_categories", None),
        "pay": getattr(dc, "payment_categories", None),
        "revenue_total": _n(getattr(dc, "revenue_total", None)),
        "payment_total": _n(getattr(dc, "payment_total", None)),
        "moms_total": _n(getattr(dc, "moms_total", None)),
        "revenue_ex_moms": _n(getattr(dc, "revenue_ex_moms", None)),
        "cash_expected": _n(getattr(dc, "cash_expected", None)),
        "cash_counted": _n(getattr(dc, "cash_counted", None)),
        "cash_difference": _n(getattr(dc, "cash_difference", None)),
        "cash_float": _n(getattr(dc, "cash_float", None)),
        "tips_total": _n(getattr(dc, "tips_total", None)),
        "closed_by": getattr(dc, "closed_by", None),
        "closed_at": dc.closed_at.isoformat() if getattr(dc, "closed_at", None) else None,
        "notes": getattr(dc, "notes", None),
        "source": getattr(dc, "source_meta", None),
    }
    raw = json.dumps(canon, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _branch_name(db, user, dc) -> str | None:
    """The branch, when the close belongs to one — or when the business has
    more than one active branch, so 'which shop?' is never a question."""
    try:
        from app.models.branch import Branch
        if getattr(dc, "branch_id", None):
            b = db.query(Branch).filter(Branch.id == dc.branch_id, Branch.user_id == user.id).first()
            return b.name if b else None
    except Exception:  # noqa: BLE001
        return None
    return None


def build_close_kasserapport_pdf(db, user, dc, *, profile=None) -> dict:
    """Render the kasserapport for one close.

    Returns {"pdf": bytes, "filename": str, "doc_id": str, "bilagsnummer": str}.
    """
    if profile is None:
        profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()

    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Table, TableStyle, Paragraph, Spacer, HRFlowable, KeepTogether,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    from app.services.bonbox_pdf_kit import money_dk, render_with_doc_hash
    from app.services.close_history import close_history_events, format_history, source_line
    from app.services.kasserapport_claims import (
        MARK_PASS,
        MARK_REVIEW,
        build_close_claims,
    )
    from app.services.tz_utils import _user_zone
    from app.utils.document_hash import get_software_identifier

    # Copenhagen-clean palette
    AMBER = colors.HexColor("#b45309")     # "look at this" — never decorative
    OK_GREEN = colors.HexColor("#065f46")  # a check that actually passed
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    DANGER = colors.HexColor("#b91c1c")

    currency = user.currency or "DKK"
    tz = _user_zone(user)

    # ─── Voucher range for the day (Bogføringsloven audit trail) ───
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense
        sale_vmin, sale_vmax = (
            db.query(func.min(Sale.voucher_number), func.max(Sale.voucher_number))
            .filter(
                Sale.user_id == user.id,
                Sale.date == dc.date,
                Sale.voucher_number.is_not(None),
                Sale.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
        exp_vmin, exp_vmax = (
            db.query(func.min(Expense.voucher_number), func.max(Expense.voucher_number))
            .filter(
                Expense.user_id == user.id,
                Expense.date == dc.date,
                Expense.voucher_number.is_not(None),
                Expense.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
    except Exception:  # noqa: BLE001
        sale_vmin = sale_vmax = exp_vmin = exp_vmax = None

    branch = _branch_name(db, user, dc)
    bilagsnummer = close_bilagsnummer(dc, branch)

    # ── The document's claims — derived once, in kasserapport_claims ──
    profile_name = getattr(profile, "company_name", None) if profile else None
    claims = build_close_claims(
        dc,
        currency=currency,
        profile=profile,
        business_name=(profile_name or getattr(user, "business_name", None) or "—"),
        has_bilag=bool(sale_vmin or exp_vmin),
        bilagsnummer=bilagsnummer,
        tz=tz,
    )
    L = claims["labels"]
    DA = claims["danish"]
    doc_id = close_document_id(dc)

    def fmt(v):
        # The ONE Danish money formatter every BonBox export uses — DKK renders
        # "1.234,56 kr."; None → "—", never a fabricated 0.
        return money_dk(v, currency)

    def signed(v):
        if v is None:
            return "—"
        return ("+" if float(v) > 0.004 else "") + fmt(v)

    if DA:
        _DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni",
                      "juli", "august", "september", "oktober", "november", "december"]
        _DA_DAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]
        date_str = (f"{_DA_DAYS[dc.date.weekday()].capitalize()} {dc.date.day}. "
                    f"{_DA_MONTHS[dc.date.month - 1]} {dc.date.year}")
    else:
        date_str = dc.date.strftime("%A %d %B %Y")

    src = source_line(dc, danish=DA, currency=currency)
    history_events = close_history_events(db, user, [dc]).get(str(dc.id), [])
    if not history_events and getattr(dc, "unlock_reason", None):
        # Unlocked right now and not yet re-locked: the row still carries it.
        history_events = [{
            "kind": "unlock", "at": getattr(dc, "unlocked_at", None),
            "by": getattr(dc, "unlocked_by", None), "reason": dc.unlock_reason,
        }]

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=0,
                        textColor=INK, fontName="Helvetica-Bold", alignment=0, leading=17)
    h_period = ParagraphStyle("Period", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, alignment=TA_RIGHT, leading=12)
    # Compact on purpose: a normal close — categories, methods, a counted
    # drawer, tips, a note, a re-lock — must fit ONE A4 page. Page 2 used to
    # hold nothing but the band and the footer.
    section_title = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8.5,
                                   textColor=MUTED, fontName="Helvetica-Bold",
                                   leading=10.5, spaceBefore=5, spaceAfter=1)
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=9.5,
                         textColor=INK, fontName="Helvetica", leading=12)
    val_r = ParagraphStyle("ValR", parent=val, alignment=TA_RIGHT)
    val_b = ParagraphStyle("ValB", parent=val, fontName="Helvetica-Bold")
    val_br = ParagraphStyle("ValBR", parent=val_b, alignment=TA_RIGHT)
    meta = ParagraphStyle("Meta", parent=val, fontSize=9, leading=12)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=7.5,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=10)

    def _rows_table(rows):
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
            ("TOPPADDING", (0, 0), (-1, -1), 1.5),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        return t

    def _story():
        story = []

        # ─── Header: title + day + bilag number ───
        # Draft vs locked is the document's single most important fact: a
        # draft exports, marked KLADDE, under a banner saying the figures can
        # still change, with no assurance band and a kladde filename.
        head_table = Table(
            [[Paragraph(claims["title"], h1),
              Paragraph(f"{date_str}<br/>{L['bilag_no']} {bilagsnummer}", h_period)]],
            colWidths=[96 * mm, 70 * mm],
        )
        head_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(head_table)
        story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=3, spaceAfter=8))

        if claims["draft_banner"]:
            draft_band = Table(
                [[Paragraph(
                    f"<font name='Helvetica-Bold' color='{colors.HexColor('#92400e').hexval()}'"
                    f" size='9.5'>{claims['draft_mark']}</font>"
                    f"<br/><font color='{MUTED.hexval()}' size='8'>{claims['draft_banner']}</font>",
                    val,
                )]],
                colWidths=[166 * mm],
            )
            draft_band.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fef3c7")),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("ROUNDEDCORNERS", [4, 4, 4, 4]),
            ]))
            story.append(draft_band)
            story.append(Spacer(1, 4 * mm))

        # ─── Identity ───
        # Everything a person typed is escaped here, at the Paragraph boundary.
        id_lines = [
            f"<font name='Helvetica-Bold' size='10.5'>{escape_pdf_text(claims['business_name'])}</font>"
        ]
        sub = []
        if claims["address_line"]:
            sub.append(escape_pdf_text(claims["address_line"]))
        if profile and getattr(profile, "org_number", None):
            sub.append(f"CVR {escape_pdf_text(profile.org_number)}")
        if sub:
            id_lines.append(f"<font color='#6b7280'>{' · '.join(sub)}</font>")
        if branch:
            id_lines.append(f"<font color='#6b7280'>{L['branch']}: {escape_pdf_text(branch)}</font>")
        who = []
        if dc.closed_by:
            # A draft was counted, not closed.
            who_label = L["closed_by"] if claims["is_locked"] else L["counted_by"]
            who.append(f"{who_label}: {escape_pdf_text(dc.closed_by)}")
        if claims["locked_at_local"] is not None:
            loc = claims["locked_at_local"]
            who.append(f"{L['locked_at']} " + (loc.strftime("%d.%m.%Y kl. %H:%M") if DA
                                               else loc.strftime("%d %b %Y %H:%M")))
        elif not claims["is_locked"]:
            who.append(L["not_locked"])
        if who:
            id_lines.append(f"<font color='#6b7280'>{' · '.join(who)}</font>")
        if src:
            id_lines.append(f"<font color='#6b7280'>{L['source']}: {escape_pdf_text(src)}</font>")
        story.append(Paragraph("<br/>".join(id_lines), meta))
        story.append(Spacer(1, 3 * mm))

        # ─── Revenue ───
        # Either the page adds up, or the page says that it does not — in its
        # own voice. Derivation lives in kasserapport_claims.
        if not claims["revenue_lines"] and claims["unsplit_total"]:
            # A total-only Z-bon: the same "Ikke fordelt på kategori" line a
            # partial split shows, so the two read as the same kind of day.
            _tone = AMBER if claims["unsplit_tone"] == "amber" else MUTED
            story.append(Paragraph(L["revenue"], section_title))
            story.append(_rows_table([
                [Paragraph(f"<font color='{_tone.hexval()}'>{L['unallocated']}</font>", val),
                 Paragraph(f"<font color='{_tone.hexval()}'>{claims['unsplit_total']}</font>", val_r)],
                [Paragraph(L["total_revenue"], val_b), Paragraph(claims["total_revenue"], val_br)],
            ]))
            if claims["unsplit_note"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(
                    f"<font color='{_tone.hexval()}'>{claims['unsplit_note']}</font>", foot))
        if claims["revenue_lines"]:
            story.append(Paragraph(L["revenue"], section_title))
            rows = []
            for line in claims["revenue_lines"]:
                label = escape_pdf_text(line["label"])
                if line["is_correction"]:
                    label = (f"{label} <font color='{MUTED.hexval()}' size='8.5'>"
                             f"({line['correction_tag']})</font>")
                rows.append([Paragraph(label, val), Paragraph(line["amount"], val_r)])
            if claims["discrepancy"] is not None:
                # Amber for a CONTRADICTION; muted for an INCOMPLETE SPLIT (the
                # Z-bon scan flow working as designed).
                _tone = (AMBER if claims["discrepancy_tone"] == "amber" else MUTED)
                rows.append([Paragraph(L["lines_sum"], val),
                             Paragraph(claims["lines_sum"], val_r)])
                rows.append([
                    Paragraph(f"<font color='{_tone.hexval()}'>{claims['discrepancy_label']}</font>", val),
                    Paragraph(f"<font color='{_tone.hexval()}'>{claims['discrepancy']}</font>", val_r),
                ])
            rows.append([Paragraph(L["total_revenue"], val_b),
                         Paragraph(claims["total_revenue"], val_br)])
            story.append(_rows_table(rows))
            if claims["discrepancy_note"]:
                _tone = (AMBER if claims["discrepancy_tone"] == "amber" else MUTED)
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(
                    f"<font color='{_tone.hexval()}'>{claims['discrepancy_note']}</font>", foot))
            if claims["correction_note"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(claims["correction_note"], foot))

        # ─── MOMS — never a number it cannot stand behind ───
        if (dc.moms_total is not None or dc.revenue_ex_moms is not None
                or not claims["revenue_ties_out"]):
            story.append(Paragraph(L["moms_title"], section_title))
            story.append(_rows_table([
                [Paragraph(L["moms_incl"], val), Paragraph(claims["moms"]["incl"], val_r)],
                # The one label rule: "(25 %)" only over a figure that IS 25 %
                # of the base; a typed or scanned figure is named by its source.
                [Paragraph(escape_pdf_text(claims["moms_label"]), val),
                 Paragraph(claims["moms"]["vat"], val_r)],
                [Paragraph(L["moms_excl"], val_b), Paragraph(claims["moms"]["excl"], val_br)],
            ]))
            if claims["moms_unknown_reason"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(
                    f"<font color='{AMBER.hexval()}'>{claims['moms_unknown_reason']}</font>", foot))
            else:
                for _note in (claims["moms_basis_note"], claims["moms_manual_note"]):
                    if _note:
                        story.append(Spacer(1, 1 * mm))
                        story.append(Paragraph(_note, foot))

        # ─── Payment methods ───
        if claims["payment_lines"]:
            story.append(Paragraph(L["payments"], section_title))
            rows = []
            for line in claims["payment_lines"]:
                if line["is_brand"]:
                    # A card brand is a SPLIT of the card line, never money on top.
                    rows.append([
                        Paragraph(f"<font color='{MUTED.hexval()}' size='9'>"
                                  f"&nbsp;&nbsp;&nbsp;&nbsp;{escape_pdf_text(line['label'])}</font>", val),
                        Paragraph(f"<font color='{MUTED.hexval()}' size='9'>{line['amount']}</font>", val_r),
                    ])
                else:
                    rows.append([Paragraph(escape_pdf_text(line["label"]), val),
                                 Paragraph(line["amount"], val_r)])
            if claims["payment_discrepancy"] is not None:
                rows.append([Paragraph(L["pay_lines_sum"], val),
                             Paragraph(claims["payment_lines_sum"], val_r)])
                rows.append([
                    Paragraph(f"<font color='{AMBER.hexval()}'>{L['pay_discrepancy']}</font>", val),
                    Paragraph(f"<font color='{AMBER.hexval()}'>{claims['payment_discrepancy']}</font>", val_r),
                ])
            rows.append([Paragraph(L["total_pay"], val_b),
                         Paragraph(claims["total_payment"], val_br)])
            story.append(_rows_table(rows))
            if claims["payment_discrepancy_note"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(
                    f"<font color='{AMBER.hexval()}'>{claims['payment_discrepancy_note']}</font>", foot))
            if claims["brand_note"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(claims["brand_note"], foot))

        # ─── Cash drawer — as the app counts it ───
        if dc.cash_counted is not None:
            story.append(Paragraph(L["cash"], section_title))
            diff = float(dc.cash_difference) if dc.cash_difference is not None else None
            from app.services.kasserapport_claims import CASH_TOL
            diff_style = ParagraphStyle(
                "Diff", parent=val_br,
                textColor=DANGER if (diff is not None and abs(diff) > CASH_TOL) else INK)
            rows = [[Paragraph(L["cash_expected"], val), Paragraph(fmt(dc.cash_expected), val_r)]]
            cash_float = getattr(dc, "cash_float", None)
            if cash_float is not None:
                rows.append([Paragraph(L["cash_drawer"], val),
                             Paragraph(fmt(float(dc.cash_counted) + float(cash_float)), val_r)])
                rows.append([Paragraph(f"− {L['cash_float']}", val),
                             Paragraph(fmt(cash_float), val_r)])
            rows.append([Paragraph(L["cash_counted"], val), Paragraph(fmt(dc.cash_counted), val_r)])
            rows.append([Paragraph(L["cash_diff"], val_b), Paragraph(signed(diff), diff_style)])
            story.append(_rows_table(rows))
            if diff is not None and abs(diff) >= 0.005:
                # One full stop: the money token already ends in "kr." — this
                # printed "Kassen mangler 20,00 kr.." on every short day.
                from app.services.kasserapport_claims import as_sentence, cash_diff_words
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph(as_sentence(cash_diff_words(diff, currency)), foot))

        # ─── Tips ───
        if dc.tips_total:
            story.append(Paragraph(L["tips"], section_title))
            story.append(_rows_table([
                [Paragraph(L["tips_total"], val), Paragraph(fmt(dc.tips_total), val_r)],
                [Paragraph(L["tips_staff"], val), Paragraph(str(dc.tips_staff_count or "—"), val_r)],
                [Paragraph(L["tips_pp"], val_b), Paragraph(fmt(dc.tips_per_person), val_br)],
            ]))
            story.append(Spacer(1, 1 * mm))
            story.append(Paragraph(L["tips_note"], foot))

        # ─── Bilagsnummer audit trail ───
        if currency == "DKK" and (sale_vmin or exp_vmin):
            story.append(Paragraph(L["vouchers"], section_title))
            rows = []
            if sale_vmin and sale_vmax:
                label = (f"S-{dc.date.year}-{sale_vmin:04d} → S-{dc.date.year}-{sale_vmax:04d}"
                         if sale_vmin != sale_vmax else f"S-{dc.date.year}-{sale_vmin:04d}")
                rows.append([Paragraph(L["v_sales"], val), Paragraph(label, val_r)])
            if exp_vmin and exp_vmax:
                label = (f"E-{dc.date.year}-{exp_vmin:04d} → E-{dc.date.year}-{exp_vmax:04d}"
                         if exp_vmin != exp_vmax else f"E-{dc.date.year}-{exp_vmin:04d}")
                rows.append([Paragraph(L["v_exp"], val), Paragraph(label, val_r)])
            if rows:
                t = Table(rows, colWidths=[110 * mm, 56 * mm])
                t.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                ]))
                story.append(t)

        # ─── Notes ───
        if dc.notes:
            story.append(Paragraph(L["notes"], section_title))
            story.append(Paragraph(escape_pdf_text(dc.notes).replace("\n", "<br/>"), meta))

        # ─── History — unlock / relock, from the append-only audit trail ───
        if history_events:
            story.append(Paragraph(L["history"], section_title))
            story.append(Paragraph(
                escape_pdf_text(format_history(history_events, danish=DA, tz=tz)).replace(" · ", "<br/>"),
                meta,
            ))

        # ─── Accountant readiness badge ───
        # EVERY line is derived from the row (build_close_claims). A draft gets
        # no badge at all. Marks, not emoji: MARK_PASS for a check that passed,
        # MARK_FAIL for one that did not, a muted "·" for information that does
        # not gate the heading.
        assurance = claims["assurance"]
        if assurance:
            all_ok = assurance["all_ok"]
            story.append(Spacer(1, 3 * mm))
            badge_color = colors.HexColor("#065f46") if all_ok else colors.HexColor("#92400e")
            badge_bg = colors.HexColor("#d1fae5") if all_ok else colors.HexColor("#fef3c7")

            body = "<br/>".join(
                band_line_markup(c, ink=INK.hexval(), ok=OK_GREEN.hexval(), muted=MUTED.hexval())
                for c in assurance["checks"])
            badge_style = ParagraphStyle("Badge", parent=val, leading=10.5)
            badge_table = Table(
                [[Paragraph(
                    # MARK_REVIEW, not U+26A0 — that codepoint draws as a black
                    # box in Helvetica's WinAnsi encoding.
                    f"<font name='Helvetica-Bold' color='{badge_color.hexval()}' size='9.5'>"
                    f"{MARK_PASS if all_ok else MARK_REVIEW} "
                    f"{assurance['heading']}</font><br/>{body}",
                    badge_style,
                )]],
                colWidths=[166 * mm],
            )
            badge_table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), badge_bg),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("ROUNDEDCORNERS", [4, 4, 4, 4]),
            ]))
            # The band and the footer belong together: a band on page 1 with
            # its footer stranded alone on page 2 reads as a truncated document.
            story.append(KeepTogether([
                badge_table,
                Spacer(1, 3 * mm),
                HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                           spaceBefore=2, spaceAfter=3),
                # A label with no value is a claim with nothing behind it; a
                # draft says "Ikke låst", which is the true statement.
                Paragraph(claims["footer"], foot),
            ]))
        else:
            story.append(Spacer(1, 4 * mm))
            story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                                    spaceBefore=2, spaceAfter=3))
            story.append(Paragraph(claims["footer"], foot))
        return story

    # One clock: the venue's, like "Låst … kl. 01:28" on the same page.
    generated_at_str = generated_local(tz, danish=DA)
    running = (
        f"{claims['title']} · {claims['business_name']} · "
        f"{dc.date.strftime('%d.%m.%Y')} · {L['bilag_no']} {bilagsnummer}"
    )
    pdf = render_with_doc_hash(
        _story,
        pagesize=A4,
        left_mm=22, right_mm=22, top_mm=15, bottom_mm=18,
        # The PDF's own document properties are part of what it claims: a
        # kladde must not present itself as "Kasserapport" in a title bar.
        title=claims["title"],
        author="BonBox",
        subject=f"{claims['business_name']} {dc.date.isoformat()}",
        software_id=get_software_identifier(),
        generated_at_str=generated_at_str,
        # No login e-mail on a document that goes to a third party.
        generator_email="",
        is_danish=DA,
        doc_hash=doc_id,
        hash_label="Dokument-id" if DA else "Document ID",
        running_header=running,
    )
    return {
        "pdf": pdf,
        "filename": close_filename(claims["business_name"], dc.date, locked=claims["is_locked"],
                                   branch=branch),
        "doc_id": doc_id,
        "bilagsnummer": bilagsnummer,
    }
