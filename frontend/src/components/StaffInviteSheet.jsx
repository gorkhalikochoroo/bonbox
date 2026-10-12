/**
 * StaffInviteSheet — "Invitér Sofie": the ONE way an owner sends a staffer
 * their way in, from the team list on the Vagtplan page.
 *
 * Before this the schedule page offered the same credential in five places
 * under five names: a bare 6-character code chip on the roster row ("HZTPAN",
 * unlabelled), a link icon that opened a "Del portal-link" dialog, a "Del link"
 * button inside the edit drawer that opened that same dialog, a per-row
 * "kopiér" in the week's share sheet, and an unexplained "App Store" link
 * under the toolbar. Nothing said that the link, the code and the Vagtplan app
 * are three doors into the SAME thing. This sheet says it once:
 *
 *   1. Send them their personal link — SMS, WhatsApp or copy. Same message on
 *      every channel (utils/staffInvite.js), sent from the owner's own phone.
 *   2. Standing next to you? The QR code, or the Vagtplan app + the code.
 *
 * Every capability the old dialogs had is still here: copy the link, the OS
 * share sheet (when the device has one), the join code, the App Store link.
 */
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useLanguage } from "../hooks/useLanguage";
import { formatDateClear } from "../utils/dateFormat";
import { staffReachState } from "../utils/portalReach";
import {
  VAGTPLAN_APP_URL,
  canSendSms,
  firstName,
  inviteMessage,
  smsHref,
  whatsappHref,
} from "../utils/staffInvite";
import { Icon } from "./ui";
import Sheet from "./ui/Sheet";

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / an insecure origin: the textarea fallback. If that
    // throws too, the caller says "couldn't copy" instead of a false tick.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok !== false;
    } catch {
      return false;
    }
  }
}

/**
 * One staffer's way-in status as a dot + a few words. Renders NOTHING for
 * "unknown" (we did not ask the server) — silence is the only honest output
 * for a question nobody asked. Colour carries meaning only: amber = needs the
 * owner, emerald = in use this week, gray = joined but quiet.
 */
export function StaffReachStatus({ lastAccessed, now, className = "" }) {
  const { t } = useLanguage();
  const r = staffReachState(lastAccessed, now);
  if (r.state === "unknown") return null;
  const when = r.daysAgo === 0
    ? t("staffReachToday")
    : r.daysAgo === 1
      ? t("staffReachYesterday")
      : formatDateClear(String(r.lastSeen).slice(0, 10));
  const tone = {
    none: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
    active: { dot: "bg-emerald-500", text: "text-gray-600 dark:text-gray-300" },
    joined: { dot: "bg-gray-400 dark:bg-gray-500", text: "text-gray-500 dark:text-gray-400" },
  }[r.state];
  const label = r.state === "none"
    ? t("staffReachNone")
    : r.state === "active"
      ? t("staffReachActive", { when })
      : t("staffReachJoined", { when });
  return (
    <span
      className={`inline-flex items-center gap-1.5 min-w-0 text-[12px] ${tone.text} ${className}`}
      data-reach={r.state}
    >
      <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

const CHANNEL =
  "min-h-[44px] inline-flex flex-col items-center justify-center gap-1 rounded-xl border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-800 text-[13px] font-medium text-gray-800 dark:text-gray-100 px-2 py-2 " +
  "hover:bg-gray-50 dark:hover:bg-gray-700/60 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

/**
 * @param {object} props
 * @param {{id: string, name: string, phone?: string|null}} props.member
 * @param {{url: string, code?: string}|null} props.link   null while loading
 * @param {boolean} props.loading
 * @param {string|null|undefined} props.lastAccessed       see staffReachState
 * @param {string} props.restaurant
 * @param {() => void} props.onClose
 */
export default function StaffInviteSheet({ member, link, loading, lastAccessed, restaurant, onClose }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(null); // "msg" | "code" | "url" | "fail" | null
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!member) return null;

  const name = firstName(member.name);
  const message = link?.url
    ? inviteMessage({ t, name: member.name, restaurant, url: link.url, code: link.code })
    : "";
  const sms = canSendSms();
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const flash = (what) => {
    setCopied(what);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };
  const copyMessage = async () => flash((await writeClipboard(message)) ? "msg" : "fail");
  const copyCode = async () => flash((await writeClipboard(link?.code || "")) ? "code" : "fail");
  const copyUrl = async () => flash((await writeClipboard(link?.url || "")) ? "url" : "fail");
  const nativeShare = async () => {
    try {
      await navigator.share({
        title: t("scheduleShareLinkTitle", { restaurant: restaurant || "BonBox" }),
        text: message,
      });
    } catch {
      // The owner closed the OS share sheet — nothing failed, nothing to say.
      return;
    }
  };

  return (
    <Sheet
      onClose={onClose}
      ariaLabel={t("staffInviteTitle", { name })}
      panelClassName="bg-white dark:bg-gray-800 shadow-sm border-t sm:border border-gray-200 dark:border-gray-700"
    >
      <div className="overflow-y-auto" data-testid="staff-invite-sheet">
        <div className="p-5 pb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("staffInviteTitle", { name })}
            </h3>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1 leading-snug">
              {t("staffInviteSub", { name })}
            </p>
            <StaffReachStatus lastAccessed={lastAccessed} className="mt-2" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="shrink-0 -mr-2 -mt-1 w-10 h-10 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-700"
          >
            <Icon name="X" size={18} />
          </button>
        </div>

        {loading || !link?.url ? (
          <div className="flex justify-center py-8" role="status" aria-label={t("staffInvitePreparing")}>
            <Icon name="Loader" size={20} className="animate-spin text-gray-400" />
          </div>
        ) : (
          <>
            {/* 1 — send it. Three equal doors, no "primary" among them: which
                one is right depends on how this team talks, not on us. */}
            <div className={`px-5 grid gap-2 ${sms ? "grid-cols-3" : "grid-cols-2"}`}>
              {sms && (
                <a href={smsHref(member.phone, message)} className={CHANNEL} data-channel="sms">
                  <Icon name="MessageSquare" size={18} className="text-gray-500 dark:text-gray-400" />
                  {t("staffInviteSms")}
                </a>
              )}
              <a
                href={whatsappHref(member.phone, message)}
                target="_blank"
                rel="noopener noreferrer"
                className={CHANNEL}
                data-channel="whatsapp"
              >
                <Icon name="MessageCircle" size={18} className="text-gray-500 dark:text-gray-400" />
                {t("staffInviteWhatsapp")}
              </a>
              <button type="button" onClick={copyMessage} className={CHANNEL} data-channel="copy">
                <Icon name={copied === "msg" ? "Check" : "Copy"} size={18} className="text-gray-500 dark:text-gray-400" />
                {copied === "msg" ? t("copied") : t("schedCopyBtn")}
              </button>
            </div>
            <p className="px-5 mt-2 text-[12px] text-gray-500 dark:text-gray-400 leading-snug">
              {t("staffInviteOwnPhone")}
              {canNativeShare && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={nativeShare}
                    className="font-medium text-gray-700 dark:text-gray-200 underline underline-offset-2"
                  >
                    {t("staffInviteOtherWay")}
                  </button>
                </>
              )}
            </p>
            {copied === "fail" && (
              <p className="px-5 mt-1 text-[12px] text-red-700 dark:text-red-400" role="alert">
                {t("firstStepsCopyFailed")}
              </p>
            )}

            {/* 2 — in person: QR to scan, or the app + the code. */}
            <div className="mx-5 mt-4 rounded-xl border border-gray-200 dark:border-gray-700 p-3.5 flex gap-3.5">
              <div className="shrink-0 rounded-lg bg-white p-1.5 border border-gray-200 dark:border-gray-600 self-start">
                <QRCodeSVG value={link.url} size={84} level="M" aria-label={t("firstStepsQrAria")} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("staffInviteCodeLabel")}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  <span
                    className="font-mono text-xl font-semibold tracking-[0.18em] text-gray-900 dark:text-gray-100"
                    data-testid="staff-invite-code"
                  >
                    {link.code || "—"}
                  </span>
                  {link.code && (
                    <button
                      type="button"
                      onClick={copyCode}
                      aria-label={`${t("schedCopyJoinCode")} — ${member.name}`}
                      className="w-10 h-10 inline-flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Icon name={copied === "code" ? "Check" : "Copy"} size={16} />
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400 leading-snug">
                  {t("staffInviteInPerson", { name })}
                </p>
                <a
                  href={VAGTPLAN_APP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-gray-700 dark:text-gray-200 hover:underline underline-offset-2"
                >
                  {t("staffInviteGetApp")}
                  <Icon name="ExternalLink" size={12} />
                </a>
              </div>
            </div>

            {/* The bare link, for anyone who wants only the URL (the old
                dialog's "Kopiér" copied just this). */}
            <div className="mx-5 mt-3 flex items-center gap-1 rounded-lg bg-gray-50 dark:bg-gray-900/40 pl-3">
              <p
                className="min-w-0 flex-1 py-2 font-mono text-[11px] text-gray-500 dark:text-gray-400 break-all select-all"
                data-testid="staff-invite-url"
              >
                {link.url}
              </p>
              <button
                type="button"
                onClick={copyUrl}
                aria-label={copied === "url" ? t("firstStepsCopied") : t("firstStepsCopy")}
                title={t("firstStepsCopy")}
                className="shrink-0 w-10 h-10 inline-flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Icon name={copied === "url" ? "Check" : "Copy"} size={14} />
              </button>
            </div>
            <p className="px-5 pt-3 pb-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
              {t("schedPortalNoAccount")}
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
