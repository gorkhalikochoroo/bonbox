/**
 * The book's two honest "I have nothing to show" states (R10 — the door iPad
 * stays on; rubric B5 and V10).
 *
 * BookUnavailable — no book for this day could be read (a door iPad restarted
 * while the wifi was down). Before R10 the list said "Ingen reservationer …
 * endnu", the floor drew every table free and the cockpit said "0 gæster":
 * an empty night, which is the one thing a host must never be told when the
 * truth is "I couldn't ask". Calm, not red — nothing is wrong with the
 * venue — and it says the page keeps trying by itself.
 *
 * StandNotConnected — a paired door screen whose link answers "not found"
 * (the owner pressed Fjern, or the screen was disconnected). It used to show
 * the raw word "not_found", zeros, "Ingen reservationer" and a working
 * "Ny reservation". Now: one screen that says what happened and the one
 * thing to do, and no guests left on it.
 */
import { AlertTriangle, KeyRound, Link2Off, RefreshCw, WifiOff } from "lucide-react";

import Button from "../ui/Button";

export function BookUnavailable({ t, message, offline = false, apptWords = false, onRetry }) {
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <section
      role="status"
      data-book-unavailable=""
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] px-4 py-5 sm:px-6 sm:py-6 flex items-start gap-3"
    >
      <span className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
        <Icon className="w-[18px] h-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 leading-snug">
          {apptWords
            ? t("rsvpBookUnavailableTitleAppt", "Couldn't load the appointments")
            : t("rsvpBookUnavailableTitle", "Couldn't load the book")}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">{message}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
          {t("rsvpBookUnavailableAuto", "Trying again by itself — nothing is lost.")}
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            size="md"
            iconLeft={<RefreshCw className="w-4 h-4" aria-hidden />}
            onClick={onRetry}
            className="max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]"
          >
            {t("tryAgain", "Try again")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function StandNotConnected({ t, apptWords = false, busy = false, onRetry, onNewCode }) {
  return (
    <div
      data-stand-gone=""
      className="min-h-dvh flex items-center justify-center px-5 py-10 bg-gray-50 dark:bg-gray-950"
    >
      <div
        role="alert"
        className="w-full max-w-sm rounded-2xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-7 shadow-sm"
      >
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200 mb-5"
          aria-hidden
        >
          <Link2Off className="w-6 h-6" />
        </span>
        <h1 className="text-[20px] font-bold tracking-[-0.02em] text-gray-900 dark:text-gray-100 leading-tight">
          {t("rsvpStandGoneTitle", "This screen isn't connected any more")}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-gray-600 dark:text-gray-300">
          {apptWords
            ? t(
              "rsvpStandGoneBodyAppt",
              "The owner removed it, or it was disconnected. Ask the owner for a new code under Appointments → Settings.",
            )
            : t(
              "rsvpStandGoneBody",
              "The owner removed it, or it was disconnected. Ask the owner for a new code under Reservations → Settings.",
            )}
        </p>
        <div className="mt-6 grid gap-2">
          <Button
            variant="primary"
            size="lg"
            iconLeft={<KeyRound className="w-4 h-4" aria-hidden />}
            onClick={onNewCode}
          >
            {t("rsvpStandGoneNewCode", "Enter a new code")}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            iconLeft={<RefreshCw className="w-4 h-4" aria-hidden />}
            onClick={onRetry}
            disabled={busy}
          >
            {t("tryAgain", "Try again")}
          </Button>
        </div>
      </div>
    </div>
  );
}
