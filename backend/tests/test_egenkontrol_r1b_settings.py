"""Egenkontrol R1b — settings: the findsmiley.dk link (Decision 7) and the
retail opt-in (grocery, veggie_shop, kiosk), plus the used-surface signal
that keeps Egenkontrol in the nav of an owner who uses it.
"""
import pytest

from app.models.food_check import FoodCheckSettings
from app.services.auth import hash_password, mint_device_pin_proof
from tests._ek_support import env  # noqa: F401 — fixture

GOOD = "https://www.findsmiley.dk/769342"
BARE = "https://findsmiley.dk/769342"           # accepted since 13 Nov 2026, stored as GOOD
BAD = [
    "http://www.findsmiley.dk/769342",
    "http://findsmiley.dk/769342",
    "https://findsmiley.dk/",
    "https://findsmiley.dk.evil.com/769342",
    "https://findsmiley.dk@evil.com/",
    "https://findsmiley.dk:443/769342",
    "https://findsmiley.dk/76 9342",
    "https://findsmiley.dk/76\\9342",
    "https://findsmiley.dk/" + "9" * 230,                 # 252, so 256 once stored with www.
    "HTTPS://FINDSMILEY.DK/769342",
    "//findsmiley.dk/769342",
    "findsmiley.dk/769342",
    "https://evil.com/https://findsmiley.dk/769342",
    "data:text/html,https://findsmiley.dk/769342",
    "javascript:alert('https://findsmiley.dk/769342')",
    "https://www.findsmiley.dk.evil.com/769342",
    "https://www.findsmiley.dk@evil.com/",
    "https://www.findsmiley.dk:443/769342",
    "javascript:alert(1)",
    "https://www.findsmiley.dk/",
    "https://www.findsmiley.dk/76 9342",
    "https://www.findsmiley.dk/76\n9342",
    "https://www.findsmiley.dk/76\\9342",
    "https://www.findsmiley.dk/" + "9" * 230,             # 256 characters
    "HTTPS://WWW.FINDSMILEY.DK/769342",
]


def _put(env, o, headers=None, **body):
    return env.client.put("/api/egenkontrol/settings", json=body, headers=headers or env.h(o))


@pytest.mark.parametrize("url", BAD)
def test_findsmiley_refusals(env, url):
    o = env.owner()
    r = _put(env, o, findsmiley_url=url)
    assert r.status_code == 422 and r.json()["detail"] == {"code": "findsmiley_invalid"}, url


def test_findsmiley_without_www_is_accepted_and_stored_in_the_one_www_form(env):
    o = env.owner()
    r = _put(env, o, findsmiley_url=f"  {BARE} ")
    assert r.status_code == 200, r.text
    assert r.json()["findsmiley_url"] == GOOD
    env.db.expire_all()
    st = env.db.query(FoodCheckSettings).filter(FoodCheckSettings.user_id == o.id).one()
    assert st.findsmiley_url == GOOD
    env.setup(o)
    assert env.folder(o)["findsmiley_url"] == GOOD
    # the same link again, either way written, is no change
    assert _put(env, o, findsmiley_url=GOOD).json()["findsmiley_url"] == GOOD
    # the stored (www) form is bounded: 251 without www → 255 stored is fine
    long_ok = "https://findsmiley.dk/" + "9" * 229
    assert len(long_ok) == 251
    r = _put(env, o, findsmiley_url=long_ok)
    assert r.status_code == 200 and r.json()["findsmiley_url"] == "https://www.findsmiley.dk/" + "9" * 229
    assert len(r.json()["findsmiley_url"]) == 255


def test_the_rule_itself():
    from app.services import egenkontrol_rules as R
    assert R.validate_findsmiley_url(BARE) == GOOD
    assert R.validate_findsmiley_url(GOOD) == GOOD
    assert R.validate_findsmiley_url("https://findsmiley.dk/da-DK/Search?q=1") == \
        "https://www.findsmiley.dk/da-DK/Search?q=1"
    assert R.validate_findsmiley_url(None) is None and R.validate_findsmiley_url("  ") is None
    for bad in BAD:
        with pytest.raises(R.RuleError):
            R.validate_findsmiley_url(bad)


def test_findsmiley_ok_trimmed_cleared_and_shown(env):
    o = env.owner()
    assert len([b for b in BAD if b.startswith("https://www.findsmiley.dk/9")][0]) == 256
    assert len([b for b in BAD if b.startswith("https://findsmiley.dk/9")][0]) + 4 == 256
    r = _put(env, o, findsmiley_url=f"  {GOOD}  ")
    assert r.status_code == 200 and r.json()["findsmiley_url"] == GOOD
    s = env.client.get("/api/egenkontrol/settings", headers=env.h(o)).json()
    assert s == {"findsmiley_url": GOOD, "opted_in": False, "opt_in_offered": False}
    env.db.expire_all()
    st = env.db.query(FoodCheckSettings).filter(FoodCheckSettings.user_id == o.id).one()
    assert st.setup_done_at is None and st.findsmiley_on_booking is False
    env.setup(o)
    assert env.folder(o)["findsmiley_url"] == GOOD
    token = env.pair(o)
    assert env.client.get(f"/api/kitchen/{token}/folder").json()["findsmiley_url"] == GOOD
    # a partial PUT leaves the link alone
    assert _put(env, o).json()["findsmiley_url"] == GOOD
    assert _put(env, o, findsmiley_url=None).json()["findsmiley_url"] is None
    _put(env, o, findsmiley_url=GOOD)
    assert _put(env, o, findsmiley_url="   ").json()["findsmiley_url"] is None
    # findsmiley_on_booking is not exposed
    _put(env, o, findsmiley_on_booking=True)
    env.db.expire_all()
    assert env.db.query(FoodCheckSettings).filter(
        FoodCheckSettings.user_id == o.id).one().findsmiley_on_booking is False


def test_only_the_owner_writes_settings(env):
    o = env.owner()
    m = env.member(o, "manager")
    assert _put(env, o, headers=env.h(m), findsmiley_url=GOOD).status_code == 403
    assert env.client.get("/api/egenkontrol/settings", headers=env.h(m)).status_code == 200
    assert env.client.get("/api/egenkontrol/settings",
                          headers=env.h(env.member(o, "cashier"))).status_code == 403
    assert env.client.get("/api/egenkontrol/settings",
                          headers=env.h(env.accountant(o))).status_code == 403
    o.device_pin_hash = hash_password("4271")
    env.db.commit()
    env.db.refresh(o)
    locked = env.h(o, shared=True, nonce="n1")
    r = _put(env, o, headers=locked, findsmiley_url=GOOD)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_pin_required"
    proof = mint_device_pin_proof(str(o.id), o.device_pin_hash, "n1")
    assert _put(env, o, headers=env.h(o, shared=True, nonce="n1", proof=proof),
                findsmiley_url=GOOD).status_code == 200


def test_retail_opt_in(env):
    g = env.owner(business_type="grocery")
    st = env.client.get("/api/egenkontrol/status", headers=env.h(g)).json()
    assert st["relevant"] is False and st["opt_in_offered"] is True and st["opted_in"] is False
    assert env.client.get("/api/activation", headers=env.h(g)).json()["surfaces"]["egenkontrol"] is False
    r = _put(env, g, opted_in=True)
    assert r.status_code == 200 and r.json()["opted_in"] is True and r.json()["opt_in_offered"] is False
    st = env.client.get("/api/egenkontrol/status", headers=env.h(g)).json()
    assert st["relevant"] is True and st["opt_in_offered"] is False and st["opted_in"] is True
    assert env.client.get("/api/activation", headers=env.h(g)).json()["surfaces"]["egenkontrol"] is True
    env.setup(g, items=[{"template_key": "fridge", "name": "Køl"}])
    r = _put(env, g, opted_in=False)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "has_checks"
    for btype in ("salon", "restaurant", "clothing"):
        o = env.owner(business_type=btype)
        r = _put(env, o, opted_in=True)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "opt_in_not_offered", btype
    k = env.owner(business_type="kiosk")
    _put(env, k, opted_in=True)
    assert _put(env, k, opted_in=False).json()["opted_in"] is False      # no checks: allowed


def test_the_used_surface_signal(env):
    salon = env.owner(business_type="salon")
    assert env.client.get("/api/activation", headers=env.h(salon)).json()["surfaces"]["egenkontrol"] is False
    env.setup(salon, items=[{"template_key": "fridge", "name": "Køl"}])
    assert env.client.get("/api/activation", headers=env.h(salon)).json()["surfaces"]["egenkontrol"] is True
    shop = env.owner(business_type="clothing")
    assert env.client.get("/api/activation", headers=env.h(shop)).json()["surfaces"]["egenkontrol"] is False
    st = env.client.get("/api/egenkontrol/status", headers=env.h(salon)).json()
    assert st["relevant"] is False and st["opt_in_offered"] is False
