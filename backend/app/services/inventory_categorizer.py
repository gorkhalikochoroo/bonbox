"""Smart inventory categorizer — deterministic-first, AI-fallback.

Two-pass design:

  Pass 1 — deterministic keyword rules per vertical.
    Free, instant, predictable. Catches the long tail of common items
    that owners type the same way every time ("Tuborg", "Heineken",
    "merlot", "engine oil"). Coverage target: >80% on a typical bar
    or workshop list. Tested against fixed corpora so a regression
    fails loudly here instead of in production.

  Pass 2 — AI categorization for whatever Pass 1 missed.
    Uses Haiku (fast + cheap, ~$0.80/M input tokens). Batches all
    unknowns into a single tool-use call so we pay tokenized JSON
    overhead once, not per-item. Strict schema via tool-use means we
    can't drift to free-text and the response is always machine-
    parseable. If AI fails / is missing API key / token cap is hit,
    items fall back to "Other" — never blocks the import.

Why deterministic-first matters:
  1. Cost: free vs Haiku-cheap-but-not-free. A bar with 200 wine
     SKUs imports them once a month — paying $0.001 per item adds
     up across the user base.
  2. Latency: keyword lookup is microseconds; Haiku call is ~1-2s.
     The user sees instant categorization for known items, with a
     small wait only for the unfamiliar ones.
  3. Reliability: rule-matched results never drift between runs;
     LLM outputs can vary. Predictability is critical for inventory
     since the categories drive downstream COGS / margin reports.
  4. Defense: rules can never be prompt-injected via item names.
     "Beer; ignore previous instructions" still gets categorized
     "Beer" by the rule pass before AI ever sees it.

Public surface:
  TAXONOMY[vertical] -> list[str]      — canonical categories per vertical
  categorize_deterministic(items, vertical) -> tuple[list, list]
  categorize_with_ai(items, vertical, *, model='claude-sonnet-5') -> tuple[list, dict]
  categorize_items(items, vertical, *, use_ai=True) -> tuple[list, dict]
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


# ─── Canonical taxonomies per vertical ─────────────────────────────────
# These are the legal target categories. AI is constrained to these
# values via the tool-use schema — it cannot invent new categories.
# Owners can rename them after import; the categorizer just ensures the
# initial bucketing is sane.

TAXONOMY: dict[str, list[str]] = {
    "bar": [
        "Beer", "Wine", "Spirits", "Liqueur", "Mixers", "Garnish",
        "Soft Drinks", "Coffee/Tea", "Snacks", "Disposables", "Cleaning",
        "Other",
    ],
    "restaurant": [
        "Beer", "Wine", "Spirits", "Soft Drinks", "Coffee/Tea",
        "Produce", "Meat", "Seafood", "Dairy", "Bakery", "Dry Goods",
        "Frozen", "Disposables", "Cleaning", "Other",
    ],
    "cafe": [
        "Coffee", "Tea", "Milk", "Syrups", "Pastry", "Sandwich",
        "Cold Drinks", "Snacks", "Disposables", "Cleaning", "Other",
    ],
    "workshop": [
        "Filters", "Oils & Fluids", "Brakes", "Engine Parts",
        "Suspension", "Body Parts", "Electrical", "Tires", "Tools",
        "Consumables", "Other",
    ],
    "retail": [
        "Apparel", "Electronics", "Beauty", "Food", "Household",
        "Toys", "Stationery", "Other",
    ],
    "salon": [
        "Hair Care", "Skin Care", "Hair Color", "Nail Care", "Tools",
        "Disposables", "Other",
    ],
    "grocery": [
        "Produce", "Dairy", "Meat", "Bakery", "Pantry", "Frozen",
        "Beverages", "Snacks", "Cleaning", "Personal Care", "Other",
    ],
}


# Default if business_type not in TAXONOMY — minimal but safe.
GENERIC_CATEGORIES = ["Beverages", "Food", "Supplies", "Other"]


# ─── Danish supplier / brand awareness ────────────────────────────────
# Major Danish hospitality + retail suppliers. When their name appears
# as a prefix on an item line ("Hørkram - Atlantic Salmon 2.5kg",
# "Netto Tuborg 6-pack") we want to STRIP the supplier name before
# rule-matching so the brand keyword still fires. Otherwise "Hørkram
# Tuborg" might not match "tuborg" because of the prefix.
#
# Casing handled at match-time via .lower(). Includes both food-service
# wholesalers (Hørkram, BC Catering, AC Catering, Sailing) and retail
# supermarkets where small businesses also shop (Rema 1000, Netto,
# Lidl, SuperBrugsen, Kvickly, Føtex, Bilka).
DANISH_SUPPLIERS = (
    "hørkram", "horkram",   # missing-diacritic variants common in OCR
    "bc catering", "bc-catering",
    "ac catering", "ac-catering",
    "sailing group", "sailing",
    "inco", "inco cash & carry",
    "catering engros",
    "danish crown",          # meat wholesaler often appears on slips
    "tulip food",
    "rema 1000", "rema",
    "netto", "discount",
    "lidl",
    "superbrugsen", "super brugsen", "brugsen",
    "kvickly",
    "føtex", "fotex",
    "bilka",
    "coop",
    "metro", "metro deutschland",
    "fisketorvet",
    "skagerak",
    "espersen",
    "royal greenland",
)


def _strip_supplier_prefix(name: str) -> str:
    """Remove a leading Danish-supplier name from an item label so the
    brand keyword underneath can still be rule-matched.

    Examples:
      'Hørkram - Atlantic Salmon 2.5kg'   → 'Atlantic Salmon 2.5kg'
      'Netto Tuborg 6-pack'                → 'Tuborg 6-pack'
      'BC Catering: Mælk 6L'                → 'Mælk 6L'

    Conservative — only strips when the supplier appears at the START
    of the name. Substring matches elsewhere are left alone (we don't
    want to false-positive remove 'rema' from 'crema fraiche')."""
    n = name.strip()
    nl = n.lower()
    for sup in DANISH_SUPPLIERS:
        if nl.startswith(sup):
            rest = n[len(sup):]
            # Strip common separators after the supplier name
            return rest.lstrip(" -:·,•—|").strip() or n
    return n


# ─── Keyword rules per vertical ────────────────────────────────────────
# Each rule maps a category → list of substrings (lowercased) found in
# item names. Order within a vertical matters: first match wins, so
# put more-specific keywords before more-general ones (e.g. "ipa"
# before "beer", "espresso" before "coffee").
#
# Rules are intentionally small and high-confidence — better to miss
# and let the AI handle it than to mislabel. "Mango" alone could be a
# fruit, garnish, mixer, or syrup depending on vertical → not in rules.
#
# Includes Danish (Mirabelle = Danish bar/restaurant) where it adds
# meaningful coverage; we don't try to translate everything since the
# AI fallback handles unknowns gracefully.

_RULES: dict[str, dict[str, list[str]]] = {
    "bar": {
        "Beer": [
            # Major Danish + International beer brands hospitality bars stock
            "tuborg", "carlsberg", "royal", "hancock", "fur øl", "thy øl",
            "skovlyst", "mikkeller", "to øl", "to-øl", "evil twin",
            "fanø bryghus", "amager bryghus", "hornbeer", "bryggeri",
            "heineken", "corona", "stella artois", "stella", "becks",
            "guinness", "kilkenny", "leffe", "duvel", "chimay",
            "asahi", "sapporo", "estrella", "peroni", "brooklyn",
            "lapin kulta", "krombacher", "warsteiner", "paulaner",
            "erdinger", "weihenstephan", "schöfferhofer",
            "grimbergen", "delirium", "kasteel",
            # Style keywords
            "pilsner", " ipa", " apa", "lager", " ale", "stout",
            "porter", "wheat beer", "weiss", "weizen", "hefeweiz",
            "saison", "lambic", "sour ", "berliner weisse",
            "trappist", "abbey", "tripel", "dubbel", "quadrupel",
            "barley wine", "session", "imperial",
            # Generic
            "beer", " øl", "fadøl", "draught", "draft beer",
            "non-alcoholic beer", "alkoholfri øl", "0.0",
        ],
        "Wine": [
            # Grape varieties — most common
            "merlot", "chardonnay", "pinot noir", "pinot grigio",
            "pinot gris", "pinot blanc", "syrah", "shiraz",
            "cabernet sauvignon", "cabernet", "sauvignon blanc",
            "sauvignon", "riesling", "viognier", "tempranillo",
            "sangiovese", "nebbiolo", "malbec", "zinfandel",
            "grenache", "gamay", "barbera", "albariño",
            "verdejo", "muscat", "gewürztraminer", "trebbiano",
            "vermentino", "pinotage", "carmenère", "cinsault",
            # Regions / appellations
            "rioja", "ribera", "chianti", "barolo", "barbaresco",
            "amarone", "valpolicella", "brunello", "montepulciano",
            "burgundy", "bordeaux", "rhone", "loire", "alsace",
            "champagne", "prosecco", "cava", "crémant", "asti",
            "rosé", "rosato", "rose wine", "rosado",
            # Generic
            "wine", " vin", "rødvin", "hvidvin", "musserende",
            "dessertvin", "port wine", "sherry", "madeira",
        ],
        "Spirits": [
            # Vodka
            "vodka", "absolut", "smirnoff", "stolichnaya",
            "grey goose", "ketel one", "tito",
            # Gin
            "gin", "bombay", "tanqueray", "hendrick", "bombay sapphire",
            "beefeater", "monkey 47", "the botanist", "sipsmith",
            "nordic gin", "mikkeller gin", "elephant gin",
            # Whisky
            "whisky", "whiskey", "scotch", "bourbon", "rye",
            "jameson", "jack daniel", "jim beam", "wild turkey",
            "macallan", "lagavulin", "glenfiddich", "glenlivet",
            "highland park", "talisker", "ardbeg", "laphroaig",
            "stauning", "fary lochan",  # Danish whisky
            # Rum
            "rum", "ron ", "havana club", "bacardi", "captain morgan",
            "kraken", "mount gay", "appleton",
            # Tequila / Mezcal
            "tequila", "mezcal", "patrón", "patron", "don julio",
            "jose cuervo", "casamigos", "sauza",
            # Brandy / Cognac
            "cognac", "brandy", "armagnac", "hennessy", "rémy martin",
            "courvoisier", "martell", "calvados",
            # Akvavit + Nordic
            "akvavit", "aalborg akvavit", "aquavit", "linie",
            "brøndum", "harald jensen",
            # Other
            "pisco", "soju", "sake", "shochu",
        ],
        "Liqueur": [
            "liqueur", "likør", "amaretto", "disaronno",
            "baileys", "irish cream", "kahlua", "tia maria",
            "campari", "aperol", "select", "sambuca", "limoncello",
            "frangelico", "chartreuse", "drambuie", "grand marnier",
            "cointreau", "triple sec", "curaçao", "midori",
            "chambord", "creme de cassis", "creme de menthe",
            "creme de cacao", "fernet", "branca", "averna",
            "jägermeister", "underberg", "becherovka",
            "cherry heering", "peter heering",
            # Schnapps / bitters
            "bitter", "bitters", "angostura", "peychaud",
            "schnapps", "snaps", "gammel dansk", "fisk ",
            "ferdinand", "stryynø",
            # Liqueurs by flavor
            "elderflower", "hyldeblomst", "blackcurrant", "solbær",
            "sloe gin", "slåen",
        ],
        "Mixers": [
            # Tonics + sodas
            "tonic", "tonic water", "fever tree", "schweppes",
            "soda water", "club soda", "sodavand",
            # Beer-style mixers
            "ginger beer", "ginger ale", "fentimans",
            # Citrus / fruit mixers
            "lemonade", "lemonadze", "cranberry juice", "tranebær",
            "lime juice", "lemon juice", "citron saft", "lime saft",
            "orange juice", "appelsinjuice",
            "pineapple juice", "ananas juice",
            "tomato juice", "tomatjuice",
            # Syrups
            "syrup", "monin", "torani", "1883",
            "grenadine", "blue curaçao syrup",
            "simple syrup", "sukkersirup",
        ],
        "Garnish": [
            # Olives + cherries
            "olive", "olives", "oliven", "kalamata",
            "cherries", "cherry", "maraschino",
            # Citrus + fruit garnishes
            "lime wedge", "lemon zest", "orange zest",
            "lemon peel", "orange peel",
            # Herbs / aromatics
            "mint sprig", "rosemary sprig", "thyme",
            # Other
            "garnish", "cocktail stick", "cocktail pick",
            "umbrella", "stirrer stick",
        ],
        "Soft Drinks": [
            "coca-cola", "coca cola", "coke", "cola",
            "pepsi", "sprite", "fanta", "7up", "schweppes",
            "dr pepper", "mountain dew",
            "faxe kondi", "faxe", "jolly cola",
            "soft drink", "sodavand",
            "still water", "sparkling water",
            "san pellegrino", "perrier", "evian", "voss",
            "danskvand", "rosa-citrus",
            # Energy / sports
            "red bull", "monster", "powerade", "gatorade",
        ],
        "Coffee/Tea": [
            "coffee", "espresso", "americano", "latte",
            "cappuccino", "macchiato", "mocha",
            "tea", "te ", "kaffe", "kaffemælk",
            "lavazza", "illy", "nespresso",
        ],
        "Disposables": [
            "straw", "sugerør", "napkin", "serviet",
            "coaster", "underlag", "cup", "kop", "krus",
            "lid", "låg", "stirrer", "rørepind",
            "paper bag", "papirpose", "to-go",
        ],
        "Cleaning": [
            "soap", "sæbe", "detergent", "opvaskemiddel",
            "sanitizer", "desinfektion", "bleach", "klorin",
            "rinse aid", "afspænding", "dishwash", "opvask",
            "cif", "ajax", "comet",
            "neutral", "miljømærke",
        ],
    },
    # Restaurant rules — food categories listed FIRST so brand
    # collisions (e.g. 'Royal Greenland' fish vs 'Royal' beer)
    # resolve to the more-specific food bucket. Order matters:
    # first match wins.
    "restaurant": {
        "Seafood": [
            # Brands first — most specific
            "royal greenland", "espersen", "fjordhus", "skagerak",
            "fisketorvet",
            # Species (DK + EN)
            "salmon", "laks", "røget laks", "smoked salmon",
            "shrimp", "rejer", "tigerrejer",
            "tuna", "tun", "tunfisk",
            "cod", "torsk", "kuller", "haddock",
            "fish", "fisk", "fiskefilet",
            "mussel", "muslinger", "blåmuslinger",
            "oyster", "østers", "scallop", "kammusling",
            "crab", "krabbe", "hummer", "lobster",
            "sild", "herring", "rakfisk", "graved",
            "rødspætte", "plaice", "havtaske", "monkfish",
            "sole", "tunge",
            "fiskeboller", "fiskefrikadeller",
            "stenbiderrogn", "lumpfish roe", "kaviar", "caviar",
        ],
        "Meat": [
            # Brands (Danish Crown is a major restaurant supplier)
            "danish crown", "tulip", "steff houlberg", "hopla",
            "skare", "rose poultry", "kødgrossisten",
            # Cuts / proteins (DK + EN)
            "chicken", "kylling", "kyllingebryst", "kyllingelår",
            "beef", "okse", "oksekød", "oksesteg", "oksefilet",
            "hakkebøf", "frikadelle", "ground beef", "hakket",
            "pork", "svin", "svinekam", "svinemørbrad", "flæsk",
            "lamb", "lam", "lammekrølle",
            "bacon", "spegepølse", "sausage", "pølse", "pølser",
            "ham", "skinke", "spegeskinke", "parmaskinke",
            "duck", "and ", "andebryst",
            "veal", "kalv", "kalvefilet",
            "tartar", "carpaccio", "leverpostej",
            "schnitzel", "wienerschnitzel",
        ],
        "Dairy": [
            # Brands (Arla is dominant in DK; Lurpak is THE butter)
            "arla", "lurpak", "lurpakk", "kærgården", "kaergaarden",
            "castello", "buko", "cheasy", "skyr",
            "mathilde", "harboe", "thise",
            "philadelphia", "boursin", "brie", "camembert",
            "puck", "carla", "minimælk",
            # Generic (DK + EN)
            "milk", "mælk", "sødmælk", "skummetmælk",
            "letmælk", "kakaomælk",
            "cream", "fløde", "piskefløde", "sødfløde",
            "kaffefløde", "creme fraiche", "crème fraîche",
            "butter", "smør", "saltet smør",
            "cheese", "ost", "danbo", "havarti", "esrom",
            "cheddar", "parmesan", "mozzarella", "feta",
            "yogurt", "yoghurt", "kefir",
            "egg", "æg", "økologiske æg",
            "kvark", "kvarg",
        ],
        "Bakery": [
            # Brands
            "schulstad", "kohberg", "lantmännen",
            "kornkammer", "wienerbrød konditori",
            # Items (DK + EN)
            "bread", "brød", "rugbrød", "rye bread",
            "franskbrød", "white bread",
            "bun", "boller", "rolls", "burgerboller",
            "pastry", "wienerbrød", "danish pastry",
            "kage", "cake", "cookie", "småkage",
            "muffin", "scone",
            "tortilla", "wrap", "pita", "naan",
            "kringle", "rundstykke", "morgenbolle",
            "flour", "mel", "hvedemel", "rugmel",
            "yeast", "gær", "bagepulver", "baking powder",
        ],
        "Beer": [
            "tuborg", "carlsberg", "hancock", "mikkeller",
            "to øl", "to-øl", "thy øl", "fur øl", "skovlyst",
            "heineken", "corona", "stella", "becks", "guinness",
            "pilsner", " ipa", " apa", "lager", " ale", "stout",
            "beer", " øl", "fadøl", "alkoholfri øl",
        ],
        "Wine": [
            "merlot", "chardonnay", "pinot", "syrah", "shiraz",
            "cabernet", "sauvignon", "riesling", "tempranillo",
            "rioja", "chianti", "burgundy", "bordeaux",
            "champagne", "prosecco", "cava", "rosé", "rosato",
            "wine", " vin", "rødvin", "hvidvin", "musserende",
        ],
        "Spirits": [
            "vodka", "absolut", "smirnoff",
            "gin", "bombay", "tanqueray", "hendrick",
            "whisky", "whiskey", "bourbon", "scotch",
            "jameson", "jack daniel", "macallan",
            "rum", "bacardi", "havana", "captain morgan",
            "tequila", "mezcal", "patrón", "patron",
            "cognac", "brandy", "calvados",
            "akvavit", "aquavit", "linie",
        ],
        "Soft Drinks": [
            "coca-cola", "coke", "cola", "pepsi", "sprite", "fanta",
            "faxe kondi", "faxe", "soft drink", "sodavand",
            "san pellegrino", "perrier", "danskvand",
        ],
        "Coffee/Tea": [
            "coffee", "espresso", "americano", "latte", "cappuccino",
            "kaffe", "lavazza", "illy",
            # NOTE: 'tea' / 'te ' deliberately omitted — too short to
            # avoid collisions with Danish words ending in 'te' like
            # 'rødspætte'. Caller falls back to AI for tea items.
        ],
        "Produce": [
            # Vegetables (DK + EN)
            "tomato", "tomat", "onion", "løg", "rødløg", "porre", "leek",
            "lettuce", "salat", "potato", "kartoffel", "kartofler",
            "carrot", "gulerod", "gulerødder",
            "garlic", "hvidløg", "pepper", "peberfrugt", "chili",
            "cucumber", "agurk", "agurker", "spinach", "spinat",
            "basil", "basilikum", "parsley", "persille",
            "thyme", "timian", "rosemary", "rosmarin", "dill",
            "kohlrabi", "knoldselleri", "celery", "selleri",
            "broccoli", "blomkål", "cauliflower", "kale", "grønkål",
            "rucola", "rucula", "spire", "sprouts",
            "champignon", "mushroom", "svampe",
            "courgette", "squash", "aubergine", "eggplant",
            "asparges", "asparagus", "rødbede", "beetroot",
            "pastinak", "parsnip", "rødkål", "red cabbage",
            "kål", "cabbage", "rosenkål",
            # Fruit
            "lemon", "citron", "lime", "appelsin", "orange",
            "apple", "æble", "pear", "pære", "banana",
            "berries", "bær", "strawberry", "jordbær",
            "blueberry", "blåbær", "raspberry", "hindbær",
            "grape", "drue", "melon",
            "avocado", "kiwi", "pineapple", "ananas",
            "mango", "papaya", "passion",
            # Herbs (general)
            "ingefær", "ginger",
        ],
        # NOTE: Seafood/Meat/Dairy/Bakery are defined ABOVE the Beer/
        # Wine/etc. block so brand collisions resolve to food first.
        # Don't redefine them here.
        "Dry Goods": [
            "rice", "ris", "basmati", "jasmine", "arborio",
            "pasta", "spaghetti", "penne", "fusilli", "tagliatelle",
            "lasagne", "ravioli", "tortellini",
            "noodle", "nudler", "ramen", "udon",
            "lentil", "linse", "linser",
            "bean", "bønne", "kikærte", "chickpea",
            "salt", "havsalt", "groft salt",
            "sugar", "sukker", "rørsukker", "brun farin",
            "honning", "honey",
            "pepper", "peber", "sortpeber",
            "spice", "krydderi", "krydderier",
            "olie", "oil", "olivenolie", "rapsolie",
            "vinegar", "eddike", "balsamico",
            "sauce", "ketchup", "mayonnaise", "remoulade",
            "soy sauce", "sojasovs", "tabasco", "sambal",
            "stock", "fond", "bouillon", "knorr", "maggi",
            "tomato sauce", "tomatpuré", "tomatpasta",
            "mustard", "sennep", "honning sennep",
            "carmencita", "beauvais", "heinz", "knorr",
            "maizena", "aurion", "den gamle fabrik",
        ],
        "Frozen": [
            "frozen", "frossen", "frost",
            "ice cream", "is ", "isbar", "fløde-is",
            "premier-is", "frisko", "magnum",
            "pommes frites", "fries", "kartoffelchips",
            "frozen vegetables", "frostgrøntsager",
            "daloon", "kims", "marvel", "findus", "iglo",
            "frozen pizza", "frostpizza", "wagyu",
        ],
        "Disposables": [
            "napkin", "serviet", "straw", "sugerør",
            "cup", "kop", "krus", "lid", "låg",
            "to-go", "takeaway box", "pizza box",
            "aluminium foil", "alufolie", "plastic wrap",
            "paper bag", "papirpose",
        ],
        "Cleaning": [
            "soap", "sæbe", "detergent", "opvaskemiddel",
            "sanitizer", "desinfektion", "bleach", "klorin",
            "cif", "ajax", "neutral", "ecover",
            "miljømærke", "rengøring",
            "kitchen roll", "køkkenrulle", "kitchen paper",
            "håndklæde papir",
        ],
    },
    # Cafe rules — order is precedence-sensitive. Cold Drinks first so
    # 'iskaffe' beats Coffee's 'kaffe'. Coffee BEFORE Milk so 'Latte
    # oat milk' (a coffee drink) lands in Coffee, not Milk. Pastry /
    # Sandwich first because they're food and shouldn't accidentally
    # match anything in beverage rules.
    "cafe": {
        "Pastry": [
            "croissant", "muffin", "cake", "pastry", "kage",
            "wienerbrød", "kringle", "scone",
            "cinnamon roll", "kanelsnegl", "kanelbolle",
            "morgenbolle", "rundstykke", "tebirkes",
            "spandauer", "frosnapper", "wienerbrød",
            "danish", "donut", "doughnut",
        ],
        "Sandwich": [
            "sandwich", "wrap", "bagel", "panini", "ciabatta",
            "smørrebrød", "open-faced",
            "focaccia", "baguette",
        ],
        "Cold Drinks": [
            # Brands
            "rynkeby", "kelda", "valsølille",
            "san pellegrino", "perrier", "evian",
            # DK soft drinks
            "faxe kondi", "sodavand", "danskvand",
            # Cold coffee/tea specific (BEFORE Coffee/Tea so they win)
            "iskaffe", "iced coffee", "iced tea", "kold te",
            "cold brew", "nitro", "frappé", "frappuccino",
            # Other
            "smoothie", "juice", "saft", "appelsinjuice",
            "soda", "cola", "coca-cola", "coke", "pepsi",
            "kombucha",
            # Energy
            "red bull", "monster",
        ],
        "Coffee": [
            # Major Copenhagen specialty roasters
            "the coffee collective", "coffee collective",
            "andersen & maillard", "andersen og maillard",
            "april coffee", "april",
            "la cabra", "prolog", "prolog coffee",
            "kaffefair", "risteriet", "estate coffee",
            "great coffee", "kontra coffee",
            "stooping",
            # International common in DK cafes
            "lavazza", "illy", "nespresso", "starbucks",
            "intelligentsia", "blue bottle",
            # Roast / drink terms (DK + EN)
            "espresso", "americano", "latte", "cappuccino",
            "cortado", "macchiato", "flat white", "mocha",
            "filter coffee", "drip coffee", "pour over",
            "aeropress", "v60", "chemex",
            "single origin", "blend",
            "ethiopia", "colombia", "kenya", "guatemala", "brazil",
            "decaf", "koffeinfri",
            "coffee bean", "kaffebønne", "kaffebønner",
            "ground coffee", "malet kaffe",
            "espresso bean",
            # Generic
            "coffee", "kaffe",
        ],
        "Tea": [
            # Brands
            "pukka", "twinings", "lipton", "yogi", "tiger ",
            "clipper", "teekanne", "ronnefeldt",
            "perch og hannibal", "anytime tea",
            # Types
            "earl grey", "english breakfast",
            "green tea", "grøn te", "matcha",
            "white tea", "hvid te",
            "oolong", "rooibos",
            "chamomile", "kamille",
            "peppermint", "pebermynte",
            "chai", "tisane",
            # Generic
            " tea", "thee", "te ",  # spaced to avoid matching 'rødspætte'
        ],
        # Milk listed AFTER Coffee so 'Latte oat milk' (a coffee drink)
        # lands in Coffee. Pure 'oat milk 1L' still hits Milk via
        # 'oatly' / 'havremælk' / etc. brand keywords.
        "Milk": [
            # Brands (Arla dominant in DK)
            "arla", "thise", "minimælk", "letmælk", "sødmælk",
            "skummetmælk", "økologisk mælk",
            # Plant-based (popular in CPH cafes)
            "oat milk", "havremælk", "oatly", "naturli",
            "soy milk", "soyamælk", "alpro",
            "almond milk", "mandelmælk",
            "coconut milk", "kokosmælk",
            # Generic
            "milk", "mælk",
        ],
        "Syrups": [
            "syrup", "monin", "torani", "1883", "routin",
            "vanilla", "vanilje", "caramel", "karamel",
            "hazelnut", "hasselnød",
            "sukkersirup", "simple syrup",
        ],
        "Snacks": [
            "chips", "kartoffelchips", "popcorn",
            "chocolate", "chokolade", "lakrids", "liquorice",
            "nut", "nødder", "mandel", "almond",
            "energy bar", "müslibar", "müsli bar",
        ],
        "Disposables": [
            "cup", "kop", "krus", "lid", "låg",
            "straw", "sugerør", "napkin", "serviet",
            "stirrer", "rørepind", "paper bag", "papirpose",
            "to-go", "takeaway",
            "ecotainer", "compostable",
        ],
        "Cleaning": [
            "soap", "sæbe", "detergent", "opvaskemiddel",
            "sanitizer", "desinfektion",
            "espresso machine cleaner", "cafiza",
            "milk cleaner", "rengøringsmiddel",
            "descaler", "afkalker",
        ],
    },
    "workshop": {
        "Filters": ["filter", "oil filter", "air filter", "fuel filter", "cabin filter"],
        "Oils & Fluids": [
            "engine oil", "motorolie", "transmission fluid",
            "brake fluid", "coolant", "antifreeze", "wiper fluid",
            "power steering fluid", "atf", "5w-30", "5w30", "10w-40", "10w40",
        ],
        "Brakes": ["brake pad", "brake disc", "brake rotor", "brake caliper", "brake shoe"],
        "Engine Parts": [
            "spark plug", "ignition coil", "timing belt", "alternator",
            "starter motor", "water pump", "drive belt",
        ],
        "Suspension": ["shock", "strut", "control arm", "sway bar", "bushing"],
        "Body Parts": ["bumper", "fender", "headlight", "tail light", "mirror"],
        "Electrical": ["battery", "fuse", "relay", "wire harness"],
        "Tires": ["tire", "tyre", "dæk", "tube"],
        "Tools": ["wrench", "socket", "pliers", "screwdriver", "jack"],
        "Consumables": ["gasket", "seal", "o-ring", "grease", "wd-40", "shop towel"],
    },
    "retail": {
        "Apparel": [
            "shirt", "pants", "dress", "jacket", "shoe", "sock",
            "hat", "scarf", "jeans",
        ],
        "Electronics": [
            "phone", "tablet", "laptop", "charger", "cable", "headphone",
            "speaker", "battery",
        ],
        "Beauty": ["lipstick", "mascara", "perfume", "cologne", "lotion"],
        "Food": ["snack", "candy", "chocolate", "cookie", "cracker"],
        "Household": ["towel", "sheet", "pillow", "blanket", "lamp", "candle"],
        "Toys": ["toy", "puzzle", "doll", "lego"],
        "Stationery": ["pen", "pencil", "notebook", "paper", "marker"],
    },
    "salon": {
        "Hair Care": [
            "shampoo", "conditioner", "hair mask", "hair oil",
            "leave-in", "serum",
        ],
        "Skin Care": [
            "moisturizer", "cleanser", "toner", "face cream",
            "sunscreen", "exfoliator",
        ],
        "Hair Color": ["color", "dye", "bleach", "developer", "toner"],
        "Nail Care": ["polish", "remover", "nail file", "cuticle"],
        "Tools": ["scissor", "razor", "comb", "brush", "clipper", "dryer"],
        "Disposables": ["glove", "towel", "cape", "foil", "cotton"],
    },
    "grocery": {
        "Produce": [
            "apple", "banana", "tomato", "tomat", "onion", "potato",
            "lettuce", "carrot", "lemon", "lime", "orange", "grape",
            "broccoli",
        ],
        "Dairy": ["milk", "mælk", "cheese", "ost", "yogurt", "butter", "smør", "cream", "fløde"],
        "Meat": ["chicken", "beef", "pork", "lamb", "bacon", "sausage", "ham"],
        "Bakery": ["bread", "brød", "bun", "roll", "cake", "pastry"],
        "Pantry": [
            "rice", "pasta", "flour", "sugar", "salt", "oil",
            "vinegar", "soy sauce", "ketchup", "mustard",
        ],
        "Frozen": ["frozen", "frossen", "ice cream"],
        "Beverages": [
            "juice", "soda", "water", "coffee", "tea", "beer", "wine",
        ],
        "Snacks": ["chip", "cracker", "cookie", "candy", "chocolate", "nut"],
        "Cleaning": ["soap", "detergent", "bleach", "sponge"],
        "Personal Care": ["toothpaste", "shampoo", "deodorant", "razor"],
    },
}


def get_taxonomy(business_type: str | None) -> list[str]:
    """Return the canonical category list for a business_type.

    Falls back to GENERIC_CATEGORIES for unknown verticals so the
    pipeline never crashes on a new business_type added without a
    rule update.
    """
    if not business_type:
        return GENERIC_CATEGORIES
    return TAXONOMY.get(business_type.lower(), GENERIC_CATEGORIES)


def _match_category(name: str, rules: dict[str, list[str]]) -> str | None:
    """Find the first matching category for an item name. Case-insensitive
    substring match. Returns None if nothing matches.

    Strips Danish-supplier prefixes ('Hørkram - ', 'BC Catering: ',
    'Netto ') before matching so 'Hørkram Atlantic Salmon' still hits
    the seafood/salmon rule. Without this, the supplier name on the
    front would prevent legitimate brand keywords behind from matching.
    """
    if not name:
        return None
    cleaned = _strip_supplier_prefix(name)
    n = cleaned.lower()
    # Iterate in dict insertion order — caller controls precedence by
    # ordering the keys in _RULES (more specific before more general).
    for category, keywords in rules.items():
        for kw in keywords:
            if kw in n:
                return category
    return None


def categorize_deterministic(
    items: list[dict], business_type: str | None
) -> tuple[list[dict], list[int]]:
    """Pass 1 — apply keyword rules.

    Returns (items_with_categories, indices_still_unknown). The
    `items_with_categories` list is the same items in the same order;
    items the rules couldn't handle have category=None and their
    indices appear in the second return value. AI handles those.

    Items that already have a non-empty `category` (e.g. user provided
    one on input) are left alone.
    """
    rules = _RULES.get((business_type or "").lower(), {})
    out: list[dict] = []
    unknown: list[int] = []

    for i, item in enumerate(items):
        # Defensive copy so we don't mutate caller's dicts.
        new_item = dict(item) if isinstance(item, dict) else {"name": str(item)}

        # Respect pre-existing category if set.
        existing = (new_item.get("category") or "").strip()
        if existing:
            out.append(new_item)
            continue

        match = _match_category(new_item.get("name", ""), rules)
        if match:
            new_item["category"] = match
            new_item["category_source"] = "rule"
        else:
            new_item["category"] = None
            unknown.append(i)
        out.append(new_item)

    return out, unknown


# ─── AI fallback (Pass 2) ──────────────────────────────────────────────

CATEGORIZER_PROMPT_VERSION = "inv_categorize_v1"

_CATEGORIZER_SYSTEM = (
    "You are an inventory-categorization assistant for Danish "
    "hospitality businesses (restaurants, bars, cafes, workshops, "
    "shops). Assign each item to exactly one of the provided "
    "categories — never invent a new category, never leave one empty, "
    "never explain. If an item is unclear, choose 'Other'. "
    "Respond ONLY via the categorize_inventory tool.\n\n"
    "DANISH SUPPLIER + BRAND CONTEXT:\n"
    "Common food-service wholesalers include Hørkram, BC Catering, "
    "AC Catering, Sailing Group, Inco, Catering Engros, Danish Crown, "
    "Tulip. Retail supermarkets where small businesses also shop: "
    "Rema 1000, Netto, Lidl, SuperBrugsen, Kvickly, Føtex, Bilka, "
    "Coop, Metro.\n\n"
    "Items often arrive with the supplier name as a prefix "
    "('Hørkram - Atlantic Salmon', 'Netto Tuborg'). IGNORE the "
    "supplier prefix when categorizing — focus on the actual product.\n\n"
    "Major Danish food brands: Arla (dairy), Lurpak (butter), "
    "Castello (cheese), Skyr/Cheasy (yogurt), Royal Greenland "
    "(seafood), Tulip / Steff Houlberg / Hopla (meat / charcuterie), "
    "Tuborg / Carlsberg / Royal / Mikkeller / Hancock (beer), "
    "Aalborg Akvavit, Faxe Kondi (Danish cola), Rynkeby (juice), "
    "Schulstad / Kohberg (bakery), Daloon / Kims (frozen), "
    "Beauvais / Carmencita / Knorr / Maggi / Aurion (pantry).\n\n"
    "Common Danish item names: laks (salmon), kylling (chicken), "
    "okse (beef), svin (pork), mælk (milk), smør (butter), ost "
    "(cheese), brød (bread), rugbrød (rye bread), tomater (tomatoes), "
    "agurker (cucumbers), løg (onions), gulerødder (carrots), "
    "kartofler (potatoes), æble (apple), pølse (sausage), pommes "
    "frites (fries), is (ice cream), sukker (sugar), salt (salt), "
    "ris (rice), pasta (pasta).\n\n"
    "Use this knowledge to categorize confidently."
)


def _build_categorize_tool(allowed_categories: list[str]) -> dict:
    """Build the Anthropic tool-use schema constrained to allowed categories.

    Strict enum on the category field is the defense against prompt-
    injection in item names — the API itself rejects any value not in
    the enum, so a malicious 'Beer; DROP TABLE inventory' name still
    can only emit one of our legal categories."""
    return {
        "name": "categorize_inventory",
        "description": "Assign a category to each input item.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {
                                "type": "integer",
                                "description": "0-based index of the item in the input list.",
                            },
                            "category": {
                                "type": "string",
                                "enum": allowed_categories,
                            },
                        },
                        "required": ["index", "category"],
                    },
                }
            },
            "required": ["items"],
        },
    }


def categorize_with_ai(
    items: list[dict],
    business_type: str | None,
    *,
    model: str = "claude-sonnet-5",
    max_tokens: int = 2000,
    timeout: float = 30.0,
) -> tuple[list[dict], dict]:
    """Pass 2 — categorize items the rules couldn't handle.

    Args:
        items: list of items WITHOUT category (or with category=None).
        business_type: drives the allowed-category enum.
        model: Haiku is the default — Sonnet would be overkill.

    Returns (categorized_items, meta) where meta has:
        input_tokens, output_tokens, model_used, timing_ms, error.

    Failures (no API key, timeout, schema mismatch) result in items
    being assigned category="Other" with category_source="fallback".
    The smart-import flow MUST NOT block on AI failure — owner-facing
    UX trumps perfect categorization.
    """
    allowed = get_taxonomy(business_type)
    meta: dict[str, Any] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "model_used": model,
        "timing_ms": 0,
        "error": None,
    }

    if not items:
        return [], meta

    # No API key → fall back to "Other" for everything. Keeps the
    # pipeline functional in dev / offline.
    api_key = getattr(settings, "ANTHROPIC_API_KEY", None)
    if not api_key:
        meta["error"] = "no_api_key"
        return [_fallback_other(it, allowed) for it in items], meta

    try:
        import anthropic
    except ImportError:
        meta["error"] = "anthropic_sdk_not_installed"
        return [_fallback_other(it, allowed) for it in items], meta

    # Build a compact list — name only, indexed. Don't feed the AI
    # quantities or other PII; less context = less attack surface.
    compact = [
        {"index": i, "name": (it.get("name") or "")[:120]}
        for i, it in enumerate(items)
    ]
    user_prompt = (
        f"Business type: {business_type or 'general'}\n"
        f"Categorize each of these {len(compact)} items into one of: "
        f"{', '.join(allowed)}.\n\n"
        f"Items:\n{json.dumps(compact, ensure_ascii=False)}"
    )

    tool = _build_categorize_tool(allowed)

    t0 = time.monotonic()
    try:
        client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=_CATEGORIZER_SYSTEM,
            tools=[tool],
            tool_choice={"type": "tool", "name": tool["name"]},
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as e:  # noqa: BLE001
        meta["error"] = type(e).__name__
        meta["timing_ms"] = int((time.monotonic() - t0) * 1000)
        logger.warning("categorize_with_ai failed: %s", e)
        return [_fallback_other(it, allowed) for it in items], meta

    meta["timing_ms"] = int((time.monotonic() - t0) * 1000)
    if hasattr(resp, "usage"):
        meta["input_tokens"] = getattr(resp.usage, "input_tokens", 0) or 0
        meta["output_tokens"] = getattr(resp.usage, "output_tokens", 0) or 0

    # Extract tool_use block.
    tool_input: dict | None = None
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "tool_use":
            tool_input = getattr(block, "input", None)
            break

    if not tool_input or "items" not in tool_input:
        meta["error"] = "no_tool_output"
        return [_fallback_other(it, allowed) for it in items], meta

    # Build index → category map. Defensive: drop indices the model
    # invented out of range, defensive enum check (anthropic SDK should
    # have already enforced via input_schema, but trust + verify).
    cat_by_index: dict[int, str] = {}
    for entry in tool_input.get("items") or []:
        idx = entry.get("index")
        cat = entry.get("category")
        if not isinstance(idx, int) or not (0 <= idx < len(items)):
            continue
        if cat not in allowed:
            cat = "Other" if "Other" in allowed else allowed[-1]
        cat_by_index[idx] = cat

    out: list[dict] = []
    for i, it in enumerate(items):
        new_item = dict(it)
        if i in cat_by_index:
            new_item["category"] = cat_by_index[i]
            new_item["category_source"] = "ai"
        else:
            # Model didn't return this index → fallback.
            new_item["category"] = "Other" if "Other" in allowed else allowed[-1]
            new_item["category_source"] = "fallback"
        out.append(new_item)
    return out, meta


def _fallback_other(item: dict, allowed: list[str]) -> dict:
    """Tag item with 'Other' and source='fallback' — used when AI is
    unavailable or fails. Never block the import path."""
    new_item = dict(item)
    new_item["category"] = "Other" if "Other" in allowed else allowed[-1]
    new_item["category_source"] = "fallback"
    return new_item


def categorize_items(
    items: list[dict],
    business_type: str | None,
    *,
    use_ai: bool = True,
) -> tuple[list[dict], dict]:
    """Orchestrator — runs Pass 1, then Pass 2 if needed.

    Returns (categorized_items, meta). meta includes:
        rule_matched: int     — how many items the rules handled
        ai_matched: int       — how many AI handled
        fallback_count: int   — how many got "Other" as last resort
        input_tokens, output_tokens, model_used, timing_ms, error

    `use_ai=False` is the test-friendly mode: skips the network call,
    everything unmatched becomes "Other" via fallback.
    """
    meta: dict[str, Any] = {
        "rule_matched": 0,
        "ai_matched": 0,
        "fallback_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "model_used": None,
        "timing_ms": 0,
        "error": None,
    }

    if not items:
        return [], meta

    # Pass 1.
    after_rules, unknown_indices = categorize_deterministic(items, business_type)
    meta["rule_matched"] = len(items) - len(unknown_indices)

    if not unknown_indices:
        return after_rules, meta

    if not use_ai:
        # Test path / offline mode: fallback everything.
        allowed = get_taxonomy(business_type)
        for i in unknown_indices:
            after_rules[i] = _fallback_other(after_rules[i], allowed)
        meta["fallback_count"] = len(unknown_indices)
        return after_rules, meta

    # Pass 2 — pull the unknowns into a sub-list for AI, then merge back.
    sub_items = [after_rules[i] for i in unknown_indices]
    sub_categorized, ai_meta = categorize_with_ai(sub_items, business_type)
    for j, idx in enumerate(unknown_indices):
        after_rules[idx] = sub_categorized[j]

    # Tally AI vs fallback in the merged result.
    for idx in unknown_indices:
        src = after_rules[idx].get("category_source")
        if src == "ai":
            meta["ai_matched"] += 1
        else:
            meta["fallback_count"] += 1

    meta["input_tokens"] = ai_meta.get("input_tokens", 0)
    meta["output_tokens"] = ai_meta.get("output_tokens", 0)
    meta["model_used"] = ai_meta.get("model_used")
    meta["timing_ms"] = ai_meta.get("timing_ms", 0)
    meta["error"] = ai_meta.get("error")
    return after_rules, meta
