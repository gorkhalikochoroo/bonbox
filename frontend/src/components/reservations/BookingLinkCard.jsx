// "Din bookingside" — the page's own address, changed safely (R9, 27 Oct
// 2026; rubric R11). Moved out of ReservationsPage's SettingsSection, where
// it was a slug field with a "/r/" prefix and a Gem.
//
//  • The box shows the REAL address: "www.bonbox.dk/" in front of the name
//    (the link handed out is www.bonbox.dk/<name>, never /r/<name>), and a
//    "Nyt link: …" line while the owner types — the server's own spelling
//    (æ → ae, spaces → dashes).
//  • Before the change, one confirm says what happens to the old link. On a
//    server that keeps old links (GET /settings sends `slug_aliases`) it
//    keeps working: printed QR codes, the website button, Google and
//    Instagram send guests on. On an older server it stops — and the
//    confirm says exactly that. Never a silent change.
//  • Old links that still work are listed, each with "Stop".
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Link2 } from "lucide-react";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import Button from "../ui/Button";
import { linkDisplay, linkPrefix, newLinkDisplay, sinceLabel, slugPreview } from "../../utils/bookingLink";

// Phone: 40 px buttons with 13 px text; the field keeps 16 px text so iOS
// does not zoom into it.
const PHONE_BTN = "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]";

export default function BookingLinkCard({
  t,
  lang = "da",
  publicUrl = "",
  slug = "",
  // undefined = an older server that keeps no old links.
  aliases,
  aliasMax = 5,
  apptWords = false,
  // ({reservation_slug?, public_url?, slug_aliases?}) — the parent keeps the
  // page's data in step.
  onSaved,
  // The jump row's anchor.
  id = "rsvp-link",
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState(slug || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState("");
  const lastSlug = useRef(slug || "");

  // A new link from outside (saved here, or minted by the switch) replaces
  // the field — unless the owner is typing in it.
  useEffect(() => {
    setDraft((cur) => (cur === lastSlug.current ? slug || "" : cur));
    lastSlug.current = slug || "";
  }, [slug]);

  const keepsOld = Array.isArray(aliases);
  const list = keepsOld ? aliases : [];
  const next = slugPreview(draft);
  const changed = !!next && next !== slug;
  const oldLink = linkDisplay(publicUrl);
  const newLink = newLinkDisplay(publicUrl, slug, next);

  const save = async () => {
    setError("");
    if (draft.trim().length < 2 || next.length < 2) {
      setError(t("rsvpSlugTooShort", "Pick at least 2 characters."));
      return;
    }
    if (!changed) return;
    // Which old links the change would push out (more than aliasMax kept).
    const rest = list.filter((a) => a.slug !== next && a.slug !== slug);
    const over = keepsOld ? Math.max(0, rest.length + 1 - aliasMax) : 0;
    const dropping = over > 0 ? rest.slice(rest.length - over) : [];
    const ok = await confirm({
      title: t("rsvpLinkChangeTitle", "Change your link?"),
      message: (
        <>
          <span className="block">{t("rsvpLinkChangeNew", "New link: {link}", { link: newLink })}</span>
          <span className="block mt-2">
            {keepsOld
              ? (apptWords
                ? t("rsvpLinkChangeKeptAppt", "The old link {old} keeps working: printed QR codes, your website button, Google and Instagram send customers on to the new one.", { old: oldLink })
                : t("rsvpLinkChangeKept", "The old link {old} keeps working: printed QR codes, your website button, Google and Instagram send guests on to the new one.", { old: oldLink }))
              : (apptWords
                ? t("rsvpLinkChangeDiesAppt", "The old link {old} stops working: printed QR codes, your website button, Google and Instagram will tell customers you don't take bookings.", { old: oldLink })
                : t("rsvpLinkChangeDies", "The old link {old} stops working: printed QR codes, your website button, Google and Instagram will tell guests you don't take bookings.", { old: oldLink }))}
          </span>
          {keepsOld && (
            <span className="block mt-2">
              {t("rsvpLinkChangeUpdate", "Print new QR codes and update your website when you can.")}
            </span>
          )}
          {dropping.map((a) => (
            <span key={a.slug} className="block mt-2">
              {t("rsvpLinkChangeDrops", "{old} stops working: at most {n} old links are kept.", {
                old: linkDisplay(a.url || a.slug), n: aliasMax,
              })}
            </span>
          ))}
        </>
      ),
      confirmLabel: t("rsvpLinkChangeYes", "Change link"),
      cancelLabel: t("rsvpLinkChangeNo", "Keep the current link"),
      // Nothing to call back once the old link is gone: focus starts on
      // Cancel and Enter does not confirm.
      irreversible: !keepsOld || dropping.length > 0,
    });
    if (ok !== true) return;
    setSaving(true);
    try {
      const res = await api.post("/reservations/slug", { slug: next });
      const d = res?.data || {};
      onSaved?.({
        reservation_slug: d.reservation_slug || next,
        public_url: d.public_url || publicUrl,
        ...(Array.isArray(d.slug_aliases) ? { slug_aliases: d.slug_aliases } : {}),
      });
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      if (code === "slug_reserved") {
        setError(t("rsvpSlugReserved", "That word is reserved — pick a different link."));
      } else if (e?.response?.status === 409) {
        setError(t("rsvpSlugTaken", "That link is taken — try another."));
      } else {
        setError(t("rsvpSlugError", "Couldn't update the link."));
      }
    } finally {
      setSaving(false);
    }
  };

  const stop = async (a) => {
    const shown = linkDisplay(a.url || a.slug);
    const ok = await confirm({
      title: t("rsvpOldLinkStopTitle", "Stop the old link?"),
      message: apptWords
        ? t("rsvpOldLinkStopBodyAppt", "{old} will no longer open your booking page: a customer with an old QR code or button is told you don't take bookings there. Anyone can take the name.", { old: shown })
        : t("rsvpOldLinkStopBody", "{old} will no longer open your booking page: a guest with an old QR code or button is told you don't take bookings there. Anyone can take the name.", { old: shown }),
      confirmLabel: t("rsvpOldLinkStopYes", "Stop the link"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (ok !== true) return;
    setStopping(a.slug);
    setError("");
    try {
      const res = await api.delete(`/reservations/slug/aliases/${encodeURIComponent(a.slug)}`);
      onSaved?.({ slug_aliases: Array.isArray(res?.data?.slug_aliases) ? res.data.slug_aliases : list.filter((x) => x.slug !== a.slug) });
    } catch {
      setError(t("rsvpOldLinkStopError", "Couldn't stop the old link. Try again."));
    } finally {
      setStopping("");
    }
  };

  return (
    <div
      id={id}
      data-testid="rsvp-share-card"
      className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
    >
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
        {t("rsvpShareTitle", "Your booking page")}
      </h2>

      {/* A <form> so Enter saves from the field. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving && changed) save();
        }}
        className="space-y-2"
      >
        <label htmlFor="rsvp-slug" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
          {t("rsvpCustomLink", "Customise your link")}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex items-center flex-1 min-w-0 h-11 max-sm:h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden text-gray-900 dark:text-gray-100 focus-within:ring-2 focus-within:ring-gray-900 dark:focus-within:ring-gray-100">
            {/* The real address, not "/r/": what the kit, the QR and the
                e-mails hand out. */}
            <span
              data-testid="rsvp-slug-prefix"
              className="pl-3 pr-1 text-sm max-sm:text-[13px] text-gray-500 dark:text-gray-400 shrink-0 self-stretch flex items-center"
            >
              {linkPrefix(publicUrl, slug)}
            </span>
            <input
              id="rsvp-slug"
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              placeholder={t("rsvpSlugPh", "cafe-mocca")}
              maxLength={60}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 pr-3 h-full text-base sm:text-sm bg-transparent outline-none text-gray-900 dark:text-gray-100"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" busy={saving} disabled={!changed} className={PHONE_BTN}>
            {t("save", "Save")}
          </Button>
        </div>
        {changed && (
          <p data-testid="rsvp-link-preview" className="text-xs text-gray-600 dark:text-gray-300 break-all">
            {t("rsvpLinkChangeNew", "New link: {link}", { link: newLink })}
          </p>
        )}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </form>

      {keepsOld && list.length > 0 && (
        <div data-testid="rsvp-old-links" className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-2">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-gray-400" aria-hidden />
            {t("rsvpOldLinksTitle", "Old links that still work")}
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {list.map((a) => (
              <li key={a.slug} className="py-1.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-gray-800 dark:text-gray-200 truncate">{linkDisplay(a.url || a.slug)}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
                    <ArrowRight className="w-3 h-3" aria-hidden />
                    {a.since
                      ? t("rsvpOldLinkSince", "Sends {who} here · old since {date}", {
                          who: apptWords ? t("rsvpOldLinkWhoAppt", "customers") : t("rsvpOldLinkWho", "guests"),
                          date: sinceLabel(a.since, lang),
                        })
                      : t("rsvpOldLinkForwards", "Sends {who} here", {
                          who: apptWords ? t("rsvpOldLinkWhoAppt", "customers") : t("rsvpOldLinkWho", "guests"),
                        })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  busy={stopping === a.slug}
                  onClick={() => stop(a)}
                  className={"shrink-0 " + PHONE_BTN}
                >
                  {t("rsvpOldLinkStop", "Stop")}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            {t("rsvpOldLinksHint", "Printed QR codes and old website buttons keep working. Stop one only if it should open nothing.")}
          </p>
        </div>
      )}
    </div>
  );
}
