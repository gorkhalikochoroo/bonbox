/**
 * Where server stamps are shown as relative or clock times, they go through
 * parseServerTime — and where a time is wall-clock, they do not.
 *
 * SOURCE guard. The live defect ("Last seen 2h ago" a minute after a sign-in)
 * was one call shape, new Date(<naive UTC string>), repeated across admin and
 * owner pages. The admin list is rendered for real in
 * adminLastSeenClock.test.jsx and the helper in serverTime.test.js; the other
 * call sites sit inside multi-thousand-line pages behind tabs and modals, so a
 * render test would pin navigation more than the rule. This pins the rule:
 *
 *   1. each fixed site imports the helper and no longer hands that field to
 *      new Date();
 *   2. the sites that already read naive stamps as UTC keep doing so;
 *   3. the reservation/event helpers do NOT use it — starts_at / ends_at are
 *      naive Europe/Copenhagen wall-clock (routers/reservations.py
 *      _local_date_of), and reading them as UTC would move every booking.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(SRC, p), "utf8");
const IMPORT = /import \{ parseServerTime \} from "\.\.\/utils\/serverTime";/;

function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

// [file, fields that must no longer reach new Date(), functions whose body must not call new Date(iso)]
const FIXED = [
  ["pages/AdminPage.jsx", ["last_active", "as_of", "trial_ends_at"], ["relativeTime"]],
  ["pages/AdminSupportPage.jsx", [], ["relativeTime"]],
  ["pages/AdminTrainingPage.jsx", ["checked_at"], []],
  ["pages/InsightsPage.jsx", [], ["timeAgo"]],
  ["pages/ConnectionsPage.jsx", ["last_synced_at"], []],
  ["pages/ReservationsPage.jsx", ["last_seen_at"], []],
  ["components/SmartImportModal.jsx", [], []],
  ["pages/GavekortPage.jsx", [], ["fmtDateTime"]],
  ["pages/ProfilePage.jsx", ["cvr_verified_at"], []],
  ["components/TrialBanner.jsx", ["trialEndsAt"], []],
  ["pages/DoorScanPage.jsx", [], ["formatTimeShort"]],
];

describe("server stamps shown as relative/clock times are read as UTC", () => {
  for (const [file, fields, fns] of FIXED) {
    it(file, () => {
      const src = read(file);
      expect(src).toMatch(IMPORT);
      expect(src).toMatch(/parseServerTime\(/);
      for (const f of fields) {
        expect(src, `${file}: new Date(…${f}…)`).not.toMatch(new RegExp(`new Date\\([^)]*\\b${f}\\b`));
      }
      for (const fn of fns) {
        expect(fnBody(src, fn), `${file}: ${fn}`).not.toMatch(/new Date\(iso\)/);
      }
    });
  }

  it("the import-history clock in SmartImportModal no longer parses created_at with new Date", () => {
    const src = read("components/SmartImportModal.jsx");
    const i = src.indexOf("const fmt = (iso) =>");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 300)).toMatch(/parseServerTime\(iso\)/);
    expect(src.slice(i, i + 300)).not.toMatch(/new Date\(iso\)/);
  });
});

describe("sites that already read naive stamps as UTC keep doing so", () => {
  const NAIVE_AS_UTC = /\[zZ\]\|\[\+-\]\\d/;
  for (const file of [
    "components/staff/OwnerChatDrawer.jsx",
    "pages/StaffPortalPage.jsx",
    "components/reservations/WaitlistSection.jsx",
    "utils/closeEmail.js",
  ]) {
    it(file, () => {
      expect(read(file)).toMatch(NAIVE_AS_UTC);
    });
  }
});

describe("wall-clock reservation times are NOT read as UTC", () => {
  for (const file of [
    "utils/floorState.js",
    "utils/serviceClock.js",
    "utils/upcomingArrivals.js",
    "hooks/useLiveAlerts.jsx",
    "components/reservations/UpcomingRail.jsx",
  ]) {
    it(file, () => {
      expect(read(file)).not.toMatch(/parseServerTime/);
    });
  }

  it("ReservationsPage uses it for the stand's last_seen_at only, never starts_at", () => {
    const src = read("pages/ReservationsPage.jsx");
    expect(src).not.toMatch(/parseServerTime\([^)]*\b(starts_at|ends_at)\b/);
    expect(src.match(/parseServerTime\(/g)).toHaveLength(1);
  });
});
