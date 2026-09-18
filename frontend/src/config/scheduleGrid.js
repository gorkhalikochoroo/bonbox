/**
 * scheduleGrid.js — the owner Vagtplan grid's pure model.
 *
 * WHY THIS IS A MODULE AND NOT LOCAL TO StaffSchedulePage.jsx
 *
 * StaffSchedulePage is ~6.4k lines and mounting it in a test drags in dnd-kit,
 * the auth/branch/entitlement providers and six network calls. So the parts of
 * the Option-B grid that can actually be WRONG — the day tally that colours a
 * column's status dot, the section grouping gate, the "seen by staff" read —
 * live here as plain functions with no React in them, and scheduleGrid.test.js
 * pins them. (eslint react-refresh/only-export-components is the other half of
 * the reason: a page module may export components, not helpers.)
 *
 * Nothing here formats or paints. Class names that ARE here (DAY_DOT_CLASS) are
 * the ones a test must be able to assert, because the dot's colour IS the
 * claim: amber says "not sent yet", emerald says "they have all seen it", and
 * getting those two the wrong way round is the kind of bug an owner acts on.
 */

import { hasSections, sectionFor, SECTION_META } from "./roleSections";

/** The grid's own bucket for a role this vertical has no section for. NOT a
 *  section — sectionFor() never returns it. Always ordered last. */
export const OTHER_SECTION = "other";

/** Staff contract type. The labels are i18n keys (Fuldtid/Deltid/Studerende),
 *  not literals: this used to be a `label: "Full-time"` string that rendered
 *  English inside an otherwise-Danish staff drawer. */
export const CONTRACT_TYPES = [
  { value: "full", labelKey: "contractFull", fallback: "Full-time" },
  { value: "part", labelKey: "contractPart", fallback: "Part-time" },
  { value: "student", labelKey: "contractStudent", fallback: "Student" },
  { value: "freelance", labelKey: "contractFreelance", fallback: "Freelance" },
];

/** contract_type → localized label. Returns "" for a missing value so callers
 *  can render `label && <chip>` — an EMPTY chip is worse than no chip. A value
 *  we don't know (older row, hand-edited) renders itself rather than vanishing. */
export function contractLabel(value, t) {
  if (!value) return "";
  const hit = CONTRACT_TYPES.find((c) => c.value === value);
  return hit ? t(hit.labelKey, hit.fallback) : String(value);
}

/**
 * "Has the staffer's acknowledgement been seen, and does it still apply?"
 *
 * SHARED CONTRACT with the backend: `confirmed_current` is a computed boolean
 * meaning the acknowledgement still applies to the shift AS IT NOW STANDS — an
 * owner who moves a published shift two hours later has a confirmed_at that is
 * now about a different shift. `??` (not `||`) is load-bearing twice: it keeps
 * an explicit `false` from falling through to the stale timestamp, and it keeps
 * this correct on every client running BEFORE the backend ships the field.
 */
export function isSeenByStaff(shift) {
  if (!shift) return false;
  return shift.confirmed_current ?? !!shift.confirmed_at;
}

/**
 * One day column's rollup across the whole roster.
 * { total, drafts, pub, seen } — pub/seen count PUBLISHED shifts only, because
 * a draft has not been sent and so cannot have been seen. Counting a draft as
 * "unseen" would paint a column the owner has not finished writing as if staff
 * were ignoring it.
 */
export function tallyDay(shifts) {
  let total = 0;
  let drafts = 0;
  let pub = 0;
  let seen = 0;
  for (const s of shifts || []) {
    if (!s) continue;
    total += 1;
    if (s.status === "draft") {
      drafts += 1;
    } else if (s.status === "published") {
      pub += 1;
      if (isSeenByStaff(s)) seen += 1;
    }
  }
  return { total, drafts, pub, seen };
}

/**
 * Which of the four states the day-header dot is in.
 *   "none"    — no shifts at all (no dot; the count renders gray)
 *   "draft"   — anything unsent outranks everything else: it is the only state
 *               that asks the owner to DO something
 *   "seen"    — every published shift has been acknowledged
 *   "neutral" — published, not everyone has looked yet. Silence, not alarm:
 *               staff have hours to read a rota and amber here would cry wolf
 *               every Monday morning.
 */
export function dayDotTone(tally) {
  if (!tally || tally.total === 0) return "none";
  if (tally.drafts > 0) return "draft";
  if (tally.pub > 0 && tally.seen === tally.pub) return "seen";
  return "neutral";
}

export const DAY_DOT_CLASS = {
  draft: "bg-amber-500",
  seen: "bg-emerald-500",
  neutral: "bg-gray-300 dark:bg-gray-600",
};

/**
 * The whole sentence behind the dot — goes in BOTH `title` and an sr-only span.
 * A 6px coloured dot is not information to a screen reader, and it is barely
 * information to a sighted owner who has not learned the key yet.
 */
export function dayTallyText(tally, t) {
  const tone = dayDotTone(tally);
  if (tone === "none") return t("schedDayNoShifts", "No shifts this day");
  if (tone === "draft") {
    return (t("schedDayDrafts", "{d} of {n} are still drafts") || "")
      .replace("{d}", String(tally.drafts))
      .replace("{n}", String(tally.total));
  }
  if (tone === "seen") return t("schedDayAllSeen", "Everyone has seen their shift");
  // Neutral with nothing published at all is a shape we don't expect (a status
  // that is neither draft nor published). Say the honest thing — the count —
  // rather than "0 of 0 have seen their shift".
  if (tally.pub === 0) {
    return (t("schedDayShiftCount", "{n} shifts this day") || "").replace("{n}", String(tally.total));
  }
  return (t("schedDaySeen", "{s} of {p} have seen their shift") || "")
    .replace("{s}", String(tally.seen))
    .replace("{p}", String(tally.pub));
}

function sectionOrder(id) {
  if (id === OTHER_SECTION) return 99;
  return SECTION_META[id]?.order ?? 98;
}

/**
 * groupStaffBySection(staff, businessType)
 *   → { grouped: false, sections: [] }              render today's single body
 *   → { grouped: true, sections: [{ id, members }] } one <tbody> per section
 *
 * THE GATE IS THE DESIGN. Sections earn their headers; they do not get them by
 * default:
 *   • the vertical must HAVE sections at all (retail/services/personal do not —
 *     inventing "Gulv" for a two-person shop is vocabulary theatre),
 *   • at least TWO real sections must be populated (a roster that is all Gulv
 *     gets one header saying "Gulv" above every row it already labelled), and
 *   • at least four staff (three people do not need chapter headings).
 * Below the gate the grid is byte-identical to what it is today.
 *
 * Uses the RAW sectionFor(), never the grid's `|| "floor"` fallback: filing a
 * café's unknown role under Gulv is exactly the lie that fallback tells, and a
 * section HEADER makes it a loud one. Unknowns go to `other`, ordered last.
 */
export function groupStaffBySection(staff, businessType) {
  const list = Array.isArray(staff) ? staff : [];
  const flat = { grouped: false, sections: [] };
  if (!hasSections(businessType) || list.length < 4) return flat;

  const buckets = new Map();
  for (const m of list) {
    const id = sectionFor(m?.role, businessType) || OTHER_SECTION;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(m);
  }
  // "Populated sections" counts REAL sections. A roster of 5 Gulv + 1 DJ is one
  // section and a stray, not two groups worth of chrome.
  const realSections = [...buckets.keys()].filter((id) => id !== OTHER_SECTION);
  if (realSections.length < 2) return flat;

  const sections = [...buckets.entries()]
    .map(([id, members]) => ({ id, members }))
    .sort((a, b) => sectionOrder(a.id) - sectionOrder(b.id));
  return { grouped: true, sections };
}
