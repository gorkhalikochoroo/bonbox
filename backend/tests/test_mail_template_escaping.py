"""Every mail template escapes what people typed (security, 8 Oct).

The welcome mail (sent at /register to an address nobody has verified yet),
the admin signup notice, and the shift mail (sent to whatever staff address
the owner entered) put business_name / staff names raw into HTML under the
BonBox sender. They now go through revisor_mail.esc, the one mail escape.

Two layers:
  * behaviour — render each builder with markup in every typed field and
    assert no raw markup survives;
  * a static guard over every `*_email_html` builder in app/: a parameter may
    reach an f-string only through esc()/escape(), after being reassigned
    from one, or when it is listed below as a server-made value.
"""
import ast
import pathlib
import pytest

EVIL = '<img src=x onerror="alert(1)">'

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# Parameters that are never typed by a person: values the server makes.
# Each entry says why. Anything else must be escaped.
SERVER_MADE_PARAMS = {
    "code",        # _verification_email_html: 6 digits from secrets
    "magic_url",   # _magic_link_email_html: FRONTEND_URL + a urlsafe token
    "is_danish",   # a bool choosing the copy
    "lang",        # a language code choosing the copy dict
    "changes",     # only iterated; each field is escaped where it is used
    "dc", "currency", "has_scan", "scan_degraded", "audience", "tz",
    "correction",  # daily close: escaped per cell inside the builder
}
ESCAPERS = {"esc", "escape", "_esc"}


def _is_escape_call(node) -> bool:
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")
    return name in ESCAPERS


def _builders():
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, ast.FunctionDef) and fn.name.endswith("email_html"):
                yield path, fn


def _raw_param_interpolations(fn):
    params = {a.arg for a in fn.args.args + fn.args.kwonlyargs}
    escaped = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            v = node.value
            # x = esc(x)   /   x = esc(x) if x else x
            if _is_escape_call(v) or (isinstance(v, ast.IfExp) and _is_escape_call(v.body)):
                escaped.add(node.targets[0].id)
    suspects = params - escaped - SERVER_MADE_PARAMS
    bad = []
    for node in ast.walk(fn):
        if isinstance(node, ast.FormattedValue):
            if _is_escape_call(node.value):
                continue
            names = {n.id for n in ast.walk(node.value) if isinstance(n, ast.Name)}
            hit = names & suspects
            if hit:
                bad.append((node.lineno, sorted(hit)))
    return bad


def test_guard_finds_the_builders():
    names = {fn.name for _, fn in _builders()}
    assert {"_welcome_email_html", "_admin_signup_email_html",
            "build_shift_email_html", "_invite_email_html"} <= names, names


def test_no_email_html_builder_interpolates_a_typed_parameter_raw():
    offenders = []
    for path, fn in _builders():
        for lineno, names in _raw_param_interpolations(fn):
            offenders.append(f"{path.relative_to(APP.parent)}:{lineno} {fn.name} {names}")
    assert not offenders, "raw interpolation of typed fields:\n" + "\n".join(offenders)


def test_guard_catches_a_raw_interpolation():
    src = 'def x_email_html(name):\n    return f"<p>{name}</p>"\n'
    fn = ast.parse(src).body[0]
    assert _raw_param_interpolations(fn) == [(2, ["name"])]
    ok = 'def x_email_html(name):\n    name = esc(name)\n    return f"<p>{name}</p>"\n'
    assert _raw_param_interpolations(ast.parse(ok).body[0]) == []


def test_welcome_mail_escapes_the_business_name():
    from app.routers.auth import _welcome_email_html
    html = _welcome_email_html(EVIL)
    assert "<img" not in html and "&lt;img" in html


def test_admin_signup_mail_escapes_every_field():
    from app.routers.auth import _admin_signup_email_html
    html = _admin_signup_email_html(f"a{EVIL}@x.dk", EVIL, EVIL)
    assert "<img" not in html and html.count("&lt;img") == 3


@pytest.mark.parametrize("lang", ["en", "da"])
def test_shift_mail_escapes_names_and_times(lang):
    from app.services.notification_service import ShiftChange, build_shift_email_html
    change = ShiftChange(
        change_type="modified", date="2026-10-09",
        old_start="09:00", old_end="17:00", new_start=EVIL, new_end="18:00",
    )
    html = build_shift_email_html(
        staff_name=f"{EVIL} Hansen", changes=[change], portal_url='https://x.dk/s/"><b>',
        restaurant_name=EVIL, week_label="Uge 41", lang=lang,
    )
    assert "<img" not in html
    assert '"><b>' not in html
    assert "&lt;img" in html
