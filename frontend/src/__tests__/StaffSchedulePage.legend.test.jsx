/**
 * The Vagtplan's Status legend, mounted on the real page (3 Nov 2026).
 *
 * The legend is the one place an owner is TAUGHT the card marks, so it has to
 * draw the cards the grid now draws: a draft is a cream card with a dashed
 * amber edge and no bar; a published card has the solid left bar and a fill;
 * "seen" is the emerald check. The old legend drew a dashed square and a gray
 * DOT for "Published" — a mark that appears nowhere on the grid.
 *
 * Real Danish catalogue; api mocked per URL (same harness as the review-round
 * page test).
 */
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, role: "owner", currency: "DKK", business_type: "cafe", plan: "pro" },
    loading: false,
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isAtCap: () => false, cap: () => 25, isReady: true, plan: "pro", data: {} }),
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));

const api = (await import("../services/api")).default;
const { default: StaffSchedulePage } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = iso(new Date());

const STAFF = [
  { id: "a", name: "Oscar Christensen", role: "server", active: true, contract_type: "full" },
  { id: "b", name: "Bo", role: "bar", active: true, contract_type: "part" },
];
const SHIFTS = [
  { id: "s1", staff_id: "a", date: TODAY, start_time: "17:00", end_time: "23:30", break_minutes: 45, status: "published", confirmed_current: true },
  { id: "s2", staff_id: "b", date: TODAY, start_time: "10:00", end_time: "16:00", break_minutes: 0, status: "draft" },
];

function routeGet(url) {
  const u = String(url);
  if (u.includes("/staff/members")) return Promise.resolve({ data: STAFF });
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 403 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: SHIFTS });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

const tokens = (el) => String(el?.className || "").split(/\s+/).filter(Boolean);

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  localStorage.setItem("lang", "da");
});

async function mountPage() {
  let view;
  await act(async () => {
    view = render(
      <MemoryRouter>
        <LanguageProvider>
          <StaffSchedulePage />
        </LanguageProvider>
      </MemoryRouter>,
    );
  });
  await screen.findAllByText("17.00–23.30", {}, { timeout: 8000 });
  return view.container;
}

describe("the Status legend draws the cards the grid draws", () => {
  it("shows a draft as cream with a dashed amber edge and no bar", async () => {
    const container = await mountPage();
    const sw = container.querySelector('[data-legend-swatch="draft"]');
    expect(sw).toBeTruthy();
    for (const c of ["bg-[#FFFBF4]", "outline-dashed", "outline-amber-400"]) expect(tokens(sw)).toContain(c);
    expect(tokens(sw)).not.toContain("border-l-[3px]");
    expect(sw.parentElement.textContent).toBe("Kladde – ikke sendt");
  });

  it("shows a published card as a solid left bar on a fill — not a gray dot", async () => {
    const container = await mountPage();
    const sw = container.querySelector('[data-legend-swatch="published"]');
    expect(sw).toBeTruthy();
    for (const c of ["border-l-[3px]", "ring-1", "bg-white"]) expect(tokens(sw)).toContain(c);
    expect(tokens(sw)).not.toContain("rounded-full");
    expect(sw.parentElement.textContent).toBe("Udgivet");
  });

  it("keeps the emerald check as 'seen', the same mark the card carries", async () => {
    const container = await mountPage();
    const legend = container.querySelector('[data-legend-swatch="draft"]').closest("div");
    const seen = within(legend).getByText("Set af medarbejderen");
    expect(seen.querySelector("svg").getAttribute("class")).toContain("text-emerald-600");
    // …and on the grid, the published shift that has been seen carries it.
    expect(container.querySelectorAll('table [title="Set af medarbejderen"]').length).toBe(1);
  });
});

describe("the page, end to end", () => {
  it("renders the full name on the desktop row AND the phone row", async () => {
    await mountPage();
    // Both views are in the DOM (CSS picks one by width).
    const names = screen.getAllByText("Oscar Christensen");
    expect(names.length).toBe(2);
    for (const el of names) {
      expect(tokens(el)).toContain("line-clamp-2");
      expect(tokens(el)).not.toContain("truncate");
    }
  });
});
