// The door screen's own build (R11, rubric B11) — the Vite plugins
// vite.stand.config.js uses, kept here so vitest can run them too.
//
// WHY A BUILD OF ITS OWN. A paired door iPad opened /stand/<token> inside the
// whole owner app: 491 KB of gzip JavaScript for one screen (20 Oct walk) —
// the full Danish dictionary (194 KB), every owner tab inside
// ReservationsPage (settings, floor editor, behandlinger, insights), and the
// app shell's providers, nav icons and cookie banner. Budget: 200 KB.
//
// THREE PLUGINS:
//   standModules()  — in this build only, four app-shell modules resolve to
//                     the door screen's lean ones (src/stand/): the language
//                     provider (no full dictionary, no boot dictionary, no
//                     preload at import), the session (a paired device has
//                     none: no /auth/me), the event log (no consent on a door
//                     device, so nothing to log), the platform and haptics
//                     (always the web). The originals are untouched and the
//                     owner app keeps them.
//   standWords()    — virtual:bonbox-stand-words/da and /en: exactly the
//                     words the door screen's code can show, taken from
//                     i18n/da.js and en.js at build time (they stay the one
//                     place a string is written). One language is loaded, and
//                     stand.html preloads it with the code. At the end of the
//                     build every module in the bundle must have been read for
//                     its words — else the build stops (never a raw key).
//   standBudget()   — the JavaScript a cold /stand/<token> downloads (the
//                     entry, its static imports and one language's words),
//                     gzip -9, must stay under STAND_JS_BUDGET; else the build
//                     stops.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND = path.resolve(HERE, "..");
export const SRC = path.join(FRONTEND, "src");

/** The door screen's entry: everything it can show is reached from here. */
export const STAND_ENTRIES = [path.join(SRC, "stand", "main.jsx")];

/** App-shell module → the door screen's lean one (paths relative to src/). */
export const STAND_SWAPS = {
  "hooks/useLanguage.jsx": "stand/standLanguage.jsx",
  "hooks/useAuth.jsx": "stand/standSession.jsx",
  "hooks/useEventLog.js": "stand/standEventLog.js",
  // stand.html is served to browsers only (the Capacitor app loads
  // index.html): the web answers, without the Capacitor runtime.
  "utils/platform.js": "stand/standPlatform.js",
  "utils/haptics.js": "stand/standHaptics.js",
  // The plan, loaded the first time the Plan lens opens (the door screen
  // opens on the list). The stand module's own import reaches the real one.
  "components/FloorPlan.jsx": "stand/standFloorPlan.jsx",
  // Full dictionaries (another language, the safety net): the app build's
  // own files, never a second copy (appDictionaries below).
  "lib/localeStore.js": "stand/standLocales.js",
};

// The app build lists its dictionary files here (in dist/, removed again by
// the door screen's build, which bakes the list in).
export const APP_DICTS_FILE = ".bonbox-app-dicts.json";
const APP_DICTS_ID = "virtual:bonbox-app-dicts";

// What the door screen's code NEVER runs: owner-only cards that
// ReservationsPage imports at the top and draws only behind __STAND_BUILD__
// (or in tabs the door screen never opens). Their words stay out of the door
// screen's words. The build PROVES it: a skipped file found in the bundle, or
// a word only a skipped function says found in the bundle's code, stops it.
export const STAND_SKIP_FILES = [
  "components/reservations/BehandlingRow.jsx",
  "components/reservations/BookingNameRow.jsx",
  "components/reservations/ClosuresCard.jsx",
  "components/reservations/InsightsSection.jsx",
  "components/reservations/SalonAttention.jsx",
  "components/reservations/SalonCapacity.jsx",
  "components/reservations/SalonRhythmCard.jsx",
  "components/reservations/StartTimesChoice.jsx",
  "components/reservations/StylistAddCard.jsx",
  "components/reservations/StylistRow.jsx",
  "components/reservations/UpcomingRail.jsx",
  "components/reservations/WebsiteBookingKit.jsx",
  "components/reservations/WeekHoursEditor.jsx",
  // The merge of tracks A, B and C (27 Oct 2026): the owner-only cards and
  // the page notice that tracks A (R5, R12) and B (R2, R9) added — drawn only
  // in SettingsSection or behind __STAND_BUILD__ — so their words stay out
  // of the door screen's dictionary too (R11's budget, rubric B11).
  "components/reservations/BookingAccentRow.jsx",
  "components/reservations/BookingLinkCard.jsx",
  "components/reservations/BookingLiveNotice.jsx",
  "components/reservations/CardSaveBar.jsx",
  "components/reservations/ContactBlocksCard.jsx",
  "components/reservations/PublicWaitlistSwitch.jsx",
  "components/reservations/SettingsJumpRow.jsx",
];
/** Top-level functions (column 0 `function Name(` … column 0 `}`) never drawn
 *  on the door screen — the owner's tabs and cards. */
export const STAND_SKIP_FUNCTIONS = {
  "pages/ReservationsPage.jsx": [
    "SettingsSection", "FloorSection", "BehandlingerSection", "StandDevices",
    "InstallHostStandHint", "SalonFirstRunCard", "PageTitle", "ZonePresetChips",
  ],
};

/** gzip -9 bytes a cold /stand/<token> may download as JavaScript. */
export const STAND_JS_BUDGET = 200 * 1000;
/** Over this the build stops whatever the mode (the dictionary came back,
 *  an owner tab leaked in…). Between the budget and this it warns, unless
 *  STAND_BUDGET_STRICT=1 (the test campaign, CI), which stops at the budget. */
export const STAND_JS_HARD_CEILING = 250 * 1000;

const WORDS_ID = "virtual:bonbox-stand-words/";
const EXTS = [".jsx", ".js", "/index.jsx", "/index.js"];

const abs = (rel) => path.join(SRC, rel);
const isDictionary = (file) => file.startsWith(path.join(SRC, "i18n") + path.sep);

function resolveLocal(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTS) {
    const f = base + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

/** Relative imports of a source file: static, re-exports and import(). */
export function importsOf(source) {
  const out = new Set();
  const res = [
    /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Every file the door screen's code reaches, with the swaps applied and
 *  the owner-only files (STAND_SKIP_FILES) left out. */
export function standFiles(entries = STAND_ENTRIES) {
  const swaps = new Map(Object.entries(STAND_SWAPS).map(([a, b]) => [abs(a), abs(b)]));
  const skip = new Set(STAND_SKIP_FILES.map(abs));
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || skip.has(file) || isDictionary(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const spec of importsOf(src)) {
      const target = resolveLocal(spec, file);
      if (!target || target.includes(`${path.sep}node_modules${path.sep}`)) continue;
      // A replacement's import of the very module it stands for is the real
      // one (standFloorPlan.jsx loads the real plan); every other import is
      // swapped as usual — as in standModules().
      stack.push(swaps.has(target) && swaps.get(target) !== file ? swaps.get(target) : target);
    }
  }
  return seen;
}

/**
 * The words a set of files can show: every string literal that IS a
 * dictionary key ("rsvpFoo" in t("rsvpFoo", …) — and in a table of keys
 * handed to t() later), plus every key under a prefix the code builds
 * (t(`allergen_${k}`) → every allergen_ key; "x_" + k likewise).
 */
export function keysIn(sources, dictKeys) {
  const keys = new Set();
  const prefixes = new Set();
  // Three independent scans, one per quote, none across a line: a stray
  // apostrophe or backtick in a comment can then never hide a key.
  const QUOTES = [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g, /`([^`$\\\n]*)`/g];
  for (const src of sources) {
    for (const re of QUOTES) {
      for (const m of src.matchAll(re)) {
        if (m[1] && dictKeys.has(m[1])) keys.add(m[1]);
      }
    }
    for (const m of src.matchAll(/`([A-Za-z][\w.]*)\$\{/g)) prefixes.add(m[1]);
    for (const m of src.matchAll(/["']([A-Za-z][\w.]*_)["']\s*\+/g)) prefixes.add(m[1]);
  }
  for (const p of prefixes) {
    // A prefix this short would take in a whole family ("rsvp…"): too broad
    // to be a real lookup — such a call names its keys in full elsewhere.
    if (p.length < 4) continue;
    for (const k of dictKeys) if (k.startsWith(p)) keys.add(k);
  }
  return keys;
}

async function loadDictionaries(stamp = "") {
  const q = stamp ? `?t=${stamp}` : "";
  const [{ da }, { en }] = await Promise.all([
    import(pathToFileURL(path.join(SRC, "i18n", "da.js")).href + q),
    import(pathToFileURL(path.join(SRC, "i18n", "en.js")).href + q),
  ]);
  return { da, en };
}

/** A source with the named top-level functions cut out (column-0
 *  `function Name(` up to its column-0 `}`), and what was cut. */
export function cutFunctions(source, names) {
  const lines = source.split("\n");
  const kept = [];
  const cut = [];
  let inCut = false;
  for (const line of lines) {
    if (!inCut) {
      const m = line.match(/^(?:export\s+(?:default\s+)?)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m && names.includes(m[1])) {
        inCut = true;
        cut.push(line);
        continue;
      }
      kept.push(line);
    } else {
      cut.push(line);
      if (line === "}") inCut = false;
    }
  }
  return { kept: kept.join("\n"), cut: cut.join("\n") };
}

/** { da: {...}, en: {...}, files: Set, cutOnly: Set } — what the door
 *  screen can say; cutOnly = words only the skipped functions say (the
 *  build checks none of them is in its code). */
export async function standWordsFor(entries = STAND_ENTRIES, stamp = "") {
  const dicts = await loadDictionaries(stamp);
  const dictKeys = new Set([...Object.keys(dicts.da), ...Object.keys(dicts.en)]);
  const files = standFiles(entries);
  const kept = [];
  const cut = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const names = STAND_SKIP_FUNCTIONS[path.relative(SRC, f).split(path.sep).join("/")];
    if (names) {
      const parts = cutFunctions(src, names);
      kept.push(parts.kept);
      cut.push(parts.cut);
    } else {
      kept.push(src);
    }
  }
  const keys = keysIn(kept, dictKeys);
  const cutOnly = new Set();
  for (const k of keysIn(cut, dictKeys)) {
    if (keys.has(k)) continue;
    // A plain word ("delete", "people") cannot be proven absent from the
    // bundle (it is also ordinary code): keep it in the words instead.
    if (/[A-Z.]/.test(k)) cutOnly.add(k);
    else keys.add(k);
  }
  const pick = (d) => Object.fromEntries([...keys].filter((k) => k in d).sort().map((k) => [k, d[k]]));
  return { da: pick(dicts.da), en: pick(dicts.en), files, cutOnly };
}

/** In the stand build only: the app shell's modules → the door screen's. */
export function standModules() {
  const swaps = new Map(Object.entries(STAND_SWAPS).map(([a, b]) => [abs(a), abs(b)]));
  return {
    name: "bonbox-stand-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith(".")) return null;
      const hit = await this.resolve(source, importer, { ...options, skipSelf: true });
      const id = hit && hit.id ? hit.id.split("?")[0] : null;
      // A replacement's import of the very module it stands for reaches the
      // real one (standFloorPlan.jsx loads the real plan).
      if (id && swaps.has(id) && swaps.get(id) !== importer.split("?")[0]) return swaps.get(id);
      return null;
    },
  };
}

/** virtual:bonbox-stand-words/<lang>, the completeness check, the preload. */
export function standWords() {
  let words = null;
  const get = async (ctx) => {
    if (!words) {
      words = await standWordsFor(STAND_ENTRIES, String(Date.now()));
      for (const f of ["da.js", "en.js"]) ctx.addWatchFile(path.join(SRC, "i18n", f));
    }
    return words;
  };
  return {
    name: "bonbox-stand-words",
    buildStart() {
      words = null;
    },
    resolveId(id) {
      if (id.startsWith(WORDS_ID)) return "\0" + id;
      return null;
    },
    async load(id) {
      if (!id.startsWith("\0" + WORDS_ID)) return null;
      const lang = id.slice(("\0" + WORDS_ID).length);
      const w = await get(this);
      if (!w[lang]) this.error(`stand words: no language "${lang}"`);
      return `export default ${JSON.stringify(w[lang])};`;
    },
    generateBundle(_opts, bundle) {
      if (!words) return;
      // Every module whose code is in the door screen was read for its words.
      const missing = [];
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, info] of Object.entries(chunk.modules || {})) {
          const file = id.split("?")[0];
          if (!file.startsWith(SRC + path.sep) || isDictionary(file)) continue;
          if (info && info.renderedLength === 0) continue;
          if (!words.files.has(file)) missing.push(path.relative(SRC, file));
        }
      }
      if (missing.length) {
        this.error(`stand words: the door screen's bundle has code its words were not read from: ${missing.join(", ")}`);
      }
      // …and no function whose words were left out is alive in it.
      const code = Object.values(bundle)
        .filter((c) => c.type === "chunk" && !(c.facadeModuleId || "").startsWith("\0" + WORDS_ID) &&
          !(c.facadeModuleId && isDictionary(c.facadeModuleId)))
        .map((c) => c.code).join("\n");
      // Only a key that looks like one (rsvpFoo, a.b): a plain word such as
      // "delete" is also an HTTP verb in axios. Plain words are kept in the
      // words instead (standWordsFor), so they need no proof.
      const alive = [...words.cutOnly].filter((k) => /[A-Z.]/.test(k) &&
        (code.includes(`"${k}"`) || code.includes(`'${k}'`) || code.includes("`" + k + "`")));
      if (alive.length) {
        this.error(`stand words: words of a function the door screen should never draw are in its code: ${alive.slice(0, 12).join(", ")} — unguard it in STAND_SKIP_FUNCTIONS or guard it with __STAND_BUILD__`);
      }
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const files = {};
        for (const chunk of Object.values(ctx.bundle || {})) {
          const m = chunk.type === "chunk" && chunk.facadeModuleId &&
            chunk.facadeModuleId.startsWith("\0" + WORDS_ID) && chunk.facadeModuleId.slice(("\0" + WORDS_ID).length);
          if (m) files[m] = "/" + chunk.fileName;
        }
        if (!files.da || !files.en) return html;
        // The device's language (stored, else the browser's — Danish anywhere
        // in the list wins, as in the app), so its words download WITH the
        // code instead of after it. A wrong guess costs a spare download.
        const script =
          "<script>(function(){try{var l=null;try{l=localStorage.getItem(\"lang\")}catch(e){}" +
          "if(!l){var n=(navigator.languages||[navigator.language||\"\"]).join(\",\").toLowerCase();l=/(^|,)(da|fo)/.test(n)?\"da\":\"en\"}" +
          `var f=${JSON.stringify(files)};var h=l==="da"?f.da:f.en;` +
          "var k=document.createElement(\"link\");k.rel=\"modulepreload\";k.href=h;document.head.appendChild(k)}catch(e){}})()</script>";
        const charset = '<meta charset="UTF-8" />';
        return html.includes(charset) ? html.replace(charset, charset + script) : html.replace("</head>", script + "</head>");
      },
    },
  };
}

/** gzip -9 of what a cold door screen downloads, per language (bytes). */
export function standJsBytes(bundle, entryFile = "main.jsx") {
  const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  // The page's entry chunk: Vite gives an HTML input's chunk the page itself
  // (stand.html) as its facade; a script entry would carry stand/main.jsx.
  const entry = chunks.find((c) => c.isEntry && c.facadeModuleId && (() => {
    const id = c.facadeModuleId.split("?")[0];
    return id.endsWith(path.sep + "stand.html") || id.endsWith(path.join("stand", entryFile));
  })());
  if (!entry) return null;
  const seen = new Set();
  const stack = [entry.fileName];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !byName.has(f)) continue;
    seen.add(f);
    stack.push(...(byName.get(f).imports || []));
  }
  const gz = (f) => zlib.gzipSync(byName.get(f).code, { level: 9 }).length;
  const base = [...seen].reduce((n, f) => n + gz(f), 0);
  const words = {};
  for (const c of chunks) {
    const lang = c.facadeModuleId && c.facadeModuleId.startsWith("\0" + WORDS_ID) && c.facadeModuleId.slice(("\0" + WORDS_ID).length);
    if (lang) words[lang] = gz(c.fileName);
  }
  return { base, words, files: [...seen] };
}

/** Stop the build when a cold door screen would download more than the budget. */
export function standBudget(budget = STAND_JS_BUDGET) {
  return {
    name: "bonbox-stand-budget",
    apply: "build",
    generateBundle(_opts, bundle) {
      const m = standJsBytes(bundle);
      if (!m) return;
      const worst = m.base + Math.max(0, ...Object.values(m.words));
      const kb = (n) => (n / 1000).toFixed(1) + " kB";
      const line = `door screen JS (gzip -9): ${kb(worst)} of ${kb(budget)} — code ${kb(m.base)} in ${m.files.length} files, words ${Object.entries(m.words).map(([k, v]) => `${k} ${kb(v)}`).join(", ")}`;
      const strict = process.env.STAND_BUDGET_STRICT === "1";
      if (worst > STAND_JS_HARD_CEILING || (strict && worst > budget)) this.error(`stand budget: ${line}`);
      if (worst > budget) console.warn(`\n⚠️  OVER BUDGET — ${line}\n`);
      else if (this.info) this.info(line);
      else console.log(line);
    },
  };
}

/** The APP build: list its dictionary files ({ code: "/assets/da-….js" })
 *  for the door screen's build, which loads them instead of building a
 *  second copy (src/stand/standLocales.js). */
export function appDictionaries() {
  return {
    name: "bonbox-app-dictionaries",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = {};
      for (const c of Object.values(bundle)) {
        const m = c.type === "chunk" && c.facadeModuleId &&
          c.facadeModuleId.split("?")[0].match(/[\\/]src[\\/]i18n[\\/]([a-z]{2})\.js$/);
        if (m) files[m[1]] = "/" + c.fileName;
      }
      if (Object.keys(files).length) {
        this.emitFile({ type: "asset", fileName: APP_DICTS_FILE, source: JSON.stringify(files) });
      }
    },
  };
}

/** The DOOR SCREEN build: the app build's list, as virtual:bonbox-app-dicts
 *  (empty when the app was not built first: no safety net, never a wrong
 *  file), and the list removed from dist/ afterwards. In dev and vitest the
 *  real lib/localeStore.js is used, so this only runs in the stand build. */
export function appDictionariesIn(outDir) {
  // The build's real outDir once resolved (a --outDir on the command line
  // wins over the config's), else the one given.
  let dir = outDir;
  const file = () => path.resolve(FRONTEND, dir, APP_DICTS_FILE);
  return {
    name: "bonbox-app-dictionaries-in",
    configResolved(config) {
      if (config && config.build && config.build.outDir) dir = config.build.outDir;
    },
    resolveId(id) {
      return id === APP_DICTS_ID ? "\0" + APP_DICTS_ID : null;
    },
    load(id) {
      if (id !== "\0" + APP_DICTS_ID) return null;
      let list = {};
      try {
        list = JSON.parse(fs.readFileSync(file(), "utf8"));
      } catch {
        this.warn(`no ${APP_DICTS_FILE} in ${outDir}/ — build the app first (npm run build); the door screen gets no full-dictionary safety net`);
      }
      const safe = Object.fromEntries(Object.entries(list).filter(([k, v]) =>
        /^[a-z]{2}$/.test(k) && typeof v === "string" && /^\/assets\/[\w.-]+\.js$/.test(v)));
      return `export default ${JSON.stringify(safe)};`;
    },
    closeBundle() {
      try {
        fs.rmSync(file(), { force: true });
      } catch {
        /* nothing to remove */
      }
    },
  };
}

/** /stand and /stand/<token> → stand.html, in `vite` and `vite preview` (Vercel: vercel.json). */
export function standHtml() {
  const rewrite = (req, _res, next) => {
    const url = req.url || "";
    const accept = String(req.headers?.accept || "");
    if (/^\/stand(\/[^.]*)?(\?.*)?$/.test(url) && accept.includes("text/html")) req.url = "/stand.html";
    next();
  };
  return {
    name: "bonbox-stand-html",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}
