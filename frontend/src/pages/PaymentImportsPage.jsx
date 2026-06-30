/**
 * PaymentImportsPage — v2 (2026-05-25, Manoj DK-only + doctrine reframe)
 *
 * What changed vs v1 (commit 1667792):
 *   • The page is now mobile-first, doctrine-compliant: PageShell +
 *     PageHeader + Card primitives, gray-900 primary buttons,
 *     Lucide icons everywhere, no rainbow color, no raw emojis in
 *     UI chrome (the MobilePay phone icon was the worst offender —
 *     it pretended to be a logo but read as a Slack reaction).
 *   • CSV upload is now FIRST-CLASS, not a footnote. Research:
 *     ~80% of DK small organizers never enable MobilePay's developer
 *     API — they export the CSV from the MobilePay Business app
 *     (Settings → Transactions → Export). The backend bank CSV
 *     parser now recognises MobilePay Erhverv exports natively, so
 *     /bank-import is the actual workflow for that population.
 *     The Vipps API path is preserved as the "if you have keys"
 *     advanced route; it's powerful (auto-sync nightly) but it's
 *     not the realistic entry point for a café owner.
 *   • Booking-match review (CSV-to-booking auto-match) preserved
 *     verbatim — that's the event-booking reconciliation surface
 *     and it's already doctrine-clean.
 *
 * Honest competitor framing (Dinero, Billy, e-conomic):
 *   • Dinero: MobilePay shown as a connection card, but the actual
 *     reconciliation is CSV + nightly bank import. Same as us.
 *   • Billy: routes everything through their "Indkomstkonto" — the
 *     owner picks a bank statement file and Billy matches by
 *     reference text. They DON'T have a separate MobilePay page.
 *   • e-conomic: full bank-feed integration via DanID; MobilePay is
 *     a transaction line under the bank, never its own surface.
 *   Conclusion: a separate MobilePay "Connect" page is mostly
 *   surface noise. We keep ONE connect card (Vipps direct, real value
 *   when keys exist) and lean hard on CSV upload as the everyday
 *   path. v3 collapses this page into /bank-import entirely.
 *
 * Tier rule: Free / Starter / Pro all see the same surfaces — the
 * connect-API path is the same complexity in all tiers (server
 * enforces the right entitlements where needed).
 *
 * Aiia / PSD2 status: the integration spec exists (see
 * docs/aiia-integration-spec.md) but is feature-flagged off by
 * default (useFeatures().bank_connect_enabled). When it ships,
 * /bank-import is the natural home for it — NOT this page. This
 * page stays focused on "I have a MobilePay CSV or a Vipps API key".
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  CreditCard,
  FileText,
  ArrowRight,
  Smartphone,
  Zap,
  Check,
  AlertCircle,
  ExternalLink,
  ChevronLeft,
  Loader2,
  X,
} from "lucide-react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { safeExternalUrl } from "../utils/safeUrl";
import PageShell from "../components/ui/PageShell";
import PageHeader from "../components/ui/PageHeader";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import DataTable from "../components/ui/DataTable";

// Country labels reduced to DK-only (Manoj 2026-05-25 lock).
// Non-DK providers stay readable in the backend for already-connected
// users but are filtered out of the connect picker.
const COUNTRY_LABELS = { DK: "Denmark" };

/* ─── Field validators ─ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_VALIDATORS = {
  vipps_mobilepay: {
    merchant_serial:  { regex: /^\d{6,8}$/,           hintKey: "fmtMsn" },
    client_id:        { regex: UUID_RE,               hintKey: "fmtUuid" },
    client_secret:    { minLength: 40,                hintKey: "fmtLong" },
    subscription_key: { minLength: 32,                hintKey: "fmtSubKey" },
  },
};
function checkField(providerId, fieldKey, value) {
  const rule = FIELD_VALIDATORS[providerId]?.[fieldKey];
  if (!rule) return { state: "neutral" };
  if (!value) return { state: "neutral" };
  if (rule.regex && !rule.regex.test(value)) return { state: "warn", hintKey: rule.hintKey };
  if (rule.minLength && value.length < rule.minLength) return { state: "warn", hintKey: rule.hintKey };
  return { state: "ok" };
}

/* ─── Smart Paste ─────────────────────────────────────────────────── */
function smartPasteParse(text, providerId) {
  if (!text || !text.trim()) return null;
  const tokens = text
    .split(/[\s\n,;=]+/)
    .map((t) => t.replace(/^["'`]+|["'`]+$/g, "").replace(/^.*?:/, "").trim())
    .filter((t) => t.length >= 4);

  if (providerId === "vipps_mobilepay") {
    const msn = tokens.find((t) => /^\d{6,8}$/.test(t)) || "";
    const uuid = tokens.find((t) => UUID_RE.test(t)) || "";
    const longs = tokens.filter(
      (t) => t.length >= 32 && t !== msn && t !== uuid && !UUID_RE.test(t)
    );
    longs.sort((a, b) => a.length - b.length);
    const sub = longs[0] || "";
    const sec = longs.find((t) => t !== sub) || "";
    const filled = { merchant_serial: msn, client_id: uuid, subscription_key: sub, client_secret: sec };
    const found = Object.values(filled).filter(Boolean).length;
    return { creds: filled, found, total: 4 };
  }
  return null;
}

/* ─── Setup Wizard (Vipps API connect) ───────────────────────────── */
function SetupWizard({ provider, onDone, onCancel, t }) {
  const [step, setStep] = useState(0); // 0 = intro, 1 = fields, 2 = testing
  const [creds, setCreds] = useState({});
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pasteAck, setPasteAck] = useState(null);
  const [pasteText, setPasteText] = useState("");

  const allFieldsFilled = provider.fields.every(
    (f) => (creds[f.key] || "").trim().length > 0
  );
  const supportsSmartPaste = !!FIELD_VALIDATORS[provider.id];

  const handleSmartPaste = (text) => {
    setPasteText(text);
    if (!text.trim()) { setPasteAck(null); return; }
    const result = smartPasteParse(text, provider.id);
    if (!result) return;
    setCreds((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(result.creds)) {
        if (!prev[k] && v) next[k] = v;
      }
      return next;
    });
    setPasteAck({ found: result.found, total: result.total });
  };
  const clearSmartPaste = () => { setPasteText(""); setPasteAck(null); };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setStep(2);
    try {
      const res = await api.post("/payment-import/connect", {
        provider: provider.id,
        label: label || provider.name,
        credentials: creds,
      });
      onDone(res.data);
    } catch (err) {
      setError(errText(err, t("connectionFailedDoubleCheck") || "Connection failed. Double-check your keys and try again."));
      setStep(1);
    }
    setSaving(false);
  };

  // Step 0: intro
  if (step === 0) {
    return (
      <Card>
        <Card.Header
          icon={<Smartphone size={18} />}
          title={`${t("connect") || "Connect"} ${provider.name}`}
          subtitle={
            provider.setup_time
              ? (t("takesAbout") || "Takes about {time}").replace("{time}", provider.setup_time)
              : null
          }
        />
        <div className="space-y-5">
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              {t("hereIsWhatYoullDo") || "Here's what you'll do:"}
            </h4>
            <div className="space-y-2.5">
              {(provider.setup_steps || []).map((step, i) => (
                <div key={i} className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 flex items-center justify-center text-xs font-bold">
                    {i + 1}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 pt-0.5">{step}</p>
                </div>
              ))}
            </div>
          </div>

          {safeExternalUrl(provider.portal_url) && (
            <a
              href={safeExternalUrl(provider.portal_url)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition group border border-gray-200 dark:border-gray-700"
            >
              <div className="w-8 h-8 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0 text-gray-500">
                <ExternalLink size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                  {(t("openPortal") || "Open {portal}").replace("{portal}", provider.portal_name || provider.name)}
                </p>
                <p className="text-xs text-gray-400 truncate">{provider.portal_url.replace("https://", "")}</p>
              </div>
              <ChevronLeft className="rotate-180 text-gray-300 dark:text-gray-500 group-hover:text-gray-500" size={14} />
            </a>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("keysStoredSecurely") || "Your keys are stored securely and only used to fetch your transactions. BonBox never stores your customers' payment details."}
          </p>

          <div className="flex gap-3 pt-1">
            <Button variant="primary" size="lg" onClick={() => setStep(1)} className="flex-1">
              {t("iHaveKeysLetsGo") || "I have my keys — let's go"}
            </Button>
            <Button variant="ghost" size="lg" onClick={onCancel}>
              {t("cancel") || "Cancel"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // Step 2: testing
  if (step === 2) {
    return (
      <Card>
        <div className="py-8 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <Loader2 className="animate-spin text-gray-700 dark:text-gray-300" size={22} />
          </div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {(t("connectingTo") || "Connecting to {provider}...").replace("{provider}", provider.name)}
          </p>
          <p className="text-xs text-gray-400 mt-1">{t("verifyingYourKeys") || "Verifying your keys"}</p>
        </div>
      </Card>
    );
  }

  // Step 1: credentials
  return (
    <Card>
      <Card.Header
        icon={
          <button
            onClick={() => setStep(0)}
            className="w-7 h-7 -ml-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center text-gray-500 transition"
            aria-label={t("back") || "Back"}
          >
            <ChevronLeft size={16} />
          </button>
        }
        title={(t("enterYourKeysFor") || "Enter your {provider} keys").replace("{provider}", provider.name)}
        subtitle={(t("pasteThemFromPortal") || "Paste them from the {portal}").replace("{portal}", provider.portal_name || "portal")}
        action={
          safeExternalUrl(provider.portal_url) && (
            <a
              href={safeExternalUrl(provider.portal_url)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white font-medium flex items-center gap-1"
            >
              {t("openPortalShort") || "Open portal"}
              <ExternalLink size={11} />
            </a>
          )
        }
      />

      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">
            {t("nameConnection") || "Name this connection (optional)"}
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("connectionNameExample") || `e.g. "My café" or "Main store"`}
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 outline-none transition"
          />
        </div>

        {supportsSmartPaste && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-3.5">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
                <Zap size={12} className="text-gray-500" />
                {t("smartPasteTitle") || "Paste all keys at once"}
              </label>
              {pasteText && (
                <button
                  onClick={clearSmartPaste}
                  className="text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 font-medium flex items-center gap-1"
                >
                  <X size={10} />
                  {t("clear") || "Clear"}
                </button>
              )}
            </div>
            <textarea
              value={pasteText}
              onChange={(e) => handleSmartPaste(e.target.value)}
              rows={3}
              placeholder={t("smartPastePlaceholder") || "Paste your 4 keys (or the whole block from the portal) — BonBox sorts them into the right fields"}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs text-gray-800 dark:text-gray-200 font-mono focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 outline-none transition resize-none"
            />
            {pasteAck && (
              <p className={`text-[11px] mt-1.5 font-medium flex items-center gap-1 ${pasteAck.found === pasteAck.total ? "text-gray-700 dark:text-gray-300" : "text-amber-600 dark:text-amber-400"}`}>
                {pasteAck.found === pasteAck.total
                  ? <Check size={11} className="text-emerald-600 dark:text-emerald-400" />
                  : <AlertCircle size={11} className="text-amber-500" />}
                {pasteAck.found === pasteAck.total
                  ? t("smartPasteAllFilled", { n: pasteAck.total })
                  : t("smartPastePartialFilled", { found: pasteAck.found, total: pasteAck.total })
                }
              </p>
            )}
          </div>
        )}

        {provider.fields.map((field, idx) => {
          const value = creds[field.key] || "";
          const check = checkField(provider.id, field.key, value);
          const borderClass =
            check.state === "warn" ? "border-amber-300 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-900/10"
                                   : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800";
          const formatHint = check.state === "warn" && check.hintKey ? (t(check.hintKey) || "")  : "";
          return (
            <div key={field.key}>
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 flex items-center justify-center text-[10px] font-bold shrink-0">
                  {idx + 1}
                </span>
                {field.label}
                {check.state === "ok" && (
                  <span className="ml-auto text-[11px] text-gray-700 dark:text-gray-300 font-semibold flex items-center gap-0.5">
                    <Check size={11} className="text-emerald-600 dark:text-emerald-400" />
                    {t("looksGood") || "Looks good"}
                  </span>
                )}
              </label>
              <input
                type={field.type}
                value={value}
                onChange={(e) => setCreds({ ...creds, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className={`w-full px-3 py-2.5 rounded-lg border text-sm text-gray-800 dark:text-gray-200 font-mono focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 outline-none transition ${borderClass}`}
              />
              {formatHint && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 ml-0.5 flex items-center gap-1">
                  <AlertCircle size={10} />
                  {formatHint}
                </p>
              )}
              {!formatHint && field.help && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 ml-0.5">
                  {field.help}
                </p>
              )}
            </div>
          );
        })}

        {error && (
          <div className="flex items-start gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl">
            <AlertCircle size={14} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-red-700 dark:text-red-400 font-medium">{error}</p>
              <p className="text-xs text-red-500 dark:text-red-500 mt-0.5">
                {t("connFailHint") || "Make sure you copied the full value with no extra spaces."}
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button
            variant="primary"
            size="lg"
            onClick={handleSave}
            disabled={!allFieldsFilled || saving}
            busy={saving}
            iconLeft={<Zap size={14} />}
            className="flex-1"
          >
            {t("testAndConnect") || "Test & Connect"}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {t("cancel") || "Cancel"}
          </Button>
        </div>
      </div>
    </Card>
  );
}


/* ─── Booking-matches review ───────────────────────────────────────── */
function BookingMatchesReview(props) {
  const key = props.importId ?? "_no_id";
  return <BookingMatchesReviewInner key={key} {...props} />;
}

function BookingMatchesReviewInner({ bookingMatches, importId, onAfterConfirm, t }) {
  const [busy, setBusy] = useState(null);
  const [localState, setLocalState] = useState(bookingMatches || null);

  if (!localState) return null;
  const auto = Array.isArray(localState.auto_confirmed) ? localState.auto_confirmed : [];
  const review = Array.isArray(localState.needs_review) ? localState.needs_review : [];
  if (auto.length === 0 && review.length === 0) return null;

  const handleConfirm = async (rowIdx, bookingId) => {
    if (!importId) return;
    setBusy(rowIdx);
    try {
      await api.post(`/payment-import/${importId}/confirm-match`, {
        csv_row_index: rowIdx,
        booking_id: bookingId,
        action: "confirm",
      });
      setLocalState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          needs_review: prev.needs_review.filter((r) => r.csv_row_index !== rowIdx),
        };
      });
      if (typeof onAfterConfirm === "function") onAfterConfirm();
    } catch { /* parent handles */ }
    setBusy(null);
  };

  const handleSkip = async (rowIdx) => {
    if (!importId) return;
    setBusy(rowIdx);
    try {
      await api.post(`/payment-import/${importId}/confirm-match`, {
        csv_row_index: rowIdx,
        action: "skip",
      });
      setLocalState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          needs_review: prev.needs_review.filter((r) => r.csv_row_index !== rowIdx),
        };
      });
      if (typeof onAfterConfirm === "function") onAfterConfirm();
    } catch { /* see above */ }
    setBusy(null);
  };

  const confidenceDotClass = (c) => {
    if (c === "high") return "bg-emerald-500";
    if (c === "medium") return "bg-amber-500";
    return "bg-gray-400";
  };

  const autoColumns = [
    { id: "csv_row", label: t("bookingMatchesCsvRow", "CSV linje"),
      render: (r) => <span className="tabular-nums text-gray-700 dark:text-gray-300">#{r.csv_row_index}</span> },
    { id: "booking_id", label: t("bookingMatchesBooking", "Booking"),
      render: (r) => {
        const id = String(r.booking_id || "");
        const href = r.event_id ? `/events/${r.event_id}#booking-${id}` : `#booking-${id}`;
        return (
          <Link to={href} className="text-gray-900 dark:text-gray-100 hover:underline">
            #{id.slice(0, 8)}
          </Link>
        );
      } },
    { id: "sale", label: t("bookingMatchesSale", "Salg"),
      render: (r) => <span className="text-gray-700 dark:text-gray-300">{r.bilagsnummer || "—"}</span> },
  ];

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 mt-4 pt-4">
      <Card>
        <Card.Header
          title={t("bookingMatchesTitle", "Booking matches")}
          subtitle={t(
            "bookingMatchesSubtitle",
            "{auto} auto-bekræftet · {review} til gennemgang",
            { auto: auto.length, review: review.length },
          )}
        />

        {auto.length > 0 && (
          <details className="group" {...(auto.length <= 5 ? { open: true } : {})}>
            <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100 select-none">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" aria-hidden="true" />
                {t("bookingMatchesAutoConfirmed", "Auto-bekræftet")}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{auto.length}</span>
            </summary>
            <div className="mt-3">
              <DataTable
                columns={autoColumns}
                rows={auto}
                rowKey={(r) => r.booking_id || r.csv_row_index}
              />
            </div>
          </details>
        )}

        {review.length > 0 && (
          <div className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingMatchesNeedsReview", "Til gennemgang")}
            </h3>
            {review.map((row) => (
              <Card key={row.csv_row_index} variant="subtle">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {row.csv_line?.amount} kr · {row.csv_line?.sender_name || "—"}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {[row.csv_line?.comment, row.csv_line?.date].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 shrink-0 tabular-nums">
                    {t("bookingMatchesCsvRow", "CSV linje")} #{row.csv_row_index}
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {(row.candidates || []).map((c) => (
                    <div
                      key={c.booking_id}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800"
                    >
                      <div className="min-w-0">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300">
                          <span
                            className={`w-1.5 h-1.5 rounded-full inline-block ${confidenceDotClass(c.confidence)}`}
                            aria-hidden="true"
                          />
                          {t(`bookingMatchesConfidence${(c.confidence || "low").replace(/^./, x => x.toUpperCase())}`, c.confidence || "low")}
                        </span>
                        <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                          {t("bookingMatchesBooking", "Booking")} #{String(c.booking_id || "").slice(0, 8)}
                        </p>
                        {c.reason && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {c.reason}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleConfirm(row.csv_row_index, c.booking_id)}
                        busy={busy === row.csv_row_index}
                      >
                        {t("bookingMatchConfirm", "Bekræft")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSkip(row.csv_row_index)}
                    disabled={busy === row.csv_row_index}
                  >
                    {t("bookingMatchSkip", "Spring over — ikke en booking")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}


/* ─── Connected Provider Card ──────────────────────────────────────── */
function ConnectedCard({ conn, provider, onDisconnect, onSync, onToggleAutoSync, syncing, syncResult, onConfirmImport, confirming, importResult, onMatchUpdated, t }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [showManual, setShowManual] = useState(false);
  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

  const isSyncing = syncing === conn.id;

  const handleSync = () => {
    setSelected(new Set());
    onSync(conn, dateFrom, dateTo, (txns) => {
      setSelected(new Set(txns.map((_, i) => i)));
    });
  };

  const toggleSelect = (i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 dark:text-gray-400 shrink-0">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{conn.label}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5 truncate">
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${conn.auto_sync ? "bg-emerald-500" : "bg-gray-400"}`} />
              {provider?.name || conn.provider}
              {conn.last_synced_at && (
                <span className="ml-1 truncate">
                  · {t("piSyncedLabel") || "Synced"} {new Date(conn.last_synced_at).toLocaleDateString()}
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => onDisconnect(conn.id)}
          className="text-xs text-gray-500 hover:text-red-600 transition font-medium shrink-0"
        >
          {t("disconnect") || "Disconnect"}
        </button>
      </div>

      {/* Auto-sync status */}
      <div className="flex items-center justify-between py-2.5 px-3.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 mb-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-800 dark:text-gray-200">
            {conn.auto_sync ? (t("autoImporting") || "Auto-importing new transactions") : (t("autoImportPaused") || "Auto-import paused")}
          </p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
            {conn.auto_sync
              ? conn.last_auto_imported > 0
                ? `${conn.last_auto_imported} new last sync`
                : (t("checksEvery6h") || "Checks every 6 hours")
              : (t("turnOnToImportAutomatically") || "Turn on to import automatically")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggleAutoSync(conn.id, !conn.auto_sync)}
          role="switch"
          aria-checked={conn.auto_sync}
          className={`relative rounded-full transition-colors shrink-0 ${conn.auto_sync ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
          style={{ minWidth: "40px", height: "22px" }}
        >
          <span
            className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform ${conn.auto_sync ? "left-[20px]" : "left-[2px]"}`}
          />
        </button>
      </div>

      {/* Manual sync */}
      <button
        onClick={() => setShowManual(!showManual)}
        className="text-xs text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white font-medium flex items-center gap-1 mb-2"
      >
        <ChevronLeft className={`transition-transform ${showManual ? "-rotate-90" : "rotate-180"}`} size={11} />
        {t("manualFetchForDates") || "Manual fetch for specific dates"}
      </button>
      {showManual && (
        <div className="flex flex-wrap items-end gap-2.5 mb-2">
          <div className="flex-1 min-w-[120px]">
            <label className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">
              {t("from") || "From"}
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="block w-full mt-0.5 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">
              {t("to") || "To"}
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full mt-0.5 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={handleSync}
            disabled={isSyncing}
            busy={isSyncing}
          >
            {isSyncing ? (t("fetching") || "Fetching...") : (t("syncNow") || "Fetch Transactions")}
          </Button>
        </div>
      )}

      {/* Sync result */}
      {syncResult && !syncResult.error && !importResult && (
        <div className="border-t border-gray-100 dark:border-gray-800 mt-3 pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{syncResult.total_count}</span>{" "}
              {t("transactionsFound") || "transactions found"}
              {syncResult.date_from && (
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                  {syncResult.date_from} — {syncResult.date_to}
                </span>
              )}
            </p>
            <label className="text-xs text-gray-700 dark:text-gray-300 cursor-pointer flex items-center gap-1">
              <input
                type="checkbox"
                checked={selected.size === syncResult.transactions.length}
                onChange={() => {
                  if (selected.size === syncResult.transactions.length) {
                    setSelected(new Set());
                  } else {
                    setSelected(new Set(syncResult.transactions.map((_, i) => i)));
                  }
                }}
              />
              {t("selectAll") || "Select all"}
            </label>
          </div>

          <div className="max-h-72 overflow-y-auto -mx-5 sm:-mx-6 border-y border-gray-100 dark:border-gray-800">
            {syncResult.transactions.map((txn, i) => (
              <div
                key={i}
                onClick={() => toggleSelect(i)}
                className={`flex items-center gap-3 px-5 sm:px-6 py-2.5 border-b border-gray-50 dark:border-gray-800/60 cursor-pointer transition ${
                  selected.has(i) ? "bg-gray-50 dark:bg-gray-800/60" : "hover:bg-gray-50 dark:hover:bg-gray-800/40"
                }`}
              >
                <input type="checkbox" checked={selected.has(i)} readOnly className="shrink-0 rounded" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{txn.description}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{txn.date}{txn.suggested_category && ` · ${txn.suggested_category}`}</p>
                </div>
                <span className={`text-sm font-semibold shrink-0 tabular-nums ${
                  txn.type === "income" ? "text-gray-900 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                }`}>
                  {txn.type === "income" ? "+" : "-"}{fmt(Math.abs(txn.amount))}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <Button
              variant="primary"
              size="lg"
              onClick={() => onConfirmImport(conn, syncResult.transactions.filter((_, i) => selected.has(i)))}
              disabled={confirming || selected.size === 0}
              busy={confirming}
              className="w-full"
            >
              {confirming
                ? (t("importing") || "Importing...")
                : `${t("importSelected") || "Import"} ${selected.size} ${t("transactions") || "transactions"}`}
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {syncResult?.error && (
        <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg">
          <AlertCircle size={14} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700 dark:text-red-400">{syncResult.error}</p>
        </div>
      )}

      {/* Booking matches */}
      {importResult?.booking_matches && (
        <BookingMatchesReview
          bookingMatches={importResult.booking_matches}
          importId={importResult.import_id || importResult.id}
          onAfterConfirm={onMatchUpdated}
          t={t}
        />
      )}

      {/* Import success */}
      {importResult && (
        <div className="mt-3 px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-center">
          <Check size={20} className="text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
          <p className="text-sm text-gray-900 dark:text-gray-100 font-semibold">
            {importResult.imported} {t("imported") || "imported"}
            {importResult.skipped > 0 && (
              <span className="text-gray-500 dark:text-gray-400 font-normal ml-1">({importResult.skipped} {t("duplicatesSkipped") || "duplicates skipped"})</span>
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("addedToCashbook") || "Added to your cash book"}</p>
        </div>
      )}
    </Card>
  );
}


/* ─── Main Page ────────────────────────────────────────────────────── */
export default function PaymentImportsPage() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [providers, setProviders] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);

  const [connectingProvider, setConnectingProvider] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const [syncResults, setSyncResults] = useState({});
  const [importResults, setImportResults] = useState({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get("/payment-import/providers"),
      api.get("/payment-import/connections"),
    ]).then(([pRes, cRes]) => {
      setProviders(pRes.data);
      setConnections(cRes.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleConnected = (newConn) => {
    setConnections((prev) => {
      const filtered = prev.filter((c) => c.id !== newConn.id);
      return [newConn, ...filtered];
    });
    setConnectingProvider(null);
  };

  const handleDisconnect = async (connId) => {
    if (!(await confirm({ message: t("confirmDisconnect") || "Remove this connection?", destructive: true }))) return;
    try {
      await api.delete(`/payment-import/connections/${connId}`);
      setConnections((prev) => prev.filter((c) => c.id !== connId));
    } catch { /* ignore */ }
  };

  const handleSync = async (conn, dateFrom, dateTo, onSelected) => {
    setSyncing(conn.id);
    setSyncResults((prev) => ({ ...prev, [conn.id]: null }));
    setImportResults((prev) => ({ ...prev, [conn.id]: null }));
    try {
      const params = {};
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      const res = await api.post(`/payment-import/sync/${conn.id}`, null, { params });
      setSyncResults((prev) => ({ ...prev, [conn.id]: res.data }));
      onSelected(res.data.transactions);
    } catch (err) {
      setSyncResults((prev) => ({ ...prev, [conn.id]: { error: errText(err, "Sync failed") } }));
    }
    setSyncing(null);
  };

  const handleConfirmImport = async (conn, txns) => {
    setConfirming(true);
    try {
      const res = await api.post("/payment-import/confirm", {
        connection_id: conn.id,
        transactions: txns,
      });
      setImportResults((prev) => ({ ...prev, [conn.id]: res.data }));
      setSyncResults((prev) => ({ ...prev, [conn.id]: null }));
    } catch { /* ignore */ }
    setConfirming(false);
  };

  const handleToggleAutoSync = async (connId, enabled) => {
    try {
      await api.patch(`/payment-import/connections/${connId}/auto-sync?enabled=${enabled}`);
      setConnections((prev) =>
        prev.map((c) => (c.id === connId ? { ...c, auto_sync: enabled } : c))
      );
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <PageShell width="narrow">
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-gray-500" size={28} />
        </div>
      </PageShell>
    );
  }

  // DK-only providers (Manoj 2026-05-25 lock)
  const dkProviders = providers.filter(
    (p) => Array.isArray(p.countries) && p.countries.includes("DK"),
  );
  const providersByCountry = dkProviders.length ? { DK: dkProviders } : {};

  return (
    <PageShell width="narrow">
      <PageHeader
        eyebrow="MONEY"
        title={t("paymentImports") || "Payment Imports"}
        subtitle={t(
          "paymentImportsSubtitleV2",
          "Most organizers upload the MobilePay or bank CSV — takes 30 seconds. Connect the API for nightly auto-sync if you have developer keys.",
        )}
      />

      {/* Setup Wizard (if connecting) — replaces everything else on the page */}
      {connectingProvider && (
        <SetupWizard
          provider={connectingProvider}
          onDone={handleConnected}
          onCancel={() => setConnectingProvider(null)}
          t={t}
        />
      )}

      {/* ── PRIMARY PATH: CSV upload ─────────────────────────────────
          The 80% workflow. MobilePay Erhverv app → Settings →
          Transactions → Export → CSV → here. We send them to
          /bank-import (which now parses MobilePay Erhverv natively)
          rather than fork an upload UI on this page. */}
      {!connectingProvider && (
        <Card>
          <Card.Header
            icon={<FileText size={18} />}
            title={t("uploadCsvCardTitle", "Upload your MobilePay or bank CSV")}
            subtitle={t(
              "uploadCsvCardSubtitle",
              "Recommended for most organizers — 30 seconds, no developer setup.",
            )}
          />
          <div className="space-y-4">
            <ol className="space-y-2.5">
              {[
                t("csvStep1", "In the MobilePay Business app: Settings → Transactions → Export"),
                t("csvStep2", "Or from your bank: Download last 30 days as CSV"),
                t("csvStep3", "Upload it here — BonBox auto-detects the format and matches bookings"),
              ].map((step, i) => (
                <li key={i} className="flex gap-3 text-sm text-gray-700 dark:text-gray-300">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 flex items-center justify-center text-xs font-bold">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
            <div className="pt-2">
              <Link to="/imports?tab=bank">
                <Button variant="primary" size="lg" iconRight={<ArrowRight size={14} />}>
                  {t("uploadCsv", "Upload CSV")}
                </Button>
              </Link>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                "csvSupportedFormats",
                "Supports: MobilePay Erhverv, Danske Bank, Nordea, Jyske Bank, Lunar, Revolut.",
              )}
            </p>
          </div>
        </Card>
      )}

      {/* ── SECONDARY PATH: API connect ──────────────────────────────
          For the ~20% who have Vipps developer-portal keys and want
          nightly auto-sync. The wizard handles the rest. */}
      {!connectingProvider && Object.entries(providersByCountry).map(([countryCode, countryProviders]) => (
        <div key={countryCode}>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2 font-semibold uppercase tracking-wider">
            {t("advancedAutoSync", "Advanced — auto-sync with API keys")}{" "}
            <span className="text-gray-400 dark:text-gray-500 font-normal normal-case tracking-normal">
              · {COUNTRY_LABELS[countryCode] || countryCode}
            </span>
          </p>
          <div className="space-y-2.5">
            {countryProviders.map((p) => {
              const isConnected = connections.some((c) => c.provider === p.id);
              return (
                <Card key={`${countryCode}-${p.id}`}>
                  <div className="flex items-center gap-4">
                    <div className="w-11 h-11 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-gray-500 dark:text-gray-400">
                      <CreditCard size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{p.description}</p>
                    </div>
                    {isConnected ? (
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-full flex items-center gap-1.5 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                        {t("connected", "Connected")}
                      </span>
                    ) : (
                      <Button
                        variant="primary"
                        size="md"
                        onClick={() => setConnectingProvider(p)}
                      >
                        {t("connect", "Connect")}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      ))}

      {/* Connected providers + their sync state */}
      {!connectingProvider && connections.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wider">
            {t("yourConnections", "Your connections")}
          </p>
          {connections.map((conn) => (
            <ConnectedCard
              key={conn.id}
              conn={conn}
              provider={providers.find((p) => p.id === conn.provider)}
              onDisconnect={handleDisconnect}
              onSync={handleSync}
              onToggleAutoSync={handleToggleAutoSync}
              syncing={syncing}
              syncResult={syncResults[conn.id]}
              onConfirmImport={handleConfirmImport}
              confirming={confirming}
              importResult={importResults[conn.id]}
              onMatchUpdated={() => {
                const imp = importResults[conn.id];
                const id = imp?.import_id || imp?.id;
                if (!id) return;
                api
                  .get(`/payment-imports/${id}`)
                  .then((r) => {
                    setImportResults((prev) => ({ ...prev, [conn.id]: r.data }));
                  })
                  .catch(() => { /* optimistic state already applied */ });
              }}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Help footer */}
      {!connectingProvider && (
        <div className="text-center pt-2 pb-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("needHelpConnecting", "Need help connecting?")}{" "}
            <a href="/contact" className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white underline underline-offset-2">
              {t("contactUs", "Contact us")}
            </a>{" "}
            {t("needHelpConnectingTail", "and we'll walk you through it.")}
          </p>
        </div>
      )}
    </PageShell>
  );
}
