/**
 * NoTableFitsSheet — "Bekræft" on a group, and no table fits (R11, rubric B7).
 *
 * The server tried the engine's own seating rule — the smallest single table,
 * else combinable tables in one zone — and answered 409 no_table_fits BEFORE
 * anything changed: the request is still a request, nothing is held, and the
 * guest has heard nothing. This sheet says that in one plain sentence and
 * offers what the host can actually do, in the order a host reaches for it:
 *
 *   1. Choose tables yourself — the booking opens on its tables (push two
 *      tables together by hand, across zones if the room allows), then
 *      Bekræft holds them.
 *   2. Another time that day where tables fit (the server's nearest, at most
 *      three) — "Flyt til 21.45 og bekræft". Said under it: agree it with the
 *      guest first; the guest is e-mailed the new time and the confirmation.
 *      A phone number makes that one tap ("Ring til …").
 *   3. Confirm without a table — on purpose; the book marks it amber
 *      "Intet bord" until it has tables.
 *   4. Not now.
 *
 * Nothing here decides for the owner, and nothing is sent until she picks.
 * Appointment words (a shop, a workshop with places) ride `apptWords`.
 */
import { AlertTriangle, CalendarClock, Check, Link2, Phone } from "lucide-react";
import Sheet from "../ui/Sheet";
import Button from "../ui/Button";
import { hm } from "../../utils/bookingTimes";
import { guestText } from "../../utils/guestText";

const ROW =
  "w-full min-h-[44px] max-sm:min-h-0! max-sm:h-10 inline-flex items-center gap-2 px-3 rounded-lg " +
  "border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] " +
  "text-sm max-sm:text-[13px] font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-50 " +
  "dark:hover:bg-[rgb(var(--surface-raised))] disabled:opacity-50 transition-colors text-left";

export default function NoTableFitsSheet({
  r,
  facts,
  t,
  busy = false,
  apptWords = false,
  onPickTables,
  onMoveTo,
  onConfirmAnyway,
  onClose,
}) {
  if (!r || !facts) return null;
  const n = Number(facts.party_size || r.party_size) || 1;
  const at = facts.at ? hm(facts.at) : "";
  const name = guestText(r.guest_name) || (apptWords ? t("rsvpColGuestAppt", "Customer") : t("rsvpGuest", "Guest"));
  const largest = Number(facts.largest_table) || 0;
  const free = Number(facts.free_seats) || 0;
  const times = Array.isArray(facts.times) ? facts.times.filter(Boolean).slice(0, 3) : [];
  // Bigger than any table AND than what may be joined: no time helps, only
  // the host's own hands (or no table). Otherwise the fitting tables are
  // simply taken then.
  const why = largest > 0 && n > largest && times.length === 0
    ? (apptWords
      ? t("rsvpNoFitTooBigAppt", "The largest space takes {max}, and no spaces can be joined for {n}.", { max: largest, n })
      : t("rsvpNoFitTooBig", "The largest table seats {max}, and no tables can be pushed together for {n}.", { max: largest, n }))
    : (apptWords
      ? t("rsvpNoFitTakenAppt", "The spaces that would fit are taken then.")
      : t("rsvpNoFitTaken", "The tables that would fit are taken then."));
  const freeLine = free > 0
    ? (apptWords
      ? t("rsvpNoFitFreeAppt", "Free at {time}: {seats} places in all.", { time: at, seats: free })
      : t("rsvpNoFitFree", "Free at {time}: {seats} seats in all.", { time: at, seats: free }))
    : (apptWords
      ? t("rsvpNoFitFreeNoneAppt", "Every space is taken at {time}.", { time: at })
      : t("rsvpNoFitFreeNone", "Every table is taken at {time}.", { time: at }));
  const phone = r.guest_phone ? String(r.guest_phone).replace(/\s+/g, "") : "";

  return (
    <Sheet
      onClose={busy ? () => {} : onClose}
      ariaLabel={apptWords
        ? t("rsvpNoFitTitleAppt", "No space fits {n} people at {time}", { n, time: at })
        : t("rsvpNoFitTitle", "No table fits {n} guests at {time}", { n, time: at })}
      panelClassName="bg-white dark:bg-[rgb(var(--surface-raised))] border-t sm:border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] shadow-2xl sm:max-w-md"
    >
      <div className="flex-1 overflow-auto p-5 space-y-4" data-testid="no-table-fits">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug text-gray-900 dark:text-gray-100">
              {apptWords
                ? t("rsvpNoFitTitleAppt", "No space fits {n} people at {time}", { n, time: at })
                : t("rsvpNoFitTitle", "No table fits {n} guests at {time}", { n, time: at })}
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{name}</p>
            <p className="mt-1 text-[13px] leading-snug text-gray-600 dark:text-gray-300" data-no-fit-why="">
              {why} {freeLine}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <button type="button" className={ROW} disabled={busy} onClick={onPickTables} data-no-fit="pick">
            <Link2 className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
            <span className="min-w-0">
              <span className="block">{apptWords ? t("rsvpNoFitPickAppt", "Choose a space yourself") : t("rsvpNoFitPick", "Choose tables yourself")}</span>
              <span className="block text-[12px] font-normal text-gray-500 dark:text-gray-400">
                {apptWords
                  ? t("rsvpNoFitPickHintAppt", "Pick the space by hand, then confirm.")
                  : t("rsvpNoFitPickHint", "Push tables together by hand, then confirm.")}
              </span>
            </span>
          </button>

          {times.length > 0 && (
            <div className="rounded-lg border border-gray-200 dark:border-[rgb(var(--surface-line))] p-3 space-y-2" data-no-fit-times="">
              <div className="text-[13px] font-medium text-gray-800 dark:text-gray-100">
                {apptWords ? t("rsvpNoFitTimesAppt", "Free spaces at another time:") : t("rsvpNoFitTimes", "Free tables at another time:")}
              </div>
              <p className="text-[12px] leading-snug text-gray-500 dark:text-gray-400">
                {apptWords
                  ? t("rsvpNoFitMoveHintAppt", "Agree the new time with the customer first — they get an e-mail about it.")
                  : t("rsvpNoFitMoveHint", "Agree the new time with the guest first — they get an e-mail about it.")}
              </p>
              {times.map((tm) => (
                <button
                  key={tm}
                  type="button"
                  className={ROW + " tabular-nums"}
                  disabled={busy}
                  onClick={() => onMoveTo(tm)}
                  data-no-fit-move={tm}
                >
                  <CalendarClock className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
                  {t("rsvpNoFitMoveTo", "Move to {time} and confirm", { time: hm(tm) })}
                </button>
              ))}
              {phone && (
                <a
                  href={`tel:${phone}`}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
                  data-no-fit-call=""
                >
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {t("rsvpNoFitCall", "Call {name}", { name })}
                </a>
              )}
            </div>
          )}

          <button type="button" className={ROW} disabled={busy} onClick={onConfirmAnyway} data-no-fit="anyway">
            <Check className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
            <span className="min-w-0">
              <span className="block">{apptWords ? t("rsvpNoFitAnywayAppt", "Confirm without a space") : t("rsvpNoFitAnyway", "Confirm without a table")}</span>
              <span className="block text-[12px] font-normal text-gray-500 dark:text-gray-400">
                {apptWords
                  ? t("rsvpNoFitAnywayHintAppt", "It shows as “No space” in the book until you give it one.")
                  : t("rsvpNoFitAnywayHint", "It shows as “No table” in the book until you give it tables.")}
              </span>
            </span>
          </button>
        </div>
      </div>
      <div
        className="shrink-0 border-t border-gray-200 dark:border-gray-800 p-4"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        <Button variant="ghost" size="lg" className="w-full justify-center max-sm:h-10 max-sm:min-h-0!" disabled={busy} onClick={onClose}>
          {t("rsvpSeatEarlyNotNow", "Not now")}
        </Button>
      </div>
    </Sheet>
  );
}
