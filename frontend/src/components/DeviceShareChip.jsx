/**
 * Shared-device ("Delt enhed") header chip (#379, Slice 2).
 *
 * Visible ONLY on a device the owner flagged shared. The one-tap control for the
 * owner: locked → "Vis tal" opens the PIN pad; revealed → "Skjul igen" re-
 * curtains immediately (the deliberate hand-off gesture before passing the
 * device to staff). Renders nothing on a normal (non-shared) device.
 */
import { useState } from "react";
import { Lock, EyeOff } from "lucide-react";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useLanguage } from "../hooks/useLanguage";
import DevicePinLockScreen from "./DevicePinLockScreen";

export default function DeviceShareChip() {
  const { t } = useLanguage();
  const { enabled, locked, relock } = useDeviceShare();
  const [pad, setPad] = useState(false);

  if (!enabled) return null;

  return (
    <>
      {locked ? (
        <button
          type="button"
          onClick={() => setPad(true)}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
        >
          <Lock className="w-3.5 h-3.5" />
          {t("deviceRevealNumbers", "Vis tal")}
        </button>
      ) : (
        <button
          type="button"
          onClick={relock}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700"
        >
          <EyeOff className="w-3.5 h-3.5" />
          {t("deviceHideNumbers", "Skjul igen")}
        </button>
      )}
      {pad && <DevicePinLockScreen modal onClose={() => setPad(false)} />}
    </>
  );
}
