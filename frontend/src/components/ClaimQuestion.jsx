import { useLanguage } from "../hooks/useLanguage";

/**
 * "Har du selv oprettet denne BonBox-konto den <dato> og valgt adgangskoden?"
 *
 * Asked when a login link (or the legacy Apple sign-in) lands in an account
 * whose address was never confirmed (backend services/claim_decision.py,
 * Manoj 8 Oct). Two answers, no third way out: closing the page leaves the
 * question open (the notice mail carries the same two choices), so there is
 * no "skip" or "continue" here.
 *
 *   Ja, det var mig  → onAnswer("keep")    nothing changes
 *   Nej / Ved ikke   → onAnswer("secure")  old password stops working, other
 *                                          devices signed out, revisor access
 *                                          and host-stand devices closed
 *
 * `preferred` (from the mail link the owner tapped) only decides which button
 * is drawn as the primary one; both are always there. Without it the two
 * answers have equal weight — the page does not nudge either way.
 */
export function formatClaimDate(iso, lang) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  try {
    return new Intl.DateTimeFormat(lang === "da" ? "da-DK" : "en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
}

const PRIMARY = "bg-slate-900 hover:bg-slate-800 text-white border border-slate-900";
const SECONDARY = "bg-white hover:bg-slate-50 text-slate-900 border border-slate-300";

export default function ClaimQuestion({ createdAt, onAnswer, busy = false, error = "", preferred = "", explainKey = "claimQuestionExplain", textKey = "claimQuestionText" }) {
  const { t, lang } = useLanguage();
  const date = formatClaimDate(createdAt, lang);
  // Equal weight unless the owner already picked one in the mail.
  const yesStyle = preferred === "keep" ? PRIMARY : SECONDARY;
  const noStyle = preferred === "secure" ? PRIMARY : SECONDARY;
  return (
    <div className="mt-5 text-left" data-testid="claim-question">
      <p className="text-[15px] font-semibold text-gray-900 leading-snug text-center">
        {t(textKey, { date })}
      </p>
      <div className="mt-5 flex flex-col gap-2.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer("keep")}
          className={`w-full h-11 rounded-lg text-[14px] font-medium transition disabled:opacity-60 ${yesStyle}`}
        >
          {t("claimQuestionYes")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer("secure")}
          className={`w-full h-11 rounded-lg text-[14px] font-medium transition disabled:opacity-60 ${noStyle}`}
        >
          {t("claimQuestionNo")}
        </button>
      </div>
      {error && (
        <p className="text-[13px] text-amber-700 mt-3 text-center" role="alert">{error}</p>
      )}
      <p className="text-[12.5px] text-gray-500 mt-4 leading-relaxed text-center">
        {t(explainKey)}
      </p>
    </div>
  );
}
