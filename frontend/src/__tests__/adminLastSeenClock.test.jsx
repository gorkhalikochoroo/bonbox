/**
 * Admin "Last seen" on a Danish clock (live defect, 11 Oct).
 *
 * Manoj signed in to two accounts and the super-admin list said "2h ago" for
 * both. The server sent last_active as naive UTC; relativeTime() and the
 * online dot read it with new Date(), i.e. as local time — 2 h in the past in
 * CEST. Rendered for real here, in Europe/Copenhagen, with the clock pinned:
 *   • a naive-UTC stamp from 1 minute ago reads "1m ago" with the green dot;
 *   • the Z-suffixed form the backend now sends reads the same;
 *   • a stamp from 3 hours ago reads "3h ago", not "5h ago".
 *
 * Backend contract: backend/tests/test_last_seen.py (Z-suffixed UTC,
 * last_active = newer of users.last_seen_at and event_logs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";
import { render, screen, waitFor, within } from "@testing-library/react";
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

// 11 Oct 2026, 12:15 in Copenhagen (CEST, UTC+2) = 10:15 UTC.
const NOW = new Date("2026-10-11T10:15:00Z");
const PREV_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "Europe/Copenhagen";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

function user(email, last_active) {
  return {
    id: email, email, business_name: email.split("@")[0], business_type: "cafe",
    role: "owner", email_verified: true, is_locked: false, tier: "free",
    created_at: "2026-09-01T08:00:00Z", last_active,
    sale_count: 0, expense_count: 0, event_count: 0, active_days: 0, is_activated: false,
  };
}

function mockApi(users) {
  get.mockImplementation((url) => {
    if (url === "/admin/users") return Promise.resolve({ data: users });
    if (url === "/admin/overview") return Promise.resolve({ data: { as_of: "2026-10-11T10:15:00Z" } });
    if (url === "/admin/retention") return Promise.resolve({ data: null });
    if (url === "/admin/signup-refs") return Promise.reject(new Error("not under test"));
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => get.mockReset());

const row = (email) => screen.getByText(email).closest("tr");
const lastSeenCell = (email) => row(email).querySelectorAll("td")[8];
const dotTitle = (email) => row(email).querySelector("td span").getAttribute("title");

describe("admin Last seen, in CEST", () => {
  it("the clock under test is Danish summer time", () => {
    expect(new Date().getTimezoneOffset()).toBe(-120);
  });

  it("a naive-UTC sign-in from 1 minute ago reads 1m ago and online", async () => {
    mockApi([
      user("sangita@cafe.dk", "2026-10-11T10:14:00"),        // naive UTC, as before the fix
      user("demo@cafe.dk", "2026-10-11T10:13:50.123456Z"),   // Z-suffixed, as the backend now sends
      user("old@cafe.dk", "2026-10-11T07:15:00"),            // 3 h ago
      user("never@cafe.dk", null),
    ]);
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("sangita@cafe.dk")).toBeTruthy());

    expect(lastSeenCell("sangita@cafe.dk").textContent).toBe("1m ago");
    expect(dotTitle("sangita@cafe.dk")).toBe("Online (active in last 5 min)");

    expect(lastSeenCell("demo@cafe.dk").textContent).toBe("1m ago");
    expect(dotTitle("demo@cafe.dk")).toBe("Online (active in last 5 min)");

    expect(lastSeenCell("old@cafe.dk").textContent).toBe("3h ago");
    expect(dotTitle("old@cafe.dk")).toBe("Active today");

    expect(lastSeenCell("never@cafe.dk").textContent).toBe("never");
    expect(dotTitle("never@cafe.dk")).toBe("Offline");
    expect(within(row("never@cafe.dk")).queryByText(/ago/)).toBeNull();
  });

  it("a sign-in seconds ago reads just now", async () => {
    mockApi([user("now@cafe.dk", "2026-10-11T10:14:40")]);
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("now@cafe.dk")).toBeTruthy());
    expect(lastSeenCell("now@cafe.dk").textContent).toBe("just now");
  });
});
