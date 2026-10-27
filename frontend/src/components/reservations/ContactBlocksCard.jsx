// "Blokerede kontakter" — the owner's list of phones and e-mails that may
// not book online, and of contacts marked as spam (R2, 27 Oct 2026).
//
//   • Blocked: an online booking from it is refused; the page says the venue
//     is not taking online bookings and offers the phone — never "blocked".
//   • Spam: the next online booking from it waits for the owner's OK.
//
// Store the minimum (backend services/contact_marks.py): the server keeps a
// keyed code and a masked hint ("•• •• •• 78", "s•••@gmail.com") — never
// the number or the address — for a limited time; that is all this card can
// show. A phone or an e-mail typed here is sent once, coded, and forgotten.
//
// Remove ("Fjern") lets the contact book online again (useConfirm); a block
// added here can be taken back from its toast (Fortryd). "Glem" is the GDPR
// path: a guest asks to be forgotten, the owner types the number or the
// address they gave, and everything kept for it at this venue goes — the
// owner never has to find which masked row it was. Fix round 27 Oct: it is a
// real erase (the block list, the waitlist and PAST bookings — the server
// counts first, the confirm says what goes, and that UPCOMING bookings keep
// the contact until the visit), and the toast says what was deleted.
import { useEffect, useState } from "react";
import { ShieldBan, X } from "lucide-react";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { forgetParts, futureLine, joinParts } from "../../utils/forgetWords";

// Phone: 40 px controls with 13 px text (the compact-controls rule).
const PHONE_CTRL = "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]";

// "12. dec 2026" in the owner's language — the day an entry ends.
export function fmtBlockDate(iso, lang = "da") {
  if (!iso) return "";
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return d.toLocaleDateString(lang === "en" ? "en-GB" : "da-DK", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return String(iso).slice(0, 10);
  }
}

// What the owner typed, as the server wants it: an address, or a phone.
export function contactPayload(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (v.includes("@")) return { email: v };
  return String(v).replace(/\D/g, "").length >= 6 ? { phone: v } : null;
}

export default function ContactBlocksCard({ t, lang = "da", apptWords = false }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [blocks, setBlocks] = useState(null); // null = not loaded
  const [days, setDays] = useState(180);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState("");

  const take = (data) => {
    setBlocks(Array.isArray(data?.blocks) ? data.blocks : []);
    if (Number(data?.days) > 0) setDays(Number(data.days));
  };

  useEffect(() => {
    let alive = true;
    api.get("/reservations/contact-blocks")
      .then((res) => { if (alive) take(res?.data); })
      // An older server has no list: the card says nothing is blocked.
      .catch(() => { if (alive) setBlocks([]); });
    return () => { alive = false; };
  }, []);

  const undoAdd = (created = [], upgraded = []) => async () => {
    try {
      let last = null;
      for (const id of created) last = await api.delete(`/reservations/contact-blocks/${id}`);
      for (const id of upgraded) last = await api.delete(`/reservations/contact-blocks/${id}`, { params: { keep_mark: 1 } });
      if (last) take(last.data);
    } catch {
      toast({ severity: "notice", message: t("rsvpSpamUndoFailed", "Couldn't undo. Nothing was changed back.") });
    }
  };

  const add = async () => {
    const body = contactPayload(value);
    if (!body) {
      setError(t("rsvpBlocksErrNoContact", "Type a phone number (at least 6 digits) or an e-mail address."));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/reservations/contact-blocks", body);
      take(res?.data);
      setValue("");
      const named = (res?.data?.entries || []).map((e) => e.hint).filter(Boolean).join(" · ");
      toast({
        severity: "success",
        message: t("rsvpBlocksAdded", "Blocked: {contact} can't book online.", { contact: named || value.trim() }),
        action: {
          label: t("rsvpSpamUndo", "Undo"),
          onClick: undoAdd(res?.data?.created || [], res?.data?.upgraded || []),
        },
      });
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      setError(code === "no_contact"
        ? t("rsvpBlocksErrNoContact", "Type a phone number (at least 6 digits) or an e-mail address.")
        : t("rsvpSettingsSaveError", "Couldn't save settings."));
    } finally {
      setBusy(false);
    }
  };

  // What the server would erase for this contact, counted first (nothing is
  // erased yet). Three answers: the counts; null = an older server with no
  // preview route (it only knows this list); or "failed" — never read as
  // "nothing kept".
  const preview = async (body) => {
    try {
      const res = await api.post("/reservations/contact-blocks/erase-preview", body);
      return res?.data?.would_erase ? res.data : "failed";
    } catch (e) {
      const st = e?.response?.status;
      return st === 404 || st === 405 ? null : "failed";
    }
  };

  const forget = async () => {
    const body = contactPayload(value);
    if (!body) {
      setError(t("rsvpBlocksErrNoContact", "Type a phone number (at least 6 digits) or an e-mail address."));
      return;
    }
    if (busy) return;
    const contact = value.trim();
    setBusy(true);
    setError("");
    try {
      const seen = await preview(body);
      if (seen === "failed") {
        setError(t("rsvpBlocksForgetCheckFailed", "Couldn't check what is kept about that contact. Nothing was deleted — try again."));
        return;
      }
      let ok;
      if (seen) {
        const parts = forgetParts(seen.would_erase, t, apptWords);
        const later = futureLine(seen.future_kept, t, apptWords);
        if (!parts.length) {
          // Nothing to delete: say so (and what is kept), ask nothing.
          toast({
            severity: "info",
            message: later
              ? `${t("rsvpBlocksForgetNothingYet", "Nothing to delete yet.")} ${later}`
              : t("rsvpBlocksNothingKept", "Nothing is kept about that contact."),
          });
          return;
        }
        const what = joinParts(parts, lang);
        ok = await confirm({
          title: t("rsvpBlocksForgetTitle", "Forget {contact}?", { contact }),
          message: [
            apptWords
              ? t("rsvpBlocksForgetWhatAppt", "Everything kept about them goes: {what}. Use it when a customer asks to be forgotten.", { what })
              : t("rsvpBlocksForgetWhat", "Everything kept about them goes: {what}. Use it when a guest asks to be forgotten.", { what }),
            later,
          ].filter(Boolean).join(" "),
          confirmLabel: t("rsvpBlocksForget", "Forget"),
          destructive: true,
        });
      } else {
        // An older server: it erases this list only — and says so.
        ok = await confirm({
          message: apptWords
            ? t("rsvpBlocksForgetConfirmAppt", "Delete everything kept about {contact} on this list? Use it when a customer asks to be forgotten.", { contact })
            : t("rsvpBlocksForgetConfirm", "Delete everything kept about {contact} on this list? Use it when a guest asks to be forgotten.", { contact }),
          confirmLabel: t("rsvpBlocksForget", "Forget"),
          destructive: true,
        });
      }
      if (ok !== true) return;
      let res;
      try {
        res = await api.post("/reservations/contact-blocks/erase", body);
      } catch {
        setError(t("rsvpBlocksForgetUnsure", "We couldn't confirm the deletion. Tap Forget again — it only deletes what is still kept."));
        return;
      }
      take(res?.data);
      setValue("");
      const done = res?.data?.erased;
      if (done) {
        const parts = forgetParts(done, t, apptWords);
        const later = futureLine(res?.data?.future_kept, t, apptWords);
        const head = parts.length
          ? t("rsvpBlocksForgottenFrom", "Forgotten: deleted from {what}.", { what: joinParts(parts, lang) })
          : t("rsvpBlocksNothingKept", "Nothing is kept about that contact.");
        toast({ severity: "info", message: [head, later].filter(Boolean).join(" ") });
      } else {
        const n = Number(res?.data?.removed) || 0;
        toast({
          severity: "info",
          message: n
            ? t("rsvpBlocksForgotten", "Forgotten: {n} kept about that contact deleted.", { n })
            : t("rsvpBlocksNothingKept", "Nothing is kept about that contact."),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b) => {
    const ok = await confirm({
      message: t("rsvpBlocksRemoveConfirm", "Let {contact} book online again?", { contact: b.hint }),
      confirmLabel: t("rsvpBlocksRemove", "Remove"),
    });
    if (ok !== true) return;
    setRemoving(b.id);
    setError("");
    try {
      const res = await api.delete(`/reservations/contact-blocks/${b.id}`);
      take(res?.data);
    } catch {
      setError(t("rsvpSettingsSaveError", "Couldn't save settings."));
    } finally {
      setRemoving(null);
    }
  };

  const list = Array.isArray(blocks) ? blocks : [];

  return (
    <div
      data-testid="rsvp-contact-blocks"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
          <ShieldBan className="w-4 h-4 text-gray-400" aria-hidden />
          {t("rsvpBlocksTitle", "Blocked contacts")}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
          {t("rsvpBlocksHint", "Online bookings from a blocked phone or e-mail are refused: the page says you aren't taking online bookings. Marked as spam: the next one waits for your OK. We don't keep the number or the address, only a code and the last characters, for {days} days.", { days })}
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-2 sm:items-end"
      >
        <div className="min-w-0">
          <label htmlFor="rsvp-block-contact" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t("rsvpBlocksAddLabel", "Phone or e-mail")}
          </label>
          <Input
            id="rsvp-block-contact"
            data-testid="rsvp-block-input"
            value={value}
            maxLength={255}
            autoComplete="off"
            placeholder={t("rsvpBlocksAddPlaceholder", "e.g. 12 34 56 78 or name@mail.dk")}
            onChange={(e) => { setValue(e.target.value); if (error) setError(""); }}
            className={PHONE_CTRL}
          />
        </div>
        {/* Phone: the two actions as equal halves of one row; from sm the
            wrapper dissolves into the form's grid. */}
        <div className="grid grid-flow-col auto-cols-fr gap-2 sm:contents">
          <Button
            type="submit"
            variant="primary"
            size="md"
            busy={busy}
            disabled={!value.trim() || busy}
            data-testid="rsvp-block-add"
            className={"h-10 " + PHONE_CTRL}
          >
            {t("rsvpBlocksAdd", "Block")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={!value.trim() || busy}
            onClick={forget}
            data-testid="rsvp-block-forget"
            className={"h-10 " + PHONE_CTRL}
          >
            {t("rsvpBlocksForget", "Forget")}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {blocks !== null && list.length === 0 ? (
        <p data-testid="rsvp-blocks-empty" className="text-[13px] text-gray-500 dark:text-gray-400">
          {apptWords
            ? t("rsvpBlocksEmptyAppt", "No blocked contacts. Mark an appointment as spam from the appointment itself.")
            : t("rsvpBlocksEmpty", "No blocked contacts. Mark a booking as spam from the booking itself.")}
        </p>
      ) : list.length > 0 ? (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-100 dark:border-gray-800">
          {list.map((b) => (
            <li key={b.id} data-testid="rsvp-block-row" className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-2">
                  <span className="tabular-nums break-all">{b.hint}</span>
                  <span
                    className={
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold " +
                      (b.mode === "block"
                        ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                        : "bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200")
                    }
                  >
                    {b.mode === "block"
                      ? t("rsvpBlocksBadgeBlock", "Blocked")
                      : t("rsvpBlocksBadgeSpam", "Spam: waits for your OK")}
                  </span>
                </p>
                <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">
                  {b.kind === "email" ? t("rsvpDetailEmail", "Email") : t("rsvpDetailPhone", "Phone")}
                  {" · "}
                  {t("rsvpBlocksUntil", "until {date}", { date: fmtBlockDate(b.until, lang) })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="md"
                busy={removing === b.id}
                onClick={() => remove(b)}
                iconLeft={<X className="w-4 h-4" aria-hidden />}
                className={"shrink-0 " + PHONE_CTRL}
                data-testid="rsvp-block-remove"
              >
                {t("rsvpBlocksRemove", "Remove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
