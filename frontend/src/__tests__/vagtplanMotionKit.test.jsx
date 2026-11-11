/**
 * The Vagtplan's Orvexlo type + motion kit (Nov 2026), below the page:
 *
 *   • Fonts: Sora + DM Sans are imported ONLY by the staff portal's entry
 *     (pages/StaffPortalPage.jsx and its vagtplan.css) — never by main.jsx,
 *     so no other page pays — and Manrope is gone. Latin files per weight;
 *     latin-ext only through unicode-range rules.
 *   • vagtplan.css: the kit's tokens, the dock's geometry, and ONE
 *     prefers-reduced-motion block that turns every vp- animation and
 *     transition off.
 *   • RollingDigits: the right value, nothing rolls on the first paint, only
 *     changed digits roll (up when the value grew, down when it shrank), and
 *     a plain single text node where motion is reduced or cannot be asked.
 *   • usePresence: an exit window with motion, none without.
 *   • useConfirm on the portal: the answer is instant, the dialog lingers
 *     for its exit; everywhere else it unmounts at once (owner app unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RollingDigits from "../components/staff/RollingDigits";
import { usePresence, useLastValue, EXIT_MS, exitMs } from "../components/staff/sheetMotion";
import { LanguageProvider } from "../hooks/useLanguage";
import { ConfirmProvider, useConfirm } from "../hooks/useConfirm";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const CSS = read("components/staff/vagtplan.css");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

afterEach(() => {
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
  vi.useRealTimers();
});

describe("Fonts: Sora + DM Sans, self-hosted, loaded by the staff portal only", () => {
  const files = walk(SRC);
  const importers = (pkg) => files
    .filter((f) => read(path.relative(SRC, f)).includes(pkg))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  it("only the portal entry (the page + its vagtplan.css) references them; main.jsx does not", () => {
    expect(importers("@fontsource/sora")).toEqual(["components/staff/vagtplan.css", "pages/StaffPortalPage.jsx"]);
    expect(importers("@fontsource/dm-sans")).toEqual(["components/staff/vagtplan.css", "pages/StaffPortalPage.jsx"]);
    expect(read("main.jsx")).not.toMatch(/sora|dm-sans/i);
    // The stylesheet itself is imported by the portal page and nowhere else.
    expect(importers("staff/vagtplan.css")).toEqual(["pages/StaffPortalPage.jsx"]);
  });

  it("the weights asked for, latin per weight, and vagtplan.css after them (its latin-ext rules must follow)", () => {
    const page = read("pages/StaffPortalPage.jsx");
    const imports = [...page.matchAll(/^import "(@fontsource\/[^"]+|\.\.\/components\/staff\/vagtplan\.css)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "@fontsource/sora/latin-600.css",
      "@fontsource/sora/latin-700.css",
      "@fontsource/dm-sans/latin-400.css",
      "@fontsource/dm-sans/latin-500.css",
      "@fontsource/dm-sans/latin-600.css",
      "@fontsource/dm-sans/latin-700.css",
      "../components/staff/vagtplan.css",
    ]);
  });

  it("latin-ext comes only through unicode-range rules (never fontsource's range-less latin-ext css)", () => {
    const faces = CSS.match(/@font-face\s*\{[^}]*\}/g) || [];
    expect(faces).toHaveLength(6);   // Sora 600/700 + DM Sans 400/500/600/700
    for (const f of faces) {
      expect(f).toMatch(/latin-ext-\d00-normal\.woff2/);
      expect(f).toMatch(/unicode-range: U\+0100-0130,/);
      // Never a range the latin file already draws (æ ø å are U+00E6 U+00F8 U+00E5).
      expect(f).not.toMatch(/U\+0000-00FF/);
    }
    for (const f of walk(SRC)) expect(read(path.relative(SRC, f))).not.toMatch(/@fontsource\/(sora|dm-sans)\/latin-ext/);
  });

  it("Manrope is gone: no import, no dependency", () => {
    for (const f of walk(SRC)) expect(read(path.relative(SRC, f))).not.toMatch(/@fontsource\/manrope/);
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
    expect(pkg.dependencies["@fontsource/manrope"]).toBeUndefined();
    expect(pkg.dependencies["@fontsource/sora"]).toBeTruthy();
    expect(pkg.dependencies["@fontsource/dm-sans"]).toBeTruthy();
  });

  it("on the portal, the text and display faces ARE DM Sans and Sora, with system fallbacks, smoothed, no tap flash", () => {
    const block = CSS.match(/body\.portal-shell \{[^}]*\}/)[0];
    expect(block).toMatch(/--font-display: 'Sora', 'DM Sans', ui-sans-serif, system-ui/);
    expect(block).toMatch(/--font-text: 'DM Sans', ui-sans-serif, system-ui/);
    expect(block).toContain("font-family: var(--font-text);");
    expect(block).toContain("-webkit-font-smoothing: antialiased;");
    expect(block).toContain("-webkit-tap-highlight-color: transparent;");
  });
});

describe("vagtplan.css: the kit's tokens and the dock", () => {
  it("timing and easing tokens, springs as linear() with a cubic-bezier fallback", () => {
    for (const tok of [
      "--dur-press: 0.11s", "--dur-fast: 0.18s", "--dur-base: 0.32s", "--dur-exit: 0.24s",
      "--dur-slow: 0.64s", "--dur-nav: 0.42s", "--dur-nav-back: 0.36s", "--dur-spring: 0.5s",
      "--ease-nav: cubic-bezier(.32, .72, 0, 1)", "--ease-out: cubic-bezier(.2, .8, .2, 1)",
      "--spring: cubic-bezier(.34, 1.4, .64, 1)", "--spring-soft: cubic-bezier(.3, 1.15, .5, 1)",
    ]) expect(CSS).toContain(tok);
    expect(CSS).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\) \{\s*body\.portal-shell \{\s*--spring: linear\(/);
  });

  it("the dock: light warm bar, 52 tall (48 under 360), radius h/2, 12 px in, 8 over the safe area, max 560", () => {
    const dock = CSS.match(/\.vp-dock \{[^}]*\}/)[0];
    expect(dock).toContain("position: fixed;");
    expect(dock).toContain("height: 52px;");
    expect(dock).toContain("border-radius: 26px;");
    expect(dock).toContain("max-width: 560px;");
    expect(dock).toContain("left: max(12px, env(safe-area-inset-left, 0px));");
    expect(dock).toContain("bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);");
    expect(dock).toContain("background: rgba(255, 253, 249, 0.97);");
    expect(dock).toContain("inset 0 1px 0 #ffffffb3");
    expect(dock).not.toMatch(/position: sticky|backdrop-filter/);
    expect(CSS).toMatch(/@media \(max-width: 359px\) \{\s*\.vp-dock \{ height: 48px; border-radius: 24px; \}/);
  });

  it("ONE indicator a column wide, moved by transform only, on the soft spring", () => {
    const ind = CSS.match(/\.vp-dock-ind \{[^}]*\}/)[0];
    expect(ind).toContain("width: calc((100% - 10px) / var(--n, 5));");
    expect(ind).toContain("transform: translateX(calc(var(--i, 0) * 100%));");
    expect(ind).toContain("transition: transform var(--dur-spring) var(--spring-soft), opacity var(--dur-fast) var(--ease-out);");
    expect(CSS).toMatch(/\.vp-dock-item:active \{ transform: scale\(\.96\); \}/);
    expect(CSS).toMatch(/@keyframes vp-label-in \{ from \{ opacity: \.15; transform: scale\(\.55\); \} \}/);
  });

  it("motion is transform + opacity only: no keyframe animates a layout property", () => {
    const frames = CSS.match(/@keyframes [\w-]+ \{[\s\S]*?\}\s*\}/g) || [];
    expect(frames.length).toBeGreaterThan(8);
    for (const k of frames) {
      const props = [...k.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      for (const p of props) expect(["opacity", "transform"]).toContain(p);
    }
  });
});

describe("Reduced motion: ONE block turns all of it off", () => {
  const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
  const start = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  const body = CSS.slice(start);

  it("there is exactly one", () => {
    expect(blocks).toHaveLength(1);
  });

  it("every vp- class that animates or transitions is in it", () => {
    const animated = new Set();
    for (const m of CSS.slice(0, start).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\b(animation|transition)\s*:/.test(m[2])) continue;
      if (/@keyframes|from|to\b|%/.test(m[1].trim().split("\n").pop())) continue;
      for (const c of m[1].matchAll(/\.(vp-[\w-]+)/g)) animated.add(c[1]);
    }
    expect([...animated].sort()).toEqual(expect.arrayContaining(["vp-breathe", "vp-dock-ind", "vp-dock-item", "vp-label-in", "vp-map-in", "vp-pop", "vp-press", "vp-roll-down", "vp-roll-up", "vp-scrim", "vp-screen-in", "vp-sheet", "vp-shimmer"]));
    for (const c of animated) expect(body).toContain(`.${c}`);
    expect(body).toMatch(/animation: none;/);
    expect(body).toMatch(/transition: none;/);
    // The shared confirm's portal motion too.
    expect(body).toContain("[data-bb-confirm] > [data-bb-confirm-panel]");
  });

  it("the JS side reads the same query: no exit window under reduced motion, nor without matchMedia", () => {
    delete window.matchMedia;
    expect(exitMs()).toBe(0);
    motionPref({ reduce: true });
    expect(exitMs()).toBe(0);
    motionPref({ reduce: false });
    expect(exitMs()).toBe(EXIT_MS);
    expect(EXIT_MS).toBe(240);
  });
});

describe("RollingDigits", () => {
  const rolled = (el) => [...el.querySelectorAll(".vp-roll-up, .vp-roll-down")].map((s) => `${s.textContent}${s.className.includes("down") ? "↓" : "↑"}`);

  it("renders the value; nothing rolls on the first paint", () => {
    motionPref({ reduce: false });
    const { container } = render(<RollingDigits value="2:16" />);
    const el = container.firstChild;
    expect(el.textContent).toBe("2:16");
    expect(rolled(el)).toEqual([]);
  });

  it("only the digits that changed roll — up when the value grew", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="2:16" />);
    rerender(<RollingDigits value="2:17" />);
    expect(container.firstChild.textContent).toBe("2:17");
    expect(rolled(container.firstChild)).toEqual(["7↑"]);
    rerender(<RollingDigits value="2:20" />);
    expect(container.firstChild.textContent).toBe("2:20");
    expect(rolled(container.firstChild)).toEqual(["2↑", "0↑"]);
    // A carry across the colon and a new column: still one direction, right text.
    rerender(<RollingDigits value="9:59" />);
    rerender(<RollingDigits value="10:00" />);
    expect(container.firstChild.textContent).toBe("10:00");
    expect(rolled(container.firstChild)).toEqual(["1↑", "0↑", "0↑", "0↑"]);
  });

  it("rolls down when the value shrank (a shorter period), and a re-render with the same value replays nothing", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="37,5" />);
    rerender(<RollingDigits value="31,5" />);
    expect(container.firstChild.textContent).toBe("31,5");
    expect(rolled(container.firstChild)).toEqual(["1↓"]);
    const digit = container.querySelector(".vp-roll-down");
    rerender(<RollingDigits value="31,5" />);
    // Same element: its animation is not restarted.
    expect(container.querySelector(".vp-roll-down")).toBe(digit);
  });

  it("numbers as well as strings", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value={4} />);
    rerender(<RollingDigits value={5} />);
    expect(container.firstChild.textContent).toBe("5");
    expect(rolled(container.firstChild)).toEqual(["5↑"]);
  });

  it("reduced motion (or no matchMedia): ONE plain text node, like the span it replaced", () => {
    for (const setup of [() => motionPref({ reduce: true }), () => { delete window.matchMedia; }]) {
      setup();
      const { container, rerender, unmount } = render(<RollingDigits value="1:05" />);
      rerender(<RollingDigits value="1:06" />);
      const el = container.firstChild;
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild.nodeType).toBe(Node.TEXT_NODE);
      expect(el.textContent).toBe("1:06");
      unmount();
    }
  });
});

describe("usePresence / useLastValue", () => {
  function Harness({ open, value }) {
    const p = usePresence(open);
    const v = useLastValue(value);
    return p.mounted ? <div data-testid="sheet" data-closing={p.closing ? "" : undefined}>{v}</div> : null;
  }

  it("with motion: closing for EXIT_MS (still showing the last value), then unmounted", () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    const { rerender } = render(<Harness open value="tir." />);
    rerender(<Harness open={false} value={null} />);
    const el = screen.getByTestId("sheet");
    expect(el.hasAttribute("data-closing")).toBe(true);
    expect(el.textContent).toBe("tir.");
    act(() => { vi.advanceTimersByTime(EXIT_MS - 1); });
    expect(screen.getByTestId("sheet")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("reduced motion: unmounted in the same render", () => {
    motionPref({ reduce: true });
    const { rerender } = render(<Harness open value="x" />);
    rerender(<Harness open={false} value={null} />);
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});

describe("useConfirm: the answer is instant; the exit plays only on the portal", () => {
  function Asker({ onAnswer }) {
    const confirm = useConfirm();
    return <button type="button" onClick={async () => onAnswer(await confirm({ title: "Stempl ud?", message: "m" }))}>ask</button>;
  }
  const mountAsker = (onAnswer) => {
    localStorage.setItem("lang", "da");
    return render(
      <LanguageProvider><ConfirmProvider><Asker onAnswer={onAnswer} /></ConfirmProvider></LanguageProvider>,
    );
  };

  it("on the portal with motion: resolves at the tap, lingers inert with data-closing, then goes", async () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    document.body.classList.add("portal-shell");
    const onAnswer = vi.fn();
    mountAsker(onAnswer);
    fireEvent.click(screen.getByText("ask"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("data-bb-confirm")).toBe(true);
    expect(dialog.hasAttribute("data-closing")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByText("Annuller")); });
    expect(onAnswer).toHaveBeenCalledWith(false);
    const leaving = document.querySelector("[data-bb-confirm]");
    expect(leaving.hasAttribute("data-closing")).toBe(true);
    expect(leaving.hasAttribute("inert")).toBe(true);
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(document.querySelector("[data-bb-confirm]")).toBeNull();
  });

  it("outside the portal (the owner app): unmounts at once, exactly as before", async () => {
    motionPref({ reduce: false });
    const onAnswer = vi.fn();
    mountAsker(onAnswer);
    fireEvent.click(screen.getByText("ask"));
    await act(async () => { fireEvent.click(screen.getByText("Annuller")); });
    expect(onAnswer).toHaveBeenCalledWith(false);
    expect(document.querySelector("[data-bb-confirm]")).toBeNull();
  });
});
