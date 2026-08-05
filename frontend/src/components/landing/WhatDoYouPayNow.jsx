/**
 * "Hvad betaler du nu?" — the owner's own arithmetic, not our claim.
 *
 * WHY THIS SHAPE
 * The obvious version of this section is a comparison table with
 * competitors' prices in it. We deleted one of those from the pricing FAQ
 * (it quoted Dinero's May prices against our founding discount) and are
 * not building another. Every competitor number available is either
 * foreign-currency and term-tiered or simply not published, so a table
 * would go stale with nobody touching it — the exact failure this site
 * was publicly caught on.
 *
 * So we assert nothing about anyone else. The owner types what THEY pay.
 * The only number we contribute is our own, and it is fetched from
 * /billing/plans rather than hardcoded, so it cannot drift from what
 * Stripe actually charges.
 *
 * RULES THIS COMPONENT MUST KEEP
 *  1. Fields start EMPTY. No placeholder amounts, no "fx 1.200 kr" — a
 *     suggested number is a claim about the market wearing a disguise.
 *  2. The result must be able to say we are MORE expensive, in the same
 *     voice as when we are cheaper. A calculator that can only produce
 *     one answer is an advert with a text box.
 *  3. Nothing leaves the browser. No fetch of inputs, no analytics event
 *     carrying values, no localStorage. The inputs are a stranger's
 *     supplier costs; we have no business collecting them.
 *  4. POS and bookkeeping are excluded, and the copy says so. BonBox is
 *     not a registered bogføringssystem and does not replace either, so
 *     counting them would inflate the difference dishonestly.
 */
import { useEffect, useRef, useState } from "react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";

// Fallback only for the seconds before /billing/plans answers, and for the
// case where it never does. Kept equal to config.py PLAN_PRICES_DKK so a
// stale fallback cannot quietly understate our own price.
const STARTER_FALLBACK = 199;

function kr(n) {
  return new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(n);
}

/** Danish keyboards produce "1.200" and "1200,50"; both must parse. */
function parseKr(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function WhatDoYouPayNow() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [booking, setBooking] = useState("");
  const [perUser, setPerUser] = useState(false);
  const [staff, setStaff] = useState("");
  const [starter, setStarter] = useState(STARTER_FALLBACK);

  // Our own price, from the same table the checkout reads. If this call
  // fails we keep the fallback rather than render a blank — but we never
  // invent a number that is lower than what we charge.
  // A ref, not state: this is a "has it happened" latch and must not
  // cause a render. Once per mount, not once per toggle — collapsing and
  // reopening should not re-hit the API. Same reasoning as the embed
  // height guard: do not be chatty on a page you are a guest on.
  const fetched = useRef(false);
  useEffect(() => {
    if (!open || fetched.current) return;
    fetched.current = true;
    let alive = true;
    api
      .get("/billing/plans")
      .then((r) => {
        const v = r?.data?.plans?.starter?.regular;
        if (alive && Number.isFinite(v)) setStarter(v);
      })
      .catch(() => { /* keep the fallback; nothing to tell the visitor */ });
    return () => { alive = false; };
  }, [open]);

  const s = parseKr(schedule);
  const b = parseKr(booking);
  const headcount = perUser ? parseKr(staff) : null;
  const anyInput = s !== null || b !== null;

  // Per-user pricing multiplies the SCHEDULING line only — that is the
  // one commonly metered per employee. Applying the multiplier to the
  // booking line too would overstate their cost in our favour.
  const theirs = anyInput
    ? (s !== null ? (perUser && headcount ? s * headcount : s) : 0) + (b !== null ? b : 0)
    : null;

  const diff = theirs === null ? null : theirs - starter;
  const cheaper = diff !== null && diff > 0;
  const same = diff !== null && diff === 0;

  return (
    <div className="mt-10 max-w-2xl mx-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left text-[15px] font-medium text-gray-900 underline underline-offset-4 decoration-gray-300 hover:decoration-gray-900"
      >
        {t("landingCalcOpen", "Regn på dine egne tal")}
      </button>

      {open && (
        <div className="mt-4 rounded-xl border border-gray-200 p-5">
          <p className="text-[14px] text-gray-600 leading-[1.6]">
            {t(
              "landingCalcIntro",
              "Vi udfylder ikke felterne for dig, og vi gætter ikke på, hvad andre tager. Skriv dine egne tal. De bliver i din browser og bliver ikke sendt nogen steder.",
            )}
          </p>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="block text-[13px] text-gray-700">
                {t("landingCalcSchedule", "Hvad betaler du i dag for vagtplan? (kr./md.)")}
              </span>
              <input
                inputMode="decimal"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-[15px] tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </label>

            <label className="block">
              <span className="block text-[13px] text-gray-700">
                {t("landingCalcBooking", "Hvad betaler du i dag for bordbestilling? (kr./md.)")}
              </span>
              <input
                inputMode="decimal"
                value={booking}
                onChange={(e) => setBooking(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-[15px] tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={perUser}
                onChange={(e) => setPerUser(e.target.checked)}
                className="mt-1"
              />
              <span className="text-[13px] text-gray-700">
                {t("landingCalcPerUser", "Min pris for vagtplan ganges med antal ansatte")}
              </span>
            </label>

            {perUser && (
              <label className="block">
                <span className="block text-[13px] text-gray-700">
                  {t("landingCalcStaff", "Antal ansatte")}
                </span>
                <input
                  inputMode="numeric"
                  value={staff}
                  onChange={(e) => setStaff(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-[15px] tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </label>
            )}
          </div>

          <p className="mt-3 text-[12px] text-gray-500 leading-[1.5]">
            {t(
              "landingCalcExclude",
              "Tag ikke kassesystem og bogføringssystem med. Dem erstatter BonBox ikke, og dem beholder du.",
            )}
          </p>

          {theirs !== null && (
            <div className="mt-4 border-t border-gray-200 pt-4" role="status" aria-live="polite">
              <p className="text-[15px] text-gray-900 leading-[1.6]">
                {t("landingCalcYouWrote", "Du har skrevet {sum} kr./md.", { sum: kr(theirs) })}{" "}
                {t("landingCalcOurs", "BonBox Starter koster {p} kr./md. Der lægges ikke moms oven i.", {
                  p: kr(starter),
                })}
              </p>
              <p className="mt-2 text-[15px] font-medium text-gray-900">
                {same
                  ? t("landingCalcSame", "Det er det samme beløb.")
                  : cheaper
                    ? t("landingCalcCheaper", "Forskel: {d} kr./md. i din favør.", { d: kr(diff) })
                    : t("landingCalcPricier", "Så er BonBox {d} kr./md. dyrere for dig.", {
                        d: kr(Math.abs(diff)),
                      })}
              </p>
              <p className="mt-2 text-[13px] text-gray-500 leading-[1.55]">
                {cheaper
                  ? t(
                      "landingCalcFootCheaper",
                      "Regnet på dine tal, ikke på nogens listepriser. Tjek selv, hvad du betaler i dag — vi kan ikke se det.",
                    )
                  : t(
                      "landingCalcFootPricier",
                      "Det kan stadig give mening, hvis du får det hele ét sted i stedet for to abonnementer. Men du skal vide det, før du skifter.",
                    )}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
