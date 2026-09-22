/**
 * The paired host stand has to chime — and must not be thrown out of itself.
 *
 * THE DEFECT. useLiveAlerts armed itself with `const active = !!user &&
 * !isAccountant`. A paired door device lives at /stand/<token> and is
 * DELIBERATELY outside ProtectedRoute (a tablet by the door has no login), so it
 * has no session and `user` is null. The entire pop-and-chime feature was
 * therefore dead on the single screen it was built for: the owner's laptop in
 * the back office beeped for a new booking, the tablet front-of-house sat
 * silent through the whole service. That is not a missing nicety — a host stand
 * that never chimes is not a host stand.
 *
 * THE SECOND HALF. Tapping a toast called navigate("/reservations"). On a paired
 * device that route is protected and there is no session and no password at the
 * door, so front-of-house would be dumped on a login screen mid-service. It
 * fired on the severe-allergy toast too — the one interaction the alert feature
 * exists for. The tap has to stay inside /stand/<token>.
 *
 * Run: cd frontend && npx vitest run src/__tests__/liveAlertsHostStand.test.jsx
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const authState = vi.hoisted(() => ({ user: null }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (_k, fallback) => fallback ?? _k, lang: "en" }),
}));
// The AudioContext doesn't exist in jsdom, and the chime isn't what's under
// test here — whether we ever get far enough to ask for it is.
vi.mock("../utils/sound", () => ({
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  unlockSound: vi.fn(),
}));

import api from "../services/api";
import { LiveAlertsProvider, useLiveAlerts } from "../hooks/useLiveAlerts";

const TOKEN = "Zt4kQn9x_Sample-Token";

function Probe() {
  const { active, openReservations } = useLiveAlerts();
  const loc = useLocation();
  return (
    <div>
      <span data-testid="active">{String(active)}</span>
      <span data-testid="where">{loc.pathname + loc.search}</span>
      <button
        type="button"
        onClick={() => openReservations({ bookingId: "bk-1", bookingDate: "2026-09-22" })}
      >
        open
      </button>
    </div>
  );
}

function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LiveAlertsProvider>
        <Routes>
          <Route path="/stand/:standToken" element={<Probe />} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </LiveAlertsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.user = null;
  api.get.mockReset();
  api.get.mockResolvedValue({
    data: { server_time: "2026-09-22T18:00:00", changes: [] },
  });
  try {
    localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
});

describe("live alerts on a paired host stand", () => {
  it("polls the change feed on /stand/<token> even with no session", async () => {
    mount(`/stand/${TOKEN}`);
    expect(screen.getByTestId("active").textContent).toBe("true");
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/reservations/changes",
        expect.anything(),
      ),
    );
  });

  it("stays inert when there is neither a session nor a stand token", async () => {
    mount("/dashboard");
    expect(screen.getByTestId("active").textContent).toBe("false");
    // Give the effect a chance to have fired before asserting a negative.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("keeps a toast tap inside the stand instead of the protected owner app", async () => {
    mount(`/stand/${TOKEN}`);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => {
      const where = screen.getByTestId("where").textContent;
      expect(where.startsWith(`/stand/${TOKEN}`)).toBe(true);
      expect(where).toContain("booking=bk-1");
      expect(where).toContain("date=2026-09-22");
    });
    // The old behaviour, spelled out so a regression is unmistakable: this is
    // the route that would have shown a login screen to a host mid-service.
    expect(screen.getByTestId("where").textContent).not.toContain("/reservations");
  });

  it("still leaves the owner's own pop-out window where it was", async () => {
    authState.user = { id: 1, role: "owner" };
    mount("/reservations/stand");
    expect(screen.getByTestId("active").textContent).toBe("true");
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/reservations/stand"),
    );
  });

  it("stays inert for an accountant session", async () => {
    authState.user = { id: 2, role: "accountant" };
    mount("/dashboard");
    expect(screen.getByTestId("active").textContent).toBe("false");
    await new Promise((r) => setTimeout(r, 0));
    expect(api.get).not.toHaveBeenCalled();
  });
});
