"""
allergy_detector — rule-based allergy signal detection (safety-critical).

The locks under test are the honesty/safety invariants:
  • Real allergy language in DA + EN is caught (recall bias).
  • A food PREFERENCE ("elsker nødder" / "extra cheese") never cries wolf.
  • "ingen allergi" / "no allergies" → silent (no flag), but a SPECIFIC allergen
    survives a generic negation ("no allergies but allergic to nuts" → nuts).
  • Severity language escalates suggested_severity to "severe" (never a number).
  • Unspecified allergy language still raises a GENERIC flag (never a silent
    all-clear).
  • Only tags in the vertical's vocabulary are ever suggested.

Run: cd backend && python3 -m pytest tests/test_allergy_detector.py -q
"""
from app.services.allergy_detector import detect_allergy_signals as d


def _tags(gn="", an="", bt="restaurant"):
    r = d(gn, an, bt)
    return set(r["suggested_tags"]) if r else set()


def test_danish_allergy_flags_specific_tag():
    assert _tags("Allergisk over for nødder") == {"nuts"}
    assert _tags("kan ikke tåle gluten") == {"gluten"}
    assert "milk" in _tags("laktoseintolerant")


def test_english_allergy_flags():
    assert _tags("allergic to shellfish") == {"crustaceans"}
    assert _tags("severe peanut allergy") >= {"peanuts"}


def test_free_compound_is_a_restriction_without_other_context():
    assert _tags("glutenfri tak") == {"gluten"}
    assert _tags("skal have mælkefri dessert") == {"milk"}


def test_preference_without_context_does_not_flag():
    # Loves nuts / wants extra — NOT an allergy. Must stay silent.
    assert d("Vi elsker nødder", "", "restaurant") is None
    assert d("gerne ekstra ost", "", "restaurant") is None
    assert d("vil gerne have fisk", "", "restaurant") is None


def test_avoid_words_are_context():
    assert _tags("ingen nødder tak") == {"nuts"}
    assert _tags("no shellfish please") == {"crustaceans"}


def test_no_allergies_is_silent():
    assert d("ingen allergi", "", "restaurant") is None
    assert d("no allergies", "", "restaurant") is None
    assert d("no known allergies", "", "restaurant") is None


def test_specific_allergen_survives_generic_negation():
    # The classic trap: a blanket "no allergies" must NOT suppress a named one.
    assert _tags("no allergies but allergic to nuts") == {"nuts"}


def test_severity_language_escalates():
    r = d("livstruende nøddeallergi", "", "restaurant")
    assert r and r["suggested_severity"] == "severe" and "nuts" in r["suggested_tags"]
    # Severity word alone (no allergen) still surfaces, generically.
    r2 = d("risk of anaphylaxis", "", "restaurant")
    assert r2 and r2["generic"] is True and r2["suggested_severity"] == "severe"


def test_generic_flag_when_unspecified():
    r = d("har en allergi", "", "restaurant")
    assert r and r["generic"] is True and r["suggested_tags"] == []
    assert r["confidence"] == "keyword_match" and r["unconfirmed"] is True


def test_allergy_note_field_is_context_by_itself():
    # A bare allergen in the dedicated allergy_note needs no other context word.
    assert _tags(gn="", an="nødder") == {"nuts"}


def test_only_vertical_vocabulary_is_suggested():
    # 'penicillin' is a MEDICAL allergen — not in the restaurant (food) vocab,
    # so a restaurant booking never suggests it; a clinic does.
    assert _tags("allergisk over for penicillin", bt="restaurant") == set()
    assert _tags("allergisk over for penicillin", bt="clinic") == {"penicillin"}


def test_empty_input_is_none():
    assert d("", "", "restaurant") is None
    assert d(None, None, "restaurant") is None
