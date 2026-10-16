/**
 * E (speed push, 15 Oct): a web READ carries no custom header, so the browser
 * sends it as a CORS "simple" request — no OPTIONS preflight round trip (33 of
 * them on a cold Home open). Every WRITE still carries the platform header and
 * the CSRF token; the native shell is unchanged.
 *
 * Security half — what must stay true:
 *   • every web POST/PUT/PATCH/DELETE echoes the bonbox_csrf cookie as
 *     X-CSRF-Token (the backend's csrf_protect enforces it on writes only);
 *   • the Stripe checkout POST still says which platform it comes from
 *     (routers/billing.py blocks it inside the iOS app);
 *   • the shared-device reveal proof still rides on reads (the backend's
 *     pin gate needs it on the financial GETs);
 *   • the native app still names its platform on every request.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import api from "../services/api";
import { setRevealProof } from "../services/deviceShare";

let sent = [];
const realAdapter = api.defaults.adapter;

function header(config, name) {
  const h = config.headers || {};
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  return h[name];
}

beforeEach(() => {
  sent = [];
  api.defaults.adapter = (config) => {
    sent.push(config);
    return Promise.resolve({ data: { ok: true, findings: ["x"] }, status: 200, statusText: "OK", headers: {}, config });
  };
  document.cookie = "bonbox_csrf=tok123; path=/";
  delete window.Capacitor;
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
  document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  delete window.Capacitor;
  setRevealProof(null);
});

describe("web", () => {
  it("a GET carries no custom header — no preflight", async () => {
    await api.get("/dashboard/batch", { params: { month: 10 } });
    const c = sent[0];
    expect(header(c, "X-BonBox-Platform")).toBeUndefined();
    expect(header(c, "X-CSRF-Token")).toBeUndefined();
    expect(header(c, "Authorization")).toBeUndefined();
  });

  it.each(["post", "put", "patch", "delete"])("a %s carries the CSRF token and the platform", async (m) => {
    await api[m]("/expenses", m === "delete" ? undefined : { amount: 1 });
    const c = sent[0];
    expect(header(c, "X-CSRF-Token")).toBe("tok123");
    expect(header(c, "X-BonBox-Platform")).toBe("web");
  });

  it("the Stripe checkout POST still names its platform", async () => {
    await api.post("/billing/stripe/checkout-session", { plan: "starter" });
    expect(header(sent[0], "X-BonBox-Platform")).toBe("web");
  });

  it("the shared-device reveal proof still rides on a read", async () => {
    setRevealProof("proof-abc");
    await api.get("/dashboard/batch");
    expect(header(sent[0], "X-BonBox-Device-Pin")).toBe("proof-abc");
  });
});

describe("native shell (unchanged)", () => {
  it("names its platform on reads and writes, and sends no CSRF header", async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    await api.get("/dashboard/batch");
    await api.post("/billing/stripe/checkout-session", {});
    expect(header(sent[0], "X-BonBox-Platform")).toBe("ios");
    expect(header(sent[1], "X-BonBox-Platform")).toBe("ios");
    expect(header(sent[0], "X-CSRF-Token")).toBeUndefined();
    expect(header(sent[1], "X-CSRF-Token")).toBeUndefined();
  });
});
