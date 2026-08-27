/**
 * useToast — the replacement for the 20 native alert() call sites (C-8).
 *
 * These exist because the thing being replaced was BLOCKING and this is not,
 * so the risky parts are not "does a box appear" but:
 *
 *   • messages STACK rather than overwrite. WineListPage's handleSaveAll loops
 *     handleSave, so N failing rows used to raise N stacked blocking dialogs.
 *     With a single-slot toast a multi-row failure would collapse into one
 *     message and the owner would silently under-count their failures.
 *   • a critical message interrupts a screen reader (role=alert) while a
 *     success does not — an error the owner misses is worse than the dialog.
 *   • useToast() outside its provider must never throw. useConfirm() documents
 *     that same guarantee, "so a stray import can never crash a screen", and a
 *     component exploding on first render has shipped a prod-down page here.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "../hooks/useToast";

/** Renders a button per message so a test can fire them in order. */
function Trigger({ messages }) {
  const toast = useToast();
  return (
    <>
      {messages.map((m, i) => (
        <button key={i} onClick={() => toast(m)}>
          fire{i}
        </button>
      ))}
    </>
  );
}

const withProvider = (messages) =>
  render(
    <ToastProvider>
      <Trigger messages={messages} />
    </ToastProvider>,
  );

describe("useToast", () => {
  it("shows the message that was passed", () => {
    withProvider([{ message: "Could not save", severity: "critical" }]);
    expect(screen.queryByText("Could not save")).toBeNull(); // nothing before firing
    fireEvent.click(screen.getByText("fire0"));
    expect(screen.getByText("Could not save")).toBeTruthy();
  });

  it("accepts a bare string as well as an options object", () => {
    withProvider(["plain string message"]);
    fireEvent.click(screen.getByText("fire0"));
    expect(screen.getByText("plain string message")).toBeTruthy();
  });

  it("STACKS messages instead of replacing them", () => {
    // The handleSaveAll case: three rows fail in the same tick.
    withProvider([
      { message: "Row 1 failed", severity: "critical" },
      { message: "Row 2 failed", severity: "critical" },
      { message: "Row 3 failed", severity: "critical" },
    ]);
    fireEvent.click(screen.getByText("fire0"));
    fireEvent.click(screen.getByText("fire1"));
    fireEvent.click(screen.getByText("fire2"));
    expect(screen.getByText("Row 1 failed")).toBeTruthy();
    expect(screen.getByText("Row 2 failed")).toBeTruthy();
    expect(screen.getByText("Row 3 failed")).toBeTruthy();
  });

  it("interrupts for a critical message but not for a success", () => {
    withProvider([
      { message: "Send failed", severity: "critical" },
      { message: "Faktura emailed", severity: "success" },
    ]);
    fireEvent.click(screen.getByText("fire0"));
    fireEvent.click(screen.getByText("fire1"));
    expect(screen.getByRole("alert").textContent).toContain("Send failed");
    expect(screen.getByRole("status").textContent).toContain("Faktura emailed");
  });

  it("can be dismissed by hand before it times out", () => {
    withProvider([{ message: "Dismiss me", severity: "info" }]);
    fireEvent.click(screen.getByText("fire0"));
    expect(screen.getByText("Dismiss me")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("ignores an empty message rather than flashing a blank card", () => {
    withProvider([{ message: "   ", severity: "critical" }]);
    fireEvent.click(screen.getByText("fire0"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not throw when used outside the provider", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No <ToastProvider> — mirrors useConfirm()'s stray-import guarantee.
    render(<Trigger messages={[{ message: "orphaned", severity: "critical" }]} />);
    expect(() => fireEvent.click(screen.getByText("fire0"))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
