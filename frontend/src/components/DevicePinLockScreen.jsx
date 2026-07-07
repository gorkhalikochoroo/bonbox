/**
 * Shared-device ("Delt enhed") reveal PIN pad (#379, Slice 2).
 *
 * Shown when a shared device tries to view the owner's financials while
 * curtained — inline by OwnerOnlyRoute (fills the page area) or as a modal from
 * the header chip. Enter the 4-digit PIN → reveal() mints a proof and the
 * curtain lifts for the session (auto re-locks on idle / background).
 *
 * HONEST copy: "hide your numbers from staff on this shared device" — never
 * "secure/krypteret". See [[design_owner_shared_device_pin]].
 */
import { useRef, useState } from "react";
import { Lock, X } from "lucide-react";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useLanguage } from "../hooks/useLanguage";

export default function DevicePinLockScreen({ modal = false, onClose }) {
  const { t } = useLanguage();
  const { reveal } = useDeviceShare();
  const [digits, setDigits] = useState(["", "", "", ""]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refs = [useRef(null), useRef(null), useRef(null), useRef(null)];

  const submit = async (pin) => {
    setBusy(true);
    setError("");
    try {
      await reveal(pin);
      if (modal && onClose) onClose(); // curtain lifts; parent route re-renders otherwise
    } catch (err) {
      const code = err?.response?.data?.detail?.code;
      setError(
        code === "pin_locked"
          ? t("devicePinLocked", "Too many tries. Wait a moment and try again.")
          : t("devicePinWrong", "Wrong PIN. Try again."),
      );
      setDigits(["", "", "", ""]);
      refs[0].current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onChange = (i, v) => {
    const d = (v || "").replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (d && i < 3) refs[i + 1].current?.focus();
    if (next.every((x) => x !== "")) submit(next.join(""));
  };

  const onKeyDown = (i, e) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs[i - 1].current?.focus();
  };

  const card = (
    <div
      className="w-full max-w-sm rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 sm:p-8 text-center"
      data-component="DevicePinLockScreen"
    >
      {modal && onClose && (
        <button
          onClick={onClose}
          aria-label={t("close", "Close")}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="w-5 h-5" />
        </button>
      )}
      <div className="mx-auto mb-4 w-11 h-11 rounded-full bg-gray-900 dark:bg-gray-100 flex items-center justify-center">
        <Lock className="w-5 h-5 text-white dark:text-gray-900" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t("devicePinTitle", "Enter your PIN")}
      </h2>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
        {t("devicePinSubtitle", "Your numbers are hidden on this shared device.")}
      </p>
      <div className="mt-6 flex justify-center gap-3" dir="ltr">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={refs[i]}
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            maxLength={1}
            value={d ? "•" : ""}
            disabled={busy}
            autoFocus={i === 0}
            onChange={(e) => onChange(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            aria-label={`${t("devicePinTitle", "Enter your PIN")} ${i + 1}`}
            className="w-12 h-14 text-center text-2xl rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100"
          />
        ))}
      </div>
      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );

  if (modal) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/40 backdrop-blur-sm p-4">
        <div className="relative">{card}</div>
      </div>
    );
  }
  return <div className="flex items-center justify-center py-16 px-4">{card}</div>;
}
