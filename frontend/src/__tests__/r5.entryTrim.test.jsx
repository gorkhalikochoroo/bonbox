/**
 * Booking R5 — "trim what the booking route loads": the app-shell icons.
 *
 * App.jsx loads PillarGate up front (its decision must be made before a lazy
 * page's chunk is fetched). It took { Button, Card, Icon } from the ./ui
 * barrel, so EVERY page's first download — a restaurant guest's booking page
 * included — carried the whole UI kit and the Icon registry with its ~70
 * Lucide icons: ~36 extra modulepreloads in index.html. It now takes its
 * three pieces from their own files and its six icons by name; the card looks
 * the same (strokeWidth 1.75, aria-hidden — what <Icon> drew).
 *
 * Checked on the source's static import graph from main.jsx (what the entry
 * chunk must carry), and on the gate itself.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// The static import graph of the entry, as the bundler sees it.
function entryGraph(start = "main.jsx") {
  const exts = ["", ".js", ".jsx", "/index.js", "/index.jsx"];
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const resolve = (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const e of exts) {
      const p = base + e;
      // exact case: a case-blind disk must not resolve bookingWait.js for BookingWait
      if (fs.existsSync(p) && fs.statSync(p).isFile() && fs.readdirSync(path.dirname(p)).includes(path.basename(p))) return p;
    }
    return null;
  };
  const seen = new Set([path.join(SRC, start)]);
  const queue = [...seen];
  while (queue.length) {
    const f = queue.shift();
    if (!/\.jsx?$/.test(f)) continue;
    const src = strip(fs.readFileSync(f, "utf8"));
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      const r = resolve(f, m[1]);
      if (r && !seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
  }
  return [...seen].map((f) => path.relative(SRC, f));
}

describe("the entry no longer carries the UI kit or the Icon registry", () => {
  const graph = entryGraph();

  it("PillarGate takes its pieces from their own files", () => {
    const src = read("components/PillarGate.jsx");
    expect(src).not.toMatch(/from "\.\/ui"/);
    expect(src).not.toMatch(/from "\.\/ui\/Icon"/);
    expect(src).toContain('import Button from "./ui/Button";');
    expect(src).toContain('import Card from "./ui/Card";');
    expect(src).toMatch(/import \{ CalendarCheck, CalendarDays, Gift, Package, Sparkles, UsersRound \} from "lucide-react";/);
  });

  it.each([
    "components/ui/index.js",
    "components/ui/Icon.jsx",
    "components/ui/StatCard.jsx",
    "components/ui/UpgradeNudge.jsx",
    "components/ui/Amount.jsx",
    "utils/currency.js",
    "lib/planPrices.js",
  ])("%s is not in the entry's static graph", (f) => {
    expect(graph).not.toContain(f);
  });

  it("still carries what every first paint needs", () => {
    for (const f of ["App.jsx", "hooks/useLanguage.jsx", "components/PillarGate.jsx", "components/ui/Button.jsx", "components/ui/Card.jsx"]) {
      expect(graph, f).toContain(f);
    }
  });
});

describe("the switched-off pillar card looks the same", () => {
  vi.mock("../hooks/usePillars", () => ({
    usePillars: () => ({ hiddenPillars: new Set(["gavekort"]), isReady: true, setPillarHidden: vi.fn() }),
  }));
  vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { business_type: "cafe" } }) }));
  vi.mock("../hooks/useLanguage", async () => {
    const { da } = await import("../i18n/da");
    return { useLanguage: () => ({ t: (k) => da[k] ?? k, lang: "da" }) };
  });

  it("the pillar's own Lucide icon at 1.75, hidden from screen readers, in the badge and on the button", async () => {
    const PillarGate = (await import("../components/PillarGate")).default;
    const { da } = await import("../i18n/da");
    const { container } = render(
      <MemoryRouter>
        <PillarGate pillar="gavekort"><p>page</p></PillarGate>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: da.pillarGateGavekortTitle })).toBeInTheDocument();
    const icons = container.querySelectorAll("svg.lucide-gift");
    expect(icons.length).toBe(2);
    for (const svg of icons) {
      expect(svg.getAttribute("stroke-width")).toBe("1.75");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.queryByText("page")).toBeNull();
  });
});

describe("the 2D table picker is its own chunk (the page's first download is under 30 kB gz)", () => {
  const page = read("pages/ReservationPublicPage.jsx");

  it("loaded on demand, prefetched as soon as the venue offers it, with the same wait as the floor fetch", () => {
    expect(page).not.toMatch(/^import PublicFloorMap from/m);
    expect(page).toContain('const loadFloorMap = () => import("../components/PublicFloorMap");');
    expect(page).toContain("const PublicFloorMap = lazy(loadFloorMap);");
    expect(page).toMatch(/if \(page\?\.guest_can_pick_table\) loadFloorMap\(\)\.catch\(\(\) => \{\}\);/);
    expect(page).toMatch(/<Suspense fallback=\{<div className=\{FLOOR_WAIT\} \/>\}>\s*<PublicFloorMap/);
  });

  it("its words stay in the page's own dictionary (the scanner follows import())", async () => {
    const { bookingGraph } = await import("../../scripts/bookingDict.mjs");
    const graph = bookingGraph(SRC).map((f) => path.relative(SRC, f));
    expect(graph).toContain("components/PublicFloorMap.jsx");
    expect(graph).toContain("config/tableArchetypes.jsx");
    // ...but never the dictionaries the language store loads on demand
    expect(graph.some((f) => f.startsWith("i18n/"))).toBe(false);
  });
});
