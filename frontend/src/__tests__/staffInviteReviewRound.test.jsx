/**
 * Review round on the "Dit team" invite flow (12 Oct 2026) — the pure parts:
 *   • one link request per person at a time (a double tap, or the invite sheet
 *     racing the Share sheet, used to be able to create two links);
 *   • "Sidst set" from the instant in the owner's zone, not from the first ten
 *     characters of a UTC string (a visit at 00:30 Copenhagen read as the
 *     previous day).
 * The page-mounted halves are in StaffSchedulePage.teamInvite.test.jsx.
 */
import { act, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onePerKey } from "../utils/staffInvite";
import { staffReachState } from "../utils/portalReach";
import { StaffReachStatus } from "../components/StaffInviteSheet";
import { LanguageProvider } from "../hooks/useLanguage";

const PREV_TZ = globalThis.process.env.TZ;
beforeAll(() => {
  globalThis.process.env.TZ = "Europe/Copenhagen";
});
beforeEach(() => {
  localStorage.setItem("lang", "da");
});
afterAll(() => {
  if (PREV_TZ === undefined) delete globalThis.process.env.TZ;
  else globalThis.process.env.TZ = PREV_TZ;
});

describe("onePerKey — one request per person at a time", () => {
  it("a second call while the first is in flight gets the SAME promise", async () => {
    const once = onePerKey();
    let calls = 0;
    let release;
    const start = () => { calls += 1; return new Promise((r) => { release = r; }); };
    const a = once("sofie", start);
    const b = once("sofie", start);
    expect(b).toBe(a);
    expect(calls).toBe(1);
    release("tokA");
    await expect(a).resolves.toBe("tokA");
    await expect(b).resolves.toBe("tokA");
  });

  it("different people do not wait on each other", () => {
    const once = onePerKey();
    let calls = 0;
    const start = () => { calls += 1; return new Promise(() => {}); };
    once("sofie", start);
    once("mads", start);
    expect(calls).toBe(2);
  });

  it("asks again once the first answer is in — and after a failure", async () => {
    const once = onePerKey();
    let calls = 0;
    await once("sofie", async () => { calls += 1; return 1; });
    await once("sofie", async () => { calls += 1; return 2; });
    await expect(once("sofie", async () => { calls += 1; throw new Error("503"); })).rejects.toThrow("503");
    await once("sofie", async () => { calls += 1; return 4; });
    expect(calls).toBe(4);
  });

  it("a synchronous throw is a rejected promise, not a crash", async () => {
    const once = onePerKey();
    await expect(once("x", () => { throw new Error("sync"); })).rejects.toThrow("sync");
  });
});

describe("'Sidst set' is the day in Copenhagen, not the UTC string's date", () => {
  // 12 Oct 2026, 14:00 in Copenhagen (CEST, UTC+2).
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

  it("22:30 UTC on 4 Oct is 00:30 on 5 Oct in Copenhagen", () => {
    const r = staffReachState("2026-10-04T22:30:00", NOW);
    expect(r.lastSeenDay).toBe("2026-10-05");
    expect(r).toMatchObject({ state: "joined", daysAgo: 7 });
  });

  it("21:59 UTC stays on the same day (23:59 local)", () => {
    expect(staffReachState("2026-10-04T21:59:00", NOW).lastSeenDay).toBe("2026-10-04");
  });

  it("winter time too: 23:30 UTC on 1 Dec is 00:30 on 2 Dec (CET, UTC+1)", () => {
    const dec = Date.UTC(2026, 11, 20, 12, 0, 0);
    expect(staffReachState("2026-12-01 23:30:00.123456", dec).lastSeenDay).toBe("2026-12-02");
  });

  it("the row says 5. okt., not 4. okt.", async () => {
    await act(async () => {
      render(
        <LanguageProvider>
          <StaffReachStatus lastAccessed="2026-10-04T22:30:00" now={NOW} />
        </LanguageProvider>,
      );
    });
    expect(screen.getByText("Sidst set 5. okt. 26")).toBeInTheDocument();
    expect(screen.queryByText(/4\. okt\./)).toBeNull();
  });

  it("'i går' is also counted in Copenhagen days", () => {
    // 22:30 UTC on 10 Oct = 00:30 on 11 Oct local → yesterday, not 2 days ago.
    expect(staffReachState("2026-10-10T22:30:00", NOW).daysAgo).toBe(1);
  });
});
