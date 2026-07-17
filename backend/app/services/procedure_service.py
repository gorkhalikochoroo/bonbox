"""
Procedurebeskrivelse (Bogføringsloven § 6) — observed-facts prefill + PDF.

Every bookkeeping-obligated business with årsrapport duty OR net turnover
above 300.000 kr. in each of the last two income years must keep a WRITTEN
description of its bookkeeping procedures, stored with the regnskabsmateriale
(never submitted unless asked). Erhvervsstyrelsen's official skabelon
(virksomhedsguiden.dk → Bogføringsprocedure) has exactly three sections, and
this module mirrors them 1:1:

  1. Generelle oplysninger        — CVR, ansvarlige, ekstern bogholder,
                                    bogføringssystem, kontoplan
  2. Registrering og afstemning   — transaktionstyper, registrerings-
                                    procedure, afstemning
  3. Opbevaring og fremfinding    — opbevaring, betryggende opbevaring,
                                    fremfinding

The BonBox twist ([[user utility over polish]]): the owner shouldn't start
from a blank Word template. BonBox already OBSERVES most answers — who has
access, how often the day is closed, that faktura numbering is gap-less §7,
where material is stored and for how long. collect_prefill() turns that into
suggested Danish text per skabelon point, each tagged `observed` (computed
from real rows / true system properties) or `declare` (only the owner can
know). The wizard shows the suggestion; the OWNER confirms or edits every
line before anything becomes the document — we never assert on their behalf.

Honesty rails:
  • observed lines state only what the data shows ("seneste 90 dage" stats,
    system properties that are true in code) — never aspirations.
  • the document carries the standard provenance footer (doc-hash, generated
    timestamp) via bonbox_pdf_kit.render_with_doc_hash + an L7 audit row.
  • the PDF is Danish-only (jurisdiction-language lock) and explicitly says
    it is the VIRKSOMHEDEN's description, not legal advice.

Retention-claim note: the "opbevaring også efter kontolukning" line is backed
by real code — GDPR erasure keeps accounting source blobs for the §10 window
via erasure_tombstones (see accounting_retention._purge_erased_account_blobs)
— which is exactly why the sentence is safe to print.
"""

from __future__ import annotations

import json
import logging
import statistics
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.models.accountant_grant import AccountantGrant
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.models.user import User
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# The skabelon's points, in official order. Keys are stable API/storage ids;
# labels are the (Danish) headings the wizard + PDF print. Adding a point =
# append here; the wizard, validation and PDF all iterate this single list.
PROCEDURE_POINTS: list[dict[str, str]] = [
    # ── 1 · Generelle oplysninger ──────────────────────────────────────
    {"key": "cvr", "section": "1", "label": "Virksomhedens CVR-nummer"},
    {"key": "ansvarlige", "section": "1", "label": "Ansvarlige personer"},
    {"key": "ekstern", "section": "1", "label": "Ekstern varetagelse af bogføringsopgaver"},
    {"key": "system", "section": "1", "label": "Bogføringssystem"},
    {"key": "kontoplan", "section": "1", "label": "Kontoplan"},
    # ── 2 · Registrering og afstemning af transaktioner ────────────────
    {"key": "transaktionstyper", "section": "2", "label": "Væsentlige typer af transaktioner"},
    {"key": "registrering", "section": "2", "label": "Procedure for registrering af transaktioner"},
    {"key": "afstemning", "section": "2", "label": "Afstemning af bogføringen"},
    # ── 3 · Procedure for opbevaring og fremfinding ────────────────────
    {"key": "opbevaring", "section": "3", "label": "Opbevaring af regnskabsmateriale"},
    {"key": "betryggende", "section": "3", "label": "Betryggende opbevaring"},
    {"key": "fremfinding", "section": "3", "label": "Fremfinding af regnskabsmateriale"},
]

SECTION_TITLES = {
    "1": "1 · Generelle oplysninger",
    "2": "2 · Registrering og afstemning af transaktioner",
    "3": "3 · Procedure for opbevaring og fremfinding",
}

VALID_KEYS = {p["key"] for p in PROCEDURE_POINTS}
MAX_ANSWER_LEN = 4000  # bounds (L2): a procedure point is prose, not a novel

_LOOKBACK_DAYS = 90


def _median_close_time_str(closes: list[DailyClose]) -> str | None:
    """Median local wall-clock hour:minute of daily closes, Copenhagen time.

    closed_at is stored UTC-naive; render in Europe/Copenhagen so the
    sentence matches the owner's lived reality (TZ convention)."""
    try:
        from zoneinfo import ZoneInfo
        from datetime import timezone

        cph = ZoneInfo("Europe/Copenhagen")
        minutes = []
        for c in closes:
            if not c.closed_at:
                continue
            local = c.closed_at.replace(tzinfo=timezone.utc).astimezone(cph)
            minutes.append(local.hour * 60 + local.minute)
        if not minutes:
            return None
        med = int(statistics.median(minutes))
        return f"{med // 60:02d}:{med % 60:02d}"
    except Exception:  # noqa: BLE001 — a stats nicety must never break prefill
        return None


def collect_prefill(db: Session, user: User) -> dict[str, Any]:
    """Observed facts → suggested Danish text per skabelon point.

    Returns {key: {"suggested": str, "basis": "observed"|"declare"}}.
    "observed" = computed from the tenant's real rows or from system
    properties that are true in code. "declare" = only the owner knows;
    the suggestion is a scaffold sentence they must complete.
    """
    profile = (
        db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    )
    since = utc_now() - timedelta(days=_LOOKBACK_DAYS)
    since_date = since.date()

    # ── observed signals ────────────────────────────────────────────────
    closes = (
        db.query(DailyClose)
        .filter(DailyClose.user_id == user.id, DailyClose.date >= since_date)
        .all()
    )
    n_closes = len(closes)
    med_time = _median_close_time_str(closes)

    n_invoices = (
        db.query(Invoice)
        .filter(Invoice.user_id == user.id, Invoice.issue_date >= since_date)
        .count()
    )
    n_scans = (
        db.query(Expense)
        .filter(
            Expense.user_id == user.id,
            Expense.receipt_photo.isnot(None),
            Expense.date >= since_date,
        )
        .count()
    )
    uses_bank_match = (
        db.query(PaymentMatchSuggestion)
        .filter(PaymentMatchSuggestion.user_id == user.id)
        .limit(1)
        .count()
        > 0
    )

    members = (
        db.query(User)
        .filter(User.owner_id == user.id)
        .all()
    )
    grants = (
        db.query(AccountantGrant)
        .filter(
            AccountantGrant.owner_user_id == user.id,
            AccountantGrant.status == "active",
        )
        .all()
    )

    cvr = getattr(profile, "org_number", None)
    cvr_verified = bool(getattr(profile, "cvr_verified_at", None))

    out: dict[str, Any] = {}

    def put(key: str, suggested: str, basis: str) -> None:
        out[key] = {"suggested": suggested.strip(), "basis": basis}

    # 1 · Generelle oplysninger -----------------------------------------
    if cvr:
        put("cvr", f"CVR-nr. {cvr}" + (" (verificeret via CVR-registret)" if cvr_verified else ""), "observed")
    else:
        put("cvr", "CVR-nr.: [udfyld]", "declare")

    owner_line = f"{user.business_name or 'Ejeren'} (ejer, {user.email}) er ansvarlig for bogføringen."
    if members:
        roles_da = {"manager": "manager", "cashier": "kasse", "viewer": "læseadgang"}
        member_lines = ", ".join(
            f"{(m.business_name or m.email)} ({roles_da.get(m.role, m.role)})" for m in members
        )
        owner_line += f" Øvrige brugere med adgang: {member_lines}."
    put("ansvarlige", owner_line, "observed")

    if grants:
        g = grants[0]
        put(
            "ekstern",
            f"Virksomhedens revisor ({g.accountant_name or g.accountant_email}) har "
            "læseadgang til regnskabsmaterialet i BonBox via revisor-adgang. "
            "[Angiv evt. CVR-nr. på revisor/bogholder og hvilke opgaver de varetager.]",
            "observed",
        )
    else:
        put(
            "ekstern",
            "Bogføringsopgaver varetages internt. [Ret hvis en ekstern bogholder "
            "eller revisor varetager opgaver — angiv navn, CVR-nr. og opgaver.]",
            "declare",
        )

    usage_bits = []
    if n_closes:
        usage_bits.append("daglig kasserapport (dagsafslutning)")
    if n_invoices:
        usage_bits.append("fakturering med fortløbende nummerering")
    if n_scans:
        usage_bits.append("digitale udgiftsbilag (foto/OCR)")
    usage = ", ".join(usage_bits) if usage_bits else "registrering af salg og udgifter"
    put(
        "system",
        f"Virksomheden anvender BonBox (bonbox.dk) til {usage}. BonBox er ikke et "
        "registreret digitalt standardbogføringssystem. [Angiv her, hvilket "
        "bogføringssystem virksomheden/revisor anvender til den løbende bogføring, "
        "fx e-conomic eller Dinero.]",
        "observed",
    )

    put(
        "kontoplan",
        "Indtægter og udgifter kategoriseres i BonBox' faste kategorier "
        "(salg pr. betalingstype, udgiftskategorier med momskoder). "
        "[Angiv evt. kontoplanen i jeres bogføringssystem.]",
        "observed",
    )

    # 2 · Registrering og afstemning ------------------------------------
    tx_bits = []
    if n_closes:
        tx_bits.append("kontant- og kortsalg (dagens omsætning)")
    if n_invoices:
        tx_bits.append("fakturasalg")
    if n_scans:
        tx_bits.append("driftsudgifter med bilag")
    put(
        "transaktionstyper",
        ("Virksomhedens væsentligste transaktionstyper: " + "; ".join(tx_bits) + ".")
        if tx_bits
        else "Virksomhedens væsentligste transaktionstyper: [udfyld — fx kontantsalg, kortsalg, fakturasalg, driftsudgifter].",
        "observed" if tx_bits else "declare",
    )

    reg_lines = []
    if n_closes:
        cadence = f"Dagens salg registreres ved daglig afslutning i BonBox"
        if med_time:
            cadence += f" (typisk omkring kl. {med_time}, aflæst af de seneste {_LOOKBACK_DAYS} dages afslutninger)"
        cadence += "; Z-rapport/kassebon fotograferes og vedhæftes som bilag."
        reg_lines.append(cadence)
    if n_scans:
        reg_lines.append(
            "Udgiftsbilag fotograferes ved modtagelse og aflæses digitalt (OCR); "
            "bilaget gemmes sammen med registreringen."
        )
    if n_invoices:
        reg_lines.append(
            "Fakturaer udstedes fra BonBox med fortløbende, ubrudt fakturanummerering; "
            "annullering sker ved kreditnota (aldrig sletning)."
        )
    if not reg_lines:
        reg_lines.append(
            "[Beskriv hvordan og hvor ofte transaktioner registreres, og hvordan "
            "bilag knyttes til registreringerne.]"
        )
    put("registrering", " ".join(reg_lines), "observed" if (n_closes or n_scans or n_invoices) else "declare")

    afst_lines = []
    if n_closes:
        afst_lines.append(
            "Ved dagsafslutning afstemmes den optalte kassebeholdning mod dagens "
            "registrerede salg; afvigelser noteres."
        )
    if uses_bank_match:
        afst_lines.append(
            "Bankbetalinger afstemmes mod fakturaer ved import af netbank-udtog (CSV) "
            "med efterfølgende godkendelse af hvert match."
        )
    afst_lines.append("[Angiv evt. øvrige afstemninger, fx månedlig bankafstemning hos revisor.]")
    put("afstemning", " ".join(afst_lines), "observed" if (n_closes or uses_bank_match) else "declare")

    # 3 · Opbevaring og fremfinding -------------------------------------
    put(
        "opbevaring",
        "Regnskabsmateriale registreret i BonBox (kasserapporter, fakturaer, "
        "udgiftsbilag og tilhørende registreringer) opbevares digitalt på servere "
        "i EU og bevares i indeværende regnskabsår samt de efterfølgende 5 år, "
        "jf. bogføringslovens § 12. Opbevaringen af regnskabsbilag fortsætter i "
        "hele perioden, også hvis kontoen lukkes.",
        "observed",
    )
    put(
        "betryggende",
        "Adgang kræver personligt login; roller styrer, hvem der kan se og ændre "
        "hvad. Låste kasserapporter og genererede rapporter forsegles med en "
        "kryptografisk kontrolsum (doc-hash), og væsentlige ændringer logges i en "
        "revisionslog. [Angiv evt. egne supplerende backup-rutiner.]",
        "observed",
    )
    put(
        "fremfinding",
        "Materialet kan fremfindes pr. dato, periode, bilagsnummer og kategori "
        "direkte i BonBox og kan til enhver tid eksporteres som CSV/PDF til "
        "revisor eller myndigheder.",
        "observed",
    )

    return out


def validate_answers(payload: Any) -> dict[str, str]:
    """Bounds + shape gate (L2): known keys only, strings only, capped length.

    Unknown keys are rejected (not silently dropped) so a typo'd wizard field
    fails loudly in dev instead of silently losing an owner's text."""
    if not isinstance(payload, dict):
        raise ValueError("answers must be an object")
    clean: dict[str, str] = {}
    for k, v in payload.items():
        if k not in VALID_KEYS:
            raise ValueError(f"unknown procedure point: {k}")
        if not isinstance(v, str):
            raise ValueError(f"answer for {k} must be a string")
        v = v.strip()
        if len(v) > MAX_ANSWER_LEN:
            raise ValueError(f"answer for {k} exceeds {MAX_ANSWER_LEN} characters")
        clean[k] = v
    return clean


def load_saved(profile: BusinessProfile | None) -> dict[str, Any] | None:
    raw = getattr(profile, "procedure_json", None) if profile else None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001 — corrupt JSON reads as "not filled yet"
        return None


def build_procedure_pdf(
    *,
    user: User,
    profile: BusinessProfile | None,
    answers: dict[str, str],
    saved_at_str: str,
    generated_at_str: str,
) -> bytes:
    """Render the Danish procedurebeskrivelse with the house provenance
    footer (doc-hash, 2-pass) via bonbox_pdf_kit.render_with_doc_hash."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    from app.services.bonbox_pdf_kit import render_with_doc_hash

    business = user.business_name or user.email
    cvr = getattr(profile, "org_number", None)

    def story():
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Spacer

        styles = getSampleStyleSheet()
        h1 = ParagraphStyle(
            "H1", parent=styles["Title"], fontSize=15, spaceAfter=1,
            alignment=0, textColor="#111827",
        )
        sub = ParagraphStyle(
            "Sub", parent=styles["Normal"], fontSize=9.5, textColor="#6b7280",
            spaceAfter=10,
        )
        sect = ParagraphStyle(
            "Sect", parent=styles["Heading2"], fontSize=12, spaceBefore=12,
            spaceAfter=4, textColor="#111827",
        )
        point_label = ParagraphStyle(
            "PointLabel", parent=styles["Normal"], fontSize=9,
            textColor="#6b7280", spaceBefore=7, spaceAfter=1,
        )
        body = ParagraphStyle(
            "Body", parent=styles["Normal"], fontSize=10.5, leading=15,
            textColor="#111827",
        )
        note = ParagraphStyle(
            "Note", parent=styles["Normal"], fontSize=8.5, leading=12,
            textColor="#6b7280", spaceBefore=14,
        )

        s = [
            Paragraph("Beskrivelse af bogføringsprocedurer", h1),
            Paragraph(
                f"{business}" + (f" · CVR {cvr}" if cvr else "") +
                " · jf. bogføringslovens § 6",
                sub,
            ),
        ]
        for sec_id in ("1", "2", "3"):
            s.append(Paragraph(SECTION_TITLES[sec_id], sect))
            for p in PROCEDURE_POINTS:
                if p["section"] != sec_id:
                    continue
                text = (answers.get(p["key"]) or "").strip()
                if not text:
                    continue  # owner chose to leave the point out
                s.append(Paragraph(p["label"], point_label))
                s.append(Paragraph(text.replace("\n", "<br/>"), body))
        s.append(Spacer(1, 6 * mm))
        s.append(Paragraph(
            f"Udarbejdet og godkendt af {business} den {saved_at_str}. "
            "Grundlaget er virksomhedens egne oplysninger; felter markeret som "
            "aflæst bygger på virksomhedens faktiske registreringer i BonBox. "
            "Beskrivelsen opbevares sammen med regnskabsmaterialet og skal "
            "opdateres, når procedurerne ændres. Dokumentet er virksomhedens "
            "egen beskrivelse og udgør ikke juridisk rådgivning.",
            note,
        ))
        return s

    return render_with_doc_hash(
        story,
        pagesize=A4,
        title=f"Procedurebeskrivelse — {business}",
        subject="Beskrivelse af bogføringsprocedurer (bogføringslovens § 6)",
        software_id="bonbox-procedure",
        generated_at_str=generated_at_str,
        generator_email=user.email,
        is_danish=True,
    )
