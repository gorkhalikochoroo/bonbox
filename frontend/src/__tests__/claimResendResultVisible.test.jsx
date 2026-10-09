/**
 * Release gate R-b (9 Oct): on a phone (390×844) the answer to "Send
 * spørgsmålet igen" rendered partly UNDER the fixed bottom tab bar (the
 * Team invite card near the bottom of the screen) — the owner tapped and saw
 * nothing until they scrolled.
 *
 * The answer is now brought into view when it appears, with a bottom scroll
 * margin that clears the tab bar (56 px + the safe area) — on a desktop, where
 * it is already in view, "nearest" moves nothing.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../services/api", () => ({ default: { post: h.post } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da" }),
}));

import ClaimQuestionResend from "../components/ClaimQuestionResend";

let scrolled;
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(opts) { scrolled.push({ el: this, opts }); };
  h.post.mockReset();
});

describe("'Send spørgsmålet igen' — the answer is seen", () => {
  it("brought into view clear of the bottom tab bar when it appears", async () => {
    h.post.mockResolvedValue({ data: { ok: true, sent_to: "ejer@cafe.dk" } });
    render(<ClaimQuestionResend testId="t" />);
    await act(async () => { fireEvent.click(screen.getByTestId("t")); });
    const result = screen.getByTestId("t-result");
    expect(result.textContent).toBe("claimResent");
    expect(scrolled.map((s) => s.el)).toContain(result);
    expect(scrolled.find((s) => s.el === result).opts).toMatchObject({ block: "nearest" });
    // The margin that keeps it above the fixed 56 px tab bar (+ safe area).
    expect(result.style.scrollMarginBottom).toMatch(/calc\(.*env\(safe-area-inset-bottom/);
  });

  it("a refusal is brought into view the same way", async () => {
    h.post.mockRejectedValue({ response: { status: 429, data: { detail: { message: "x", message_da: "Spørgsmålet er allerede sendt i dag." } } } });
    render(<ClaimQuestionResend testId="t" />);
    await act(async () => { fireEvent.click(screen.getByTestId("t")); });
    const result = screen.getByTestId("t-result");
    expect(result.textContent).toBe("Spørgsmålet er allerede sendt i dag.");
    expect(scrolled.map((s) => s.el)).toContain(result);
  });
});
