"""Egenkontrol R1a — the Kontrolmappe PDF, read with pypdf (never by size).

Plan "PDF content": the venue from the account (never a query param), local
times right in winter and summer, a readable minus, typed markup printed as
text, the Doc-hash footer, "Ikke registreret" and "Fortrudte indtastninger",
the late text, Danish whatever the cook's language, the shared-screen names
legend, no overclaims, the 30-day limit, and the export audit row.
"""
import io
import json
from datetime import datetime, timedelta

from pypdf import PdfReader

from app.models.audit_log import AuditLog
from tests._ek_support import START, env  # noqa: F401 — fixture

MINUS = "−"


def _pdf(env, owner, **params):
    r = env.client.get("/api/egenkontrol/folder.pdf", params=params, headers=env.h(owner))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    return r


def _text(raw: bytes) -> tuple[str, PdfReader]:
    reader = PdfReader(io.BytesIO(raw))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return " ".join(text.split()), reader


def _fonts(reader) -> set:
    out = set()
    for page in reader.pages:
        res = page.get("/Resources") or {}
        fonts = res.get("/Font") or {}
        for f in fonts.values():
            out.add(str(f.get_object().get("/BaseFont")))
    return out


def test_the_pdf_says_what_happened_in_danish(env):
    o = env.owner(name="Bistro Nørrebro")
    checks = env.setup(o)
    fridge, freezer = checks["fridge"]["id"], checks["freezer"]["id"]
    # 12 Nov: fridge read at 09:30 (frist 08:00) — late and out of limit, chosen
    # in English on the device: codes are stored, the PDF prints Danish.
    env.clock.set(datetime(2026, 11, 12, 8, 30))
    r = env.save(o, fridge, 7.1, action_code="thermostat_adjusted", fate_code="moved",
                 action_note="<b>Bold</b> & co")
    assert r.status_code == 201, r.text
    env.save(o, freezer, -18.0, typed_name="Ali K.")
    undone = env.save(o, freezer, -18.5, typed_name="Mia").json()
    env.client.post(f"/api/egenkontrol/entries/{undone['id']}/undo", headers=env.h(o))
    # 14 Nov: nobody wrote the 13th down
    env.clock.set(datetime(2026, 11, 14, 12, 0))
    r = _pdf(env, o, **{"from": "2026-11-12", "to": "2026-11-14", "business_name": "Evil"})
    assert 'filename="Kontrolmappe_2026-11-12_2026-11-14.pdf"' in r.headers["content-disposition"]
    text, reader = _text(r.content)

    assert "Bistro Nørrebro" in text and "Evil" not in text
    assert "CVR 12345678" in text and "EK-20261112-20261114" in text
    assert "Doc-hash:" in text
    assert "Overblik" in text and "Afvigelser" in text
    assert "Registreringer pr. kontrolpunkt" in text
    assert "For sent · registreret kl. 09:30 (frist kl. 08:00)" in text
    assert "Justeret termostaten" in text and "Flyttet til anden køl" in text
    assert "<b>Bold</b> & co" in text              # typed markup prints as text
    assert "Ikke registreret" in text
    assert "Fortrudte indtastninger" in text and "18,5" in text
    assert "Ali K. (skrevet ind)" in text
    assert 'Navne markeret "valgt på køkken-iPad" er valgt på en delt skærm.' in text
    assert "Risikoanalyse og egenkontrolprogram ligger hos virksomheden." in text
    assert "Kontrolpunkter og grænser" in text
    assert "Grænse fra loven: BEK nr. 1331 af 20/11/2025" in text
    assert "Startværdi fra Fødevarestyrelsens eksempel på egenkontrol" in text
    assert "Gennemgået af:" in text
    for never in ("klar til Fødevarestyrelsen", "Sikker", "Alt er dokumenteret"):
        assert never not in text, never
    # the minus sign: U+2212 is not in Helvetica's WinAnsi set, so ReportLab
    # 4.2.5 draws it from the Symbol font (plan D12). pypdf reads it back as
    # U+2212 through Symbol's own encoding; if a pypdf version maps the glyph
    # differently, the Symbol font in the page resources is the evidence.
    assert "18,0 °C" in text
    if f"{MINUS}18,0" not in text:
        assert any("Symbol" in f for f in _fonts(reader)), _fonts(reader)

    audit = env.db.query(AuditLog).filter(AuditLog.action == "export.artifact_generated").all()
    assert len(audit) == 1
    after = json.loads(audit[0].after_state)
    assert after["doc_type"] == "egenkontrol_registreringer"
    assert after["bilagsnummer"] == "EK-20261112-20261114" and len(after["doc_hash"]) == 64
    assert after["period_start"] == "2026-11-12"


def test_local_times_are_right_in_winter_and_in_summer(env):
    o = env.owner()
    env.clock.set(datetime(2026, 1, 15, 5, 10))        # 06:10 CET
    fridge = env.setup(o, items=START[:1])["fridge"]["id"]
    env.clock.set(datetime(2026, 1, 15, 7, 30))        # 08:30 CET
    env.save(o, fridge, 3.4)
    env.clock.set(datetime(2026, 7, 15, 6, 30))        # 08:30 CEST
    env.save(o, fridge, 4.4)
    env.clock.set(datetime(2026, 7, 16, 12, 0))
    winter, _ = _text(_pdf(env, o, **{"from": "2026-01-15", "to": "2026-01-15"}).content)
    summer, _ = _text(_pdf(env, o, **{"from": "2026-07-15", "to": "2026-07-15"}).content)
    # one row per slot: date, frist, value, registered (local), who
    assert "15. jan 2026 kl. 08:00 3,4 °C kl. 08:30 Mia" in winter
    assert "kl. 07:30" not in winter                   # never the UTC clock
    assert "15. jul 2026 kl. 08:00 4,4 °C kl. 08:30 Mia" in summer
    assert "kl. 06:30" not in summer


def test_a_93_day_range_is_refused(env):
    """R1b: 92 days per file (R1a refused 31)."""
    o = env.owner()
    env.setup(o)
    r = env.client.get("/api/egenkontrol/folder.pdf", params={"from": "2026-08-12", "to": "2026-11-12"},
                       headers=env.h(o))
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "range_too_long", "max_days": 92}


def test_injected_markup_cannot_break_or_steer_the_pdf(env):
    o = env.owner(name="<img src='http://10.0.0.1/x'/> & Co")
    env.setup(o, items=[{"template_key": "fridge", "name": "<font color=red>Køl</font>"}])
    env.clock.tick(minutes=40)
    fridge = env.today_json(o)["checks"][0]["id"]
    env.save(o, fridge, 3.0, typed_name="<i>Ali</i>")
    text, _ = _text(_pdf(env, o).content)
    assert "<img src='http://10.0.0.1/x'/> & Co" in text
    assert "<font color=red>Køl</font>" in text and "<i>Ali</i>" in text


def test_default_period_is_the_last_30_days(env):
    o = env.owner()
    env.setup(o)
    r = _pdf(env, o)
    assert 'Kontrolmappe_2026-10-14_2026-11-12.pdf' in r.headers["content-disposition"]
    text, _ = _text(r.content)
    assert "14. okt 2026 – 12. nov 2026" in text
    assert timedelta  # noqa: B018 — imported for readers extending the period tests
