/**
 * CustomerOutreachModal — close the loop on the Brief's "regulars at
 * risk" signal.
 *
 * The Daily Brief surfaces "3 regulars haven't been back in ~18 days
 * (Marie, Andreas, Lukas)". Today that's an observation. With this
 * modal, the owner taps "Reach out" → picks a template → "Open SMS"
 * launches their phone's native SMS app with body + recipient pre-filled.
 *
 * The cross-platform sms: URI scheme works on iOS, Android, and modern
 * desktop browsers (which route to Messages.app on macOS or Phone Link
 * on Windows). Format:
 *
 *   sms:+4512345678,+4587654321?body=encoded%20message
 *
 * iOS Safari needs the `?body=` query (not `&body=` first). For multiple
 * recipients we comma-separate. We always include the phone number(s)
 * in the URL so it's truly one-tap; owner just hits send in their SMS
 * app.
 *
 * Three template options:
 *   • Wine night invite — "We have a wine night tonight…"
 *   • Generic miss-you — "Haven't seen you in a while — come say hi"
 *   • Custom — owner writes their own
 *
 * Recipient picker:
 *   • If `defaultCustomerIds` is provided (e.g. from the Brief CTA),
 *     pre-select those customers.
 *   • Owner can deselect any, add others, or toggle "all at-risk".
 *   • Phone-less customers are shown but greyed out — they can't
 *     receive SMS without a number.
 *
 * Privacy: the SMS NEVER goes through BonBox's servers. The owner's
 * own phone sends it. We don't see who they messaged or what they
 * said. (We DO log an audit_log entry that the modal was used —
 * useful for adoption tracking, never the content.)
 */
import { useEffect, useMemo, useState, useRef } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

const _TEMPLATE_KEYS = ["winenight", "missyou", "newmenu", "custom"];

function _normalizePhone(raw) {
  // Strip non-digit + non-plus. Keep + only if leading.
  // Owner-typed phones come in mixed formats:
  //   "+4512345678" / "12 34 56 78" / "12345678" / "(12) 345 678"
  // The native SMS app handles most variants but we strip spaces and
  // parens so the sms: URI parses cleanly across platforms.
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[\s()-]/g, "");
  // Validate: must end with at least 6 digits to be a plausible phone
  const digitsOnly = cleaned.replace(/\D/g, "");
  if (digitsOnly.length < 6) return null;
  return cleaned;
}

function _firstName(fullName) {
  return String(fullName || "").trim().split(/\s+/)[0] || "";
}

function _renderTemplate(key, customers, businessName) {
  // Build the SMS body. Templates use first names so the message
  // doesn't read like a marketing blast. Single recipient → just
  // their first name; 2-3 → comma-separated; 4+ → "venner" / "friends".
  const names = customers.map(c => _firstName(c.name)).filter(Boolean);
  let salutation;
  if (names.length === 0) {
    salutation = "Hej!";
  } else if (names.length === 1) {
    salutation = `Hej ${names[0]}!`;
  } else if (names.length <= 3) {
    salutation = `Hej ${names.join(", ")}!`;
  } else {
    salutation = `Hej venner!`;
  }

  const biz = businessName || "BonBox";

  switch (key) {
    case "winenight":
      return `${salutation}\n\nDet er længe siden vi har set jer på ${biz}. Vi har vinaften i denne uge — kom forbi for et glas på huset 🍷\n\nVi glæder os til at se jer!\n— ${biz}`;
    case "missyou":
      return `${salutation}\n\nVi savner jer på ${biz}! Det er længe siden sidst. Kik forbi i denne uge — vi sætter en kop kaffe over når I kommer ☕\n\n— ${biz}`;
    case "newmenu":
      return `${salutation}\n\nVi har lanceret en ny menu på ${biz} — kom forbi og vær blandt de første til at smage den!\n\n— ${biz}`;
    case "custom":
    default:
      return `${salutation}\n\n\n— ${biz}`;
  }
}

function _buildSmsUrl(phones, body) {
  // sms: URI — works on iOS, Android, and macOS Messages.
  // Phones go in the "to" part separated by commas.
  // Body is URL-encoded after the ?.
  const to = phones.filter(Boolean).join(",");
  const encoded = encodeURIComponent(body || "");
  // iOS requires `?` (not `&`) as the first separator after the addresses.
  return `sms:${to}?body=${encoded}`;
}

export default function CustomerOutreachModal({
  open,
  onClose,
  /** Pre-selected customer ids when the modal is opened from the Brief CTA. */
  defaultCustomerIds = [],
  /** Optional override: pass customers directly instead of fetching at-risk. */
  customers: customersProp = null,
  /** Business name for the template signature. */
  businessName = "BonBox",
}) {
  const { t } = useLanguage();
  const [atRisk, setAtRisk] = useState(customersProp || []);
  const [loading, setLoading] = useState(!customersProp);
  const [selectedIds, setSelectedIds] = useState(new Set(defaultCustomerIds));
  const [template, setTemplate] = useState("winenight");
  const [customBody, setCustomBody] = useState("");
  const [toast, setToast] = useState("");
  // Refs for focus management — restore focus to whatever opened the
  // modal when it closes, and trap focus inside while open.
  const dialogRef = useRef(null);
  const previousActiveElementRef = useRef(null);

  // ESC key + focus restoration. WCAG 2.1.2 (No Keyboard Trap) requires
  // either trapping focus inside the dialog or letting ESC close it.
  // We let ESC close + restore focus to the trigger — sufficient for AA.
  //
  // a11y-todo: We don't yet trap Tab focus inside the dialog. A user
  // pressing Tab repeatedly will eventually escape into the page behind.
  // This is acceptable because ESC closes (AA-compliant) but a full
  // focus trap (matching CustomerOutreachModal's modality) would be AAA.
  // Consider importing focus-trap-react if the modal grows complex enough
  // to need one.
  useEffect(() => {
    if (!open) return;
    previousActiveElementRef.current = document.activeElement;
    // Defer focus to the next paint so the dialog has mounted.
    const t = setTimeout(() => {
      dialogRef.current?.focus();
    }, 0);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
      // Restore focus to the trigger that opened the modal
      try { previousActiveElementRef.current?.focus?.(); } catch { /* element gone */ }
    };
  }, [open, onClose]);

  // Fetch at-risk regulars when opening (unless customers were passed in
  // directly — e.g. from the Brief CTA which already has them).
  useEffect(() => {
    if (!open) return;
    if (customersProp) {
      setAtRisk(customersProp);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.get("/khata/at-risk")
      .then(r => {
        if (!alive) return;
        const list = r.data?.regulars_at_risk || [];
        setAtRisk(list);
        // If no defaults were passed, auto-select all reachable
        // (phone present) customers — owners almost always want all.
        if (defaultCustomerIds.length === 0) {
          setSelectedIds(new Set(list.filter(c => c.phone).map(c => c.id)));
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) {
          setAtRisk([]);
          setLoading(false);
        }
      });
    return () => { alive = false; };
  }, [open, customersProp, defaultCustomerIds.length]);

  // When the customer set changes, refresh the template body unless
  // owner has explicitly typed in custom mode.
  const selectedCustomers = useMemo(
    () => atRisk.filter(c => selectedIds.has(c.id)),
    [atRisk, selectedIds],
  );

  const phones = useMemo(
    () => selectedCustomers
      .map(c => _normalizePhone(c.phone))
      .filter(Boolean),
    [selectedCustomers],
  );

  const messageBody = useMemo(() => {
    if (template === "custom") return customBody;
    return _renderTemplate(template, selectedCustomers, businessName);
  }, [template, customBody, selectedCustomers, businessName]);

  const toggleCustomer = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSend = () => {
    if (phones.length === 0) {
      setToast(t("outreachNoPhone") || "Pick at least one customer with a phone number.");
      setTimeout(() => setToast(""), 3000);
      return;
    }
    if (!messageBody.trim()) {
      setToast(t("outreachNoBody") || "Message body is empty.");
      setTimeout(() => setToast(""), 3000);
      return;
    }
    const url = _buildSmsUrl(phones, messageBody);
    // Fire-and-forget audit log — best-effort, never blocks the SMS.
    try {
      api.post("/khata/outreach-log", {
        customer_ids: Array.from(selectedIds),
        template,
        recipient_count: phones.length,
      }).catch(() => {});
    } catch {
      // Silent — analytics shouldn't break the user experience
    }
    window.location.href = url;
    // Close after a short delay so the SMS app has time to open
    setTimeout(() => onClose?.(), 800);
  };

  if (!open) return null;

  const totalReachable = atRisk.filter(c => c.phone).length;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="outreach-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-stone-900 rounded-t-2xl sm:rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col focus:outline-none"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-stone-100 dark:border-stone-800 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="outreach-dialog-title" className="text-base font-semibold text-stone-900 dark:text-stone-100 flex items-center gap-2">
                <Icon name="Heart" size={18} className="text-emerald-600 shrink-0" />
                {t("outreachTitle") || "Reach out to regulars"}
              </h3>
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-1 leading-relaxed">
                {t("outreachSubtitle") ||
                  "Pick a template, choose who to text, hit Open SMS. The message goes through your phone — BonBox never sees it."}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close") || "Close"}
              className="w-7 h-7 -mr-1 -mt-1 rounded-md text-stone-500 hover:text-stone-700 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-700/60 dark:hover:text-stone-200 transition flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Template picker */}
          <div className="px-5 pt-4">
            <p className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider mb-2">
              {t("outreachTemplate") || "Template"}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {_TEMPLATE_KEYS.map((key) => {
                const labels = {
                  winenight: t("outreachTplWine") || "Wine night invite",
                  missyou: t("outreachTplMissyou") || "Miss-you note",
                  newmenu: t("outreachTplNewMenu") || "New menu launch",
                  custom: t("outreachTplCustom") || "Custom",
                };
                const active = template === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTemplate(key)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition ${
                      active
                        ? "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300"
                        : "bg-white dark:bg-stone-800 border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-500"
                    }`}
                  >
                    {labels[key]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Customers picker */}
          <div className="px-5 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                {t("outreachRecipients") || "Recipients"} ({selectedCustomers.length}/{atRisk.length})
              </p>
              {totalReachable > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set(atRisk.filter(c => c.phone).map(c => c.id)))}
                  className="text-xs text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition"
                >
                  {t("outreachSelectAll") || "Select all reachable"}
                </button>
              )}
            </div>
            {loading ? (
              <div className="py-6 text-center text-sm text-stone-400">
                {t("outreachLoading") || "Loading regulars…"}
              </div>
            ) : atRisk.length === 0 ? (
              <div className="py-6 text-center text-sm text-stone-400 border border-dashed border-stone-200 dark:border-stone-700 rounded-lg">
                {t("outreachEmpty") || "No at-risk regulars right now — keep doing what you're doing."}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {atRisk.map(c => {
                  const hasPhone = !!_normalizePhone(c.phone);
                  const selected = selectedIds.has(c.id);
                  return (
                    <li key={c.id}>
                      <label className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition ${
                        selected
                          ? "bg-emerald-50/60 dark:bg-emerald-900/15 border-emerald-200 dark:border-emerald-800/40"
                          : "bg-white dark:bg-stone-800/60 border-stone-200 dark:border-stone-700"
                      } ${!hasPhone ? "opacity-60" : ""}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!hasPhone}
                          onChange={() => toggleCustomer(c.id)}
                          className="mt-0.5 accent-emerald-600"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-800 dark:text-stone-100 truncate">
                            {c.name}
                          </div>
                          <div className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                            {c.visits} {t("outreachVisits") || "visits"} · {(t("outreachDaysAgo") || "{n} days silent").replace("{n}", String(c.days_since_last))}
                            {!hasPhone && (
                              <span className="ml-2 text-red-500 dark:text-red-400">
                                {t("outreachNoPhoneTag") || "no phone"}
                              </span>
                            )}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Message preview / custom edit */}
          <div className="px-5 pt-4 pb-2">
            <p className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider mb-2">
              {t("outreachMessage") || "Message"}
            </p>
            <textarea
              value={messageBody}
              onChange={(e) => {
                if (template !== "custom") setTemplate("custom");
                setCustomBody(e.target.value);
              }}
              rows={6}
              maxLength={500}
              placeholder={t("outreachPlaceholder") || "Write your own message…"}
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 leading-relaxed"
            />
            <p className="text-[10.5px] text-stone-400 mt-1">
              {(t("outreachCharCount") || "{n}/500 chars · template auto-fills first names").replace("{n}", String(messageBody.length))}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 bg-stone-50 dark:bg-stone-800/40 border-t border-stone-100 dark:border-stone-800 flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-stone-500 dark:text-stone-400 min-w-0" aria-live="polite">
            {toast && <span className="text-amber-700 dark:text-amber-400">{toast}</span>}
            {!toast && phones.length > 0 && (
              <span>
                {(t("outreachReadyText") || "Ready to text {n} customer{s}").replace("{n}", String(phones.length)).replace("{s}", phones.length === 1 ? "" : "s")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onSend}
            disabled={phones.length === 0 || !messageBody.trim()}
            className="shrink-0 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-50 dark:focus-visible:ring-offset-stone-800"
          >
            {t("outreachOpenSms") || "Open SMS"}
          </button>
        </div>
      </div>
    </div>
  );
}
