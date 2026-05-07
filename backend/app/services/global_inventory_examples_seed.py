"""Pre-seed canonical global smart-inventory examples.

Runs once on first deploy (idempotent — won't re-insert on restart).
Bootstraps the AI extraction pipeline with a curated set of examples
covering Denmark's major suppliers + brands, so a fresh tenant gets
high-quality categorization on day one without anyone having to
teach the model.

Selection criteria for each canonical example:
  • Brand or supplier the codebase already recognizes in
    DANISH_SUPPLIERS / categorizer rules
  • Common SKU shape (size + unit visible on the slip)
  • Maps to a clear, unambiguous BonBox category

Privacy: these examples carry only {extracted_name → final_name,
final_category} deltas — no sale amounts, no per-business data, no
PII. Same privacy posture as user-corrected examples that already
flow into the few-shot prompt.

How it works:
  • _CANONICAL_EXAMPLES is a static list (below)
  • seed_if_empty() runs at app startup, after migrations
  • Idempotency: skips entirely if any global example already exists.
    This means founder corrections via the super_admin path don't
    get clobbered by re-running the seed (they only run once on a
    truly fresh DB).
  • Updates: bumping the version means the seed re-runs on a
    truly empty global table — safe across redeploys.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy.orm import Session

from app.models.inventory_import_example import InventoryImportExample

logger = logging.getLogger(__name__)


# ─── Canonical example library ────────────────────────────────────────
#
# Each tuple: (kind, extracted_name, extracted_category,
#              final_name, final_category, notes)
#
# Categories are BonBox's canonical category set (Beer, Spirits, Wine,
# Soft Drinks, Coffee, Tea, Dairy, Seafood, Meat, Bakery, Produce,
# Garnish, Cleaning, etc.) used across categorizer rules + UI.
#
# Format hints:
#   • Names use Danish form ("Tuborg Pilsner 33cl" not "Tuborg
#     Pilsner 12oz") — matches what supplier slips actually say
#   • Sizes use "cl" / "ml" / "l" / "kg" / "stk" / "pak" — DK norms
#   • Brand-first, descriptor-second: "Royal Greenland laks" not
#     "laks Royal Greenland"

_CANONICAL_EXAMPLES: list[tuple[str, str, str | None, str, str | None, str]] = [
    # ── Beer (bar / restaurant / cafe) ─────────────────────────────
    ("name_correction", "Tuborg",      None, "Tuborg Pilsner 33cl",     "Beer",        "Common shorthand for the green bottle"),
    ("name_correction", "Toob 33",     None, "Tuborg Pilsner 33cl",     "Beer",        "Shorthand on bar slips"),
    ("name_correction", "Carlsberg",   None, "Carlsberg Hof 33cl",      "Beer",        "Default Carlsberg = Hof in DK bars"),
    ("name_correction", "Royal Pilsner", None, "Royal Pilsner 33cl",    "Beer",        ""),
    ("name_correction", "Mikkeller IPA", None, "Mikkeller IPA 33cl",    "Beer",        "Craft beer"),
    ("name_correction", "Faxe",        None, "Faxe Premium 33cl",       "Beer",        ""),
    ("category_correction", "Carlsberg Hof",  "General",  "Carlsberg Hof 33cl",  "Beer",        ""),
    ("category_correction", "Tuborg Classic", "General",  "Tuborg Classic 33cl", "Beer",        ""),

    # ── Spirits ──────────────────────────────────────────────────
    ("name_correction", "Aalborg Akvavit", None, "Aalborg Akvavit 70cl", "Spirits",    "Classic Danish snaps"),
    ("name_correction", "Bombay",      None, "Bombay Sapphire 70cl",    "Spirits",     "Gin"),
    ("name_correction", "Absolut",     None, "Absolut Vodka 70cl",      "Spirits",     ""),
    ("name_correction", "Smirnoff",    None, "Smirnoff Vodka 70cl",     "Spirits",     ""),
    ("name_correction", "Bacardi",     None, "Bacardi Rum 70cl",        "Spirits",     ""),
    ("name_correction", "Jägermeister", None, "Jägermeister 70cl",      "Spirits",     ""),
    ("name_correction", "Fernet",      None, "Fernet-Branca 70cl",      "Spirits",     ""),

    # ── Wine ─────────────────────────────────────────────────────
    ("category_correction", "Rødvin husets",      "General",  "Rødvin husets 75cl",       "Wine", "House red"),
    ("category_correction", "Hvidvin Sauvignon Blanc", "General", "Sauvignon Blanc 75cl", "Wine", "House white"),
    ("category_correction", "Rosé Provence",      "General",  "Rosé Provence 75cl",       "Wine", ""),
    ("category_correction", "Champagne Moët",     "General",  "Moët & Chandon 75cl",      "Wine", "Sparkling — bookkept under Wine"),

    # ── Soft drinks (cafe / restaurant) ─────────────────────────
    ("name_correction", "Coca Cola",   None, "Coca-Cola 33cl",          "Soft Drinks", ""),
    ("name_correction", "Cola Zero",   None, "Coca-Cola Zero 33cl",     "Soft Drinks", ""),
    ("name_correction", "Sprite",      None, "Sprite 33cl",             "Soft Drinks", ""),
    ("name_correction", "Fanta",       None, "Fanta Orange 33cl",       "Soft Drinks", ""),
    ("name_correction", "Faxe Kondi",  None, "Faxe Kondi 33cl",         "Soft Drinks", "DK lemonade"),
    ("name_correction", "Schweppes Tonic", None, "Schweppes Tonic 33cl", "Soft Drinks", ""),

    # ── Coffee + tea (cafe context) ─────────────────────────────
    ("name_correction", "Espresso bønner", None, "Espresso bønner 1kg",  "Coffee",     "Beans by kg"),
    ("name_correction", "Møstings kaffe",  None, "Møstings kaffe 1kg",  "Coffee",     "Copenhagen roaster"),
    ("name_correction", "La Cabra",        None, "La Cabra kaffe 250g",  "Coffee",     "Aarhus roaster"),
    ("name_correction", "The Coffee Collective", None, "The Coffee Collective 250g", "Coffee", "Copenhagen roaster"),
    ("name_correction", "Earl Grey",       None, "Earl Grey te 100g",    "Tea",        ""),

    # ── Dairy (Lurpak, Arla, Thise) ─────────────────────────────
    ("name_correction", "Lurpak",      None, "Lurpak smør 250g",        "Dairy",       "Iconic DK butter"),
    ("name_correction", "Sødmælk",     None, "Sødmælk 1l",              "Dairy",       ""),
    ("name_correction", "Arla skyr",   None, "Arla Skyr 1kg",           "Dairy",       ""),
    ("name_correction", "Thise smør",  None, "Thise smør 250g",         "Dairy",       "Organic"),
    ("name_correction", "Mozzarella",  None, "Mozzarella 125g",         "Dairy",       ""),
    ("name_correction", "Parmesan",    None, "Parmesan revet 200g",     "Dairy",       ""),

    # ── Seafood (Royal Greenland, Skagerak, Espersen) ────────────
    ("name_correction", "Royal Greenland laks fersk", None,
        "Royal Greenland laks fersk 1kg", "Seafood", "Hørkram supplier prefix; brand=Royal Greenland"),
    ("name_correction", "Skagerak rødspætte filet", None,
        "Skagerak rødspætte filet 1kg",   "Seafood", ""),
    ("name_correction", "Rejer",       None, "Rejer 200g",              "Seafood",     ""),
    ("name_correction", "Tun",         None, "Tun frisk 1kg",           "Seafood",     ""),
    ("name_correction", "Torsk filet", None, "Torsk filet 1kg",         "Seafood",     ""),

    # ── Meat (Danish Crown, Tulip Food) ──────────────────────────
    ("name_correction", "Danish Crown svinekød", None,
        "Danish Crown svinekød 1kg",      "Meat",        "Default supplier"),
    ("name_correction", "Tulip bacon",  None, "Tulip Bacon 200g",       "Meat",        ""),
    ("name_correction", "Kylling brystfilet", None, "Kylling brystfilet 1kg", "Meat",  ""),
    ("name_correction", "Hakket oksekød 8-12%", None,
        "Hakket oksekød 8-12% 1kg",       "Meat",        ""),
    ("name_correction", "Lammekød",    None, "Lammekød 1kg",            "Meat",        ""),

    # ── Bakery + carbs (rugbrød, gluten staples) ────────────────
    ("name_correction", "Rugbrød grovskåret", None,
        "Rugbrød grovskåret 1kg",         "Bakery",      ""),
    ("name_correction", "Croissant",   None, "Croissant smør 70g stk",  "Bakery",      "DK café staple"),
    ("name_correction", "Wienerbrød",  None, "Wienerbrød 100g stk",     "Bakery",      ""),
    ("name_correction", "Snittebrød",  None, "Snittebrød 500g",         "Bakery",      ""),

    # ── Produce ─────────────────────────────────────────────────
    ("name_correction", "Tomater rød", None, "Tomater rød 1kg",         "Produce",     ""),
    ("name_correction", "Agurk dansk", None, "Agurk dansk stk",         "Produce",     ""),
    ("name_correction", "Salat hjerte", None, "Salat hjertesalat stk", "Produce",     ""),
    ("name_correction", "Citroner",    None, "Citroner stk",            "Produce",     ""),
    ("name_correction", "Limes",       None, "Limes stk",               "Produce",     "Bar garnish or food"),
    ("category_correction", "Limes",   "Produce", "Limes stk",          "Garnish",     "If shop is bar context — Garnish wins"),

    # ── Garnish (bar context) ──────────────────────────────────
    ("name_correction", "Mynteblade",  None, "Mynteblade frisk bdt",   "Garnish",     "Mojito"),
    ("name_correction", "Oliven sorte", None, "Oliven sorte 200g",     "Garnish",     ""),
    ("name_correction", "Cocktail kirsebær", None, "Maraschino-kirsebær 200g", "Garnish", ""),

    # ── Cleaning + supplies (kiosk / cafe) ─────────────────────
    ("name_correction", "Karklude",    None, "Karklude pak",            "Cleaning",    ""),
    ("name_correction", "Toiletpapir", None, "Toiletpapir 8 ruller",    "Cleaning",    ""),
    ("name_correction", "Servietter",  None, "Servietter pak",          "Supplies",    ""),
    ("name_correction", "Kaffefilter", None, "Kaffefilter 1x4 pak",     "Supplies",    ""),
]


def seed_if_empty(db: Session) -> dict:
    """Insert canonical global examples if the global table is empty.

    Idempotent — checking via .filter(is_global=True).first() is fast
    enough at app startup; no need for a separate marker table.

    Returns:
      {"inserted": N} on first run
      {"inserted": 0, "skipped": True} on subsequent runs
    """
    existing = db.query(InventoryImportExample).filter(
        InventoryImportExample.is_global.is_(True),
    ).first()
    if existing is not None:
        return {"inserted": 0, "skipped": True}

    inserted = 0
    for kind, extracted_name, extracted_cat, final_name, final_cat, notes in _CANONICAL_EXAMPLES:
        row = InventoryImportExample(
            id=uuid.uuid4(),
            user_id=None,            # global
            is_global=True,
            kind=kind,
            extracted_name=extracted_name,
            extracted_category=extracted_cat,
            final_name=final_name,
            final_category=final_cat,
            promoted_from_import_id=None,
            hit_count=1,
            notes=notes or "Bootstrapped on first deploy",
        )
        db.add(row)
        inserted += 1

    db.commit()
    return {"inserted": inserted, "skipped": False}


def example_count() -> int:
    """Helper for tests + admin panel — how many canonical examples
    we ship in the bootstrap."""
    return len(_CANONICAL_EXAMPLES)
