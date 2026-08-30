/**
 * useUndoToast — the recovery affordance behind every soft delete.
 *
 * Deleting a sale, expense, waste log or cashbook entry is a soft delete with a
 * working restore endpoint, but until now the only route back was knowing that
 * More → Recently Deleted exists and then picking the right tab. This hook is
 * what turns that into one tap, so the parts that can silently fail matter:
 *
 *   • The action label was HARDCODED "Undo" while `undo` and `dismiss` had
 *     Danish translations sitting unused — so a Danish owner met an English
 *     word on the one control they reach for when something just went wrong.
 *   • A failed undo must NOT dismiss. The hook's own docstring promises the
 *     toast stays up showing the error "so the user knows the undo didn't take
 *     effect" — if it closed on failure, the owner would believe their sale was
 *     back when it was still deleted. That is the dangerous direction.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// t() echoes a marker so a hardcoded English string can't pass as translated.
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k) => `DA:${k}`,
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));

const { useUndoToast } = await import("../hooks/useUndoToast");

/** Minimal host: fires the toast, renders whatever the hook returns. */
function Host({ onUndo, message = "Salg flyttet til papirkurv" }) {
  const { show, ToastUI } = useUndoToast();
  return (
    <>
      <button onClick={() => show({ message, onUndo })}>fire</button>
      {ToastUI}
    </>
  );
}

describe("useUndoToast", () => {
  it("renders nothing until something is deleted", () => {
    render(<Host onUndo={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the message once fired", () => {
    render(<Host onUndo={vi.fn()} />);
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByRole("status").textContent).toContain(
      "Salg flyttet til papirkurv",
    );
  });

  it("labels the action with the TRANSLATED string, not a hardcoded 'Undo'", () => {
    render(<Host onUndo={vi.fn()} />);
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByText("DA:undo")).toBeTruthy();
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("translates the dismiss control's accessible name too", () => {
    render(<Host onUndo={vi.fn()} />);
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByLabelText("DA:dismiss")).toBeTruthy();
  });

  it("runs the restore handler and closes on success", async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    render(<Host onUndo={onUndo} />);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByText("DA:undo"));

    await waitFor(() => expect(onUndo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("STAYS OPEN when the restore fails, so nobody thinks it came back", async () => {
    // The dangerous direction: closing here reads as "restored".
    const onUndo = vi.fn().mockRejectedValue(new Error("network"));
    render(<Host onUndo={onUndo} />);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByText("DA:undo"));

    await waitFor(() => expect(onUndo).toHaveBeenCalled());
    expect(screen.getByRole("status")).toBeTruthy();
    // ...and the undo button is gone, so it can't be mistaken for "try again".
    expect(screen.queryByText("DA:undo")).toBeNull();
  });

  it("surfaces the translated failure text when the error carries none", async () => {
    render(<Host onUndo={vi.fn().mockRejectedValue({})} />);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByText("DA:undo"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("DA:undoFailed"),
    );
  });

  it("can be dismissed by hand without restoring anything", () => {
    const onUndo = vi.fn();
    render(<Host onUndo={onUndo} />);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByLabelText("DA:dismiss"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("replaces the previous toast rather than stacking two undos", () => {
    // Deliberately UNLIKE useToast (which stacks): two live undo buttons would
    // be ambiguous about which delete they reverse.
    render(<Host onUndo={vi.fn()} />);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getAllByText("DA:undo")).toHaveLength(1);
  });
});
