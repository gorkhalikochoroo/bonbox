/**
 * Financial curtain placeholder (#379, Slice 2 polish).
 *
 * Rendered IN PLACE OF a money-position dashboard card (profit hero, revenue
 * trend, P&L) when the device is in shared mode and not currently revealed.
 * Tapping opens the reveal PIN pad. Today's-till revenue stays visible
 * elsewhere (staff see it at the register anyway) — this only curtains the
 * business's position over time. Honest copy: "hidden on a shared device".
 */
import { useState } from "react";
import { Lock } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import DevicePinLockScreen from "./DevicePinLockScreen";

export default function FinancialCurtain() {
  const { t } = useLanguage();
  const [pad, setPad] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setPad(true)}
        className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
        data-component="FinancialCurtain"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
            <Lock className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              {t("curtainTitle", "Numbers hidden")}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("curtainTapReveal", "Tap and enter your PIN to show them on this shared device.")}
            </p>
          </div>
        </div>
      </button>
      {pad && <DevicePinLockScreen modal onClose={() => setPad(false)} />}
    </>
  );
}
