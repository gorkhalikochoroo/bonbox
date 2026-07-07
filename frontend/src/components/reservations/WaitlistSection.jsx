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
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Users, Clock, Bell, X, CalendarPlus, Loader2 } from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { useConfirm } from "../../hooks/useConfirm";
import Button from "../ui/Button";

const inputCls =
  "w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 " +
  "placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 " +
  "dark:focus:ring-gray-100 focus:border-transparent";

// Next round hour today (local) as an HH:MM default for the Book time picker.
function defaultBookTime() {
  const d = new Date();
  const h = Math.min(23, d.getMinutes() > 0 ? d.getHours() + 1 : d.getHours());
  return String(h).padStart(2, "0") + ":00";
}

export default function WaitlistSection({ day, spotMatches, refreshTick, onCountChange, onConverted }) {
  const { t } = useLanguage();
  const confirm = useConfirm();

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
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

  const fetchList = useCallback(async () => {
    if (!day) return;
    setLoading(true);
    try {
      const res = await api.get("/reservations/waitlist", { params: { day } });
      const list = res.data?.waitlist || [];
      setEntries(list);
      if (onCountChange) onCountChange(res.data?.active_count ?? list.length);
    } catch {
      setEntries([]);
      if (onCountChange) onCountChange(0);
    } finally {
      setLoading(false);
    }
  }, [day, onCountChange]);

  // Refetch on day change AND whenever the parent's book refetches
  // (refreshTick bumps after any booking mutation — status flip, table move/
  // clear, new booking, walk-in). Keeps the Venteliste "spot on" the moment a
  // booking changes, so a freed / newly-taken seat is reflected without a
  // manual reload.
  useEffect(() => {
    fetchList();
  }, [fetchList, refreshTick]);

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
    fetchList();
    const tmr = setTimeout(() => setHighlight(new Set()), 30000);
    return () => clearTimeout(tmr);
  }, [spotMatches, fetchList]);

  const flashToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

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
      fetchList();
    } catch (err) {
      const code = err?.response?.status;
      setAddErr(
        code === 402
          ? t("upgradeRequired", "Upgrade required")
          : t("rsvpWlAddErr", "Couldn't add — check the phone number."),
      );
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
      flashToast(
        channel === "sms"
          ? t("rsvpWlSmsSent", "SMS sent")
          : t("rsvpWlNotifyCall", "No SMS on this plan — call {name} on {phone}.", { name: who, phone: phone || entry.guest_phone }),
      );
      fetchList();
    } catch (err) {
      if (err?.response?.status === 429) {
        flashToast(t("rsvpWlNotifyCap", "Already contacted twice — call them directly."));
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
      fetchList();
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
      fetchList();
      if (onConverted) onConverted();
    } catch (err) {
      if (err?.response?.status === 409) {
        flashToast(t("rsvpConvertFull", "That slot just filled — pick another time."));
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
          {entries.length > 0 && (
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
        <div className="px-4 py-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-800">
          {toast}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="px-4 py-6 flex justify-center">
          <Loader2 className="w-5 h-5 text-gray-300 dark:text-gray-600 animate-spin" aria-hidden />
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
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 tabular-nums shrink-0">
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
                        className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums hover:text-gray-600">
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
