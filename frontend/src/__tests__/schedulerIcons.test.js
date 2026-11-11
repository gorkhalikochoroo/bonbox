// @vitest-environment node
/**
 * The Vagtplan app shells' icon links (Android walk, 11 Nov 2026): the
 * scheduler build (VITE_APP_MODE=scheduler, dist-scheduler) points every
 * rel="icon" link at its Vagtplan twin, so the Android WebView never asks
 * Capacitor's local server for /favicon.ico (which it answers with an empty
 * 404). The web build's document is left byte-equal.
 */
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const saved = process.env.VITE_APP_MODE;

async function plugin() {
  const { default: config } = await import("../../vite.config.js");
  const p = config.plugins.flat().find((x) => x && x.name === "bonbox-scheduler-icons");
  expect(p).toBeTruthy();
  return p;
}

afterEach(() => {
  if (saved === undefined) delete process.env.VITE_APP_MODE;
  else process.env.VITE_APP_MODE = saved;
});

describe("schedulerIcons", () => {
  it("scheduler build: every rel=icon is the Vagtplan file (which exists); nothing else changes", async () => {
    process.env.VITE_APP_MODE = "scheduler";
    const p = await plugin();
    expect(p.apply).toBe("build");
    const out = p.transformIndexHtml.handler(INDEX, { path: "/index.html" });
    const icons = [...out.matchAll(/<link\s+rel="icon"[^>]*?\shref="([^"]+)"/g)].map((m) => m[1]);
    expect(icons.length).toBe(6);
    for (const href of icons) {
      expect(href.startsWith("/vagtplan-")).toBe(true);
      expect(fs.existsSync(path.join(FRONTEND, "public", href.split("?")[0]))).toBe(true);
    }
    expect(out).not.toMatch(/<link\s+rel="icon"[^>]*\shref="\/favicon/);
    // Only those six hrefs differ: undo them and the document is the source.
    expect(out.replace(/\/vagtplan-(favicon|icon-192)/g, (m, f) => `/${f}`)).toBe(INDEX.replace(/\/vagtplan-(favicon|icon-192)/g, (m, f) => `/${f}`));
    expect(out.length - INDEX.length).toBe(6 * "vagtplan-".length);
  });

  it("the web build (no VITE_APP_MODE) is untouched", async () => {
    delete process.env.VITE_APP_MODE;
    const p = await plugin();
    expect(p.transformIndexHtml.handler(INDEX, { path: "/index.html" })).toBe(INDEX);
  });

  it("runs before htmlDiet, which stays last", async () => {
    const { default: config } = await import("../../vite.config.js");
    const names = config.plugins.flat().filter(Boolean).map((x) => x.name);
    expect(names.indexOf("bonbox-scheduler-icons")).toBeGreaterThan(-1);
    expect(names[names.length - 1]).toBe("bonbox-html-diet");
  });
});
