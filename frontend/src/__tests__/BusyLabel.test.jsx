/**
 * Busy → done inside the button (premium feel P6 / 1.7, components/staff/BusyLabel.jsx).
 *
 *   • Most answers land within 300 ms and never show a ring: idle until then,
 *     the ring from 300 ms, the label back at once when the wait ends.
 *   • `hold` freezes what was showing (no ring appears on a card that is
 *     fading out; a ring that was showing stays).
 *   • `done` shows the check; useDoneFlash keeps it 900 ms.
 *   • Label, ring and check share ONE grid cell (the button never changes
 *     size), and the label is always in the DOM (the accessible name never
 *     changes).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BusyLabel, { BUSY_WAIT_MS, DONE_HOLD_MS, useDoneFlash } from "../components/staff/BusyLabel";

const state = () => document.querySelector(".vp-busy").dataset.state;
const later = (ms) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the numbers", () => {
  it("ring after 300 ms; the check holds 900 ms", () => {
    expect(BUSY_WAIT_MS).toBe(300);
    expect(DONE_HOLD_MS).toBe(900);
  });
});

describe("busy", () => {
  it("idle at 0 and 299 ms, busy at 301 ms, idle again at once when the wait ends", () => {
    const { rerender } = render(<button type="button" disabled><BusyLabel busy>Tag den</BusyLabel></button>);
    expect(state()).toBe("idle");
    later(299);
    expect(state()).toBe("idle");
    later(2);
    expect(state()).toBe("busy");
    rerender(<button type="button"><BusyLabel busy={false}>Tag den</BusyLabel></button>);
    expect(state()).toBe("idle");
  });

  it("a wait that ends before 300 ms never shows a ring, and the next wait starts from zero", () => {
    const { rerender } = render(<BusyLabel busy>Send</BusyLabel>);
    later(250);
    rerender(<BusyLabel busy={false}>Send</BusyLabel>);
    later(100);
    expect(state()).toBe("idle");
    rerender(<BusyLabel busy>Send</BusyLabel>);
    later(299);
    expect(state()).toBe("idle");
    later(1);
    expect(state()).toBe("busy");
  });
});

describe("hold", () => {
  it("freezes idle: no ring at 301 ms on a card that is fading out", () => {
    const { rerender } = render(<BusyLabel busy={false}>Stempl ud</BusyLabel>);
    rerender(<BusyLabel busy hold>Stempl ud</BusyLabel>);
    later(301);
    expect(state()).toBe("idle");
    later(2000);
    expect(state()).toBe("idle");
  });

  it("freezes busy: the ring stays when busy goes false under hold", () => {
    const { rerender } = render(<BusyLabel busy>Stempl ud</BusyLabel>);
    later(301);
    expect(state()).toBe("busy");
    rerender(<BusyLabel busy={false} hold>Stempl ud</BusyLabel>);
    expect(state()).toBe("busy");
    later(1000);
    expect(state()).toBe("busy");
  });
});

describe("done", () => {
  function Claim() {
    const [done, flash] = useDoneFlash();
    return (
      <button type="button" onClick={flash} disabled={done}>
        <BusyLabel done={done}>Tag den</BusyLabel>
      </button>
    );
  }

  it("done shows the check (it wins over busy)", () => {
    render(<BusyLabel busy done>Gem</BusyLabel>);
    later(400);
    expect(state()).toBe("done");
  });

  it("useDoneFlash: the check for 900 ms, then the label again", () => {
    render(<Claim />);
    expect(state()).toBe("idle");
    fireEvent.click(screen.getByRole("button"));
    expect(state()).toBe("done");
    expect(screen.getByRole("button").disabled).toBe(true);
    later(899);
    expect(state()).toBe("done");
    later(1);
    expect(state()).toBe("idle");
    expect(screen.getByRole("button").disabled).toBe(false);
  });

  // Fix round (busy-done-window): flash(settled) also waits for the reload
  // that removes the row, so a slow reload never shows an enabled label.
  function Held({ settled }) {
    const [done, flash] = useDoneFlash();
    return (
      <button type="button" onClick={() => flash(settled)} disabled={done}>
        <BusyLabel done={done}>Tag den</BusyLabel>
      </button>
    );
  }
  async function answer(fn) {
    await act(async () => { fn(); for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
  }

  it("flash(settled): the check holds past 900 ms until the promise settles, then the label", async () => {
    let done;
    render(<Held settled={new Promise((r) => { done = r; })} />);
    fireEvent.click(screen.getByRole("button"));
    later(900);
    expect(state()).toBe("done");
    later(5000);
    expect(state()).toBe("done");
    expect(screen.getByRole("button").disabled).toBe(true);
    await answer(() => done());
    expect(state()).toBe("idle");
    expect(screen.getByRole("button").disabled).toBe(false);
  });

  it("flash(settled): a reload that fails ends the hold too; one that answers early still gets its 900 ms", async () => {
    let fail;
    const { unmount } = render(<Held settled={new Promise((_, r) => { fail = r; })} />);
    fireEvent.click(screen.getByRole("button"));
    later(1000);
    await answer(() => fail(new Error("offline")));
    expect(state()).toBe("idle");
    unmount();
    render(<Held settled={Promise.resolve()} />);
    fireEvent.click(screen.getByRole("button"));
    await answer(() => {});
    later(899);
    expect(state()).toBe("done");
    later(1);
    expect(state()).toBe("idle");
  });
});

describe("one object", () => {
  it("label, ring and check are the grid's three children; the ring and check are hidden from readers", () => {
    render(<BusyLabel busy>Accepter</BusyLabel>);
    const box = document.querySelector(".vp-busy");
    expect(box.tagName).toBe("SPAN");
    const kids = [...box.children];
    expect(kids).toHaveLength(3);
    expect(kids[0].getAttribute("class")).toBe("vp-busy-label");
    expect(kids[1].getAttribute("class")).toBe("vp-busy-spin vp-ring");
    expect(kids[2].getAttribute("class")).toContain("vp-busy-check");
    expect(kids[1].getAttribute("aria-hidden")).toBe("true");
    expect(kids[2].getAttribute("aria-hidden")).toBe("true");
  });

  it("the label stays in the DOM in every state, so the button's name never changes", () => {
    const { rerender } = render(<button type="button"><BusyLabel>Gemmer…</BusyLabel></button>);
    const name = () => screen.getByRole("button").textContent;
    expect(name()).toBe("Gemmer…");
    rerender(<button type="button"><BusyLabel busy>Gemmer…</BusyLabel></button>);
    later(400);
    expect(state()).toBe("busy");
    expect(name()).toBe("Gemmer…");
    rerender(<button type="button"><BusyLabel done>Gemmer…</BusyLabel></button>);
    expect(state()).toBe("done");
    expect(name()).toBe("Gemmer…");
    expect(screen.getByRole("button", { name: "Gemmer…" })).toBeTruthy();
  });
});
