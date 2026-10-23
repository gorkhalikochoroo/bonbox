/**
 * LANDING V6 — the stylesheet stays inside the page (PORT_PLAN 1.6, port step 3).
 *
 * The landing's CSS rides in its lazy chunk and STAYS loaded after the visitor
 * leaves "/" for /register, /login or the app. So every rule in landingV6.css
 * must be scoped to the page root (.lp6), or reach html/body only through
 * :root:has(.lp6) — which stops matching the moment the page unmounts.
 * Global names (keyframes, registered custom properties) are prefixed lp6-,
 * because an @property registration is global whatever its selector.
 *
 * Also pinned: the overrides of the app's own global rules that the page does
 * not want (44 px touch min-height, smooth scroll, scroll padding), the v6.2 /
 * v6.3 rules the prototype was measured with, Tailwind not scanning the v6
 * folder, and the one extra font weight the page brings.
 *
 * The real-browser half (every computed style of the prototype vs the port, at
 * six sizes and six page states) is the lab's port-build/tools/css_parity.mjs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postcss from "postcss";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const FRONTEND = join(SRC, "..");
const V6 = join(SRC, "components", "landing", "v6");
const CSS_FILE = join(V6, "landingV6.css");
const read = (p) => readFileSync(p, "utf8");
const css = read(CSS_FILE);
const root = postcss.parse(css);
// the rules alone, comments dropped (the header comment names the unprefixed properties on purpose)
const bare = (() => {
  const r = postcss.parse(css);
  r.walkComments((c) => c.remove());
  return r.toString();
})();

// a selector list split at top-level commas (not inside :is(), :not(), [..])
const splitList = (s) => {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const inKeyframes = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === "atrule" && /keyframes$/i.test(p.name)) return true;
  return false;
};
const styleRules = [];
root.walkRules((r) => {
  if (!inKeyframes(r)) styleRules.push(r);
});
const selectors = styleRules.flatMap((r) => splitList(r.selector));
const rulesFor = (sel) => styleRules.filter((r) => splitList(r.selector).includes(sel));
const ruleFor = (sel) => rulesFor(sel)[0];
const mediaOfRule = (r) => (r && r.parent && r.parent.type === "atrule" && r.parent.name === "media" ? r.parent.params : null);
const declsOf = (rule) => {
  const o = {};
  rule.walkDecls((d) => {
    o[d.prop] = d.value + (d.important ? " !important" : "");
  });
  return o;
};

describe("landingV6.css — every selector is scoped to the page", () => {
  it("has a few hundred rules to check (the parse found the file)", () => {
    expect(selectors.length).toBeGreaterThan(600);
  });

  it("every selector starts with .lp6 or :root:has(.lp6)", () => {
    const bad = selectors.filter((s) => !/^(\.lp6(?![\w-])|:root:has\(\.lp6\)(?![\w-]))/.test(s));
    expect(bad).toEqual([]);
  });

  it("no selector names html, body or :root except through :root:has(.lp6)", () => {
    const bad = selectors.filter((s) => {
      const rest = s.replace(/^:root:has\(\.lp6\)( body)?/, "");
      return /(^|[\s>+~(,])(html|body)(?![\w-])|:root/.test(rest);
    });
    expect(bad).toEqual([]);
  });

  it("html/body rules set only the ground, the scroll behaviour and the page's own body box", () => {
    const allowed = {
      ":root:has(.lp6)": ["background", "scroll-behavior", "scroll-padding-top", "overscroll-behavior", "text-size-adjust", "-webkit-text-size-adjust"],
      ":root:has(.lp6) body": ["margin", "padding-left", "padding-right", "background", "overflow-x"],
    };
    const seen = [];
    for (const r of styleRules) {
      for (const s of splitList(r.selector)) {
        if (!s.startsWith(":root:has(.lp6)")) continue;
        expect(Object.keys(allowed)).toContain(s);
        r.walkDecls((d) => {
          seen.push(`${s} { ${d.prop} }`);
          expect(allowed[s]).toContain(d.prop);
        });
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("keyframes and registered custom properties carry the lp6- prefix, and every animation names only lp6- keyframes", () => {
    const keyframes = [];
    const props = [];
    root.walkAtRules((a) => {
      if (/keyframes$/i.test(a.name)) keyframes.push(a.params.trim());
      if (a.name === "property") props.push(a.params.trim());
    });
    expect(keyframes.sort()).toEqual(["lp6-barGrow", "lp6-dgIn", "lp6-dgOut", "lp6-rowFade", "lp6-rowRise"]);
    expect(props.sort()).toEqual(["--lp6-bx", "--lp6-by", "--lp6-draw", "--lp6-k"]);
    const names = new Set(keyframes);
    root.walkDecls(/^animation(-name)?$/, (d) => {
      const used = d.value.match(/\blp6-[\w-]+|\b(dgIn|dgOut|rowFade|rowRise|barGrow)\b/g) || [];
      for (const u of used) expect(names.has(u)).toBe(true);
    });
    // the unprefixed registered names never come back (--k0 / --ck are plain, unregistered properties)
    expect(bare).not.toMatch(/--(bx|by|k|draw)(?![\w-])/);
  });

  it("carries no @import, @font-face or remote url()", () => {
    // an @import would also make @tailwindcss/postcss compile this file as a Tailwind root
    const at = [];
    root.walkAtRules((a) => at.push(a.name));
    expect(at).not.toContain("import");
    expect(at).not.toContain("font-face");
    expect(bare).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
  });
});

describe("landingV6.css — the app's global rules the page does not want are undone on the page only", () => {
  it("the 44 px touch min-height on every a / button (index.css, pointer: coarse) is reset inside .lp6", () => {
    const app = read(join(SRC, "index.css"));
    expect(app).toMatch(/button:not\(\[role="switch"\]\), a, \[role="button"\],[\s\S]*?min-height: 44px/);
    const r = ruleFor(".lp6 :is(a,button,[role=button])");
    expect(r).toBeTruthy();
    expect(declsOf(r)["min-height"]).toBe("auto");
  });

  it("html scrolls the way the prototype was measured while the page is mounted: no smooth scroll, no scroll padding, the native bounce", () => {
    const decls = {};
    for (const r of styleRules) if (splitList(r.selector).includes(":root:has(.lp6)")) Object.assign(decls, declsOf(r));
    expect(decls["scroll-behavior"]).toBe("auto");
    expect(decls["scroll-padding-top"]).toBe("auto");
    expect(decls["overscroll-behavior"]).toBe("auto");
    expect(decls.background.toUpperCase()).toBe("#F6F4EC");
    // :root:has(.lp6) is 0,2,0 — it beats index.css's `html { scroll-behavior: smooth; overscroll-behavior: none }` (0,0,1)
    // and the old landing's `html:has([data-page="landing"]) { scroll-padding-top: 74px }` (0,1,1)
  });

  it("body is the prototype's page body while mounted: paper, no margin, no sideways scroll", () => {
    const d = declsOf(ruleFor(":root:has(.lp6) body"));
    expect(d).toEqual({ margin: "0", "padding-left": "0", "padding-right": "0", background: "#F6F4EC", "overflow-x": "clip" });
  });

  it("fix round: the safe-area side insets move from body (index.css) onto the root, so the stacked night band bleeds to both edges", () => {
    const app = read(join(SRC, "index.css"));
    expect(app).toMatch(/padding-left: env\(safe-area-inset-left\);\s*padding-right: env\(safe-area-inset-right\);/);
    const root = rulesFor(".lp6").map(declsOf).find((d) => d["padding-left"]);
    expect(root).toEqual({ "padding-left": "env(safe-area-inset-left,0px)", "padding-right": "env(safe-area-inset-right,0px)" });
    // the band's full bleed is measured from the root's content box, and the root is the clip box
    expect(declsOf(ruleFor(".lp6:not(.story) .nb"))["margin-inline"]).toBe("calc(50% - 50vw)");
    expect(rulesFor(".lp6").some((r) => declsOf(r)["overflow-x"] === "clip")).toBe(true);
    // body keeps its bottom padding (the cookie banner's --bb-consent-h rides on it) and its top inset
    const body = declsOf(ruleFor(":root:has(.lp6) body"));
    expect(body["padding-bottom"]).toBeUndefined();
    expect(body["padding-top"]).toBeUndefined();
  });

  it("fix round: index.css's touch press shrink (scale .97 on a / button / [role=button]:active) is undone inside .lp6", () => {
    const app = read(join(SRC, "index.css"));
    expect(app).toMatch(/button:active, a:active, \[role="button"\]:active \{\s*scale: 0\.97;/);
    expect(declsOf(ruleFor(".lp6 :is(a,button,[role=button]):active"))).toEqual({ scale: "none" });
  });

  it("fix round: until the engine's first layout every transition is off (.lp6-boot), so no hidden picture fades out at load", () => {
    const sels = [".lp6.lp6-boot", ".lp6.lp6-boot *", ".lp6.lp6-boot::before", ".lp6.lp6-boot::after", ".lp6.lp6-boot *::before", ".lp6.lp6-boot *::after"];
    for (const sel of sels) expect([sel, declsOf(ruleFor(sel))]).toEqual([sel, { transition: "none !important" }]);
    expect(splitList(ruleFor(".lp6.lp6-boot").selector).sort()).toEqual([...sels].sort());
    // the picture rule it holds back: story hides every later screen with a .22 s fade
    expect(declsOf(ruleFor(".lp6.story .fx")).transition).toMatch(/opacity \.22s/);
    expect(mediaOfRule(ruleFor(".lp6.lp6-boot"))).toBeNull();
  });

  it("fix round: the language switch in the footer always shows; only the top bar's steps aside, under 500 px, while the header's \"Prøv gratis\" is up", () => {
    const hiding = styleRules.filter((r) => /\.lang/.test(r.selector) && /display/.test(r.toString()) && declsOf(r).display === "none");
    expect(hiding.map((r) => [mediaOfRule(r), r.selector])).toEqual([["(max-width:499px)", ".lp6.js.cta-past:not(.dock-on) .top .lang"]]);
    // the footer's link list unsets every button (all:unset, padding 10px 0): the switch's own rule after it gives the 44 px box back
    expect(declsOf(ruleFor(".lp6 .foot .links .lang button"))).toMatchObject({ display: "inline-flex", position: "relative", padding: "0", width: "44px", height: "44px" });
    expect(declsOf(ruleFor(".lp6 .foot .links .lang"))["margin-left"]).toBe("-10px"); // the first flag on the links' left edge
  });

  it("flags round (23 Oct): two flags, each a 44 x 44 button; the page's language full colour over a 2 px line, the other at .45, full under hover and focus", () => {
    expect(declsOf(ruleFor(".lp6 .lang button"))).toMatchObject({ all: "unset", "box-sizing": "border-box", position: "relative", width: "44px", height: "44px", cursor: "pointer" });
    expect(declsOf(ruleFor(".lp6 .lang .flag"))).toMatchObject({ width: "24px", height: "18px", flex: "none" });
    expect(declsOf(ruleFor(".lp6 .lang button[aria-pressed=false] .flag"))).toEqual({ opacity: ".45" });
    expect(declsOf(ruleFor(".lp6 .lang button[aria-pressed=false]:focus-visible .flag"))).toEqual({ opacity: "1" });
    const hover = ruleFor(".lp6 .lang button[aria-pressed=false]:hover .flag");
    expect([mediaOfRule(hover), declsOf(hover)]).toEqual(["(hover:hover)", { opacity: "1" }]);
    // the state never rests on colour alone: a line under the pressed flag, in the one stroke that reads on paper and on night
    expect(declsOf(ruleFor(".lp6 .lang button[aria-pressed=true]::after"))).toMatchObject({ content: '""', position: "absolute", height: "2px", background: "var(--line)" });
    const tokens = declsOf(ruleFor(".lp6"));
    expect(tokens["--line"]).toBe("#71857A");
    for (const night of [".lp6[data-g=night]", ".lp6[data-x=np]"]) expect(declsOf(ruleFor(night))["--line"]).toBeUndefined();
    // a visible focus ring on every flag
    expect(declsOf(ruleFor(".lp6 .lang button:focus-visible"))).toMatchObject({ outline: "2px solid var(--fg)" });
    // nothing repaints a flag at the night edge: no crossing rule reaches .lang or .flag
    expect(selectors.filter((sel) => /\.xing/.test(sel) && /\.lang|\.flag/.test(sel))).toEqual([]);
    // the old DK · EN rules are gone (text, separator, current-as-text)
    expect(selectors.filter((sel) => /\.lang .*(\.sx|\.dot|\.lg-cur|\.lg-alt|\bb\b)/.test(sel))).toEqual([]);
  });

  it("the page root is its own stacking context with no transform (fixed bars still pin to the viewport)", () => {
    const decls = {};
    for (const r of styleRules) if (splitList(r.selector).includes(".lp6") && r.parent.type === "root") Object.assign(decls, declsOf(r));
    expect(decls).toMatchObject({ position: "relative", "z-index": "0", isolation: "isolate", background: "var(--paper)" });
    expect(decls.transform).toBeUndefined();
    expect(decls.filter).toBeUndefined();
  });
});

describe("landingV6.css — the measured v6.2 / v6.3 rules came across", () => {
  // some rule for exactly this selector declares prop: value (a selector can have several rules, e.g. .lp6 .next)
  const has = (sel, prop, value) => {
    const rs = rulesFor(sel);
    expect(rs.length, sel).toBeGreaterThan(0);
    if (!prop) return rs[0];
    const r = rs.find((x) => declsOf(x)[prop] === value);
    expect(r ? value : rs.map((x) => declsOf(x)[prop]), `${sel} { ${prop} }`).toBe(value);
    return r;
  };
  it("v6.2: a story page that drops under 600 px tall hides the stage screens (.cramp)", () => {
    has(".lp6.cramp .frame .fx", "visibility", "hidden");
  });
  it("v6.2: the 22.50 caption stays one line on phones", () => {
    const r = has(".lp6.story .stand figcaption.demo", "white-space", "nowrap");
    expect(r.parent.params).toBe("(max-width:767px)");
  });
  it("v6.3: a quick second tap on the stepper or the bottom bar is a tap, not a zoom, with no grey flash", () => {
    has(".lp6 .next", "touch-action", "manipulation");
    has(".lp6 .dock", "-webkit-tap-highlight-color", "transparent");
  });
  it("v6.2: the 7 / 7 row keeps Prøv gratis still and puts ← Forrige 96 px in from the right", () => {
    has(".lp6.story .sn-end .prev", "margin-right", "96px");
    has(".lp6.story .sn-end", "flex-wrap", "nowrap");
    has(".lp6.story .story-nav.lp6-end .sn-end");
  });
  it("v6.2: the footer mail link's focus ring hugs its own line", () => {
    has(".lp6 .foot .legal p a:focus-visible", "outline-offset", "-11px");
  });
  it("v6.3: the room still draws itself right after a stepper jump (.jd eases --lp6-draw)", () => {
    expect(declsOf(ruleFor(".lp6.story .room-svg.jd")).transition).toMatch(/^--lp6-draw 1s/);
  });
  it("the price section is #pricing (Terms § 8 links /#pricing), clear of the top bar", () => {
    has(".lp6 #pricing", "scroll-margin-top", "calc(var(--hh) + 8px)");
    expect(bare).not.toMatch(/#priser(?![\w-])/);
  });
  it("the colliding class names are prefixed: .lp6-glass, .lp6-ring, .lp6-end", () => {
    expect(selectors.some((s) => /\.lp6-glass(?![\w-])/.test(s))).toBe(true);
    expect(selectors.some((s) => /\.lp6-ring(?![\w-])/.test(s))).toBe(true);
    expect(selectors.some((s) => /\.lp6-end(?![\w-])/.test(s))).toBe(true);
    expect(selectors.filter((s) => /\.(glass|ring|end)(?![\w-])/.test(s))).toEqual([]);
  });
});

describe("landingV6.css — port step 4 (iOS Safari fixes after v6.3)", () => {
  const DESK = "(min-width:1024px) and (min-aspect-ratio:5/4)";
  const ONECOL = "not all and (min-width:1024px) and (min-aspect-ratio:5/4)";
  const mediaOf = (r) => (r.parent && r.parent.type === "atrule" && r.parent.name === "media" ? r.parent.params : null);

  it("a press on the stepper or on the bar's Prøv gratis shows as a short dim (the grey tap flash stays off)", () => {
    expect(declsOf(ruleFor(".lp6 .next:active"))).toEqual({ opacity: ".55" });
    expect(declsOf(ruleFor(".lp6 .dock .btn:active"))).toEqual({ opacity: ".78" });
    expect(mediaOf(ruleFor(".lp6 .next:active"))).toBeNull(); // every pointer, every size
    expect(rulesFor(".lp6 .dock").some((r) => declsOf(r)["-webkit-tap-highlight-color"] === "transparent")).toBe(true);
  });

  it("the bottom bar serves every one-column stage (iPad portrait too): only the two-column page hides it", () => {
    const hide = rulesFor(".lp6 .dock").filter((r) => declsOf(r).display === "none");
    expect(hide.map(mediaOf)).toEqual([DESK]);
    // the frame's own stepper row exists only on the two-column page; elsewhere the bar carries ← · Næste · n / 7
    expect(rulesFor(".lp6.story .story-nav").filter((r) => declsOf(r).display === "grid").map(mediaOf)).toEqual([DESK]);
    // the room reserved for the bar, the header's Prøv gratis while the bar is up, and the focus clearance follow the same line
    expect(rulesFor(".lp6").filter((r) => declsOf(r)["--dk"] === "0px").map(mediaOf)).toEqual([DESK]);
    expect(mediaOf(ruleFor(".lp6.js.dock-on .top .btn"))).toBe(ONECOL);
    expect(mediaOf(ruleFor(".lp6 main a"))).toBe(ONECOL);
    // nothing is keyed to the old 820 px line any more
    expect(bare).not.toMatch(/\((min-width:820px|max-width:819px)\)/);
  });
});

describe("the landing's CSS plumbing outside the stylesheet", () => {
  it("Tailwind does not scan the v6 folder (its words would become global utilities)", () => {
    const app = read(join(SRC, "index.css"));
    expect(app.split("\n")[0]).toBe('@import "tailwindcss";');
    expect(app).toMatch(/^@source not "\.\/components\/landing\/v6";$/m);
  });

  it("styles.js brings Inter 300 (the clock) from @fontsource/inter beside the page's stylesheet, and nothing else", () => {
    const s = read(join(V6, "styles.js"));
    const imports = [...s.matchAll(/^import\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@fontsource/inter/latin-300.css", "./landingV6.css"]);
    expect(existsSync(join(FRONTEND, "node_modules", "@fontsource", "inter", "latin-300.css"))).toBe(true);
    // the app already loads 400/500/600 in main.jsx; the page adds no other weight
    const main = read(join(SRC, "main.jsx"));
    for (const w of [400, 500, 600]) expect(main).toContain(`@fontsource/inter/latin-${w}.css`);
    expect(main).not.toContain("@fontsource/inter/latin-300.css");
  });
});
