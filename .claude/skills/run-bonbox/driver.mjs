#!/usr/bin/env node
// BonBox run/driver harness.
//
// Boots the FastAPI backend against a FRESH throwaway sqlite (schema
// auto-creates on startup via Base.metadata.create_all — ~99 tables) and the
// Vite frontend, registers a demo owner through the real /api/auth/register
// endpoint, and smoke-tests the endpoints this repo's PRs actually touch
// (reservations, day-rail month-load, billing entitlements, daily-close range
// export). No browser dependency — this is the headless handle on the running
// app. For the visual layer, run `up` and open the printed URL in the Claude
// Code Browser pane (that is how every screenshot this session was taken).
//
// Usage:
//   node driver.mjs smoke   # boot both, register + API smoke, tear down, exit 0/1
//   node driver.mjs up      # boot both, seed a demo owner, LEAVE running (Ctrl-C to stop)
//
// Ports (browser flow needs the defaults — the frontend hardcodes
// http://localhost:8000/api as its dev API base):
//   BONBOX_API_PORT (default 8000)   BONBOX_WEB_PORT (default 5173)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// .claude/skills/run-bonbox/driver.mjs  ->  repo root is three levels up.
const REPO = resolve(HERE, "..", "..", "..");
const BACKEND = join(REPO, "backend");
const FRONTEND = join(REPO, "frontend");

const API_PORT = process.env.BONBOX_API_PORT || "8000";
const WEB_PORT = process.env.BONBOX_WEB_PORT || "5173";
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const MODE = process.argv[2] === "up" ? "up" : "smoke";

// Prefer the committed venv interpreter; fall back to whatever uvicorn is on
// PATH (this session used the conda one — both work).
const VENV_UVICORN = join(BACKEND, "venv", "bin", "uvicorn");
const UVICORN = existsSync(VENV_UVICORN) ? VENV_UVICORN : "uvicorn";

const procs = [];
const log = (m) => console.log(`[driver] ${m}`);
// Throw so main()'s catch runs teardown and no further steps execute.
const die = (m) => { throw new Error(m); };

function shutdown(code) {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch {} }
  setTimeout(() => process.exit(code), 400);
}
process.on("SIGINT", () => { log("stopping…"); shutdown(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, label, timeoutMs = 75000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) { log(`${label} ready (${Math.round((Date.now() - t0) / 1000)}s)`); return true; }
    } catch {}
    await sleep(700);
  }
  die(`${label} did not come up within ${timeoutMs / 1000}s (${url})`);
}

function launch(name, cmd, args, opts) {
  log(`launch ${name}: ${cmd} ${args.join(" ")}`);
  // detached so we can SIGTERM the whole process group (uvicorn/vite fork).
  const p = spawn(cmd, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
  p.stdout.on("data", (d) => process.env.BONBOX_VERBOSE && process.stdout.write(`  [${name}] ${d}`));
  p.stderr.on("data", (d) => process.env.BONBOX_VERBOSE && process.stderr.write(`  [${name}] ${d}`));
  p.on("exit", (c) => c && c !== 0 && !p.__expected && die(`${name} exited early (code ${c}) — run with BONBOX_VERBOSE=1 to see why`));
  procs.push(p);
  return p;
}

async function main() {
  if (!existsSync(BACKEND) || !existsSync(FRONTEND)) die(`expected backend/ and frontend/ under ${REPO}`);

  // ── Backend on a fresh throwaway sqlite ──────────────────────────────
  const scratch = join(await mkdtemp(join(tmpdir(), "bonbox-run-")), "fresh.db");
  log(`fresh sqlite: ${scratch}`);
  const env = {
    ...process.env,
    DATABASE_URL: `sqlite:///${scratch}`,
    // Non-Fernet is fine — the app derives a key via SHA-256 (see crypto note
    // on boot). Any 32+ char string keeps encrypt/decrypt working.
    APP_SECRET_KEY: process.env.APP_SECRET_KEY || "run-skill-dev-secret-key-000000000000",
    PORT: API_PORT,
  };
  // No --reload: reload forks a reloader child that survives a naive kill.
  launch("backend", UVICORN, ["app.main:app", "--port", API_PORT, "--app-dir", BACKEND], { cwd: BACKEND, env });
  await waitFor(`${API}/api/health`, "backend");

  // ── Register a demo owner through the real endpoint ──────────────────
  const owner = {
    // gmail.com is on the app's mail-domain whitelist, so /register skips the
    // MX DNS lookup (works with no network); the dashed local-part never trips
    // the bot-alias regex. Nothing is ever emailed to it in dev.
    email: `bonbox-run-${Date.now()}@gmail.com`,
    password: "RunSkill123!",
    business_name: "Bistro Nørrebro (demo)",
    business_type: "restaurant",
    currency: "DKK",
  };
  const reg = await fetch(`${API}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(owner),
  });
  if (!reg.ok) die(`register -> ${reg.status} ${(await reg.text()).slice(0, 200)}`);
  const token = (await reg.json()).access_token;
  if (!token) die("register returned no access_token");
  log(`registered ${owner.email}`);
  const auth = { Authorization: `Bearer ${token}` };

  // A fresh signup is email_verified=false, so the FRONTEND parks it on a
  // /verify-email wall (dev sends no mail, so there's no token to click). We
  // own this throwaway DB — flip the flag directly so the app is usable. The
  // account is then on its 14-day trial = full features. python3 is the
  // backend runtime, so it's always present.
  await new Promise((res) => {
    const q = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
      + "c.execute('UPDATE users SET email_verified=1 WHERE email=?',(sys.argv[2],)); "
      + "c.commit(); print('verified', c.total_changes)";
    const v = spawn("python3", ["-c", q, scratch, owner.email], { stdio: "inherit" });
    v.on("exit", () => res());
  });

  // ── Smoke the endpoints PRs here actually touch ──────────────────────
  const checks = [
    ["billing entitlements", `${API}/api/billing/entitlements`, (d) => d.plan && d.caps],
    ["reservations settings", `${API}/api/reservations/settings`, (d) => "reservations_enabled" in d],
    ["day-rail month-load", `${API}/api/reservations/month-load`, (d) => Array.isArray(d.days)],
    ["staff members", `${API}/api/staff/members`, (d) => Array.isArray(d)],
  ];
  for (const [label, url, ok] of checks) {
    const r = await fetch(url, { headers: auth });
    if (!r.ok) die(`${label} -> ${r.status}`);
    const d = await r.json();
    if (!ok(d)) die(`${label} returned unexpected shape: ${JSON.stringify(d).slice(0, 160)}`);
    log(`ok  ${label}`);
  }

  // ── Frontend ─────────────────────────────────────────────────────────
  launch("frontend", "npm", ["run", "dev", "--prefix", FRONTEND, "--", "--port", WEB_PORT, "--strictPort"],
    { cwd: FRONTEND, env: process.env });
  await waitFor(`${WEB}/`, "frontend");

  log("──────────────────────────────────────────────");
  log(`ALL GREEN.  web ${WEB}   api ${API}`);
  log(`demo owner: ${owner.email} / ${owner.password}`);

  if (MODE === "smoke") { procs.forEach((p) => (p.__expected = true)); log("smoke OK — tearing down"); shutdown(0); }
  else {
    log("mode=up — servers left running. Open the web URL in the Browser pane to screenshot.");
    log("Ctrl-C to stop.");
  }
}

main().catch((e) => die(e.stack || String(e)));
