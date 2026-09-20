/**
 * saveFile's third outcome has to survive.
 *
 * utils/download.js exists to kill one thing: an export that delivers nothing
 * while the button looks like it worked. It then reintroduced that in two
 * places of its own, both on the native shell, both behind `ok: true`:
 *
 *   1. NotAllowedError was treated as "the owner dismissed the sheet". It is
 *      not. It is what WebKit throws when navigator.share() is called without
 *      transient user activation — and EVERY revisor export in this repo is
 *      shaped `await api.get(blob)` and THEN saveFile, so the network hop has
 *      already spent the activation. On the iOS app the momsangivelse, the
 *      lønseddel, the faktura and the lagerrapport would each answer ok:true
 *      having delivered nothing.
 *
 *   2. When the share sheet is unavailable on native, control fell through to
 *      the anchor — which this module's own header documents as a no-op in
 *      that WebView ("no download manager and no Files destination, so the tap
 *      does nothing at all") — and the anchor returned ok:true regardless.
 *
 * Both prior implementations got case 1 right (shareDailyCloseRange.js
 * special-cases AbortError ALONE), so this is a regression guard as much as a
 * unit test. The repo's rule: a boolean erases "couldn't check" — return three
 * outcomes and default to failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* platform.isNativeApp is the switch the whole module pivots on, so it is the
   one thing mocked. Everything else is the real code path. */
const isNativeApp = vi.fn(() => false);
vi.mock("../utils/platform", () => ({ isNativeApp: () => isNativeApp() }));

const { saveFile } = await import("../utils/download");

const PDF = () => new Blob(["%PDF-1.4 not really"], { type: "application/pdf" });

let origShare, origCanShare;

beforeEach(() => {
  isNativeApp.mockReturnValue(false);
  origShare = navigator.share;
  origCanShare = navigator.canShare;
  // jsdom ships no object-URL implementation; the anchor path needs one.
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    globalThis.URL.revokeObjectURL = vi.fn();
  }
});

afterEach(() => {
  navigator.share = origShare;
  navigator.canShare = origCanShare;
  vi.restoreAllMocks();
});

/** Make the share sheet available and have it reject with `name`. */
function shareRejects(name) {
  navigator.canShare = vi.fn(() => true);
  navigator.share = vi.fn(() => {
    const e = new Error(name);
    e.name = name;
    return Promise.reject(e);
  });
}

describe("saveFile — the native share path", () => {
  it("counts a dismissed sheet as delivered", async () => {
    // The sheet OPENED. Showing an error for closing a thing you opened is
    // noise, and dumping a download afterwards ignores the cancel.
    isNativeApp.mockReturnValue(true);
    shareRejects("AbortError");
    await expect(saveFile(PDF(), "kasserapport.pdf")).resolves.toEqual({
      ok: true,
      channel: "share",
    });
  });

  it("does NOT count a lost user activation as delivered", async () => {
    // The regression. NotAllowedError means the sheet never opened.
    isNativeApp.mockReturnValue(true);
    shareRejects("NotAllowedError");
    const out = await saveFile(PDF(), "momsangivelse.pdf");
    expect(out.ok).toBe(false);
    expect(out.channel).toBeUndefined();
  });

  it("does not claim success when the shell has nowhere to put the file", async () => {
    // No share sheet on native = no delivery channel at all. The anchor is not
    // a fallback here, it is a no-op, so it must not answer ok:true.
    isNativeApp.mockReturnValue(true);
    navigator.canShare = vi.fn(() => false);
    navigator.share = vi.fn();
    const out = await saveFile(PDF(), "loenseddel.pdf");
    expect(out).toEqual({ ok: false, reason: "no_download_manager" });
  });

  it("still succeeds when the sheet actually takes the file", async () => {
    // Positive control: without this, every assertion above would also pass on
    // a saveFile() that simply always failed on native.
    isNativeApp.mockReturnValue(true);
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(() => Promise.resolve());
    await expect(saveFile(PDF(), "faktura.pdf")).resolves.toEqual({
      ok: true,
      channel: "share",
    });
  });
});

describe("saveFile — the web path is untouched by the native rule", () => {
  it("downloads through the anchor on the web", async () => {
    const out = await saveFile(PDF(), "kasserapport.pdf");
    expect(out).toEqual({ ok: true, channel: "download" });
  });

  it("appends the anchor before clicking it", async () => {
    // Firefox ignores a click on a detached node — one of the two shapes the
    // 27 hand-rolled copies had.
    const appended = [];
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node.tagName === "A") appended.push(node);
      return realAppend(node);
    });
    await saveFile(PDF(), "daily-close.csv");
    expect(appended.length).toBe(1);
    expect(appended[0].download).toBe("daily-close.csv");
  });

  it("does not revoke the object URL in the same tick as the click", async () => {
    // Safari treats a synchronous revoke as a cancel: 0-byte file, no error.
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await saveFile(PDF(), "vat.xlsx");
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("saveFile — refusals that are not a device problem", () => {
  it("refuses an empty file rather than handing over 0 bytes", async () => {
    const out = await saveFile(new Blob([], { type: "application/pdf" }), "x.pdf");
    expect(out).toEqual({ ok: false, reason: "empty_file" });
  });

  it("refuses a missing payload", async () => {
    expect(await saveFile(null, "x.pdf")).toEqual({ ok: false, reason: "no_data" });
  });
});

describe("no export call site throws the outcome away", () => {
  it("every saveFile call is awaited and its result read, or explicitly returned", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); }
        else if (/\.jsx?$/.test(e.name)) files.push(p);
      }
    })(SRC);

    const bare = [];
    for (const file of files) {
      if (file.endsWith(`utils${path.sep}download.js`)) continue;
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        const call = /\bsaveFile\s*\(/.test(line) || /\bsaveTextFile\s*\(/.test(line);
        if (!call) return;
        // Fine: the outcome is bound, returned, or fed straight to a branch.
        if (/(=|return|\?|\bif\s*\()\s*(await\s+)?save(Text)?File\s*\(/.test(line)) return;
        if (/^\s*(import|\*|\/\/)/.test(line)) return;
        bare.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(
      bare,
      `saveFile never throws, so an unread result is a silently swallowed failure:\n${bare.join("\n")}`,
    ).toEqual([]);
  });
});
