/**
 * The admin page's door-visit table (GET /admin/signup-refs) — rendered for
 * real, with the API mocked. It must show the counts per round and per code,
 * survive the endpoint failing without blanking the rest of the page, and
 * read "no account yet" as a measured empty state.
 *
 * Backend contract: backend/tests/test_admin_signup_refs.py.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, f, v) => {
      const text = typeof f === "string" ? f : k;
      const vars = typeof f === "object" && f ? f : v;
      return vars ? text.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : text;
    },
    lang: "en", setLang: () => {}, LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { email: "admin@example.dk" } }) }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => false }));
// recharts needs a measured container; the charts are not under test here.
vi.mock("recharts", () => {
  const Stub = ({ children }) => <div>{children}</div>;
  return {
    BarChart: Stub, Bar: Stub, XAxis: Stub, YAxis: Stub, Tooltip: Stub, ResponsiveContainer: Stub,
    LineChart: Stub, Line: Stub, CartesianGrid: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
  };
});

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }));

import AdminPage from "../pages/AdminPage";

const STEPS = [
  "signups", "email_verified", "onboarding_finished", "first_close_any",
  "first_close_locked", "staff_link_created", "staff_link_opened", "active_7d",
];
const zero = Object.fromEntries(STEPS.map((s) => [s, 0]));

function mockApi(refs) {
  get.mockImplementation((url) => {
    if (url === "/admin/signup-refs") return refs instanceof Error ? Promise.reject(refs) : Promise.resolve({ data: refs });
    if (url === "/admin/overview") return Promise.resolve({ data: { as_of: new Date().toISOString() } });
    if (url === "/admin/retention") return Promise.resolve({ data: null });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => get.mockReset());

const show = () => render(<MemoryRouter><AdminPage /></MemoryRouter>);

describe("admin door-visit table", () => {
  it("shows counts per round/argument and per code", async () => {
    mockApi({
      steps: STEPS,
      total: { ...zero, signups: 3, first_close_locked: 1 },
      by_prefix: [
        { prefix: "r1-a", ...zero, signups: 2, first_close_locked: 1 },
        { prefix: "r2-b", ...zero, signups: 1 },
      ],
      by_ref: [
        { ref: "r1-a-03", prefix: "r1-a", ...zero, signups: 2, first_close_locked: 1 },
        { ref: "r2-b-01", prefix: "r2-b", ...zero, signups: 1 },
      ],
      excluded_internal: 1,
    });
    show();
    await waitFor(() => expect(screen.getByText("r1-a-03")).toBeTruthy());
    expect(screen.getByText("Door visits (signup codes)")).toBeTruthy();
    expect(screen.getByText("r1-a")).toBeTruthy();
    expect(screen.getByText("r2-b-01")).toBeTruthy();
    expect(screen.getByText("All codes")).toBeTruthy();
    expect(screen.getByText("1 internal/test accounts left out")).toBeTruthy();
    const row = screen.getByText("r1-a-03").closest("tr");
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    // code, then the 8 steps in order: signups 2, locked close 1, the rest 0.
    expect(cells).toEqual(["r1-a-03", "2", "0", "0", "0", "1", "0", "0", "0"]);
  });

  it("reads an empty fieldwork as zeros, with a plain empty line", async () => {
    mockApi({
      steps: STEPS, total: zero,
      by_prefix: [{ prefix: "r1-a", ...zero }, { prefix: "r2-b", ...zero }],
      by_ref: [], excluded_internal: 0,
    });
    show();
    await waitFor(() => expect(screen.getByText("No account has been created with a kept code yet.")).toBeTruthy());
    // A 0 is "none counted", never "none happened" — the subtitle says so.
    expect(screen.getByText(/A lower bound: a code reaches an account only in the browser that opened the QR/)).toBeTruthy();
    expect(screen.queryByText(/left out/)).toBeNull();
  });

  it("a failing endpoint says so and leaves the rest of the page up", async () => {
    mockApi(new Error("boom"));
    show();
    await waitFor(() => expect(screen.getByText("Door-visit counts could not be loaded.")).toBeTruthy());
    expect(screen.getByText(/Super Admin Mode/)).toBeTruthy();
  });
});
