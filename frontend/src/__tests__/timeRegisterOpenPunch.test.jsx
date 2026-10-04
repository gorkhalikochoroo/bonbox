/**
 * Tidsregistrering: a forgotten clock-out is not "Overholder".
 *
 * An open punch (clocked in, never out) showed "Overholder" beside 0 t — the
 * day's working time is not known, which is the one thing this register exists
 * to know. The server now sends status "open" with the punches named
 * (time_registration.open_punch_is_forgotten); the row says "Mangler
 * udstempling" in red and links to Timer's answer sheet for that person, on
 * the same window.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));
vi.mock("../utils/platform", () => ({
  isNativeApp: () => false, canPurchaseInApp: () => false, isIPad: () => false, platform: { isNative: false },
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ ready: true, hasFeature: () => true, minPlanForFeature: () => null, tier: "pro", plan: "pro" }),
}));

const TimeRegistrationPage = (await import("../pages/TimeRegistrationPage")).default;

const STAFF = {
  staff_id: "s-7", staff_name: "Tilde", status: "open", days_registered: 3, total_hours: 16,
  weekly_avg_hours: 4, rest_violation_count: 0, over_weekly_cap: false,
  open_punch_count: 1, open_punches: [{ date: "2026-09-26", start: "16:58" }],
};

function mount() {
  get.mockImplementation((url) => {
    if (url === "/staff/time-registration/preference") return Promise.resolve({ data: {} });
    if (url === "/staff/time-registration") {
      return Promise.resolve({ data: { staff: [STAFF], totals: { staff_count: 1, all_compliant: false, with_open_punches: 1 } } });
    }
    if (url === "/staff/time-registration/s-7") {
      return Promise.resolve({ data: { ...STAFF, register: [
        { date: "2026-09-25", start: "08:00", end: "16:00", hours: 8, source: "clock" },
        { date: "2026-09-26", start: "16:58", end: null, hours: 0, source: "clock" },
      ] } });
    }
    return Promise.resolve({ data: null });
  });
  return render(<MemoryRouter initialEntries={["/staff/hours?tab=time&from=2026-09-01&to=2026-09-30"]}><TimeRegistrationPage /></MemoryRouter>);
}

describe("a forgotten clock-out in the register", () => {
  it("is flagged, not 'Overholder', and links to Timer's answer sheet", async () => {
    mount();
    expect(await screen.findByText(/tregOpenPunch/)).toBeInTheDocument();
    expect(screen.queryByText("tregOk")).toBeNull();
    const link = screen.getByRole("link", { name: /tregFixClockOutOne/ });
    const href = new URL(link.getAttribute("href"), "http://x");
    expect(href.pathname).toBe("/staff/hours");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      tab: "hours", view: "details", resolve: "s-7", from: "2026-09-01", to: "2026-09-30",
    });
  });

  it("the open day in the register says the end is missing", async () => {
    mount();
    fireEvent.click(await screen.findByText("Tilde"));
    await waitFor(() => expect(screen.getByText("tregNoEnd")).toBeInTheDocument());
  });
});
