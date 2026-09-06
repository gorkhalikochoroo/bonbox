/**
 * Pull-to-refresh must never say "Up to date" when it could not ask.
 *
 * loadData fans out over Promise.allSettled and deliberately KEEPS the last
 * good schedule when the schedule leg rejects ("fail honest" — a stale-but-true
 * roster beats a blank screen). It used to report that outcome as a boolean,
 * which collapsed "nothing moved" and "we never reached the server" into the
 * same `false` — so the chip rendered "Up to date — no changes" over week-old
 * shifts. Seen live 2026-09-03: a bad row 500'd GET /portal/{token}/schedule
 * and the iOS Scheduler app told the staffer their schedule was current.
 *
 * These tests mount the real page and drive the real touch gesture, so they
 * pin the WHOLE path — allSettled outcome → doRefresh → chip text — rather
 * than a re-implementation of it. The fail-honest half is asserted too: the
 * previously-loaded shift must still be on screen underneath the warning.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tok1";

/** Swapped per test to decide what the SCHEDULE leg does on the 2nd call. */
let scheduleCalls = 0;
let secondSchedule = null;

const shift = (date) => ({
  id: `s-${date}`, date, start_time: "17:00", end_time: "23:00", status: "published",
});
const ok = (data) => Promise.resolve({ data });

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Ana", restaurant_name: "Sekuwa" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) {
    scheduleCalls += 1;
    // First load seeds the signature; the second is what each test varies.
    if (scheduleCalls === 1) return ok({ shifts: [shift("2026-09-04")] });
    return secondSchedule();
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.includes("/hours")) return ok({ shifts: [], totals: {} });
  return ok([]);            // team-schedule, open-shifts, covers, everything else
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

/**
 * The real gesture: the listeners live on .full-height.scrollable and read
 * e.touches[0].clientY. jsdom has no TouchEvent constructor, so we dispatch
 * plain events carrying the one field the handlers actually read.
 */
async function pullToRefresh() {
  const el = document.querySelector(".full-height.scrollable");
  expect(el).toBeTruthy();
  const fire = (type, y) => {
    const e = new Event(type, { bubbles: true });
    if (y !== undefined) e.touches = [{ clientY: y }];
    el.dispatchEvent(e);
  };
  await act(async () => {
    fire("touchstart", 0);
    fire("touchmove", 40);    // past the 12px "pulling" threshold
    fire("touchmove", 120);   // past the 70px release threshold
    fire("touchend");
  });
}

/**
 * Read the pull chip SPECIFICALLY. A bare getByText is ambiguous here: on a
 * real change the separate "schedule updated" toast carries the same string,
 * so a global query matches two nodes and cannot tell which surface spoke.
 */
function chipText() {
  const chip = document.querySelector('[role="status"].fixed.left-0.right-0.z-40');
  return chip ? chip.textContent.trim() : null;
}

async function mountPortal(lang) {
  if (lang) localStorage.setItem("lang", lang);
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
        <Routes>
          <Route path="/portal/:token" element={<StaffPortalPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
  // First load has landed once the seeded shift is on screen.
  await waitFor(() => expect(scheduleCalls).toBe(1));
  await act(async () => {});
}

beforeEach(() => {
  scheduleCalls = 0;
  secondSchedule = null;
  get.mockClear();
});

describe("pull-to-refresh chip", () => {
  it("says it could NOT check when the schedule leg rejects", async () => {
    secondSchedule = () => Promise.reject({ response: { status: 500 } });
    await mountPortal();
    await pullToRefresh();

    // The exact lie this replaces is "Up to date — no changes".
    await waitFor(() => expect(chipText()).toBe("Couldn't check — showing last known"));
  });

  it("keeps the last-good schedule on screen when the fetch fails", async () => {
    secondSchedule = () => Promise.reject({ response: { status: 500 } });
    await mountPortal();
    // The rendered schedule column, captured before the doomed refresh. The
    // pull chip is a sibling of this node, so it cannot pollute the compare.
    const content = () => document.querySelector(".max-w-lg.px-4.py-4").textContent;
    const before = content();
    expect(before).toContain("17:00");        // the seeded shift is really drawn
    await pullToRefresh();

    await waitFor(() => expect(chipText()).toBe("Couldn't check — showing last known"));
    // Fail honest: the failure must not blank the roster it could not verify.
    expect(content()).toBe(before);
  });

  it("still says 'no changes' when the fetch SUCCEEDS and nothing moved", async () => {
    secondSchedule = () => ok({ shifts: [shift("2026-09-04")] });
    await mountPortal();
    await pullToRefresh();

    await waitFor(() => expect(chipText()).toBe("Up to date — no changes"));
  });

  // The page passes an English literal as t()'s fallback, so a MISSING Danish
  // key fails silently by showing English to a Danish staffer. Only rendering
  // in da catches that — the dictionary guards cannot.
  it("says it in Danish for a Danish staffer", async () => {
    secondSchedule = () => Promise.reject({ response: { status: 500 } });
    await mountPortal("da");
    await pullToRefresh();

    await waitFor(() => expect(chipText()).toBe("Kunne ikke tjekke — viser sidst kendte"));
  });

  it("still says 'updated' when the roster actually changed", async () => {
    secondSchedule = () => ok({ shifts: [shift("2026-09-04"), shift("2026-09-05")] });
    await mountPortal();
    await pullToRefresh();

    await waitFor(() => expect(chipText()).toBe("Schedule updated"));
  });
});
