"""The single-close kasserapport PDF — ONE builder for every copy of it.

It used to live inline in the GET /daily-close/{id}/pdf route, so nothing else
could call it: the lock mail attached a different document (the one-day range
export) with the opposite readiness verdict. History's download, the lock mail
and the explicit resend now all render through here.
"""
from __future__ import annotations

from io import BytesIO

from sqlalchemy import func

from app.models.business_profile import BusinessProfile
from app.services.bonbox_pdf_kit import escape_pdf_text


def close_filename(business_name: str, d, *, locked: bool = True) -> str:
    """'Kasserapport Mirabelle ApS 2026-09-25.pdf' — business + date, safe
    characters. A draft says so in its name: a kladde mailed on and opened a
    week later is identified by its filename alone."""
    from app.services.revisor_mail import safe_name_part
    lead = "Kasserapport" if locked else "Kasserapport KLADDE"
    return f"{lead} {safe_name_part(business_name)} {d.isoformat()}.pdf"


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
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable,
        KeepTogether,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    from app.services.bonbox_pdf_kit import money_dk
    from app.services.kasserapport_claims import (
        MARK_FAIL,
        MARK_PASS,
        MARK_REVIEW,
        build_close_claims,
    )

    # Copenhagen-clean palette
    AMBER = colors.HexColor("#b45309")     # "look at this" — never decorative
    OK_GREEN = colors.HexColor("#065f46")  # a check that actually passed
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    DANGER = colors.HexColor("#b91c1c")

    currency = user.currency or "DKK"

    # ─── Voucher range for the day (Bogføringsloven 2024 audit trail) ───
    # If sales/expenses for this date have voucher_numbers, show min-max range
    # so accountant can cross-check the closes against the bilag list.
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

    # ── The document's claims ──
    # Every assertion this PDF makes — whether it is final, what its lines add
    # up to, whether its MOMS can be stated, which checks actually passed, what
    # its footer and filename may say — is derived ONCE, in
    # services/kasserapport_claims.py, and rendered here without addition.
    # ReportLab compresses its streams, so a test cannot grep the produced PDF;
    # deriving the claims in a pure function is what makes them pinnable, and
    # the claims on this page are the part that must never drift.
    #
    # `has_bilag` is passed in because only the router can reach Sale/Expense.
    profile_name = getattr(profile, "company_name", None) if profile else None
    claims = build_close_claims(
        dc,
        currency=currency,
        profile=profile,
        business_name=(profile_name or getattr(user, "business_name", None) or "—"),
        has_bilag=bool(sale_vmin or exp_vmin),
    )
    L = claims["labels"]
    DA = claims["danish"]

    def fmt(v):
        # The ONE Danish money formatter every BonBox export uses — DKK renders
        # "1.234,56 kr." (period thousands, comma decimal, "kr." unit), which is
        # what every screen in the app shows and what a kasserapport must tie
        # out to. This endpoint used to hand-roll "1.234,56 DKK", so the one
        # document a revisor reads disagreed with the page that produced it.
        # None / non-numeric → "—", never a fabricated 0.
        return money_dk(v, currency)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        # The PDF's own document properties are part of what it claims: a
        # kladde opened in a viewer must not present itself as "Kasserapport"
        # in the title bar while the page says KLADDE.
        title=claims["title"],
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=2,
                        textColor=INK, fontName="Helvetica-Bold")
    h_period = ParagraphStyle("Period", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, alignment=TA_RIGHT)
    section_title = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8.5,
                                   textColor=MUTED, fontName="Helvetica-Bold",
                                   leading=12, spaceBefore=8, spaceAfter=3)
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=10.5,
                         textColor=INK, fontName="Helvetica", leading=14)
    val_r = ParagraphStyle("ValR", parent=val, alignment=TA_RIGHT)
    val_b = ParagraphStyle("ValB", parent=val, fontName="Helvetica-Bold")
    val_br = ParagraphStyle("ValBR", parent=val_b, alignment=TA_RIGHT)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    story = []

    # ─── Header: title + date ───
    # Draft vs locked is the document's single most important fact. An owner
    # genuinely wants to read a kasserapport BEFORE locking it — that is how you
    # check the day against the Z-report — so refusing to export a draft would
    # remove a real use. What must never happen is a draft that READS as final.
    # So a draft exports, marked KLADDE in the title, under a banner saying the
    # figures can still change, with no assurance band and a kladde filename.
    # Danish-style date format: "16. maj 2026" for DKK, "16 May 2026" else
    if DA:
        _DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni",
                      "juli", "august", "september", "oktober", "november", "december"]
        date_str = f"{dc.date.day}. {_DA_MONTHS[dc.date.month - 1]} {dc.date.year}"
    else:
        date_str = dc.date.strftime("%d %B %Y")
    head_table = Table(
        [[Paragraph(claims["title"], h1), Paragraph(date_str, h_period)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=4, spaceAfter=12))

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
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("ROUNDEDCORNERS", [4, 4, 4, 4]),
        ]))
        story.append(draft_band)
        story.append(Spacer(1, 6 * mm))

    # ─── Business info ───
    # BusinessProfile uses `company_name` (CVR-style legal entity name);
    # User uses `business_name` (signup-time DBA). Profile wins if both set
    # because that's the legal name an accountant needs on the kasserapport.
    # Everything a person typed is escaped here, at the Paragraph boundary —
    # a Paragraph parses markup, so "Mad & drikke" broke the page and an
    # `<img src=…>` in a name made the server read a file or a URL.
    # (Security review, Sep 2026.)
    biz_lines = [
        f"<font name='Helvetica-Bold' size='10.5'>{escape_pdf_text(claims['business_name'])}</font>"
    ]
    # The stored `address` in DK almost always already ends with the postal town
    # ("Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby") while zipcode + city are
    # ALSO filled in, so the naive join printed "…, 2500 Valby, 2500 Valby".
    # One shared composer now (bonbox_pdf_kit.compose_business_address).
    if claims["address_line"]:
        biz_lines.append(f"<font color='#6b7280'>{escape_pdf_text(claims['address_line'])}</font>")
    if profile and getattr(profile, "org_number", None):
        biz_lines.append(f"<font color='#6b7280'>CVR {escape_pdf_text(profile.org_number)}</font>")
    if dc.closed_by:
        # Danish document, Danish label — this said "Closed by:" on a page
        # otherwise written entirely in Danish.
        biz_lines.append(f"<font color='#6b7280'>{L['closed_by']}: {escape_pdf_text(dc.closed_by)}</font>")
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * mm))

    # ─── Revenue Breakdown ───
    # Arithmetic integrity. The page used to print the stored line items above
    # the stored total with NOTHING checking that they agree, so a row holding
    # 'food:-57' with revenue_total 0.00 produced a −57,00 line sitting silently
    # under a 0,00 total. Either the page adds up, or the page says that it does
    # not — in its own voice, on the page itself. Derivation lives in
    # kasserapport_claims.build_close_claims; this only draws it.
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
            # The lines and the total disagree. Show BOTH, plus the difference
            # as its own explicit line, so the column visibly adds up and the
            # reader is told what the difference is.
            #
            # Amber for a CONTRADICTION (a negative line the total ignored,
            # lines summing past the total). Muted for an INCOMPLETE SPLIT —
            # positive lines that do not yet itemise the whole of a known
            # total, which is the Z-report scan flow working as designed and
            # must not be dressed up as an error. The claim carries its own
            # tone; this only draws it.
            _tone = (AMBER if claims["discrepancy_tone"] == "amber" else MUTED)
            rows.append([Paragraph(L["lines_sum"], val),
                         Paragraph(claims["lines_sum"], val_r)])
            rows.append([
                Paragraph(
                    f"<font color='{_tone.hexval()}'>{claims['discrepancy_label']}</font>",
                    val),
                Paragraph(f"<font color='{_tone.hexval()}'>{claims['discrepancy']}</font>",
                          val_r),
            ])
        rows.append([Paragraph(L["total_revenue"], val_b),
                     Paragraph(claims["total_revenue"], val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        if claims["discrepancy_note"]:
            story.append(Spacer(1, 2 * mm))
            _tone = (AMBER if claims["discrepancy_tone"] == "amber" else MUTED)
            story.append(Paragraph(
                f"<font color='{_tone.hexval()}'>{claims['discrepancy_note']}</font>",
                foot,
            ))
        if claims["correction_note"]:
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(claims["correction_note"], foot))

    # ─── MOMS / SALG ───
    # This block is a MOMS statement to an accountant; it underpins a filing, so
    # it must never assert a number it cannot stand behind. It used to render
    # `float(dc.moms_total or 0)` — a NULL or contradictory VAT figure printed as
    # a confident "0,00" on a page whose own revenue lines said otherwise.
    # Doctrine: a value that is not known renders "—".
    if (dc.moms_total is not None or dc.revenue_ex_moms is not None
            or not claims["revenue_ties_out"]):
        story.append(Paragraph(L["moms_title"], section_title))
        moms_rows = [
            [Paragraph(L["moms_incl"], val), Paragraph(claims["moms"]["incl"], val_r)],
            [Paragraph(L["moms_vat"], val), Paragraph(claims["moms"]["vat"], val_r)],
            [Paragraph(L["moms_excl"], val_b), Paragraph(claims["moms"]["excl"], val_br)],
        ]
        t = Table(moms_rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        if claims["moms_unknown_reason"]:
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(
                f"<font color='{AMBER.hexval()}'>{claims['moms_unknown_reason']}</font>",
                foot,
            ))
        else:
            # Names the basis when the lines above don't itemise all of it, so
            # a stated MOMS is never read as reconciled against a breakdown
            # that is admittedly incomplete.
            for _note in (claims["moms_basis_note"], claims["moms_manual_note"]):
                if _note:
                    story.append(Spacer(1, 2 * mm))
                    story.append(Paragraph(_note, foot))

    # ─── Payment Methods ───
    if claims["payment_lines"]:
        story.append(Paragraph(L["payments"], section_title))
        # Same rule as the revenue lines: built-in methods get the app's own
        # word ("cash" → "Kontant", "bank_transfer" → "Bankoverførsel",
        # "MobilePay" kept as the brand), anything the owner typed passes
        # through verbatim.
        rows = []
        for line in claims["payment_lines"]:
            if line["is_brand"]:
                # A card brand is a SPLIT of the card line, not another method
                # — payment_total deliberately excludes it. Drawn indented and
                # muted so it can never be read as money on top. Printing these
                # as peers is how a close carrying dankort/visa splits showed
                # lines summing to far more than its own stated total.
                rows.append([
                    Paragraph(f"<font color='{MUTED.hexval()}' size='9'>"
                              f"&nbsp;&nbsp;&nbsp;&nbsp;{escape_pdf_text(line['label'])}</font>", val),
                    Paragraph(f"<font color='{MUTED.hexval()}' size='9'>"
                              f"{line['amount']}</font>", val_r),
                ])
            else:
                rows.append([Paragraph(escape_pdf_text(line["label"]), val),
                             Paragraph(line["amount"], val_r)])
        if claims["payment_discrepancy"] is not None:
            # Same rule as the revenue block: lines and total may not disagree
            # in silence.
            rows.append([Paragraph(L["pay_lines_sum"], val),
                         Paragraph(claims["payment_lines_sum"], val_r)])
            rows.append([
                Paragraph(f"<font color='{AMBER.hexval()}'>{L['pay_discrepancy']}</font>",
                          val),
                Paragraph(f"<font color='{AMBER.hexval()}'>"
                          f"{claims['payment_discrepancy']}</font>", val_r),
            ])
        rows.append([Paragraph(L["total_pay"], val_b),
                     Paragraph(claims["total_payment"], val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        if claims["payment_discrepancy_note"]:
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(
                f"<font color='{AMBER.hexval()}'>"
                f"{claims['payment_discrepancy_note']}</font>", foot,
            ))
        if claims["brand_note"]:
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(claims["brand_note"], foot))

    # ─── Cash Drawer ───
    if dc.cash_counted is not None:
        story.append(Paragraph(L["cash"], section_title))
        diff = float(dc.cash_difference or 0)
        diff_style = ParagraphStyle("Diff", parent=val_br,
                                    textColor=DANGER if abs(diff) > 100 else INK)
        rows = [
            [Paragraph(L["cash_expected"], val), Paragraph(fmt(dc.cash_expected), val_r)],
            [Paragraph(L["cash_counted"], val), Paragraph(fmt(dc.cash_counted), val_r)],
            [Paragraph(L["cash_diff"], val_b), Paragraph(fmt(dc.cash_difference), diff_style)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── Tips ───
    if dc.tips_total:
        story.append(Paragraph(L["tips"], section_title))
        rows = [
            [Paragraph(L["tips_total"], val), Paragraph(fmt(dc.tips_total), val_r)],
            [Paragraph(L["tips_staff"], val),
             Paragraph(str(dc.tips_staff_count or "—"), val_r)],
            [Paragraph(L["tips_pp"], val_b), Paragraph(fmt(dc.tips_per_person), val_br)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(L["tips_note"], foot))

    # ─── Bilagsnummer audit trail (DK Bogføringsloven 2024) ───
    if currency == "DKK" and (sale_vmin or exp_vmin):
        story.append(Paragraph(L["vouchers"], section_title))
        rows = []
        if sale_vmin and sale_vmax:
            label = (f"S-{dc.date.year}-{sale_vmin:04d} → S-{dc.date.year}-{sale_vmax:04d}"
                     if sale_vmin != sale_vmax
                     else f"S-{dc.date.year}-{sale_vmin:04d}")
            rows.append([Paragraph(L["v_sales"], val), Paragraph(label, val_r)])
        if exp_vmin and exp_vmax:
            label = (f"E-{dc.date.year}-{exp_vmin:04d} → E-{dc.date.year}-{exp_vmax:04d}"
                     if exp_vmin != exp_vmax
                     else f"E-{dc.date.year}-{exp_vmin:04d}")
            rows.append([Paragraph(L["v_exp"], val), Paragraph(label, val_r)])
        if rows:
            t = Table(rows, colWidths=[110 * mm, 56 * mm])
            t.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(t)

    # ─── Notes ───
    if dc.notes:
        story.append(Paragraph(L["notes"], section_title))
        # Escaped, and the owner's own line breaks kept.
        story.append(Paragraph(escape_pdf_text(dc.notes).replace("\n", "<br/>"), val))

    # ─── Accountant readiness badge ───
    # EVERY line in this badge is derived from the row (see build_close_claims).
    # It used to be a static sentence — "Salgsmoms beregnet, kontant afstemt,
    # bilagsnumre i orden" — printed under a GENNEMGÅS ("to be reviewed")
    # heading on a draft with NULL payments and a 0,00 MOMS that contradicted
    # its own page. A heading saying "review this" over a body listing three
    # passes is a document arguing with itself; and none of the three had been
    # checked. A DRAFT gets no badge at all — an unlocked close has nothing to
    # assure, and the KLADDE band at the top of the page is its whole status.
    assurance = claims["assurance"]
    if assurance:
        all_ok = assurance["all_ok"]
        # 5mm, not 10. The band went from a heading plus one sentence to a
        # heading plus four derived lines, and the old 10mm gap pushed the
        # footer onto a second page carrying nothing else — a two-page
        # kasserapport whose page 2 is one line of small print.
        story.append(Spacer(1, 5 * mm))
        badge_color = colors.HexColor("#065f46") if all_ok else colors.HexColor("#92400e")
        badge_bg = colors.HexColor("#d1fae5") if all_ok else colors.HexColor("#fef3c7")
        # Marks, not emoji: "✓" for a check that passed, "×" for one that did
        # not. A failed check is never silently omitted — the whole value of
        # this band to a revisor is seeing what was NOT done.
        body = "<br/>".join(
            f"<font color='{(OK_GREEN if c['ok'] else AMBER).hexval()}' size='8'>"
            f"{MARK_PASS if c['ok'] else MARK_FAIL} {c['text']}</font>"
            for c in assurance["checks"]
        )
        # Tighter leading for the check list — four 8pt lines do not need the
        # 14pt leading the 10.5pt body rows use.
        badge_style = ParagraphStyle("Badge", parent=val, leading=11.5)
        badge_table = Table(
            [[Paragraph(
                f"<font name='Helvetica-Bold' color='{badge_color.hexval()}' size='9.5'>"
                # MARK_REVIEW, not U+26A0. That codepoint is outside the
                # WinAnsi encoding Helvetica is drawn in, so ReportLab put a
                # black tofu box there — which is precisely the "▪ GENNEMGÅS"
                # the founder's exported PDF showed. The marks are named in
                # kasserapport_claims and pinned by mark_is_renderable.
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
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("ROUNDEDCORNERS", [4, 4, 4, 4]),
        ]))
        # The band and the footer belong together: a band on page 1 with its
        # footer stranded alone on page 2 reads as a truncated document.
        story.append(KeepTogether([
            badge_table,
            Spacer(1, 4 * mm),
            HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                       spaceBefore=2, spaceAfter=4),
            # ─── Footer ───
            # A label with no value is a claim with nothing behind it. This used
            # to print "Lukket —" unconditionally, so a close that was NEVER
            # locked told the revisor it was final and then dangled an em-dash
            # where the timestamp should be. No timestamp → no "Lukket" segment
            # at all; a draft says "Ikke låst", which is the true statement.
            Paragraph(claims["footer"], foot),
        ]))
    else:
        story.append(Spacer(1, 6 * mm))
        story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER,
                                spaceBefore=2, spaceAfter=4))
        story.append(Paragraph(claims["footer"], foot))

    doc.build(story)
    buf.seek(0)
    # The filename must not imply finality either — a kladde downloaded, mailed
    # on and opened a week later is identified by its name alone.
    pdf = buf.getvalue()
    from app.utils.document_hash import short_hash
    return {
        "pdf": pdf,
        "filename": close_filename(claims["business_name"], dc.date, locked=claims["is_locked"]),
        "doc_id": short_hash(pdf, length=16),
        "bilagsnummer": "",
    }
