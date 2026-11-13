/**
 * Beskeder must read the threads ONCE per open (13 Nov 2026 device pass).
 *
 * The schedule page passes `onUnreadChange={(n) => chatUnreadQ.setData(...)}`
 * — a fresh arrow every render — and reporting the count re-renders that
 * page. While loadThreads depended on the prop, every answer made a new
 * loadThreads, re-ran the open effect and fetched again: ~180 requests a
 * second until the per-IP limit answered 429 to the whole app.
 *
 * The harness reproduces the live caller exactly: new arrow each render, and
 * the callback writes a NEW object into parent state (so React re-renders even
 * when the count is unchanged).
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: {
    get: vi.fn((url) => {
      if (url === "/staff/chat/threads")
        return Promise.resolve({ data: { threads: [{ id: 1, name: "Ana", unread: 2 }] } });
      if (url === "/staff/chat/groups") return Promise.resolve({ data: { groups: [] } });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

import api from "../services/api";
import OwnerChatDrawer from "../components/staff/OwnerChatDrawer";
import { LanguageProvider } from "../hooks/useLanguage";

function LiveCaller() {
  const [badge, setBadge] = useState({ unread: 0 });
  return (
    <>
      <span data-testid="badge">{badge.unread}</span>
      <OwnerChatDrawer open onClose={() => {}} onUnreadChange={(n) => setBadge({ unread: n })} />
    </>
  );
}

beforeEach(() => {
  localStorage.setItem("lang", "da");
  api.get.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OwnerChatDrawer — no request loop", () => {
  it("opening reads threads + groups once, even with a new callback every render", async () => {
    render(
      <LanguageProvider>
        <LiveCaller />
      </LanguageProvider>,
    );
    // The badge got the real count, so the callback DID fire and re-render the parent…
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("2"));
    // …and give any loop time to show itself.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const calls = api.get.mock.calls.map((c) => c[0]);
    expect(calls.filter((u) => u === "/staff/chat/threads")).toHaveLength(1);
    expect(calls.filter((u) => u === "/staff/chat/groups")).toHaveLength(1);
  });

  it("the 8 s refresh still runs, and still reports to the LATEST callback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seen = [];
    function Caller({ tag }) {
      return <OwnerChatDrawer open onClose={() => {}} onUnreadChange={(n) => seen.push([tag, n])} />;
    }
    const { rerender } = render(
      <LanguageProvider>
        <Caller tag="first" />
      </LanguageProvider>,
    );
    await waitFor(() => expect(seen).toContainEqual(["first", 2]));
    rerender(
      <LanguageProvider>
        <Caller tag="second" />
      </LanguageProvider>,
    );
    const before = api.get.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    await waitFor(() => expect(seen).toContainEqual(["second", 2]));
    // One refresh = one threads read + one groups read, no more.
    expect(api.get.mock.calls.length - before).toBe(2);
  });
});
