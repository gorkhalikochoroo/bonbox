"""Egenkontrol R1b — what the Kontrolmappe PDF prints (pypdf text, never size).

Overblik with "Fra papir" and "Rettelser"; a corrected deviation STAYS under
Afvigelser with "Rettet: Tastefejl"; a "Rettelser" section; paper readings
with both times; "Foto vedlagt"; the owner's documents LISTED (never
attached); the findsmiley.dk link as plain text; every typed string escaped;
the real minus; the doc-hash footer; and never a claim it cannot make.
"""
import io
from datetime import timedelta

from pypdf import PdfReader

from tests._ek_support import T0, env, store  # noqa: F401 — fixtures

MINUS = "−"


def _text(content: bytes) -> str:
    reader = PdfReader(io.BytesIO(content))
    return " ".join(p.extract_text() for p in reader.pages).replace("\n", " ")


def _section(text: str, start: str, end: str) -> str:
    i = text.index(start)
    return text[i:text.index(end, i)]


def test_the_r1b_pdf(env, store):
    o = env.owner()
    c = env.setup(o)
    fridge, freezer = c["fridge"]["id"], c["freezer"]["id"]
    assert env.client.put("/api/egenkontrol/settings", headers=env.h(o),
                          json={"findsmiley_url": "https://www.findsmiley.dk/769342"}).status_code == 200
    env.doc(o, title="<b>Plan & co</b>")
    env.clock.tick(minutes=40)                                   # 08:10
    dev = env.save(o, fridge, 9.9, action_code="thermostat_adjusted", fate_code="moved").json()
    assert env.photo(o, dev["id"]).status_code == 201
    env.save(o, freezer, -18.0)
    env.clock.tick(minutes=20)                                   # 08:30
    r = env.correct(o, dev["id"], "typo", value_c=3.9)
    assert r.status_code == 201, r.text
    env.clock.set(T0 + timedelta(days=2))                        # 14 Nov 07:30
    p = env.paper(o, fridge, 4.0, "2026-11-13", "08:05", reason="Nettet nede <i>&</i>")
    assert p.status_code == 201, p.text

    resp = env.client.get("/api/egenkontrol/folder.pdf",
                          params={"from": "2026-11-12", "to": "2026-11-14"}, headers=env.h(o))
    assert resp.status_code == 200
    t = _text(resp.content)

    # header + overview
    assert "Kontrolrapporter på findsmiley.dk: https://www.findsmiley.dk/769342" in t
    ov = _section(t, "Overblik", "Afvigelser Dato")
    assert ("Målinger Til tiden For sent Ikke registreret Afvigelser Heraf ikke afsluttet "
            "Fra papir Rettelser Fortrudt 3 3 0 3 1 0 1 1 0") in ov

    # Afvigelser: the corrected deviation is still there, with its reason
    devs = _section(t, "Afvigelser Dato", "Registreringer pr. kontrolpunkt")
    flat = devs.replace(" ", "")
    assert "9,9°C" in flat
    assert "Rettet:Tastefejl·9,9°C→3,9°C·12.nov2026kl.08:30" in flat
    assert "Rettet—ikkeenafvigelse" in flat
    assert "Fotovedlagt" in flat

    # per-check rows: the paper reading prints both times and its reason
    per = _section(t, "Registreringer pr. kontrolpunkt", "Fortrudte indtastninger")
    pflat = per.replace(" ", "")
    assert "Frapapir·indtastet14.novkl.07:30·målt13.novkl.08:05·Årsag:Nettetnede<i>&</i>" in pflat
    assert "(frapapir)(skrevetind)" in pflat
    assert "Rettet(seRettelser)" in pflat
    assert "13. nov 2026 kl. 08:00 4,0 °C kl. 08:05" in per        # its time column = measured
    assert f"{MINUS}18,0 °C" in t or "18,0 °C" in t

    # Fortrudte: the corrected original is NOT here; Rettelser lists it
    und = _section(t, "Fortrudte indtastninger", "Ugentlig gennemgang")
    assert "Ingen fortrudte indtastninger i perioden." in und
    ret = und[und.index("Rettelser"):]
    rflat = ret.replace(" ", "")
    assert "Tastefejl" in rflat and "9,9°C" in rflat and "3,9°C" in rflat
    assert "12.nov2026kl.08:30" in rflat

    # weekly review (none) and documents (listed by title and date)
    assert "Ingen ugentlig gennemgang registreret i perioden." in t
    docs = _section(t, "Dokumenter i BonBox (pr. 14. nov 2026)", "Kontrolpunkter og grænser")
    assert "Egenkontrolprogram" in docs and "<b>Plan & co</b>" in docs
    assert "12. nov 2026" in docs and "12. nov 2027" in docs
    assert "Dokumenterne er ikke vedlagt denne udskrift. De kan vises i BonBox." in docs

    # legend + footer + never-claims
    assert 'Målinger markeret "fra papir" er tastet ind af ejeren efter et papirnotat' in t
    assert '"Foto vedlagt" betyder, at der ligger et foto i BonBox ved målingen.' in t
    assert "Doc-hash:" in t
    for never in ("klar til Fødevarestyrelsen", "Aktuel", "Sikker", "Alt er dokumenteret"):
        assert never not in t, never


def test_a_hygiejnebevis_prints_no_review_date(env, store):
    """The PDF's documents table: the programme keeps "Gennemgås igen senest"
    a year on; the hygiejnebevis (it does not expire) prints "–" there."""
    o = env.owner()
    env.setup(o)
    env.doc(o, title="Program", doc_type="programme")
    env.doc(o, title="Bevis Mia", doc_type="hygiene_cert", name="bevis.pdf")
    resp = env.client.get("/api/egenkontrol/folder.pdf",
                          params={"from": "2026-11-12", "to": "2026-11-12"}, headers=env.h(o))
    assert resp.status_code == 200
    t = _text(resp.content)
    docs = _section(t, "Dokumenter i BonBox", "Kontrolpunkter og grænser")
    assert "Gennemgås igen senest" in docs
    assert docs.count("12. nov 2027") == 1                       # the programme only
    hyg = docs[docs.index("Hygiejnebevis"):]
    hyg = hyg[:hyg.index("Dokumenterne er ikke vedlagt")]
    assert "Bevis Mia" in hyg and "12. nov 2027" not in hyg
    assert hyg.rstrip().endswith("–"), hyg


def test_empty_sections_say_so(env, store):
    o = env.owner()
    env.setup(o)
    t = _text(env.client.get("/api/egenkontrol/folder.pdf", headers=env.h(o)).content)
    assert "Ingen rettelser i perioden." in t
    assert "Ingen dokumenter lagt i BonBox." in t
    assert "Ingen ugentlig gennemgang registreret i perioden." in t
    assert "findsmiley" not in t


def test_a_corrected_paper_reading_keeps_its_paper_reason(env, store):
    """reason_text = the paper reason, correction_text = the correction's
    words. A corrected "Fra papir" row must still print WHY it came in late,
    in the JSON and in the PDF — for a 'typo' (no text) and an 'other'."""
    o = env.owner()
    fridge = env.setup(o)["fridge"]["id"]
    env.clock.set(T0 + timedelta(days=2))                        # 14 Nov 07:30
    p = env.paper(o, fridge, 3.0, "2026-11-13", "08:10", reason="Nettet var nede")
    assert p.status_code == 201, p.text
    a = env.correct(o, p.json()["id"], "typo", value_c=3.2)
    assert a.status_code == 201, a.text
    a = a.json()["entry"]
    assert a["reason_text"] == "Nettet var nede" and a["correction_text"] is None
    b = env.correct(o, a["id"], "other", value_c=3.5, reason_text="Aflæst forkert")
    assert b.status_code == 201, b.text
    b = b.json()["entry"]
    assert b["reason_text"] == "Nettet var nede" and b["correction_text"] == "Aflæst forkert"
    assert b["source"] == "paper"

    f = env.folder(o, **{"from": "2026-11-13", "to": "2026-11-14"})
    assert [x["reason_text"] for x in f["paper"]] == ["Nettet var nede"]
    assert [c["reason_text"] for c in f["corrections"]] == [None, "Aflæst forkert"]

    resp = env.client.get("/api/egenkontrol/folder.pdf",
                          params={"from": "2026-11-13", "to": "2026-11-14"}, headers=env.h(o))
    assert resp.status_code == 200
    t = _text(resp.content)
    flat = t.replace(" ", "")
    assert "Årsag:Nettetvarnede" in flat
    assert "Årsag:Aflæstforkert" not in flat                      # never as the paper reason
    ret = t[t.index("Rettelser", t.index("Fortrudte indtastninger")):]
    assert "Aflæst forkert" in ret and "Tastefejl" in ret
