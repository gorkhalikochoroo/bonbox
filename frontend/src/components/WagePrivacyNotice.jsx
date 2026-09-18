/**
 * WagePrivacyNotice — what a seat sees where a wage surface used to be.
 *
 * Payroll is owner-only (Manoj, 18 Sep 2026: "close the payroll-estimate
 * carve-out"). The server enforces it; this is the half that decides whether
 * the enforcement reads as a RULE or as a BUG. A denied fetch caught into an
 * empty array renders "no tips yet" over a real tip history — a falsehood — and
 * a denied fetch caught into null renders a blank panel under a working period
 * picker, which every manager will report as broken.
 *
 * The wage tabs are hidden for these seats, so the normal path never reaches
 * this component. It is the DEEP-LINK floor: a bookmark, a ⌘K jump, a pushed
 * link, an old URL with ?tab=payroll still on it.
 *
 * TWO POPULATIONS, TWO TRUTHS — and this component shipped telling both of them
 * the first one. A delegated seat is blocked by their ROLE and cannot undo it.
 * An owner on a curtained "Delt enhed" tablet is the OWNER: they can see wage
 * figures, they just have to lift the curtain. Telling them "Din rolle kan ikke
 * se løntal — spørg ejeren" says something false and then sends them to ask
 * themselves. `reason="curtain"` shows the shipped curtain copy instead and
 * opens the reveal PIN pad in place, which is exactly what FinancialCurtain
 * does for the dashboard's money cards.
 *
 * COPY IS REUSED, NOT INVENTED, on both branches. `hovRoleCannotSee` /
 * `hovRoleCannotSeeHint` already ship in real en + da for the role case one tab
 * over; `curtainTitle` / `curtainTapReveal` already ship for the curtain case.
 * A near-duplicate string would be one more thing to keep in step, and two
 * surfaces that answer the same question differently is exactly the defect
 * class the landing-honesty sweep was about.
 */
import { useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import DevicePinLockScreen from "./DevicePinLockScreen";
import { Icon } from "./ui";

export default function WagePrivacyNotice({ reason = "role", actionLabel, onAction }) {
  const { t } = useLanguage();
  const [pad, setPad] = useState(false);
  const curtained = reason === "curtain";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
      <Icon name="Lock" size={28} className="text-gray-400 mx-auto mb-2" />
      <p className="text-gray-700 dark:text-gray-200 font-medium">
        {curtained
          ? t("curtainTitle", "Numbers hidden")
          : t("hovRoleCannotSee", "Your role can't see wage figures")}
      </p>
      <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
        {curtained
          ? t("curtainTapReveal", "Tap and enter your PIN to show them on this shared device.")
          : t("hovRoleCannotSeeHint", "Hours and clock-ins are under Details. Ask the business owner for the wage overview.")}
      </p>

      {/* The curtain's way out is the PIN, not a different tab: this owner came
          here to read the number and can still have it. */}
      {curtained ? (
        <button
          type="button"
          onClick={() => setPad(true)}
          className="mt-4 text-sm font-medium text-[rgb(var(--brand-600))] dark:text-[rgb(var(--brand-400))] hover:underline"
        >
          {/* The same words the global DeviceShareChip uses for the same act —
              one gesture should not have two names. */}
          {t("deviceRevealNumbers", "Show numbers")}
        </button>
      ) : (
        /* For a role seat the way out is optional — a calm dead end still beats
           a spinner, and on some surfaces there is nowhere honest to send them. */
        onAction && actionLabel && (
          <button
            type="button"
            onClick={onAction}
            className="mt-4 text-sm font-medium text-[rgb(var(--brand-600))] dark:text-[rgb(var(--brand-400))] hover:underline"
          >
            {actionLabel}
          </button>
        )
      )}

      {pad && <DevicePinLockScreen modal onClose={() => setPad(false)} />}
    </div>
  );
}
