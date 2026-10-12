/**
 * Vagtplan — "who is in" asks the server ONCE per page load / trigger.
 *
 * QA 12 Oct 2026: GET /staff/schedules/link-status went out twice on every
 * /staff/schedule load. The page asked again whenever the roster's SIZE
 * changed, and a click (expanding "Dit team") asked again even while the
 * load's request was still in flight. The answer covers every person on the
 * account (it is not branch-filtered), so a roster re-read has nothing new to
 * ask; only a person the last answer did not cover (just added) is a reason.
 *
 * Whole page mounted, real Danish catalogue, api mocked per URL.
 */
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, role: "owner", currency: "DKK", business_type: "cafe", plan: "pro", business_name: "Café Mirabelle" },
    loading: false,
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isAtCap: () => false, cap: () => 25, isReady: true, plan: "pro", data: {} }),
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));
// The branch the page shows — switchable between renders.
const BRANCH = { id: null };
vi.mock("../components/BranchSelector", async (importOriginal) => ({
  ...(await importOriginal()),
  useBranch: () => ({ branchId: BRANCH.id, branchType: null, hasMultiBranch: true, branches: [] }),
}));

const api = (await import("../services/api")).default;
const { default: StaffSchedulePage } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

const SOFIE = { id: "a", name: "Sofie Holm", role: "Barista", active: true, contract_type: "part", base_rate: 165 };
const MADS = { id: "b", name: "Mads Kjær", role: "Barista", active: true, contract_type: "part", base_rate: 158 };
let STAFF_ALL;
let STAFF_B1;
let statusAnswer;

function routeGet(url, cfg) {
  const u = String(url);
  if (u.includes("/staff/schedules/link-status")) return statusAnswer();
  if (u.includes("/staff/members")) {
    return Promise.resolve({ data: cfg?.params?.branch_id === "b1" ? STAFF_B1 : STAFF_ALL });
  }
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 500 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

const statusCalls = () => api.get.mock.calls.filter(([u]) => String(u).includes("/link-status"));
// The whole account, whatever branch the page shows.
const accountStatus = () => Promise.resolve({
  data: STAFF_ALL.map((s) => ({ staff_id: s.id, has_link: true, has_pin: false, last_accessed: null })),
});

beforeEach(() => {
  BRANCH.id = null;
  STAFF_ALL = [SOFIE, MADS];
  STAFF_B1 = [SOFIE];
  statusAnswer = accountStatus;
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation((url) => {
    if (String(url) === "/staff/members") {
      return Promise.resolve({ data: { id: "n", name: "Freja Lund", active: true, role: "Barista" } });
    }
    return Promise.resolve({ data: {} });
  });
  localStorage.setItem("lang", "da");
  vi.stubGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(0), 0));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const tree = () => (
  <StrictMode>
    <MemoryRouter>
      <LanguageProvider>
        <StaffSchedulePage />
      </LanguageProvider>
    </MemoryRouter>
  </StrictMode>
);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe("link-status — one request per load or trigger", () => {
  it("a page load (StrictMode, as the dev server runs it) asks once", async () => {
    await act(async () => { render(tree()); });
    await screen.findByTestId("team-reach-chip", {}, { timeout: 8000 });
    await settle();
    expect(statusCalls()).toHaveLength(1);
  });

  it("a roster re-read (another branch) asks nothing new — the answer already covers everyone", async () => {
    BRANCH.id = "b1";
    let utils;
    await act(async () => { utils = render(tree()); });
    await screen.findByTestId("team-reach-chip", {}, { timeout: 8000 });
    await settle();
    expect(statusCalls()).toHaveLength(1);
    BRANCH.id = null; // the roster now has two people, not one
    await act(async () => { utils.rerender(tree()); });
    await waitFor(() =>
      expect(api.get.mock.calls.filter(([u, c]) => String(u).includes("/staff/members") && !c?.params?.branch_id).length).toBeGreaterThan(0),
    );
    await settle();
    expect(statusCalls()).toHaveLength(1);
  });

  it("opening 'Dit team' while the load's request is still out shares it", async () => {
    let answer;
    statusAnswer = () => new Promise((res) => { answer = res; });
    await act(async () => { render(tree()); });
    await waitFor(() => expect(statusCalls()).toHaveLength(1), { timeout: 8000 });
    fireEvent.click(await screen.findByRole("button", { name: /Dit team/ }));
    await settle();
    expect(statusCalls()).toHaveLength(1);
    await act(async () => { answer({ data: STAFF_ALL.map((s) => ({ staff_id: s.id, has_link: true, last_accessed: null })) }); });
    expect(await screen.findByTestId("team-reach-chip")).toBeInTheDocument();
  });

  it("opening 'Dit team' later is its own trigger: one more, fresh", async () => {
    await act(async () => { render(tree()); });
    await screen.findByTestId("team-reach-chip", {}, { timeout: 8000 });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Dit team/ }));
    await settle();
    expect(statusCalls()).toHaveLength(2);
  });

  it("a person added a moment ago is not covered yet — that one asks again", async () => {
    await act(async () => { render(tree()); });
    fireEvent.click(await screen.findByRole("button", { name: /Dit team/ }, { timeout: 8000 }));
    await settle();
    const before = statusCalls().length;
    STAFF_ALL = [SOFIE, MADS, { id: "n", name: "Freja Lund", active: true, role: "Barista" }];
    fireEvent.change(screen.getByLabelText("Navn"), { target: { value: "Freja Lund" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj" })); });
    await screen.findByTestId("team-just-added");
    await waitFor(() => expect(statusCalls()).toHaveLength(before + 1));
    await settle();
    expect(statusCalls()).toHaveLength(before + 1);
  });
});
