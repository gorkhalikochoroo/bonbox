"""
note_intent — rule-based reservation note classification.

Locks under test:
  • DA + EN operational cues are caught (birthday / anniversary / business /
    accessibility / large group).
  • Accessibility OUTRANKS everything (safety-relevant seating need wins).
  • A specific text intent beats the size-only fallback (a birthday for 10 is a
    birthday, not merely "large group").
  • party_size >= threshold yields large_group even with an empty note.
  • Only the defined buckets are ever returned; nothing matched → None (never a
    fabricated label).

Run: cd backend && python3 -m pytest tests/test_note_intent.py -q
"""
from app.services.note_intent import classify_note_intent as c, VALID_INTENTS


def test_birthday_da_and_en():
    assert c("Fejrer fødselsdag i aften") == "celebration_birthday"
    assert c("birthday dinner for grandma") == "celebration_birthday"


def test_anniversary():
    assert c("Vores bryllupsdag") == "celebration_anniversary"
    assert c("25th wedding anniversary") == "celebration_anniversary"


def test_business():
    assert c("Forretningsmøde med en kunde") == "business"
    assert c("work dinner, need it quiet") == "business"


def test_accessibility_outranks_everything():
    # A wheelchair need is the most actionable thing to get right — it wins even
    # when celebration language is also present.
    assert c("Fødselsdag, gæst i kørestol") == "accessibility"
    assert c("need a high chair for the baby") == "accessibility"


def test_specific_intent_beats_size_fallback():
    # A birthday for 12 is a birthday, not just "large group".
    assert c("Stor fødselsdag", party_size=12) == "celebration_birthday"


def test_large_group_from_size_only():
    assert c(None, party_size=8) == "large_group"
    assert c("", party_size=10) == "large_group"


def test_large_group_from_text():
    assert c("Selskab på 6") == "large_group"


def test_no_signal_is_none():
    assert c("Vindue tak") is None          # "window seat please" — no bucket
    assert c(None) is None
    assert c("", party_size=2) is None


def test_only_valid_labels_returned():
    for note in ["fødselsdag", "bryllupsdag", "firmamiddag", "kørestol", "selskab"]:
        r = c(note)
        assert r is None or r in VALID_INTENTS


def test_preference_not_misread_as_business():
    # "team" appears in business cues; a bare unrelated word shouldn't over-fire
    # on a normal note. (Sanity: plain dietary note stays None here.)
    assert c("Ingen løg tak") is None       # "no onion please"
