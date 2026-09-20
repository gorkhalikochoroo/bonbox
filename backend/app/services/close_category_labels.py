"""Danish display labels for the BUILT-IN daily-close categories.

Why this exists
---------------
The kasserapport PDF rendered every revenue/payment key with ``k.title()``, so
a Danish accounting document handed to a revisor said "Food", "Takeaway",
"Bank Transfer" — English labels on a DK artifact, while the screen that
produced it said "Mad", "Kontant". The screen already has the right words: the
built-in categories in ``frontend/src/pages/DailyClosePage.jsx`` each carry an
i18n ``labelKey`` (``dcCatFood`` …) resolved through ``useLanguage.jsx``.

This module mirrors that vocabulary server-side so the artifact and the page
agree.

The one rule that matters
-------------------------
Only BUILT-IN keys are translated. A category the owner typed themselves
carries no ``labelKey`` on the frontend and carries no entry here — it passes
through **verbatim**, exactly as the owner wrote it. Translating an owner's own
words would put language in their accounts that they never chose, and would be
unrecognisable to them on the document their revisor reads back to them.

Terminology lock: ``gavekort``, ``faktura``, ``MobilePay``, ``PayPal`` and
``Takeaway`` are the same word in both languages and are not "translated" — they
are spelled the way the app spells them.
"""
from __future__ import annotations

# Built-in REVENUE categories — mirrors REVENUE_CATS_BY_TYPE in
# DailyClosePage.jsx and the dcCat* keys in useLanguage.jsx (en + da).
_REVENUE_LABELS: dict[str, tuple[str, str]] = {
    # key                 (da,                            en)
    "food":               ("Mad",                         "Food"),
    "drinks":             ("Drikkevarer",                  "Drinks"),
    "takeaway":           ("Takeaway",                     "Takeaway"),
    "parts":              ("Reservedele",                  "Parts"),
    "labor":              ("Arbejde",                      "Labour"),
    "diagnostics":        ("Fejlsøgning",                  "Diagnostics"),
    "towing":             ("Bugsering",                    "Towing"),
    "products":           ("Varer",                        "Products"),
    "returns":            ("Returvarer",                   "Returns"),
    "services":           ("Ydelser",                      "Services"),
    "treatments":         ("Behandlinger",                 "Treatments"),
    "retail_products":    ("Udsalgsvarer",                 "Retail products"),
    "bread_pastry":       ("Brød & bagværk",               "Bread & pastry"),
    "other":              ("Andet",                        "Other"),
    "groceries":          ("Dagligvarer",                  "Groceries"),
    "tobacco_lottery":    ("Tobak & lotteri",              "Tobacco & lottery"),
    "fresh":              ("Frisk",                        "Fresh"),
    "online_sales":       ("Onlinesalg",                   "Online sales"),
    "returns_refunds":    ("Returneringer & refusioner",   "Returns & refunds"),
    "shipping":           ("Fragtindtægt",                 "Shipping revenue"),
    "revenue":            ("Omsætning",                    "Revenue"),
}

# Built-in PAYMENT methods — mirrors PAYMENT_METHODS_BY_TYPE + the dcPay* keys.
# MobilePay / PayPal are brand names and are NOT translated in either language;
# `faktura` and `gavekort` keep their Danish spelling in both by the locked
# terminology rule.
_PAYMENT_LABELS: dict[str, tuple[str, str]] = {
    "cash":          ("Kontant",        "Cash"),
    "kontant":       ("Kontant",        "Cash"),
    "card":          ("Kort",           "Card"),
    "card_online":   ("Kort (online)",  "Card (online)"),
    "mobilepay":     ("MobilePay",      "MobilePay"),
    "paypal":        ("PayPal",         "PayPal"),
    "invoice":       ("Faktura",        "Faktura"),
    "faktura":       ("Faktura",        "Faktura"),
    "bank_transfer": ("Bankoverførsel", "Bank transfer"),
    "gift_card":     ("Gavekort",       "Gavekort"),
    "gavekort":      ("Gavekort",       "Gavekort"),
    # Card-brand splits that ride along in payment_breakdown for revisor
    # fidelity. Brand names — identical in both languages, but cased properly
    # instead of ".title()"-mangled ("Softpay", not "Softpay"/"SoftPay" drift).
    "dankort":       ("Dankort",        "Dankort"),
    "visa":          ("Visa",           "Visa"),
    "mastercard":    ("Mastercard",     "Mastercard"),
    "softpay":       ("Softpay",        "Softpay"),
    "betalingskort": ("Betalingskort",  "Betalingskort"),
}


# Card-brand / scheme splits that ride along inside payment_breakdown for
# revisor fidelity. They are a BREAKDOWN OF THE CARD LINE, never extra payment
# methods — the write side excludes them from payment_total (routers/
# daily_close.py) and the range export drops them from its buckets
# (daily_close_range_export.py). Both used to keep a private copy of this set;
# the kasserapport now needs the same knowledge to avoid printing brand lines
# as peers of the card line above a total that deliberately excludes them, so
# the set lives here once.
CARD_BRAND_KEYS = frozenset({
    "dankort", "visa", "mastercard", "softpay", "betalingskort",
})


def normalize_payment_key(key: str) -> str:
    """Lower/underscore form used to compare a stored key against the built-in
    vocabulary ("Bank Transfer", "bank-transfer" → "bank_transfer")."""
    return (key or "").strip().lower().replace(" ", "_").replace("-", "_")


def is_card_brand_key(key: str) -> bool:
    """True when `key` is a card-brand split of the card line rather than a
    payment method in its own right."""
    return normalize_payment_key(key) in CARD_BRAND_KEYS


def _lookup(table: dict[str, tuple[str, str]], key: str, danish: bool) -> str | None:
    entry = table.get((key or "").strip().lower())
    if entry is None:
        return None
    return entry[0] if danish else entry[1]


def revenue_category_label(key: str, *, danish: bool = True) -> str:
    """Display label for one revenue-breakdown key.

    Built-in key → the app's own word ("food" → "Mad"). Anything else is the
    OWNER'S OWN category name and is returned verbatim, untouched — never
    translated, never title-cased.
    """
    return _lookup(_REVENUE_LABELS, key, danish) or (key or "")


def payment_method_label(key: str, *, danish: bool = True) -> str:
    """Display label for one payment-breakdown key. Same rule as above:
    built-ins get the app's word, owner-typed keys pass through verbatim.

    Legacy / imported closes can carry "Bank Transfer" or "gift-card" where the
    write side persists "bank_transfer"; those are still BUILT-IN keys and get
    the app's word rather than falling through as if the owner had typed them.
    """
    return (
        _lookup(_PAYMENT_LABELS, key, danish)
        or _lookup(_PAYMENT_LABELS, normalize_payment_key(key), danish)
        or (key or "")
    )


def is_builtin_revenue_category(key: str) -> bool:
    """True when `key` is one of the app's own categories (so a caller can tell
    an owner-typed name apart from a built-in one)."""
    return (key or "").strip().lower() in _REVENUE_LABELS
