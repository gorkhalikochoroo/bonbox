"""The two mails a new owner gets at signup — the e-mail verification code and
the welcome — in Danish or English.

They were English only, so a Danish café owner who signed up on a Danish
phone, in a Danish app, got "Your verification code is …" as the very first
thing BonBox ever sent them.

Language, strongest signal first (`signup_mail_lang`):
  1. the app's language at signup (the register form sends `ui_language`,
     which the app itself picked from the owner's choice → browser locale →
     currency), "da" → Danish, any other app language → English;
  2. the browser's Accept-Language when the client did not say (an older
     app, the legacy Google/Apple endpoints): a first tag of "da" → Danish,
     any other first tag → English;
  3. the account currency: DKK → Danish, else English (owner_lang's rule).

Each mail is built ONCE per language as (subject, html, text): the text/plain
part is written from the same copy, so the two parts can never say
different things. Every value put into the HTML is escaped.
"""
from __future__ import annotations

import html as _html

_BRAND_ICON = (
    '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" '
    'xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" '
    'rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" '
    'stroke="white" stroke-width="1.5" stroke-linecap="round"/>'
    '<path d="M4 20h20" stroke="{accent}" stroke-width="2"/></svg>'
)

DASHBOARD_URL = "https://bonbox.dk/dashboard"
CONTACT_URL = "https://bonbox.dk/contact"


def _norm_lang(code) -> str | None:
    c = str(code or "").strip().lower()
    if not c:
        return None
    return "da" if c == "da" or c.startswith("da-") or c.startswith("da_") else "en"


def _first_accept_language(header) -> str | None:
    """The first language tag of an Accept-Language header ("da-DK,da;q=0.9,
    en;q=0.8" → "da-dk"), or None. A "*" is no answer."""
    for part in str(header or "").split(","):
        tag = part.split(";")[0].strip().lower()
        if tag and tag != "*":
            return tag
    return None


def signup_mail_lang(ui_language=None, accept_language=None, currency=None) -> str:
    """"da" or "en" for a signup mail — see the module docstring."""
    chosen = _norm_lang(ui_language)
    if chosen:
        return chosen
    browser = _norm_lang(_first_accept_language(accept_language))
    if browser:
        return browser
    return "da" if (currency or "DKK").strip().upper() == "DKK" else "en"


def mail_lang_for_user(user, request=None) -> str:
    """The same rule for an existing account: its saved app language, else the
    request's browser language, else its currency."""
    accept = None
    try:
        accept = request.headers.get("accept-language") if request is not None else None
    except Exception:  # noqa: BLE001 — a header read never decides a failure
        accept = None
    return signup_mail_lang(
        getattr(user, "ui_language", None), accept, getattr(user, "currency", None),
    )


# ── Verification code ──────────────────────────────────────────────────

_VERIFY = {
    "da": {
        "subject": "BonBox — din bekræftelseskode er {code}",
        "title": "Bekræft din e-mail",
        "lede": "Skriv koden i BonBox for at bekræfte din e-mail.",
        "expires": "Koden udløber om 30 minutter.",
        "ignore": "Har du ikke oprettet en konto hos BonBox, kan du se bort fra denne mail.",
        "tagline": "styr på dagens tal",
    },
    "en": {
        "subject": "BonBox — Your verification code is {code}",
        "title": "Verify your email",
        "lede": "Enter this code in the app to verify your email",
        "expires": "This code expires in 30 minutes.",
        "ignore": "If you didn't create an account, ignore this email.",
        "tagline": "Your smart business companion",
    },
}


def verification_mail(code, lang: str = "en") -> tuple[str, str, str]:
    """(subject, html, text) for the 6-digit e-mail verification code."""
    c = _VERIFY["da" if lang == "da" else "en"]
    code_s = str(code or "")
    e = _html.escape
    subject = c["subject"].format(code=code_s)
    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:0;background:#0f172a">
  <div style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:rgba(255,255,255,0.1);border-radius:14px;padding:12px 14px;border:1px solid rgba(255,255,255,0.1)">
        {_BRAND_ICON.format(accent="#22c55e")}
      </div>
      <h1 style="font-size:22px;color:#ffffff;margin:12px 0 4px">{e(c["title"])}</h1>
      <p style="color:#94a3b8;font-size:14px;margin:0">{e(c["lede"])}</p>
    </div>
    <div style="text-align:center;margin:28px 0">
      <span style="display:inline-block;font-size:36px;font-weight:700;letter-spacing:10px;color:#22c55e;background:rgba(34,197,94,0.1);padding:18px 36px;border-radius:16px;border:2px dashed rgba(34,197,94,0.4)">{e(code_s)}</span>
    </div>
    <p style="font-size:13px;color:#64748b;text-align:center;margin-top:24px">
      {e(c["expires"])}<br>{e(c["ignore"])}
    </p>
    <div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:28px;padding-top:16px;text-align:center">
      <p style="font-size:12px;color:#475569;margin:0">
        <span style="color:#94a3b8">Bon</span><span style="color:#22c55e">Box</span> — {e(c["tagline"])}
      </p>
    </div>
  </div>
</div>"""
    text = (
        f"{c['title']}\n\n"
        f"{c['lede']}\n\n"
        f"    {code_s}\n\n"
        f"{c['expires']}\n"
        f"{c['ignore']}\n\n"
        f"BonBox — {c['tagline']}\n"
    )
    return subject, html, text


# ── Welcome ────────────────────────────────────────────────────────────
# The Danish mail names the first fifteen minutes — the day's kasserapport,
# the staff invite, the revisor — and only what BonBox does today: nothing
# goes to a revisor until the owner asks for it (the revisor's lock mail is
# an explicit choice, off for a new address).

_WELCOME = {
    "da": {
        "subject": "Velkommen til BonBox",
        "title": "Velkommen til BonBox",
        "sub": "Din konto er klar",
        "hello_name": "Hej {name},",
        "hello": "Hej,",
        "intro": "Sådan kommer du i gang:",
        "items": [
            "Lav din første kasserapport — tag et billede af Z-bonnen, eller tast dagens totaler.",
            "Inviter dit personale — de åbner et link eller skriver en kode og ser deres vagter på telefonen.",
            "Tilføj din revisor, når du er klar — BonBox sender intet til revisoren, før du selv beder om det.",
        ],
        "cta": "Åbn BonBox →",
        "questions": "Spørgsmål? Skriv til os på",
    },
    "en": {
        "subject": "Welcome to BonBox!",
        "title": "Welcome to BonBox!",
        "sub": "Your smart business companion",
        "hello_name": "Hi {name},",
        "hello": "Hi,",
        "intro": "Your account is ready. Here's what you can do:",
        "items": [
            "Log sales & expenses in seconds",
            "Track inventory & waste",
            "Get smart staffing suggestions",
            "Generate PDF reports",
            "Snap receipts with your camera",
        ],
        "cta": "Open BonBox →",
        "questions": "Questions? Write to us at",
    },
}


def welcome_mail(name, lang: str = "en") -> tuple[str, str, str]:
    """(subject, html, text) for the welcome mail. `name` is the business
    name the owner typed at signup — escaped, and left out when blank."""
    c = _WELCOME["da" if lang == "da" else "en"]
    e = _html.escape
    clean = " ".join(str(name or "").split())
    if clean.casefold() == "there":  # the old callers' placeholder
        clean = ""
    hello_html = (e(c["hello_name"]).replace("{name}", f"<strong>{e(clean)}</strong>")
                  if clean else e(c["hello"]))
    hello_text = c["hello_name"].format(name=clean) if clean else c["hello"]
    items_html = "\n".join(f"    <li>{e(item)}</li>" for item in c["items"])
    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      {_BRAND_ICON.format(accent="#FCD34D")}
    </div>
    <h1 style="font-size:22px;color:#1e293b;margin:12px 0 4px">{e(c["title"])}</h1>
    <p style="color:#64748b;font-size:14px;margin:0">{e(c["sub"])}</p>
  </div>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    {hello_html}
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    {e(c["intro"])}
  </p>
  <ul style="font-size:14px;color:#475569;line-height:1.8;padding-left:20px">
{items_html}
  </ul>
  <div style="text-align:center;margin:28px 0">
    <a href="{DASHBOARD_URL}" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">{e(c["cta"])}</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
    {e(c["questions"])} <a href="{CONTACT_URL}" style="color:#16a34a;text-decoration:none">bonbox.dk/contact</a>
  </p>
</div>"""
    text = "\n".join([
        c["title"],
        "",
        hello_text,
        "",
        c["intro"],
        *[f"- {item}" for item in c["items"]],
        "",
        f"{c['cta'].rstrip(' →')}: {DASHBOARD_URL}",
        "",
        f"{c['questions']} {CONTACT_URL}",
        "",
    ])
    return c["subject"], html, text
