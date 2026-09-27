"""Which language a notification to the OWNER is written in.

The app's language is picked per device, and the app saves it to
users.ui_language whenever it differs from what the account has, so the
server can write a push in the language the owner actually reads the app in.

Notifications exist in Danish and English: Danish for "da", English for every
other app language (the app itself falls back to English for those).

Until the app has saved a choice (NULL) the old guess stands — a DKK account
reads Danish — so nobody's notifications switch language before they have
opened the app once.
"""

from __future__ import annotations


def owner_lang(user) -> str:
    """"da" or "en" for notifications addressed to this account holder."""
    chosen = (getattr(user, "ui_language", None) or "").strip().lower()
    if chosen:
        return "da" if chosen == "da" else "en"
    currency = (getattr(user, "currency", None) or "DKK").upper()
    return "da" if currency == "DKK" else "en"
