/**
 * A misread scanned total can be corrected DOWN.
 *
 * The close saves the larger of the category sum and the scanned total, so a
 * half-read breakdown never saves too little. But the scanned total was not
 * editable: a Z-report read as 17.300 for a real 17.030 stayed 17.300 whatever
 * the owner typed in the categories — the ledger row and the kasserapport said
 * 270 kr. of revenue that never happened. The total is now an editable field,
 * and the corrected figure is what the close sends.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
});

describe("daily close — a misread scanned total", () => {
  it("is editable, and the corrected total is what the close sends", async () => {
    // The receipt says 17.030; the scanner read 17.300.
    post.mockResolvedValueOnce({
      data: {
        revenue_total: 17300,
        revenue: { food: 4200, drinks: 12830 },
        payments: { card: 17030 },
        raw_text: "KASSE 17030",
        ocr_available: true,
      },
    });
    post.mockResolvedValue({ data: { id: 1, status: "confirmed" } });
    const { container } = render(
      <MemoryRouter>
        <DailyClosePage />
      </MemoryRouter>,
    );

    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());

    const total = container.querySelector("#scan-total");
    expect(total).not.toBeNull();
    expect(total.value).toBe("17.300");
    fireEvent.change(total, { target: { value: "17.030" } });
    expect(total.value).toBe("17.030");

    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const lock = await screen.findByText("confirmAndLock");
    fireEvent.click(lock);

    await waitFor(() =>
      expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status !== "draft")).toBe(true),
    );
    const [, payload] = post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status !== "draft");
    expect(payload.revenue_total_override).toBe(17030);
  });
});
