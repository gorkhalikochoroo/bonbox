"""
Kontrolmappe PDF — the egenkontrol records for a period (R1a: at most 30 days).

Built on bonbox_pdf_kit (2-pass render with the Doc-hash + "Side x af y"
footer, export_bilagsnummer, escape_pdf_text). Rules it keeps:

  • DANISH ONLY, whatever language the cook used: actions and fates are stored
    as codes and printed through the Danish label tables in egenkontrol_rules.
  • Every printed time is the reading's LOCAL calendar date + time in the
    venue zone (egenkontrol_rules.to_local) — right on Postgres in winter and
    in summer, and a 00:20 reading prints its own calendar date.
  • EVERY typed string (check names, notes, staff names, other-texts, action
    notes, product notes, venue name and address) goes through
    escape_pdf_text: a Paragraph parses markup, and an <img> in a note would
    otherwise make the server fetch an address.
  • The venue name, address and CVR come from the ACCOUNT, never from a
    query parameter.
  • It says what it covers. It never claims more: no "klar til
    Fødevarestyrelsen", no "Sikker", no "Alt er dokumenteret".
"""

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S
from app.services.bonbox_pdf_kit import (
    compose_business_address,
    escape_pdf_text,
    export_bilagsnummer,
    render_with_doc_hash,
)
from app.utils.document_hash import compute_document_hash

TITLE = "Kontrolmappe — registreringer til egenkontrol"
FOOTER_NOTE = (
    "Udskrift af registreringer fra BonBox. Virksomheden er selv ansvarlig for sin "
    "risikoanalyse og sit egenkontrolprogram."
)
NAMES_LEGEND = (
    'Navne markeret "valgt på køkken-iPad" er valgt på en delt skærm. '
    "De er ikke et personligt login."
)
SCOPE_LINE = (
    "Udskriften indeholder registreringer og afvigelser. Risikoanalyse og "
    "egenkontrolprogram ligger hos virksomheden."
)
SIGN_LINE = "Gennemgået af: ______________________    Dato: ______________"


def _esc(v) -> str:
    return escape_pdf_text(v)


def _local(dt, tz):
    return R.to_local(dt, tz)


def _when(e, tz) -> tuple[str, str]:
    loc = _local(e.recorded_at, tz)
    return R.format_date_da(loc.date()), loc.strftime("%H:%M")


def _who(e) -> str:
    return f"{_esc(e.staff_name)} {_esc(R.name_note_da(e.name_source, e.via))}"


def _action_text(e) -> str:
    if not e.action_code:
        return "–"
    t = _esc(R.ACTION_LABEL_DA.get(e.action_code, e.action_code))
    if e.action_code == "other" and e.action_other:
        t += f": {_esc(e.action_other)}"
    if e.action_note:
        t += f"<br/><i>Note: {_esc(e.action_note)}</i>"
    return t


def _fate_text(e) -> str:
    if not e.fate_code:
        return "–"
    t = _esc(R.FATE_LABEL_DA.get(e.fate_code, e.fate_code))
    if e.fate_code == "other" and e.fate_other:
        t += f": {_esc(e.fate_other)}"
    return t


def _followup_fate(f, tz) -> Optional[str]:
    """'→ Kasseret (kl. 09:00)' when a follow-up gave the food its final fate."""
    if not f.fate_code:
        return None
    return f"→ {_fate_text(f)} (kl. {_local(f.recorded_at, tz).strftime('%H:%M')})"


def _followup_line(f, tz) -> str:
    """'4,0 °C kl. 09:00 · Mia (skrevet ind)' + the follow-up's own note."""
    t = (f"{R.format_temp_da(f.value_c)} kl. {_local(f.recorded_at, tz).strftime('%H:%M')}"
         f" · {_who(f)}")
    if f.action_note:
        t += f"<br/><i>Note: {_esc(f.action_note)}</i>"
    return t


def _limit_for_entry(e) -> str:
    if e.limit_c is None:
        return "–"
    lim = R.Limit(e.limit_c, e.limit_direction or "max", "owner")
    return R.limit_text_da(lim)


def _device_note(e, tz) -> Optional[str]:
    if e.client_typed_at is None:
        return None
    if abs(e.recorded_at - e.client_typed_at) <= R.CLIENT_TIME_DIFF:
        return None
    typed = _local(e.client_typed_at, tz).strftime("%H:%M")
    got = _local(e.recorded_at, tz).strftime("%H:%M")
    return f"Tastet kl. {typed} ifølge enheden · modtaget kl. {got}"


def _value_text(e) -> str:
    t = R.format_temp_da(e.value_c)
    if e.product_type:
        t = f"{R.PRODUCT_LABEL_DA.get(e.product_type, e.product_type)}: {t}"
    return t


def build_folder_pdf(db: Session, owner, date_from: date, date_to: date,
                     branch_id=None, generator_email: Optional[str] = None) -> tuple[bytes, str, str]:
    """→ (pdf bytes, bilagsnummer, doc_hash). Raises RuleError for a bad range.
    `generator_email` is the person who made the file (a manager seat), else
    the owner's e-mail."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle

    fd = S.folder_data(db, owner, date_from, date_to, branch_id)
    tz = fd.tz
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    venue = fd.venue_name
    address = compose_business_address(profile) if profile is not None else ""
    cvr = getattr(profile, "org_number", None) if profile is not None else None
    period = f"{R.format_date_da(date_from)} – {R.format_date_da(date_to)}"
    bilag = export_bilagsnummer("EK", date_from, date_to)
    generated = _local(fd.now, tz).strftime("%d-%m-%Y %H:%M")
    names = {str(c.id): c for c in fd.checks}

    filled_ids = {str(r.filled_by.id) for r in fd.slot_results if r.filled_by is not None}
    live = [e for e in fd.entries if e.voided_at is None]
    # EVERY voided reading prints, whatever its reason; and a deviation is any
    # out-of-limit reading — its cached state only says open or closed.
    undone = [e for e in fd.entries if e.voided_at is not None]
    deviations = [e for e in live if R.is_deviation(e)]
    s = fd.summary

    def story():
        styles = getSampleStyleSheet()
        h1 = ParagraphStyle("EkH1", parent=styles["Title"], fontSize=15, alignment=0,
                            spaceAfter=2, textColor="#111827")
        sub = ParagraphStyle("EkSub", parent=styles["Normal"], fontSize=9.5,
                             textColor="#374151", leading=13)
        h2 = ParagraphStyle("EkH2", parent=styles["Heading2"], fontSize=12,
                            spaceBefore=12, spaceAfter=4, textColor="#111827")
        h3 = ParagraphStyle("EkH3", parent=styles["Heading3"], fontSize=10,
                            spaceBefore=8, spaceAfter=2, textColor="#111827")
        cell = ParagraphStyle("EkCell", parent=styles["Normal"], fontSize=8, leading=10)
        head = ParagraphStyle("EkHead", parent=cell, fontName="Helvetica-Bold")
        muted = ParagraphStyle("EkMuted", parent=styles["Normal"], fontSize=8.5,
                               leading=11.5, textColor="#4b5563")

        def P(text, st=cell):
            return Paragraph(text, st)

        def table(header, rows, widths):
            data = [[P(h, head) for h in header]] + [[P(c) for c in r] for r in rows]
            t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
            t.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#9ca3af")),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            return t

        out = [Paragraph(_esc(TITLE), h1)]
        lines = [f"<b>{_esc(venue)}</b>"]
        if address:
            lines.append(_esc(address))
        if cvr:
            lines.append(f"CVR {_esc(cvr)}")
        lines.append(f"Periode: {_esc(period)}")
        if fd.branch_name:
            lines.append(f"Afdeling: {_esc(fd.branch_name)}")
        lines.append(f"Bilagsnummer: {_esc(bilag)}")
        out.append(Paragraph("<br/>".join(lines), sub))

        # 2 — Overblik (computed, never a claim)
        out.append(Paragraph("Overblik", h2))
        out.append(table(
            ["Målinger", "Til tiden", "For sent", "Ikke registreret",
             "Afvigelser", "Heraf ikke afsluttet", "Fortrudt"],
            [[str(s["readings"]), str(s["slots_on_time"]), str(s["slots_late"]),
              str(s["slots_missed"]), str(s["deviations"]), str(s["deviations_open"]),
              str(s["undone"])]],
            [22, 22, 22, 26, 22, 30, 22],
        ))

        # 3 — Afvigelser
        out.append(Paragraph("Afvigelser", h2))
        if not deviations:
            out.append(Paragraph("Ingen afvigelser i perioden.", muted))
        else:
            rows = []
            for e in deviations:
                d, t = _when(e, tz)
                fups = [f for f in fd.followups.get(str(e.id), []) if f.voided_at is None]
                fu = "<br/>".join(_followup_line(f, tz) for f in fups) if fups else "–"
                # What finally happened to the food, when a follow-up said it
                # ("Afventer ny måling → Kasseret (kl. 09:00)").
                food = "<br/>".join(
                    [_fate_text(e)] + [x for x in (_followup_fate(f, tz) for f in fups) if x]
                )
                state = "Afsluttet" if e.deviation_state == "closed" else "Ikke afsluttet"
                rows.append([
                    f"{d}<br/>kl. {t}", _esc(S.entry_check_name(fd, e)), _value_text(e),
                    _limit_for_entry(e), _action_text(e), food, _who(e), fu, state,
                ])
            out.append(table(
                ["Dato", "Kontrolpunkt", "Måling", "Grænse", "Hvad blev gjort",
                 "Maden", "Hvem", "Opfølgning", "Status"],
                rows, [16, 19, 15, 16, 23, 20, 20, 33, 16],
            ))

        # 4 — Registreringer pr. kontrolpunkt
        out.append(Paragraph("Registreringer pr. kontrolpunkt", h2))
        if not fd.checks:
            out.append(Paragraph("Ingen kontrolpunkter i perioden.", muted))
        for c in fd.checks:
            cid = str(c.id)
            rows = []  # (sort key, row)
            for r in fd.slot_results:
                if r.slot.check_id != cid:
                    continue
                due_local = R.hhmm_local(r.slot.due_at, tz)
                if r.filled_by is not None:
                    e = r.filled_by
                    d, t = _when(e, tz)
                    notes = []
                    if r.state == "late":
                        notes.append(R.late_text_da(t, due_local))
                    if R.is_deviation(e):
                        notes.append("Afvigelse (se Afvigelser)")
                    dn = _device_note(e, tz)
                    if dn:
                        notes.append(dn)
                    rows.append((e.recorded_at, [
                        d, f"kl. {due_local}", _value_text(e), f"kl. {t}", _who(e),
                        "<br/>".join(_esc(n) for n in notes) or "Til tiden",
                    ]))
                else:
                    label = "Ikke registreret" if r.state == "missed" else "Ikke registreret endnu"
                    rows.append((r.slot.due_at, [
                        R.format_date_da(r.slot.business_date), f"kl. {due_local}",
                        "–", "–", "–", label,
                    ]))
            for e in live:
                if str(e.check_id) != cid or str(e.id) in filled_ids:
                    continue
                d, t = _when(e, tz)
                notes = []
                if e.product_type:
                    notes.append("Dato, mærkning og emballage tjekket" if e.label_ok
                                 else "Mærkning ikke markeret som tjekket")
                if e.product_note:
                    notes.append(f"Vare: {e.product_note}")
                if R.is_deviation(e):
                    notes.append("Afvigelse (se Afvigelser)")
                dn = _device_note(e, tz)
                if dn:
                    notes.append(dn)
                rows.append((e.recorded_at, [
                    d, "–", _value_text(e), f"kl. {t}", _who(e),
                    "<br/>".join(_esc(n) for n in notes) or "–",
                ]))
            rows.sort(key=lambda x: x[0])
            cur = (fd.period_revs.get(cid) or [(None, None)])[-1][0]
            sched = R.schedule_text_da(cur.schedule, c.template_key) if cur else ""
            heading = _esc(c.name) + (f" · {_esc(c.note)}" if c.note else "")
            block = [Paragraph(heading, h3), Paragraph(_esc(sched), muted)]
            if rows:
                block.append(table(["Dato", "Frist", "Måling", "Registreret", "Hvem", "Bemærkning"],
                                   [r for _, r in rows], [22, 16, 26, 20, 38, 52]))
            else:
                block.append(Paragraph("Ingen registreringer i perioden.", muted))
            out.append(KeepTogether(block[:2]))
            out.extend(block[2:])

        # 5 — Fortrudte indtastninger
        out.append(Paragraph("Fortrudte indtastninger", h2))
        if not undone:
            out.append(Paragraph("Ingen fortrudte indtastninger i perioden.", muted))
        else:
            rows = []
            for e in undone:
                d, t = _when(e, tz)
                vt = _local(e.voided_at, tz).strftime("%H:%M") if e.voided_at else "–"
                when_voided = f"kl. {vt}"
                if e.void_reason != "undo":
                    when_voided += f"<br/>Årsag: {_esc(e.void_reason or '–')}"
                rows.append([d, f"kl. {t}", _esc(S.entry_check_name(fd, e)), _value_text(e),
                             _who(e), when_voided])
            out.append(table(["Dato", "Registreret", "Kontrolpunkt", "Måling", "Hvem", "Fortrudt"],
                             rows, [24, 20, 34, 26, 42, 20]))

        # 6 — Kontrolpunkter og grænser (every revision valid in the period)
        out.append(Paragraph("Kontrolpunkter og grænser", h2))
        for c in fd.checks:
            rows = []
            for rv, _until in fd.period_revs.get(str(c.id), []):
                vf = _local(rv.valid_from, tz)
                if rv.kind == "receiving":
                    parts = []
                    for pt in R.PRODUCT_TYPES:
                        lim = R.limit_for(rv, pt)
                        parts.append(
                            f"{R.PRODUCT_LABEL_DA[pt]}: {R.limit_text_da(lim)} "
                            f"({R.source_text_da(lim.source, lim.ref)})"
                        )
                    lim_text = "<br/>".join(_esc(p) for p in parts)
                    src_text = ""
                else:
                    lim = R.limit_for(rv) if rv.limit_c is not None else None
                    lim_text = _esc(R.limit_text_da(lim))
                    src_text = _esc(R.source_text_da(lim.source, lim.ref)) if lim else ""
                rows.append([
                    f"{R.format_date_da(vf.date())} kl. {vf.strftime('%H:%M')}",
                    _esc(rv.name), _esc(R.schedule_text_da(rv.schedule, rv.template_key)),
                    lim_text, src_text, "Slået til" if rv.active else "Slået fra",
                ])
            if rows:
                out.append(table(["Gyldig fra", "Navn", "Hvornår", "Grænse", "Kilde", "Status"],
                                 rows, [26, 24, 34, 36, 40, 16]))
                out.append(Spacer(1, 2 * mm))

        # 7 — review line, 8 — legend + scope
        out.append(Spacer(1, 8 * mm))
        out.append(Paragraph(_esc(SIGN_LINE), sub))
        out.append(Spacer(1, 6 * mm))
        out.append(Paragraph(_esc(NAMES_LEGEND), muted))
        out.append(Paragraph(_esc(SCOPE_LINE), muted))
        return out

    pdf = render_with_doc_hash(
        story,
        pagesize=A4,
        margins_mm=16,
        title=f"Kontrolmappe — {venue}",
        subject=f"Egenkontrol: registreringer {period}",
        software_id="bonbox-egenkontrol",
        generated_at_str=generated,
        generator_email=generator_email or getattr(owner, "email", "") or "",
        is_danish=True,
        running_header=f"{venue} · Kontrolmappe · {period}",
        running_header_page_no=False,
        footer_note=FOOTER_NOTE,
    )
    return pdf, bilag, compute_document_hash(pdf)
