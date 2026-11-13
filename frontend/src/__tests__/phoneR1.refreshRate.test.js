/**
 * Phone R1, 120 Hz ("phones are 120 Hz… also iPad laptop 90 or 120 Hz so
 * those as well"). What lets the owner app and Vagtplan run at the screen's
 * own rate, and what keeps their motion the same at 60, 90, 120 or 144 Hz:
 *
 *   • iOS: both apps carry CADisableMinimumFrameDurationOnPhone = true in the
 *     top-level Info.plist dict. Without it a ProMotion iPhone holds the app's
 *     Core Animation work (the web view's compositor animations) at 60 Hz.
 *     iPad ProMotion needs no key.
 *   • Android: nothing in either app caps the refresh rate (no preferred
 *     refresh rate or display mode, no software layer, no hardware
 *     acceleration turned off).
 *   • The motion files animate the compositor's properties only (transform /
 *     opacity; the one exception is the clock-in ring's stroke, drawn once),
 *     never a layout property in a transition, and will-change sits on the
 *     dock's one sliding indicator only.
 *   • The motion modules are timed in ms: no setInterval, no frame-length
 *     constant (16.7 ms, 1000 / 60). The logic itself is run at 60/90/120/144
 *     Hz in spring.test.js, sheetDrag.test.jsx and scanPace.test.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");

describe("iOS: both apps opt in to ProMotion on iPhone", () => {
  for (const plistPath of ["ios/App/App/Info.plist", "ios-scheduler/App/App/Info.plist"]) {
    it(`${plistPath}: CADisableMinimumFrameDurationOnPhone is true, once, in the top-level dict`, () => {
      const plist = read(plistPath);
      const matches = [...plist.matchAll(/<key>CADisableMinimumFrameDurationOnPhone<\/key>\s*(<true\/>|<false\/>)/g)];
      expect(matches).toHaveLength(1);
      expect(matches[0][1]).toBe("<true/>");
      // Depth: opened minus closed <dict> before the key — 1 is the plist's own dict.
      const before = plist.slice(0, matches[0].index);
      const depth = (before.match(/<dict>/g) || []).length - (before.match(/<\/dict>/g) || []).length;
      expect(depth).toBe(1);
    });
  }
});

describe("Android: nothing caps the refresh rate", () => {
  const files = [
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/java/dk/bonbox/app/MainActivity.java",
    "android-scheduler/app/src/main/AndroidManifest.xml",
    "android-scheduler/app/src/main/java/dk/bonbox/scheduler/MainActivity.java",
  ];
  for (const f of files) {
    it(f, () => {
      const src = read(f);
      expect(src).not.toMatch(/preferredRefreshRate|preferredDisplayModeId|setFrameRate|LAYER_TYPE_SOFTWARE|FRAME_RATE/);
      expect(src).not.toMatch(/hardwareAccelerated\s*=\s*"false"/);
    });
  }
});

/** Splits a CSS value at top-level commas (cubic-bezier(.2, .8, …) stays whole). */
function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const MOTION_CSS = [
  "src/components/today/today.css",
  "src/components/staff/vagtplan.css",
  "src/components/staff/vagtplanPad.css",
  "src/components/owner/ownerShell.css",
];
const COMPOSITOR = new Set(["transform", "opacity", "translate", "scale", "rotate"]);
// The clock-in ring draws itself once (CLOCK-MOTION-SPEC 2.1): an SVG stroke, 640 ms, then still.
const KEYFRAME_EXCEPTIONS = { "vp-ring-draw": ["stroke-dashoffset"] };
// Paint only, no layout: colour fades on a press or a hover.
const PAINT = new Set(["color", "background-color", "border-color", "box-shadow"]);

describe("the motion CSS animates the compositor's properties", () => {
  for (const f of MOTION_CSS) {
    const css = stripCssComments(read(f));

    it(`${f}: every @keyframes moves transform / opacity only`, () => {
      const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)];
      expect(blocks.length).toBe((css.match(/@keyframes/g) || []).length);   // every block read, none skipped
      for (const m of blocks) {
        const [, name, body] = m;
        const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]));
        for (const p of props) {
          if (COMPOSITOR.has(p) || KEYFRAME_EXCEPTIONS[name]?.includes(p)) continue;
          throw new Error(`${f} @keyframes ${name} animates ${p}`);
        }
      }
    });

    it(`${f}: no transition on a layout property (or on "all")`, () => {
      const decls = [...css.matchAll(/(?<![\w-])transition(-property)?\s*:\s*([^;}]+)/g)];
      expect(decls.length).toBe((css.match(/(?<![\w-])transition(-property)?\s*:/g) || []).length);
      for (const m of decls) {
        const [, isProp, value] = m;
        for (const part of splitTop(value)) {
          const prop = isProp ? part : part.split(/\s+/)[0];
          if (prop === "none") continue;
          expect(COMPOSITOR.has(prop) || PAINT.has(prop), `${f}: transition on ${prop}`).toBe(true);
        }
      }
    });
  }

  it("will-change only on the dock's one sliding indicator (Vagtplan's and the owner's)", () => {
    const owners = [];
    for (const f of MOTION_CSS) {
      const css = stripCssComments(read(f));
      for (const m of css.matchAll(/([^{}]+)\{[^}]*will-change\s*:/g)) owners.push(m[1].trim());
    }
    expect(owners.sort()).toEqual([".ow-dock-ind", ".vp-dock-ind"]);
  });
});

describe("the motion modules are timed in ms, never in frames", () => {
  const MODULES = [
    "src/components/staff/spring.js",
    "src/components/staff/sheetDrag.js",
    "src/components/staff/sheetMotion.js",
    "src/components/staff/pressFeel.js",
    "src/components/staff/RollingDigits.jsx",
    "src/components/staff/clockBeat.js",
    "src/components/today/todayMotion.jsx",
    "src/components/MobileBottomNav.jsx",
    "src/lib/scanPace.js",
  ];
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const f of MODULES) {
    it(f, () => {
      const src = code(read(f));
      expect(src).not.toMatch(/setInterval\s*\(/);
      expect(src).not.toMatch(/16\.6|16\.7|1000\s*\/\s*60\b|\/\s*60\s*;/);
    });
  }
});
