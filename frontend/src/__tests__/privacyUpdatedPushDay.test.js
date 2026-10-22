/**
 * PUSH-DAY GATE (Landing v6 + Frankfurt release, 22 Oct 2026).
 *
 * /privacy changes in this release (the main Supabase row moves to
 * Frankfurt; the old project's fallback copy gets its own row while it
 * exists), so its "Senest opdateret" / "Last updated" date — PRIVACY_UPDATED
 * in src/legal/terms.js, which dates /cookies too — must be the Copenhagen
 * day the frontend bundle is verified live on www.bonbox.dk.
 *
 * Until the release packet sets that day, PRIVACY_UPDATED holds
 * PRIVACY_PUSH_DAY_PLACEHOLDER and THIS TEST FAILS ON PURPOSE. The fix is
 * one line in terms.js: `export const PRIVACY_UPDATED = "2026-10-2x";`
 * (the push day). If the push slips past Copenhagen midnight, move it again
 * before the push. Never fix this test by changing it.
 */
import { describe, expect, it } from "vitest";
import { PRIVACY_PUSH_DAY_PLACEHOLDER, PRIVACY_UPDATED, TERMS_VERSION } from "../legal/terms";

describe("PRIVACY_UPDATED is the push day, not the placeholder", () => {
  it("has been set by the release packet", () => {
    expect(
      PRIVACY_UPDATED,
      "PRIVACY_UPDATED is still the push-day placeholder: set it in src/legal/terms.js to the Copenhagen day this bundle goes live",
    ).not.toBe(PRIVACY_PUSH_DAY_PLACEHOLDER);
  });

  it("is a real day, no earlier than the day this release was built (22 Oct 2026) or the Terms", () => {
    expect(PRIVACY_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRIVACY_UPDATED >= "2026-10-22").toBe(true);
    expect(PRIVACY_UPDATED >= TERMS_VERSION).toBe(true);
  });

  it("the placeholder itself is a valid far-future day (so the pages render while it is in place)", () => {
    expect(PRIVACY_PUSH_DAY_PLACEHOLDER).toBe("2099-12-31");
  });
});
