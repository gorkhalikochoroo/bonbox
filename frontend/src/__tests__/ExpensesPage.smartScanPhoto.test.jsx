/**
 * Smart skan → Udgifter (Stock + Money walk, 12 Oct 2026, two P1s).
 *
 *  1. The photo was dropped: the expense saved with no bilag, and the page
 *     then asked the owner to snap the receipt they had just photographed
 *     ("12 udgifter mangler bilag … snap det for at beholde fradraget").
 *     Now the photo is attached as the expense's bilag after it is saved.
 *  2. "Felter pre-udfyldt fra billedet" showed when NOTHING was read (an
 *     all-null extraction). Now it says it could not read the photo.
 *
 * Strings are asserted by key (t echoes the key).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a), post: (...a) => post(...a),
    put: vi.fn(() => Promise.resolve({ data: {} })), patch: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const ExpensesPage = (await import("../pages/ExpensesPage")).default;
const { holdScanPhoto } = await import("../utils/pendingScanPhoto");

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/expenses/categories") return Promise.resolve({ data: [{ id: "cat1", name: "Råvarer" }] });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (url === "/expenses") return Promise.resolve({ data: { id: "e1", amount: 226.45, date: "2026-10-12" } });
    return Promise.resolve({ data: { ok: true } });
  });
});

const renderFromScan = (prefill) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/expenses", state: { source: "smart_scan", prefill, verify_hints: [] } }]}>
      <Routes><Route path="/expenses" element={<ExpensesPage />} /></Routes>
    </MemoryRouter>,
  );

describe("Smart skan → Udgifter", () => {
  it("says it could not read the photo when nothing was read", async () => {
    renderFromScan({ vendor: null, amount: null, date: null, ocr_available: false });
    expect(await screen.findByText("smartScan.notRead")).toBeInTheDocument();
    expect(screen.queryByText("smartScan.prefilled")).toBeNull();
  });

  // QA 12 Oct: the not-read line sat in the success box with a check and
  // vanished after 4 s. It is an attention note (amber, info icon) that
  // stays until the owner saves or dismisses it.
  it("shows the not-read line as an attention note, not a success, and it stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderFromScan({ vendor: null, amount: null, date: null, ocr_available: false });
      const note = await screen.findByTestId("exp-scan-not-read");
      expect(note.textContent).toContain("smartScan.notRead");
      const box = note.querySelector('[role="status"]');
      expect(box.className).toContain("bg-amber-50");
      expect(box.className).not.toContain("emerald");
      expect(note.querySelector(".lucide-info")).not.toBeNull();
      expect(note.querySelector(".lucide-circle-check, .lucide-check-circle-2, .lucide-circle-check-big")).toBeNull();
      await vi.advanceTimersByTimeAsync(10000);
      expect(container.querySelector('[data-testid="exp-scan-not-read"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the not-read note goes when the owner dismisses it", async () => {
    renderFromScan({ vendor: null, amount: null, date: null });
    const note = await screen.findByTestId("exp-scan-not-read");
    fireEvent.click(note.querySelector('button[aria-label="dismiss"]'));
    expect(screen.queryByTestId("exp-scan-not-read")).toBeNull();
  });

  it("the not-read note goes once the owner saves the expense", async () => {
    renderFromScan({ vendor: null, amount: null, date: null });
    await screen.findByTestId("exp-scan-not-read");
    fireEvent.change(screen.getByPlaceholderText("customAmount"), { target: { value: "120" } });
    const add = screen.getAllByRole("button").find((b) => b.textContent.trim() === "add");
    await waitFor(() => expect(add).not.toBeDisabled());
    fireEvent.click(add);
    await waitFor(() => expect(post.mock.calls.some(([u]) => u === "/expenses")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("exp-scan-not-read")).toBeNull());
  });

  it("still says pre-filled when something was read", async () => {
    renderFromScan({ vendor: "Bilka", amount: 226.45, date: null });
    expect(await screen.findByText("smartScan.prefilled")).toBeInTheDocument();
  });

  it("keeps the photo and attaches it as the bilag after the expense is saved", async () => {
    const photo = new File(["jpeg"], "kvittering_bilka.jpg", { type: "image/jpeg" });
    holdScanPhoto(photo, "/expenses");
    const { container } = renderFromScan({ vendor: "Bilka", amount: 226.45, date: null });
    expect(await screen.findByTestId("exp-scan-photo-kept")).toBeInTheDocument();
    const add = screen.getAllByRole("button").find((b) => b.textContent.trim() === "add");
    await waitFor(() => expect(add).not.toBeDisabled());
    fireEvent.click(add);
    await waitFor(() =>
      expect(post.mock.calls.some(([u]) => u === "/expenses/e1/attach-receipt")).toBe(true),
    );
    const [, form] = post.mock.calls.find(([u]) => u === "/expenses/e1/attach-receipt");
    expect(form.get("file")).toBe(photo);
    expect(container.querySelector('[data-testid="exp-scan-photo-kept"]')).toBeNull();
  });
});
