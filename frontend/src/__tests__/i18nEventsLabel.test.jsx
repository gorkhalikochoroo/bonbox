/**
 * One destination, one Danish name.
 *
 * THE BUG (shipped, found by probing the live deploy):
 *   The Events pillar is reached through two chrome surfaces that read two
 *   DIFFERENT catalogue keys — navManifest points the nav row and the ⌘K result
 *   at `events`, and the pillar card at `pillarLabelEvents`. In Danish those
 *   resolved to "Events" and "Arrangementer", so ONE account showed two names
 *   for one page depending on which surface the owner looked at.
 *
 * THE RESOLUTION, and why it went this way rather than the other:
 *   "arrangement" is the declared DK terminology lock for this domain (see the
 *   DoorScan block in useLanguage.jsx: '"arrangement" / "billet" / "scanner"
 *   stay close to the Danish phrasing'). It is honoured by the whole public
 *   booking flow and the door-scan copy — the words the owner's own GUESTS
 *   read — plus the pillar gate. `events`/`eventsTitle` were the holdouts.
 *
 *   The comment those two keys carried defended English on interview evidence,
 *   but what that evidence rejected was "begivenhed" as bureaucratic — not
 *   "arrangement", which is the ordinary spoken Danish noun the lock had
 *   already chosen. So this is not a reversal of the founder's call.
 *
 * WHY A TEST AND NOT JUST A FIX:
 *   Nothing structural stops the two keys drifting apart again — they live
 *   ~4000 lines apart in the catalogue and no call site sees both. This pins
 *   the INVARIANT (the surfaces agree) rather than the spelling, and it reads
 *   the key names out of navManifest so it keeps testing the real wiring even
 *   if the nav row is later repointed at a different key.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";
import { NAV_MANIFEST, PILLAR_DISPLAY_BY_ID } from "../config/navManifest";

/** Renders one t() call so assertions read the resolved string. */
function Probe({ tkey }) {
  const { t } = useLanguage();
  return <span data-testid="out">{t(tkey)}</span>;
}

const resolve = (tkey, lang) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

/* The two key names, read from the manifest rather than hardcoded, so this
   follows a future repoint instead of quietly testing a dead key. */
const navRow = NAV_MANIFEST.find((i) => i.to === "/events");
const pillar = PILLAR_DISPLAY_BY_ID.events;

describe("Events — the nav row, ⌘K and the pillar card must agree", () => {
  beforeEach(() => localStorage.clear());

  it("the manifest really does route these surfaces through two keys", () => {
    // If this ever collapses to one key the drift becomes impossible and the
    // rest of this file is redundant — that would be a fine reason to delete
    // it, but it should be a DECISION, not a silent change.
    expect(navRow?.labelKey).toBeTruthy();
    expect(pillar?.labelKey).toBeTruthy();
    expect(navRow.labelKey).not.toBe(pillar.labelKey);
  });

  it.each(["da", "en"])("%s: nav row and pillar card name the page identically", (lang) => {
    expect(resolve(navRow.labelKey, lang)).toBe(resolve(pillar.labelKey, lang));
  });

  it.each(["da", "en"])("%s: the page H1 matches the nav row that leads to it", (lang) => {
    // eventsTitle is the EventsPage <h1>. A nav row that says one word and
    // lands on a heading that says another is the same defect, one click later.
    expect(resolve("eventsTitle", lang)).toBe(resolve(navRow.labelKey, lang));
  });

  it("Danish uses the locked Danish noun, not the English loanword", () => {
    // Pins the DIRECTION of the fix. Without this, a future edit could make the
    // surfaces agree by flipping the pillar card to "Events" — consistent, but
    // out of step with the booking and door-scan copy the same owner reads.
    expect(resolve(navRow.labelKey, "da")).toBe("Arrangementer");
    expect(resolve(pillar.labelKey, "da")).toBe("Arrangementer");
  });

  it("English is untouched", () => {
    expect(resolve(navRow.labelKey, "en")).toBe("Events");
  });
});
