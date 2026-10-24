/**
 * Booking fix round 2 (24 Oct 2026) — the stand's held toast reads right for
 * one booking ("1 online booking to check", not "1 online bookings") and its
 * line says nothing is held — true on a salon's stand too, where there is no
 * table.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) => {
      let s = typeof fb === "string" ? fb : _k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    },
    lang: "en",
  }),
}));
const snd = vi.hoisted(() => ({ playChime: vi.fn(), playUrgent: vi.fn(), playCancel: vi.fn() }));
vi.mock("../utils/sound", () => ({
  playChime: snd.playChime, playUrgent: snd.playUrgent, playCancel: snd.playCancel,
  unlockSound: vi.fn(), prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import { LiveAlertsProvider } from "../hooks/useLiveAlerts";

const change = (id, over = {}) => ({
  id, kind: "new", guest_name: "Bot", party_size: 2, starts_at: "2026-10-26T19:00:00",
  status: "requested", source: "public", table_label: null, has_allergy: true,
  allergy_severity: "severe", has_ai_allergy: false, note_intent: null,
  updated_at: `2026-10-24T18:00:0${id}`, held: true, ...over,
});

function mountStand() {
  return render(
    <MemoryRouter initialEntries={["/stand/Zt4kQn9x_Sample-Token"]}>
      <LiveAlertsProvider>
        <Routes><Route path="*" element={<div />} /></Routes>
      </LiveAlertsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  snd.playChime.mockReset(); snd.playUrgent.mockReset(); snd.playCancel.mockReset();
  api.get.mockReset();
  try { localStorage.clear(); } catch { /* no storage */ }
});
afterEach(() => { vi.useRealTimers(); });

const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); };

describe("the held toast's words", () => {
  it("one held booking: the singular title, and no table in the line", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-24T18:00:00", changes: [] } })
      .mockResolvedValue({ data: { server_time: "2026-10-24T18:00:20", changes: [change(1)] } });
    mountStand();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await poll();
    expect(screen.getByText("1 online booking to check")).toBeTruthy();
    expect(screen.queryByText("1 online bookings to check")).toBeNull();
    expect(screen.getByText("Waiting for your OK — nothing is held until you confirm")).toBeTruthy();
  });

  it("two: the plural", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-24T18:00:00", changes: [] } })
      .mockResolvedValue({ data: { server_time: "2026-10-24T18:00:20", changes: [change(1), change(2)] } });
    mountStand();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await poll();
    expect(screen.getByText("2 online bookings to check")).toBeTruthy();
  });
});
