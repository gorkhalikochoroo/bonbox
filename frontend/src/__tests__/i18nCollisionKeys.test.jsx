/**
 * Two i18n keys that were each doing two jobs.
 *
 * A duplicate key in a translation object is legal JS — the last one wins — so
 * a key defined twice for two DIFFERENT purposes resolves to one string and
 * silently shows the wrong text at one of its call sites. Two shipped that way:
 *
 *   rsvpCancelConfirm* : the OWNER cancelling someone else's table and the GUEST
 *     cancelling their own share the dialog keys. The guest copy won, so the
 *     owner was asked to confirm with "The table is released immediately … You're
 *     welcome to book again" — second-person copy about the reader's own booking,
 *     shown to the person cancelling someone else's, naming nobody.
 *
 *   rsvpClosed : the one-word label under a disabled day chip, and the <h1> of
 *     the whole public booking page when a venue takes no reservations. The word
 *     won, so an un-named venue's booking link opened on a page titled "closed".
 *
 * The placeholder assertions are the sharp ones. t() only substitutes when a vars
 * object is passed AND the string contains "{" (useLanguage.jsx). So:
 *   • the GUEST body must carry NO placeholder — its call site passes no vars, and
 *     a "{name}" there would render literally to a member of the public;
 *   • the OWNER body MUST carry {name} — its call site passes it, and a string
 *     without the brace silently discards the guest's name from the dialog.
 * Those two pull in opposite directions, which is exactly why one key cannot
 * serve both.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

/** Renders one t() call so assertions read the resolved string. */
function Probe({ tkey, vars }) {
  const { t } = useLanguage();
  return <span data-testid="out">{vars ? t(tkey, undefined, vars) : t(tkey)}</span>;
}

const resolve = (tkey, { lang = "en", vars } = {}) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} vars={vars} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

describe("rsvpClosed — chip word vs page headline", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ["en", "Not taking reservations"],
    ["da", "Tager ikke imod reservationer"],
  ])("%s: rsvpClosed is the ClosedScreen headline, not a word", (lang, expected) => {
    expect(resolve("rsvpClosed", { lang })).toBe(expected);
  });

  it.each([
    ["en", "closed"],
    ["da", "lukket"],
  ])("%s: rsvpDayClosed is the short day-chip label", (lang, expected) => {
    expect(resolve("rsvpDayClosed", { lang })).toBe(expected);
  });

  it.each(["en", "da"])("%s: the two are not the same string", (lang) => {
    expect(resolve("rsvpClosed", { lang })).not.toBe(resolve("rsvpDayClosed", { lang }));
  });

  it.each(["en", "da"])("%s: the headline stays parallel to its named twin", (lang) => {
    // rsvpClosedNamed is "{name} isn't taking reservations" — the un-named
    // branch has to read like a headline, which is what regressed.
    const named = resolve("rsvpClosedNamed", { lang });
    const plain = resolve("rsvpClosed", { lang });
    expect(named.length).toBeGreaterThan(plain.length);
    expect(plain.split(" ").length).toBeGreaterThan(1);
  });
});

describe("reservation cancel — owner dialog vs guest dialog", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: the GUEST body carries no placeholder", (lang) => {
    // Its call site passes no vars, so any "{…}" would reach a member of the
    // public verbatim.
    expect(resolve("rsvpCancelConfirmBody", { lang })).not.toMatch(/\{/);
  });

  it.each(["en", "da"])("%s: the OWNER body names the guest", (lang) => {
    const raw = resolve("rsvpOwnerCancelConfirmBody", { lang });
    expect(raw).toMatch(/\{name\}/);
  });

  it.each(["en", "da"])("%s: the owner body actually interpolates", (lang) => {
    const out = resolve("rsvpOwnerCancelConfirmBody", { lang, vars: { name: "Mette" } });
    expect(out).toContain("Mette");
    expect(out).not.toMatch(/\{name\}/);
  });

  it.each(["en", "da"])("%s: owner and guest bodies are different messages", (lang) => {
    expect(resolve("rsvpOwnerCancelConfirmBody", { lang })).not.toBe(
      resolve("rsvpCancelConfirmBody", { lang }),
    );
  });

  it.each(["en", "da"])("%s: the owner dialog has its own title and confirm label", (lang) => {
    expect(resolve("rsvpOwnerCancelConfirmTitle", { lang })).toBeTruthy();
    expect(resolve("rsvpOwnerCancelConfirmYes", { lang })).toBeTruthy();
    expect(resolve("rsvpOwnerCancelConfirmTitle", { lang })).not.toBe("rsvpOwnerCancelConfirmTitle");
  });
});

describe("useConfirm default labels exist in Danish", () => {
  beforeEach(() => localStorage.clear());

  it.each(["dlgConfirmTitle", "dlgCancel", "dlgConfirm", "dlgDelete"])(
    "%s is translated, not falling back to English",
    (key) => {
      // These four lived only in `en`, and t() falls back to en — so every
      // confirm dialog that passed no explicit labels asked a Danish owner
      // "Are you sure?" with "Cancel" / "Delete" buttons.
      const en = resolve(key, { lang: "en" });
      const da = resolve(key, { lang: "da" });
      expect(da).toBeTruthy();
      expect(da).not.toBe(key);
      expect(da).not.toBe(en);
    },
  );
});
