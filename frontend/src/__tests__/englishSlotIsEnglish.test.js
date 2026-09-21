/**
 * The English string must be English.
 *
 * Nothing in the suite noticed that a Danish sentence had been pasted into the
 * EN slot: the key resolves, the string is real copy, the raw-key-leak guard
 * sees an entry, and the locked-terms guard only polices terms that must STAY
 * Danish. So an owner or a guest reading the product in English met:
 *
 *   • "Den valgte behandler er ikke ledig på det tidspunkt…"  on the public
 *     salon booking page — a guest who chose English, told in Danish that
 *     their stylist is busy;
 *   • "Send en SMS-påmindelse dagen før…" in reservation settings;
 *   • "{n} varer fulgt · {m} med forbrugshistorik" sitting directly beside the
 *     correctly translated "Items flagged", on one line, in one breath.
 *
 * WHAT THIS DOES NOT FLAG, because these are decisions and not defects:
 *   • the DK terms that stay Danish in every language — MOMS, SKAT,
 *     kasserapport, kreditnota, faktura, lønseddel, revisor, gavekort,
 *     vagtplan, kladde, khata, and the trade vocabulary the inventory and
 *     salon surfaces declare in their own headers (leverandør, lager,
 *     bestilling, behandler …). An English sentence built AROUND one of those
 *     is the house style, and rsvpErrStylist is the reference for it;
 *   • statutory text that cites a Danish law or authority (Bogføringsloven,
 *     Skattestyrelsen) — it is quoted, not translated;
 *   • short strings where the two languages genuinely coincide ("OK", "Email").
 *
 * The test is therefore not "does this look Danish" but "is this a Danish
 * SENTENCE" — detected by function words that carry no meaning of their own
 * and would never survive into English prose.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "hooks", "useLanguage.jsx"), "utf8");

const ENTRY = /^ {4}([A-Za-z0-9_]+): "((?:[^"\\]|\\.)*)",\s*$/gm;

/**
 * Danish function words. Grammar, not vocabulary — a Danish NOUN in an English
 * sentence is the house style; a Danish PREPOSITION means the sentence itself
 * was never translated. "for" and "i" are excluded: both are ordinary English.
 */
const DANISH_GRAMMAR =
  /\b(og|til|fra|med|ikke|kan|skal|din|dit|dine|som|når|hvis|af|på|er|det|den|men|eller|også|kun|ved|har|bliver|vælg|sendes|føj)\b/i;

/**
 * Keys where Danish in the English slot is deliberate. Each needs a reason —
 * this list is the record of those decisions, and adding to it should feel
 * like a decision rather than a way to get the test to pass.
 */
const DELIBERATE = new Map([
  ["landingV2BookingCtaDa", "the key name says Da — it is the Danish CTA by design"],
  ["landingV2BookingTimeLabelDa", "same — the key name says Da"],
  ["customersHowFooter", "cites CVR-registeret, Erhvervsstyrelsen and DAWA — Danish registries, quoted"],
  ["taxReadyToFile", "SKAT-facing wording; the tax surfaces stay Danish"],
  ["taxPdfEmailRevisorAria", "revisor-facing; the revisor surfaces stay Danish"],
  ["profileRevisorMovedNotice", "revisor-facing"],
  ["fakturaHowFooter", "quotes Bogføringsloven — statutory text is quoted, not translated"],
  ["mileageHowFooter", "cites Skattestyrelsen's rate and Bogføringsloven §11"],
  ["pillarGateGavekortTitle", "gavekort is a locked term and the sentence is two words around it"],
]);

describe("no Danish sentence sits in the English slot", () => {
  it("every EN string is either English, or a recorded decision", () => {
    const seen = new Set();
    const offenders = [];
    for (const [, key, value] of SOURCE.matchAll(ENTRY)) {
      if (seen.has(key)) continue; // the first definition is EN; later ones are other languages
      seen.add(key);
      if (DELIBERATE.has(key)) continue;
      if (value.length <= 12) continue; // "OK", "Email" — no room for grammar
      if (DANISH_GRAMMAR.test(value)) offenders.push(`${key}: "${value.slice(0, 90)}"`);
    }
    expect(
      offenders,
      `These render Danish to someone who chose English.\n` +
        `A Danish NOUN in an English sentence is the house style (see\n` +
        `rsvpErrStylist). A Danish sentence is an untranslated key.\n` +
        `If it is deliberate, add it to DELIBERATE with the reason:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the guard can actually see the EN table", () => {
    const seen = new Set();
    for (const [, key] of SOURCE.matchAll(ENTRY)) seen.add(key);
    expect(seen.size).toBeGreaterThan(5000);
  });
});
