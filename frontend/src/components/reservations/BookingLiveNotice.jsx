// "Online booking is on" — told the moment it happens (R9, 27 Oct 2026;
// rubric R10).
//
// The server switches the public page on by itself when the venue gets its
// first table (or behandler / place) and the owner never set the switch —
// on purpose: before, a whole floor could be built and the page still took
// no booking. It said so in its answer; nothing on screen did. Now every
// create path announces it (utils/bookingActivation.js) and this one notice,
// mounted once under the page's tabs, shows the link, a copy button and the
// way to the switch. A toast says it too, wherever the owner has scrolled.
// Indstillinger keeps a line about it until the owner flips the switch.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, CheckCircle2, Copy, Settings, X } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { ACTIVATION_EVENT } from "../../utils/bookingActivation";
import { linkDisplay } from "../../utils/bookingLink";

// Phone: 40 px controls with 13 px text (the compact-controls rule).
const BTN =
  "inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 min-h-0! px-3 rounded-lg text-[13px] font-medium " +
  "border border-gray-200 dark:border-gray-700 bg-white dark:bg-transparent text-gray-800 dark:text-gray-200 " +
  "hover:bg-gray-50 dark:hover:bg-gray-800";

async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* no clipboard: nothing more to offer here */ }
  return false;
}

// A sentence with "{link}" in it, the link as a real anchor.
function withLink(text, url) {
  const [before, after = ""] = String(text).split("{link}");
  return (
    <>
      {before}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2 break-all"
      >
        {linkDisplay(url)}
      </a>
      {after}
    </>
  );
}

export function liveNoticeWords(t, kind) {
  if (kind === "stylist") {
    return t("rsvpLiveBodyStylist", "You added your first stylist, so customers can now book online at {link}.");
  }
  if (kind === "place") {
    return t("rsvpLiveBodyPlace", "You added your first space, so customers can now book online at {link}.");
  }
  return t("rsvpLiveBodyTable", "You added your first table, so guests can now book online at {link}.");
}

export default function BookingLiveNotice({ t, settingsHref = "/reservations?tab=settings" }) {
  const [facts, setFacts] = useState(null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    const on = (e) => {
      const d = e?.detail;
      if (!d || typeof d.public_url !== "string" || !d.public_url) return;
      setFacts(d);
      setCopied(false);
      toast({
        severity: "success",
        message: t("rsvpLiveToast", "Online booking is on: {link}", { link: linkDisplay(d.public_url) }),
        action: {
          label: t("rsvpTabSettings", "Settings"),
          // Indstillinger says it for as long as it matters (the switch's
          // own line) — the notice has done its job.
          onClick: () => { setFacts(null); navigate(settingsHref); },
        },
      });
    };
    window.addEventListener(ACTIVATION_EVENT, on);
    return () => window.removeEventListener(ACTIVATION_EVENT, on);
  }, [toast, navigate, t, settingsHref]);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!facts) return null;

  return (
    <div
      role="status"
      data-testid="rsvp-live-notice"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 flex items-start gap-3"
    >
      <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("rsvpLiveTitle", "Online booking is on")}
          </h2>
          <p className="mt-0.5 text-[13px] leading-snug text-gray-600 dark:text-gray-300">
            {withLink(liveNoticeWords(t, facts.kind), facts.public_url)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t("rsvpLiveNotReady", "Not ready yet? Turn it off in Settings.")}
          </p>
        </div>
        <div className="grid grid-flow-col auto-cols-fr sm:flex gap-2">
          <button
            type="button"
            data-testid="rsvp-live-copy"
            onClick={async () => setCopied(await copy(facts.public_url))}
            className={BTN}
          >
            {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
            <span aria-live="polite">{copied ? t("rsvpCopied", "Copied") : t("rsvpWebCopyLink", "Copy link")}</span>
          </button>
          <button
            type="button"
            data-testid="rsvp-live-settings"
            onClick={() => { setFacts(null); navigate(settingsHref); }}
            className={BTN}
          >
            <Settings className="w-4 h-4" aria-hidden />
            {t("rsvpTabSettings", "Settings")}
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setFacts(null)}
        aria-label={t("dismiss", "Dismiss")}
        className="shrink-0 -mr-1 -mt-1 w-9 h-9 min-h-0! inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
      >
        <X className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
}
