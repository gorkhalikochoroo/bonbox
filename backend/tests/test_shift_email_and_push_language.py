"""The one automatic message Danish staff receive must be in Danish — and the
push that carries it must still be deliverable.

THE DEFECT. build_shift_email_html took no `lang` and had no Danish variant.
On the FREE plan this email is the ONLY thing that fires when an owner
publishes a schedule: no staff app, no SMS. So the single automatic message
Danish kitchen and floor staff ever got from BonBox was entirely English —
"Your schedule has been updated", "CANCELLED", "View Schedule" — about when
they are expected at work.

THE TRAP THAT CAME WITH THE FIX, which is why the push half is tested here at
all. Making the week label Danish changes `week_label`, and `week_label` is
what builds the web-push / APNs tag:

    safe_label = week_label.replace(" ", "-").lower()
    tag = f"bonbox-schedule-{user_id}-{safe_label}"

A collapse-id must be ASCII. "Uge 39 — ændret" is not, and a rejected tag does
not raise where anyone sees it — the notification simply never arrives, on the
channel whose entire job is telling staff they are working. Localising the
email without sanitising the tag would have traded a readable-but-English
message for no message at all.

Note `ch.isalnum()` is true for every Unicode letter, so "Café" survives it.
The filter has to require isascii() explicitly — that is asserted below,
because it is exactly the kind of thing that looks fixed and is not.
"""
from __future__ import annotations

from datetime import date

from app.services.notification_service import build_shift_email_html, ShiftChange


def _change():
    return ShiftChange(
        date=date(2026, 9, 25), change_type="removed",
        old_start="17:00", old_end="23:00", new_start=None, new_end=None,
    )


def _html(lang):
    return build_shift_email_html(
        staff_name="Mette Hansen", changes=[_change()],
        portal_url="https://bonbox.dk/s/tok", restaurant_name="Café Manoj",
        week_label="Uge 39", lang=lang,
    )


class TestTheEmailSpeaksTheOwnersLanguage:
    def test_danish_is_actually_danish(self):
        h = _html("da")
        for word in ("Hej", "Din vagtplan er opdateret", "AFLYST", "Se vagtplan", "Dag", "Vagt"):
            assert word in h, f"missing Danish copy: {word!r}"

    def test_danish_carries_no_leftover_english(self):
        h = _html("da")
        for stray in ("CANCELLED", "View Schedule", "Your schedule has been updated",
                      "Questions? Ask your manager"):
            assert stray not in h, f"English leaked into the Danish email: {stray!r}"

    def test_english_is_unchanged(self):
        h = _html("en")
        assert "CANCELLED" in h and "View Schedule" in h
        assert "AFLYST" not in h

    def test_an_unknown_language_falls_back_to_english_not_a_crash(self):
        """This email fires from a background task. A KeyError here would be
        swallowed and the staffer would simply never hear."""
        for lang in ("fr", "", None, "DA"):
            h = build_shift_email_html(
                staff_name="Mette", changes=[_change()], portal_url=None,
                restaurant_name="Café", week_label="Uge 39", lang=lang,
            )
            assert "<html>" in h and len(h) > 500

    def test_case_is_not_load_bearing(self):
        assert "AFLYST" in build_shift_email_html(
            staff_name="Mette", changes=[_change()], portal_url=None,
            restaurant_name="Café", week_label="Uge 39", lang="DA",
        )


class TestThePushTagSurvivesDanish:
    """Reimplements the tag rule and pins its properties. If the source drifts
    from this, the push stops being delivered and nothing else would say so."""

    @staticmethod
    def _tag(week_label, user_id="u1"):
        base = (week_label or "").replace(" ", "-").lower()
        for src, dst in (("æ", "ae"), ("ø", "oe"), ("å", "aa")):
            base = base.replace(src, dst)
        safe = "".join(
            ch for ch in base if ch.isascii() and (ch.isalnum() or ch == "-")
        )[:48] or "week"
        return f"bonbox-schedule-{user_id}-{safe}"

    def test_a_danish_label_yields_an_ascii_tag(self):
        for label in ("Uge 39", "Uge 39 — ændret", "Uge 39 på Café Ø", "Ærø Bryghus uge 3"):
            tag = self._tag(label)
            assert tag.isascii(), f"non-ASCII collapse-id for {label!r}: {tag!r}"

    def test_accented_latin_is_stripped_not_kept(self):
        """ch.isalnum() alone would keep the é in Café and leave the tag
        non-ASCII — the bug hiding inside the fix."""
        assert "é" not in self._tag("Uge 39 på Café Ø")

    def test_two_different_weeks_do_not_collapse_onto_one_tag(self):
        assert self._tag("Uge 39") != self._tag("Uge 40")

    def test_a_changed_week_does_not_collapse_onto_the_plain_week(self):
        assert self._tag("Uge 39") != self._tag("Uge 39 — ændret")

    def test_an_empty_label_still_produces_a_usable_tag(self):
        assert self._tag("").endswith("-week")

    def test_the_tag_stays_short(self):
        assert len(self._tag("Uge 39 " + "x" * 200)) < 80


class TestTheSourceStillMatchesThisRule:
    def test_the_ascii_guard_is_present_in_the_service(self):
        """Pins the isascii() requirement in the real file — the reimplemented
        rule above cannot catch the source losing it."""
        import inspect
        import app.services.notification_service as ns
        src = inspect.getsource(ns)
        assert "ch.isascii()" in src, (
            "the push tag no longer requires ASCII — a Danish or accented week "
            "label will silently stop being delivered"
        )
