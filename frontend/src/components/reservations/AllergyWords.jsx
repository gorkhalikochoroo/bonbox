/**
 * Allergies said in WORDS on the book, never by colour alone (R11, rubric B8).
 *
 * Before: the phone row and the stand showed a small triangle — red when
 * severe, amber otherwise — and the guest's note in that colour. "Alvorlig"
 * existed only as a colour, and allergens ticked without a note were not on
 * the phone row at all (20 Oct walk, T9). A host who cannot tell red from
 * amber, or reads the iPad in a dim room, had nothing to go on.
 *
 * Now every row says it before the note: an icon, the severity as a word, the
 * allergens from the fixed list, then the guest's own note:
 *
 *     ⬣ Alvorlig · Jordnødder, Trænødder · Min søn kan ikke tåle nødder
 *     ▲ Intolerans · Gluten (korn)
 *     ? Mulig allergi · Gluten (korn)        ← the AI's unconfirmed reading
 *
 * Severe also differs by SHAPE wherever only an icon fits (the flags column,
 * a timeline bar, a floor tile): an octagon, never the triangle the other
 * levels use.
 *
 * The guest's note is shown through guestText (links defanged for display)
 * and is never altered or stored back (gotcha_never_alter_guest_text).
 */
import { AlertTriangle, HelpCircle, OctagonAlert } from "lucide-react";
import { guestText } from "../../utils/guestText";
import { allergyFacts, allergySentence, allergyTone, allergyWord } from "../../utils/allergyWords";

/**
 * The icon alone: an octagon for severe, a question mark for the AI's
 * possible allergy, a triangle for everything else. Colour comes from the
 * caller's className, so a cancelled row can grey it.
 */
export function AllergyIcon({ level, className = "w-3.5 h-3.5", ...rest }) {
  const Icon = level === "severe" ? OctagonAlert : level === "possible" ? HelpCircle : AlertTriangle;
  return <Icon className={className} data-allergy-icon={level === "severe" ? "severe" : level === "possible" ? "possible" : "allergy"} {...rest} />;
}

/**
 * One line: icon + word + allergens + the guest's note. Truncates on one
 * line by default (`wrap` lets it wrap on a roomy screen). Nothing when the
 * booking carries no allergy.
 */
export default function AllergyLine({ r, t, className = "", wrap = false, cancelled = false }) {
  const f = allergyFacts(r);
  if (!f.level) return null;
  const names = f.tags.map((k) => t(`allergen_${k}`, k)).join(", ");
  const note = guestText(f.note);
  const sentence = allergySentence(r, t);
  return (
    <div
      className={
        "flex items-center gap-1 min-w-0 text-[12px] leading-snug " + allergyTone(f.level, cancelled) + " " + className
      }
      title={sentence}
      data-allergy-line=""
      data-allergy-level={f.level}
    >
      <AllergyIcon
        level={f.level}
        className={"w-3.5 h-3.5 shrink-0" + (f.level === "possible" && !cancelled ? " opacity-90" : "")}
        aria-hidden
      />
      <span className={"min-w-0 " + (wrap ? "whitespace-normal break-words" : "truncate")}>
        <span className="font-semibold">{allergyWord(f.level, t)}</span>
        {names ? <span>{" · "}{names}</span> : null}
        {note ? <span className="font-normal">{" · "}{note}</span> : null}
      </span>
    </div>
  );
}
