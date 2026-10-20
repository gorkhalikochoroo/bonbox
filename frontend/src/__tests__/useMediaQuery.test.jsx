/**
 * useMediaQuery (booking push p3) builds ONE MediaQueryList per query and
 * reads its .matches on every render — the booking page re-renders on every
 * keystroke in the guest form, and a new list per render was a wasted
 * allocation and evaluation each time. It still follows the list's change
 * event, and is false without matchMedia (jsdom, an old browser).
 */
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../hooks/useMediaQuery";

afterEach(() => {
  cleanup();
  delete window.matchMedia;
});

function Probe({ onRender }) {
  const [n, setN] = useState(0);
  const wide = useMediaQuery("(min-width: 1024px)");
  onRender(wide);
  return <button type="button" onClick={() => setN(n + 1)}>{String(wide)}</button>;
}

describe("useMediaQuery", () => {
  it("one MediaQueryList across re-renders, following its change event", () => {
    let listener = null;
    const mql = {
      matches: false, media: "(min-width: 1024px)",
      addEventListener: (_e, fn) => { listener = fn; }, removeEventListener: () => { listener = null; },
    };
    window.matchMedia = vi.fn(() => mql);
    const seen = [];
    const { getByRole } = render(<Probe onRender={(v) => seen.push(v)} />);
    for (let i = 0; i < 5; i++) act(() => { getByRole("button").click(); });
    expect(window.matchMedia).toHaveBeenCalledTimes(1);
    expect(getByRole("button").textContent).toBe("false");
    act(() => { mql.matches = true; listener?.(); });
    expect(getByRole("button").textContent).toBe("true");
    expect(window.matchMedia).toHaveBeenCalledTimes(1);
  });

  it("is false without matchMedia", () => {
    delete window.matchMedia;
    const { getByRole } = render(<Probe onRender={() => {}} />);
    expect(getByRole("button").textContent).toBe("false");
  });
});
