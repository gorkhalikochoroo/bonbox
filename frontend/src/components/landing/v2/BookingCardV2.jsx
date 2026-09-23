/**
 * The public booking card — the LEFT column artifact of section
 * id="reservations" on the new landing page.
 *
 * This is a live miniature of the guest-facing /bistro page: the guest
 * picks a date, a party size and a time, and the footer button restates
 * exactly what they are about to book. The chips are real buttons and the
 * selection actually moves, so nothing here pretends to be interactive
 * without being interactive.
 *
 * The DA/EN pair is the public page's own language switch — the guest
 * page really is bilingual — so flipping it re-labels the card. Those
 * Danish strings are CONTENT of the demo, not UI chrome, which is why
 * both variants carry their own t() key.
 *
 * The floor plan that sits beside this card is a separate component
 * (components/landing/FloorPlan.jsx) and is deliberately not built here.
 *
 * Colours are stock Tailwind under the design's names: slate-900 is its
 * "ink", slate-200 its border, green-600 the confirmed time.
 */
import { useEffect, useState } from "react";
import { useLanguage } from "../../../hooks/useLanguage";
import { dateLocale } from "../../../utils/dateFormat";

/** Chip geometry differs per group in the design: 12 / 14 / 13 px inline. */
const CHIP_BASE =
  "rounded-[9px] py-2 text-[12.5px] leading-none transition-colors";
const CHIP_IDLE = "border border-slate-200 text-slate-900 hover:border-slate-300";
const CHIP_ON = "border border-transparent bg-slate-900 font-medium text-white";
const CHIP_TIME_ON = "border border-transparent bg-bb-green font-semibold text-white";

const PARTY_SIZES = [1, 2, 3, 4, 5, 6];
const TIMES = ["18:15", "18:30", "18:45", "19:00", "19:15"];

export default function BookingCardV2() {
  const { t, lang } = useLanguage();
  // The demo opens in whatever language the visitor is reading the site in.
  // It used to hard-code "en", so the Danish landing page showed an English
  // booking card — "Pick a date", "Party size", "No account needed" were the
  // only English left on the page. The DA/EN switch below still works; it is
  // the public page's own control, and a visitor toggling it keeps their
  // choice until the site language itself changes.
  const demoLang = lang === "da" ? "da" : "en";
  const [cardLang, setCardLang] = useState(demoLang);
  useEffect(() => {
    setCardLang(demoLang);
  }, [demoLang]);
  const [dateIdx, setDateIdx] = useState(0);
  const [party, setParty] = useState(2);
  const [time, setTime] = useState("19:00");

  const da = cardLang === "da";

  // THE NEXT FOUR REAL DAYS, not four strings frozen in July.
  //
  // These were hardcoded ("Mon 27 Jul", "Tue 28"...), so by late September the
  // booking demo on the front page offered tables two months in the PAST. To a
  // prospect that does not read as demo data, it reads as a product nobody has
  // touched since summer — on the one widget whose entire job is to look live.
  //
  // HeroV2 already hit this and fixed it for the greeting date; its comment
  // says the preview "aged into a screenshot of a product nobody had touched
  // in weeks". Same defect, same folder, one component over. The figures in
  // this card stay invented and the caption says so — the DATES are the frame
  // around them, and today is the only honest frame.
  //
  // Same reasoning as HeroV2 for not memoising: dateLocale() reads the stored
  // language rather than taking it as an argument, so a memo would either look
  // like a missing dependency or freeze the dates in the previous language.
  const dates = (() => {
    const loc = da ? "da-DK" : dateLocale();
    const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
    const part = (d, opts) => {
      try {
        return new Intl.DateTimeFormat(loc, opts).format(d).replace(/\.$/, "");
      } catch {
        return "";
      }
    };
    const out = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      // Composed from PARTS rather than one format call. Asking Intl for
      // weekday+day together in Danish yields "tors. den 24." — the locale's
      // own pattern inserts "den", which is correct prose and wrong for a
      // chip. The frozen strings these replace read "Tir 28" / "Tue 28", and
      // that shape is what fits.
      const wd = cap(part(d, { weekday: "short" }));
      const day = d.getDate();
      const mon = i === 0 ? part(d, { month: "short" }) : "";
      const dayStr = da ? `${day}.` : `${day}`;
      out.push([wd, dayStr, mon].filter(Boolean).join(" "));
    }
    return out;
  })();

  const copy = da
    ? {
        eyebrow: t("landingV2BookingEyebrowDa", "Bestil bord"),
        dateLabel: t("landingV2BookingDateLabelDa", "Vælg en dato"),
        partyLabel: t("landingV2BookingPartyLabelDa", "Antal gæster"),
        timeLabel: t("landingV2BookingTimeLabelDa", "Vælg et tidspunkt"),
        service: t("landingV2BookingServiceDa", "Aften"),
        cta: t("landingV2BookingCtaDa", "Book {time} til {party}", {
          time,
          party,
        }),
        note: t(
          "landingV2BookingNoteDa",
          "Ingen konto nødvendig · Gratis afbestilling",
        ),
      }
    : {
        eyebrow: t("landingV2BookingEyebrow", "Book a table"),
        dateLabel: t("landingV2BookingDateLabel", "Pick a date"),
        partyLabel: t("landingV2BookingPartyLabel", "Party size"),
        timeLabel: t("landingV2BookingTimeLabel", "Pick a time"),
        service: t("landingV2BookingService", "Dinner"),
        cta: t("landingV2BookingCta", "Book {time} for {party}", {
          time,
          party,
        }),
        note: t(
          "landingV2BookingNote",
          "No account needed · Free cancellation",
        ),
      };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 pt-5 pb-[18px] shadow-[0_16px_36px_-24px_rgba(15,23,42,0.35)]">
      {/* Venue header */}
      <div className="mb-[18px] flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-[11px] bg-slate-900 font-display text-sm font-bold text-white"
        >
          BO
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] min-[1041px]:text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {copy.eyebrow}
          </div>
          <div className="truncate font-display text-[17px] font-bold tracking-[-0.02em] text-slate-900">
            {t("landingV2BookingVenue", "Bistro Nørrebro")}
          </div>
        </div>
        <div
          className="flex gap-2 text-[11.5px] font-semibold"
          role="group"
          aria-label={t("landingV2BookingLangGroup", "Page language")}
        >
          {["da", "en"].map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setCardLang(code)}
              aria-pressed={cardLang === code}
              className={`inline-flex min-w-[40px] items-center justify-center min-[1041px]:inline-block min-[1041px]:min-w-0 ${
                cardLang === code
                  ? "text-slate-900"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Date */}
      <div className="mb-2 text-[12.5px] font-semibold text-slate-600">
        {copy.dateLabel}
      </div>
      <div
        className="mb-4 flex flex-wrap gap-[7px]"
        role="group"
        aria-label={copy.dateLabel}
      >
        {dates.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => setDateIdx(i)}
            aria-pressed={dateIdx === i}
            className={`${CHIP_BASE} px-3 ${dateIdx === i ? CHIP_ON : CHIP_IDLE}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Party size */}
      <div className="mb-2 text-[12.5px] font-semibold text-slate-600">
        {copy.partyLabel}
      </div>
      <div
        className="mb-4 flex flex-wrap gap-[7px]"
        role="group"
        aria-label={copy.partyLabel}
      >
        {PARTY_SIZES.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setParty(n)}
            aria-pressed={party === n}
            className={`${CHIP_BASE} px-3.5 min-w-[44px] min-[1041px]:min-w-0 ${party === n ? CHIP_ON : CHIP_IDLE}`}
          >
            {n}
          </button>
        ))}
      </div>

      {/* Time */}
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[12.5px] font-semibold text-slate-600">
          {copy.timeLabel}
        </span>
        <span className="text-[11px] min-[1041px]:text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {copy.service}
        </span>
      </div>
      <div
        className="mb-[18px] flex flex-wrap gap-[7px]"
        role="group"
        aria-label={copy.timeLabel}
      >
        {TIMES.map((slot) => (
          <button
            key={slot}
            type="button"
            onClick={() => setTime(slot)}
            aria-pressed={time === slot}
            className={`${CHIP_BASE} px-[13px] ${time === slot ? CHIP_TIME_ON : CHIP_IDLE}`}
          >
            {slot}
          </button>
        ))}
      </div>

      {/* Footer */}
      <button
        type="button"
        className="mb-2.5 w-full rounded-xl bg-slate-900 py-[13px] text-center text-[14.5px] font-medium text-white"
      >
        {copy.cta}
      </button>
      <div className="text-center text-[12px] text-slate-500">{copy.note}</div>
    </div>
  );
}
