// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import api from "../services/api";
import StaffBankRow from "../components/StaffBankRow";
import StaffDocumentsRow from "../components/StaffDocumentsRow";
import { useAuth } from "../hooks/useAuth";
import { sectionFor, sectionsFor, hasSections } from "../config/roleSections";
import {
  SECTION_COLORS,
  SECTION_BAR,
  SECTION_BAR_NEUTRAL,
  SECTION_HEADER,
  SECTION_LABEL_KEY,
  SECTION_LABEL_FALLBACK,
} from "../config/scheduleSectionColors";
// The grid's pure model (day tally, section grouping, contract labels, the
// "seen by staff" read). Lives outside the page so it can be unit-tested
// without mounting 6k lines of JSX — see config/scheduleGrid.js.
import {
  CONTRACT_TYPES,
  DAY_DOT_CLASS,
  contractLabel,
  dayDotTone,
  dayTallyText,
  groupStaffBySection,
  isSeenByStaff,
  tallyDay,
} from "../config/scheduleGrid";
// Manager/cashier/viewer seats never see wage kroner on this page — the
// backend denies the wage endpoint to them in parallel, this hides the chrome
// so the denial doesn't read as a broken toggle.
import { isStaffMemberRole } from "../config/navManifest";
import { useLanguage } from "../hooks/useLanguage";
// Three outcomes, never two. Every fetch on this page used to end in
// `catch { setRows([]) }`, which made "the week did not load" look exactly
// like "the week is empty" — and draftCount, derived from that same array,
// then read 0 and the toolbar announced "Udgivet" about a week nobody had
// managed to read. useAsyncData keeps `failed` apart from empty (and keeps
// the last true rows through a failed reload); LoadFailed is what we render
// INSTEAD of an empty state that would otherwise be lying.
import useAsyncData from "../hooks/useAsyncData";
import { trackEvent } from "../hooks/useEventLog";
import { useConfirm } from "../hooks/useConfirm";
import { useEntitlements } from "../hooks/useEntitlements";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useBranch } from "../components/BranchSelector";
import { displayCurrency, formatKr, formatOwnerMoney, isMoneyRejected, moneyLocale, parseMoneyInput } from "../utils/currency";
import MoneyField from "../components/ui/MoneyField";
import { errText } from "../utils/errText";
import { formatHours, hoursUnit } from "../utils/hours";
// "Has anyone actually opened their link?" — three outcomes, never a boolean.
// null (we never asked / the call failed) must not render as "nobody has",
// and it must never render as the sentence claiming the team can see the week.
import { summarizePortalReach, linkWasOpened } from "../utils/portalReach";
import { formatDateClear } from "../utils/dateFormat";
import { saveFile } from "../utils/download";
import { expectedWeekLabor } from "../utils/weekLaborPct";
import { FadeIn } from "../components/AnimationKit";
import { UpgradeNudge, PageHeader, Button, SectionBanner, Icon, LoadFailed } from "../components/ui";
// THE modal container. ShiftModal used to hand-roll a vertically-centred card
// with no max-height and no internal scroller. It fit a 390×844 portrait phone
// with room to spare — so state the failure accurately: it broke wherever the
// USABLE height dropped under the card, which is landscape (an iPhone here is
// 844×390; Info.plist ships LandscapeLeft/Right), a short desktop window, and
// a phone with the software keyboard up. In all three the title clipped off
// the top and Tilføj vagt sat below the fold with nothing to scroll.
// Sheet gives the bottom sheet, the cap, the scroll and the pinned footer.
import Sheet from "../components/ui/Sheet";
import { useLocation } from "react-router-dom";
import { X, Link2, Pencil, Trash2, Mail, Phone, Loader2, Plus, Check, MapPin, MapPinOff, CalendarOff, Lock, LockKeyholeOpen, StickyNote } from "lucide-react";
import OwnerChatDrawer from "../components/staff/OwnerChatDrawer";
// Slice 1 of the [L] drag layer — drag a shift block from one cell onto an
// EMPTY cell (different staff and/or day) to REASSIGN it. dnd-kit gives us an
// accessible (keyboard + pointer) drag with a 6px activation distance, so a
// plain click still opens the modal / blooms a draft. Desktop grid ONLY.
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCenter,
} from "@dnd-kit/core";
// C7 Intelligence collapse — weather + smart-staffing forecasts fold into a
// collapsed panel right here on the Schedule page (where shift decisions are
// made), replacing the standalone /weather + /staffing Intelligence pages.
import ScheduleForecastPanel from "../components/ScheduleForecastPanel";
import SickCallNotificationCard from "../components/SickCallNotificationCard";
import SwapRequestNotificationCard from "../components/SwapRequestNotificationCard";
import ScheduleConfirmationCard from "../components/ScheduleConfirmationCard";

/* ═══════════════════════════════════════════════════════════
   CONSTANTS & HELPERS
   ═══════════════════════════════════════════════════════════ */
// Shift-role options are VERTICAL-AWARE (display-only vocab; role_on_shift never
// drives availability/booking). A restaurant/cafe/bar owner sees kitchen/floor
// roles; a salon owner sees salon roles. Default = restaurant so every existing
// (non-salon) account stays byte-identical. Salon role names stay Danish in BOTH
// locales (proper role nouns, like the DK terminology lock) — plain strings,
// never t() keys.
const ROLES_RESTAURANT = ["Chef", "Bartender", "Server", "Runner", "Dishwasher", "Manager"];
const ROLES_SALON = ["Frisør", "Barber", "Kolorist", "Kosmetolog", "Negletekniker", "Reception"];
const ROLES_BY_TYPE = { salon: ROLES_SALON }; // extend later (bakery/retail); default = restaurant
function rolesFor(businessType) {
  return ROLES_BY_TYPE[String(businessType || "").toLowerCase()] || ROLES_RESTAURANT;
}

// Staff roles are stored lowercase ("server", "kitchen"), but the shift-role
// <select> options are capitalized ("Server"). A raw `member.role` default left
// the select with no matching option → it snapped to the first one ("Chef").
// Map a staff role to the matching shift-role option so the New Shift modal
// defaults to the person's actual role.
const ROLE_TO_SHIFT_OPTION = {
  server: "Server", waiter: "Server", floor: "Server",
  manager: "Manager",
  dishwasher: "Dishwasher",
  chef: "Chef", cook: "Chef", kitchen: "Chef",
  barista: "Bartender", bartender: "Bartender", bar: "Bartender",
  runner: "Runner",
};
function roleToShiftOption(r, roles = ROLES_RESTAURANT) {
  if (!r) return roles[0];
  const exact = roles.find((x) => x.toLowerCase() === String(r).toLowerCase());
  if (exact) return exact;
  return ROLE_TO_SHIFT_OPTION[String(r).toLowerCase()] || roles[0];
}
// CONTRACT_TYPES moved to config/scheduleGrid.js when its labels became i18n
// keys — a hardcoded "Full-time" was rendering English inside an otherwise
// Danish staff drawer, and the grid now shows the same label as a row chip.

// ROLE_CATEGORY used to live here as a literal map keyed on CAPITALISED names.
// Two problems, both measured 2026-09-06:
//   1. staff_members.role is free text and 12 of 25 live rows are LOWERCASE
//      (server, barista, manager, kitchen, dishwasher), so ROLE_CATEGORY
//      ["kitchen"] / ["dishwasher"] / ["barista"] all missed and fell through
//      `|| "floor"` — a kitchen hand and a barista were painted Gulv/emerald
//      on this very grid.
//   2. It held six restaurant roles, so every non-hospitality vertical also
//      landed on "floor". A whole salon read as one undifferentiated Floor.
// Both are now the shared, archetype-keyed resolver in config/roleSections.js,
// which the STAFF app calls too — one map, not two that drift.
//
// Colour stays local (config/scheduleSectionColors.js). It happens to agree
// with the staff app on all five sections now — this grid moved `floor` off
// emerald and onto violet when emerald became the "seen by staff" signal — but
// only the SECTION is contractually shared.
function useCatFor() {
  const { user } = useAuth();
  const bt = user?.business_type;
  // `|| "floor"` preserves today's behaviour for anything unresolved, so an
  // unknown role lands exactly where it always has.
  return (role) => sectionFor(role, bt) || "floor";
}

// Section → colour/label now lives in config/scheduleSectionColors.js, keyed by
// the SAME section ids roleSections.js resolves. It used to be three literals
// right here covering only kitchen/bar/floor, so `catFor()` returning a SALON
// section ("treatment"/"front") produced `undefined` and the next line read
// `colors.dot` — a white screen on the owner's own Vagtplan for every salon.
// Local aliases keep the ~20 call sites below reading as they always have.
const ROLE_COLORS = SECTION_COLORS;
const ROLE_BAR = SECTION_BAR;
const ROLE_LABEL_KEY = SECTION_LABEL_KEY;
const ROLE_LABEL_FALLBACK = SECTION_LABEL_FALLBACK;

// The 3px left bar on a shift card. `hasSecs` is the same gate as the row dot
// (hasSections(businessType)): a retail / services / personal account has no
// sections, so the legend renders no "Roller:" block — and a colour key with
// nothing to read it by is decoration pretending to be information. Those
// cards get a neutral edge instead. Everywhere else, the section hue.
function roleBar(cat, hasSecs) {
  if (!hasSecs) return SECTION_BAR_NEUTRAL;
  return ROLE_BAR[cat] || ROLE_BAR.floor;
}

function roleLabel(cat, t) {
  // `|| "floor"` twice over: an unknown section must land on a real entry, not
  // on `t(undefined, undefined)` which renders empty.
  const c = ROLE_LABEL_KEY[cat] ? cat : "floor";
  return t(ROLE_LABEL_KEY[c], ROLE_LABEL_FALLBACK[c]);
}

// English fallbacks only — every render site goes through dayShort() so a
// Danish owner reads Man/Tir/Ons, not Mon/Tue/Wed. Kept as the t() fallback
// (not deleted) so a missing catalogue key degrades to English, never "day_mon_short".
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABEL_KEYS = [
  "day_mon_short", "day_tue_short", "day_wed_short", "day_thu_short",
  "day_fri_short", "day_sat_short", "day_sun_short",
];

/** Localized 3-letter weekday for a Monday-indexed 0..6. */
function dayShort(i, t) {
  return t(DAY_LABEL_KEYS[i], DAY_LABELS[i]);
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTE_OPTIONS = ["00", "15", "30", "45"];

/** Returns Monday of the week containing the given date */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Returns ISO week number */
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Formats "Week 15: 7 Apr – 13 Apr 2026" */
// Danish abbreviations are lowercase and take a period after the day number
// ("24. aug"), which is why this is a table rather than toLocaleDateString —
// the Intl short-month output for da-DK varies by runtime ("aug." vs "aug").
const WEEK_MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  da: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
};

function weekParts(weekStart, lang) {
  const ws = new Date(weekStart);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const da = lang === "da";
  return { ws, we, da, m: WEEK_MONTHS[da ? "da" : "en"], num: getISOWeekNumber(ws) };
}

function formatWeekRange(weekStart, lang = "en") {
  const { ws, we, da, m, num } = weekParts(weekStart, lang);
  const day = (dt) => (da ? `${dt.getDate()}. ${m[dt.getMonth()]}` : `${dt.getDate()} ${m[dt.getMonth()]}`);
  return `${da ? "Uge" : "Week"} ${num}: ${day(ws)} – ${day(we)} ${we.getFullYear()}`;
}

/** "Uge 38" / "Week 38" — the WEEK NUMBER alone. A DK owner navigates by week
    number ("kan du tage uge 38?"); the dates are confirmation, not the label.
    Split out of formatWeekRange so the pill can weight the two halves
    differently instead of shouting the whole string in semibold. */
function formatWeekLabel(weekStart, lang = "en") {
  const { da, num } = weekParts(weekStart, lang);
  return `${da ? "Uge" : "Week"} ${num}`;
}

/** The date range alone — the quiet half of the week pill. */
function formatWeekDates(weekStart, lang = "en") {
  const { ws, we, da, m } = weekParts(weekStart, lang);
  const day = (dt) => (da ? `${dt.getDate()}. ${m[dt.getMonth()]}` : `${dt.getDate()} ${m[dt.getMonth()]}`);
  return `${day(ws)} – ${day(we)} ${we.getFullYear()}`;
}

/** Phone variant of the range alone — drops the year and collapses a same-month
    range ("24.–30. aug"). The full form does not fit beside the Previous/Next
    buttons at 402pt: it wrapped to two lines and squeezed them against the card
    edges. (This replaced formatWeekRangeShort, which glued the week number to
    the dates in one string the pill can no longer weight separately.) */
function formatWeekDatesShort(weekStart, lang = "en") {
  const { ws, we, da, m } = weekParts(weekStart, lang);
  const endStr = da ? `${we.getDate()}. ${m[we.getMonth()]}` : `${we.getDate()} ${m[we.getMonth()]}`;
  const startStr =
    ws.getMonth() === we.getMonth()
      ? (da ? `${ws.getDate()}.` : `${ws.getDate()}`)
      : (da ? `${ws.getDate()}. ${m[ws.getMonth()]} ` : `${ws.getDate()} ${m[ws.getMonth()]} `);
  const sep = ws.getMonth() === we.getMonth() ? "–" : "– ";
  return `${startStr}${sep}${endStr}`;
}


/** Returns array of 7 Date objects starting from weekStart (Monday) */
function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Format date as YYYY-MM-DD */
function toISO(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format shift time at FULL precision: "16:00–23:00". Owners double-check
    these times, so we never crush "16:00" to a bare "16"; both sides are full
    HH:MM joined by a true en-dash (–). */
function formatShiftTime(start, end) {
  if (!start || !end) return "";
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

/** Calculate hours between two HH:MM times minus break */
function calcHours(startTime, endTime, breakMinutes = 0) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMinutes < 0) totalMinutes += 24 * 60; // overnight shift
  totalMinutes -= breakMinutes;
  return Math.max(0, totalMinutes / 60);
}

/** DK convention: a shift past ~6h carries a 45-min pause. Mirrors the backend
    `suggested_break_minutes` so a shift seeded here defaults to the SAME break
    the punch clock and roster apply — never a hidden 0 that inflates the hours.
    A suggestion only (overenskomst varies) — always owner-overridable. */
function suggestedBreak(startTime, endTime) {
  return calcHours(startTime, endTime, 0) >= 6 ? 45 : 0;
}

/** Absence type → short owner-facing label for the grid chip. */
function absKindLabel(kind, t) {
  return {
    ferie: t("absenceKindFerie", "Holiday"),
    sick: t("absenceKindSick", "Sick"),
    barns_syg: t("absenceKindBarns", "Child's sick day"),
    andet: t("absenceKindAndet", "Other"),
  }[kind] || kind;
}

/** Sum a staffer's net hours across the visible week.
 *
 *  Takes the PLURAL cell accessor. It used to take the singular one and so
 *  silently dropped a second same-day shift — which is how the Timer column
 *  came to read 18.8t beside a server-computed Vagtplan Shield chip reading
 *  25t, on the same row, for the same person. */
function weeklyHoursFor(memberId, weekDates, getShiftsForCell) {
  let total = 0;
  for (const d of weekDates) {
    for (const s of getShiftsForCell(memberId, d)) {
      total += calcHours(s.start_time, s.end_time, s.break_minutes || 0);
    }
  }
  return total;
}

/** Format hours for the Timer column: 1 decimal, trailing-zero trimmed, with
    the localized unit. DK uses a comma decimal + 't' (timer); EN uses '.' + 'h'
    so "32,5t" reads native in Danish and "32.5h" in English. */
/** Week-level hours. Delegates to the shared formatter so Vagtplan and
    Timer & løn cannot drift apart again: this printed "38h" while the hours
    page printed "38,0 t" for the identical week, one tab away. The visible
    change is the space — "38 t", not "38t"; a unit glued to a digit reads as
    part of the number. */
function formatTimer(h, lang) {
  return formatHours(h, { lang, decimals: 1 });
}

/** Per-shift / per-day hours: keeps 2-decimal precision (an 07:00–15:20 shift is
    8,33 t, never crushed to 8,3 — matches the backend pay calc) and uses the
    localized unit + DK comma decimal. */
function formatShiftHours(hrs, lang) {
  // No `?? 0`. It used to coerce an unknown into a confident "0,00 t", which
  // is the same fabricated zero F1 removed from five job pages — inside the
  // helper that was supposed to enforce the opposite rule. A real zero-hour
  // shift is passed as 0 at the call site; anything unknown says "—".
  return formatHours(hrs, { lang, decimals: 2 });
}

/* ─── Saved shift presets (Vagt-skabeloner) ───
   Reusable shift templates the owner defines once and drops onto cells.
   Client-side only (localStorage) — no backend, no PII, instant. Shape:
   { id, label, start, end, role, break_minutes }. */
const SHIFT_TEMPLATES_KEY = "bonbox_shift_templates_v1";

function loadShiftTemplates() {
  try {
    const arr = JSON.parse(localStorage.getItem(SHIFT_TEMPLATES_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((x) => x && x.start && x.end) : [];
  } catch {
    return [];
  }
}

/** One localStorage write, one honest answer.
 *  @returns {boolean} false when the browser refused (private mode / storage
 *  disabled). The owner's preference simply does not survive the reload —
 *  worth returning, never worth an error banner. */
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} false when this browser refused the write (private mode)
 *  — the presets still work for this session, they just won't survive a
 *  reload. Reported rather than swallowed: a catch that answers its caller is
 *  the same rule as the load paths below, one size down. */
function persistShiftTemplates(list) {
  try {
    localStorage.setItem(SHIFT_TEMPLATES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** True if a shift row belongs to the given staff id (tolerates either
    field name the API has used: staff_id or staff_member_id). */
function shiftBelongsTo(s, id) {
  return !!s && !!id && (s.staff_id === id || s.staff_member_id === id);
}

/** Most-recent (latest date) shift for a staff id within a shift list —
    used to pre-fill the shift modal so owners don't re-type each time. */
function mostRecentShiftFor(shiftList, id) {
  if (!id) return null;
  const mine = (shiftList || [])
    .filter((s) => shiftBelongsTo(s, id) && s.start_time && s.end_time)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)); // latest first
  return mine[0] || null;
}

/* ─── Live labor-cost helpers (shared by page + grid + mobile) ─── */

/** Pick the cost field for a per-shift / daily / week record by basis.
    Returns a number, or null when the record/field is absent. */
function costByBasis(rec, basis) {
  if (!rec) return null;
  const v = basis === "loaded" ? rec.cost_loaded : rec.cost_gross;
  return typeof v === "number" ? v : null;
}

/** Whole-percent string from a 0..1 ratio, e.g. 0.285 → "29%". */
function pctLabel(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

/** Tailwind text-color classes for a labor% vs target, per the locked
    status-color rule: ≤target emerald, ≤target×1.15 amber, else red.
    target/ratio are 0..1. Returns gray when either is missing. */
function laborTone(ratio, target) {
  if (ratio == null || target == null || Number.isNaN(ratio) || Number.isNaN(target)) {
    return "text-gray-400 dark:text-gray-500";
  }
  if (ratio <= target) return "text-emerald-600 dark:text-emerald-400";
  if (ratio <= target * 1.15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Footer/grid labor% tone — like laborTone but NEVER emerald. The reason has
    changed but the rule has not: green used to be the Floor ROLE signal here;
    now it is the "seen by staff" signal (the day-header dot, the check on a
    card). Either way an emerald number in the footer would read as a status
    claim about the roster, not a budget verdict. So "good/under-budget" stays
    neutral gray-900 and only over-budget colours. under→gray-900, near→amber,
    over→red. */
function laborToneFooter(ratio, target) {
  if (ratio == null || target == null || Number.isNaN(ratio) || Number.isNaN(target)) {
    return "text-gray-400 dark:text-gray-500";
  }
  if (ratio <= target) return "text-gray-900 dark:text-gray-100";
  if (ratio <= target * 1.15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/* ─── Shift-card chrome (desktop block, split blocks, drag ghost, phone chip) ───
   ONE definition for all four, because they are the same object seen from four
   places and they used to drift.

   PUBLISHED keeps the calm gray ring it has always had. A DRAFT drops the ring
   entirely for a dashed amber OUTLINE. Why outline and not the old
   `ring + border-dashed`: `border-dashed` dashed the 3px left ROLE BAR — the one
   mark on the card that must stay solid, because it says which section the shift
   belongs to, not what state it is in. An owner reading a half-built week saw
   the section signal dissolve on exactly the shifts they were still writing.
   `outline` sits outside the box model, so it dashes the card without touching
   the bar; -outline-offset-1 tucks it inside a 58px column instead of bleeding
   into the neighbour. */
const CARD_PUBLISHED = "ring-1 ring-gray-200 dark:ring-gray-700";
const CARD_DRAFT =
  "outline-1 outline-dashed -outline-offset-1 outline-amber-400 dark:outline-amber-500/60";
function cardChrome(isDraft) {
  return isDraft ? CARD_DRAFT : CARD_PUBLISHED;
}

/** "Kladde" — 11px, sentence case, amber pill. It replaced a 9px UPPERCASE
    amber label that read like a validation error. A draft is not a mistake; it
    is a shift the owner has not sent yet, and the pill says so at a size an
    owner over 40 can read across a 16-row grid. */
function DraftPill({ t }) {
  return (
    <span className="inline-block rounded px-1 py-px text-[11px] font-medium leading-none bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
      {t("schedDraft")}
    </span>
  );
}

/** Line-2 markers on a shift card: "the staffer has seen this" and "this shift
    carries a note" (the grid never showed notes at all before — they existed
    only inside the edit modal, so an allergy note on a Saturday shift was
    invisible while building Saturday).

    INLINE, deliberately. An absolutely-positioned corner icon collides with the
    time in a card that is 58-80px wide — there is no corner that is not already
    the most important thing on the card. */
function ShiftMarkers({ shift, published, t }) {
  const seen = published && isSeenByStaff(shift);
  const note = String(shift?.notes || "").trim();
  if (!seen && !note) return null;
  return (
    <>
      {seen && (
        <span
          title={t("schedSeenByStaff", "Seen by the staffer")}
          className="ml-1 inline-flex align-middle text-emerald-600 dark:text-emerald-400"
        >
          <Check className="w-3 h-3" strokeWidth={2.5} aria-hidden />
        </span>
      )}
      {note && (
        <span
          title={note}
          className="ml-1 inline-flex align-middle text-gray-400 dark:text-gray-500"
        >
          <StickyNote className="w-[11px] h-[11px]" strokeWidth={2} aria-hidden />
        </span>
      )}
    </>
  );
}

/** Per-staff confirmation rollup for the owner grid from the staff-side
    "Jeg har set det". Reads it through isSeenByStaff(), the same one line the
    shift cards use: `confirmed_current ?? !!confirmed_at`, so the row badge and
    the cards beside it can never tell the owner two different stories about the
    same week. confirmed_current is the backend's computed "the acknowledgement
    still applies to the shift AS IT NOW STANDS".
    "all" → every published shift seen (green check); "partial"/"none" →
    amber; null → no published shifts OR neither field is in the payload yet
    (degrade to NO badge — never a misleading "nobody confirmed"). HONESTY:
    green is gated strictly on every published shift carrying the signal.

    Takes the PLURAL cell accessor. It used to take the singular one, so on a
    split-shift day only the FIRST shift counted: a staffer who confirmed the
    lunch shift and never saw the dinner one still got the green CheckCircle2 —
    the badge asserting "seen" over a shift nobody had read. */
function staffConfirmState(memberId, weekDates, getShiftsForCell) {
  let published = 0;
  let confirmed = 0;
  let fieldSeen = false;
  for (const date of weekDates) {
    for (const s of getShiftsForCell(memberId, date)) {
      if (s && s.status === "published") {
        published += 1;
        if ("confirmed_at" in s || "confirmed_current" in s) fieldSeen = true;
        if (isSeenByStaff(s)) confirmed += 1;
      }
    }
  }
  if (published === 0 || !fieldSeen) return null;
  if (confirmed === published) return "all";
  return confirmed > 0 ? "partial" : "none";
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */

// Loading skeleton that mirrors the weekly grid (header + h-14 rows) so the
// page settles instead of jumping from a bare spinner to a full table.
//
// With WORDS. A shimmer alone says "something is happening" and nothing else,
// which leaves the owner to guess between "still loading" and "stuck" — the
// same two-outcomes-for-three-states problem the rest of this page just lost.
// One line naming what is on its way costs nothing and removes the guess.
function GridSkeleton({ t }) {
  const cols = 7;
  const rows = 5;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <p className="px-4 pt-3 text-[13px] text-gray-500 dark:text-gray-400">
        {t ? t("schedLoadingWeek", "Loading this week's shifts…") : "Loading this week's shifts…"}
      </p>
      <div className="animate-pulse">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <th className="px-4 py-3 w-40">
                <div className="h-3 w-16 rounded bg-gray-200 dark:bg-gray-700" />
              </th>
              {Array.from({ length: cols }).map((_, i) => (
                <th key={i} className="px-2 py-3">
                  <div className="h-3 w-8 mx-auto rounded bg-gray-200 dark:bg-gray-700" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <div className="space-y-1">
                      <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700" />
                      <div className="h-2 w-12 rounded bg-gray-100 dark:bg-gray-700/60" />
                    </div>
                  </div>
                </td>
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c} className="px-1 py-2">
                    {(r + c) % 3 === 0 ? (
                      <div className="h-14 rounded-lg bg-gray-100 dark:bg-gray-700/50" />
                    ) : (
                      <div className="h-14" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// Live "clocked in now" strip — who's currently on the clock (open punches),
// auto-updating ~30s. Staff self-clock from their portal → they appear here in
// near-real-time. Dark gray-900 chips = "in use", same language as the floor.
function ClockedInStrip() {
  const { t, lang } = useLanguage();
  // Polled, so the third state shows up in a particular way here: a failed
  // poll used to be swallowed whole, and the strip went on pulsing its live
  // dot over numbers that were by then minutes old. useAsyncData KEEPS the
  // last rows through a failure (stale-but-true beats blank) and `failed` is
  // what lets us stop calling them live.
  const clockedInQ = useAsyncData(() => api.get("/staff/clocked-in"), []);
  const { reload: reloadClockedIn } = clockedInQ;
  useEffect(() => {
    const id = setInterval(() => reloadClockedIn(), 30000);
    return () => clearInterval(id);
  }, [reloadClockedIn]);
  const rows = Array.isArray(clockedInQ.data?.clocked_in) ? clockedInQ.data.clocked_in : [];
  // No LoadFailed here, ON PURPOSE. With nothing in hand this strip has never
  // said anything — it renders nothing at all — so there is no comforting
  // claim to correct, and an amber banner riding above the week on every
  // offline load would be noise in front of the thing the owner came for.
  // With stale rows in hand we do keep showing them, minus the "live" claim.
  if (!rows.length) return null;
  const fmtDur = (min) => {
    if (min == null) return "";
    const h = Math.floor(min / 60);
    const m = min % 60;
    // The hour unit was typed as a literal "t", so an English seat watching
    // the same strip read "2t 30m".
    const hu = hoursUnit(lang);
    return h > 0 ? `${h}${hu} ${m}m` : `${m}m`;
  };
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {/* The pulse IS the claim "this is live". It stops the moment we stop
            being able to ask, and the words beside it say so — the rows stay,
            because they were true, they are just no longer current. */}
        {clockedInQ.failed ? (
          <span className="flex h-2.5 w-2.5" aria-hidden>
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
        ) : (
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t("schedClockedInNow", "Clocked in now")} · {rows.length}
        </span>
        {clockedInQ.failed && (
          <span className="text-[11px] font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400">
            {t("schedClockedInStale", "Not updating right now")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <span
            key={r.staff_id}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-2.5 py-1 text-sm"
          >
            <span className="font-medium truncate max-w-[10rem]">{r.name}</span>
            <span className="text-[12px] opacity-80 tabular-nums">{r.since}</span>
            {r.elapsed_min != null && (
              <span className="text-[11px] font-semibold tabular-nums opacity-90">
                {fmtDur(r.elapsed_min)}
              </span>
            )}
            {r.unverified && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-amber-300 dark:text-amber-400"
                title={t("schedGeoUnverifiedChip", "Location not verified")}
              >
                <MapPinOff className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                {t("schedGeoUnverifiedChip", "Location not verified")}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// Clock-in geofence (location lock) setup — opt-in. Owner taps "use my
// current location" while standing at the venue to set the anchor; staff
// clock-in then verifies device distance. Staff location is checked only at
// the punch, never stored (GDPR) — the staff card shows that notice.
function ClockGeofenceSettings() {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [savedMsg, setSavedMsg] = useState(""); // honest success confirmation
  const [open, setOpen] = useState(false);      // expanded only when unset, or on demand
  const [query, setQuery] = useState("");       // address or pasted map link
  const [found, setFound] = useState(null);     // resolved candidate, not yet saved
  // setData, not a second copy of the config in local state: a save writes the
  // server's echo straight back into the one place this card reads from.
  const cfgQ = useAsyncData(() => api.get("/staff/clock-geofence"), []);
  const cfg = cfgQ.data;
  const setCfg = cfgQ.setData;
  // Rendering nothing is the RIGHT answer to a failure here, and the reason is
  // specific rather than convenient: this endpoint is owner-only, so a 403 is
  // the normal reply for a manager seat. An amber "something went wrong" would
  // then fire on every single load for those seats, about a setting they are
  // not allowed to see. The card asserts nothing when it is absent — it does
  // not say "no location lock is set" — so silence tells no story.
  if (!cfg) return null;

  const save = async (patch) => {
    setBusy(true);
    setMsg("");
    setSavedMsg("");
    try {
      const res = await api.post("/staff/clock-geofence", { enabled: cfg.enabled, ...patch });
      setCfg(res.data);
      // Only confirm "location-bound" when a venue was actually anchored AND
      // the lock is on — never overclaim. (Honesty: a distance check at the
      // punch instant, not proof of presence.)
      if (patch.lat != null && patch.lng != null && res.data?.has_location && res.data?.enabled) {
        setSavedMsg(t("schedGeoSaved", "Venue anchored here. Staff clock-in is now location-bound."));
      }
    } catch {
      setMsg(t("schedGeoErr", "Couldn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const setHere = () => {
    if (!navigator.geolocation) {
      setMsg(t("schedGeoNoGps", "Location unavailable on this device."));
      return;
    }
    setBusy(true);
    setMsg("");
    navigator.geolocation.getCurrentPosition(
      (p) => save({
        enabled: true, lat: p.coords.latitude, lng: p.coords.longitude,
        anchor_source: "gps",
      }),
      () => {
        setBusy(false);
        setMsg(t("schedGeoDenied", "Allow location to set the venue."));
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  // ── Anchor from an address or a pasted map pin ────────────────────────
  // Standing at the venue is the most accurate way and stays the default, but
  // it is the ONLY way this panel used to offer — so an owner setting up at
  // home simply could not finish the step, and the geofence is what decides
  // who may clock in. A setup step that needs physical presence is one many
  // owners never complete.
  //
  // Two-step on purpose: resolve, show what was found, THEN save. A silent
  // one-tap "set from address" would let a typo re-point a live payroll
  // control with nothing on screen to catch it.
  const resolveQuery = async () => {
    const q = query.trim();
    if (q.length < 4) return;
    setBusy(true);
    setMsg("");
    setSavedMsg("");
    setFound(null);
    try {
      const res = await api.post("/staff/clock-geofence/resolve", { query: q });
      setFound(res.data);
    } catch (err) {
      setMsg(
        err?.response?.status === 404
          ? t("schedGeoNotFound", "Couldn't find that. Try a full address, or paste a map link.")
          : t("schedGeoErr", "Couldn't save. Try again."),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmFound = () => {
    if (!found) return;
    save({
      enabled: true, lat: found.lat, lng: found.lng,
      anchor_source: found.source, anchor_label: found.label || null,
    }).then(() => { setFound(null); setQuery(""); });
  };

  // COLLAPSED once the venue anchor exists. This panel is a Settings control
  // that lives on a work surface: the owner sets the anchor once, ever, and
  // then opens this page 52 times a year to build a rota. Expanded it occupied
  // the first strip of the page — the explainer, two checkboxes and a button —
  // pushing the week nav and the grid down by a card-height on every visit.
  //
  // Not moved to Settings, because the punch-clock rules genuinely belong beside
  // the roster they police. Collapsed instead: one line of state plus a way in.
  // When there is NO location yet it stays open — an unconfigured geofence is a
  // real call to action, not a setting.
  if (cfg.has_location && !open) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <Icon name="MapPin" size={14} className="text-gray-400 dark:text-gray-500 shrink-0" />
        <span className="text-gray-600 dark:text-gray-300">
          {cfg.enabled
            ? t("schedGeoSet", "Venue set · within {m} m", { m: cfg.radius_m })
            : t("schedGeoOffSummary", "Clock-in is not locked to the venue")}
        </span>
        {/* Which method anchored it. Absent on every anchor set before this
            shipped — those render nothing rather than an invented method. */}
        {cfg.enabled && cfg.anchor_label && (
          <span className="text-gray-400 dark:text-gray-500 truncate max-w-[16rem]">
            · {cfg.anchor_label}
          </span>
        )}
        {cfg.enabled && !cfg.anchor_label && cfg.anchor_source === "gps" && (
          <span className="text-gray-400 dark:text-gray-500">
            · {t("schedGeoFromGps", "set at the venue")}
          </span>
        )}
        {cfg.enabled && cfg.window_enabled && (
          <span className="text-gray-400 dark:text-gray-500">
            · {t("schedWindowNote", "Opens 15 min before the shift")}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-auto text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 rounded"
        >
          {t("change", "Change")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* Verbose explainer is desktop-only — on mobile it dominated the top of
          the Schedule page above the actual grid. The toggle + status below
          still convey the essential state. */}
      <p className="hidden sm:block w-full text-[12px] text-gray-500 dark:text-gray-400 leading-snug">
        {t("schedGeoHelp", "Staff can only clock in near the venue. Set the anchor from where you're standing, or type the address — their phone's location is checked at that moment only, never saved or tracked.")}
      </p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!cfg.enabled}
          disabled={busy || !cfg.has_location}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900 disabled:opacity-50"
        />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("schedGeoTitle", "Only clock in at the venue")}
        </span>
      </label>
      <span className="text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
        {cfg.has_location
          ? t("schedGeoSet", "Venue set · within {m} m", { m: cfg.radius_m })
          : t("schedGeoUnset", "No venue location set")}
      </span>
      <button
        type="button"
        onClick={setHere}
        disabled={busy}
        className="ml-auto inline-flex items-center justify-center min-h-[36px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        {cfg.has_location ? t("schedGeoReset", "Update location") : t("schedGeoUseHere", "Use my current location")}
      </button>

      {/* Address / map-link path. Sits UNDER the GPS button, not beside it:
          standing at the venue is still the accurate default, and this is the
          fallback for everyone who isn't there right now. */}
      <div className="w-full flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setFound(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveQuery(); } }}
          placeholder={t("schedGeoAddrPlaceholder", "…or type the address, or paste a map link")}
          className="flex-1 min-w-[220px] min-h-[36px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
        />
        <button
          type="button"
          onClick={resolveQuery}
          disabled={busy || query.trim().length < 4}
          className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
        >
          {t("schedGeoLookUp", "Find")}
        </button>
      </div>

      {/* Confirm step. The owner sees WHAT was found before it becomes the
          anchor — and is told plainly that an address lands on the building
          entrance, not on the spot where staff stand. Computed is not
          measured, and a 150 m radius is only forgiving if you know which
          one you got. */}
      {found && (
        <div className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Icon name="MapPin" size={14} className="text-gray-400 shrink-0" />
          <span className="text-[13px] text-gray-800 dark:text-gray-200 font-medium">
            {found.label || t("schedGeoFoundPin", "Pin from map link")}
          </span>
          <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
            {Number(found.lat).toFixed(5)}, {Number(found.lng).toFixed(5)}
          </span>
          <button
            type="button"
            onClick={confirmFound}
            disabled={busy}
            className="ml-auto inline-flex items-center justify-center min-h-[34px] px-3 rounded-lg bg-gray-900 dark:bg-gray-100 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-white transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
          >
            {t("schedGeoUseThis", "Use this")}
          </button>
          {/* The caveat has to match the METHOD. It was unconditional, and on
              a pasted pin it read "An address points at the building
              entrance…" — a sentence that is simply not true of a map pin,
              sitting under coordinates the owner is about to trust with
              clock-in. Caught on the live panel, not in review. */}
          <p className="w-full text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
            {found.source === "map_link" &&
              t(
                "schedGeoPinCaveat",
                "A dropped pin is only as exact as where it was placed — check it sits on the venue, not the street.",
              )}
            {found.source === "place_name" &&
              t(
                "schedGeoNameCaveat",
                "Found by name on a public map — check the address above is really yours before using it.",
              )}
            {found.source === "address" &&
              t(
                "schedGeoAddrCaveat",
                "An address points at the building entrance — close enough for the {m} m radius, but standing at the venue is more exact.",
                { m: cfg.radius_m },
              )}
          </p>
        </div>
      )}
      {/* Clock-in TIME window — one toggle, no knobs. Flip it on and staff can't
          clock in until 15 min before their shift (before that the staff app
          shows a calm "Låst" state with the exact open time). A fixed sensible
          default keeps it one-tap — no minutes to decide. */}
      <div className="w-full border-t border-gray-100 dark:border-gray-700/60 pt-2.5 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!cfg.window_enabled}
            disabled={busy}
            onChange={(e) => save({ window_enabled: e.target.checked, window_minutes: 15 })}
            className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900 disabled:opacity-50"
          />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("schedWindowTitle", "Only clock in near shift start")}
          </span>
        </label>
        {cfg.window_enabled && (
          <span className="text-[12px] text-gray-500 dark:text-gray-400">
            {t("schedWindowNote", "Opens 15 min before the shift")}
          </span>
        )}
      </div>
      {msg && <span className="w-full text-[12px] text-red-500 dark:text-red-400">{msg}</span>}
      {savedMsg && !msg && (
        <span className="w-full text-[12px] text-emerald-600 dark:text-emerald-400">{savedMsg}</span>
      )}
      {cfg.has_location && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="w-full text-left text-[12px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 rounded"
        >
          {t("done", "Done")}
        </button>
      )}
    </div>
  );
}

export default function StaffSchedulePage() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const { branchId } = useBranch();
  // Are we the popped-out window? Derived from the PATH, never threaded down
  // as a prop — the same call the reservations pop-out makes, and for the same
  // reason: a prop that isn't passed to every consumer throws
  // "standalone is not defined" and takes the whole page with it.
  // The route (/staff/schedule/stand) renders this page OUTSIDE <Layout />, so
  // "standalone" here means exactly one thing: no app chrome around us.
  const location = useLocation();
  const standalone = location.pathname.endsWith("/staff/schedule/stand");
  const currency = displayCurrency(user?.currency);
  // A manager/cashier/viewer seat sees the roster but never the wage layer.
  // The backend is locking the wage endpoint down to owners in parallel; this
  // hides the chrome so the 403 lands as "no cost column" rather than as a
  // toggle that does nothing and a total stuck on "—". We also stop ASKING for
  // the data (see fetchShifts) — no point firing a call we know is denied.
  //
  // A CURTAINED shared device counts as one, same rule as Layout.jsx:243 and
  // every other owner-financial gate. Two reasons, and the second is the one
  // that bites: (1) the whole point of "Delt enhed" is that colleagues' wage
  // costs are hidden while the tablet is out, and the client-side `stats`
  // fallback would happily recompute them from base_rate; (2) week-cost is on
  // the shared-device deny set now, so firing it on a curtained device answers
  // 403 device_pin_required — which the api interceptor turns into
  // "drop the reveal proof + raise the LockScreen". Merely opening the rota
  // would pop the PIN curtain on a page that carries no financials.
  const { enabled: devShared, locked: devLocked } = useDeviceShare();
  const isStaffSeat = isStaffMemberRole(user?.role) || (devShared && devLocked);
  // Vertical-aware shift-role list (salon → Frisør/…; else restaurant). Stable
  // module-array reference, so it's safe in hook dep arrays.
  const roles = rolesFor(user?.business_type);

  // Week navigation
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);

  // Data. `staff` and `shifts` now come from useAsyncData further down (they
  // are the two fetches whose silent [] told the lie this page was fixed for);
  // these two are painted layers with no claim of their own.
  const [availability, setAvailability] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [error, setError] = useState("");

  // Live labor-cost layer (server-computed, loaded/gross + labor% vs target).
  // Null when the endpoint fails — the UI falls back to the client `stats`
  // memo so the grid + summary still render. Never blocks shift rendering.
  const [weekCost, setWeekCost] = useState(null);
  // Vagtplan Shield — /schedules/week-load payload (per-staff hours, caps,
  // 11-timers rest warnings). null = unavailable (fail-soft, chip hidden).
  const [weekLoad, setWeekLoad] = useState(null);

  // Predicted demand (forecast-only, no roster build) — powers the persistent
  // "demand vs your roster" chip in the per-day footer so the owner FEELS the
  // forecast while hand-building shifts, not only in the one-shot Autopilot
  // card. Null for non-Pro (endpoint 402s) or on error → no chip, never blocks.
  const [forecast, setForecast] = useState(null);
  const forecastByDate = useMemo(() => {
    const m = {};
    for (const d of forecast?.days || []) m[d.date] = d;
    return m;
  }, [forecast]);

  // Owner display prefs (persisted so the choice sticks across sessions):
  //   showCost  — show the day/week wage TOTALS (footer, week header, mobile
  //                day strip). Never per shift: kr on a card, above the hours
  //                that produced it, IS that person's hourly rate (default on)
  //   costBasis — 'gross' (Løn) vs 'loaded' (Inkl. feriepenge) for all costs
  const [showCost, setShowCost] = useState(() => {
    try {
      return localStorage.getItem("bonbox_sched_showcost") !== "false";
    } catch {
      return true;
    }
  });
  const [costBasis, setCostBasis] = useState(() => {
    try {
      return localStorage.getItem("bonbox_sched_costbasis") === "loaded" ? "loaded" : "gross";
    } catch {
      return "gross";
    }
  });
  // Both prefs write through one helper so the "this browser refuses storage"
  // outcome is returned to a caller instead of vanishing inside a bare catch.
  // Nothing on screen depends on the answer — a pref that cannot persist costs
  // the owner one extra tap after a reload, it does not misreport anything.
  useEffect(() => {
    writePref("bonbox_sched_showcost", showCost ? "true" : "false");
  }, [showCost]);
  useEffect(() => {
    writePref("bonbox_sched_costbasis", costBasis);
  }, [costBasis]);
  // What the grid and the phone list actually receive. The owner's stored
  // preference AND the seat gate, resolved once here rather than at each of the
  // two call sites — a gate that has to be remembered twice is a gate that gets
  // remembered once.
  const costVisible = showCost && !isStaffSeat;

  // Staff management panel
  const [showManageStaff, setShowManageStaff] = useState(false);
  // Owner ↔ staff chat ("Beskeder") — drawer + launcher-badge unread count.
  const [chatOpen, setChatOpen] = useState(false);
  // Poll the cheap aggregate-unread endpoint so the launcher badge lights up
  // when staff write. `enabled: !chatOpen` pauses it while the drawer is open
  // (the drawer owns reads) WITHOUT reporting a failure — a question we chose
  // not to ask has no answer. A failed poll keeps the last count rather than
  // dropping the badge to 0: "we couldn't ask" must not read as "nobody
  // wrote". Badge-only, so there is no banner to raise.
  const chatUnreadQ = useAsyncData(
    () => api.get("/staff/chat/unread"),
    [chatOpen],
    { enabled: !chatOpen },
  );
  const { reload: reloadChatUnread } = chatUnreadQ;
  useEffect(() => {
    if (chatOpen) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reloadChatUnread();
    }, 25000);
    return () => clearInterval(id);
  }, [chatOpen, reloadChatUnread]);
  const chatUnread = chatUnreadQ.data?.unread || 0;

  // Shift modal
  const [shiftModal, setShiftModal] = useState(null); // { staffId, date, shift? }
  // Smart-default memory: the last shift the owner saved this session
  // ({ start, end, break_minutes, role }). When they open "Add Shift"
  // again for a staff with no prior shift this week, the modal pre-fills
  // from this so a run of similar shifts is 1 tap, not 5. Cleared on reload.
  const [lastShiftTemplate, setLastShiftTemplate] = useState(null);

  // Saved shift presets (Vagt-skabeloner) — reusable templates the owner keeps
  // across sessions (localStorage). Arming one makes the next empty-cell click
  // bloom from it instead of the most-recent-shift seed.
  const [shiftTemplates, setShiftTemplates] = useState(loadShiftTemplates);
  const [armedTemplateId, setArmedTemplateId] = useState(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const armedTemplate = useMemo(
    () => shiftTemplates.find((x) => x.id === armedTemplateId) || null,
    [shiftTemplates, armedTemplateId]
  );
  const addTemplate = useCallback((tpl) => {
    setShiftTemplates((prev) => {
      const next = [...prev, tpl];
      persistShiftTemplates(next);
      return next;
    });
    setShowTemplateModal(false);
  }, []);
  const removeTemplate = useCallback((id) => {
    setShiftTemplates((prev) => {
      const next = prev.filter((x) => x.id !== id);
      persistShiftTemplates(next);
      return next;
    });
    setArmedTemplateId((cur) => (cur === id ? null : cur));
  }, []);

  // Action states
  const [copying, setCopying] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Pre-publish confirm sheet (audit #248): holds a computed summary
  // { draftCount, staffCount, hours, cost, anyRate } while open; null = closed.
  // Publishing is the "money moment" staff see — owners get one calm glance at
  // what's about to go live before it does.
  const [publishConfirm, setPublishConfirm] = useState(null);
  // After a successful publish we keep the confirm sheet OPEN and swap it to a
  // success state (✓ + the server's real published/notify counts) — a durable
  // "it worked" moment beats a toast that blinks out. null = pre-publish.
  const [publishResult, setPublishResult] = useState(null);

  /* ─── Data fetching ─── */
  // THE ROSTER. `catch { setStaff([]) }` made "we could not read your team"
  // identical to "you have no team", and the page then offered the first-run
  // "Build your first schedule" panel to an owner with fifteen people on the
  // books. Three outcomes now: loading / failed / the real list.
  const staffQ = useAsyncData(
    () => {
      // include_inactive: deactivated staff must stay reachable — the owner
      // still has to clear their bank details after they leave, and the portal
      // stops working for them the moment active=false. Everything that
      // schedules or emails filters on `active` (see activeStaff), so they do
      // not leak into pickers.
      const params = { include_inactive: true };
      if (branchId) params.branch_id = branchId;
      return api.get("/staff/members", { params });
    },
    [branchId],
    { initial: [] },
  );
  // useMemo so the identity is stable across renders — a fresh [] on every
  // render would make every downstream memo (activeStaff, stats, the day
  // tallies) recompute for nothing.
  const staff = useMemo(() => staffQ.data || [], [staffQ.data]);
  const fetchStaff = staffQ.reload;

  // THE WEEK. The one the audit named: a failed load left shifts at [], which
  // is also what an untouched week looks like — and draftCount, computed from
  // this very array, then read 0, so the toolbar's primary action turned into
  // a green "Udgivet". The page claimed every shift was out to staff for a
  // week it had never managed to read. `failed` is now a state of its own and
  // the Published/Draft label is gated on it.
  const weekStartIso = toISO(weekStart);
  const shiftsQ = useAsyncData(
    () => {
      const params = { week_start: weekStartIso };
      if (branchId) params.branch_id = branchId;
      return api.get("/staff/schedules", { params });
    },
    [weekStartIso, branchId],
    { initial: [] },
  );
  const shifts = useMemo(() => shiftsQ.data || [], [shiftsQ.data]);
  const reloadShifts = shiftsQ.reload;

  // Two words, kept apart everywhere below: `loading` means we are still
  // asking, `loadFailed` means we asked and got nothing back. The old page had
  // only the first, so the second fell through to the empty state.
  const loading = staffQ.loading || shiftsQ.loading;
  const loadFailed = staffQ.failed || shiftsQ.failed;

  // The layers painted ON TOP of the week (cost, hours load, forecast,
  // availability, fravær). Each is fail-soft by design — a missing layer
  // removes a chip or a footer, it never invents a number — so they keep their
  // own catches, but they run as one step so every refresh path (initial load,
  // copy-week, publish, autopilot-apply, modal save) still moves together.
  const fetchWeekLayers = useCallback(async () => {
    const params = { week_start: toISO(weekStart) };
    if (branchId) params.branch_id = branchId;
    // Live labor cost — fetched alongside shifts so every refresh path
    // (initial load, copy-week, publish, autopilot-apply, modal save) keeps
    // the cost layer in sync. Fail-soft: on error (including the 403 a staff
    // seat now gets) null it out — the grid renders exactly the same, minus a
    // footer. Does NOT block the grid. Skipped outright for a staff seat: we
    // know the answer is "denied", so asking is just a red line in their
    // network tab and a wasted round trip.
    if (isStaffSeat) {
      setWeekCost(null);
    } else {
      try {
        const costRes = await api.get("/staff/schedules/week-cost", { params });
        setWeekCost(costRes.data || null);
      } catch {
        setWeekCost(null);
      }
    }
    // Vagtplan Shield — per-staff weekly load + DK labour signals (contract
    // cap, 48h ceiling, 11-timers reglen). Drives the hours chip on each grid
    // row + the pre-publish warnings. Fail-soft: never blocks the grid.
    try {
      const loadRes = await api.get("/staff/schedules/week-load", {
        params: { week_start: params.week_start },
      });
      setWeekLoad(loadRes.data || null);
    } catch {
      setWeekLoad(null);
    }
    // Predicted demand for this week (Pro-gated). Fail-soft: 402 for non-Pro or
    // any error just null it out → no forecast chip, grid unaffected.
    try {
      const fcRes = await api.get("/staff/schedules/forecast", {
        params, _noRetry: true,
      });
      setForecast(fcRes.data || null);
    } catch {
      setForecast(null);
    }
    // Standing "kan ikke" availability — painted as calm red cells on the grid
    // so the owner spots conflicts at a glance (at 15-30 rows especially). Not
    // week/branch scoped; fail-soft (never blocks the grid).
    let avRows = null;
    try {
      const avRes = await api.get("/staff/availability");
      avRows = avRes.data?.availability || [];
    } catch {
      avRows = null; // "we could not ask", which is NOT an empty list
    }
    // Only overwrite with an answer. Clearing to [] repainted every red cell
    // white, i.e. told the owner nobody had said "kan ikke" — and they roster
    // onto white. These rows are not week-scoped, so the ones already in hand
    // stay true; stale beats a false all-clear.
    if (avRows) setAvailability(avRows);
    // Approved/pending fravær (ferie, syg) — painted on the grid so the owner
    // sees who's off. include_resolved=true to also show 'covered' (still off);
    // 'cancelled' (declined) is filtered out client-side. Fail-soft.
    let absRows = null;
    try {
      const absRes = await api.get("/staff/absences", {
        params: { days_back: 31, include_resolved: true },
      });
      absRows = absRes.data || [];
    } catch {
      absRows = null; // same rule as availability: no answer ≠ nobody is off
    }
    if (absRows) setAbsences(absRows);
  }, [weekStart, branchId, isStaffSeat]);

  // Everything the week is made of, refreshed together. Every existing caller
  // (`await fetchShifts()` after a create / delete / move / copy-week /
  // publish / autopilot-apply) keeps its exact meaning.
  const fetchShifts = useCallback(
    async () => { await Promise.all([reloadShifts(), fetchWeekLayers()]); },
    [reloadShifts, fetchWeekLayers],
  );

  // Map staff_id → their standing "unavailable" blocks; a soft signal the owner
  // sees but can still override (they can hand-place onto a red cell).
  const availByStaff = useMemo(() => {
    const m = {};
    for (const a of availability) {
      // Keep BOTH kinds. "preferred" must never block a shift, but discarding
      // it here meant a staffer could mark days they WANT and no one ever saw
      // it — a control that writes to nowhere. Consumers below decide what a
      // kind means; this map just carries it.
      (m[String(a.staff_id)] = m[String(a.staff_id)] || []).push(a);
    }
    return m;
  }, [availability]);

  const matchAvail = useCallback((staffId, date, kind) => {
    const list = availByStaff[String(staffId)];
    if (!list || !list.length) return null;
    const iso = toISO(date);
    const pyWd = (date.getDay() + 6) % 7; // JS Sun=0 → DK/Python Mon=0
    for (const a of list) {
      const rowKind = a.kind === "preferred" ? "preferred" : "unavailable";
      if (rowKind !== kind) continue;
      const match = a.date ? a.date === iso : a.weekday === pyWd;
      if (match) return { ...a, timeLabel: a.start_time ? `${a.start_time}–${a.end_time}` : null };
    }
    return null;
  }, [availByStaff]);

  // Kept separate ON PURPOSE. Every caller of unavailFor treats a hit as a
  // reason NOT to roster someone; a preference is the opposite signal and must
  // never reach that path.
  const unavailFor = useCallback((staffId, date) => matchAvail(staffId, date, "unavailable"), [matchAvail]);
  const preferredFor = useCallback((staffId, date) => matchAvail(staffId, date, "preferred"), [matchAvail]);

  // Approved/pending fravær keyed by staff_id → { ISO date → row }. Excludes
  // declined ('cancelled'); a concrete absence outranks a standing "kan ikke".
  const absByStaff = useMemo(() => {
    const m = {};
    for (const a of absences) {
      if (a.status === "cancelled") continue;
      const sid = String(a.staff_id);
      (m[sid] = m[sid] || {})[a.date] = a;
    }
    return m;
  }, [absences]);

  const absenceFor = useCallback((staffId, date) => {
    const byDate = absByStaff[String(staffId)];
    return byDate ? byDate[toISO(date)] || null : null;
  }, [absByStaff]);

  // Both queries own their own mount/dep loads now; this is the retry handle
  // the LoadFailed banner hands the owner, and the one path that clears the
  // page-level error while it re-asks.
  const fetchAll = useCallback(async () => {
    setError("");
    await Promise.all([fetchStaff(), reloadShifts(), fetchWeekLayers()]);
  }, [fetchStaff, reloadShifts, fetchWeekLayers]);

  // The painted layers follow the week/branch the grid is showing. The roster
  // and the shifts themselves are fetched by their own hooks above.
  useEffect(() => {
    fetchWeekLayers();
  }, [fetchWeekLayers]);

  /* ─── Click-to-bloom (one-tap add) ─── */
  // Holds { id } of the just-bloomed draft for ~6s so a mis-tap is one tap to
  // remove (Fortryd). null = nothing to undo. Drafts never notify, so this is
  // a purely local convenience, NOT an "unsend".
  const [undoShift, setUndoShift] = useState(null);

  // Clicking an EMPTY cell drops a SEEDED DRAFT inline — no modal, no typing —
  // pre-filled from that staffer's most-recent shift (or this session's last
  // template). The modal stays as the deep-editor for OCCUPIED cells.
  // SAFE BY CONSTRUCTION: the POST omits `status`, so the backend defaults it
  // to 'draft' → a bloomed shift NEVER notifies staff. Only Publish notifies.
  const bloomDraft = useCallback(
    async (staffId, dateObj, memberRole) => {
      // An armed preset wins; else the staffer's most-recent shift; else the
      // session's last-used template. So tapping a preset then a day places it.
      const seed = armedTemplate || mostRecentShiftFor(shifts, staffId) || lastShiftTemplate || null;
      const startT = seed?.start_time || seed?.start || "16:00";
      const endT = seed?.end_time || seed?.end || "23:00";
      const payload = {
        staff_id: staffId,
        date: toISO(dateObj),
        start_time: startT,
        end_time: endT,
        // Respect a break the seed carries; otherwise default to the DK
        // suggestion for these times so a quick-placed 6h+ shift reads the
        // same hours as the punched/rostered one instead of a silent 0.
        break_minutes: seed?.break_minutes ?? suggestedBreak(startT, endT),
        role_on_shift: roleToShiftOption(seed?.role_on_shift || seed?.role || memberRole, roles),
        branch_id: branchId || undefined,
        // status intentionally OMITTED → backend defaults 'draft' → no notify.
      };
      try {
        const res = await api.post("/staff/schedules", payload);
        const createdId = res?.data?.id ?? null;
        await fetchShifts();
        if (createdId != null) {
          setUndoShift({ id: createdId });
          setTimeout(
            () => setUndoShift((u) => (u && u.id === createdId ? null : u)),
            6000
          );
        }
      } catch (err) {
        if (
          err?.response?.status === 409 &&
          err?.response?.data?.detail?.code === "shift_overlap"
        ) {
          setError(
            t("schedSlotTaken", "That overlaps a shift they already have that day.")
          );
        } else {
          setError(errText(err, t("shiftCreateFailed", "Failed to create shift.")));
        }
      }
    },
    [shifts, lastShiftTemplate, armedTemplate, branchId, fetchShifts, t, roles]
  );

  const undoBloom = useCallback(async () => {
    if (!undoShift) return;
    const id = undoShift.id;
    setUndoShift(null);
    try {
      await api.delete(`/staff/schedules/${id}`);
      await fetchShifts();
    } catch (err) {
      setError(errText(err, t("shiftDeleteFailed", "Failed to delete shift.")));
    }
  }, [undoShift, fetchShifts, t]);

  /* ─── Drag-to-move ([L] slice 1) ─── */
  // Holds { id, prevStaffId, prevDateIso } of the just-moved shift for ~6s so a
  // mis-drop is one tap to put it back (Fortryd). null = nothing to undo.
  const [undoMove, setUndoMove] = useState(null);

  // Reassign a shift to a NEW staff and/or day via PUT /staff/schedules/{id}
  // with the full payload where staff_id + date are the new target. Backend
  // update_schedule re-validates the staff belongs to the tenant. CRUCIALLY we
  // keep start/end/status UNCHANGED — update_schedule only notifies when a
  // PUBLISHED shift's start/end changed, so a move introduces NO notification.
  const moveShift = useCallback(
    async (shift, toStaffId, toDateIso) => {
      const prevStaffId = shift.staff_id ?? shift.staff_member_id;
      const prevDateIso = String(shift.date);
      const payload = {
        staff_id: toStaffId,
        date: toDateIso,
        start_time: shift.start_time,
        end_time: shift.end_time,
        break_minutes: shift.break_minutes || 0,
        role_on_shift: shift.role_on_shift,
        notes: shift.notes || undefined,
        status: shift.status,
        branch_id: branchId || undefined,
      };
      try {
        await api.put(`/staff/schedules/${shift.id}`, payload);
        setUndoMove({ id: shift.id, prevStaffId, prevDateIso });
        setTimeout(
          () => setUndoMove((u) => (u && u.id === shift.id ? null : u)),
          6000
        );
        await fetchShifts();
      } catch (err) {
        // 409 shift_overlap → the target staffer already works an overlapping
        // shift that day. Nothing moved (no undo to offer); just say so plainly.
        if (
          err?.response?.status === 409 &&
          err?.response?.data?.detail?.code === "shift_overlap"
        ) {
          setError(
            t("schedSlotTaken", "That overlaps a shift they already have that day.")
          );
        } else {
          setError(errText(err, t("shiftUpdateFailed", "Failed to update shift.")));
        }
      }
    },
    [branchId, fetchShifts, t]
  );

  const undoMoveAction = useCallback(async () => {
    if (!undoMove) return;
    const { id, prevStaffId, prevDateIso } = undoMove;
    setUndoMove(null);
    const s = shifts.find((x) => x.id === id);
    if (!s) return;
    try {
      await api.put(`/staff/schedules/${id}`, {
        staff_id: prevStaffId,
        date: prevDateIso,
        start_time: s.start_time,
        end_time: s.end_time,
        break_minutes: s.break_minutes || 0,
        role_on_shift: s.role_on_shift,
        notes: s.notes || undefined,
        status: s.status,
        branch_id: branchId || undefined,
      });
      await fetchShifts();
    } catch (err) {
      setError(errText(err, t("shiftUpdateFailed", "Failed to update shift.")));
    }
  }, [undoMove, shifts, branchId, fetchShifts, t]);

  /* ─── Week navigation ─── */
  // Each of these used to clear the error banner as a side effect of the
  // refetch they triggered (fetchAll owned setError("")). The fetch is the
  // hook's job now, so the clearing moves here, where it was always really
  // about the owner navigating away from whatever failed.
  const goToPrevWeek = () => {
    const prev = new Date(weekStart);
    prev.setDate(prev.getDate() - 7);
    setError("");
    setWeekStart(prev);
  };

  const goToNextWeek = () => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + 7);
    setError("");
    setWeekStart(next);
  };

  const goToCurrentWeek = () => {
    setError("");
    setWeekStart(getWeekStart(new Date()));
  };

  // Drives the "Denne uge" escape hatch — shown only when it would change
  // something. Compared as ISO strings, not Date identity: weekStart is a live
  // Date object and `===` on two Dates is never true.
  const isCurrentWeek = toISO(weekStart) === toISO(getWeekStart(new Date()));

  /* ─── Actions ─── */
  const handleCopyLastWeek = async () => {
    setCopying(true);
    setError("");
    try {
      const prevWeek = new Date(weekStart);
      prevWeek.setDate(prevWeek.getDate() - 7);
      await api.post("/staff/schedules/copy-week", {
        source_week: toISO(prevWeek),
        target_week: toISO(weekStart),
        branch_id: branchId || undefined,
      });
      await fetchShifts();
    } catch (err) {
      setError(errText(err, "Failed to copy last week's schedule."));
    }
    setCopying(false);
  };

  // Frontend mirror of the backend's _pick_rate: weekend (Sat/Sun) > evening
  // (≥18:00) > base, using each member's REAL premium rates (null → base). Keeps
  // the publish summary's labor figure on the same basis as the day/week wage
  // totals in the footer, instead of silently billing everything at base.
  const pickRate = (member, dateStr, startTime) => {
    const base = Number(member?.base_rate) || 0;
    const evening = Number(member?.evening_rate) || base;
    const weekend = Number(member?.weekend_rate) || base;
    const dow = new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun … 6=Sat
    if ((dow === 0 || dow === 6) && weekend > 0) return weekend;
    if (startTime && parseInt(String(startTime).slice(0, 2), 10) >= 18 && evening > 0) return evening;
    return base;
  };

  // Summarize the draft shifts that "Publish" will make live — computed from
  // already-loaded shifts + staff, so the confirm sheet is instant (no fetch).
  const computePublishSummary = () => {
    const drafts = (shifts || []).filter((s) => s.status === "draft");
    const staffIds = new Set();
    let hours = 0;
    let cost = 0;
    let anyRate = false;
    drafts.forEach((s) => {
      const sid = s.staff_id || s.staff_member_id;
      if (sid) staffIds.add(sid);
      const hrs = calcHours(s.start_time, s.end_time, s.break_minutes || 0);
      hours += hrs;
      const member = staff.find((m) => m.id === sid);
      const rate = pickRate(member, s.date, s.start_time);
      if (rate > 0) anyRate = true;
      cost += hrs * rate;
    });
    // Match the grid's basis: +12.5% feriepenge when "Inkl. feriepenge" is the
    // active view, so this figure adds up to the same week total the footer
    // shows. (There is no per-shift figure to agree with any more — the grid's
    // "≈ N kr." line is gone; see the note above the cost layer.)
    if (costBasis === "loaded") cost *= 1.125;
    return {
      draftCount: drafts.length,
      staffCount: staffIds.size,
      hours: Math.round(hours * 10) / 10,
      cost: Math.round(cost),
      anyRate,
    };
  };

  // Persistent at-a-glance state for the toolbar CTA: how many shifts are still
  // unpublished. 0 → the week is fully live and the button reads "Published".
  //
  // null when the week could not be read AT ALL. This is the count the audit
  // caught lying: derived from an array a failed fetch had left empty, it said
  // 0, and 0 is the value that makes the button claim "Udgivet". A count we
  // could not compute has to be a third value, not the reassuring one.
  const draftCount = useMemo(
    () => (shiftsQ.failed ? null : (shifts || []).filter((s) => s.status === "draft").length),
    [shifts, shiftsQ.failed],
  );

  // Step 1 — open the confirm sheet (the deliberate gate before going live).
  const requestPublish = async () => {
    setError("");
    setPublishResult(null);
    const summary = computePublishSummary();
    // Vagtplan Shield — refetch week-load at the publish moment (the state
    // copy can be stale if shifts were just added) and attach warnings.
    // Fail-soft: a fetch error publishes without warnings, never blocks.
    //
    // But it no longer publishes SILENTLY without them. An empty shield list
    // renders as no amber box, which the owner reads as "checked, nothing
    // wrong" — a clean bill of health on the 48-timers and 11-timers rules
    // that nobody actually ran. null now means "could not check", and the
    // sheet says that in words instead of showing a reassuring blank.
    let shield = [];
    try {
      const res = await api.get("/staff/schedules/week-load", {
        params: { week_start: toISO(weekDates[0]) },
      });
      for (const e of res.data?.staff || []) {
        if (e.over_dk48) {
          shield.push({ kind: "dk48", name: e.name, hours: e.hours });
        } else if (e.over_cap) {
          shield.push({ kind: "cap", name: e.name, hours: e.hours, cap: e.cap });
        }
        if (e.over_month) {
          shield.push({ kind: "month", name: e.name, hours: e.month_hours, cap: e.month_cap, period: e.period_label });
        }
        for (const r of e.rest_warnings || []) {
          shield.push({ kind: "rest", name: e.name, gap: r.gap_hours });
        }
      }
    } catch {
      shield = null; // could not check — NOT "nothing to warn about"
    }
    setPublishConfirm({ ...summary, shield });
  };

  // Step 2 — actually publish (called from the confirm sheet's CTA), then show
  // an HONEST success banner built from the server's real counts.
  const confirmPublish = async () => {
    setPublishing(true);
    setError("");
    try {
      const params = { week_start: toISO(weekStart) };
      if (branchId) params.branch_id = branchId;
      const res = await api.post("/staff/schedules/publish", null, { params });
      trackEvent("schedule_published", "schedule");  // product analytics
      await fetchShifts();
      const d = res.data || {};
      // Keep the sheet OPEN and flip it to a success state built from the
      // server's real counts — the durable confirmation that was missing.
      // notify is THREE outcomes, not a count with a convenient default.
      // Coercing the raw field with `|| 0` collapsed a missing value into 0,
      // and 0 is now a sentence the sheet says out loud — "nobody was told". A body
      // from an older backend, or a shape change, would have put those words
      // on screen about a publish that did notify people. null means we could
      // not tell, and the sheet says that instead of picking a side.
      const rawNotify = d.notify_count;
      const notify =
        rawNotify === null || rawNotify === undefined || !Number.isFinite(Number(rawNotify))
          ? null
          : Number(rawNotify);
      setPublishResult({
        published: Number(d.published) || 0,
        notify,
      });
    } catch (err) {
      setError(errText(err, "Failed to publish schedule."));
    }
    setPublishing(false);
  };

  const [exporting, setExporting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailToast, setEmailToast] = useState("");
  // Staff v2 (2026-05-28) — "Share with staff" CTA mints/refreshes
  // StaffLink magic-links for every staff scheduled this week and emails
  // each their portal URL. Distinct from "Email staff" (text-only
  // change-summary): this CTA is the on-ramp that gives staff a bookmarkable
  // /s/{token} URL where every future schedule edit + push notification
  // converges. Tier-gated on `staff_portal_link` (Starter+/Trial).
  const [sharing, setSharing] = useState(false);
  const [shareToast, setShareToast] = useState("");
  // Unified "Share schedule" sheet (2026-05-29) — replaces the email-only
  // window.confirm() with a checkbox picker: Select all / individual, then
  // Copy links (the UNIVERSAL channel — works for staff with no email, paste
  // into WhatsApp/SMS) or Email those who have an address. Links are minted
  // via POST /staff/members/{id}/link and cached so re-copying is instant.
  const [shareSheet, setShareSheet] = useState(false);
  // The hand-off chooser (F5). Three delivery paths that used to sit naked in
  // the toolbar, each now carrying the sentence that tells them apart.
  const [handoffSheet, setHandoffSheet] = useState(false);
  const [shareSel, setShareSel] = useState(() => new Set());
  const [shareLinks, setShareLinks] = useState({}); // staffId -> portal URL
  const [shareCodes, setShareCodes] = useState({}); // staffId -> short join code
  // staffId -> ISO timestamp of the last time that staffer opened their link,
  // or null for "never opened". Absent from the map = we have not asked.
  const [shareOpened, setShareOpened] = useState({});
  // The rollup of the above: null until the server has answered once. Three
  // outcomes — see utils/portalReach.js. Nothing on this page may state that
  // staff can see the week unless this says somebody has actually opened it.
  const [portalReach, setPortalReach] = useState(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCopiedN, setShareCopiedN] = useState(0);
  const [shareRowCopied, setShareRowCopied] = useState(null); // staffId just copied
  // Extra PIN lock per staff link (multi-layer link protection).
  const [pinHas, setPinHas] = useState({});       // staffId -> bool: link requires a PIN
  const [pinReveal, setPinReveal] = useState({}); // staffId -> the 4-digit PIN, shown ONCE after generating
  const [pinBusy, setPinBusy] = useState(null);   // staffId whose PIN toggle is in flight
  // Extra-PIN controls are hidden by default (off + out of sight) — the
  // everyday share flow is just login code + copy. Owners opt in per sheet.
  const [showPinControls, setShowPinControls] = useState(false);
  // UpgradeNudge state — bulk-staff-email is Pro+. Free/Starter
  // users still get the PDF download for printing/WhatsApp share.
  const [upgradeNudge, setUpgradeNudge] = useState(null);

  // Autopilot (Task #50 — Pro killer feature) — read 8 weeks of revenue
  // patterns + 7-day weather forecast + each staff's hourly cost, and
  // propose next week's schedule at minimum labor cost while respecting
  // DK labor law. Owner reviews → Apply materializes the draft shifts.
  const [autopilotLoading, setAutopilotLoading] = useState(false);
  const [autopilotApplying, setAutopilotApplying] = useState(false);
  const [autopilotSuggestion, setAutopilotSuggestion] = useState(null);
  const [autopilotToast, setAutopilotToast] = useState("");

  const handleRunAutopilot = async () => {
    setAutopilotLoading(true);
    setError("");
    setAutopilotToast("");
    try {
      const res = await api.post("/staff/schedules/autopilot", {
        week_start: toISO(weekStart),
        branch_id: branchId || undefined,
      });
      setAutopilotSuggestion(res.data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 402 && detail?.code === "plan_required") {
        setUpgradeNudge({
          tier: detail.upgrade_to || "pro",
          benefit: t(
            "nudgeAutopilot",
            "Let BonBox propose next week's schedule from your sales history + weather"
          ),
          // Was an emoji glyph, which rendered in the OS emoji font at
          // whatever colour/size the platform felt like — next to the
          // Lucide-iconed chooser one tap earlier it read as a different app.
          iconName: "Sparkles",
        });
      } else {
        setError(
          detail?.message ||
            (typeof detail === "string" ? detail : null) ||
            t("autopilotFailed", "Couldn't run autopilot.")
        );
      }
    } finally {
      setAutopilotLoading(false);
    }
  };

  const handleApplyAutopilot = async () => {
    if (!autopilotSuggestion) return;
    setAutopilotApplying(true);
    setError("");
    try {
      const shifts = autopilotSuggestion.days.flatMap((day) =>
        (day.shifts || []).map((s) => ({
          date: day.date,
          staff_id: s.staff_id,
          start: s.start,
          end: s.end,
          break_minutes: s.break_minutes,
          role: s.role,
        }))
      );
      const res = await api.post("/staff/schedules/autopilot/apply", {
        week_start: autopilotSuggestion.week_start,
        branch_id: branchId || undefined,
        shifts,
      });
      const n = res.data?.applied ?? shifts.length;
      setAutopilotToast(
        // The banner this lands in already draws a Lucide Sparkles at
        // icon="Sparkles"; the leading emoji was a second, mismatched
        // sparkle sitting right beside it.
        `${t("autopilotApplied", "Schedule applied")} — ${n} ${t(
          "autopilotShifts",
          "shifts scheduled"
        )}`
      );
      setTimeout(() => setAutopilotToast(""), 7000);
      setAutopilotSuggestion(null);
      await fetchShifts();
    } catch (err) {
      setError(
        errText(err, t("autopilotApplyFailed", "Couldn't apply the autopilot schedule."))
      );
    } finally {
      setAutopilotApplying(false);
    }
  };

  /** Email this week's schedule directly to every active staff
   *  member with an email on file. Reply-to is set server-side to
   *  the owner's address so staff replies come back to the owner.
   *
   *  We do a confirm() first because this fires a real email to
   *  every recipient — easy to surprise an owner who didn't realize
   *  the button does that. The confirm tells them up front how many
   *  emails are about to go out.
   */
  const handleEmailToStaff = async () => {
    const eligible = staff.filter(
      (s) => s.active !== false && (s.email || "").includes("@")
    );
    if (eligible.length === 0) {
      setError(
        t("scheduleEmailNoRecipients", "No active staff have an email yet. Add an email on each staff member.")
      );
      return;
    }
    const ok = await confirm({ message:
      (t("scheduleEmailConfirm", "Email this week's schedule to {n} staff?").replace("{n}", eligible.length))
      + "\n\n" + eligible.map(s => `• ${s.name} <${s.email}>`).join("\n")
    , destructive: false });
    if (!ok) return;

    setEmailing(true);
    setError("");
    setEmailToast("");
    try {
      const r = await api.post("/staff/schedules/email", {
        week_start: toISO(weekStart),
        lang: lang || "en",
        cc_self: true,
      });
      const sent = r.data?.sent || 0;
      const skipped = r.data?.skipped_no_email || 0;
      const failed = (r.data?.failed || []).length;
      let msg = `✓ ${sent} ${t("scheduleEmailSent", "sent")}`;
      if (skipped) msg += ` · ${skipped} ${t("scheduleEmailSkippedNoEmail", "skipped (no email)")}`;
      if (failed) msg += ` · ${failed} ${t("scheduleEmailFailed", "failed")}`;
      setEmailToast(msg);
      setTimeout(() => setEmailToast(""), 7000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required — surface as the UpgradeNudge dialog so the
      // owner sees a clean Pro pitch instead of a generic error toast.
      if (err?.response?.status === 402 &&
          detail?.code === "plan_required" &&
          detail?.feature === "bulk_staff_email") {
        setUpgradeNudge({
          tier: detail.required_plan || "pro",
          benefit: t("nudgeBulkStaffEmail", "Email this week's schedule to every staff member in one tap"),
          // Lucide, not an emoji envelope — see the Sparkles note above.
          iconName: "Mail",
        });
      } else {
        setError(detail?.message || (typeof detail === "string" ? detail : null) || (t("scheduleEmailFailedAll", "Couldn't email the schedule.")));
      }
    } finally {
      setEmailing(false);
    }
  };

  /**
   *  handleShareWithStaff — calls /staff/schedules/share-with-staff which
   *  (a) ensures every staff scheduled this week has an active StaffLink
   *      magic-link (mints token_urlsafe(24) when missing), and
   *  (b) emails each staff their personal /s/{token} portal URL.
   *
   *  After the call lands, future schedule edits trigger push notifications
   *  via the staff's portal subscription — the "auto-sync" requirement
   *  Manoj wired into the spec.
   *
   *  402 plan_required → opens the UpgradeNudge so Free owners see a clean
   *  upsell instead of a raw error. Other errors land in the error banner.
   */
  const handleShareWithStaff = async () => {
    const eligible = staff.filter(
      (s) => s.active !== false && (s.email || "").includes("@")
    );
    if (eligible.length === 0) {
      setError(
        t(
          "scheduleShareNoRecipients",
          "No active staff have an email yet — add an email so they can receive their schedule link."
        )
      );
      return;
    }
    const ok = await confirm({ message:
      (t(
        "scheduleShareConfirm",
        "Share this week's schedule with {n} staff via a personal magic link?"
      ).replace("{n}", eligible.length)) +
        "\n\n" +
        eligible.map((s) => `• ${s.name} <${s.email}>`).join("\n")
    , destructive: false });
    if (!ok) return;

    setSharing(true);
    setError("");
    setShareToast("");
    try {
      const r = await api.post("/staff/schedules/share-with-staff", {
        week_start: toISO(weekStart),
      });
      const emailed = r.data?.emailed_count || 0;
      const issued = r.data?.links_issued || 0;
      const skipped = r.data?.skipped_no_email || 0;
      const failed = r.data?.email_failed_count || 0;
      let msg = `✓ ${emailed} ${t("scheduleShareEmailed", "links sent")}`;
      if (issued)
        msg += ` · ${issued} ${t("scheduleShareIssued", "new links minted")}`;
      if (skipped)
        msg += ` · ${skipped} ${t(
          "scheduleShareSkippedNoEmail",
          "skipped (no email)"
        )}`;
      if (failed) msg += ` · ${failed} ${t("scheduleShareFailed", "failed")}`;
      setShareToast(msg);
      setTimeout(() => setShareToast(""), 7000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required → UpgradeNudge (the Starter+ value gate).
      if (
        err?.response?.status === 402 &&
        detail?.code === "plan_required" &&
        detail?.feature === "staff_portal_link"
      ) {
        setUpgradeNudge({
          tier: detail.required_plan || "starter",
          benefit: t(
            "nudgeStaffPortalLink",
            "Send every staff a personal schedule link — they bookmark it, get push when shifts change"
          ),
          // Lucide, not an emoji chain link — see the Sparkles note above.
          iconName: "Link2",
        });
      } else {
        setError(
          detail?.message ||
            (typeof detail === "string" ? detail : null) ||
            t("scheduleShareFailedAll", "Couldn't share the schedule.")
        );
      }
    } finally {
      setSharing(false);
    }
  };

  const handleExportPdf = async () => {
    setExporting(true);
    setError("");
    try {
      const res = await api.get("/staff/schedules/pdf", {
        params: { week_start: toISO(weekStart), lang: lang || "en" },
        responseType: "blob",
      });
      // This revoked the blob URL on the very next line, which races Safari's
      // fetch of it, and had no native path at all — so "PDF til opslagstavlen"
      // produced an empty file on a Mac and nothing whatsoever in the iOS app.
      const out = await saveFile(res.data, `bonbox-schedule-${toISO(weekStart)}.pdf`, {
        type: "application/pdf",
        title: t("schedHandoffPdfLabel", "PDF for the staff board"),
      });
      if (!out.ok) setError(t("schedulePdfFailed") || "Couldn't export PDF.");
    } catch (err) {
      setError(errText(err, t("schedulePdfFailed") || "Couldn't export PDF."));
    } finally {
      setExporting(false);
    }
  };

  /* ─── Shift helpers ─── */
  // ALL shifts in a cell, not the first one.
  //
  // This was `shifts.find(...)`, so a cell rendered exactly one shift per
  // person per day and the second was invisible AND uneditable — no way to
  // open, move or delete it from the grid. Meanwhile the Vagtplan Shield chip
  // beside the same name came from the server and counted every shift, and the
  // publish sheet counted the full array, so the screen contradicted itself:
  // Timer read 18.8t, the chip read 25t, the sheet said 8 drafts over 7 blocks.
  // The staff app showed the hidden shift the whole time.
  //
  // Second same-day shifts are reachable three ways in production: a staffer
  // claiming an open shift (writes a published row behind an overlap-only
  // guard), copy-week, and the Add-Shift modal's free staff+date picker — the
  // backend explicitly allows non-overlapping same-day shifts (staff.py:2187).
  // Sorted by start time so the earlier shift reads first.
  const getShiftsForCell = (staffId, date) => {
    const dateStr = toISO(date);
    return shifts
      .filter(
        (s) => (s.staff_member_id === staffId || s.staff_id === staffId) && s.date === dateStr
      )
      .sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")));
  };

  // A singular `getShiftForCell = getShiftsForCell(...)[0]` used to live here
  // and be handed to both the grid and the phone list. Every one of its
  // remaining callers turned out to be a place that had to see the WHOLE day
  // (day stats, the confirmation badge, the phone row), and reading a split
  // shift through [0] is precisely how they each dropped the second shift. The
  // plural accessor is now the only one — there is no singular to pick up by
  // accident.

  const activeStaff = useMemo(() => staff.filter((s) => s.active !== false), [staff]);

  /* ─── Stats ─── */
  const stats = useMemo(() => {
    let totalHours = 0;
    let totalCost = 0;
    shifts.forEach((s) => {
      const hrs = calcHours(s.start_time, s.end_time, s.break_minutes || 0);
      totalHours += hrs;
      const member = staff.find((m) => m.id === (s.staff_member_id || s.staff_id));
      const rate = member?.base_rate || 0;
      totalCost += hrs * rate;
    });
    return {
      totalHours: Math.round(totalHours * 10) / 10,
      totalCost: Math.round(totalCost),
      activeCount: activeStaff.length,
    };
  }, [shifts, staff, activeStaff]);

  /* ─── Live labor-cost derivations ─── */
  // costForShift() used to live here: a per-shift kroner lookup the grid and
  // the phone chip printed under the hours. It is gone on purpose. That number
  // divided by the hours printed directly above it IS the person's hourly rate,
  // and the Vagtplan is a screen colleagues, a stand-in manager and anyone
  // walking past the office look at. The cost layer still powers the DAY and
  // WEEK totals below — an aggregate tells the owner what they need (is this
  // week affordable?) without publishing anybody's wage.

  // Headline week summary — prefers the server's cost layer; falls back to the
  // client `stats` for hours/cost when the endpoint is unavailable. Labor% is
  // ONLY shown from the server (it needs revenue we don't compute client-side).
  const targetPct = typeof weekCost?.target_labor_pct === "number" ? weekCost.target_labor_pct : null;
  const weekSummary = useMemo(() => {
    const w = weekCost?.week || null;
    // The fallback to the client `stats` is the honest path ONLY while the
    // shifts it sums actually arrived. With the week unread, stats.totalHours
    // is 0 because there is nothing to add up, and "0 timer · ≈ 0 kr" is a
    // confident answer to a question we never got to ask. null → "—", the same
    // rule every money surface in the product already follows. The server's
    // own week figures (w) stay trustworthy either way — they are not derived
    // from the array that failed.
    const shiftsUnknown = shiftsQ.failed && !w;
    const hours = typeof w?.hours === "number" ? w.hours : (shiftsUnknown ? null : stats.totalHours);
    const cost = w ? costByBasis(w, costBasis) : (shiftsUnknown ? null : stats.totalCost);

    // The headline labor%. `w.labor_pct_*` is now an ACTUALS number over
    // settled days only (matched numerator/denominator — see staff.py), so on
    // a week that has not closed it is legitimately blank. `expected` fills
    // that in from the forecast the day cells are already showing, and says so
    // via isForecast; we never present a projection unlabelled.
    const expected = expectedWeekLabor({
      daily: weekCost?.daily,
      forecast,
      costBasis,
    });
    const actualPct = w
      ? (costBasis === "loaded" ? w.labor_pct_loaded : w.labor_pct_gross)
      : null;
    // Prefer the fuller answer: expected covers every day we have a basis for,
    // actuals cover only the closed ones. When no forecast qualified they are
    // the same number and isForecast is false, so nothing gets mislabelled.
    const laborPct =
      typeof expected.pct === "number"
        ? expected.pct
        : (typeof actualPct === "number" ? actualPct : null);

    return {
      // null travels all the way to the screen on purpose — `|| 0` and `?? 0`
      // here were what turned "unknown" into a number.
      hours: hours == null ? null : Math.round(hours * 10) / 10,
      cost: cost == null ? null : Math.round(cost),
      laborPct,
      isForecast: typeof expected.pct === "number" && expected.isForecast,
      daysActual: expected.daysActual,
      daysForecast: expected.daysForecast,
      daysUnknown: expected.daysUnknown,
      hasRevenue: laborPct != null,
    };
  }, [weekCost, forecast, costBasis, stats.totalHours, stats.totalCost, shiftsQ.failed]);

  // ─── Unified Share sheet helpers (this component owns the toolbar + state) ──
  const shareActiveStaff = () => activeStaff;

  /** Portal links + join codes for every staff member, in ONE round-trip.
   *
   *  Extracted from openShareSheet because the Manage Staff roster needs the
   *  same data: a join code is the ONLY way into the Scheduler app, and the
   *  roster is where an owner is actually thinking about a person. Having it
   *  live solely inside the Share sheet meant the credential was two screens
   *  away from the row that names its owner.
   *
   *  Owner-only on the server (_require_owner_actor), so a staff seat gets a
   *  403 here and simply renders no code — which is the correct outcome, not
   *  an error state.
   */
  const loadShareLinks = useCallback(async () => {
    try {
      const r = await api.get("/staff/schedules/share-links");
      const map = {};
      const codes = {};
      const pins = {};
      const opened = {};
      for (const row of r.data || []) {
        if (row.staff_id && row.portal_url) {
          map[row.staff_id] = `${window.location.origin}${row.portal_url}`;
        }
        if (row.staff_id && row.join_code) codes[row.staff_id] = row.join_code;
        if (row.staff_id) pins[row.staff_id] = !!row.has_pin;
        // null, deliberately, for a link nobody has ever opened: the KEY being
        // present is what says "we asked", and the value is what says "never".
        if (row.staff_id) opened[row.staff_id] = linkWasOpened(row) ? row.last_accessed : null;
      }
      setShareLinks((prev) => ({ ...map, ...prev }));
      // Server LAST for codes: `prev` spread last meant a cached code could
      // never be replaced by a fresh fetch. Harmless while the endpoint never
      // re-minted — and a live bug the moment it does, because the screen
      // would keep showing the burned code it had already cached.
      // shareLinks deliberately keeps prev-wins: a portal token is durable and
      // that ordering protects an in-flight per-staff mint. A code is not.
      setShareCodes((prev) => ({ ...prev, ...codes }));
      setPinHas(pins);
      setShareOpened(opened);
      // The server has answered, so the page may now speak about reach — and
      // only about what this answer says. `summarizePortalReach` returns null
      // for a non-array, which keeps a malformed 200 in the "we do not know"
      // bucket rather than letting it render as "nobody has opened it".
      setPortalReach(summarizePortalReach(r.data));
      return true;
    } catch {
      // Answered, not swallowed — and deliberately without a banner. This
      // pre-fetch is an optimisation with a REAL recovery: mintLinkFor
      // re-mints per staffer on demand, so a failure costs one round-trip at
      // copy time, not a wrong screen. A missing join code is also the correct
      // render for a manager seat (the endpoint is owner-only), which is
      // exactly why "no code" must not be dressed up as an error here.
      //
      // portalReach is left UNTOUCHED on purpose. A failed refetch is not
      // evidence that nobody opened their link, and it is not a reason to
      // discard an answer we already have — the page simply keeps saying
      // whatever it last actually knew, or stays silent if that is nothing.
      return false;
    }
  }, []);

  const openShareSheet = () => {
    // Default selection = everyone active (the "share to all" path; owner
    // unchecks who they don't want).
    setShareSel(new Set(activeStaff.map((s) => s.id)));
    setShareCopiedN(0);
    setShareRowCopied(null);
    setPinReveal({}); // never carry a shown-once PIN across opens
    setShowPinControls(false); // extra-PIN section starts collapsed each open
    setShareSheet(true);
    // Pre-fetch every link in ONE call so "Copy links" is instant and runs
    // inside the click gesture (no per-staff POST storm). mintLinkFor reads
    // this cache first; if the fetch fails we fall back to per-staff mint.
    loadShareLinks();
  };

  const shareAllSelected = () =>
    activeStaff.length > 0 && activeStaff.every((s) => shareSel.has(s.id));

  const toggleShareAll = () => {
    if (shareAllSelected()) setShareSel(new Set());
    else setShareSel(new Set(activeStaff.map((s) => s.id)));
  };

  const toggleShareOne = (id) => {
    setShareSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Mint (or reuse cached) a portal link for one staff member.
  const mintLinkFor = async (member) => {
    if (shareLinks[member.id]) return shareLinks[member.id];
    const res = await api.post(`/staff/members/${member.id}/link`);
    const fullUrl = `${window.location.origin}${res.data.portal_url}`;
    setShareLinks((prev) => ({ ...prev, [member.id]: fullUrl }));
    if (res.data.join_code) {
      setShareCodes((prev) => ({ ...prev, [member.id]: res.data.join_code }));
    }
    return fullUrl;
  };

  const _writeClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  // Copy one staff's link (per-row action).
  const copyOneLink = async (member) => {
    try {
      const url = await mintLinkFor(member);
      // Carry the app along with the link — so the staffer's WhatsApp/SMS
      // names the free BonBox Scheduler app + store link, the moment they
      // actually decide to install it. The link stays first (the main thing).
      const appLine = `${t("shareCopyAppLine", "Or get the free BonBox Scheduler app")}: https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793`;
      await _writeClipboard(`${url}\n\n${appLine}`);
      setShareRowCopied(member.id);
      setTimeout(() => setShareRowCopied(null), 2000);
    } catch (err) {
      setError(errText(err, "Failed to generate link"));
    }
  };

  // Turn the extra PIN lock on/off for one staffer's link. ON = we GENERATE
  // the 4-digit code (owner never invents one) and reveal it once so they
  // can read it to the staffer. OFF = link works with no PIN again.
  const toggleLinkPin = async (member) => {
    if (pinBusy) return;
    setPinBusy(member.id);
    try {
      if (pinHas[member.id]) {
        await api.delete(`/staff/members/${member.id}/link/pin`);
        setPinHas((p) => ({ ...p, [member.id]: false }));
        setPinReveal((p) => { const n = { ...p }; delete n[member.id]; return n; });
      } else {
        // {} not omitted: the endpoint takes an OPTIONAL body; axios with no
        // data sends no JSON body at all, which FastAPI 422s on older deploys.
        const res = await api.post(`/staff/members/${member.id}/link/pin`, {});
        setPinHas((p) => ({ ...p, [member.id]: true }));
        if (res.data?.pin) setPinReveal((p) => ({ ...p, [member.id]: res.data.pin }));
      }
    } catch (err) {
      setError(errText(err, t("pinToggleFailed", "Couldn't change the PIN")));
    } finally {
      setPinBusy(null);
    }
  };

  // Copy a combined "Name — url" block for every selected staff. UNIVERSAL:
  // works for staff with no email (paste into a WhatsApp/SMS group).
  // Mints in PARALLEL (a sequential await-loop crawled on a cold backend and
  // blew past the clipboard's user-gesture window for big teams). Cached
  // links resolve instantly, so re-copying is a no-op round-trip.
  const copySelectedLinks = async () => {
    const chosen = activeStaff.filter((s) => shareSel.has(s.id));
    if (chosen.length === 0) return;
    setShareBusy(true);
    try {
      const results = await Promise.all(
        chosen.map(async (m) => {
          try {
            return `${m.name} — ${await mintLinkFor(m)}`;
          } catch {
            return null; // skip per-staff failures; keep the rest
          }
        })
      );
      const lines = results.filter(Boolean);
      if (lines.length) {
        // One app line at the foot of the block — everyone who gets a link
        // also learns the free BonBox Scheduler app + store link.
        const appLine = `${t("shareCopyAppLine", "Or get the free BonBox Scheduler app")}: https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793`;
        await _writeClipboard(`${lines.join("\n")}\n\n${appLine}`);
        setShareCopiedN(lines.length);
        setTimeout(() => setShareCopiedN(0), 4000);
      }
    } finally {
      setShareBusy(false);
    }
  };

  const shareEmailableCount = () =>
    activeStaff.filter(
      (s) => shareSel.has(s.id) && (s.email || "").includes("@")
    ).length;

  /* ─── Render ─── */
  return (
    <div className="p-4 sm:p-6 max-w-7xl 2xl:max-w-[1728px] mx-auto space-y-6">
      <PageHeader
        eyebrow="STAFF"
        title={t("staffSchedule") || "Staff Schedule"}
        subtitle={t("staffScheduleDesc") || "Plan weekly shifts, manage staff, and track labor costs."}
        actions={
          /* Beskeder — owner ↔ staff 1:1 chat launcher. Unread badge polls the
             cheap aggregate endpoint; opening the drawer marks read.
             It used to sit in the week toolbar below, where it was the only
             control in that row that is not a step in building a week, and on
             a phone it was part of what pushed "Del" off the right edge. Here
             it keeps its label at every width and stays where an owner looks
             for an inbox. */
          <button
            onClick={() => setChatOpen(true)}
            title={t("ownerChatTitle", "Messages")}
            className="relative inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-medium bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 transition"
          >
            <Icon name="MessageSquare" size={14} />
            <span>{t("navMessages", "Messages")}</span>
            {chatUnread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[16px] text-center">
                {chatUnread > 9 ? "9+" : chatUnread}
              </span>
            )}
          </button>
        }
      />

      {/* Live punch-clock — who's on the clock right now (staff self-clock
          from their portal, auto-updates ~30s). Hides when nobody's in. */}
      <ClockedInStrip />

      {/* Clock-in location lock (opt-in geofence). */}
      <ClockGeofenceSettings />

      {/* Fravær (ferie/sygdom) that need godkend/afvis. Interrupt-only —
          hides itself when nothing is pending. This card had no mount point
          anywhere in the app before; the Vagtplan is its natural home since
          the owner manages staff here. */}
      <SickCallNotificationCard />

      {/* Peer-confirmed shift swaps awaiting the owner's final approve/deny.
          Interrupt-only — hides when none pending. Built + endpoint-backed
          (/staff/swap-requests) but had no mount point before the 2026-07-01
          trust sweep, so the owner could never act on accepted swaps. */}
      <SwapRequestNotificationCard />

      {/* "3 of 4 staff confirmed this week's schedule" — the owner half of the
          bidirectional confirmation loop. Self-hides when nothing is published
          or once everyone has confirmed. */}
      <ScheduleConfirmationCard />

      {/* Week navigation + actions */}
      <FadeIn delay={0.05}>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Week nav — on a phone the arrows lose their word labels and the
                date label flexes into whatever is left. With the words shown,
                Previous (~100pt) + the 220pt label + Next (~80pt) + gaps came
                to ~416pt against the ~338pt actually available inside the page
                and card padding, so the label wrapped to two lines and pushed
                the buttons into the card edges. sm: and up is unchanged. */}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrevWeek}
                aria-label={t("schedPrevWeek", "Previous")}
              >
                {"\u2190"}<span className="hidden sm:inline"> {t("schedPrevWeek", "Previous")}</span>
              </Button>
              {/* Week pill. "Uge 38" carries the weight; the dates follow in
                  normal gray as confirmation. It used to be one semibold run,
                  which made the number \u2014 the thing a DK owner actually
                  navigates by \u2014 no louder than the month names beside it.
                  `title`, NOT aria-label: an aria-label REPLACES the visible
                  text for a screen reader, so the old pattern would have
                  announced "Go to this week" and never read the week out. */}
              <button
                onClick={goToCurrentWeek}
                title={t("schedGoToThisWeek", "Go to this week")}
                className="px-4 py-2 rounded-lg text-sm bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] border border-gray-200 dark:border-gray-700 flex-1 sm:flex-none min-w-0 sm:min-w-[220px] text-center hover:bg-gray-100 dark:hover:bg-[rgb(var(--surface-raised))] transition"
              >
                <span className="font-semibold text-gray-900 dark:text-gray-100">
                  {formatWeekLabel(weekStart, lang)}
                </span>{" "}
                <span className="font-normal text-gray-600 dark:text-gray-400">
                  <span className="sm:hidden">{formatWeekDatesShort(weekStart, lang)}</span>
                  <span className="hidden sm:inline">{formatWeekDates(weekStart, lang)}</span>
                </span>
              </button>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNextWeek}
                aria-label={t("schedNextWeek", "Next")}
              >
                <span className="hidden sm:inline">{t("schedNextWeek", "Next")} </span>{"\u2192"}
              </Button>
              {/* "Denne uge" \u2014 the way back after browsing. Clicking the pill
                  has always done this and nothing anywhere said so (the pill
                  gained its title in the same change); three weeks forward, the
                  owner's only route home was three taps on \u2190. Shown ONLY when
                  it would do something, and sm:+ only \u2014 on a phone the row is
                  already full. */}
              {!isCurrentWeek && (
                // The wrapper (not a `hidden` class on the Button) does the
                // hiding: Button's own BASE already sets `inline-flex`, and two
                // display utilities on one element is a coin-toss decided by
                // stylesheet order, not by the order they are written.
                <span className="hidden sm:block">
                  <Button variant="ghost" size="sm" onClick={goToCurrentWeek}>
                    {t("schedThisWeek", "This week")}
                  </Button>
                </span>
              )}
            </div>

            {/* Action buttons — one accent (Publish = the money moment),
                rest secondary / ghost. */}
            {/* Mobile-first toolbar: 7 actions in one row.  On phones the
                verbose labels (Copy Last Week, Share with staff, Email
                staff) collapse to icon-only with title-tooltips, so they
                fit a 375px viewport in 2 rows max. Tablet+ shows full
                labels. */}
            {/* The phone row used to be `flex-nowrap overflow-x-auto` with its
                scrollbar suppressed (here AND by index.css on coarse pointers).
                It held six controls — Tilføj, Kopiér, Auto, Udgiv · N, Beskeder,
                Del — which measure roughly 450px against the 338px a 402pt
                phone leaves inside the page and card padding. So "Del" simply
                ended past the right edge of a row with nothing on screen saying
                it scrolled: the owner's way of getting the week to the team was
                invisible on the device most of them build the week on.

                Two fixes, both subtraction. Beskeder left this row entirely —
                it is an inbox, not a step in building a week, and it now lives
                in the page header where it is visible from every scroll
                position. And the row WRAPS on a phone instead of scrolling, so
                the five that remain are all on screen and all tappable. From
                sm: up nothing changes — it was already flex-wrap there. */}
            <div className="flex items-center gap-2 flex-wrap [&>*]:shrink-0 justify-start sm:justify-end w-full sm:w-auto">
              {/* Secondary, not primary. The week has exactly ONE headline
                  action — Udgiv — and a toolbar with three gray-900 buttons
                  tells the owner nothing about which of them finishes the job. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShiftModal({ staffId: null, date: null, shift: null })}
                iconLeft={<Icon name="Plus" size={14} />}
                title={t("schedAddShiftTitle", "Add shift")}
              >
                <span className="hidden sm:inline">{t("schedAddShift", "Add Shift")}</span>
                <span className="sm:hidden">{t("schedAddShort", "Add")}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyLastWeek}
                disabled={copying}
                busy={copying}
                title={t("schedCopyLastWeekTitle", "Copy last week's schedule")}
                iconLeft={!copying && <Icon name="Copy" size={14} />}
              >
                {copying
                  ? "…"
                  : (<>
                      <span className="hidden sm:inline">{t("schedCopyLastWeek", "Copy Last Week")}</span>
                      <span className="sm:hidden">{t("schedCopyShort", "Copy")}</span>
                    </>)}
              </Button>
              {/* Autopilot (Pro+ killer feature) — proposes next week's
                  schedule from 8 weeks of sales + the 7-day forecast +
                  staff hourly cost. Tier-gated: Starter/Free see an
                  UpgradeNudge dialog on click; Pro/Trial run it. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRunAutopilot}
                disabled={autopilotLoading}
                busy={autopilotLoading}
                iconLeft={!autopilotLoading && <Icon name="Sparkles" size={14} />}
                title={t(
                  "autopilotTitle",
                  "Let BonBox propose next week's schedule from your data"
                )}
              >
                {autopilotLoading
                  ? t("autopilotRunning", "…")
                  : (<>
                      {/* Its three siblings in this row all collapse to a short
                          label below sm:; this one did not, and it is what
                          pushed the row past 402pt. The row IS horizontally
                          scrollable by design, but the scrollbar is hidden
                          (scrollbar-width:none here, and index.css suppresses
                          it on coarse pointers), so the overflow read as a
                          rendering bug: the Publish button sliced mid-word to
                          "Publishe". Fixing the width is better than adding a
                          scroll hint for a row that should simply fit. */}
                      <span className="hidden sm:inline">{t("autopilotButton", "Autopilot")}</span>
                      <span className="sm:hidden">{t("autopilotShort")}</span>
                    </>)}
              </Button>
              {/* THE one primary action on this row. `loading` is checked
                  before draftCount: until the week's shifts have arrived
                  draftCount is 0, and the button then rendered a green tick and
                  the words "Udgivet" — a claim that every shift was already out
                  to staff, made about a week nobody had looked at yet.

                  A FAILED week now lands in the same place, and that is the
                  third state this page was missing: draftCount is null, not 0,
                  so the tick cannot appear for a week we could not read. The
                  button shows "—" and says so in its title. The grid below
                  carries the amber banner and the Try again. */}
              <Button
                variant={draftCount > 0 ? "accent" : "secondary"}
                size="sm"
                onClick={requestPublish}
                disabled={publishing || loading || draftCount == null}
                busy={publishing}
                title={loading
                  ? t("schedPublishWeekTitle", "Publish week")
                  : draftCount == null
                    ? t("somethingWentWrong")
                    : draftCount > 0
                      ? t("schedPublishWeekTitle", "Publish week")
                      : t("schedAllPublishedTitle", "All shifts published")}
              >
                {publishing ? (
                  "…"
                ) : loading || draftCount == null ? (
                  <span className="tabular-nums text-gray-400 dark:text-gray-500">—</span>
                ) : draftCount > 0 ? (
                  <>
                    <span className="hidden sm:inline">{t("publishConfirmCta", "Publish Week")}</span>
                    <span className="sm:hidden">{t("publishShort", "Publish")}</span>
                    <span className="ml-1 tabular-nums opacity-80">· {draftCount}</span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="CheckCircle2" size={14} />
                    {t("publishedState", "Published")}
                  </span>
                )}
              </Button>
              {/* Beskeder moved to the PageHeader actions slot — see the note
                  on this row's container above. */}
              {/* ONE hand-off control.
                  This row used to offer four near-identical ways to get the
                  week to staff — Udgiv, Del med medarbejdere, Send til
                  medarbejdere and a PDF — with nothing on screen explaining
                  which of them notifies anybody. Udgiv stays out here because
                  it is the one that finishes the week; the other three are
                  DELIVERY choices, so they collapse behind one button and each
                  states, in a sentence, who receives what and whether they are
                  told. No publish or notify semantics changed — the same three
                  handlers run, one tap further in. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Ask who has actually opened their link at the moment the
                  // owner starts a hand-off. Same owner-only call the Share
                  // sheet and the roster already make (and a no-op re-read once
                  // every staffer has a live code), but made HERE it means the
                  // reach line below the toolbar can stop guessing before the
                  // owner sends the week out one more time into silence.
                  loadShareLinks();
                  setHandoffSheet(true);
                }}
                disabled={sharing || emailing || exporting}
                busy={sharing || emailing || exporting}
                iconLeft={!(sharing || emailing || exporting) && <Icon name="Share2" size={14} />}
                title={t("schedHandoffTitle", "Choose how this week reaches your staff")}
              >
                <span className="hidden sm:inline">{t("schedHandoffButton", "Share week")}</span>
                <span className="sm:hidden">{t("scheduleShareButtonShort", "Share")}</span>
              </Button>
              {/* Pop the week out to its own window — no sidebar, full width for
                  a 7-column grid. Icon-only and last: it changes nothing, so it
                  must not compete with the actions that do.
                  Desktop only (sm+): on a phone there is no sidebar to escape,
                  so the button would cost space and buy nothing.
                  Hidden while already popped out — a control that re-opens the
                  window you are standing in is a dead end. */}
              {!standalone && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-sm:hidden"
                  onClick={() =>
                    window.open("/staff/schedule/stand", "_blank", "noopener,noreferrer")
                  }
                  aria-label={t("schedOpenWindow", "Open schedule in its own window")}
                  title={t("schedOpenWindow", "Open schedule in its own window")}
                  iconLeft={<Icon name="ExternalLink" size={14} />}
                />
              )}
            </div>
          </div>
          {/* Reach, not reassurance.
              This line used to read "Your team sees these shifts in the BonBox
              Scheduler app" — unconditionally, on every owner's screen, from
              the first minute of a brand-new account with no staff and no link
              ever sent. It was the product's most-read sentence about staff
              delivery and it was asserted, never checked. Across 51 venues not
              one staff link had ever been opened, so it was false everywhere it
              mattered, and it is a large part of why nobody found out: the
              owner shared the week, read this, and had no reason to look
              further.
              Now it states what `last_accessed` on the staff links actually
              says, in three outcomes:
                • portalReach === null — we have not asked the server (the call
                  is owner-only and deliberately not made on mount). Render
                  NOTHING. Silence is the only honest output for "unknown"; the
                  zero-state below would be a different, equally wrong claim.
                • opened > 0 — say how many, and keep the store link.
                • opened === 0 — say so plainly and hand over the control that
                  fixes it. Not a dead end: it opens the same hand-off chooser
                  as the toolbar button. */}
          {portalReach && portalReach.staff > 0 && (
            portalReach.opened > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-gray-400 dark:text-gray-500">
                {/* No leading icon: a 14px Lucide "Smartphone" is a bare rounded
                    rectangle at this size and read as a missing-glyph box rather
                    than an icon. */}
                <span>
                  {/* "staff links", not "your team": the denominator is the
                      rows this endpoint returned — one per non-deleted staff
                      member, which can include someone deactivated. Counting
                      links is the thing we actually measured, so that is what
                      the sentence names. */}
                  {t(
                    "scheduleStaffOpenedCount",
                    "{opened} of {total} staff links have been opened",
                    { opened: portalReach.opened, total: portalReach.staff },
                  )}
                </span>
                {/* The separator travels WITH the link — on a phone the line broke
                    after the "·", orphaning it at the end of the first line. */}
                <span className="whitespace-nowrap">
                  <span aria-hidden="true">·</span>{" "}
                  <a
                    href="https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
                  >
                    {t("appStore", "App Store")}
                  </a>
                </span>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
                <Icon name="AlertTriangle" size={13} className="shrink-0" />
                <span>
                  {t(
                    "scheduleStaffNoneOpened",
                    "No one has opened their schedule link yet",
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => { loadShareLinks(); setHandoffSheet(true); }}
                  className="font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300 transition-colors"
                >
                  {t("schedHandoffButton", "Share week")}
                </button>
              </div>
            )
          )}
        </div>
      </FadeIn>

      {/* C7 — Forecast & demand (weather-smart + smart-staffing), collapsed
          by default. Sits between the week toolbar and the grid so the
          owner can glance at next week's weather + recommended headcount
          while planning, without it dominating the page. */}
      <FadeIn delay={0.07}>
        <ScheduleForecastPanel />
      </FadeIn>

      {/* Error banner */}
      {error && (
        <SectionBanner
          severity="critical"
          title={error}
          icon="AlertTriangle"
          onDismiss={() => setError("")}
        />
      )}
      {/* Email-success toast (auto-dismisses after 7s \u2014 see handleEmailToStaff) */}
      {emailToast && (
        <SectionBanner
          severity="success"
          title={emailToast}
          icon="CheckCircle2"
          onDismiss={() => setEmailToast("")}
        />
      )}
      {/* Share-success toast (auto-dismisses after 7s \u2014 see handleShareWithStaff) */}
      {shareToast && (
        <SectionBanner
          severity="success"
          title={shareToast}
          icon="Link2"
          onDismiss={() => setShareToast("")}
        />
      )}
      {/* Autopilot-success toast (auto-dismisses after 7s) */}
      {autopilotToast && (
        <SectionBanner
          severity="success"
          title={autopilotToast}
          icon="Sparkles"
          onDismiss={() => setAutopilotToast("")}
        />
      )}
      {/* (Publish success now lives in the PublishConfirmModal's success state —
          a durable ✓ panel with the server's real counts, not a fleeting toast.
          The old publishToast SectionBanner was removed with its state.) */}

      {/* Autopilot suggestion review panel \u2014 Pro killer feature (Task #50).
          Renders ONLY when a suggestion is loaded. Owner reviews per-day
          predictions + suggested shifts then taps Apply (materializes draft
          rows) or Discard. */}
      {autopilotSuggestion && (
        <FadeIn delay={0.02}>
          {/* No `currency` prop any more: every figure inside the panel goes
              through formatKr, which emits its own "kr." — the bare code token
              it used to append is gone with the bare toLocaleString. */}
          <AutopilotPanel
            suggestion={autopilotSuggestion}
            staff={staff}
            applying={autopilotApplying}
            onApply={handleApplyAutopilot}
            onDiscard={() => setAutopilotSuggestion(null)}
            t={t}
            lang={lang}
          />
        </FadeIn>
      )}


      {/* Manage Staff collapsible */}
      <FadeIn delay={0.1}>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
          <button
            onClick={() => {
              // Fetch the codes on EXPAND, not on mount: this is owner-only
              // data and most visits to the schedule never open the roster.
              // From the click handler rather than an effect so the state
              // write stays in an event, per react-hooks/set-state-in-effect.
              if (!showManageStaff) loadShareLinks();
              setShowManageStaff(!showManageStaff);
            }}
            aria-expanded={showManageStaff}
            className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition rounded-xl"
          >
            <span className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Icon name="Users" size={16} className="text-gray-500" /> {t("schedManageStaff", "Manage Staff")}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                ({activeStaff.length} {t("schedActiveCount", "active")})
              </span>
            </span>
            <Icon name="ChevronDown" size={16} className={`text-gray-500 transition-transform ${showManageStaff ? "rotate-180" : ""}`} />
          </button>
          {showManageStaff && (
            <StaffPanel
              staff={staff}
              currency={currency}
              onRefresh={fetchStaff}
              branchId={branchId}
              joinCodes={shareCodes}
              onCodeMinted={(id, code) =>
                setShareCodes((prev) => ({ ...prev, [id]: code }))
              }
            />
          )}
        </div>
      </FadeIn>

      {/* Legend — STATUS first, roles second.
          Status leads because it is the half an owner has to be taught: the
          dashed amber card, the emerald column dot and the emerald check are
          three new marks and none of them is guessable. Roles come second and
          list only the sections THIS vertical actually has — sectionsFor()
          returns [] for retail/services/personal, which is why those verticals
          also get no row dot (a dot with nothing in the legend explaining it is
          decoration pretending to be a key).
          The old "FRI / Ingen vagt" gray dot is gone: it matched nothing on the
          grid. An empty cell is SILENT — no dot was ever drawn in it — so the
          legend was teaching a mark that does not exist. */}
      <FadeIn delay={0.12}>
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">{t("schedLegendStatus", "Status:")}</span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm border border-dashed border-amber-400 dark:border-amber-500/60" aria-hidden="true" />
            {t("schedLegendDraft", "Draft – not sent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
            {t("schedLegendPublished", "Published")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
            {t("schedDayAllSeen", "Everyone has seen their shift")}
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} aria-hidden="true" />
            {t("schedSeenByStaff", "Seen by the staffer")}
          </span>
          {sectionsFor(user?.business_type).length > 0 && (
            <>
              <span className="font-medium ml-1">{t("schedLegendRoles", "Roles:")}</span>
              {sectionsFor(user?.business_type).map((s) => (
                <span key={s} className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${(ROLE_COLORS[s] || ROLE_COLORS.floor).dot}`} aria-hidden="true" />
                  {roleLabel(s, t)}
                </span>
              ))}
            </>
          )}
        </div>
      </FadeIn>

      {/* Saved shift presets — tap a chip to arm it, then tap a day to drop it.
          Hidden while the week is unknown: the cells they arm are not on
          screen, so the tray would be a control with nowhere to land. */}
      {!loading && !loadFailed && activeStaff.length > 0 && (
        <FadeIn delay={0.13}>
          <ShiftTemplatesTray
            templates={shiftTemplates}
            armedId={armedTemplateId}
            onArm={setArmedTemplateId}
            onAddClick={() => setShowTemplateModal(true)}
            onRemove={removeTemplate}
            t={t}
          />
        </FadeIn>
      )}

      {/* Schedule Grid.
          The order is the whole fix, and it only works in this order:
          loading (a skeleton that says what it is waiting for) → FAILED (the
          amber banner + Try again) → empty (the first-run panel, which is now
          only ever shown to someone who really has no team) → the week.
          LoadFailed replaces the empty state here rather than sitting above
          it: showing both would still leave "Build your first schedule" on a
          page that has no idea whether there is one. */}
      <FadeIn delay={0.15}>
        {loading ? (
          <GridSkeleton t={t} />
        ) : loadFailed ? (
          <LoadFailed
            onRetry={fetchAll}
            body={t(
              "schedLoadFailedBody",
              "This week couldn't be loaded, so nothing below is the full picture yet.",
            )}
          />
        ) : activeStaff.length === 0 ? (
          <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Ghosted grid backdrop — first-run still reads as "this is where
                your week lives"; the real first step is adding the team. */}
            <div className="pointer-events-none absolute inset-0 opacity-[0.35] dark:opacity-[0.18]" aria-hidden="true">
              <div className="grid grid-cols-7 gap-px p-4">
                {Array.from({ length: 28 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-10 rounded-md ${i % 4 === 0 ? "bg-gray-200 dark:bg-gray-700" : "bg-gray-100 dark:bg-gray-700/40"}`}
                  />
                ))}
              </div>
            </div>
            <div className="relative px-6 py-14 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-white">
                <Icon name="CalendarDays" size={22} />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t("schedFirstRunTitle", "Build your first schedule")}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
                {t("schedFirstRunBody", "Add your team, then plan a week of shifts in seconds — click a day to drop a shift, or let Autopilot draft it.")}
              </p>
              <button
                type="button"
                onClick={() => setShowManageStaff(true)}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gray-900 text-white px-5 py-2.5 text-sm font-semibold hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
              >
                <Icon name="Users" size={16} />
                {t("schedFirstRunCta", "Add staff members")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop / tablet grid — tablets in portrait (≥ md = 768px)
                still get the full week table since they have the width.
                Phones in landscape at 640px deserve the mobile day-list
                experience, hence `md:` not `sm:`. */}
            <div className="hidden md:block">
              <ScheduleGrid
                staff={activeStaff}
                weekDates={weekDates}
                getShiftsForCell={getShiftsForCell}
                unavailFor={unavailFor}
                preferredFor={preferredFor}
                absenceFor={absenceFor}
                showCost={costVisible}
                currency={currency}
                dailyCost={weekCost?.daily || null}
                forecast={forecast}
                forecastByDate={forecastByDate}
                costBasis={costBasis}
                targetPct={targetPct}
                weekLoad={weekLoad}
                t={t}
                lang={lang}
                onMoveShift={moveShift}
                onCellClick={(staffId, date, existingShift) =>
                  existingShift
                    ? setShiftModal({ staffId, date: toISO(date), shift: existingShift })
                    : bloomDraft(staffId, date, (activeStaff.find((m) => m.id === staffId) || {}).role)
                }
              />
            </div>
            {/* Mobile day-at-a-time list. Default day = today (within the
                current week range). Swipe arrows + day-strip switch the
                visible day. Same setShiftModal so the edit flow is
                identical across viewports. */}
            <div className="md:hidden">
              <MobileSchedule
                staff={activeStaff}
                weekDates={weekDates}
                getShiftsForCell={getShiftsForCell}
                unavailFor={unavailFor}
                preferredFor={preferredFor}
                absenceFor={absenceFor}
                currency={currency}
                showCost={costVisible}
                isStaffSeat={isStaffSeat}
                weekCost={weekCost}
                costBasis={costBasis}
                targetPct={targetPct}
                t={t}
                lang={lang}
                onCellClick={(staffId, date, existingShift) =>
                  existingShift
                    ? setShiftModal({ staffId, date: toISO(date), shift: existingShift })
                    : bloomDraft(staffId, date, (activeStaff.find((m) => m.id === staffId) || {}).role)
                }
              />
            </div>
          </>
        )}
      </FadeIn>

      {/* Åbne vagter — unassigned slots staff claim one-tap. Portal-backed, so
          shown only for paid plans (Free can't share/claim); the create call is
          still server-gated on staff_portal_link as the real barrier. */}
      {user?.plan !== "free" && (
        <FadeIn delay={0.15}>
          <OpenShiftsPanel weekStart={weekStart} t={t} />
        </FadeIn>
      )}

      {/* Week summary bar — the live labor-cost headline. Hidden on mobile;
          MobileSchedule embeds the per-day cost + labor% strip inline, so a
          second summary here would be redundant. Hours/cost fall back to the
          client `stats` when the cost endpoint is unavailable; labor% only
          shows when the server returned revenue (never fabricated). */}
      <FadeIn delay={0.2}>
        <div className="hidden md:block bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-5">
            {/* Left: quiet KPI strip — scheduled hours · labor cost · staff.
                Stacked micro-label/value pairs so they read as calm context
                under the labor% hero, not a run-on sentence. */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <div className="flex items-center gap-2.5">
                <Icon name="Clock" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="leading-tight">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {t("schedTotalHours")}
                  </div>
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {formatTimer(weekSummary.hours, lang)}
                  </div>
                </div>
              </div>

              {/* Lønomkostning — owner only. A manager seat gets the roster and
                  the hours; the wage total is not theirs to read, and the
                  client-side `stats` fallback would happily compute it from
                  base_rate even with the server denying the cost endpoint. */}
              {!isStaffSeat && (
                <>
                  <span className="hidden sm:block w-px h-9 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

                  <div className="flex items-center gap-2.5">
                    <Icon name="Banknote" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                    <div className="leading-tight">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        <span>{t("schedTotalCost")}</span>
                        {costBasis === "loaded" && (
                          <span className="normal-case tracking-normal font-normal text-gray-400 dark:text-gray-500">
                            · {t("schedCostLoadedNote")}
                          </span>
                        )}
                      </div>
                      <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                        {/* No "≈" in front of a dash — the squiggle promises
                            an estimate, and we do not have one. */}
                        {weekSummary.cost == null ? "—" : `≈ ${formatKr(weekSummary.cost, { decimals: 0 })}`}
                      </div>
                    </div>
                  </div>
                </>
              )}

              <span className="hidden sm:block w-px h-9 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

              <div className="flex items-center gap-2.5">
                <Icon name="Users" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="leading-tight">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {t("schedStaffActive")}
                  </div>
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {/* A roster we could not read is not a roster of nobody. */}
                    {staffQ.failed ? "—" : stats.activeCount}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: labor% hero + cost controls. The whole cluster is
                owner-only — lønprocent IS a wage figure (cost ÷ revenue), so
                showing it to a manager seat while hiding the kroner beside it
                would just be the same number with one step of arithmetic in
                front of it. */}
            {!isStaffSeat && (
            <div className="flex items-center gap-5">
              {/* Labor % — the hero number, color-coded vs target. Set off by a
                  divider and sized well above the context metrics so it reads
                  first. */}
              <div className="text-right border-l border-gray-200 dark:border-gray-700 pl-5">
                <div className="flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  <Icon name="TrendingUp" size={13} />
                  <span>{t("schedLaborPct")}</span>
                </div>
                {weekSummary.hasRevenue && weekSummary.laborPct != null ? (
                  <>
                    <div
                      className={`text-4xl font-bold leading-none tracking-tight tabular-nums mt-1 ${laborTone(
                        weekSummary.laborPct,
                        targetPct
                      )}`}
                    >
                      {pctLabel(weekSummary.laborPct)}
                    </div>
                    {/* A projected number never wears an actuals label. The
                        chip is the whole point of Option B: the figure is only
                        useful while planning, and it is only honest if it says
                        it is a projection while it is one. */}
                    {weekSummary.isForecast && (
                      <div className="mt-1 flex items-center justify-end gap-1.5">
                        {/* 11px floor — and this chip is the one that tells the
                            owner the labor% beside it is a projection. */}
                        <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700/60 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          {t("schedLaborForecast", "projected")}
                        </span>
                        <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                          {(t("schedLaborForecastMix", "{a} days actual · {f} forecast") || "")
                            .replace("{a}", String(weekSummary.daysActual))
                            .replace("{f}", String(weekSummary.daysForecast))}
                        </span>
                      </div>
                    )}
                    {/* Days we could not price at all are named, not hidden —
                        otherwise the % silently describes fewer days than the
                        cost strip beside it. */}
                    {weekSummary.daysUnknown > 0 && (
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums mt-1">
                        {(t("schedLaborDaysUnknown", "{n} days without a revenue basis") || "")
                          .replace("{n}", String(weekSummary.daysUnknown))}
                      </div>
                    )}
                    {targetPct != null && (
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums mt-1">
                        {t("schedLaborTarget")} {pctLabel(targetPct)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-4xl font-bold leading-none tracking-tight tabular-nums text-gray-300 dark:text-gray-600 mt-1">
                      —
                    </div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500 max-w-[13rem] leading-snug mt-1">
                      {t("schedLaborNoRev")}
                    </div>
                  </>
                )}
              </div>

              <CostControls
                showCost={showCost}
                onToggleShowCost={() => setShowCost((v) => !v)}
                costBasis={costBasis}
                onCostBasis={setCostBasis}
                t={t}
              />
            </div>
            )}
          </div>
          {!isStaffSeat && (
            <p className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700/60 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
              {t("schedCostEstimateNote")}
            </p>
          )}
        </div>
      </FadeIn>

      {/* Click-to-bloom undo — a calm one-tap Fortryd for the just-added draft.
          Auto-dismisses after ~6s. Drafts never notify, so this is purely a
          local convenience (no "unsend"). */}
      {undoShift && (
        <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 shadow-lg">
          <span className="text-sm">{t("schedShiftAdded", "Shift added as draft")}</span>
          <button
            type="button"
            onClick={undoBloom}
            className="text-sm font-semibold underline underline-offset-2"
          >
            {t("schedUndo", "Undo")}
          </button>
        </div>
      )}

      {/* Drag-to-move undo — a calm one-tap Fortryd for the just-moved shift.
          Auto-dismisses after ~6s. A move never changes the time, so a published
          shift is NOT re-notified by the move (or by this undo). */}
      {undoMove && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 shadow-lg">
          <span className="text-sm">{t("schedMoved", "Shift moved")}</span>
          <button
            type="button"
            onClick={undoMoveAction}
            className="text-sm font-semibold underline underline-offset-2"
          >
            {t("schedUndo", "Undo")}
          </button>
        </div>
      )}

      {/* Shift Modal */}
      {showTemplateModal && (
        <TemplateCreateModal
          t={t}
          onClose={() => setShowTemplateModal(false)}
          onSave={addTemplate}
        />
      )}

      {shiftModal && (
        <ShiftModal
          modal={shiftModal}
          staff={activeStaff}
          shifts={shifts}
          weekDates={weekDates}
          lastTemplate={lastShiftTemplate}
          onTemplateSave={setLastShiftTemplate}
          onClose={() => setShiftModal(null)}
          onSaved={() => {
            setShiftModal(null);
            fetchShifts();
          }}
          branchId={branchId}
        />
      )}

      {/* Owner ↔ staff chat ("Beskeder") slide-over. Self-contained — owns its
          own fetches; onUnreadChange keeps the launcher badge honest. */}
      <OwnerChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        /* The drawer has just read the threads, so its count is the freshest
           answer there is — written into the same place the poll writes, not
           a second copy that could disagree with it. */
        onUnreadChange={(n) => chatUnreadQ.setData({ unread: n })}
      />

      {/* Publish-confirm sheet — the deliberate gate before draft shifts go
          live to staff. Shows what's about to change in one calm glance. */}
      {publishConfirm && (
        // `currency` dropped with the bare toLocaleString in the est-labor
        // tile — formatKr emits its own "kr.".
        <PublishConfirmModal
          summary={publishConfirm}
          result={publishResult}
          weekStart={weekStart}
          lang={lang}
          publishing={publishing}
          onConfirm={confirmPublish}
          onClose={() => {
            setPublishConfirm(null);
            setPublishResult(null);
          }}
          /* The way out of "published, but nobody was told". A sheet that
             states that and then offers only "Close" leaves the owner exactly
             where the silent failure wants them; this hands them the hand-off
             chooser instead. */
          onShare={() => {
            setPublishConfirm(null);
            setPublishResult(null);
            loadShareLinks();
            setHandoffSheet(true);
          }}
          t={t}
        />
      )}

      {/* Upgrade nudge — Free/Starter user trying bulk-email-staff
          (Pro+). The PDF download button stays available so they
          can still print or paste a link into WhatsApp.
          iconName, not icon: all three setUpgradeNudge callers above now name a
          Lucide glyph, which the dialog draws in its own gray-400 at its own
          size. The owner was seeing an OS emoji — platform-coloured, sized by
          the emoji font — heading a dialog built entirely from Lucide. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          iconName={upgradeNudge.iconName}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}

      {/* Unified Share sheet — Select all / per-staff, then Copy links
          (universal — works without email) or Email those with an address. */}
      {/* Hand-off chooser — wayfinding only. Every row calls the handler it
          always called; what is new is that the owner can read, before tapping,
          who receives what and whether anyone is notified. */}
      {handoffSheet && (
        <Sheet onClose={() => setHandoffSheet(false)} ariaLabel={t("schedHandoffTitle", "Choose how this week reaches your staff")}>
          <div className="p-5 pb-3">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("schedHandoffTitle", "Choose how this week reaches your staff")}
            </h3>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">
              {t("schedHandoffSub", "Publishing is what makes the week real. These three just decide how it gets to people.")}
            </p>
          </div>
          <div className="px-3 pb-4 space-y-1.5">
            {[
              {
                key: "links",
                icon: "Link2",
                label: t("schedHandoffLinksLabel", "Personal link for each staffer"),
                body: t("schedHandoffLinksBody", "Everyone gets their own link. They save it once and are notified whenever the schedule changes."),
                busy: sharing,
                run: () => { setHandoffSheet(false); openShareSheet(); },
              },
              {
                key: "email",
                icon: "Send",
                label: t("schedHandoffEmailLabel", "Email this week's schedule"),
                body: t("schedHandoffEmailBody", "One email with this week only, to everyone who has an email on file. No app, no notification."),
                busy: emailing,
                run: () => { setHandoffSheet(false); handleEmailToStaff(); },
              },
              {
                key: "pdf",
                icon: "FileText",
                label: t("schedHandoffPdfLabel", "PDF for the staff board"),
                body: t("schedHandoffPdfBody", "Downloads a sheet you can print and pin up. Nothing is sent to anyone."),
                busy: exporting,
                run: () => { setHandoffSheet(false); handleExportPdf(); },
              },
            ].map((row) => (
              <button
                key={row.key}
                type="button"
                disabled={sharing || emailing || exporting}
                onClick={row.run}
                className="w-full flex items-start gap-3 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-3.5 text-left hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))] transition disabled:opacity-60"
              >
                <span className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                  <Icon name={row.busy ? "Loader" : row.icon} size={17} className={row.busy ? "animate-spin" : undefined} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-gray-900 dark:text-gray-100">{row.label}</span>
                  <span className="block text-[13px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5">{row.body}</span>
                </span>
                <Icon name="ChevronRight" size={16} className="shrink-0 text-gray-300 dark:text-gray-600 mt-1" />
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {shareSheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShareSheet(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg max-w-md w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="p-5 pb-3 border-b border-gray-100 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-gray-900 dark:text-white">
                  {t("shareScheduleTitle", "Share this week's schedule")}
                </h3>
                <button onClick={() => setShareSheet(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("shareScheduleSub", "Pick who to share with. The link needs no account — staff just open it.")}
              </p>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                {t("shareJoinCodeHint", "No link? Staff can type their code at bonbox.dk/join.")}
              </p>
              <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={shareAllSelected()}
                  onChange={toggleShareAll}
                  className="w-4 h-4 rounded accent-gray-900 dark:accent-gray-100"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t("shareSelectAll", "Select all")}
                  <span className="text-gray-400 dark:text-gray-500 font-normal"> · {shareSel.size}/{shareActiveStaff().length}</span>
                </span>
              </label>
            </div>
            {/* Staff list */}
            <div className="flex-1 overflow-y-auto p-2">
              {shareActiveStaff().map((s) => {
                const sel = shareSel.has(s.id);
                const hasEmail = (s.email || "").includes("@");
                const pinOn = !!pinHas[s.id];
                const revealed = pinReveal[s.id];
                return (
                  <div key={s.id}>
                  <label
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer ${sel ? "bg-gray-50 dark:bg-gray-700/40" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => toggleShareOne(s.id)}
                      className="w-4 h-4 rounded accent-gray-900 dark:accent-gray-100"
                    />
                    <div className="relative w-7 h-7 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-600 dark:text-gray-300 flex-shrink-0">
                      {(s.name || "?").charAt(0).toUpperCase()}
                      <StaffAvatar member={s} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{s.name}</div>
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate flex items-center gap-1.5">
                        {/* Was an emoji envelope glued to the address; it drew
                            in the OS emoji font, coloured, on a row whose every
                            other glyph is a 12-14px gray Lucide. */}
                        <span className="truncate inline-flex items-center gap-1 min-w-0">
                          {hasEmail && <Icon name="Mail" size={12} className="shrink-0 text-gray-400 dark:text-gray-500" />}
                          <span className="truncate">
                            {hasEmail ? s.email : t("shareNoEmail", "link only — no email")}
                          </span>
                        </span>
                        {shareCodes[s.id] && (
                          <span className="shrink-0 font-mono font-semibold tracking-wider text-gray-600 dark:text-gray-300">
                            · {t("shareJoinCodeShort", "code")} {shareCodes[s.id]}
                          </span>
                        )}
                      </div>
                      {/* The read receipt. This sheet is where an owner hands
                          the week over, and until now it could not tell a link
                          somebody opens every morning from one that has never
                          been tapped — the endpoint had the column and dropped
                          it. Rendered ONLY when the server answered for this
                          staffer (the key is present): an absent key means we
                          did not ask, and "we did not ask" must not print as
                          "never opened". */}
                      {Object.prototype.hasOwnProperty.call(shareOpened, s.id) && (
                        <div
                          className={`text-[11px] truncate ${
                            shareOpened[s.id]
                              ? "text-gray-400 dark:text-gray-500"
                              : "text-amber-700 dark:text-amber-500"
                          }`}
                        >
                          {shareOpened[s.id]
                            ? t("shareLinkOpened", "Opened {date}", { date: formatDateClear(shareOpened[s.id]) })
                            : t("shareLinkNeverOpened", "Never opened")}
                        </div>
                      )}
                    </div>
                    {/* Extra PIN lock — hidden unless the owner opened the
                        "Extra security" section, OR this link already has a
                        PIN (an active lock stays visible + manageable). */}
                    {(showPinControls || pinOn) && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); toggleLinkPin(s); }}
                      disabled={pinBusy === s.id}
                      title={pinOn ? t("pinRemoveTitle", "Remove PIN") : t("pinRequireTitle", "Require a PIN to open this link")}
                      aria-pressed={pinOn}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded flex-shrink-0 transition ${
                        pinOn
                          ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      } disabled:opacity-50`}
                    >
                      {pinBusy === s.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                        : pinOn
                          ? <Lock className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
                          : <LockKeyholeOpen className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
                      <span>{t("pinLabel", "PIN")}</span>
                    </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); copyOneLink(s); }}
                      className="text-[11px] px-2 py-1 rounded text-emerald-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
                    >
                      {shareRowCopied === s.id ? "✓" : t("shareCopyOne", "copy")}
                    </button>
                  </label>
                  {/* Shown ONCE after generating — read it to the staffer. */}
                  {revealed && (
                    <div className="mx-3 mb-1 -mt-0.5 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" strokeWidth={2} aria-hidden />
                      <span className="text-[11px] text-emerald-800 dark:text-emerald-300 flex-1 min-w-0">
                        {t("pinRevealHint", "Give {name} this code:").replace("{name}", s.name)}
                      </span>
                      <span className="font-mono text-lg font-bold tracking-[0.3em] text-emerald-900 dark:text-emerald-200">{revealed}</span>
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
            {/* Footer actions */}
            <div className="p-4 border-t border-gray-100 dark:border-gray-700 space-y-2">
              <button
                onClick={copySelectedLinks}
                disabled={shareBusy || shareSel.size === 0}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-50 transition"
              >
                {/* The primary CTA of the step that actually gets the week to
                    staff used to lead with an emoji clipboard, then swap to a
                    bare "✓" — two different glyph systems on one button, and
                    neither is the Lucide set the chooser one tap earlier is
                    built from. */}
                {shareBusy
                  ? t("shareWorking", "Preparing…")
                  : shareCopiedN > 0
                    ? (<><Icon name="Check" size={14} />{`${shareCopiedN} ${t("shareCopiedLinks", "links copied")}`}</>)
                    : (<><Icon name="Copy" size={14} />{`${t("shareCopyLinks", "Copy")} ${shareSel.size} ${shareSel.size === 1 ? t("shareLinkWord", "link") : t("shareLinksWord", "links")}`}</>)}
              </button>
              <button
                onClick={() => { setShareSheet(false); handleShareWithStaff(); }}
                disabled={sharing || shareEmailableCount() === 0}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 transition"
                title={shareEmailableCount() === 0 ? t("shareNoEmailable", "No selected staff have an email") : ""}
              >
                {/* Emoji envelope → the same Lucide Mail the hand-off chooser
                    and the publish sheet already use for "this sends email". */}
                <Icon name="Mail" size={14} className="shrink-0" />
                <span>
                  {t("shareEmailWithAddress", "Email those with an address")}
                  {shareEmailableCount() > 0 ? ` (${shareEmailableCount()})` : ""}
                </span>
              </button>
              <p className="text-[11px] text-gray-400 dark:text-gray-600 text-center">
                {t("shareFootNote", "Paste copied links into WhatsApp or SMS — works for staff without email.")}
              </p>
              {/* Extra security (PIN) — collapsed by default so the everyday
                  flow stays just login code + copy. Opting in reveals the
                  per-row PIN control; a link that already has a PIN shows it
                  regardless. Most owners never need this. */}
              <button
                type="button"
                onClick={() => setShowPinControls((v) => !v)}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition"
                aria-expanded={showPinControls}
              >
                <Lock className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                {showPinControls
                  ? t("pinDisclosureHide", "Hide extra security")
                  : t("pinDisclosureShow", "Extra security · require a PIN")}
              </button>
              {showPinControls && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 text-center leading-relaxed">
                  {t("pinHint", "PIN is a separate, optional lock — tap a staffer's PIN to also require a 4-digit PIN (handy for a shared phone). Most staff don't need one.")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   AUTOPILOT REVIEW PANEL (Task #50 — Pro killer feature)

   Renders the AutopilotSuggestion the backend returned:
     • Header: week + predicted revenue, suggested cost, savings vs last week
     • Per-day card: weather chip, predicted revenue, suggested shifts table
     • Compliance warnings as amber chips
     • Apply (materializes draft Schedule rows) / Discard
   ═══════════════════════════════════════════════════════════ */
// Lucide names, not emoji — the same map WeatherPage already uses, and for the
// same reason stated there: an emoji is a different vendor cartoon on every OS
// and cannot take a design-system colour. schedule_autopilot.py's _bucket_for
// returns exactly these four strings, or the whole forecast dict is empty.
const AUTOPILOT_WEATHER_ICON = {
  sunny: "Sun",
  rainy: "CloudRain",
  cold: "Snowflake",
  cloudy: "CloudSun",
};

function WeatherChip({ weather }) {
  // A day with no forecast used to fall through to the 🌤️ default and render
  // a partly-sunny glyph with no temperature beside it — a weather claim about
  // a day we have no weather for. `summary` is null exactly when the forecast
  // fetch returned nothing, so that day now says nothing.
  const name = AUTOPILOT_WEATHER_ICON[weather?.summary];
  if (!name) return null;
  const t = weather.temp_c;
  const p = weather.precipitation_mm;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <Icon name={name} size={13} className="shrink-0 text-gray-400 dark:text-gray-500" />
      {t != null && <span>{Math.round(t)}°C</span>}
      {p != null && p >= 0.5 && <span className="text-gray-500 dark:text-gray-400">{p.toFixed(1)}mm</span>}
    </span>
  );
}

function formatDayShort(iso) {
  const d = new Date(iso + "T00:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

function AutopilotPanel({ suggestion, applying, onApply, onDiscard, t, lang }) {
  // On phones the 7 day-cards stack into one ~1,200px column. Collapse them
  // behind a disclosure so the week summary + Apply/Discard stay above the
  // fold; always expanded from `sm:` up (desktop layout unchanged).
  const [showDays, setShowDays] = useState(false);
  const totalRevenue = suggestion.days.reduce(
    (sum, d) => sum + (d.predicted_revenue || 0),
    0
  );
  const compared = suggestion.compared_to_last_week || {};
  const dayCount = suggestion.days.length;
  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          {/* 11px floor — and this eyebrow carries the confidence caveat, the
              one sentence that decides how much of this panel to believe. */}
          <p className="text-[11px] font-semibold tracking-wider uppercase text-gray-500 dark:text-gray-400">
            <Icon name="Sparkles" size={12} className="inline-block -mt-0.5 mr-1 text-gray-400 dark:text-gray-500" />
            {t("autopilotHeading", "Autopilot Suggestion")} ·{" "}
            {suggestion.confidence === "high"
              ? t("autopilotConfidenceHigh", "High confidence")
              : suggestion.confidence === "medium"
              ? t("autopilotConfidenceMedium", "Medium confidence")
              : t("autopilotConfidenceLow", "Low confidence — limited data")}
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white mt-0.5">
            {t("autopilotWeekOf", "Week of")} {formatDayShort(suggestion.week_start)}
          </h3>
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {/* formatKr, not a bare toLocaleString + a "DKK" token. The owner
                was reading these two figures in the BROWSER's locale — an
                en-US Chrome printed "15,000 DKK" — one card away from the week
                toolbar, which has always printed the same kind of number as
                "15.000 kr." through this exact formatter. Same helper now, so
                the two reconcile. */}
            <span>
              {t("autopilotPredicted", "Predicted")}:{" "}
              <strong className="text-gray-900 dark:text-white">
                {formatKr(totalRevenue, { decimals: 0 })}
              </strong>
            </span>
            <span>
              {t("autopilotLabor", "Suggested labor")}:{" "}
              <strong className="text-gray-900 dark:text-white">
                {/* Same rule as the week toolbar: no "≈" in front of a dash —
                    the squiggle promises an estimate we do not have. */}
                {suggestion.week_total_cost == null
                  ? "—"
                  : `≈ ${formatKr(suggestion.week_total_cost, { decimals: 0 })}`}
              </strong>{" "}
              <span className="text-gray-500">
                · {formatTimer(suggestion.week_total_hours, lang)}
              </span>
            </span>
            {totalRevenue > 0 && (
              <span>
                {t("schedLaborPct", "Labor %")}:{" "}
                <strong className={laborTone(suggestion.week_total_cost / totalRevenue, suggestion.basis?.target_labor_pct ?? null)}>
                  {pctLabel(suggestion.week_total_cost / totalRevenue)}
                </strong>
                {(suggestion.basis?.target_labor_pct ?? null) != null && (
                  <span className="text-gray-500">
                    {" "}· {t("schedLaborTarget", "target")} {pctLabel(suggestion.basis.target_labor_pct)}
                  </span>
                )}
              </span>
            )}
            {compared.savings_label && (
              <span
                className={
                  compared.delta_pct < 0
                    ? "text-gray-700 dark:text-emerald-400 font-medium"
                    : "text-amber-700 dark:text-amber-400"
                }
              >
                {compared.savings_label}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 w-full sm:w-auto">
          <button
            type="button"
            onClick={onDiscard}
            disabled={applying}
            className="flex-1 sm:flex-none px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
          >
            {t("autopilotDiscard", "Discard")}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
          >
            {applying ? (
              t("autopilotApplying", "Applying…")
            ) : (
              <>
                <Icon name="Check" size={15} />
                {t("autopilotApply", "Apply schedule")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Compliance warnings */}
      {suggestion.compliance_warnings && suggestion.compliance_warnings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestion.compliance_warnings.map((w, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs"
            >
              <Icon name="AlertTriangle" size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
              {w}
            </span>
          ))}
        </div>
      )}

      {/* Per-day cards — collapsed by default on phones (toggle below); the
          grid is always shown from `sm:` up so desktop is unchanged. */}
      <button
        type="button"
        onClick={() => setShowDays((v) => !v)}
        aria-expanded={showDays}
        className="sm:hidden w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-200"
      >
        <span>
          {showDays
            ? t("autopilotHideDays", "Hide daily plan")
            : t("autopilotShowDays", "View daily plan")}{" "}
          <span className="text-gray-400 font-normal tabular-nums">· {dayCount}</span>
        </span>
        <Icon
          name="ChevronDown"
          size={16}
          className={`transition-transform ${showDays ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`${showDays ? "grid" : "hidden"} sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3`}
      >
        {suggestion.days.map((day) => (
          <div
            key={day.date}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-2.5 sm:p-3 space-y-1.5 sm:space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {day.weekday}
                </div>
                <div className="text-[11px] text-gray-500">
                  {formatDayShort(day.date)}
                </div>
              </div>
              <div className="text-xs text-gray-700 dark:text-gray-300 text-right whitespace-nowrap">
                <WeatherChip weather={day.weather} />
              </div>
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5 sm:block sm:space-y-0.5">
              <div>
                {t("autopilotRevenue", "Revenue")}:{" "}
                <span className="text-gray-800 dark:text-gray-200 font-medium">
                  {/* Same locale fix as the header. The `|| 0` went with it:
                      schedule_autopilot.py types predicted_revenue as a float
                      and always ships one, so the coalesce was covering a case
                      the contract does not have — and if a future payload ever
                      dropped it, formatKr's "—" is the honest render, not a
                      confident 0 kr. */}
                  {formatKr(day.predicted_revenue, { decimals: 0 })}
                </span>
              </div>
              <div>
                {t("autopilotDemand", "Demand")}:{" "}
                <span className="text-gray-800 dark:text-gray-200 font-medium">
                  {formatTimer(day.predicted_demand_hours, lang)}
                </span>
              </div>
            </div>
            {/* Same rule as the grid: aggregates yes, per-person-per-shift no.
                Each row names a staffer AND prints their start–end times, so a
                trailing "≈ N kr." was the kr ÷ hours division the grid had the
                per-shift line removed for, reproduced one click away. The
                day total below is what the owner is actually deciding on. */}
            {day.shifts && day.shifts.length > 0 ? (
              <ul className="space-y-1">
                {day.shifts.map((s, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between text-xs gap-2 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] px-2 py-1 sm:py-1.5 rounded-md"
                  >
                    <span className="truncate">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {s.staff_name}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">
                        {" "}
                        · {s.start}-{s.end}
                      </span>
                      {s.break_minutes > 0 && (
                        <span className="text-gray-400">
                          {" "}
                          · {s.break_minutes}m brk
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] italic text-gray-400 px-2 py-1.5">
                {t("autopilotNoShifts", "No shifts proposed")}
              </div>
            )}
            <div className="text-[11px] font-medium text-gray-700 dark:text-gray-300 border-t border-gray-100 dark:border-gray-700 pt-1.5">
              {t("autopilotTotal", "Total")}:{" "}
              {/* The day's labour total, in the same formatter as the week
                  summary it has to add up to. */}
              {day.total_cost == null
                ? "—"
                : `≈ ${formatKr(day.total_cost, { decimals: 0 })}`}
              <span className="text-gray-400 font-normal">
                {" "}
                · {formatTimer(day.total_hours, lang)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   STAFF DETAIL / EDIT MODAL  (Staff v2, #336)
   ═══════════════════════════════════════════════════════════

   Owners asked for a real "click a staff member → see + edit their
   details" surface instead of the cramped inline form that expanded a
   row. This is that surface: a centred card on desktop, a bottom-sheet /
   near-full-screen panel on mobile (notch-safe).

   It owns NO save logic of its own — every mutation is delegated to the
   handlers passed down from StaffPanel (handleUpdate / generateLink /
   handleDeactivate) so the endpoints + payloads stay byte-identical to
   the old inline path. The modal only drives `editForm` (the same shared
   state) via onChange and decides when to call those handlers.

   Props:
     member     — the staff row being viewed (name, role, email, phone,
                  contract_type, base_rate, is_active, …). null = closed.
     editForm   — shared edit state (already populated by openDetail).
     setEditForm
     currency   — "DKK" gates the Trækkort row (same rule as inline form).
     saving     — true while a save/PUT is in flight.
     rates      — { base, evening, weekend, holiday } from getRateCard.
     onSave     — () => handleUpdate(member.id) ; resolves true on success.
     onClose    — close without saving.
     onShare    — () => generateLink(member).
     onDeactivate — () => handleDeactivate(member). Takes the whole row, not
                  the id: the confirm dialog names the person it is about to
                  cut off.
     t          — translator from useLanguage.
*/

// Overlay that fills an avatar circle with the staffer's uploaded profile photo.
// Renders NOTHING until the photo loads (the caller shows the name initial as
// the base layer), so it degrades to initials with no flicker. The image is
// fetched as a blob through the authed `api` client — not a bare <img src> —
// so it works in the native owner app where an <img> can't carry the bearer
// token, and it cache-busts on profile_photo_at so a staffer's new photo shows
// up the next time the owner loads the roster. Wrap it in a `relative
// overflow-hidden rounded-full` container.
function StaffAvatar({ member }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let obj = null;
    if (member?.id && member?.profile_photo_at) {
      api
        // ?v= busts the browser HTTP cache (proxy sets max-age=86400) so a
        // staffer's new photo replaces the old one instead of showing stale.
        .get(`/staff/members/${member.id}/photo?v=${encodeURIComponent(member.profile_photo_at)}`, { responseType: "blob" })
        .then((r) => {
          if (cancelled) return;
          obj = URL.createObjectURL(r.data);
          setUrl(obj);
        })
        .catch(() => { if (!cancelled) setUrl(null); });
    } else {
      setUrl(null);
    }
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [member?.id, member?.profile_photo_at]);
  if (!url) return null;
  return <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" />;
}

function StaffDetailModal({
  member,
  editForm,
  setEditForm,
  currency,
  saving,
  rates,
  onSave,
  onClose,
  onShare,
  onDeactivate,
  roles = ROLES_RESTAURANT,
  t,
}) {
  const catFor = useCatFor();
  // The hour unit comes off utils/hours.js, never typed: these three labels
  // read "(DKK/hr)" — an English unit on a Danish wage form — for as long as
  // they existed, and "t" is the unit every other hours surface in the app
  // prints. `t` is the translate function here (a prop), so the language is
  // taken from the hook rather than shadowed.
  const { lang: rateLang } = useLanguage();
  const perHour = hoursUnit(rateLang);
  // A wage rate is MONEY per hour — kroner the owner types — so the three
  // rate boxes are text, read by the strict parser in the ACCOUNT's notation.
  // type="number" on an English-locale browser rewrites a Dane's "1.500,50"
  // to "1.50050" without raising badInput; see components/ui/MoneyField.jsx.
  // The trækkort box below them stays a number input: it is a PERCENTAGE.
  const mLocale = moneyLocale(currency);
  const rateRejected =
    isMoneyRejected(editForm.base_rate, mLocale)
    || isMoneyRejected(editForm.evening_rate, mLocale)
    || isMoneyRejected(editForm.weekend_rate, mLocale);
  // The base rate as a number, for the "Use suggested" premiums below. Number()
  // on the raw string would read a typed "1.500,50" as NaN and hide the button.
  const baseRateNum = parseMoneyInput(editForm.base_rate, mLocale);
  const cardRef = useRef(null);
  // Hold the latest onClose in a ref so the focus/Esc effect can depend only
  // on `member` (open/close). Without this, the parent re-renders on every
  // keystroke (editForm lives in StaffPanel), `onClose` gets a new identity,
  // the effect re-runs, and focus snaps back to the first field mid-typing.
  // The ref is updated in an effect (never during render) to satisfy the
  // react-hooks/refs lint rule.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Esc to close + focus management. We trap focus loosely: on open we
  // move focus into the dialog (first focusable / the card itself) and a
  // keydown handler keeps Tab within the card. Restores focus to whatever
  // was focused before open on unmount.
  useEffect(() => {
    if (!member) return undefined;
    const prevActive = document.activeElement;
    const card = cardRef.current;

    const focusables = () =>
      card
        ? Array.from(
            card.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];

    // Move focus into the dialog (name field if present, else the card).
    const first = focusables()[0];
    if (first) first.focus();
    else if (card) card.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    // Lock background scroll while the sheet/dialog is up.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      if (prevActive && typeof prevActive.focus === "function") prevActive.focus();
    };
    // Depend only on `member` — onClose is read via onCloseRef so the effect
    // doesn't tear down on every parent re-render (keystroke).
  }, [member]);

  if (!member) return null;

  const cat = catFor(member.role);
  const colors = ROLE_COLORS[cat] || ROLE_COLORS.floor;
  const isInactive = member.active === false;
  const initial = (member.name || "?").trim().charAt(0).toUpperCase() || "?";

  // Shared input styling — rounded-xl, focus ring, dark mode.
  const inputCls =
    "w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none transition";
  const labelCls =
    "block text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5";

  const handleSave = async () => {
    const ok = await onSave();
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("staffDetailsTitle", "Staff details") + " — " + member.name}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 max-h-[92vh] sm:max-h-[88vh] flex flex-col outline-none"
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-100 dark:border-gray-700">
          <div className="relative flex-shrink-0 w-11 h-11 rounded-full overflow-hidden bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-base font-semibold">
            {initial}
            <StaffAvatar member={member} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-gray-900 dark:text-white truncate">
                {member.name}
              </h2>
              <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors.bg} ${colors.text}`}>
                {member.role}
              </span>
              {isInactive && (
                <span className="text-xs text-red-500 font-medium">{t("inactive")}</span>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {contractLabel(member.contract_type, t)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="flex-shrink-0 p-1.5 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — scrolls if it overflows */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Name */}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sd-name">{t("staffName", "Name")}</label>
              <input
                id="sd-name"
                type="text"
                value={editForm.name || ""}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className={inputCls}
                placeholder={t("staffName", "Name")}
              />
            </div>
            {/* Role */}
            <div>
              <label className={labelCls} htmlFor="sd-role">{t("staffRole", "Role")}</label>
              <select
                id="sd-role"
                value={editForm.role || ""}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                className={inputCls}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {/* Contract type */}
            <div>
              <label className={labelCls} htmlFor="sd-contract">{t("contractType", "Contract type")}</label>
              <select
                id="sd-contract"
                value={editForm.contract_type || ""}
                onChange={(e) => setEditForm({ ...editForm, contract_type: e.target.value })}
                className={inputCls}
              >
                {CONTRACT_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>{t(ct.labelKey, ct.fallback)}</option>
                ))}
              </select>
              {/* Vagtplan Shield toggle — hour-LIMIT warnings only (contract
                  cap / 48h / 90t-md); the 11-timers rest warning is safety
                  law and never toggleable. Default ON; part/student contracts
                  with no explicit monthly cap warn at the 90 t-md default. */}
              <label className="mt-2 flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={(editForm.hour_limit_warn ?? member.hour_limit_warn) !== false}
                  onChange={(e) => setEditForm({ ...editForm, hour_limit_warn: e.target.checked })}
                  className="mt-0.5 w-4 h-4 rounded accent-gray-900 dark:accent-gray-100"
                />
                <span className="text-xs text-gray-600 dark:text-gray-300 leading-snug">
                  {t("staffHourLimitToggle", "Warn on hour limits")}
                  <span className="block text-[11px] text-gray-400 dark:text-gray-500">
                    {(editForm.contract_type || member.contract_type) === "part" ||
                     (editForm.contract_type || member.contract_type) === "student"
                      ? t("staffHourLimitHintPart", "Part-time/student: warns at 90 h/month unless you set a custom limit — typical international-student ceiling.")
                      : t("staffHourLimitHint", "Warns at the contract cap and the DK 48h week. Rest warnings (11h rule) always stay on.")}
                  </span>
                </span>
              </label>
            </div>
            {/* Email */}
            <div>
              <label className={labelCls} htmlFor="sd-email">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3" /> {t("staffEmail", "Email")}
                </span>
              </label>
              <input
                id="sd-email"
                type="email"
                value={editForm.email || ""}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                className={inputCls}
                placeholder={t("optional", "Optional")}
              />
            </div>
            {/* Phone */}
            <div>
              <label className={labelCls} htmlFor="sd-phone">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> {t("staffPhone", "Phone")}
                </span>
              </label>
              <input
                id="sd-phone"
                type="tel"
                value={editForm.phone || ""}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                className={inputCls}
                placeholder={t("optional", "Optional")}
              />
            </div>
            {/* Home address — staff keep this current from the portal; the
                owner sees + can edit it here. "Opdateret {dato}" shows when it
                last changed so the owner knows it's fresh. */}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sd-address">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="w-3 h-3" /> {t("staffAddress", "Address")}
                </span>
              </label>
              <input
                id="sd-address"
                type="text"
                value={editForm.address || ""}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                className={inputCls}
                placeholder={t("staffAddressStreetPlaceholder", "Street & number")}
                autoComplete="street-address"
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="sd-postal">{t("staffPostalCode", "Postal code")}</label>
              <input
                id="sd-postal"
                type="text"
                inputMode="numeric"
                value={editForm.postal_code || ""}
                onChange={(e) => setEditForm({ ...editForm, postal_code: e.target.value })}
                className={inputCls}
                placeholder="2200"
                autoComplete="postal-code"
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="sd-city">{t("staffCity", "City")}</label>
              <input
                id="sd-city"
                type="text"
                value={editForm.city || ""}
                onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                className={inputCls}
                placeholder={t("optional", "Optional")}
                autoComplete="address-level2"
              />
            </div>
            {member.address_updated_at && (
              <p className="sm:col-span-2 -mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                {t("staffAddressUpdated", "Address updated")}{" "}
                {new Date(member.address_updated_at).toLocaleDateString()}
              </p>
            )}
            {/* Bank account — staff-entered in their portal, encrypted at rest.
                Fetched on demand (not with the drawer) so the audit trail
                records a real intent to look, not every drawer open. */}
            <StaffBankRow memberId={member.id} memberName={member.name} labelCls={labelCls} />
            {/* Employment documents shared with this staffer — they download
                them in their portal behind the PIN. */}
            <StaffDocumentsRow memberId={member.id} labelCls={labelCls} />
            {/* Base rate */}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sd-rate">{t("baseRate")} ({currency}/{perHour})</label>
              <MoneyField
                id="sd-rate"
                locale={mLocale}
                value={editForm.base_rate ?? ""}
                onChange={(e) => setEditForm({ ...editForm, base_rate: e.target.value })}
                className={`${inputCls} tabular-nums`}
                placeholder={`${t("baseRate")} (${currency}/${perHour})`}
              />
            </div>
          </div>

          {/* Premium rates — OPTIONAL. Empty = paid at base (what most small
              DK venues do). A real kr/hr figure here flows into the schedule's
              ≈ labor cost (evening after 18:00, weekend Sat/Sun). The suggested
              values are a starting point, never auto-applied. Holiday is
              deliberately omitted until a DK helligdag calendar lands. */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("premiumRatesTitle", "Premium rates (optional)")}
              </p>
              {baseRateNum > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setEditForm({
                      ...editForm,
                      evening_rate: Math.round(baseRateNum * 1.25),
                      weekend_rate: Math.round(baseRateNum * 1.45),
                    })
                  }
                  className="text-[11px] font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2 hover:opacity-70"
                >
                  {t("premiumUseSuggested", "Use suggested")}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="sd-evening">{t("rateEvening", "Evening")} ({currency}/{perHour})</label>
                <MoneyField
                  id="sd-evening"
                  locale={mLocale}
                  value={editForm.evening_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, evening_rate: e.target.value })}
                  className={`${inputCls} tabular-nums`}
                  placeholder={rates.suggestedEvening ? `${t("egAbbrev", "e.g.")} ${rates.suggestedEvening}` : t("optional", "Optional")}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="sd-weekend">{t("rateWeekend", "Weekend")} ({currency}/{perHour})</label>
                <MoneyField
                  id="sd-weekend"
                  locale={mLocale}
                  value={editForm.weekend_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, weekend_rate: e.target.value })}
                  className={`${inputCls} tabular-nums`}
                  placeholder={rates.suggestedWeekend ? `${t("egAbbrev", "e.g.")} ${rates.suggestedWeekend}` : t("optional", "Optional")}
                />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {t("premiumRatesHint", "Leave blank to pay base rate. Evening applies after 18:00, weekend on Sat/Sun — and flows into the schedule's labor cost.")}
            </p>
          </div>

          {/* Trækkort — DK only, same values + conversion as the old inline
              form. UI shows %, handleUpdate divides by 100 on submit. */}
          {currency === "DKK" && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Trækkort
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select
                  value={editForm.tax_card_type || ""}
                  onChange={(e) => setEditForm({ ...editForm, tax_card_type: e.target.value })}
                  className={inputCls}
                  title="Trækkort type — affects A-skat estimate"
                  aria-label="Trækkort type"
                >
                  <option value="">{t("auto")}</option>
                  <option value="hovedkort">Hovedkort (~36%)</option>
                  <option value="bikort">Bikort (~42%)</option>
                  <option value="frikort">Frikort (0%)</option>
                </select>
                <input
                  type="number"
                  value={editForm.tax_card_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, tax_card_rate: e.target.value })}
                  placeholder={t("rateOverridePct")}
                  min="0"
                  max="60"
                  step="0.1"
                  className={`${inputCls} tabular-nums`}
                  title="Paste exact rate from employee's eSkattekort (0–60%)"
                  aria-label={t("rateOverridePct")}
                />
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("trækkortHint")}
              </p>
            </div>
          )}

          {/* (Read-only rate card removed — base + evening/weekend are now
              editable inputs above, and Holiday is deferred until a DK
              helligdag calendar lands, so we never show a rate we can't
              honestly apply to the schedule's cost.) */}
        </div>

        {/* Footer — primary actions + secondary (share / deactivate).
            Notch-safe bottom padding for the mobile bottom-sheet. */}
        <div className="border-t border-gray-100 dark:border-gray-700 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || rateRejected}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? t("saving", "Saving…") : t("saveChanges", "Save changes")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              {t("cancel", "Cancel")}
            </button>
          </div>
          {!isInactive && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onShare}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
              >
                <Link2 className="w-4 h-4" />
                {t("shareLink", "Share link")}
              </button>
              <button
                type="button"
                onClick={onDeactivate}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
              >
                <Trash2 className="w-4 h-4" />
                {t("deactivate", "Deactivate")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STAFF MANAGEMENT PANEL
   ═══════════════════════════════════════════════════════════ */
// Decimals for an HOURLY RATE, which is the one money figure on this page an
// owner multiplies by hours. base_rate is Numeric(10,2) and 137,50 kr./t is a
// rate people really type; printing it as "138 kr./t" beside an `earned` the
// server derived from 137,50 hands them a payroll row they cannot reproduce.
// Whole rates stay clean. (Same rule, same reason, as StaffHoursPage.)
function rateDecimals(rate) {
  const n = typeof rate === "string" ? parseFloat(rate) : rate;
  return Number.isInteger(n) ? 0 : 2;
}

function StaffPanel({ staff, currency, onRefresh, branchId, joinCodes = {}, onCodeMinted }) {
  // Wage rates are money — same reasoning as StaffDetailModal above.
  const mLocale = moneyLocale(currency);
  const catFor = useCatFor();
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  // Which row's code was just copied. Local on purpose — the parent has its
  // own copied-state for the Share sheet and the two should not fight over
  // one flag. Cleared on a timer, and guarded so a later row's copy cannot
  // be cleared by an earlier row's timeout.
  const [codeCopied, setCodeCopied] = useState(null);
  // `user` is referenced below for the admin-only WhatsApp setup block
  // (`user?.is_admin`). The parent had it via useAuth() but sub-components
  // each need their own destructure — this exact pattern crashed the
  // panel with `ReferenceError: user is not defined` and bounced the
  // whole /staff/schedule page through the global error boundary.
  const { user } = useAuth();
  // Vagtplan roster cap (Free 3 / Starter 10 / Pro 25). `staff` is the active,
  // non-deleted tenant roster (GET /staff/members filters exactly that and
  // ignores branch_id), so its length IS the seat count the server gates on —
  // UI and gate read the same number. Tri-state on isReady so the lock never
  // flashes for a paying user while entitlements load (tier-flicker doctrine).
  const { isAtCap, cap, isReady, plan, data: entData } = useEntitlements();
  const seatsUsed = staff.length;
  const seatCap = cap("staff_members");
  const atSeatCap = isReady && isAtCap("staff_members", seatsUsed);
  // Next tier + its seat count come from the SERVER's own plans matrix, never
  // hardcoded here — so the number in the CTA can't drift from billing.py.
  // Pro is the top tier: no next tier ⇒ no upgrade CTA (a nudge that leads
  // nowhere is a dead end, so we show the seat line alone instead).
  const nextTier = plan === "free" ? "starter" : plan === "starter" ? "pro" : null;
  const nextSeats = nextTier
    ? entData?.plans?.[nextTier]?.caps?.staff_members ?? null
    : null;
  const roles = rolesFor(user?.business_type);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState(roles[0]);
  const [contractType, setContractType] = useState("full");
  const [baseRate, setBaseRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({});
  // The staff member currently open in the detail/edit modal (#336). The
  // modal owns the edit now; `editForm` is the shared draft state it drives.
  const [detailMember, setDetailMember] = useState(null);
  const [panelError, setPanelError] = useState("");
  const [linkModal, setLinkModal] = useState(null); // { staffName, portalUrl, loading }
  const [linkCopied, setLinkCopied] = useState(false);

  const generateLink = async (member) => {
    setLinkModal({ staffName: member.name, portalUrl: null, loading: true });
    try {
      const res = await api.post(`/staff/members/${member.id}/link`);
      const origin = window.location.origin;
      const fullUrl = `${origin}${res.data.portal_url}`;
      // This endpoint routes through _ensure_join_code, so its join_code is the
      // one value guaranteed live — it re-mints a burned or expired one. The
      // response used to be read for portal_url only and the code thrown away,
      // which would leave the roster chip four lines above showing the OLD code
      // right after the owner pressed the button that replaced it.
      if (res.data.join_code) onCodeMinted?.(member.id, res.data.join_code);
      setLinkModal({ staffName: member.name, portalUrl: fullUrl, loading: false });
    } catch (err) {
      setPanelError(errText(err, "Failed to generate link"));
      setLinkModal(null);
    }
  };

  const copyLink = async () => {
    if (!linkModal?.portalUrl) return;
    try {
      await navigator.clipboard.writeText(linkModal.portalUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = linkModal.portalUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const shareLink = async () => {
    if (!linkModal?.portalUrl) return;
    if (navigator.share) {
      const restaurant = user?.business_name || "BonBox";
      const firstName = (linkModal.staffName || "").trim().split(/\s+/)[0] || linkModal.staffName;
      try {
        await navigator.share({
          title: t("scheduleShareLinkTitle", "Your schedule · {restaurant}", { restaurant }),
          text: t(
            "scheduleShareText",
            "Hi {name} 👋 Here's your personal link to your shifts, hours and tips at {restaurant}:",
            { name: firstName, restaurant },
          ),
          url: linkModal.portalUrl,
        });
      } catch {
        // The ONE catch on this page that is genuinely nothing: the OS share
        // sheet rejects when the owner dismisses it. Nothing failed and
        // nothing is claimed, so there is nothing to report — returning says
        // that out loud rather than leaving an empty block to be read as an
        // oversight.
        return;
      }
    } else {
      copyLink();
    }
  };

  const handleAdd = async () => {
    if (!name.trim()) return;
    // Client-side mirror of the server gate. The 402 is the real barrier —
    // this just avoids a pointless round-trip and a red error where the
    // honest answer is "you're out of seats, here's the upgrade".
    if (atSeatCap) return;
    setSaving(true);
    setPanelError("");
    try {
      await api.post("/staff/members", {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        role,
        contract_type: contractType,
        // A BLANK RATE BOX IS "NOT SET", NEVER "ZERO KRONER AN HOUR".
        //
        // The Tilføj button is live on an empty rate (isMoneyRejected treats an
        // untouched box as the resting state, deliberately), so this is the
        // ordinary path for an owner who adds the roster first and sets wages
        // later — and it used to land `0`. A stored 0 is a FACT everywhere
        // downstream: _pick_rate returns it, `earned` computes to 0 kr., the
        // rate card printed "0 kr./t", and the owner was told they pay this
        // person nothing. null is the only honest value for a figure nobody
        // entered, and every consumer already treats it as "not known": the
        // rate card renders "—", /hours/summary sends hourly_rate: null, and
        // the client cost estimators read `base_rate || 0` so no sum changes
        // shape. 0 keeps meaning what it should — an owner who really typed 0.
        base_rate: (() => {
          if (String(baseRate ?? "").trim() === "") return null;
          const n = parseMoneyInput(baseRate, mLocale);
          return Number.isFinite(n) ? n : null;
        })(),
        branch_id: branchId || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setRole(roles[0]);
      setContractType("full");
      setBaseRate("");
      onRefresh();
    } catch (err) {
      setPanelError(errText(err, "Failed to add staff member."));
    }
    setSaving(false);
  };

  const handleUpdate = async (id) => {
    setSaving(true);
    setPanelError("");
    // Premium rates: "" (field cleared) -> null = remove the premium; a number
    // -> set it; undefined (untouched) -> omitted from the JSON so the server
    // keeps the stored value. (axios/JSON.stringify drops undefined keys.)
    // parseMoneyInput, not parseFloat: the rate boxes are text, so a Dane's
    // "187,50" arrives intact and parseFloat would stop at the comma and
    // return 187. An unreadable rate cannot get here — the modal's Save
    // button is dead while one is on screen.
    const rateOrNull = (v) =>
      v === undefined ? undefined : v === "" || v === null ? null : parseMoneyInput(v, mLocale);
    try {
      await api.put(`/staff/members/${id}`, {
        name: editForm.name?.trim() || undefined,
        email: editForm.email !== undefined ? (editForm.email.trim() || null) : undefined,
        phone: editForm.phone !== undefined ? (editForm.phone.trim() || null) : undefined,
        address: editForm.address !== undefined ? (editForm.address.trim() || null) : undefined,
        postal_code: editForm.postal_code !== undefined ? (editForm.postal_code.trim() || null) : undefined,
        city: editForm.city !== undefined ? (editForm.city.trim() || null) : undefined,
        role: editForm.role || undefined,
        contract_type: editForm.contract_type || undefined,
        // Base rate through the SAME helper as the premiums. It used to call
        // parseMoneyInput directly, which returns NaN for a cleared box and
        // arrived as JSON null only because JSON.stringify happens to serialize
        // NaN that way — an accident, not an intention, and one that would turn
        // into `0` the day this payload was built by anything else. "" is
        // "cleared this rate" and says so out loud now.
        base_rate: rateOrNull(editForm.base_rate),
        evening_rate: rateOrNull(editForm.evening_rate),
        weekend_rate: rateOrNull(editForm.weekend_rate),
        // Trækkort fields — null/empty maps to NULL on server (treated as
        // hovedkort default by payroll service).
        tax_card_type: editForm.tax_card_type || null,
        tax_card_rate: editForm.tax_card_rate
          ? parseFloat(editForm.tax_card_rate) / 100  // UI shows %, backend stores decimal
          : null,
        // Vagtplan Shield toggle — only sent when the owner touched it
        // (undefined = omitted, server keeps the stored value).
        hour_limit_warn: editForm.hour_limit_warn,
      });
      setEditForm({});
      onRefresh();
      setSaving(false);
      return true; // signals the detail modal to close on success
    } catch (err) {
      setPanelError(errText(err, "Failed to update staff member."));
    }
    setSaving(false);
    return false;
  };

  const handleDeactivate = async (member) => {
    // "Deactivate this staff member?" named nobody. The roster is a list of
    // near-identical rows ending in the same three small icons, so on a team of
    // eight the dialog looked the same whoever you had tapped — and the thing
    // it ends is somebody's access to their own shifts. It says the name now,
    // and what actually stops working.
    const ok = await confirm({
      title: t("staffDeactivateTitleNamed", "Deactivate {name}?", { name: member.name }),
      message: t(
        "staffDeactivateBodyNamed",
        "{name} won't appear in future schedules, and the staff link on their phone stops working straight away.",
        { name: member.name },
      ),
      confirmLabel: t("deactivate", "Deactivate"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    setPanelError("");
    try {
      await api.delete(`/staff/members/${member.id}`);
      onRefresh();
    } catch (err) {
      setPanelError(errText(err, "Failed to deactivate staff member."));
    }
  };

  // Build the shared `editForm` draft from a member row. Drives the detail/
  // edit modal (openDetail). Centralises the field set + the percent↔decimal
  // trækkort conversion so the PUT payload matches what the server expects.
  const buildEditDraft = (member) => ({
    name: member.name,
    email: member.email || "",
    phone: member.phone || "",
    address: member.address || "",
    postal_code: member.postal_code || "",
    city: member.city || "",
    // Normalise to a shift-role option (stored roles can be lowercase "server",
    // but the <select> options are capitalized "Server") so the dropdown
    // pre-selects the member's ACTUAL role instead of defaulting to "Chef".
    role: roleToShiftOption(member.role, roles),
    contract_type: member.contract_type,
    // `??`, not `||`, for the same reason the premiums beside it use it: a
    // member whose rate really IS 0 (an unpaid trial week, the owner's own
    // row) had it seeded as "" — the form then showed "not set", and saving
    // any unrelated field wrote null back over a deliberate 0. Only a genuine
    // null now reads as an empty box.
    base_rate: member.base_rate ?? "",
    evening_rate: member.evening_rate ?? "",
    weekend_rate: member.weekend_rate ?? "",
    tax_card_type: member.tax_card_type || "",
    // Backend stores decimal (0.36); UI shows percent (36)
    tax_card_rate: member.tax_card_rate
      ? Math.round(parseFloat(member.tax_card_rate) * 100 * 10) / 10
      : "",
  });

  // Open the detail/edit modal (#336). Populates the shared edit draft and
  // routes everything through the modal — the old cramped inline editor has
  // been retired, so the name + pencil affordances both land here.
  const openDetail = (member) => {
    setEditForm(buildEditDraft(member));
    setDetailMember(member);
  };

  const closeDetail = () => {
    setDetailMember(null);
    setEditForm({});
  };

  const getRateCard = (member) => {
    // `|| 0` turned a REDACTED rate into a stated one: the server nulls
    // base_rate for a delegated seat and for a curtained shared device, and
    // every card then read "Grundløn: 0 kr/hr" — a figure asserted as fact,
    // which is the opposite of the "—" the hours table gives the same value.
    // null now means "not shown to you"; 0 still means the owner set 0.
    const base = member.base_rate == null ? null : member.base_rate;
    // Premiums are REAL stored values, not derived — null means "not set"
    // (the shift is paid at base). We never fabricate a premium the owner
    // didn't enter, and the schedule's ≈ cost reads these same fields.
    const num = (v) =>
      v === null || v === undefined || v === "" ? null : Number(v);
    return {
      base,
      evening: num(member.evening_rate),
      weekend: num(member.weekend_rate),
      holiday: num(member.holiday_rate),
      // Suggested DK starting points — shown only as the input placeholder +
      // "Use suggested"; never applied until the owner saves a real rate.
      suggestedEvening: base ? Math.round(base * 1.25) : null,
      suggestedWeekend: base ? Math.round(base * 1.45) : null,
    };
  };

  return (
    <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700">
      {/* Add form */}
      <div className="pt-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t("addNewStaffMember")}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder={t("staffName", "Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <input
            type="email"
            placeholder={t("schedEmailOptional", "Email (optional)")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <input
            type="tel"
            placeholder={t("schedPhoneOptional", "Phone (optional)")}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {roles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={contractType}
            onChange={(e) => setContractType(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {CONTRACT_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>{t(ct.labelKey, ct.fallback)}</option>
            ))}
          </select>
          <MoneyField
            locale={mLocale}
            placeholder={`${t("schedBaseRate", "Base rate")} (${currency}/${hoursUnit(lang)})`}
            value={baseRate}
            onChange={(e) => setBaseRate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !name.trim() || atSeatCap || isMoneyRejected(baseRate, mLocale)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {atSeatCap && <Lock className="w-3.5 h-3.5" aria-hidden="true" />}
            {saving ? t("schedAdding", "Adding...") : t("schedAddShort", "Add")}
          </button>
        </div>

        {/* Roster seats are used up — say so plainly and offer the one real
            way forward. Existing staff are untouched (grandfathered); this
            only blocks the next add, so the copy must never imply data loss. */}
        {atSeatCap && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t("schedSeatsUsed", "{used} of {cap} staff seats used", {
                used: seatsUsed,
                cap: seatCap,
              })}
            </p>
            {nextTier && nextSeats ? (
              <UpgradeNudge
                intent="inline"
                tier={nextTier}
                iconName="Users"
                benefit={t(
                  "schedSeatsBenefit",
                  "Room for {n} people on the schedule — your current team stays exactly as it is.",
                  { n: nextSeats },
                )}
                ctaLabel={t("nudgeSeePlans", "See plans")}
              />
            ) : null}
          </div>
        )}
      </div>

      {panelError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
          {panelError}
        </div>
      )}

      {/* Staff list */}
      {staff.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-4">
          {t("schedNoStaffPanel", "No staff members yet. Add your first team member above.")}
        </p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("currentStaff")}</h3>
          <div className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-100 dark:border-gray-700 rounded-xl overflow-hidden">
            {staff.map((member) => {
              const cat = catFor(member.role);
              const colors = ROLE_COLORS[cat] || ROLE_COLORS.floor;
              const rates = getRateCard(member);
              const isInactive = member.active === false;

              return (
                <div
                  key={member.id}
                  className={`px-4 py-3 bg-white dark:bg-gray-800 ${isInactive ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors.bg} ${colors.text}`}>
                        {member.role}
                      </div>
                      {/* Click the name to open the detail/edit modal (#336).
                          Disabled for inactive members (their edit affordances
                          are hidden below). */}
                      {/* Inactive members open the drawer too, read-only: the
                          edit affordances below are gated on !isInactive, but
                          the owner still has to be able to get IN to clear a
                          leaver's bank details — their own portal stops working
                          the moment active=false. */}
                      <button
                        type="button"
                        onClick={() => openDetail(member)}
                        title={t("viewStaffDetails") || "View details"}
                        aria-label={`${t("viewStaffDetails") || "View details"} — ${member.name}`}
                        className="text-sm font-medium text-gray-900 dark:text-white truncate cursor-pointer hover:underline underline-offset-2 decoration-gray-300 dark:decoration-gray-600 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 transition"
                      >
                        {member.name}
                      </button>
                      {member.email && (
                        <span className="text-xs text-emerald-600 dark:text-gray-300" title={member.email}>
                          @
                        </span>
                      )}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {contractLabel(member.contract_type, t)}
                      </span>
                      {isInactive && (
                        <span className="text-xs text-red-500 font-medium">{t("inactive")}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      {/* Join code — the ONLY way this person gets into the
                          Scheduler app. It already existed inside the "Share
                          with staff" sheet, two screens from the row that
                          names its owner; this is the same value where you are
                          already thinking about the person.

                          NOT hidden on mobile the way the rate card beside it
                          is: a rate is something you read, a code is something
                          you read ALOUD to someone standing in front of you,
                          which is exactly when you are holding the phone.

                          Tap copies. Renders nothing when there is no code —
                          the endpoint is owner-only, so a staff seat simply
                          sees the row without one rather than an error. */}
                      {!isInactive && joinCodes[member.id] && (
                        <button
                          type="button"
                          onClick={async () => {
                            const code = joinCodes[member.id];
                            try {
                              await navigator.clipboard.writeText(code);
                            } catch {
                              const ta = document.createElement("textarea");
                              ta.value = code;
                              document.body.appendChild(ta);
                              ta.select();
                              document.execCommand("copy");
                              document.body.removeChild(ta);
                            }
                            setCodeCopied(member.id);
                            setTimeout(
                              () => setCodeCopied((c) => (c === member.id ? null : c)),
                              1500,
                            );
                          }}
                          title={t("schedCopyJoinCode", "Copy join code")}
                          aria-label={`${t("schedCopyJoinCode", "Copy join code")} — ${member.name}`}
                          className="shrink-0 px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-700 font-mono text-xs font-semibold tracking-wider tabular-nums text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
                        >
                          {codeCopied === member.id
                            ? t("copied", "Copied")
                            : joinCodes[member.id]}
                        </button>
                      )}
                      {/* Rate card */}
                      <div className="hidden sm:flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                        {/* The rate read "185DKK/hr" — the raw Numeric straight
                            out of the payload, no grouping, the currency CODE
                            jammed against it and an English unit, on the one
                            line of this roster that states a wage. Through the
                            house formatter and utils/hours.js it reads
                            "185 kr./t", the same notation as the Hours table's
                            rate column. Øre survive (a real 137,50 kr./t is a
                            rate people type); whole rates stay clean. */}
                        <span title={t("baseRate")}>
                          {t("baseRate")}: {rates.base == null
                            ? "—"
                            : `${formatOwnerMoney(rates.base, currency, { decimals: rateDecimals(rates.base) })}/${hoursUnit(lang)}`}
                        </span>
                        {/* Premiums were bare numbers ("Aften: 231") sitting
                            beside a formatted base — same row, two notations,
                            and one of them not identifiable as money at all.
                            The unit is carried once, by the base chip, so these
                            stay compact on the narrow tablet this row targets. */}
                        {rates.evening != null && (
                          <span title={t("rateEvening", "Evening")}>{t("rateEveShort", "Eve")}: {formatOwnerMoney(rates.evening, currency, { decimals: rateDecimals(rates.evening) })}</span>
                        )}
                        {rates.weekend != null && (
                          <span title={t("rateWeekend", "Weekend")}>{t("rateWkndShort", "Wknd")}: {formatOwnerMoney(rates.weekend, currency, { decimals: rateDecimals(rates.weekend) })}</span>
                        )}
                        {rates.evening == null && rates.weekend == null && (
                          <span className="text-gray-300 dark:text-gray-600">{t("noPremiumSet", "No premium")}</span>
                        )}
                      </div>
                      {!isInactive && (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => generateLink(member)}
                            title={t("sharePortalLink")}
                            aria-label={`${t("sharePortalLink")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition"
                          >
                            <Link2 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openDetail(member)}
                            title={t("editStaff", "Edit")}
                            aria-label={`${t("editStaff", "Edit")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeactivate(member)}
                            title={t("deactivate", "Deactivate")}
                            aria-label={`${t("deactivate", "Deactivate")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* WhatsApp Setup Guide
          ──────────────────────────────────────────────────────────
          Hidden from regular customers — this card asks the owner to
          create their own Twilio account, find SID/Auth tokens, and
          paste env vars into BonBox's Render dashboard. That's a
          DevOps setup nobody-but-the-founder can complete (customers
          can't log into Render in the first place), and the Twilio
          sandbox path delivers a 24-hour-only experience that stops
          working silently for staff.

          Customers see a calm "Coming soon" tile instead.

          Production plan (Manoj's job, once):
            • Apply for Twilio WhatsApp Business approval (~3 weeks)
            • Pre-approve message templates with Meta
            • Use existing TWILIO_* env vars on Render (single shared
              sender for all customers)
            • Customer-facing toggle just sets whatsapp_enabled flag
          */}
      {/* The customer-facing "WhatsApp — coming soon" tile was removed: staff
          alerts run on email + in-app + native push, so we don't tease a channel
          that isn't live. The admin-only Twilio setup guide below stays. */}
      {user?.is_admin && (
      <details className="group">
        <summary className="flex items-center justify-between cursor-pointer py-3 px-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-800/30 text-sm font-medium text-gray-800 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition">
          <span>📱 WhatsApp Notifications — Quick Setup (admin only)</span>
          <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </summary>
        <div className="mt-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 space-y-5 text-sm text-gray-600 dark:text-gray-400">

          {/* How it works */}
          <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100 dark:border-gray-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-1">How it works</p>
            <p>When you publish or change a schedule, staff with a phone number get a WhatsApp message like:</p>
            <div className="mt-2 p-3 bg-white dark:bg-[rgb(var(--surface-card))] rounded-lg border border-gray-200 dark:border-gray-700 font-mono text-xs leading-relaxed">
              <p className="text-emerald-600 dark:text-gray-300">BonBox - Schedule Update</p>
              <p className="mt-1">Hi Jonas! Your shifts changed:</p>
              <p className="mt-1">Mon 14 Apr: 10:00 - 18:00</p>
              <p>Wed 16 Apr: start moved to 15:00</p>
              <p>Fri 18 Apr: shift removed</p>
            </div>
          </div>

          {/* 3 simple steps */}
          <div className="space-y-4">
            <p className="text-gray-800 dark:text-gray-200 font-semibold">3 steps to set it up:</p>

            {/* Step 1 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">1</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Sign up at twilio.com <span className="text-xs font-normal text-gray-500">(free, 2 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-lg text-xs space-y-1">
                  <p>Go to <span className="text-emerald-600 dark:text-gray-300 font-medium">twilio.com/try-twilio</span></p>
                  <p>Enter your email and create a password</p>
                  <p>Verify your phone number — done!</p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">2</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Turn on WhatsApp <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-lg text-xs space-y-2">
                  <p>In Twilio, click <span className="font-medium text-gray-800 dark:text-gray-200">Messaging</span> in the left menu</p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Try it out</span> &rarr; <span className="font-medium text-gray-800 dark:text-gray-200">Send a WhatsApp message</span></p>
                  <p>You'll see a sandbox number like <span className="font-mono text-emerald-600 dark:text-gray-300">+1 415 523 8886</span></p>
                  <p>And a join code like <span className="font-mono text-emerald-600 dark:text-gray-300">join bright-owl</span></p>
                  <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded border border-gray-100 dark:border-gray-800/30">
                    <p className="text-gray-700 dark:text-gray-300">Copy these 3 things from your Twilio dashboard:</p>
                    <div className="mt-1 font-mono space-y-0.5 text-gray-700 dark:text-gray-300">
                      <p>Account SID: <span className="text-emerald-600 dark:text-gray-300">AC1234...abcd</span></p>
                      <p>Auth Token: <span className="text-emerald-600 dark:text-gray-300">ef5678...wxyz</span></p>
                      <p>WhatsApp #: <span className="text-emerald-600 dark:text-gray-300">+14155238886</span></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">3</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Paste them in Render <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-lg text-xs space-y-2">
                  <p>Go to your BonBox backend on <span className="font-medium text-gray-800 dark:text-gray-200">render.com</span></p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Environment</span> in the sidebar</p>
                  <p>Add these 3 values:</p>
                  <div className="mt-1 font-mono bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-700 space-y-0.5 text-gray-700 dark:text-gray-300">
                    <p>TWILIO_ACCOUNT_SID = <span className="text-emerald-600 dark:text-gray-300">paste yours</span></p>
                    <p>TWILIO_AUTH_TOKEN = <span className="text-emerald-600 dark:text-gray-300">paste yours</span></p>
                    <p>TWILIO_WHATSAPP_NUMBER = <span className="text-emerald-600 dark:text-gray-300">+14155238886</span></p>
                  </div>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Save Changes</span> — Render restarts automatically</p>
                </div>
              </div>
            </div>
          </div>

          {/* Staff side */}
          <div className="p-3 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-2">What your staff does</p>
            <div className="text-xs space-y-2">
              <p><span className="font-medium text-gray-800 dark:text-gray-200">You:</span> Add their phone number here (e.g. <span className="font-mono text-blue-600 dark:text-blue-400">+4512345678</span>) using the edit button above</p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Staff:</span> Opens WhatsApp, sends <span className="font-mono bg-white dark:bg-gray-900 px-1.5 py-0.5 rounded text-emerald-600 dark:text-gray-300">join bright-owl</span> to <span className="font-mono">+1 415 523 8886</span></p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Done!</span> They'll now get WhatsApp messages when shifts change</p>
            </div>
          </div>

          <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-lg text-xs text-amber-700 dark:text-amber-400">
            <strong>Tip:</strong> This uses Twilio's free sandbox (great for testing). When you're ready for production, upgrade to a Twilio WhatsApp Business number — staff won't need to send the join message anymore.
          </div>
        </div>
      </details>
      )}

      {/* Portal Link Modal */}
      {linkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setLinkModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-sm w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              {/* A 30px emoji chain link was the largest thing in this dialog and
                  the only coloured one. Same Lucide Link2 the toolbar and the
                  share toast use, in the quiet tile the chooser rows use. */}
              <div className="mx-auto mb-2 w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-300">
                <Icon name="Link2" size={18} />
              </div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">{t("sharePortalLink")}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("schedSendThisTo", "Send this to")} <strong>{linkModal.staffName}</strong> {t("schedPortalLinkDesc", "— they can see their schedule, hours, and tips.")}
              </p>
            </div>

            {linkModal.loading ? (
              <div className="flex justify-center py-4">
                <div className="animate-spin w-6 h-6 border-2 border-gray-300 border-t-transparent rounded-full" />
              </div>
            ) : (
              <>
                <div className="bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-xl p-3 text-xs font-mono text-gray-600 dark:text-gray-400 break-all select-all">
                  {linkModal.portalUrl}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={copyLink}
                    className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition ${
                      linkCopied
                        ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                        : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                    }`}
                  >
                    {/* Emoji clipboard / phone → Lucide, same as every other
                        copy-and-share control on this page. */}
                    <Icon name={linkCopied ? "Check" : "Copy"} size={14} />
                    <span>{linkCopied ? t("schedCopied", "Copied!") : t("schedCopyBtn", "Copy")}</span>
                  </button>
                  <button
                    onClick={shareLink}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition"
                  >
                    <Icon name="Share2" size={14} />
                    <span>{t("schedShareBtn", "Share")}</span>
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-600 text-center">
                  {t("schedPortalNoAccount", "No account needed. Staff just opens the link. You can deactivate it anytime.")}
                </p>
              </>
            )}

            <button
              onClick={() => setLinkModal(null)}
              className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {t("close", "Close")}
            </button>
          </div>
        </div>
      )}

      {/* Staff detail / edit modal (#336). Owns the edit; delegates the
          actual save/share/deactivate to the existing handlers so the
          endpoints + payloads are unchanged. */}
      <StaffDetailModal
        member={detailMember}
        editForm={editForm}
        setEditForm={setEditForm}
        currency={currency}
        saving={saving}
        rates={detailMember ? getRateCard(detailMember) : { base: 0, evening: 0, weekend: 0, holiday: 0 }}
        onSave={() => handleUpdate(detailMember.id)}
        onClose={closeDetail}
        onShare={() => generateLink(detailMember)}
        onDeactivate={() => handleDeactivate(detailMember)}
        roles={roles}
        t={t}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SCHEDULE GRID
   ═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   MOBILE SCHEDULE — day-at-a-time vertical list (Staff v2, #251)
   ═══════════════════════════════════════════════════════════

   Mobile owners check the schedule walking to work / between rushes — the
   JTBD is "who's on with me today?", not "plan the whole week". An 8-col
   table never works on 390px. This component renders ONE day at a time
   with a swipeable day-strip on top, per-day stats line, and a vertical
   staff list with tap-to-edit shift cells.

   Shares all state with the desktop ScheduleGrid via props (same `shifts`
   array, same `getShiftsForCell`, same `onCellClick`) so the edit flow
   stays identical — owners can switch from phone to laptop mid-week
   without rebuilding mental model.
*/
/* ═══════════════════════════════════════════════════════════
   COST CONTROLS  (owner toggles in the week summary bar)
   Two calm, status-color-free controls:
     • "Vis lønsum" switch — the DAY and WEEK totals. It used to govern a
       per-shift kroner line in every grid cell too, which is why its old label
       ("Vis lønkroner") promised kroner the grid no longer prints: hours and
       kroner on adjacent lines of one card is a person's hourly rate, published
       on a screen the whole team walks past.
     • Løn / Inkl. feriepenge segmented control — gross vs holiday-loaded.
   Both persist to localStorage at the page level; this is pure UI.
   Rendered for OWNERS only — a staff seat never sees this cluster at all.
   ═══════════════════════════════════════════════════════════ */
function CostControls({ showCost, onToggleShowCost, costBasis, onCostBasis, t }) {
  return (
    <div className="flex items-center gap-3">
      {/* Show-cost switch — h-9 hit area keeps it touch-friendly and on the
          same baseline as the segmented control beside it. */}
      <button
        type="button"
        role="switch"
        aria-checked={showCost}
        onClick={onToggleShowCost}
        title={t("schedCostShowHelp", "Shows the wage total per day and for the week. Never kroner per shift.")}
        className="flex items-center gap-2 h-9 px-1 text-xs font-medium text-gray-600 dark:text-gray-300 rounded-lg hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      >
        <span
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
            showCost ? "bg-gray-900 dark:bg-white" : "bg-gray-200 dark:bg-gray-600"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 shadow-sm transition-transform ${
              showCost ? "translate-x-[1.125rem]" : "translate-x-1"
            }`}
          />
        </span>
        <span>{t("schedCostShow")}</span>
      </button>

      {/* Gross / loaded segmented control — matched h-9 height, clean inset
          active state (gray-900 text on white), muted inactive. */}
      <div
        className="inline-flex h-9 items-center rounded-lg border border-gray-200 dark:border-gray-600 p-1 bg-gray-100 dark:bg-gray-700/50"
        role="group"
        aria-label={t("schedTotalCost")}
      >
        {[
          { v: "gross", label: t("schedCostGross") },
          { v: "loaded", label: t("schedCostLoaded") },
        ].map((opt) => {
          const active = costBasis === opt.v;
          return (
            <button
              key={opt.v}
              type="button"
              onClick={() => onCostBasis(opt.v)}
              aria-pressed={active}
              className={`h-full px-3 text-xs font-medium rounded-md transition-colors ${
                active
                  ? "bg-white dark:bg-[rgb(var(--surface-card))] text-gray-900 dark:text-white shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Phone day-list. Takes the PLURAL cell accessor: `getShiftsForCell` was
 *  already being passed in from the page but never destructured here, so the
 *  whole surface read a split-shift day through the singular accessor — the
 *  lunch shift rendered, the dinner shift did not exist. On a phone that is
 *  the ONLY view the owner has, so a second shift was invisible AND
 *  untappable, and the day's hours/cost strip under-counted it.
 *
 *  Exported (named) so MobileSchedule.salon.test.jsx can mount the real thing
 *  — the salon crash below was found by reading, never by running, and a page
 *  this size needs the regression pinned by a render, not by a grep. */
export function MobileSchedule({ staff, weekDates, getShiftsForCell, showCost, weekCost, costBasis, targetPct, t, lang, onCellClick, unavailFor, preferredFor, absenceFor, isStaffSeat = false }) {
  const catFor = useCatFor();
  const { user } = useAuth();
  // Same rule as the desktop grid: the row dot only says something on a
  // vertical that HAS sections. Elsewhere it is one colour on every row.
  const showRowDot = hasSections(user?.business_type);
  // Default to today within the current week range. If the user navigated
  // to a different week (Previous/Next), today falls outside — pick the
  // middle of the week (Thursday) as a sensible default.
  const todayISO = toISO(new Date());
  const defaultIdx = (() => {
    const todayInWeek = weekDates.findIndex((d) => toISO(d) === todayISO);
    return todayInWeek >= 0 ? todayInWeek : 3; // 3 = Thu
  })();
  const [dayIdx, setDayIdx] = useState(defaultIdx);

  // Reset when weekDates changes (user clicked Previous/Next Week).
  useEffect(() => {
    setDayIdx(defaultIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekDates[0]?.toISOString()]);

  const selectedDate = weekDates[dayIdx];
  const selectedISO = toISO(selectedDate);
  const isSelectedToday = selectedISO === todayISO;

  // Same per-day rollup the desktop header dot uses, computed the same way, so
  // an owner switching phone → laptop mid-week reads the identical status. On a
  // phone this is the ONLY place the week's shape is visible at all: without it
  // you would have to tap through seven days to find the one still in Kladde.
  const dayTally = useMemo(() => {
    const m = {};
    for (const date of weekDates) {
      const all = [];
      for (const member of staff) all.push(...getShiftsForCell(member.id, date));
      m[toISO(date)] = tallyDay(all);
    }
    return m;
  }, [staff, weekDates, getShiftsForCell]);

  // Per-day stats — hours, cost, staff-on-shift count. Prefers the server's
  // daily cost (loaded/gross + labor%); falls back to a client estimate from
  // base_rate when the cost layer is unavailable. Labor% only shows when the
  // server returned revenue for that day (never fabricated).
  const serverDay = useMemo(
    () => (weekCost?.daily || []).find((d) => d.date === selectedISO) || null,
    [weekCost, selectedISO]
  );
  const dayStats = useMemo(() => {
    let totalHours = 0;
    let totalCost = 0;
    let staffOn = 0;
    staff.forEach((member) => {
      // EVERY shift of the day, not just the first: a split lunch+dinner day
      // was billing the owner for one of the two in the fallback estimate.
      // staffOn stays a head COUNT — two shifts is still one person on the
      // floor, and "2 on shift" for one staffer would be a plain lie.
      const shifts = getShiftsForCell(member.id, selectedDate);
      if (!shifts.length) return;
      const rate = member.base_rate || 0;
      for (const shift of shifts) {
        const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
        totalHours += hrs;
        totalCost += hrs * rate;
      }
      staffOn += 1;
    });
    const cost = serverDay ? costByBasis(serverDay, costBasis) : null;
    const laborPct = serverDay
      ? (costBasis === "loaded" ? serverDay.labor_pct_loaded : serverDay.labor_pct_gross)
      : null;
    return {
      hours: Math.round((serverDay && typeof serverDay.hours === "number" ? serverDay.hours : totalHours) * 10) / 10,
      cost: Math.round(cost ?? totalCost),
      staffOn,
      laborPct: typeof laborPct === "number" ? laborPct : null,
      hasRevenue: serverDay ? serverDay.revenue != null : false,
    };
  }, [staff, selectedDate, getShiftsForCell, serverDay, costBasis]);

  const goPrev = () => setDayIdx((i) => Math.max(0, i - 1));
  const goNext = () => setDayIdx((i) => Math.min(6, i + 1));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* ── Day-strip: 7 pills, today/selected highlighted ── */}
      <div className="px-3 pt-3 pb-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={dayIdx === 0}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={t("schedPrevDay", "Previous day")}
          >
            ←
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {dayShort(dayIdx, t)} {selectedDate.getDate()}/{selectedDate.getMonth() + 1}
            </div>
            {/* "I dag" in the brand accent, not emerald. Emerald now means
                "seen by staff" on this surface — and it already meant "helst"
                on the chips below, so green was doing three jobs on one
                phone screen. */}
            {isSelectedToday && (
              // 11px is the ramp's floor. This whole phone column — "I dag",
              // the booket line, the three status chips below — was set at 10
              // and 9, i.e. the day view an owner actually uses standing up was
              // the smallest type in the app.
              <div className="text-[11px] uppercase tracking-wider font-semibold text-[rgb(var(--brand-600))] dark:text-[rgb(var(--brand-400))]">
                {t("schedToday")}
              </div>
            )}
            {/* Booked covers — the demand this day's roster has to serve.
                Lives in the day title (which has vertical room), NOT the stats
                strip below: that strip is whitespace-nowrap and tuned to hold
                one line at 320px, so a 5th token would break it.
                Absent entirely when the owner doesn't take reservations. */}
            {typeof serverDay?.covers_booked === "number" && (
              <div
                className="text-[11px] mt-0.5 whitespace-nowrap text-gray-500 dark:text-gray-400 tabular-nums"
                aria-label={t("schedCoversBookedAria").replace("{n}", serverDay.covers_booked)}
              >
                {serverDay.covers_booked} {t("schedCoversBooked")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={dayIdx === 6}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={t("schedNextDay", "Next day")}
          >
            →
          </button>
        </div>
        {/* 7 day pills — tap to switch. Each carries the same status dot as
            the desktop column header, so the week's shape (which day is still
            Kladde, which one everybody has read) is legible without tapping
            through all seven. min-h-[44px] is the iOS tap-target floor: the
            two-line pill was ~42px before the dot went in. */}
        <div className="grid grid-cols-7 gap-1">
          {weekDates.map((date, i) => {
            const iso = toISO(date);
            const isToday = iso === todayISO;
            const isSelected = i === dayIdx;
            const tally = dayTally[iso] || { total: 0, drafts: 0, pub: 0, seen: 0 };
            const tone = dayDotTone(tally);
            const sentence = dayTallyText(tally, t);
            return (
              <button
                key={i}
                type="button"
                onClick={() => setDayIdx(i)}
                title={sentence}
                className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] py-1.5 rounded-lg transition-colors ${
                  isSelected
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                    : isToday
                    ? "bg-[rgb(var(--brand-50))] text-[rgb(var(--brand-600))] dark:bg-[rgb(var(--brand-600)/0.15)] dark:text-[rgb(var(--brand-400))]"
                    : "bg-gray-50 text-gray-600 dark:bg-gray-700/40 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                aria-pressed={isSelected}
              >
                <span className="text-[11px] font-medium uppercase">{dayShort(i, t)}</span>
                <span className="text-xs font-semibold tabular-nums">{date.getDate()}</span>
                {/* 4px dot. Reserve the row even when there is no dot, or the
                    pills jump height as days fill up. */}
                <span className="h-1 flex items-center" aria-hidden="true">
                  {tone !== "none" && (
                    <span className={`w-1 h-1 rounded-full ${DAY_DOT_CLASS[tone]}`} />
                  )}
                </span>
                <span className="sr-only">{sentence}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Per-day stats strip — staff · hours · (cost) · labor%. The labor%
          is pushed right and weighted as the day's headline; staff/hours/cost
          are quiet context. whitespace-nowrap + min-w-0 keep it on one line at
          320px even with a long cost figure. ── */}
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-900/30">
        <div className="flex items-center gap-2.5 text-xs whitespace-nowrap">
          {/* "N on shift" — least-important, truncates first if space is tight. */}
          <span className="text-gray-500 dark:text-gray-400 min-w-0 truncate">
            <strong className="text-gray-900 dark:text-gray-100 tabular-nums">{dayStats.staffOn}</strong> {t("schedOnShift")}
          </span>
          <span className="text-gray-300 dark:text-gray-600 flex-shrink-0" aria-hidden="true">·</span>
          <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums flex-shrink-0">{formatShiftHours(dayStats.hours, lang)}</span>
          {showCost && (
            <>
              <span className="text-gray-300 dark:text-gray-600 flex-shrink-0" aria-hidden="true">·</span>
              <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums flex-shrink-0">
                ≈ {formatKr(dayStats.cost, { decimals: 0 })}
              </span>
            </>
          )}
          {/* Labor% — the day headline, pushed to the right edge; never shrinks.
              Hidden entirely for a manager/cashier/viewer seat (and a curtained
              shared device), exactly as the desktop cluster is. Their weekCost
              is null by construction, so leaving it in printed the word
              "Lønprocent" over a permanent "—": a label for a number the seat
              is never going to be shown. */}
          {!isStaffSeat && (
            <span className="ml-auto flex items-center gap-1 pl-1 flex-shrink-0">
              {/* 11px floor. The strip is still one line at 320px: the "N på
                  vagt" span carries min-w-0 truncate and absorbs the ~5px. */}
              <span className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {t("schedLaborPct")}
              </span>
              {dayStats.hasRevenue && dayStats.laborPct != null ? (
                <span className={`text-sm font-bold tabular-nums ${laborTone(dayStats.laborPct, targetPct)}`}>
                  {pctLabel(dayStats.laborPct)}
                </span>
              ) : (
                <span className="text-sm font-bold text-gray-300 dark:text-gray-600 tabular-nums">—</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ── Staff list — one row per active staff member ── */}
      <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
        {staff.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t("schedNoActiveStaff", "No active staff. Add staff members from the Manage Staff section above.")}
          </div>
        ) : (
          staff.map((member) => {
            const cat = catFor(member.role);
            const colors = ROLE_COLORS[cat] || ROLE_COLORS.floor;
            const dayShifts = getShiftsForCell(member.id, selectedDate);
            const hasShift = dayShifts.length > 0;
            // Same precedence as the desktop grid: a concrete fravær (indigo)
            // outranks a standing "kan ikke" (red); both only on empty rows.
            const mAbs = !hasShift ? (absenceFor?.(member.id, selectedDate) || null) : null;
            const mBlk = !hasShift && !mAbs ? (unavailFor?.(member.id, selectedDate) || null) : null;
            // A staffer can now mark days they WANT. Reading as plain "OFF"
            // beside a red "Can't work" made the preference invisible on the
            // one screen it exists to inform.
            const mPref = !hasShift && !mAbs && !mBlk ? (preferredFor?.(member.id, selectedDate) || null) : null;

            // Identity half of the row — shared by both branches below so the
            // two layouts can never drift apart.
            const identity = (
              <>
                {/* Role dot + initials avatar */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {showRowDot && <span className={`w-2 h-2 rounded-full ${colors.dot}`} />}
                  <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-gray-300">
                    {(member.name || "?").charAt(0).toUpperCase()}
                  </div>
                </div>
                {/* Name + role + contract type (same chip as the desktop row —
                    it is what replaced the per-shift kroner). */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {member.name}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{member.role}</span>
                    {contractLabel(member.contract_type, t) && (
                      <span className="px-1 py-px rounded bg-gray-100 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap flex-shrink-0">
                        {contractLabel(member.contract_type, t)}
                      </span>
                    )}
                  </div>
                </div>
              </>
            );

            // EMPTY DAY — unchanged: the whole row stays one big tap target
            // that blooms a draft (or just shows fravær / kan ikke / helst).
            if (!hasShift) {
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => onCellClick(member.id, selectedDate, null)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors"
                  aria-label={t("schedAddShiftAria", "Add shift for {name}").replace("{name}", member.name)}
                >
                  {identity}
                  {/* Ferie / Kan ikke / Helst — the three facts that decide
                      whether the owner can put this person on today. They were
                      set at 10px inside a px-2 py-1 pill that has the room for
                      the floor. */}
                  {mAbs ? (
                    <span className="inline-flex items-center rounded-md px-2 py-1 bg-indigo-100/70 dark:bg-indigo-900/30">
                      <span className="text-[11px] font-semibold text-indigo-500 dark:text-indigo-300 uppercase tracking-wide">{absKindLabel(mAbs.kind, t)}</span>
                    </span>
                  ) : mBlk ? (
                    <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 bg-red-100/70 dark:bg-red-900/30">
                      <CalendarOff className="w-3 h-3 text-red-400 dark:text-red-400" strokeWidth={2} aria-hidden />
                      <span className="text-[11px] font-medium text-red-400 dark:text-red-400 tabular-nums">{mBlk.timeLabel || t("schedKanIkkeCell", "Can't work")}</span>
                    </span>
                  ) : mPref ? (
                    <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 bg-emerald-100/70 dark:bg-emerald-900/30">
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} aria-hidden />
                      <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">{mPref.timeLabel || t("schedHelstCell", "Prefers")}</span>
                    </span>
                  ) : (
                    <div className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1">
                      <span>{t("schedOff", "OFF")}</span>
                      <span className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 font-bold">
                        +
                      </span>
                    </div>
                  )}
                </button>
              );
            }

            // ONE OR MORE SHIFTS — a plain wrapper carrying ONE button PER
            // shift. It cannot stay a single row-wide <button>: a nested
            // button is invalid HTML and only the first shift would ever be
            // reachable, which is the bug. Identity stays non-interactive
            // rather than becoming a second button that silently means "the
            // first shift" — ambiguous on exactly the day this fixes.
            return (
              <div key={member.id} className="w-full flex items-center gap-3 px-4 py-3">
                {identity}
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  {dayShifts.map((shift) => {
                    const shiftCat = catFor(shift.role_on_shift || member.role);
                    const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
                    const isDraft = shift.status === "draft";
                    const timeLabel = formatShiftTime(shift.start_time, shift.end_time);
                    return (
                      <button
                        key={shift.id}
                        type="button"
                        onClick={() => onCellClick(member.id, selectedDate, shift)}
                        // min-h-44 = the iOS tap-target floor. The chip's own
                        // content is ~40px with one line of hours, so without
                        // this a split day would hand the owner two targets
                        // that are each a hair too small to hit reliably.
                        className={`min-h-[44px] px-2.5 py-1.5 rounded-lg bg-white dark:bg-[rgb(var(--surface-card))] ${cardChrome(isDraft)} border-l-[3px] ${roleBar(shiftCat, showRowDot)} tabular-nums text-right leading-tight transition-colors hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))]`}
                        aria-label={t("schedEditShiftAtAria", "Edit {name}'s {time} shift")
                          .replace("{name}", member.name)
                          .replace("{time}", timeLabel)}
                      >
                        <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                          {timeLabel}
                        </div>
                        {/* Same line 2 as the desktop card, same order: hours,
                            then the status marks. No kroner line — see the note
                            where costForShift() used to be. */}
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {formatShiftHours(hrs, lang)}
                          <ShiftMarkers shift={shift} published={!isDraft} t={t} />
                        </div>
                        {isDraft && (
                          <div className="mt-0.5">
                            <DraftPill t={t} />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}


/* ─── Drag layer ([L] slice 1 — move only) ───
   Honesty / design invariants:
   • Only EMPTY cells accept a drop (occupied droppables are `disabled`) — this
     is how we forbid overwrite/stacking; you can never drop onto a filled cell.
   • A plain CLICK still fires the cell's onClick (modal / bloom) because the
     PointerSensor has a 6px activation distance — sub-6px pointer travel is a
     click, not a drag.
   • A move keeps the shift's time (start/end unchanged) → update_schedule sends
     NO notification even for a published shift. We never touch `status`.
   • prefers-reduced-motion: no rotate / no lift on the drag ghost. */
const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The shift block, made draggable. Wraps the EXISTING block markup (passed as
// children) so the cell's visual stays byte-identical; we only add grab cursor
// + a dim while the ghost flies. touch-action:none lets pointer drag work on
// touch/trackpad without the page scrolling underneath.
function DraggableShiftBlock({ shift, member, dateIso, children }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: shift.id,
    data: { shift, fromStaffId: member.id, fromDateIso: dateIso },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ touchAction: "none" }}
      className={`cursor-grab active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
    >
      {children}
    </div>
  );
}

// The grid cell, made a drop target. OCCUPIED cells pass `occupied` → the
// droppable is `disabled` (won't accept a drop), so the only legal targets are
// EMPTY cells. The existing <td> (classes / onClick / title / aria-label) is
// preserved verbatim; on hover-over we add a calm gray drop-ring (no rainbow).
function DroppableCell({ staffId, dateIso, occupied, className, onClick, title, "aria-label": ariaLabel, children }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `${staffId}::${dateIso}`,
    data: { staffId, dateIso },
    disabled: occupied,
  });
  const dropRing =
    isOver && active && !occupied
      ? " ring-2 ring-inset ring-gray-900/30 dark:ring-gray-100/30 rounded-lg"
      : "";
  return (
    <td
      ref={setNodeRef}
      className={`${className}${dropRing}`}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </td>
  );
}

/* ─── Saved shift presets — the "Skabeloner" tray ─────────────────────────
   A calm row of preset chips above the grid. Tap a chip to ARM it, then click
   any empty day to drop a draft seeded from that preset (bloomDraft prefers the
   armed template). Tap again to disarm. Pure client-side; the "New" button
   opens a tiny modal to define one. */
function ShiftTemplatesTray({ templates, armedId, onArm, onAddClick, onRemove, t }) {
  const catFor = useCatFor();
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mr-0.5">
        {t("schedTemplates", "Templates")}
      </span>
      {templates.map((tpl) => {
        const cat = catFor(tpl.role);
        const armed = tpl.id === armedId;
        return (
          <div
            key={tpl.id}
            role="button"
            tabIndex={0}
            onClick={() => onArm(armed ? null : tpl.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onArm(armed ? null : tpl.id)}
            title={armed ? t("schedTemplateArmedHint", "Tap a day to place it · tap chip to cancel") : t("schedTemplateArmHint", "Tap, then tap a day to place it")}
            className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] cursor-pointer transition ${
              armed
                ? "border-gray-900 dark:border-gray-100 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600"
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${(ROLE_COLORS[cat] || ROLE_COLORS.floor).dot}`} />
            <span className="font-medium max-w-[120px] truncate">{tpl.label}</span>
            <span className="tabular-nums opacity-70">{tpl.start}–{tpl.end}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(tpl.id); }}
              title={t("schedTemplateRemove", "Remove template")}
              className="opacity-0 group-hover:opacity-100 transition-opacity -mr-0.5 ml-0.5 hover:text-red-400"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddClick}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-2.5 py-1 text-[12px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400"
      >
        <Plus className="w-3 h-3" />
        {t("schedTemplateNew", "New")}
      </button>
    </div>
  );
}

function TemplateCreateModal({ t, onClose, onSave }) {
  const [label, setLabel] = useState("");
  const [startH, setStartH] = useState("16");
  const [startM, setStartM] = useState("00");
  const [endH, setEndH] = useState("23");
  const [endM, setEndM] = useState("00");
  const [role, setRole] = useState("Server");
  const [err, setErr] = useState("");

  const selCls =
    "rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100";

  const save = () => {
    const start = `${startH}:${startM}`;
    const end = `${endH}:${endM}`;
    if (start === end) {
      setErr(t("schedTemplateSameTime", "Start and end can't be the same."));
      return;
    }
    onSave({
      id: `tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      label: (label.trim() || `${start}–${end}`).slice(0, 28),
      start,
      end,
      role,
      // Default the template's break to the DK suggestion for its length, so
      // shifts placed from it inherit a correct pause instead of a hidden 0.
      break_minutes: suggestedBreak(start, end),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("schedTemplateNewTitle", "New shift template")}
          </h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("schedTemplateLabel", "Name (optional)")}
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("schedTemplateLabelPh", "e.g. Evening, Lunch")}
          className={`${selCls} w-full mb-3`}
          maxLength={28}
        />

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftTime", "Time")}
        </label>
        <div className="flex items-center gap-1.5 mb-3">
          <select value={startH} onChange={(e) => setStartH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={startM} onChange={(e) => setStartM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-gray-400 mx-1">–</span>
          <select value={endH} onChange={(e) => setEndH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={endM} onChange={(e) => setEndM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftRole", "Role")}
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className={`${selCls} w-full mb-4`}>
          {OPEN_ROLE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>{t(c.key, c.fallback)}</option>
          ))}
        </select>

        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

        <Button variant="primary" className="w-full justify-center" onClick={save}>
          {t("schedTemplateSave", "Save template")}
        </Button>
      </div>
    </div>
  );
}


/* ─── Åbne vagter (open shifts) — owner lane ───────────────────────────────
   A self-contained card under the grid: the owner posts UNASSIGNED slots that
   any staffer claims one-tap from their portal (first-come). Isolated from
   ScheduleGrid so it never touches the grid's drag/cost internals. Backend
   guards the rest (Starter+ gate, overlap, atomic claim). */

// Role choices for an open shift, mapped to a role value whose ROLE_CATEGORY
// resolves to the right category label (Køkken / Bar / Gulv).
const OPEN_ROLE_CHOICES = [
  { value: "Server", key: "roleFloor", fallback: "Floor" },
  { value: "Chef", key: "roleKitchen", fallback: "Kitchen" },
  { value: "Bartender", key: "roleBar", fallback: "Bar" },
];

function OpenShiftChip({ row, t, onCancel }) {
  const catFor = useCatFor();
  const cat = catFor(row.role_on_shift);
  if (row.status === "filled") {
    return (
      <div className="rounded-lg ring-1 ring-emerald-200 dark:ring-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1.5 text-[11px] leading-tight">
        <div className="flex items-center gap-1 text-emerald-800 dark:text-emerald-300 font-medium">
          <Check className="w-3 h-3 shrink-0" />
          <span className="truncate">{row.claimed_by_name || t("openTaken", "Taken")}</span>
        </div>
        <div className="text-emerald-700/80 dark:text-emerald-400/80 tabular-nums mt-0.5">
          {formatShiftTime(row.start_time, row.end_time)}
        </div>
      </div>
    );
  }
  // OPEN: a dashed gray box (intentionally gray on all 4 sides — no role flood);
  // the role shows as a dot + label so we never hit the border-color footgun.
  const dot = (ROLE_COLORS[cat] || ROLE_COLORS.floor).dot;
  return (
    <div className="group relative rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] px-2 py-1.5 text-[11px] leading-tight">
      <div className="flex items-center gap-1 font-medium text-gray-700 dark:text-gray-200 tabular-nums">
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        {formatShiftTime(row.start_time, row.end_time)}
      </div>
      <div className="text-gray-400 dark:text-gray-500 mt-0.5">{roleLabel(catFor(row.role_on_shift), t)}</div>
      <button
        onClick={() => onCancel(row)}
        title={t("openCancel", "Remove")}
        aria-label={t("openCancel", "Remove")}
        className="absolute top-1 right-1 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-500"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function OpenShiftCreateModal({ weekDates, t, onClose, onCreated }) {
  // Multi-location S5: the open shift is posted AT the currently-viewed
  // location (same context rule as shift create) — no extra picker.
  const { branchId: _openShiftBranchId } = useBranch();
  const [dateIso, setDateIso] = useState(toISO(weekDates[0]));
  const [startH, setStartH] = useState("16");
  const [startM, setStartM] = useState("00");
  const [endH, setEndH] = useState("23");
  const [endM, setEndM] = useState("00");
  const [role, setRole] = useState("Server");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setSaving(true);
    setErr("");
    try {
      await api.post("/staff/open-shifts", {
        date: dateIso,
        start_time: `${startH}:${startM}`,
        end_time: `${endH}:${endM}`,
        role_on_shift: role,
        branch_id: _openShiftBranchId || undefined,
      });
      onCreated();
    } catch (e) {
      setErr(errText(e, t("openCreateFailed", "Couldn't add the open shift.")));
      setSaving(false);
    }
  };

  const selCls =
    "rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("openShiftAddTitle", "Add open shift")}
          </h3>
          <button onClick={onClose}>
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftDay", "Day")}
        </label>
        <select value={dateIso} onChange={(e) => setDateIso(e.target.value)} className={`${selCls} w-full mb-3`}>
          {weekDates.map((d, i) => (
            <option key={i} value={toISO(d)}>
              {dayShort(i, t)} · {d.getDate()}/{d.getMonth() + 1}
            </option>
          ))}
        </select>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftTime", "Time")}
        </label>
        <div className="flex items-center gap-1.5 mb-3">
          <select value={startH} onChange={(e) => setStartH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={startM} onChange={(e) => setStartM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-gray-400 mx-1">–</span>
          <select value={endH} onChange={(e) => setEndH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={endM} onChange={(e) => setEndM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftRole", "Role")}
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className={`${selCls} w-full mb-4`}>
          {OPEN_ROLE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>{t(c.key, c.fallback)}</option>
          ))}
        </select>

        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

        <Button variant="primary" className="w-full justify-center" onClick={submit} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("openShiftAddCta", "Post open shift")}
        </Button>
      </div>
    </div>
  );
}

function OpenShiftsPanel({ weekStart, t }) {
  const confirm = useConfirm();
  // Same resolver the chips render their role label with — the remove dialog
  // has to echo the chip word for word, not invent a second vocabulary.
  const catFor = useCatFor();
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const wsIso = toISO(weekStart);

  // Same defect, one panel down: `catch { setRows([]) }` printed "Ingen åbne
  // vagter i denne uge" — a statement about the week — whenever the request
  // failed. Åbne vagter are the slots staff are watching for, so a false
  // "there are none" is the version of this bug that reaches other people.
  const openQ = useAsyncData(
    () => api.get(`/staff/open-shifts?week_start=${wsIso}`),
    [wsIso],
    { initial: [] },
  );
  const rows = useMemo(() => (Array.isArray(openQ.data) ? openQ.data : []), [openQ.data]);
  const fetchOpen = openQ.reload;

  const cancelOpen = useCallback(async (row) => {
    // The X that triggers this is invisible on a phone (hover-only reveal, now
    // gated) and removed the shift on a single tap. Ask first — this is the
    // published plan other people are reading.
    //
    // And ask about ONE slot: "Fjern denne åbne vagt?" was word-for-word the
    // same dialog for every chip in the week, so a Friday with three open
    // slots gave the owner no way to check which X they had actually hit.
    // It now reads the chip back — same day header, same times, same role.
    const dayIdx = weekDates.findIndex((d) => toISO(d) === row.date);
    const d = dayIdx >= 0 ? weekDates[dayIdx] : new Date(`${row.date}T00:00:00`);
    const dayLabel = `${dayShort(dayIdx >= 0 ? dayIdx : (d.getDay() + 6) % 7, t)} ${d.getDate()}/${d.getMonth() + 1}`;
    const ok = await confirm({
      title: t("removeOpenShiftTitleDated", "Remove the open shift on {day}?", { day: dayLabel }),
      message: t(
        "removeOpenShiftBodyDetail",
        "{time} · {role} — it comes off the week, and anyone waiting to pick up a shift stops seeing it.",
        {
          time: formatShiftTime(row.start_time, row.end_time),
          role: roleLabel(catFor(row.role_on_shift), t),
        },
      ),
      confirmLabel: t("openCancel", "Remove"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/staff/open-shifts/${row.id}`);
      await fetchOpen();
    } catch (err) {
      setError(errText(err, t("openCancelFailed", "Couldn't remove the open shift.")));
    }
  }, [fetchOpen, t, confirm, catFor, weekDates]);

  // null, not 0, when the week did not load — and note WHICH week: the hook
  // keeps the previous week's rows through a failed switch, so a stale count
  // here would be a confident number about the wrong seven days. The body
  // below shows the banner instead of those rows for the same reason.
  const openCount = openQ.failed ? null : rows.filter((r) => r.status === "open").length;
  const byDate = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.date] ||= []).push(r);
    return m;
  }, [rows]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4 mt-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            {t("openShiftsTitle", "Open shifts")}
            {openCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[11px] font-medium tabular-nums">
                {openCount}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("openShiftsSubtitle", "Slots anyone can pick up — first to take it, gets it.")}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)} className="shrink-0">
          <Plus className="w-4 h-4" />
          {t("openShiftAdd", "Open shift")}
        </Button>
      </div>

      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

      {openQ.loading ? (
        <div className="py-1.5">
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">
            {t("openShiftsLoading", "Loading open shifts…")}
          </p>
          <div className="h-12 rounded-lg bg-gray-100 dark:bg-gray-700/40 animate-pulse" />
        </div>
      ) : openQ.failed ? (
        /* Instead of the empty line below, never above it — "no open shifts"
           and "we couldn't ask" are different weeks. */
        <LoadFailed onRetry={openQ.reload} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 py-1.5">
          {t("openShiftsEmpty", "No open shifts this week.")}
        </p>
      ) : (
        <>
          {/* Desktop: 7-day columns aligned to the week. */}
          <div className="hidden md:grid grid-cols-7 gap-2">
            {weekDates.map((d, i) => {
              const dayRows = byDate[toISO(d)] || [];
              return (
                <div key={i} className="min-h-[1.5rem]">
                  {/* 11px floor. */}
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                    {dayShort(i, t)} {d.getDate()}
                  </div>
                  <div className="space-y-1.5">
                    {dayRows.map((r) => (
                      <OpenShiftChip key={r.id} row={r} t={t} onCancel={cancelOpen} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Mobile: a flat day-labelled list. */}
          <div className="md:hidden space-y-1.5">
            {weekDates.map((d, i) => {
              const dayRows = byDate[toISO(d)] || [];
              if (!dayRows.length) return null;
              return (
                <div key={i}>
                  {/* 11px floor. */}
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                    {dayShort(i, t)} {d.getDate()}/{d.getMonth() + 1}
                  </div>
                  <div className="space-y-1.5">
                    {dayRows.map((r) => (
                      <OpenShiftChip key={r.id} row={r} t={t} onCancel={cancelOpen} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {showCreate && (
        <OpenShiftCreateModal
          weekDates={weekDates}
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchOpen(); }}
        />
      )}
    </div>
  );
}


/** The desktop/tablet week table.
 *
 *  Exported (named) for the SAME reason MobileSchedule is: the Option-B section
 *  bodies and the day-header status line are structural JSX changes to a table,
 *  and in this repo a green build has shipped a white screen before (a TDZ went
 *  to production). ScheduleGrid.optionB.test.jsx mounts this, which is the only
 *  way to find out that a <tbody> actually renders. Nothing outside the tests
 *  imports it — the page's own use is the declaration below. */
export function ScheduleGrid({
  staff,
  weekDates,
  getShiftsForCell,
  unavailFor,
  preferredFor,
  absenceFor,
  onCellClick,
  onMoveShift,
  showCost,
  dailyCost,
  forecast,
  forecastByDate,
  costBasis,
  targetPct,
  weekLoad,
  t,
  lang,
}) {
  const catFor = useCatFor();
  const { user } = useAuth();
  const businessType = user?.business_type;
  // Map server `daily` entries by date for O(1) footer lookups.
  const dailyByDate = useMemo(() => {
    const m = {};
    for (const d of dailyCost || []) m[d.date] = d;
    return m;
  }, [dailyCost]);

  // Option B — one <tbody> per section, with a tinted header band above its
  // people. Gated inside groupStaffBySection(); below the gate `grouped` is
  // false and the table renders exactly the single ungrouped body it always has.
  const grouping = useMemo(
    () => groupStaffBySection(staff, businessType),
    [staff, businessType],
  );
  // The per-row colour dot only means something where sections exist. On a shop
  // or a consultancy every role resolves through catFor's `|| "floor"`, so the
  // dot is one violet full stop on every row with nothing in the legend that
  // explains it — a decoration pretending to be a key. Silence instead.
  const showRowDot = hasSections(businessType);

  // Per-day rollup behind the column-header status dot, keyed by ISO date.
  // Built from the SAME staff × getShiftsForCell walk the rows below use, so
  // the header can never claim something the cells under it contradict.
  const dayTally = useMemo(() => {
    const m = {};
    for (const date of weekDates) {
      const all = [];
      for (const member of staff) all.push(...getShiftsForCell(member.id, date));
      m[toISO(date)] = tallyDay(all);
    }
    return m;
  }, [staff, weekDates, getShiftsForCell]);

  // Drag-to-move is POINTER-only. 6px activation distance = a plain click still
  // opens the modal / blooms a draft (sub-6px travel is not a drag). We do NOT
  // register a KeyboardSensor: dnd-kit's default keyboard movement nudges the
  // ghost by pixels and can't snap to grid cells, so a keyboard-only user could
  // never reliably land a drop — a misleading half-feature. Reassigning by
  // keyboard stays fully available via the cell → ShiftModal path (the modal
  // lets you change staff + date directly).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  // The shift currently being dragged — drives the DragOverlay ghost. null = idle.
  const [activeShift, setActiveShift] = useState(null);

  const handleDragStart = (event) => {
    setActiveShift(event.active?.data?.current?.shift || null);
  };
  const handleDragEnd = (event) => {
    setActiveShift(null);
    const { active, over } = event;
    if (!over || !over.data?.current || !active?.data?.current) return;
    const to = over.data.current; // { staffId, dateIso } of the EMPTY target cell
    const from = active.data.current; // { shift, fromStaffId, fromDateIso }
    // No-op if dropped back where it started (same staff + same day).
    if (to.staffId === from.fromStaffId && to.dateIso === from.fromDateIso) return;
    onMoveShift?.(from.shift, to.staffId, to.dateIso);
  };

  // Ghost block for the DragOverlay — same markup as the in-cell block (white +
  // 3px ROLE_BAR + the time line), lifted with a shadow and a tiny rotate. We
  // respect prefers-reduced-motion: no rotate when the OS asks for less motion.
  const ghostCat = activeShift
    ? catFor(activeShift.role_on_shift)
    : "floor";

  // The tinted band above a section's people (Option B). A PLAIN <tr>/<td>:
  // it must never register a droppable, or dnd-kit would offer the owner a
  // drop target that belongs to nobody. Its seven day cells answer the one
  // question a section header is for — "is the pass covered on Saturday?" —
  // and the amber 0 is the whole point: a day that HAS a roster but nobody
  // from this section is the gap you can't see by counting rows.
  const renderSectionHeader = (sec) => {
    const hdr = SECTION_HEADER[sec.id] || SECTION_HEADER.other;
    const label = roleLabel(sec.id, t);
    const sectionHours = sec.members.reduce(
      (sum, m) => sum + weeklyHoursFor(m.id, weekDates, getShiftsForCell),
      0,
    );
    return (
      <tr key={`section-${sec.id}`} className={hdr.bg}>
        <td className={`px-4 py-1.5 border-l-[3px] ${hdr.bar}`}>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${hdr.dot} flex-shrink-0`} aria-hidden="true" />
            <span className={`text-xs font-semibold ${hdr.text}`}>{label}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {sec.members.length}
            </span>
          </div>
        </td>
        {weekDates.map((date, i) => {
          const onShift = sec.members.filter(
            (m) => getShiftsForCell(m.id, date).length > 0,
          ).length;
          const dayEmpty = (dayTally[toISO(date)]?.total || 0) === 0;
          return (
            <td key={i} className="px-1 py-1.5 text-center">
              {dayEmpty ? (
                // Nobody at all is closed/quiet, not a hole in this section.
                <span className="text-xs text-gray-300 dark:text-gray-600 tabular-nums">—</span>
              ) : onShift === 0 ? (
                <span
                  className="inline-flex items-center justify-center rounded px-1.5 text-xs font-semibold tabular-nums bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                  title={(t("schedSectionNobodyOn", "Nobody from {section} is on shift") || "").replace("{section}", label)}
                >
                  0
                </span>
              ) : (
                <span className={`text-xs font-semibold tabular-nums ${hdr.text}`}>{onShift}</span>
              )}
            </td>
          );
        })}
        <td className={`px-3 py-1.5 text-right text-xs font-semibold tabular-nums ${hdr.text}`}>
          {sectionHours > 0 ? formatTimer(sectionHours, lang) : "—"}
        </td>
      </tr>
    );
  };

  // ONE staff row. Extracted because Option B renders the roster from a
  // different place depending on the gate — one flat <tbody>, or one per
  // section — and two copies of a 280-line row is how the two would drift.
  const renderStaffRow = (member) => {
    const cat = catFor(member.role);
    const colors = ROLE_COLORS[cat] || ROLE_COLORS.floor;

    return (
      <tr key={member.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/40">
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            {showRowDot && <span className={`w-2 h-2 rounded-full ${colors.dot} flex-shrink-0`} />}
            <div>
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[104px]">
                  {member.name}
                </span>
                {/* Confirmation badge — surfaces the staff-side "Jeg har
                    set det". Green ONLY when every published shift this
                    week is confirmed; amber otherwise; nothing when no
                    published shifts (or confirmed_at not in payload). */}
                {(() => {
                  const cs = staffConfirmState(member.id, weekDates, getShiftsForCell);
                  if (!cs) return null;
                  return cs === "all" ? (
                    <span title={t("schedConfirmedAll", "Confirmed")} className="shrink-0 leading-none">
                      <Icon name="CheckCircle2" size={13} className="text-emerald-500 dark:text-emerald-400" />
                    </span>
                  ) : (
                    <span title={t("schedConfirmedPartial", "Not everyone has confirmed yet")} className="shrink-0 leading-none">
                      <Icon name="AlertTriangle" size={12} className="text-amber-500 dark:text-amber-400" />
                    </span>
                  );
                })()}
              </div>
              {/* 11px floor — role + contract type, in the 160px staff column
                  that has the room for it. */}
              <div className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
                <span>{member.role}</span>
                {/* Contract type — Fuldtid / Deltid / Studerende / Freelance.
                    This is what replaced the per-shift kroner: an owner
                    building a week needs to know who is a student before they
                    put them on Wednesday lunch, and unlike a wage it is not
                    private from the person standing behind them. No chip at
                    all when contract_type is empty — an empty chip is worse
                    than none. */}
                {contractLabel(member.contract_type, t) && (
                  <span className="px-1 py-px rounded bg-gray-100 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">
                    {contractLabel(member.contract_type, t)}
                  </span>
                )}
                {/* Vagtplan Shield hours chip — "34/37t". Amber past
                    the contract cap, red past DK 48h or with an
                    11-timers rest conflict; calm gray otherwise.
                    Hidden when week-load is unavailable (fail-soft)
                    or the staffer has no shifts this week. */}
                {(() => {
                  const e = (weekLoad?.staff || []).find((x) => x.staff_id === member.id);
                  if (!e || !(e.hours > 0)) return null;
                  const hasRest = (e.rest_warnings || []).length > 0;
                  const cls = e.over_dk48 || e.over_month || hasRest
                    ? "bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400"
                    : e.over_cap
                      ? "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "bg-gray-100 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400";
                  // formatTimer, not raw interpolation with a literal "t".
                  // Seen live on 2026-09-20: this chip rendered "6.25t" —
                  // an English decimal point wearing the Danish unit, in BOTH
                  // languages, because the number came straight off the API
                  // and the "t" was typed here. Next to it the grid's own
                  // hours read "6,25t" in Danish and "6.25h" in English,
                  // because those go through the formatter. Two hour figures,
                  // one row apart, disagreeing about notation.
                  // One resolved unit for the chip AND its tooltip. The
                  // tooltip strings used to carry a literal "t" in the
                  // catalogue, so the English chip read "34 h" above a tooltip
                  // that said "34t of 37t" — the Danish unit, unformatted, on
                  // an English screen.
                  const hoursLang = lang;
                  const label = e.cap != null
                    ? `${formatTimer(e.hours, hoursLang)}/${formatTimer(e.cap, hoursLang)}`
                    : formatTimer(e.hours, hoursLang);
                  const title = [
                    e.over_cap ? t("shieldOverCapTitle", "Over the contract cap ({cap}/week)").replace("{cap}", formatTimer(e.cap, hoursLang)) : "",
                    e.over_dk48 ? t("shieldOver48Title", "Over the DK 48h weekly ceiling") : "",
                    e.over_month ? t("shieldOverMonthTitle", "{period}: {h} of {cap} — over the monthly limit").replace("{period}", e.period_label || t("shieldMonthWord", "Month")).replace("{h}", formatTimer(e.month_hours, hoursLang)).replace("{cap}", formatTimer(e.month_cap, hoursLang)) : "",
                    hasRest ? t("shieldRestTitle", "Under 11 hours' rest between shifts") : "",
                    !e.over_month && e.month_cap != null ? t("shieldMonthInfoTitle", "{period}: {h} of {cap}").replace("{period}", e.period_label || t("shieldMonthWord", "Month")).replace("{h}", formatTimer(e.month_hours, hoursLang)).replace("{cap}", formatTimer(e.month_cap, hoursLang)) : "",
                    e.warn_enabled === false ? t("shieldWarnOffTitle", "Hour-limit warnings are off for this staffer") : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <span
                      title={title || t("shieldHoursTitle", "Scheduled hours this week")}
                      className={`px-1 py-px rounded font-medium tabular-nums ${cls}`}
                    >
                      {label}
                    </span>
                  );
                })()}
              </div>
            </div>
          </div>
        </td>
        {weekDates.map((date, dayIdx) => {
          const cellShifts = getShiftsForCell(member.id, date);
          const shift = cellShifts[0];
          // Everything after the first. Rendered below the primary
          // block so a second same-day shift is visible AND has its
          // own click target — before this it existed in the data,
          // in the hours chip and in the staff app, but could not be
          // opened, moved or deleted from the owner's own grid.
          const extraShifts = cellShifts.slice(1);
          const isToday = toISO(date) === toISO(new Date());

          if (!shift) {
            // A concrete fravær (approved ferie/syg) outranks a standing
            // "kan ikke" — both tint the empty cell so the owner sees
            // who's off, but both stay legal drop targets (soft signals;
            // the owner can still hand-place over them).
            const abs = absenceFor?.(member.id, date) || null;
            const blk = abs ? null : unavailFor(member.id, date);
            // A soft "helst" — shown, never treated as a block.
            const pref = abs || blk ? null : preferredFor(member.id, date);
            const absLabel = abs ? absKindLabel(abs.kind, t) : "";
            return (
              <DroppableCell
                key={dayIdx}
                staffId={member.id}
                dateIso={toISO(date)}
                occupied={false}
                className={`group px-1 py-2 text-center cursor-pointer transition-colors ${
                  abs
                    ? "bg-indigo-50/50 dark:bg-indigo-950/20"
                    : blk
                      ? "bg-red-50/60 dark:bg-red-950/20"
                      : pref
                        ? "bg-emerald-50/60 dark:bg-emerald-950/20"
                        : isToday ? "bg-gray-50/60 dark:bg-gray-800/40" : ""
                } hover:bg-gray-50 dark:hover:bg-gray-800/40`}
                onClick={() => onCellClick(member.id, date, null)}
                title={abs
                  ? (abs.reason ? `${absLabel} · ${abs.reason}` : absLabel)
                  : blk
                    ? (blk.note
                        ? `${t("schedKanIkkeCell", "Can't work")} · ${blk.note}`
                        : t("schedKanIkkeCell", "Can't work"))
                    : t("schedBloomHint", "Click to add a shift")}
                aria-label={abs
                  ? t("schedFravaerAria", "{name} is off this day").replace("{name}", member.name)
                  : blk
                    ? t("schedKanIkkeAria", "{name} can't work this day").replace("{name}", member.name)
                    : t("schedAddShiftAria", "Add shift for {name}").replace("{name}", member.name)}
              >
                {/* Available cells render SILENCE — a single hover-Plus
                    advertises one-tap add so the grid stays calm at 16×7.
                    Fravær cells show a calm indigo kind-chip; "Kan ikke"
                    a quiet red chip. Both fade to the Plus on hover
                    (override). h-14 matches the occupied block. */}
                <div className="h-14 relative flex items-center justify-center">
                  {/* 9px was the smallest type anywhere in BonBox, and it was
                      carrying "Ferie" / "Barns sygedag" — the reason a name is
                      unavailable. 11px is the floor; the chip can take a second
                      line inside an h-14 cell, which the one-line header rows
                      above this grid deliberately cannot. */}
                  {abs && (
                    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-indigo-100/70 dark:bg-indigo-900/30 transition-opacity group-hover:opacity-0" aria-hidden>
                      <span className="text-[11px] leading-tight font-semibold text-indigo-500 dark:text-indigo-300 uppercase tracking-wide">{absLabel}</span>
                    </span>
                  )}
                  {blk && (
                    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-red-100/70 dark:bg-red-900/30 transition-opacity group-hover:opacity-0" aria-hidden>
                      <CalendarOff className="w-[11px] h-[11px] text-red-400 dark:text-red-400" strokeWidth={2} />
                      {blk.timeLabel && (
                        <span className="text-[11px] leading-tight font-medium text-red-400 dark:text-red-400 tabular-nums">{blk.timeLabel}</span>
                      )}
                    </span>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    <Icon name="Plus" size={14} className="text-gray-300 dark:text-gray-600" />
                  </span>
                </div>
              </DroppableCell>
            );
          }

          const shiftCat = catFor(shift.role_on_shift || member.role);
          const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
          const isDraft = shift.status === "draft";

          return (
            // FILLED cell = NOT a drop target (occupied) — forbids
            // overwrite. Its block is the DRAG SOURCE. The cell's
            // onClick (open modal) still fires on a plain click thanks
            // to the 6px PointerSensor activation distance.
            <DroppableCell
              key={dayIdx}
              staffId={member.id}
              dateIso={toISO(date)}
              occupied
              className={`px-1 py-2 text-center cursor-pointer transition-colors ${
                isToday ? "bg-gray-50/60 dark:bg-gray-800/40" : ""
              } hover:bg-gray-100 dark:hover:bg-gray-700/50`}
              onClick={() => onCellClick(member.id, date, shift)}
            >
              <DraggableShiftBlock shift={shift} member={member} dateIso={toISO(date)}>
                <div
                  className={`min-h-[3.5rem] text-left rounded-lg pl-2.5 pr-2 py-1.5 leading-tight bg-white dark:bg-[rgb(var(--surface-card))] ${cardChrome(isDraft)} border-l-[3px] ${roleBar(shiftCat, showRowDot)}`}
                >
                  <div className="text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {formatShiftTime(shift.start_time, shift.end_time)}
                  </div>
                  {/* Line 2 carries everything that is NOT the time: hours, the
                      cross-role chip, and the two status marks. There is no
                      line 3 any more — the per-shift kroner used to live there,
                      and hours + kroner on adjacent lines is a division anyone
                      can do in their head. A rota is a screen other people
                      stand in front of; a wage is not. */}
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {formatShiftHours(hrs, lang)}
                    {shift.role_on_shift && shift.role_on_shift !== member.role && (
                      <span className="ml-1.5 inline-block rounded px-1 py-px bg-gray-100 dark:bg-gray-700 text-[11px] font-medium text-gray-500 dark:text-gray-400 align-middle leading-none">
                        {roleLabel(catFor(shift.role_on_shift), t)}
                      </span>
                    )}
                    <ShiftMarkers shift={shift} published={!isDraft} t={t} />
                  </div>
                  {isDraft && (
                    <div className="mt-0.5">
                      <DraftPill t={t} />
                    </div>
                  )}
                </div>
              </DraggableShiftBlock>
              {/* Split shift — the second (and any further) shift on
                  this day. Each carries its own click target and its
                  own drag handle, so it can be opened, moved and
                  deleted like the first. stopPropagation because the
                  cell's own onClick opens shifts[0]; without it a tap
                  on the second block would edit the first. */}
              {extraShifts.map((ex) => {
                const exHrs = calcHours(
                  ex.start_time, ex.end_time, ex.break_minutes || 0,
                );
                const exCat = catFor(ex.role_on_shift || member.role);
                const exDraft = ex.status === "draft";
                return (
                  <div
                    key={ex.id}
                    className="mt-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCellClick(member.id, date, ex);
                    }}
                  >
                    <DraggableShiftBlock shift={ex} member={member} dateIso={toISO(date)}>
                      <div
                        className={`text-left rounded-lg pl-2.5 pr-2 py-1.5 leading-tight bg-white dark:bg-[rgb(var(--surface-card))] ${cardChrome(exDraft)} border-l-[3px] ${roleBar(exCat, showRowDot)}`}
                      >
                        <div className="text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                          {formatShiftTime(ex.start_time, ex.end_time)}
                        </div>
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {formatShiftHours(exHrs, lang)}
                          <ShiftMarkers shift={ex} published={!exDraft} t={t} />
                        </div>
                        {exDraft && (
                          <div className="mt-0.5">
                            <DraftPill t={t} />
                          </div>
                        )}
                      </div>
                    </DraggableShiftBlock>
                  </div>
                );
              })}
            </DroppableCell>
          );
        })}
        {/* Timer — this staffer's weekly net hours; amber when over
            their max_hours_week cap, with the over-amount beneath. */}
        <td className="px-3 py-2 text-right align-middle">
          {(() => {
            const wh = weeklyHoursFor(member.id, weekDates, getShiftsForCell);
            if (wh <= 0) {
              return <span className="text-[12px] text-gray-300 dark:text-gray-600">—</span>;
            }
            const cap = member.max_hours_week;
            const over = cap && wh > cap;
            const hoursLang = lang;
            return (
              <div className="leading-tight">
                <div
                  className={`text-[13px] font-semibold tabular-nums ${
                    over
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-gray-900 dark:text-gray-100"
                  }`}
                  title={over ? t("schedOvertimeTip", "Over weekly hours") : undefined}
                >
                  {formatTimer(wh, hoursLang)}
                </div>
                {over && (
                  // 11px floor — this is the over-cap figure, in the 160px
                  // Timer column.
                  <div className="text-[11px] text-amber-500 dark:text-amber-400 tabular-nums">
                    +{formatTimer(wh - cap, hoursLang)}
                  </div>
                )}
              </div>
            );
          })()}
        </td>
      </tr>
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-40">
                {t("schedStaffCol")}
              </th>
              {weekDates.map((date, i) => {
                const isToday = toISO(date) === toISO(new Date());
                // Booked covers for this day — the DEMAND half of the grid.
                // null/undefined = this owner doesn't take reservations, so the
                // line is absent entirely. 0 is a real fact (quiet night) and
                // DOES render — "no bookings" and "no booking system" are
                // different truths and must look different.
                const coversBooked = dailyByDate[toISO(date)]?.covers_booked;
                return (
                  <th
                    key={i}
                    className={`px-2 py-3 text-center text-xs font-semibold uppercase tracking-wider w-[calc((100%-13rem)/7)] ${
                      isToday
                        ? "text-gray-900 dark:text-gray-100 bg-gray-50/50 dark:bg-gray-800/50"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    {/* Today's column says so in words. "I dag" in the brand
                        accent, not emerald — emerald is now the "seen by staff"
                        signal in this grid and a green weekday header would be
                        read as a status claim about the whole column. */}
                    <div
                      className={
                        isToday
                          ? "text-[rgb(var(--brand-600))] dark:text-[rgb(var(--brand-400))]"
                          : undefined
                      }
                    >
                      {isToday ? t("schedToday") : dayShort(i, t)}
                    </div>
                    {/* 11px floor — four characters, so the column width is
                        unaffected (unlike the two nowrap lines below). */}
                    <div className="font-normal text-[11px] mt-0.5 opacity-70">
                      {date.getDate()}/{date.getMonth() + 1}
                    </div>
                    {/* Demand on top, roster in the middle, cost in the footer —
                        the column reads top-to-bottom as one sentence. Kept
                        deliberately quiet (10px, gray, normal weight): the
                        footer's labor% is the column headline and stays it.
                        The word "booked" is load-bearing — walk-ins never enter
                        the book, so a bare count would overclaim the night. */}
                    {typeof coversBooked === "number" && (
                      // whitespace-nowrap is load-bearing (same reason as the
                      // mobile stats strip): the day column is only ~58px of
                      // content box at iPad landscape, so without it "38 booket"
                      // wraps to two lines and this "quiet" line becomes the
                      // TALLEST thing in the header — inverting the hierarchy it
                      // is supposed to sit under. No icon here for the same
                      // reason: icon+gap costs 14px the column does not have, and
                      // it would push the table wide enough to start scrolling on
                      // iPad. The word "booket" already says what the number is.
                      <div
                        className="font-normal normal-case tracking-normal text-[10px] mt-1 whitespace-nowrap text-gray-500 dark:text-gray-400 tabular-nums"
                        aria-label={t("schedCoversBookedAria").replace("{n}", coversBooked)}
                      >
                        {coversBooked} {t("schedCoversBooked")}
                      </div>
                    )}
                    {/* LAST header line — the day's roster STATUS. Amber = the
                        owner still owes this day a publish; emerald = every
                        published shift has been acknowledged; gray = sent, not
                        everyone has looked yet (silence, not alarm — staff have
                        hours to read a rota). The dot alone is not information,
                        so the whole sentence goes in `title` AND sr-only. The
                        word "vagter" is xl:-only: at 1024px this column is ~58px
                        of content box and the number has to survive alone. */}
                    {(() => {
                      const tally = dayTally[toISO(date)] || { total: 0, drafts: 0, pub: 0, seen: 0 };
                      const tone = dayDotTone(tally);
                      const sentence = dayTallyText(tally, t);
                      return (
                        <div
                          className="font-normal normal-case tracking-normal text-[10px] mt-1 whitespace-nowrap flex items-center justify-center gap-1 tabular-nums"
                          title={sentence}
                        >
                          {tone !== "none" && (
                            <span
                              className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${DAY_DOT_CLASS[tone]}`}
                              aria-hidden="true"
                            />
                          )}
                          <span className={tone === "none" ? "text-gray-400 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"}>
                            {tally.total}
                            <span className="hidden xl:inline"> {t("schedShiftsWord", "shifts")}</span>
                          </span>
                          <span className="sr-only">{sentence}</span>
                        </div>
                      );
                    })()}
                  </th>
                );
              })}
              {/* Timer column — weekly net hours per staffer (right edge). */}
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-12">
                {t("schedTimerCol", "Hours")}
              </th>
            </tr>
          </thead>
          {/* Option B: one <tbody> per section, each under a tinted header
              band. Below the gate (few staff, one section, or a vertical with
              no sections at all) this is the SAME single ungrouped body the
              grid has always rendered. Header rows register no droppable, so
              drag-and-drop targets are unchanged. */}
          {grouping.grouped ? (
            grouping.sections.map((sec) => (
              <tbody key={sec.id} className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {renderSectionHeader(sec)}
                {sec.members.map(renderStaffRow)}
              </tbody>
            ))
          ) : (
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {staff.map(renderStaffRow)}
            </tbody>
          )}
          {/* Per-day footer — hours + (cost) + labor% per column, aligned to
              the day cells above. Only rendered when the server returned the
              daily cost layer; labor% color-codes vs target and shows "—" with
              no revenue. Compact + tabular-nums to stay calm under 16 rows. */}
          {dailyCost && dailyCost.length > 0 && (
            <tfoot>
              <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40">
                <td className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 align-top">
                  {t("schedDayTotals")}
                </td>
                {weekDates.map((date, i) => {
                  const iso = toISO(date);
                  const d = dailyByDate[iso];
                  const hrs = d && typeof d.hours === "number" ? d.hours : 0;
                  const cost = d ? costByBasis(d, costBasis) : null;
                  const laborPct = d
                    ? (costBasis === "loaded" ? d.labor_pct_loaded : d.labor_pct_gross)
                    : null;
                  const hasRev = d ? d.revenue != null : false;
                  return (
                    <td key={i} className="px-1 py-3 text-center align-top leading-tight">
                      {/* Per-day total hours — quiet context above the labor%. */}
                      <div className="text-[11px] text-gray-700 dark:text-gray-300 tabular-nums">
                        {formatShiftHours(hrs, lang)}
                      </div>
                      {showCost && cost != null && (
                        <div className="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums mt-px">
                          ≈ {formatKr(cost, { decimals: 0 })}
                        </div>
                      )}
                      {/* Labor% — the column headline, color-coded vs target. */}
                      <div className="mt-1">
                        {hasRev && typeof laborPct === "number" ? (
                          <span className={`inline-flex items-center gap-0.5 text-sm font-bold tabular-nums ${laborToneFooter(laborPct, targetPct)}`}>
                            {pctLabel(laborPct)}
                            {targetPct != null && laborPct > targetPct && (
                              <Icon name="TrendingUp" size={11} className="shrink-0" aria-hidden="true" />
                            )}
                          </span>
                        ) : (
                          <span className="text-sm font-bold text-gray-300 dark:text-gray-600 tabular-nums">—</span>
                        )}
                      </div>
                      {/* Predicted demand vs rostered hours — the persistent
                          forecast overlay so the owner feels it while building
                          shifts. HONEST: only shown when a real same-weekday
                          history backs it (>=3 samples) and demand is
                          meaningful; the amber "short" delta is the actionable
                          bit (owners care most about being understaffed). The
                          basis ("from N recent sales" + weather) is on hover. */}
                      {(() => {
                        const fc = forecastByDate?.[iso];
                        if (!fc) return null;
                        const demand = fc.predicted_demand_hours;
                        // Demand line: only when a real same-weekday history backs it.
                        const showDemand = demand >= 1 && (fc.sample_count || 0) >= 3;
                        // Booked-covers CONTEXT: forward reservations for this day.
                        // Honest — the booked number, never a demand claim. The
                        // backend only sets it on the revenue path for food venues
                        // with an actual book, so a salon (appointment demand) and
                        // reservations-off venues send null. Shows even when the
                        // demand forecast is too thin, so a booked-solid restaurant
                        // with sparse sales history still sees its book.
                        const covers = fc.booked_covers > 0 ? fc.booked_covers : 0;
                        if (!showDemand && !covers) return null;
                        const shortBy = demand - hrs;
                        const isShort = showDemand && shortBy > Math.max(1, demand * 0.15);
                        // Basis names the real signal — "bookings" for a salon
                        // (appointment density), "sales" for revenue verticals.
                        const tip =
                          (fc.sample_basis === "appointments"
                            ? (t("schedForecastBasisAppts", "Estimated from {n} recent same-weekday bookings") || "")
                            : (t("schedForecastBasis", "Estimated from {n} recent same-weekday sales") || "")
                          ).replace("{n}", String(fc.sample_count)) +
                          (fc.weather_summary ? ` · ${fc.weather_summary}` : "");
                        return (
                          <div className="mt-1 text-[10px] leading-tight tabular-nums">
                            {showDemand && (
                              <div title={tip}>
                                <span className="text-gray-400 dark:text-gray-500">
                                  {t("schedForecastDemand", "demand")} ~{formatHours(demand, { lang, decimals: 0 })}
                                </span>
                                {isShort && (
                                  <span className="text-amber-600 dark:text-amber-400 font-semibold ml-1">
                                    −{formatHours(shortBy, { lang, decimals: 0 })}
                                  </span>
                                )}
                              </div>
                            )}
                            {covers > 0 && (
                              <div className="text-gray-400 dark:text-gray-500">
                                {(t("schedForecastCoversBooked", "{n} guests booked") || "").replace("{n}", String(covers))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  );
                })}
                {/* Timer — the week's grand total hours across all staff. */}
                <td className="px-3 py-3 text-right align-top">
                  {(() => {
                    const total = staff.reduce(
                      (sum, m) => sum + weeklyHoursFor(m.id, weekDates, getShiftsForCell),
                      0
                    );
                    return (
                      <div className="text-[13px] font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                        {formatTimer(total, lang)}
                      </div>
                    );
                  })()}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
    <DragOverlay dropAnimation={PREFERS_REDUCED_MOTION ? null : undefined}>
      {activeShift ? (
        <div
          className={`min-h-[3.5rem] text-left rounded-lg pl-2.5 pr-2 py-1.5 leading-tight bg-white dark:bg-[rgb(var(--surface-card))] ${cardChrome(activeShift.status === "draft")} border-l-[3px] ${roleBar(ghostCat, showRowDot)} shadow-lg cursor-grabbing`}
          style={PREFERS_REDUCED_MOTION ? undefined : { transform: "rotate(2deg)" }}
        >
          <div className="text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {formatShiftTime(activeShift.start_time, activeShift.end_time)}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
            {formatShiftHours(calcHours(activeShift.start_time, activeShift.end_time, activeShift.break_minutes || 0), lang)}
            <ShiftMarkers shift={activeShift} published={activeShift.status !== "draft"} t={t} />
          </div>
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}

/* ═══════════════════════════════════════════════════════════
   PUBLISH CONFIRM MODAL  (audit #248 P0 — the deliberate "go-live" gate)
   Owners are paying real money; publishing emails staff. So before we go
   live we show exactly what's about to ship: N draft shifts → M staff,
   total hours, and (when rates exist) the estimated labor cost. The
   summary is computed client-side from already-loaded shifts+staff, so
   the sheet is instant — no extra fetch. The post-publish success banner
   (built in confirmPublish) reports the server's REAL notified count, so
   we never fabricate "everyone was emailed".
   ═══════════════════════════════════════════════════════════ */
function StatTile({ icon, value, label }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] px-3 py-2.5">
      <div className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums leading-tight">
        {value}
      </div>
      <div className="flex items-center gap-1 mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
        <Icon name={icon} size={13} className="text-gray-400 dark:text-gray-500" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function PublishConfirmModal({ summary, result, weekStart, publishing, onConfirm, onClose, onShare, t, lang }) {
  // The Shield warnings below arrive as raw numbers and used to be pasted into
  // catalogue strings that typed the hour unit themselves, so a Danish owner
  // read an English unit here and the Danish one on the chip the sentence is
  // about — one row apart.
  const fmtWarnHours = (n) => formatHours(n, { lang });
  const done = !!result; // success state shown after a publish completes
  const nothing = !summary || summary.draftCount === 0;
  // The publish landed in the database and reached NOBODY. That is the state
  // this sheet used to celebrate: a green tick, "{n} shifts are now live on
  // your team's schedule", and the actual outcome — that not one person was
  // sent anything — demoted to grey 12px underneath it. An owner reads the
  // headline. Across 51 venues no staff link has ever been opened, and this is
  // one of the screens that kept that quiet. So it stops being a footnote and
  // becomes the headline, the icon and the tone.
  //   result.notify === 0    → we know: nobody.
  //   result.notify === null → the server did not tell us; see below.
  const toldNobody = done && result.published > 0 && result.notify === 0;
  const notifyUnknown = done && result.published > 0 && result.notify == null;
  const headerIcon = done ? (toldNobody ? "AlertTriangle" : "CheckCircle2") : "Send";
  const headerTone = toldNobody
    ? { ring: "bg-amber-50 dark:bg-amber-900/20", glyph: "text-amber-600 dark:text-amber-400" }
    : { ring: "bg-emerald-50 dark:bg-emerald-900/20", glyph: "text-emerald-600 dark:text-emerald-400" };
  const title = done
    ? (result.published === 0
        ? t("publishNothingTitle", "Nothing to publish")
        : toldNobody
          ? t("publishedNobodyToldTitle", "Published — but nobody was told")
          : t("publishedTitle", "Week published"))
    : (nothing
        ? t("publishNothingTitle", "Nothing to publish")
        : t("publishConfirmTitle", "Publish this week?"));
  return (
    // Container swap ONLY — every row below is the one that shipped. This was
    // the last hand-rolled `fixed inset-0 items-center` card on the page: an
    // uncapped, unscrollable box holding four stat tiles, up to six Vagtplan
    // Shield warnings and the notify note. On a week with several warnings the
    // card grew past the viewport and "Udgiv uge" — the button the whole sheet
    // exists to reach — sat below the fold with nothing to scroll, which is
    // exactly the failure the file header at the top documents ShiftModal being
    // ported out of. Sheet supplies the phone bottom sheet, the height cap, the
    // single scroller, the keyboard inset, Escape and the focus trap; this file
    // supplies the three rows: fixed header, scrolling body, pinned footer.
    <Sheet
      onClose={onClose}
      zClassName="z-50"
      ariaLabel={title}
      panelClassName="bg-white dark:bg-gray-800 shadow-sm border-t sm:border border-gray-200 dark:border-gray-700"
    >
      {/* Header — never scrolls, so the owner always knows which week this is */}
      <div className="shrink-0 flex items-start justify-between gap-3 px-5 pt-4 pb-3 sm:px-6 sm:pt-5">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full ${headerTone.ring} flex items-center justify-center shrink-0`}>
              <Icon name={headerIcon} size={done ? 20 : 18} className={headerTone.glyph} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white leading-tight">
                {title}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatWeekRange(weekStart, lang)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-colors"
            aria-label={t("close", "Close")}
          >
            <Icon name="X" size={20} />
          </button>
      </div>

      {/* The one scrolling region. The Shield warnings that used to push Udgiv
          off the bottom of the screen now scroll inside this box instead. */}
      <div data-sheet-body="" className="flex-1 overflow-y-auto px-5 pb-4 space-y-4 sm:px-6">

        {done ? (
          /* ── Success — durable confirmation from the server's real counts ── */
          <div className="space-y-1.5">
            {result.published === 0 ? (
              <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
                {t("publishedNothing", "Already up to date — nothing new to publish.")}
              </p>
            ) : toldNobody ? (
              /* Truth first, in the sentence the owner actually reads, and the
                 saved-shift count second — where it belongs, because it is the
                 part that needed no telling. */
              <>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                  {t(
                    "publishedNobodyToldBody",
                    "No one was sent anything. None of the affected staff have an email on file.",
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {t(
                    "publishedSavedNotSent",
                    "{n} shift(s) are saved as published, but your team has not been told.",
                    { n: result.published },
                  )}
                </p>
                {/* The way out is the sheet's PRIMARY action, in the footer —
                    see below. A sheet that reports a silent failure and offers
                    only "Done" is a dead end, and this one is the last screen
                    before the owner walks away believing the week went out. */}
              </>
            ) : (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
                  {t("publishedLiveCount", "{n} shift(s) are now live on your team's schedule.").replace("{n}", String(result.published))}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {notifyUnknown
                    /* The server did not give us a count. "0 notified" would be
                       a claim; so would "{m} notified". Say which it is. */
                    ? t(
                        "publishedNotifyUnknown",
                        "We could not confirm whether anyone was notified.",
                      )
                    : t("publishedNotifyYes", "{m} staff notified about their changes.").replace("{m}", String(result.notify))}
                </p>
              </>
            )}
          </div>
        ) : nothing ? (
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            {t(
              "publishNothingBody",
              "Every shift this week is already published. Add or edit a shift, then publish to push the changes to your staff.",
            )}
          </p>
        ) : (
          <>
            {/* What's about to go live */}
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile
                icon="CalendarDays"
                value={summary.draftCount}
                label={t("publishStatShifts", "draft shifts")}
              />
              <StatTile
                icon="Users"
                value={summary.staffCount}
                label={t("publishStatStaff", "staff")}
              />
              <StatTile
                icon="Clock"
                value={formatTimer(summary.hours, lang)}
                label={t("publishStatHours", "total hours")}
              />
              {summary.anyRate && (
                <StatTile
                  icon="Coins"
                  /* Was a bare toLocaleString + a "DKK" token: the owner read
                     this figure in the BROWSER's locale while the toolbar
                     behind the sheet printed the same week's wage bill through
                     formatKr. Two spellings of one number, 200px apart. */
                  value={
                    summary.cost == null
                      ? "—"
                      : `≈ ${formatKr(summary.cost, { decimals: 0 })}`
                  }
                  label={t("publishStatCost", "est. labor")}
                />
              )}
            </div>

            {/* Vagtplan Shield — labour-law signals for THIS week. Warns,
                never blocks: the owner always decides (the §-rules are their
                call; we make the numbers visible at the moment that counts). */}
            {summary.shield === null && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                  <Icon name="AlertTriangle" size={13} />
                  {t("shieldUnavailableTitle", "Hour warnings couldn't be checked")}
                </div>
                <p className="text-[12px] text-amber-800 dark:text-amber-300 leading-snug mt-0.5">
                  {t(
                    "shieldUnavailableBody",
                    "You can still publish — this just means the 48-hour and 11-hour checks didn't run this time.",
                  )}
                </p>
              </div>
            )}
            {(summary.shield || []).length > 0 && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                  <Icon name="AlertTriangle" size={13} />
                  {t("shieldPublishHeading", "Check before you publish")}
                </div>
                {summary.shield.slice(0, 6).map((w, i) => (
                  <p key={i} className="text-[12px] text-amber-800 dark:text-amber-300 leading-snug">
                    {w.kind === "cap" &&
                      t("shieldWarnCap", "{name}: {hours} — over the contract cap of {cap}/week")
                        .replace("{name}", w.name).replace("{hours}", fmtWarnHours(w.hours)).replace("{cap}", fmtWarnHours(w.cap))}
                    {w.kind === "dk48" &&
                      t("shieldWarnDk48", "{name}: {hours} — over the 48h weekly ceiling")
                        .replace("{name}", w.name).replace("{hours}", fmtWarnHours(w.hours))}
                    {w.kind === "month" &&
                      t("shieldWarnMonth", "{name}: {hours} in {period} — over the monthly limit of {cap}")
                        .replace("{name}", w.name).replace("{hours}", fmtWarnHours(w.hours))
                        .replace("{period}", w.period || t("shieldMonthWord", "Month")).replace("{cap}", fmtWarnHours(w.cap))}
                    {w.kind === "rest" &&
                      t("shieldWarnRest", "{name}: only {gap} rest between two shifts (11h rule)")
                        .replace("{name}", w.name).replace("{gap}", fmtWarnHours(w.gap))}
                  </p>
                ))}
                {summary.shield.length > 6 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    +{summary.shield.length - 6} {t("shieldWarnMore", "more — see the hour chips on the grid")}
                  </p>
                )}
              </div>
            )}

            {/* Honest notify note — no count promised here; the success
                banner reports the server's real number after publish. */}
            <div className="flex items-start gap-2 rounded-lg bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] px-3 py-2.5">
              <Icon name="Mail" size={15} className="text-gray-400 dark:text-gray-500 mt-0.5 shrink-0" />
              <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                {t(
                  "publishNotifyNote",
                  "Staff whose shifts changed get an email (and a push if they've opened their portal).",
                )}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Actions — OUTSIDE the scroller, so Udgiv uge is on screen from the
          moment the sheet opens no matter how many Shield warnings are above
          it. pb uses the home-indicator inset on a phone. */}
      <div
        className="shrink-0 flex justify-end gap-2 px-5 py-3 sm:px-6 border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}
      >
          {done ? (
            toldNobody && onShare ? (
              /* Published, and not one person was told. "Done" must not be the
                 only thing on offer here — the whole failure this sheet now
                 reports is that the week is sitting in the database where no
                 staffer can see it. Share week is the action; Done demotes to
                 secondary but stays, because the publish itself did succeed. */
              <>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  {t("publishDone", "Done")}
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onShare}
                  iconLeft={<Icon name="Share2" size={14} />}
                >
                  {t("schedHandoffButton", "Share week")}
                </Button>
              </>
            ) : (
              <Button variant="accent" size="sm" onClick={onClose} iconLeft={<Icon name="Check" size={14} />}>
                {t("publishDone", "Done")}
              </Button>
            )
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {nothing ? t("close", "Close") : t("cancel", "Cancel")}
              </Button>
              {!nothing && (
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onConfirm}
                  busy={publishing}
                  iconLeft={<Icon name="Send" size={14} />}
                >
                  {t("publishConfirmCta", "Publish Week")}
                </Button>
              )}
            </>
          )}
      </div>
    </Sheet>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHIFT MODAL
   ═══════════════════════════════════════════════════════════ */
/**
 * ShiftModal — add / edit one shift.
 *
 * Exported (named) for the same reason MobileSchedule and ScheduleGrid are:
 * the viewport finding (an uncapped dialog with no scroller, so the title
 * clips and Tilføj vagt sits below the fold) can only be pinned down as DOM,
 * and this is the only way to mount the real thing without 6k lines of page
 * around it.
 *
 * ROUTES IN, so the fix is re-checked where an owner actually meets it: the
 * toolbar "+ Tilføj" (add mode, on screen at every width) and a tap on an
 * OCCUPIED cell (edit mode). Tapping an EMPTY cell does NOT open this dialog —
 * it blooms a seeded draft inline (see bloomDraft) — so any report that
 * reproduces through an empty cell is describing a path that does not exist.
 */
export function ShiftModal({ modal, staff, shifts = [], weekDates, lastTemplate, onTemplateSave, onClose, onSaved, branchId }) {
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const roles = rolesFor(user?.business_type);
  const existingShift = modal.shift;
  const isEdit = !!existingShift;

  /* Smart defaults (audit #248 P0): owners shouldn't re-type 16:00–23:00 +
     break + role on every cell. Seed precedence for a NEW shift:
       1. The selected staff's most-recent shift THIS week (their pattern).
       2. The last shift the owner saved this session (run of similar shifts).
       3. Hard fallback 16:00–23:00, no break, member's default role.
     Edit mode always uses the shift's own values. */
  const seed = useMemo(() => {
    if (existingShift) {
      return {
        start: existingShift.start_time,
        end: existingShift.end_time,
        break_minutes: existingShift.break_minutes || 0,
        role: existingShift.role_on_shift || null,
      };
    }
    const r = mostRecentShiftFor(shifts, modal.staffId);
    if (r) return { start: r.start_time, end: r.end_time, break_minutes: r.break_minutes || 0, role: r.role_on_shift || null };
    if (lastTemplate?.start && lastTemplate?.end) return { ...lastTemplate };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [staffId, setStaffId] = useState(modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id || "");
  const [date, setDate] = useState(modal.date || (existingShift?.date) || toISO(weekDates[0]));
  const [startHour, setStartHour] = useState(() => (seed?.start ? seed.start.slice(0, 2) : "16"));
  const [startMin, setStartMin] = useState(() => (seed?.start ? seed.start.slice(3, 5) : "00"));
  const [endHour, setEndHour] = useState(() => (seed?.end ? seed.end.slice(0, 2) : "23"));
  const [endMin, setEndMin] = useState(() => (seed?.end ? seed.end.slice(3, 5) : "00"));
  const [breakMinutes, setBreakMinutes] = useState(
    () => seed?.break_minutes ?? suggestedBreak(seed?.start || "16:00", seed?.end || "23:00")
  );
  const [roleOnShift, setRoleOnShift] = useState(() => {
    if (seed?.role) return roleToShiftOption(seed.role, roles);
    const member = staff.find((s) => s.id === (modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id));
    return roleToShiftOption(member?.role, roles);
  });
  const [notes, setNotes] = useState(existingShift?.notes || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modalError, setModalError] = useState("");
  // True once the owner edits any time/break field — stops auto re-seeding
  // on staff change so we never clobber a value they typed themselves.
  const [touched, setTouched] = useState(false);
  // Same staff + same calendar day in the PREVIOUS week, fetched lazily so
  // the "Last week" quick-fill can mirror a recurring rota. null = none.
  const [prevWeekShift, setPrevWeekShift] = useState(null);

  // When the owner picks a DIFFERENT staff in Add mode: default the role to
  // that member's role, and (unless they've touched the form) re-seed the
  // times from that staff's most recent shift this week.
  const prevStaffRef = useRef(staffId);
  useEffect(() => {
    if (isEdit) return;
    const changed = prevStaffRef.current !== staffId;
    prevStaffRef.current = staffId;
    if (!staffId) return;
    const member = staff.find((s) => s.id === staffId);
    if (member?.role) setRoleOnShift(roleToShiftOption(member.role, roles));
    if (!changed || touched) return;
    const r = mostRecentShiftFor(shifts, staffId);
    if (r) {
      setStartHour(r.start_time.slice(0, 2));
      setStartMin(r.start_time.slice(3, 5));
      setEndHour(r.end_time.slice(0, 2));
      setEndMin(r.end_time.slice(3, 5));
      setBreakMinutes(r.break_minutes || 0);
      if (r.role_on_shift) setRoleOnShift(r.role_on_shift);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId]);

  // Lazily fetch the same staff + same calendar day last week for "Last week".
  useEffect(() => {
    if (isEdit || !staffId || !date) { setPrevWeekShift(null); return; }
    let cancelled = false;
    const prevSameDay = new Date(date);
    prevSameDay.setDate(prevSameDay.getDate() - 7);
    const prevISO = toISO(prevSameDay);
    const params = { week_start: toISO(getWeekStart(prevSameDay)) };
    if (branchId) params.branch_id = branchId;
    api.get("/staff/schedules", { params })
      .then((res) => {
        if (cancelled) return;
        const match = (res.data || []).find(
          (s) => String(s.date) === prevISO && shiftBelongsTo(s, staffId) && s.start_time && s.end_time
        );
        setPrevWeekShift(match || null);
      })
      .catch(() => { if (!cancelled) setPrevWeekShift(null); });
    return () => { cancelled = true; };
  }, [staffId, date, isEdit, branchId]);

  // Apply a template shift (quick-fill chip) to the time/break/role fields.
  // User-initiated → mark touched so staff-change re-seeding stays out.
  const applyTemplate = (s) => {
    if (!s?.start_time || !s?.end_time) return;
    setStartHour(s.start_time.slice(0, 2));
    setStartMin(s.start_time.slice(3, 5));
    setEndHour(s.end_time.slice(0, 2));
    setEndMin(s.end_time.slice(3, 5));
    setBreakMinutes(s.break_minutes || 0);
    if (s.role_on_shift) setRoleOnShift(s.role_on_shift);
    setTouched(true);
  };

  const startTime = `${startHour}:${startMin}`;
  const endTime = `${endHour}:${endMin}`;
  const previewHours = calcHours(startTime, endTime, breakMinutes);

  const recentForStaff = useMemo(() => (isEdit ? null : mostRecentShiftFor(shifts, staffId)), [staffId, shifts, isEdit]);
  // arbejdstidsloven: a break is expected for shifts over 6h. Suggest 30 min
  // when none is set — one tap, fully overridable.
  const BREAK_SUGGEST = 30;
  const showBreakSuggest = previewHours >= 6 && (Number(breakMinutes) || 0) === 0;

  const handleSave = async () => {
    if (!staffId) {
      setModalError(t("shiftSelectStaffError", "Please select a staff member."));
      return;
    }
    if (!date) {
      setModalError(t("shiftSelectDateError", "Please select a date."));
      return;
    }

    setSaving(true);
    setModalError("");

    const payload = {
      staff_id: staffId,
      date,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes || 0,
      role_on_shift: roleOnShift,
      notes: notes.trim() || undefined,
      branch_id: branchId || undefined,
    };

    try {
      if (isEdit) {
        await api.put(`/staff/schedules/${existingShift.id}`, payload);
      } else {
        await api.post("/staff/schedules", payload);
      }
      // Remember this shift so the next "Add" pre-fills from it.
      onTemplateSave?.({ start: startTime, end: endTime, break_minutes: breakMinutes || 0, role: roleOnShift });
      onSaved();
    } catch (err) {
      const d = err.response?.data?.detail;
      const fallbackMsg = isEdit
        ? t("shiftUpdateFailed", "Failed to update shift.")
        : t("shiftCreateFailed", "Failed to create shift.");
      if (err.response?.status === 409 && d?.code === "shift_overlap") {
        setModalError(t("schedSlotTaken", "That overlaps a shift they already have that day."));
      } else {
        // errText safely coerces string / 422-array / {code,message} detail to a
        // string (never the raw object → no React-child crash).
        setModalError(errText(err, fallbackMsg));
      }
    }
    setSaving(false);
  };

  // Two-step delete: the "Delete Shift" button flips an in-modal confirm
  // (setConfirmDelete) instead of a native window.confirm() — consistent with
  // the rest of BonBox's dialogs, and (unlike the OS popup) actually testable.
  const handleDelete = async () => {
    if (!existingShift?.id) return;
    setDeleting(true);
    setModalError("");
    try {
      await api.delete(`/staff/schedules/${existingShift.id}`);
      onSaved(); // closes the modal on success
    } catch (err) {
      setModalError(errText(err, t("shiftDeleteFailed", "Failed to delete shift.")));
      setDeleting(false);
    }
  };

  // Date options for the dropdown: all 7 days of the current week
  const dateOptions = weekDates.map((d) => ({
    value: toISO(d),
    label: `${dayShort(d.getDay() === 0 ? 6 : d.getDay() - 1, t)} ${d.getDate()}/${d.getMonth() + 1}`,
  }));

  const title = isEdit ? t("shiftEditTitle", "Edit Shift") : t("shiftAddTitle", "Add Shift");

  return (
    // Container swap ONLY — every field below is the one that shipped. Sheet
    // supplies the phone bottom sheet (max-h-[92dvh]), the flex column, the
    // portal, Escape, scroll lock and the focus trap; this file supplies the
    // three rows: fixed header, scrolling body, pinned footer.
    <Sheet
      onClose={onClose}
      zClassName="z-50"
      ariaLabel={title}
      panelClassName="bg-white dark:bg-gray-800 shadow-sm border-t sm:border border-gray-200 dark:border-gray-700"
    >
      {/* pt-4 on a phone: Sheet used to open with a grab bar whose padding was
          standing in for this header's top margin, and that bar was a dead
          affordance (nothing drags it). The spacing belongs here, stated. */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 pt-4 pb-3 sm:px-6 sm:pt-5">
        {/* 16px, not text-lg: 18px is off the locked ramp. */}
        <h2 className="text-[16px] font-semibold text-gray-900 dark:text-white">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close", "Close")}
          className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-colors"
        >
          <Icon name="X" size={20} />
        </button>
      </div>

      {/* The one scrolling region. Everything that used to push Tilføj vagt
          off the bottom of the screen now scrolls inside this box instead. */}
      <div data-sheet-body="" className="flex-1 overflow-y-auto px-5 pb-4 space-y-4 sm:px-6">
        {modalError && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
            {modalError}
          </div>
        )}

        {/* Staff member */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("staffMember")}</label>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            <option value="">{t("selectStaff")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role})
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftDateLabel", "Date")}</label>
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {dateOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Quick-fill chips (Add mode) — one tap to reuse this staff's most
            recent shift or their shift from the same day last week. Kills the
            "re-type every time" friction the audit flagged. */}
        {!isEdit && (recentForStaff || prevWeekShift) && (
          <div className="flex items-center gap-2 flex-wrap -mt-1">
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{t("shiftQuickFill", "Quick fill")}:</span>
            {recentForStaff && (
              <button
                type="button"
                onClick={() => applyTemplate(recentForStaff)}
                title={t("shiftCopyRecentTitle", "Use this staff member's most recent shift this week")}
                className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition"
              >
                {t("shiftCopyRecent", "Latest shift")} · {formatShiftTime(recentForStaff.start_time, recentForStaff.end_time)}
              </button>
            )}
            {prevWeekShift && (
              <button
                type="button"
                onClick={() => applyTemplate(prevWeekShift)}
                title={t("shiftSameLastWeekTitle", "Use the same shift from last week")}
                className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                {t("shiftSameLastWeek", "Last week")} · {formatShiftTime(prevWeekShift.start_time, prevWeekShift.end_time)}
              </button>
            )}
          </div>
        )}

        {/* Time selectors */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("startTime")}</label>
            <div className="flex gap-1">
              <select
                value={startHour}
                onChange={(e) => { setStartHour(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={startMin}
                onChange={(e) => { setStartMin(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("endTime")}</label>
            <div className="flex gap-1">
              <select
                value={endHour}
                onChange={(e) => { setEndHour(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={endMin}
                onChange={(e) => { setEndMin(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Break + Role */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftBreakLabel", "Break (minutes)")}</label>
            <input
              type="number"
              value={breakMinutes}
              onChange={(e) => { setBreakMinutes(e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value) || 0)); setTouched(true); }}
              min="0"
              max="120"
              step="5"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
            />
            {/* arbejdstidsloven nudge — a break is expected for 6h+ shifts.
                One tap to add 30 min; fully overridable. */}
            {showBreakSuggest && (
              <button
                type="button"
                onClick={() => { setBreakMinutes(BREAK_SUGGEST); setTouched(true); }}
                title={t("shiftBreakHint", "Recommended for shifts over 6 hours")}
                className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                + {t("shiftBreakSuggest", "Add {n} min break").replace("{n}", BREAK_SUGGEST)}
              </button>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("roleOnShift")}</label>
            <select
              value={roleOnShift}
              onChange={(e) => setRoleOnShift(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
            >
              {roles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
          {t("shiftPreview", "Shift: {start} \u2013 {end} ({hours} net)")
            .replace("{start}", startTime)
            .replace("{end}", endTime)
            .replace("{hours}", formatShiftHours(previewHours, lang))}
          {breakMinutes > 0 && " " + t("shiftPreviewBreak", "with {n}min break").replace("{n}", breakMinutes)}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftNotesLabel", "Notes (optional)")}</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("shiftNotesPlaceholder", "e.g. Training, covering for Anna...")}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>
      </div>

      {/* Pinned footer. The whole point of the port: Tilføj vagt / Opdater
          vagt is ALWAYS on screen, whatever the form does above it, and sits
          clear of the home indicator on a notched phone. */}
      <div
        data-sheet-footer=""
        className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95 backdrop-blur px-5 pt-3 sm:px-6"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        {confirmDelete ? (
          /* In-app delete confirmation — replaces the native window.confirm()
             so it matches BonBox's dialog style and is automatable/testable. */
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-200">
              {t("shiftDeleteConfirm", "Delete this shift?")}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
              >
                {t("cancel", "Cancel")}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50"
              >
                {deleting ? t("shiftDeleting", "Deleting...") : t("shiftDeleteBtn", "Delete Shift")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              {isEdit && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50"
                >
                  {t("shiftDeleteBtn", "Delete Shift")}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                {t("cancel", "Cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
              >
                {saving ? t("shiftSaving", "Saving...") : isEdit ? t("shiftUpdateBtn", "Update Shift") : t("shiftAddTitle", "Add Shift")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
