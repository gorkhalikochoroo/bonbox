/**
 * Daily Brief emails sent before 3 Nov 2026 carry an opt-out link (and a
 * one-click List-Unsubscribe URL) on the SPA host: bonbox.dk/api/email/
 * unsubscribe, where the SPA served its own shell and nothing happened. Those
 * tokens live 30 days, so vercel.json sends that one path to the API host.
 * permanent → 308, which keeps the method: Gmail's one-click POST arrives as
 * a POST. Redirects run before rewrites, so the SPA catch-all never sees it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(resolve(here, "../../vercel.json"), "utf8"));

describe("opt-out links on the SPA host reach the API", () => {
  it("redirects /api/email/unsubscribe to api.bonbox.dk with a 308", () => {
    const r = (vercel.redirects || []).find((x) => x.source === "/api/email/unsubscribe");
    expect(r).toBeTruthy();
    expect(r.destination).toBe("https://api.bonbox.dk/api/email/unsubscribe");
    expect(r.permanent).toBe(true);
    expect(r.statusCode).toBeUndefined();
  });

  it("is the only redirect off the SPA host for /api (nothing else moves)", () => {
    const api = (vercel.redirects || []).filter((x) => x.source.startsWith("/api"));
    expect(api.map((x) => x.source)).toEqual(["/api/email/unsubscribe"]);
  });
});
