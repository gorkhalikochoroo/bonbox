"""DK MOMS-fradrag classifier — pins the Momsloven §42 rule logic that the
filing's input-VAT now depends on. Wrong classification is harmful in BOTH
directions (over-claim = SKAT fine; under-claim = owner loses real fradrag),
so these tests lock the conservative, explicit-match behaviour."""
from app.services.dk_fradrag import fradrag_factor


def test_normal_categories_get_full_fradrag():
    for name in (
        "Ingredients", "Rent", "Husleje", "Utilities", "El", "Supplies",
        "Other", "Ukategoriseret", "Groceries", "Varekøb",
        # Near-misses of the no-moms words below must keep full fradrag.
        "Salon produkter", "Salat", "Leveringsgebyr",
    ):
        assert fradrag_factor(name) == 1.0, name


def test_costs_without_moms_have_nothing_to_deduct():
    # This list used to sit in the test above as FULL fradrag — "Wages" and
    # "Løn" included — which deducted 20% of every wage bill as købsmoms that
    # was never paid. Wages, holiday pay, pension and insurance carry no moms.
    for name in (
        "Løn", "Lønninger", "Wages", "Salary", "Salaries", "Payroll",
        "Feriepenge", "Pension", "Forsikring", "Insurance",
    ):
        assert fradrag_factor(name) == 0.0, name


def test_empty_and_none_default_to_full():
    assert fradrag_factor("") == 1.0
    assert fradrag_factor("   ") == 1.0
    assert fradrag_factor(None) == 1.0


def test_repraesentation_is_zero_fradrag():
    for name in (
        "Repræsentation", "repræsentation", "Repræsentationsudgifter",
        "Representation", "Repr.",
    ):
        assert fradrag_factor(name) == 0.0, name


def test_restaurant_and_hotel_are_quarter_fradrag():
    for name in (
        "Restaurantbesøg", "restaurantbesøg", "Restauration",
        "Forretningsfrokost", "Forretningsmiddag", "Hotel", "Overnatning",
    ):
        assert fradrag_factor(name) == 0.25, name


def test_gavekort_is_not_falsely_zero():
    # 'Gavekort' (gift cards bought as resale stock) must NOT trip the
    # repræsentation rule — plain 'gave' is deliberately unmatched.
    assert fradrag_factor("Gavekort") == 1.0
    assert fradrag_factor("Gift cards") == 1.0
