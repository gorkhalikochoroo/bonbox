/**
 * R1 fix round (24 Oct 2026) — spam the booking screen held must not set off
 * the host stand.
 *
 * The review posted six bot bookings marked "severe allergy"; the screen held
 * every one (status requested), and the stand still got six sticky red
 * toasts and the urgent beep on every poll during service (atk-k). Now the
 * change feed marks held rows (`held: true`) and the stand folds them into
 * ONE quiet "N online bookings to check" toast: no sound, no sticky red, no
 * "sent to kitchen". When the owner APPROVES a held booking with a severe
 * allergy, the feed sends it again as kind "approved" — and THAT alerts like
 * any severe allergy (the 14 Jun rule, unchanged for real bookings).
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertSoundFor, splitHeld } from "../lib/liveAlertKinds";

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

describe("splitHeld", () => {
  it("separates held items, and a held batch makes no sound", () => {
    const items = [{ id: 1, held: true, severe: false }, { id: 2, severe: true }, { id: 3, held: true }];
    const { live, held } = splitHeld(items);
    expect(live.map((i) => i.id)).toEqual([2]);
    expect(held.map((i) => i.id)).toEqual([1, 3]);
    expect(alertSoundFor(splitHeld([{ held: true }, { held: true }]).live)).toBe(null);
  });
});

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

describe("the stand under a held flood", () => {
  it("six held 'severe' bot bookings: one quiet toast, no beep, nothing sticky", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-24T18:00:00", changes: [] } })
      .mockResolvedValue({ data: { server_time: "2026-10-24T18:00:20",
        changes: [1, 2, 3, 4, 5, 6].map((i) => change(i)) } });
    mountStand();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await poll();
    expect(screen.getByText("6 online bookings to check")).toBeTruthy();
    expect(screen.queryByText("✓ Got it — sent to kitchen")).toBeNull();
    expect(screen.queryByText("⚠ Severe allergy noted")).toBeNull();
    expect(snd.playUrgent).not.toHaveBeenCalled();
    expect(snd.playChime).not.toHaveBeenCalled();
  });

  it("the owner approves one: now it alerts as a severe allergy", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-24T18:00:00", changes: [] } })
      .mockResolvedValue({ data: { server_time: "2026-10-24T18:00:20",
        changes: [change(7, { kind: "approved", status: "confirmed", held: false, guest_name: "Anna" })] } });
    mountStand();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await poll();
    expect(screen.getByText("Booking confirmed")).toBeTruthy();
    expect(screen.getByText("⚠ Severe allergy noted")).toBeTruthy();
    expect(screen.getByText("✓ Got it — sent to kitchen")).toBeTruthy();
    expect(snd.playUrgent).toHaveBeenCalledTimes(1);
  });

  it("a real (not held) severe booking alerts exactly as before", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-24T18:00:00", changes: [] } })
      .mockResolvedValue({ data: { server_time: "2026-10-24T18:00:20",
        changes: [change(8, { status: "confirmed", held: false, guest_name: "Real" })] } });
    mountStand();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await poll();
    expect(screen.getByText("⚠ Severe allergy noted")).toBeTruthy();
    expect(snd.playUrgent).toHaveBeenCalledTimes(1);
  });
});
