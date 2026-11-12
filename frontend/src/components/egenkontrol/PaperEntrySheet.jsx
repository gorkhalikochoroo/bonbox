/**
 * "Fra papir" — the owner types in a reading that was written on paper, for
 * example while the network was down (R1b, owner only; hidden for a manager,
 * a cashier and a viewer, and behind the reveal PIN on a curtained tablet).
 *
 * At most 14 days back. The check, the measured date and time and the reason
 * sit ABOVE the keypad as one fixed block; then the usual "Registrér" panel
 * (RecordPanel with its `paper` prop): keypad, the deviation questions with
 * CLOSING fates only (a paper reading is a finished story — it never opens or
 * answers a live deviation), "Hvem målte?". The server stores both times:
 * when it was measured (the official time, its slot) and when it was typed
 * in; the Kontrolmappe and the PDF show both. Keep the paper note.
 */
import { useState } from "react";
import Sheet from "../ui/Sheet";
import api from "../../services/api";
import RecordPanel from "./RecordPanel";
import { addDays, errorCode, localDateOf, venueCalendarToday } from "./ekLogic";

const SELECT =
  "w-full min-h-14! rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-4 text-base " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";

/** HH:MM of a device timestamp (a queued reading's typed time), or "". */
function hhmmOf(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function PaperEntrySheet({
  checks = [],
  staff = [],
  businessDate,
  timeZone = null,
  prefill = null,
  onSaved,
  onClose,
  t,
  lang = "da",
}) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && c.active !== false && !c.archived_at);
  // The server reads date + time as a CALENDAR wall time in the venue's zone:
  // the newest date is the venue's calendar date (the business date + 1
  // between midnight and the cutoff), not the business date.
  const [maxDate] = useState(() => venueCalendarToday(businessDate, timeZone) || businessDate || null);
  const minDate = maxDate ? addDays(maxDate, -14) : null;
  const [checkId, setCheckId] = useState(() =>
    prefill?.checkId && list.some((c) => c.id === prefill.checkId) ? prefill.checkId : list[0]?.id || null,
  );
  // A queued reading: the CALENDAR date it was typed (as its time) — never
  // its business date, which is a day earlier for anything after midnight.
  const [date, setDate] = useState(() => localDateOf(prefill?.typedAt) || prefill?.businessDate || maxDate || "");
  const [time, setTime] = useState(() => hhmmOf(prefill?.typedAt) || "");
  const [reason, setReason] = useState("");
  const [nonce, setNonce] = useState(0);
  const check = list.find((c) => c.id === checkId) || null;

  const onSave = async (body) => {
    try {
      const res = await api.post("/egenkontrol/paper-entries", body);
      onSaved?.(res?.data || null, prefill);
      return { ok: true, entry: res?.data || null };
    } catch (err) {
      // Every refusal keeps the sheet open with its reason and the SAME
      // client_id (a retry of a lost answer is a replay, not a second row).
      const d = err?.response?.data?.detail;
      const missing = d && typeof d === "object" && Array.isArray(d.missing) ? d.missing : [];
      let code = errorCode(err);
      // The check did not exist yet (or was off) at the MEASURED time — not
      // "switched off now": say so in its own words.
      if (code === "check_inactive" && d && typeof d === "object" && d.at === "measured") code = "check_inactive_measured";
      return { ok: false, kind: "needs_action", code, missing };
    }
  };

  const header = (
    <div className="space-y-3">
      <p className="text-[15px] text-gray-700 dark:text-gray-300" data-testid="ek-paper-intro">{t("ekPaperIntro")}</p>
      <div>
        <label htmlFor="ek-paper-check" className="block text-[15px] font-semibold mb-2 text-gray-900 dark:text-gray-100">{t("ekPaperCheck")}</label>
        <select
          id="ek-paper-check"
          className={SELECT}
          value={checkId || ""}
          onChange={(e) => {
            setCheckId(e.target.value);
            setNonce((n) => n + 1);
          }}
          data-testid="ek-paper-check"
        >
          {list.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <Sheet
      onClose={onClose}
      desktop="top"
      ariaLabel={t("ekPaperTitle")}
      panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700"
    >
      {check ? (
        <RecordPanel
          key={`${check.id}:${nonce}`}
          check={check}
          staff={staff}
          heldWho={null}
          onSave={onSave}
          onClose={onClose}
          draft={prefill?.draft && prefill.checkId === check.id ? { state: prefill.draft } : null}
          t={t}
          lang={lang}
          idPrefix="ek-paper"
          businessDate={null}
          allowPhoto={false}
          paper={{ date, time, reason, setDate, setTime, setReason, minDate, maxDate, header }}
        />
      ) : (
        <div className="p-5">
          <p className="text-[15px] text-gray-700 dark:text-gray-300">{t("ekKitchenNoChecks")}</p>
        </div>
      )}
    </Sheet>
  );
}
