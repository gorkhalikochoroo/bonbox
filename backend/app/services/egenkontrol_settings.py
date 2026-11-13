"""
Egenkontrol R1b — the venue's settings: the findsmiley.dk link (Decision 7)
and the retail opt-in.

  • findsmiley_url — the owner pastes THEIR OWN findsmiley.dk link once;
    BonBox shows it as a plain text link in the Kontrolmappe (owner and
    kitchen) and prints it in the PDF. Never the smiley image, never the FVST
    logo, never a fetched result. https://www.findsmiley.dk/… and
    https://findsmiley.dk/… are accepted; both are kept in the one www form
    (egenkontrol_rules.validate_findsmiley_url).
  • opted_in — a grocery, veggie_shop or kiosk switches egenkontrol on with
    one tap; it can be switched off again only while no (non-archived) check
    exists.
  • findsmiley_on_booking stays FALSE and is not exposed in R1b (the public
    booking page is its own release).
"""

from sqlalchemy.orm import Session

from app.models.food_check import FoodCheck, FoodCheckSettings
from app.services import audit_service
from app.services import egenkontrol_rules as R
from app.services import egenkontrol_service as S


def settings_out(db: Session, owner) -> dict:
    st = S.get_settings(db, owner)
    opted = bool(st is not None and st.opted_in)
    return {
        "findsmiley_url": st.findsmiley_url if st is not None else None,
        "opted_in": opted,
        "opt_in_offered": S.opt_in_offered(getattr(owner, "business_type", None), opted),
    }


def update_settings(db: Session, owner, payload, *, actor_user_id) -> dict:
    """PARTIAL: only the fields in the body change. Creates the settings row
    when missing (setup_done_at stays NULL)."""
    sent = payload.model_fields_set
    changes = {}
    if "findsmiley_url" in sent:
        try:
            changes["findsmiley_url"] = R.validate_findsmiley_url(payload.findsmiley_url)
        except R.RuleError as e:
            raise S.rule_http(e)
    if "opted_in" in sent and payload.opted_in is not None:
        want = bool(payload.opted_in)
        if want and (getattr(owner, "business_type", None) or "") not in R.RETAIL_OPT_IN_TYPES:
            raise S.rule_http(R.RuleError("opt_in_not_offered"))
        if not want:
            live = (
                db.query(FoodCheck.id)
                .filter(FoodCheck.user_id == owner.id, FoodCheck.archived_at.is_(None))
                .first()
            )
            if live is not None:
                raise S.conflict("has_checks")
        changes["opted_in"] = want

    st = S.get_settings(db, owner)
    now = S.now_utc()
    before = {
        "findsmiley_url": st.findsmiley_url if st is not None else None,
        "opted_in": bool(st is not None and st.opted_in),
    }
    if st is None:
        st = FoodCheckSettings(user_id=owner.id, created_at=now)
        db.add(st)
    real = {k: v for k, v in changes.items() if before.get(k) != v}
    for k, v in changes.items():
        setattr(st, k, v)
    if real:
        st.updated_at = now
        db.flush()
        audit_service.record(
            db, owner, "egenkontrol.settings_changed", "food_check_settings", None,
            before={k: before[k] for k in real}, after=real, actor_id=actor_user_id,
        )
    db.commit()
    return settings_out(db, owner)
