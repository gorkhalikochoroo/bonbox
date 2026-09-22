/**
 * WaitlistSection — the owner Venteliste (reservation waitlist).
 *
 * Parties the venue couldn't seat, parked here instead of a paper pad. When a
 * table frees (a booking is cancelled/no-showed), the parent hands us the
 * `spotMatches` the backend surfaced — we highlight who fits so the owner can
 * one-tap Notify or Book. HONESTY: notifying never promises a held table (the
 * copy says "måske ledig"); Book routes through the real create path so
 * no-double-booking still holds; nothing is auto-notified.
 *
 * Mobile-first: the whole thing is a single calm card; the add form collapses
 * to one column and every row is a full-width stacked card with ≥44px taps.
 *
 * PAIRED HOST STAND. On /stand/<token> the api client rewrites /reservations/*
 * onto /stand/<token>/*, and the backend accepts that credential only on the
 * calls it explicitly wraps. The waitlist READ was wrapped but none of the
 * mutations were, so this card drew Add / Notify / Book / Remove on the door
 * tablet and every one of them 404'd — the venteliste is written down by the
 * person at the door, so that was the whole feature, unreachable exactly where
 * it is used. The mutations are wrapped now (routers/stand_link.py). The one
 * residue is DEPLOY SKEW: frontend and backend ship separately, so a newer
 * bundle can still meet an older API. Every failure path below therefore has to
 * say something true rather than guess at the cause.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, Users, Clock, Bell, X, CalendarPlus, Loader2 } from "lucide-react";
import api from "../../services/api";
import { getStandToken } from "../../services/standAuth";
import { useLanguage } from "../../hooks/useLanguage";
import { useConfirm } from "../../hooks/useConfirm";
import useAsyncData from "../../hooks/useAsyncData";
import Button from "../ui/Button";
import LoadFailed from "../ui/LoadFailed";

const inputCls =
  "w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 " +
  "placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 " +
  "dark:focus:ring-gray-100 focus:border-transparent";

/**
 * What we hand the cockpit when the fetch did not come back.
 *
 * The parent renders this straight into a StatCard (`value={n}`) and turns the
 * tile amber on `n > 0`. "—" is the house glyph for a number we do not have
 * (Amount, formatKr, formatHours all answer it), and it compares false, so an
 * unanswered request neither lights the tile up nor zeroes it out. A blank
 * value would read as a rendering bug; a 0 would read as a fact.
 */
const UNKNOWN_COUNT = "—";

// Next round hour today (local) as an HH:MM default for the Book time picker.
function defaultBookTime() {
  const d = new Date();
  const h = Math.min(23, d.getMinutes() > 0 ? d.getHours() + 1 : d.getHours());
  return String(h).padStart(2, "0") + ":00";
}

export default function WaitlistSection({ day, spotMatches, refreshTick, onCountChange, onConverted }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  // Is this a paired door device? Only used to explain a 404 on a call whose
  // owner-side handler can never produce one (POST /waitlist) — there, and only
  // there, a 404 unambiguously means "this device's credential doesn't reach
  // that route", i.e. an API older than this bundle.
  const onStand = !!getStandToken();

  const [busyId, setBusyId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ guest_name: "", guest_phone: "", party_size: 2, note: "" });
  const [addErr, setAddErr] = useState("");
  const [saving, setSaving] = useState(false);
  // Inline "pick a time" for Book, per entry.
  const [bookFor, setBookFor] = useState(null);
  const [bookTime, setBookTime] = useState(defaultBookTime);
  // Ids the backend just surfaced as fitting a freed table (highlight + ring).
  const [highlight, setHighlight] = useState(() => new Set());
  const [spotBanner, setSpotBanner] = useState(null); // {n, one?:name}
  const [toast, setToast] = useState(null); // transient inline result line

  // THE THIRD STATE. This list used to be two-valued: rows, or "No one waiting
  // yet". A failed GET took the same road as an empty one — `setEntries([])`
  // plus `onCountChange(0)` — so a dropped request told the owner the Venteliste
  // was empty AND told the cockpit tile the same thing as a number. Mid-service
  // that is the lie that costs a table: the parties ARE still waiting, we just
  // could not ask. "Couldn't load" now has its own words and its own retry, and
  // what we push upward says "unknown" instead of zero.
  //
  // Refetches on day change AND whenever the parent's book refetches
  // (refreshTick bumps after any booking mutation — status flip, table move/
  // clear, new booking, walk-in). Keeps the Venteliste "spot on" the moment a
  // booking changes, so a freed / newly-taken seat is reflected without a
  // manual reload.
  const q = useAsyncData(
    () => api.get("/reservations/waitlist", { params: { day } }),
    [day, refreshTick],
    // No day picked yet is a question we never asked, not a request that failed.
    { enabled: !!day },
  );

  // Stable across renders (useAsyncData memoizes it), so handlers and effects
  // can depend on it without re-firing.
  const reloadWaitlist = q.reload;
  const entries = q.data?.waitlist || [];
  const activeCount = q.data?.active_count ?? entries.length;

  // Report the failure UPWARD, not a zero — a confident zero is the same lie one
  // level up, where the cockpit tile has no banner to qualify it. We stay silent
  // while the request is still in flight (nothing to say yet) and while there is
  // no day (nothing was asked).
  useEffect(() => {
    if (!onCountChange || !day || q.loading) return;
    if (q.failed) onCountChange(UNKNOWN_COUNT, { failed: true });
    else onCountChange(activeCount);
  }, [onCountChange, day, q.loading, q.failed, activeCount]);

  // Parent surfaced matches from a just-freed table → highlight + a calm banner.
  useEffect(() => {
    if (!spotMatches || spotMatches.length === 0) return;
    const ids = new Set(spotMatches.map((m) => m.id));
    setHighlight(ids);
    setSpotBanner(
      spotMatches.length === 1
        ? { one: spotMatches[0].guest_name }
        : { n: spotMatches.length },
    );
    reloadWaitlist();
    const tmr = setTimeout(() => setHighlight(new Set()), 30000);
    return () => clearTimeout(tmr);
  }, [spotMatches, reloadWaitlist]);

  // A toast that carries something the host has to ACT on — a phone number to
  // dial — cannot vanish on the same timer as "SMS sent". The notify fallback
  // said "call {name} on {phone}" and then deleted the number after 4s, so the
  // one instruction the host was given outlived the data they needed to follow
  // it. TOAST_ACTIONABLE_MS is for messages holding data; the default is for
  // messages that only report an outcome.
  const TOAST_MS = 4000;
  const TOAST_ACTIONABLE_MS = 20000;
  const toastTimerRef = useRef(null);
  const flashToast = (msg, ms = TOAST_MS) => {
    setToast(msg);
    // Without this, a second toast inherits the first one's countdown and can
    // disappear almost immediately.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  };
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const addEntry = async (e) => {
    e?.preventDefault();
    setAddErr("");
    if (!form.guest_phone.trim()) {
      setAddErr(
        t(
          "rsvpWaitlistPhoneRequired",
          "Add a phone — we text them when a table frees.",
        ),
      );
      return;
    }
    setSaving(true);
    try {
      await api.post("/reservations/waitlist", {
        guest_name: form.guest_name.trim() || null,
        guest_phone: form.guest_phone.trim(),
        party_size: Math.max(1, Math.min(100, parseInt(form.party_size, 10) || 2)),
        waitlist_date: day,
        note: form.note.trim() || null,
      });
      setForm({ guest_name: "", guest_phone: "", party_size: 2, note: "" });
      setAdding(false);
      reloadWaitlist();
    } catch (err) {
      // "Check the phone number" was the answer to EVERY non-402 failure — a
      // 500, a dropped connection, a route the device cannot reach. It sent the
      // host back to re-type a number that was never the problem, and it
      // asserted a cause we had not established. Only a validation status
      // actually says the input was wrong.
      const code = err?.response?.status;
      let msg;
      if (code === 402) msg = t("upgradeRequired", "Upgrade required");
      else if (code === 400 || code === 422) {
        msg = t("rsvpWlAddErr", "Couldn't add — check the phone number.");
      } else if (onStand && (code === 404 || code === 405)) {
        msg = t(
          "rsvpWlStandUnavailable",
          "This door device can't do that yet — add them in BonBox on your phone.",
        );
      } else {
        msg = t("rsvpWlAddErrGeneric", "Couldn't add them just now — try again.");
      }
      setAddErr(msg);
    } finally {
      setSaving(false);
    }
  };

  const notify = async (entry) => {
    if ((entry.notify_count || 0) >= 2) {
      flashToast(t("rsvpWlNotifyCap", "Already contacted twice — call them directly."));
      return;
    }
    const who = entry.guest_name || t("rsvpGuest", "Guest");
    const ok = await confirm({
      message: t("rsvpWlNotifyConfirm", "Let {name} know a spot may have opened? The table isn't reserved for them.", { name: who }),
      confirmLabel: t("rsvpWlNotify", "Notify"),
    });
    if (!ok) return;
    setBusyId(entry.id);
    try {
      const res = await api.post(`/reservations/waitlist/${entry.id}/notify`);
      const { channel, phone } = res.data || {};
      const sentBySms = channel === "sms";
      flashToast(
        sentBySms
          ? t("rsvpWlSmsSent", "SMS sent")
          : t("rsvpWlNotifyCall", "No SMS on this plan — call {name} on {phone}.", { name: who, phone: phone || entry.guest_phone }),
        // The call fallback hands over a number to dial; give the host time to
        // read and dial it. "SMS sent" is just an outcome and can go quickly.
        sentBySms ? TOAST_MS : TOAST_ACTIONABLE_MS,
      );
      reloadWaitlist();
    } catch (err) {
      if (err?.response?.status === 429) {
        flashToast(t("rsvpWlNotifyCap", "Already contacted twice — call them directly."));
      } else {
        // Same third-state rule one layer down: the button spun and then went
        // quiet, which the owner reads as "sent". 402 / 500 / offline — say so.
        flashToast(t("rsvpWlNotifyErr", "Couldn't send that just now — try again."));
      }
    } finally {
      setBusyId(null);
    }
  };

  const removeEntry = async (entry) => {
    const who = entry.guest_name || t("rsvpGuest", "Guest");
    const ok = await confirm({
      message: t("rsvpWlRemoveConfirm", "Remove {name} from the waitlist?", { name: who }),
      destructive: true,
      confirmLabel: t("rsvpWlRemove", "Remove"),
    });
    if (!ok) return;
    setBusyId(entry.id);
    try {
      await api.patch(`/reservations/waitlist/${entry.id}`, { status: "cancelled" });
      reloadWaitlist();
    } catch {
      // There was no catch here at all: a failed remove threw into nothing and
      // the row simply stayed, which reads as "the tap didn't register".
      flashToast(t("rsvpWlRemoveErr", "Couldn't remove them just now — try again."));
    } finally {
      setBusyId(null);
    }
  };

  const book = async (entry) => {
    if (bookFor !== entry.id) {
      setBookFor(entry.id);
      setBookTime(defaultBookTime());
      return;
    }
    setBusyId(entry.id);
    try {
      // Route through the real create path with normal auto-assignment — the
      // converted booking lands on a table just like a web booking (no
      // overflow, so it never lands table-less showing "—"). A 409 = the slot
      // genuinely filled; we surface the honest toast below.
      await api.post(`/reservations/waitlist/${entry.id}/convert`, {
        starts_at: `${day}T${bookTime}:00`,
        auto_assign: true,
      });
      setBookFor(null);
      reloadWaitlist();
      if (onConverted) onConverted();
    } catch (err) {
      if (err?.response?.status === 409) {
        flashToast(t("rsvpConvertFull", "That slot just filled — pick another time."));
      } else {
        // 402 / 500 / network — the button was spinning then silently gave up.
        // Surface an honest generic error so the owner knows to retry.
        flashToast(t("rsvpConvertError", "Couldn't book them just now — try again."));
      }
    } finally {
      setBusyId(null);
    }
  };

  const dismissSpot = () => {
    setSpotBanner(null);
    setHighlight(new Set());
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {t("rsvpWlTitle", "Waitlist")}
          </h3>
          {/* Suppressed on a failed reload: the cockpit tile is already saying
              "—" for the same number, and two different answers on one screen
              is worse than one that admits it doesn't know. The stale rows
              below still show, under a banner that says they're stale. */}
          {!q.failed && entries.length > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {entries.length}
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Plus className="w-4 h-4" />}
          onClick={() => { setAdding((v) => !v); setAddErr(""); }}
        >
          {t("rsvpWlAddCta", "Add")}
        </Button>
      </div>

      {/* "A spot may have opened" — surfaced, never auto-acted. */}
      {spotBanner && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-sm border-b border-amber-100 dark:border-amber-900/40">
          <Bell className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">
            {spotBanner.one
              ? t("rsvpWlSpotOne", "A spot may have opened — {name} fits", { name: spotBanner.one })
              : t("rsvpWlSpotOpened", "A spot may have opened — {n} waiting that fit", { n: spotBanner.n })}
          </span>
          <button type="button" onClick={dismissSpot} aria-label={t("close", "Close")}
            className="shrink-0 -my-0.5 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-amber-100/70 dark:hover:bg-amber-900/40">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <form onSubmit={addEntry} className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input className={inputCls} placeholder={t("rsvpWlName", "Name")} value={form.guest_name}
              onChange={(e) => setForm((f) => ({ ...f, guest_name: e.target.value }))} />
            <input className={inputCls} inputMode="tel" placeholder={t("rsvpWlPhoneReq", "Phone (required)")} value={form.guest_phone}
              required aria-required="true"
              onChange={(e) => setForm((f) => ({ ...f, guest_phone: e.target.value }))} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="inline-flex items-center gap-2">
              <Users className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
              <input className={inputCls} type="number" min="1" max="100" value={form.party_size}
                aria-label={t("rsvpWlPartySize", "Guests")}
                onChange={(e) => setForm((f) => ({ ...f, party_size: e.target.value }))} />
            </div>
            <input className={inputCls} placeholder={t("rsvpWlNote", "Note (optional)")} value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </div>
          {addErr && <p className="text-xs text-red-600 dark:text-red-400">{addErr}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" disabled={saving}
              iconLeft={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}>
              {t("rsvpWlAdd", "Add to waitlist")}
            </Button>
          </div>
        </form>
      )}

      {/* Transient result line */}
      {toast && (
        <div className="px-4 py-2 text-sm text-gray-800 dark:text-gray-100 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-800">
          {toast}
        </div>
      )}

      {/* List — in this order: still asking, couldn't ask, nothing there, rows.
          "Couldn't ask" is the state that was missing; it stands INSTEAD of the empty state,
          never above it, because "no one is waiting" and "we don't know who is
          waiting" are different facts and only the first is reassuring. When a
          RELOAD fails on top of rows we already had, the banner sits above those
          rows instead: stale-but-true beats a blank card in the middle of
          service, and the banner is what says they're stale. */}
      {q.loading || !day ? (
        <div className="px-4 py-6 flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 text-gray-300 dark:text-gray-600 animate-spin" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("rsvpWlLoading", "Loading the waitlist…")}
          </p>
        </div>
      ) : q.failed && entries.length === 0 ? (
        <div className="px-4 py-4">
          <LoadFailed
            onRetry={reloadWaitlist}
            body={t("rsvpWlLoadFailedBody", "We couldn't load the waitlist just now — that isn't the same as nobody waiting.")}
          />
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{t("rsvpWlEmpty", "No one waiting yet")}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t("rsvpWlEmptyBody", "Turned someone away? Add them here — you'll see who fits when a table frees.")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {q.failed && (
            <li className="px-4 pt-3 pb-1">
              <LoadFailed
                onRetry={reloadWaitlist}
                body={t("rsvpWlStaleBody", "Showing the last waitlist we loaded — it may be out of date.")}
              />
            </li>
          )}
          {entries.map((e) => {
            const lit = highlight.has(e.id);
            const busy = busyId === e.id;
            return (
              <li key={e.id}
                className={"px-4 py-3 " + (lit ? "bg-amber-50/60 dark:bg-amber-950/20" : "")}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {e.guest_name || t("rsvpGuest", "Guest")}
                      </span>
                      <span className="inline-flex items-center gap-1 text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums shrink-0">
                        <Users className="w-3.5 h-3.5 text-gray-400" aria-hidden />{e.party_size}
                      </span>
                      {e.status === "notified" && (
                        <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                          {t("rsvpWlNotified", "Notified")}
                          {e.notify_count > 1 ? ` ·${e.notify_count}` : ""}
                        </span>
                      )}
                    </div>
                    {e.note && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">{e.note}</p>
                    )}
                    {e.guest_phone && (
                      <a href={`tel:${String(e.guest_phone).replace(/\s+/g, "")}`}
                        className="text-xs text-gray-600 dark:text-gray-300 tabular-nums hover:text-gray-900 dark:hover:text-gray-100">
                        {e.guest_phone}
                      </a>
                    )}
                  </div>
                  {/* Actions — ≥44px taps, wrap on narrow screens */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button variant="secondary" size="sm" disabled={busy}
                      iconLeft={<Bell className="w-4 h-4" />} onClick={() => notify(e)}>
                      {t("rsvpWlNotify", "Notify")}
                    </Button>
                    <Button variant="primary" size="sm" disabled={busy}
                      iconLeft={<CalendarPlus className="w-4 h-4" />} onClick={() => book(e)}>
                      {t("rsvpWlBook", "Book")}
                    </Button>
                    <button type="button" onClick={() => removeEntry(e)} disabled={busy}
                      aria-label={t("rsvpWlRemove", "Remove")}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {/* Inline time picker for Book */}
                {bookFor === e.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <input type="time" value={bookTime} onChange={(ev) => setBookTime(ev.target.value)}
                      className={inputCls + " max-w-[8rem]"} aria-label={t("rsvpColTime", "Time")} />
                    <Button variant="primary" size="sm" disabled={busy}
                      iconLeft={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}
                      onClick={() => book(e)}>
                      {t("rsvpWlBook", "Book")}
                    </Button>
                    <button type="button" onClick={() => setBookFor(null)}
                      className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
                      {t("cancel", "Cancel")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
