/**
 * "Ninety items in, the phone rang, and the count was gone."
 *
 * The optælling is a 120-line walk through a cold room on a phone. Until this
 * change the counted numbers existed ONLY in React state until the single POST
 * at the very end, and the one visible way out was a 36px X beside a scrolling
 * list. Brush it — or get backgrounded long enough for iOS to reload the tab —
 * and every line was gone, silently.
 *
 * Three things are pinned here, because all three are invisible in a green
 * build:
 *   1. the X is guarded once anything has been counted, and the guard is a
 *      CHOICE (save / discard), not a yes-no;
 *   2. the safe branch is the DEFAULT one — cancel, Esc and the backdrop all
 *      keep the draft, and only the red answer throws it away;
 *   3. reopening resumes, and SAYS it resumed.
 *
 * jsdom gives us a real localStorage, so the persistence is tested as
 * persistence rather than mocked into a fiction.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn(() => Promise.resolve({ data: {} }));
const apiPost = vi.fn(() => Promise.resolve({ data: { adjusted: 1, stock_value: 1234 } }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => apiGet(...a), post: (...a) => apiPost(...a) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "owner-1", business_type: "cafe", role: "owner" } }),
}));

const CountRitual = (await import("../components/CountRitual")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");
const { loadCountDraft, clearCountDraft } = await import("../utils/countDraft");

const ITEMS = [
  { id: "a", name: "Gin", category: "Bar", unit: "flasker", quantity: 4 },
  { id: "b", name: "Mælk", category: "Køl", unit: "liter", quantity: 9 },
];

function mount(props = {}) {
  return render(
    <LanguageProvider>
      <ConfirmProvider>
        <CountRitual open items={ITEMS} onClose={() => {}} onDone={() => {}} {...props} />
      </ConfirmProvider>
    </LanguageProvider>,
  );
}

/** Confirm the current line. The shipped Danish is "Stemmer · næste"; the
    provider under test resolves to the EN catalogue, hence the label here. */
async function countOneLine() {
  const next = await screen.findByText(/Correct ·/);
  await act(async () => { fireEvent.click(next); });
}

beforeEach(() => {
  clearCountDraft("owner-1");
  apiPost.mockClear();
});

describe("the count survives the interruption", () => {
  it("writes the counted lines to the device as they are entered", async () => {
    mount();
    expect(loadCountDraft("owner-1")).toBeNull(); // nothing counted yet = no draft
    await countOneLine();
    const draft = loadCountDraft("owner-1");
    expect(draft).not.toBeNull();
    expect(Object.keys(draft.counts)).toEqual(["a"]);
  });

  it("resumes on reopen and says so", async () => {
    const first = mount();
    await countOneLine();
    first.unmount(); // the reload

    mount();
    // The restored lines are announced. A resume the owner is not told about
    // is indistinguishable from the app inventing numbers on their shelf.
    expect(await screen.findByText(/1 items were already done/)).toBeInTheDocument();
  });

  it("drops a draft line whose item no longer exists", async () => {
    const first = mount();
    await countOneLine();
    first.unmount();

    // "Gin" was deleted between the interruption and the resume. Its counted
    // line must not survive into the POST as a line for a row that is gone —
    // and with nothing left to restore there is nothing to announce either.
    // (The test above is the positive control for that announcement.)
    mount({ items: [ITEMS[1]] });
    expect(await screen.findByText("Mælk")).toBeInTheDocument();
    expect(screen.queryByText(/items were already done/)).toBeNull();
  });
});

describe("the X is a choice, not a trapdoor", () => {
  it("closes straight through when nothing has been counted", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await act(async () => { fireEvent.click(screen.getByLabelText("Close")); });
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(/Discard the count/)).toBeNull();
  });

  it("asks once a line has been counted, and offers both answers", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await countOneLine();
    await act(async () => { fireEvent.click(screen.getByLabelText("Close")); });

    expect(await screen.findByText("You're in the middle of a count")).toBeInTheDocument();
    expect(screen.getByText("Discard the count")).toBeInTheDocument();
    expect(screen.getByText("Save for later")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled(); // nothing happens until they answer
  });

  it("keeps the draft on the SAFE answer", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await countOneLine();
    await act(async () => { fireEvent.click(screen.getByLabelText("Close")); });
    await act(async () => { fireEvent.click(await screen.findByText("Save for later")); });

    expect(onClose).toHaveBeenCalled();
    expect(loadCountDraft("owner-1")).not.toBeNull();
  });

  it("only throws the count away on the deliberate red answer", async () => {
    mount({ onClose: () => {} });
    await countOneLine();
    await act(async () => { fireEvent.click(screen.getByLabelText("Close")); });
    await act(async () => { fireEvent.click(await screen.findByText("Discard the count")); });

    expect(loadCountDraft("owner-1")).toBeNull();
  });

  it("treats Escape as save, never as discard", async () => {
    // Esc and the backdrop both resolve the dialog as "cancel". Cancel is the
    // SAVE side on purpose: a guard whose accidental path is the lossy one is
    // not a guard.
    mount({ onClose: () => {} });
    await countOneLine();
    await act(async () => { fireEvent.click(screen.getByLabelText("Close")); });
    await screen.findByText("You're in the middle of a count");
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });

    expect(loadCountDraft("owner-1")).not.toBeNull();
  });
});

describe("a submitted count is not a pending one", () => {
  it("clears the draft only after the server has the numbers", async () => {
    mount();
    await countOneLine();            // item a
    await countOneLine();            // item b → finish
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      "/inventory/count/reconcile", expect.anything(),
    ));
    await waitFor(() => expect(loadCountDraft("owner-1")).toBeNull());
  });

  it("keeps the draft when the reconcile fails", async () => {
    apiPost.mockRejectedValueOnce({ response: { data: { detail: "nej" } } });
    mount();
    await countOneLine();
    await countOneLine();
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    // The owner walked the cold room for these lines. A failed POST must not
    // be the thing that deletes them.
    expect(loadCountDraft("owner-1")).not.toBeNull();
  });
});
