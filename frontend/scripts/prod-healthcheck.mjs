#!/usr/bin/env node
/**
 * prod-healthcheck.mjs — LIVE synthetic health-check for bonbox.dk.
 *
 * Catches the class of breakage where Vercel serves an INCONSISTENT deploy:
 * the served index references a chunk hash that either (a) 404s, or (b) 200s
 * but was built against a DIFFERENT graph, so a shared chunk it destructures
 * no longer exports the name it imports. At runtime that is a module-link
 * `SyntaxError: does not provide an export named 'X'` → the lazy import rejects
 * → App.jsx lazyRetry gives up → the top-level ErrorBoundary shows
 * "Something went wrong / connection issue". A plain 200-check MISSES (b) —
 * every chunk returns 200. This walks the chunk GRAPH and verifies the
 * import/export contract, which is the actual failure surface.
 *
 * Run:  npm run healthcheck:prod
 *       node scripts/prod-healthcheck.mjs --base=https://www.bonbox.dk --json
 * Exit: 0 = healthy, 1 = broken deploy, 2 = script/network error.
 *
 * No deps. Node >= 18 (global fetch). Verifies PROD, never localhost.
 */

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const BASE = (argv.base || process.env.HEALTHCHECK_BASE || "https://www.bonbox.dk").replace(/\/$/, "");
const JSON_OUT = !!argv.json;
const EXPECT_HASH = argv["expect-index"]; // optional: pin to the hash the current build emitted (staleness gate)

// Route → the source module its lazy import pulls. We assert the served entry
// chunk's dynamic-import map contains a chunk whose basename starts with this.
const KEY_ROUTES = [
  { route: "/reservations", chunkPrefix: "ReservationsPage-" },
  { route: "/dashboard", chunkPrefix: "DashboardPage-" },
  { route: "/gavekort", chunkPrefix: "GavekortPage-" },
  { route: "/r/:slug", chunkPrefix: "ReservationPublicPage-" },
];

const CHUNK_RE = /(?:assets\/)?([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8})\.js/g;
const TIMEOUT_MS = 12000;

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "cache-control": "no-cache" } });
    const body = res.ok ? await res.text() : "";
    return { status: res.status, body, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

/** Parse a rolldown/rollup chunk into its static import edges + export names. */
function parseChunk(src) {
  // imports: import{a as b,c}from"./Chunk-hash.js";  and side-effect import"./x.js"
  const imports = []; // { file, names:[localImportedName] }
  const importFrom = /import\s*\{([^}]*)\}\s*from\s*["']\.\/([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8}\.js)["']/g;
  let m;
  while ((m = importFrom.exec(src))) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.includes(" as ") ? s.split(" as ")[0].trim() : s.trim())); // we need the EXPORTED name = left side
    imports.push({ file: m[2], names });
  }
  const bareImport = /import\s*["']\.\/([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8}\.js)["']/g;
  while ((m = bareImport.exec(src))) imports.push({ file: m[1], names: [] });

  // exports: export{a,b as c,d as default};  (rolldown emits a single/few export{} blocks)
  const exports = new Set();
  const exportBlock = /export\s*\{([^}]*)\}/g;
  while ((m = exportBlock.exec(src))) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      // `x as y` re-exports y; `x` exports x
      exports.add(p.includes(" as ") ? p.split(" as ")[1].trim() : p);
    }
  }
  return { imports, exports };
}

async function main() {
  const errors = [];
  const warnings = [];
  const notes = [];

  // 1. Fetch the HTML shell, extract the entry chunk (<script type=module src=...>).
  const idx = await get(BASE + "/");
  if (idx.status !== 200) {
    errors.push(`index HTML ${idx.status} at ${BASE}/`);
    return finish({ errors, warnings, notes });
  }
  const entryMatch = idx.body.match(/<script[^>]+type="module"[^>]+src="\/assets\/([A-Za-z0-9_$-]+-[A-Za-z0-9_$-]{8})\.js"/)
    || idx.body.match(/src="\/assets\/(index-[A-Za-z0-9_$-]{8})\.js"/);
  if (!entryMatch) {
    errors.push("no module entry <script src=/assets/index-*.js> found in HTML shell");
    return finish({ errors, warnings, notes });
  }
  const entryName = entryMatch[1] + ".js";
  notes.push(`entry=${entryName}`);

  if (EXPECT_HASH && entryName !== EXPECT_HASH && `${EXPECT_HASH}.js` !== entryName) {
    // Staleness gate: the live entry is not what THIS build emitted. Vercel didn't
    // ship the current source. Warn (not fail) unless --strict-stale.
    (argv["strict-stale"] ? errors : warnings).push(
      `STALE deploy: live entry ${entryName} != expected ${EXPECT_HASH}`,
    );
  }

  // 2. Fetch the entry chunk = the dynamic-import map (all route chunks resolve here).
  const entry = await get(`${BASE}/assets/${entryName}`);
  if (entry.status !== 200) {
    errors.push(`entry chunk ${entryName} → ${entry.status}`);
    return finish({ errors, warnings, notes });
  }

  // 3. Route-level presence: each key route's chunk must appear in the entry map + return 200.
  const routeChunkByPrefix = {};
  const routeReport = [];
  for (const { route, chunkPrefix } of KEY_ROUTES) {
    const re = new RegExp(`(?:assets\\/)?(${chunkPrefix.replace(/[-]/g, "\\-")}[A-Za-z0-9_$-]{8})\\.js`);
    const hit = entry.body.match(re);
    if (!hit) {
      errors.push(`route ${route}: no chunk matching ${chunkPrefix}* referenced by entry`);
      routeReport.push({ route, chunk: null, status: null, ok: false });
      continue;
    }
    const file = hit[1] + ".js";
    routeChunkByPrefix[chunkPrefix] = file;
    const r = await get(`${BASE}/assets/${file}`);
    const ok = r.status === 200;
    if (!ok) errors.push(`route ${route}: chunk ${file} → ${r.status}`);
    routeReport.push({ route, chunk: file, status: r.status, ok });
  }
  notes.push({ routes: routeReport });

  // 4. Chunk-GRAPH consistency (the real check). BFS from the entry + every route chunk.
  //    For each chunk: every static-imported chunk must (a) return 200 and
  //    (b) EXPORT every name this chunk imports from it. A missing export = the
  //    module-link SyntaxError that crashes the lazy route in prod.
  const cache = new Map(); // file -> {status, parsed}
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const r = await get(`${BASE}/assets/${file}`);
    const parsed = r.status === 200 ? parseChunk(r.body) : null;
    const rec = { status: r.status, parsed };
    cache.set(file, rec);
    return rec;
  }

  const roots = [entryName, ...Object.values(routeChunkByPrefix)];
  const seen = new Set();
  const queue = [...roots];
  let edgesChecked = 0;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rec = await load(file);
    if (rec.status !== 200) {
      errors.push(`chunk ${file} → ${rec.status} (referenced in graph)`);
      continue;
    }
    for (const imp of rec.parsed.imports) {
      const dep = await load(imp.file);
      if (dep.status !== 200) {
        errors.push(`${file} imports ${imp.file} which → ${dep.status} (broken chunk link)`);
        continue;
      }
      // THE discriminating signal: does the dep actually export what we import?
      for (const name of imp.names) {
        edgesChecked++;
        if (!dep.parsed.exports.has(name)) {
          errors.push(
            `GRAPH INCONSISTENCY: ${file} imports {${name}} from ${imp.file}, ` +
              `but ${imp.file} does not export "${name}" (exports: ${[...dep.parsed.exports].sort().join(",")}). ` +
              `→ module-link SyntaxError → lazy route rejects → ErrorBoundary.`,
          );
        }
      }
      if (!seen.has(imp.file)) queue.push(imp.file);
    }
  }
  notes.push(`graph: ${seen.size} chunks, ${edgesChecked} import-name edges verified`);

  // 5. Backend liveness (App.jsx pings HEAD /api/health). Fail-soft — a backend
  //    blip is a different alert; we only NOTE it so a frontend gate isn't held
  //    hostage by a Render cold start.
  const apiBase =
    argv["api-base"] ||
    process.env.HEALTHCHECK_API_BASE ||
    BASE.replace(/^https?:\/\/(www\.)?/, "https://api.");
  try {
    const h = await get(`${apiBase}/api/health`);
    notes.push(`backend ${apiBase}/api/health → ${h.status}`);
    if (h.status >= 500) warnings.push(`backend /api/health → ${h.status}`);
  } catch (e) {
    warnings.push(`backend health probe failed: ${e.message}`);
  }

  return finish({ errors, warnings, notes });
}

function finish({ errors, warnings, notes }) {
  const healthy = errors.length === 0;
  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, healthy, errors, warnings, notes }, null, 2));
  } else {
    console.log(`\nBonBox prod health-check — ${BASE}`);
    for (const n of notes) console.log("  ·", typeof n === "string" ? n : JSON.stringify(n));
    if (warnings.length) {
      console.log("\n  WARN:");
      for (const w of warnings) console.log("   ~", w);
    }
    if (errors.length) {
      console.log("\n  BROKEN:");
      for (const e of errors) console.log("   ✗", e);
    }
    console.log(`\n  ${healthy ? "HEALTHY ✓" : "DEPLOY BROKEN ✗ (" + errors.length + " error(s))"}\n`);
  }
  process.exit(healthy ? 0 : 1);
}

main().catch((e) => {
  console.error("healthcheck crashed:", e?.stack || e);
  process.exit(2); // distinct from a detected breakage
});
