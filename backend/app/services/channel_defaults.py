"""System order-channel defaults — single source of truth.

Every BonBox tenant starts with this catalogue available out of the box. The
user can override label / emoji / color for any of these by POSTing a custom
OrderChannelConfig with the same slug, and they can add brand-new channels
(Foodpanda, Hungry.dk, internal "VIP table", etc.) on top.

Slugs in SYSTEM_CHANNELS are reserved — owner-created channels with these
slugs are rejected by the schema validator so the override flow is the only
way to customise them. This protects the historical sales rows tagged with
those slugs from accidentally being detached.

LEGACY entries (`legacy: True`) stay in the dataset so historical Sale rows
(254+ just_eat rows as of 2026-05) still render with a sensible label, but
they're not surfaced in the "add a new sale" dropdown — the frontend filters
them out.
"""
from __future__ import annotations

from typing import Iterable


# Channel slugs the owner is NOT allowed to claim — reserved for system /
# legacy. Same-slug customs are blocked by the schema; this list is the
# allow-list for "is this slug already a system slug?" lookups.
RESERVED_SLUGS: frozenset[str] = frozenset(
    {"dine_in", "takeaway", "web", "phone", "catering", "other"}
)


SYSTEM_CHANNELS: dict[str, dict] = {
    "dine_in":  {"label": "Restaurant",       "emoji": "\U0001F37D", "color": "emerald-500", "sort": 0},
    "takeaway": {"label": "Take-Away Pickup", "emoji": "\U0001F961", "color": "orange-500",  "sort": 10},
    "wolt":     {"label": "Wolt",             "emoji": "\U0001F6F5", "color": "cyan-500",    "sort": 20},
    "uber_eats":{"label": "Uber Eats",        "emoji": "\U0001F6F5", "color": "stone-900",   "sort": 30},
    "foodora":  {"label": "Foodora",          "emoji": "\U0001F6F5", "color": "pink-500",    "sort": 40},
    "phone":    {"label": "Phone Order",      "emoji": "\U0001F4DE", "color": "blue-500",    "sort": 50},
    "web":      {"label": "Web Pre-Paid",     "emoji": "\U0001F4BB", "color": "violet-500",  "sort": 60},
    "catering": {"label": "Catering",         "emoji": "\U0001F389", "color": "amber-500",   "sort": 70},
    "other":    {"label": "Other",            "emoji": "•",     "color": "gray-500",    "sort": 80},
    # Legacy — historical-only, NOT in dropdown for new entries.
    # Just Eat closed in Denmark in 2024; keeping the slug ensures the
    # 254+ historical sale rows tagged "just_eat" still render with a
    # sensible label. The legacy flag tells the frontend to grey it out.
    "just_eat": {"label": "Just Eat (closed)","emoji": "\U0001F6F5", "color": "stone-400",   "sort": 999, "legacy": True},
}


def system_channels_as_list() -> list[dict]:
    """Return the SYSTEM_CHANNELS catalogue as an ordered list, with each
    entry shaped like an OrderChannelConfigOut row.

    The shape MUST match the response model used by GET /channels so the
    frontend can merge user customs + system defaults without juggling two
    different shapes.
    """
    out: list[dict] = []
    for slug, meta in SYSTEM_CHANNELS.items():
        out.append({
            "id": None,
            "slug": slug,
            "label": meta["label"],
            "emoji": meta.get("emoji"),
            "color": meta.get("color"),
            "sort_order": meta.get("sort", 0),
            "is_archived": False,
            "is_system": True,
            "is_legacy": bool(meta.get("legacy", False)),
            "created_at": None,
            "updated_at": None,
        })
    out.sort(key=lambda r: (r["sort_order"], r["slug"]))
    return out


def merge_user_channels(user_rows: Iterable) -> list[dict]:
    """Merge user-created OrderChannelConfig rows on top of SYSTEM_CHANNELS.

    Rules:
      • Same slug as a system entry  → user row overrides label/emoji/color.
        The system row's `sort_order` is kept unless the user row sets one.
        is_system stays True so the UI doesn't offer "delete" — only edit.
      • New slug                     → fresh user row, is_system=False.
      • is_archived rows             → still included so the frontend can
        decide whether to render them (settings page yes, sale dropdown no).

    Caller passes ORM rows; this function reads attributes directly so it
    works with either the SQLAlchemy model or a dict shape from a join.
    """
    by_slug: dict[str, dict] = {}
    for row in system_channels_as_list():
        by_slug[row["slug"]] = row

    for r in user_rows:
        slug = getattr(r, "slug", None)
        if not slug:
            continue
        existing = by_slug.get(slug)
        merged = {
            "id": getattr(r, "id", None),
            "slug": slug,
            "label": getattr(r, "label", None) or (existing or {}).get("label") or slug.replace("_", " ").title(),
            "emoji": getattr(r, "emoji", None) or (existing or {}).get("emoji"),
            "color": getattr(r, "color", None) or (existing or {}).get("color") or "gray-500",
            "sort_order": (
                getattr(r, "sort_order", None)
                if getattr(r, "sort_order", None) not in (None, 0)
                else (existing or {}).get("sort_order", 0)
            ) or 0,
            "is_archived": bool(getattr(r, "is_archived", False)),
            "is_system": existing is not None,
            "is_legacy": bool((existing or {}).get("is_legacy", False)),
            "created_at": getattr(r, "created_at", None),
            "updated_at": getattr(r, "updated_at", None),
        }
        by_slug[slug] = merged

    merged_list = list(by_slug.values())
    merged_list.sort(key=lambda x: (x["sort_order"], x["slug"]))
    return merged_list


def channel_label_map(user_rows: Iterable) -> dict[str, str]:
    """Helper for property_report.py and other label-rendering callers.

    Returns a flat slug → label dict, with archived rows still included
    (so historical sales render their channel label even after archive).
    """
    return {row["slug"]: row["label"] for row in merge_user_channels(user_rows)}
