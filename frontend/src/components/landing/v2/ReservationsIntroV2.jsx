import { useLanguage } from "../../../hooks/useLanguage";
import { TEXT } from "./fluid";

/**
 * The heading of the reservations band (push 9, B3). The band used to start
 * straight on the booking widget with nothing saying what it was — and the
 * hero's "Se bordplanen" button landed a visitor right on it. Same eyebrow /
 * h2 / lead shape as the other bands.
 */
export default function ReservationsIntroV2() {
  const { t } = useLanguage();
  return (
    <div className={`mb-6 max-w-[58ch] md:mb-10 ${TEXT}`}>
      <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {t("landingV2.reservations.eyebrow", "Reservations")}
      </div>
      <h2 className="mb-3 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900">
        {t("landingV2.reservations.title", "Guests book a table themselves. No account needed.")}
      </h2>
      <p className="text-[17px] text-slate-600 max-md:hidden">
        {t(
          "landingV2.reservations.body",
          "Your own booking page in Danish and English. Bookings land in the booking book and on the floor plan, with a waitlist when you are full.",
        )}
      </p>
    </div>
  );
}
