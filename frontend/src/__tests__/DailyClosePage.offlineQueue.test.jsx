/**
 * The daily close page has to TELL the owner when a close is not in the books.
 *
 * The queue module (dailyCloseQueue.test.js) proves a blocked close is kept.
 * This proves the owner can SEE it and reach it — which is the half that was
 * missing: a close stopped by the anomaly guard used to be indistinguishable
 * from a close waiting for a signal bar, when one of them will never send
 * itself and needs the owner's eyes.
 *
 * Strings are asserted by key (t returns the key here), so this test pins the
 * behaviour, not the wording.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    patch: vi.fn(),
  },
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    // Echo the key plus any interpolated values, so a count can be asserted
    // without depending on the Danish or English sentence around it.
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join(",")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));

const { OQ_KEY, QUEUE_NEEDS_CONFIRMATION } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const renderPage = () =>
  render(
    <MemoryRouter>
      <DailyClosePage />
    </MemoryRouter>,
  );

const seedQueue = (items) => localStorage.setItem(OQ_KEY, JSON.stringify(items));

const blockedClose = {
  id: "q1",
  ts: 1758000000000,
  state: QUEUE_NEEDS_CONFIRMATION,
  payload: { date: "2026-09-15", status: "confirmed" },
  anomaly: { reason: "low", today_total: 2234, baseline_avg: 22340, delta_pct: -0.9 },
};

const waitingClose = {
  id: "q2",
  ts: 1758000001000,
  payload: { date: "2026-09-16", status: "confirmed" },
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
});

describe("daily close — queued closes the owner has to see", () => {
  it("says 'waiting for your confirmation', not just 'pending'", async () => {
    seedQueue([blockedClose]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/dcQueuedNeedsConfirm:1/)).toBeInTheDocument();
    });
    // …and does NOT count it as something the network will handle on its own.
    expect(screen.queryByText(/dcQueuedNetwork/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dcSyncPending/)).not.toBeInTheDocument();
  });

  it("counts the two kinds of waiting separately", async () => {
    seedQueue([blockedClose, waitingClose]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/dcQueuedNeedsConfirm:1/)).toBeInTheDocument();
    });
    // Online in jsdom, so the network-bound one offers Sync.
    expect(screen.getByText(/dcSyncPending:1/)).toBeInTheDocument();
  });

  it("names the blocked close by its date so the owner knows which night it is", async () => {
    seedQueue([blockedClose]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("dcQueueBlockedTitle")).toBeInTheDocument();
    });
    expect(screen.getByText(/15 Sep 26/)).toBeInTheDocument();
  });

  it("opens the same double-check dialog the wizard uses, and never auto-acknowledges", async () => {
    seedQueue([blockedClose]);
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText("dcQueueReviewCta")).toBeInTheDocument());
    fireEvent.click(screen.getByText("dcQueueReviewCta"));

    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    });
    expect(screen.getByText("closeAnomalyTitle")).toBeInTheDocument();
    // Nothing was posted by merely LOOKING at it.
    expect(post).not.toHaveBeenCalled();
  });

  it("sends acknowledge_anomaly only once the owner taps confirm, then clears the close", async () => {
    seedQueue([blockedClose]);
    post.mockResolvedValue({ data: { id: 42 } });
    renderPage();

    await waitFor(() => expect(screen.getByText("dcQueueReviewCta")).toBeInTheDocument());
    fireEvent.click(screen.getByText("dcQueueReviewCta"));
    await waitFor(() => expect(screen.getByText("closeAnomalyConfirm")).toBeInTheDocument());
    fireEvent.click(screen.getByText("closeAnomalyConfirm"));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/daily-close", {
        date: "2026-09-15",
        status: "confirmed",
        acknowledge_anomaly: true,
      });
    });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(OQ_KEY))).toEqual([]);
    });
  });

  it("names the date inside the dialog, not just 'today'", async () => {
    // A queued close is by construction NOT today's — it sat on the device
    // through an offline stretch. The anomaly templates say "Dagens total",
    // so without this the owner acknowledges a money guard against a day the
    // dialog never names.
    seedQueue([blockedClose]);
    renderPage();

    await waitFor(() => expect(screen.getByText("dcQueueReviewCta")).toBeInTheDocument());
    fireEvent.click(screen.getByText("dcQueueReviewCta"));

    await waitFor(() => expect(screen.getByText("closeAnomalyTitle")).toBeInTheDocument());
    expect(screen.getByText(/dcAnomalyForDate:.*15 Sep 26/)).toBeInTheDocument();
  });

  it("stops retrying a close the server already holds, and offers to remove the copy", async () => {
    // Our POST committed and the reply was lost on flaky 4G. The retry hits
    // the lock guard (409) forever, so this used to sit under a permanent red
    // "couldn't be saved" banner — over money that IS in the books — with no
    // button on the row at all.
    seedQueue([waitingClose]);
    post.mockRejectedValue(Object.assign(new Error("409"), {
      response: { status: 409, data: { detail: "This daily close is locked. Unlock it first to make changes." } },
    }));
    renderPage();

    await waitFor(() => expect(screen.getByText(/dcSyncPending:1/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/dcSyncPending:1/));

    // Not red, not "retry" — and the server's English lock message is not the
    // headline the owner reads.
    await waitFor(() => expect(screen.getByText(/dcQueuedAlreadySaved:1/)).toBeInTheDocument());
    expect(screen.queryByText(/dcQueuedFailed/)).not.toBeInTheDocument();
    expect(screen.getByText(/dcQueueErrLocked/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("dcQueueRemoveCopy"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(OQ_KEY))).toEqual([]));
  });

  it("translates a refused close instead of echoing the server's English", async () => {
    seedQueue([waitingClose]);
    post.mockRejectedValue(Object.assign(new Error("500"), {
      response: { status: 500, data: { detail: "Internal Server Error" } },
    }));
    renderPage();

    await waitFor(() => expect(screen.getByText(/dcSyncPending:1/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/dcSyncPending:1/));

    await waitFor(() => expect(screen.getByText(/dcQueuedFailed:1/)).toBeInTheDocument());
    // A translated sentence leads; the raw server text is secondary detail.
    expect(screen.getByText(/dcQueueErrServer/)).toBeInTheDocument();
    expect(screen.getByText("Internal Server Error")).toBeInTheDocument();
  });

  it("shows no queue chrome at all when nothing is queued", async () => {
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText("dcQueueBlockedTitle")).not.toBeInTheDocument();
    expect(screen.queryByText(/dcQueuedNeedsConfirm/)).not.toBeInTheDocument();
  });
});
