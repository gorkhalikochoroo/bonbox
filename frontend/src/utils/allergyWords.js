// Allergies in WORDS (R11, rubric B8) — the pure part, shared by the book's
// rows (components/reservations/AllergyWords.jsx), the floor tile and the
// timeline. See that component for the why.
import { guestText } from "./guestText";

/** A recorded allergy on the booking (tags, a note or a severity). */
export function hasRecordedAllergy(r) {
  return !!r && (
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity
  );
}

/**
 * What the row says about allergies:
 *   level — "severe" | "intolerance" | "preference" | "allergy" (recorded,
 *           no level) | "possible" (only the AI's unconfirmed reading) | null
 *   tags  — allergen keys (the fixed list); note — the guest's own words.
 */
export function allergyFacts(r) {
  if (!r) return { level: null, tags: [], note: "" };
  if (hasRecordedAllergy(r)) {
    const sev = r.allergy_severity;
    return {
      level: sev === "severe" || sev === "intolerance" || sev === "preference" ? sev : "allergy",
      tags: Array.isArray(r.allergen_tags) ? r.allergen_tags.filter(Boolean) : [],
      note: r.allergy_note || "",
    };
  }
  const ai = r.ai_allergy;
  if (ai && ai.has_ai_suggested_allergy) {
    return { level: "possible", tags: Array.isArray(ai.ai_tags) ? ai.ai_tags.filter(Boolean) : [], note: "" };
  }
  return { level: null, tags: [], note: "" };
}

/** The level as a word ("Alvorlig", "Intolerans", "Allergi", "Mulig allergi"). */
export function allergyWord(level, t) {
  if (level === "severe") return t("rsvpSevSevere", "Severe");
  if (level === "intolerance") return t("rsvpSevIntolerance", "Intolerance");
  if (level === "preference") return t("rsvpSevPreference", "Preference");
  if (level === "possible") return t("rsvpAllergyPossible", "Possible allergy");
  return t("rsvpAllergyFlag", "Allergy");
}

/** The full sentence a screen reader (and a title tooltip) gets. */
export function allergySentence(r, t) {
  const f = allergyFacts(r);
  if (!f.level) return "";
  const names = f.tags.map((k) => t(`allergen_${k}`, k)).join(", ");
  const head = f.level === "severe" ? t("rsvpAllergySevere", "Severe allergy") : allergyWord(f.level, t);
  return [head, names, guestText(f.note)].filter(Boolean).join(" · ");
}

/** The row's colour for a level (text); cancelled rows read grey. */
export function allergyTone(level, cancelled = false) {
  if (cancelled) return "text-gray-500 dark:text-gray-400";
  if (level === "severe") return "text-red-700 dark:text-red-400";
  return "text-amber-800 dark:text-amber-300";
}

