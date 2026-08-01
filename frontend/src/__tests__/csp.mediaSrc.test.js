/**
 * CSP regression guard — the alert chime needs blob: media.
 *
 * WHY THIS EXISTS. PR #206 moved the host stand's severe-allergy chime off pure
 * Web Audio (which iOS silences with the mute switch) onto an HTML5 <audio>
 * element fed by a WAV synthesised at runtime into a Blob. Every local check
 * passed — unit tests, build, and a browser run against the dev server, where I
 * decoded both WAVs and confirmed real signal.
 *
 * It was still broken in production, for a reason no local test could see: the
 * deployed CSP had no `media-src`, so it fell back to `default-src 'self'`,
 * which does not permit blob:. `img-src` and `worker-src` had been granted
 * blob: over time; media never had. The <audio> element therefore failed with
 * "NotSupportedError: The element has no supported sources", the code fell back
 * to the oscillator — audible on a laptop, SILENT on the muted iPad the whole
 * feature exists for — and the audibility chip read "Sound off" while sound was
 * in fact playing, which is a false alarm on a safety indicator.
 *
 * Vite's dev server ships no CSP, which is exactly why this survived local
 * verification. So the guard reads the deployed config rather than the app.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(resolve(here, "../../vercel.json"), "utf8"));

const cspValues = (vercel.headers || [])
  .flatMap((h) => h.headers || [])
  .filter((h) => h.key === "Content-Security-Policy")
  .map((h) => h.value);

/** Pull one directive out of a CSP string, or null if absent. */
function directive(csp, name) {
  const hit = csp
    .split(";")
    .map((s) => s.trim())
    .find((d) => d === name || d.startsWith(name + " "));
  return hit ?? null;
}

describe("CSP allows the runtime-synthesised alert chime", () => {
  it("ships at least one CSP block", () => {
    expect(cspValues.length).toBeGreaterThan(0);
  });

  it.each(cspValues.map((v, i) => [i, v]))(
    "block %i declares media-src explicitly",
    (_i, csp) => {
      // Explicit, not inherited: default-src is 'self', so an absent media-src
      // silently forbids blob: and kills the chime in production only.
      expect(directive(csp, "media-src")).not.toBeNull();
    },
  );

  it.each(cspValues.map((v, i) => [i, v]))(
    "block %i allows blob: media",
    (_i, csp) => {
      expect(directive(csp, "media-src")).toContain("blob:");
    },
  );

  it("does not rely on default-src for media", () => {
    for (const csp of cspValues) {
      const def = directive(csp, "default-src") || "";
      const media = directive(csp, "media-src") || "";
      // If someone ever widens default-src to include blob:, media-src must
      // still say so itself — inherited permission is how this broke.
      expect(media).toContain("blob:");
      expect(def).toContain("'self'");
    }
  });
});
