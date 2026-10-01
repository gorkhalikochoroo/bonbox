/**
 * The whole Vagtplan page, mounted — the wiring the component tests cannot
 * see. A green build has shipped a white screen from this file before (a TDZ),
 * and every finding in this round crosses the page: the fravær sheet opened
 * from a grid row, the week's cost "—" with the names from week-cost, the
 * copy-week toast naming who was skipped, "Tilføj" opening on today.
 *
 * Real Danish catalogue; api mocked per URL.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  { id: "a", name: "Anna", role: "server", active: true, contract_type: "full", base_rate: 180 },
  { id: "b", name: "Bo", role: "bar", active: true, contract_type: "part", base_rate: null },
];
const SHIFTS = [
  { id: "s1", staff_id: "a", date: TODAY, start_time: "17:00", end_time: "23:30", break_minutes: 45, status: "published" },
  { id: "s2", staff_id: "b", date: TODAY, start_time: "10:00", end_time: "16:00", break_minutes: 0, status: "draft" },
];
const WEEK_COST = {
  target_labor_pct: 0.3,
  missing_wage: [{ staff_id: "b", name: "Bo" }],
  daily: [{ date: TODAY, hours: 11.75, cost_gross: null, cost_loaded: null, revenue: null, settled: false }],
  week: { hours: 11.75, cost_gross: null, cost_loaded: null, revenue: null, labor_pct_gross: null, labor_pct_loaded: null, settled: { days: 0 } },
};

function routeGet(url) {
  const u = String(url);
  if (u.includes("/staff/members")) return Promise.resolve({ data: STAFF });
  if (u.includes("/staff/schedules/week-cost")) return Promise.resolve({ data: WEEK_COST });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: SHIFTS });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  localStorage.setItem("lang", "da");
});

async function mountPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <StaffSchedulePage />
        </LanguageProvider>
      </MemoryRouter>,
    );
  });
  // The grid is up once a shift card is on screen.
  await screen.findAllByText("17.00–23.30", {}, { timeout: 8000 });
}

describe("the Vagtplan page after the review round", () => {
  it("renders the week with Danish times and says why the week's cost is unknown", async () => {
    await mountPage();
    // Desktop summary + phone week line both carry the reason.
    const reasons = await screen.findAllByText("Mangler timeløn: Bo");
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    // And the phone line labels the hours as planned, drafts included.
    expect(screen.getByTestId("sched-week-line").textContent).toContain("planlagt, inkl. kladder");
    expect(screen.getByTestId("sched-week-line").textContent).toContain("11,75 t");
  });

  it("opens the fravær sheet from a person's row and registers the absence", async () => {
    await mountPage();
    const [rowAction] = screen.getAllByRole("button", { name: "Registrér fravær for Bo" });
    fireEvent.click(rowAction);
    const sheet = await screen.findByRole("dialog", { name: "Fravær" });
    expect(within(sheet).getByLabelText("Medarbejder").value).toBe("b");
    fireEvent.click(within(sheet).getByRole("button", { name: "Gem fravær" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/staff/absences", expect.objectContaining({ staff_id: "b", kind: "sick" })),
    );
    // The page re-reads its layers so the grid shows it.
    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => String(u).includes("/staff/absences")).length).toBeGreaterThan(1));
  });

  it("opens 'Tilføj' on today when this week is on screen", async () => {
    await mountPage();
    fireEvent.click(screen.getByTitle("Tilføj vagt"));
    const sheet = await screen.findByRole("dialog", { name: "Tilføj vagt" });
    const dateSel = within(sheet).getAllByRole("combobox")[1];
    expect(dateSel.value).toBe(TODAY);
  });

  it("names who copy-week left out because it would have double-booked them", async () => {
    api.post.mockImplementation((url) =>
      String(url).includes("copy-week")
        ? Promise.resolve({ data: { copied: 3, skipped: 0, skipped_overlap: 1, skipped_overlap_names: ["Anna"] } })
        : Promise.resolve({ data: {} }),
    );
    await mountPage();
    fireEvent.click(screen.getByTitle("Kopiér sidste uges vagtplan"));
    expect(
      await screen.findByText("3 vagter kopieret fra sidste uge · 1 sprunget over (overlapper): Anna"),
    ).toBeInTheDocument();
  });

  it("publishes from a neutral button and names who has no way to be told", async () => {
    await mountPage();
    const publish = screen.getByTitle("Udgiv ugen");
    // Not emerald: that is the status colour on this page.
    expect(publish.className).not.toContain("bg-emerald-600");
    fireEvent.click(publish);
    const sheet = await screen.findByRole("dialog", { name: "Udgiv denne uge?" });
    // Bo (the only draft) has neither email nor phone → nobody reachable:
    // the e-mail promise is gone and the amber box says so instead.
    expect(within(sheet).queryByText(/får en e-mail/)).toBeNull();
    expect(within(sheet).getByText(/Ingen af disse medarbejdere har e-mail eller telefon/)).toBeInTheDocument();
  });

  it("publishes once on a double tap, and names who was not emailed", async () => {
    let resolvePublish;
    api.post.mockImplementation((url) =>
      String(url).includes("/staff/schedules/publish")
        ? new Promise((r) => { resolvePublish = r; })
        : Promise.resolve({ data: {} }),
    );
    await mountPage();
    fireEvent.click(screen.getByTitle("Udgiv ugen"));
    const sheet = await screen.findByRole("dialog", { name: "Udgiv denne uge?" });
    const cta = within(sheet).getByRole("button", { name: "Udgiv ugen" });
    fireEvent.click(cta);
    fireEvent.click(cta);
    const publishCalls = () => api.post.mock.calls.filter(([u]) => String(u).includes("/publish"));
    expect(publishCalls()).toHaveLength(1);
    await act(async () => {
      resolvePublish({ data: { published: 1, notify_count: 0, skipped_no_email_names: ["Bo"] } });
    });
    expect(await screen.findByText("Ikke sendt e-mail (ingen adresse registreret): Bo")).toBeInTheDocument();
    expect(publishCalls()).toHaveLength(1);
  });
});
