// GavekortPage — the owner-facing gavekort (gift card) surface at /gavekort.
//
// Starter+ feature (gated on `gavekort`). Two views via TabPills:
//   1. Udsted   — issue a gavekort: amount + recipient + type → result card
//                 with QR (from qr_token), the GK code, and Print / Send.
//   2. Oversigt — the tracking ledger: three summary tiles
//                 (Udstedt / Indløst / Udestående) + a filterable, searchable
//                 card list. Tapping a card opens the detail drawer with the
//                 full transaktionsspor (udstedt → indløst rows showing staff +
//                 regning + dagsafslutning → saldo), plus Indløs + Annullér.
//
// Backend contract (app/routers/gavekort.py, mounted /api/gavekort):
//   POST   /gavekort/issue            {amount_minor, recipient_name?, note?,
//                                       voucher_class, expires_at?}
//   GET    /gavekort?status=&q=        {summary, cards}
//   GET    /gavekort/{id}             {card, transactions}
//   POST   /gavekort/{id}/redeem       {amount_minor, idempotency_key, sale_ref?}
//   POST   /gavekort/{id}/void         (owner action → compensating ledger row)
//
// Design doctrine (LOCKED): gray-900 primary + status-colors-only
// (green=active, amber=partial/expiring, red=void/expired) — NO blue/rainbow.
// Lucide outline icons (no emoji). Inter. rounded-xl. Money is the headline in
// gray-900; status is the only color. ONE primary action per view. Mobile +
// notch-aware. da-DK money via formatKr ("kr."). DK terms (gavekort / udsted /
// indløs / saldo / udestående / revisor) stay Danish in every UI language.
//
// Money is integer øre on the wire; the frontend rounds for display only.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Gift,
  QrCode,
  Printer,
  Send,
  Plus,
  Ban,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Wallet,
  Receipt,
  Moon,
  UserRound,
  Search,
  RefreshCw,
  CircleDollarSign,
  CreditCard,
  Smartphone,
  Banknote,
  Share2,
  Maximize2,
  Link2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useStickyMethod } from "../hooks/useStickyMethod";
import { useEntitlements } from "../hooks/useEntitlements";
import { useAuth } from "../hooks/useAuth";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Chip from "../components/ui/Chip";
import StatCard from "../components/ui/StatCard";
import TabPills from "../components/ui/TabPills";
import FilterBar from "../components/ui/FilterBar";
import Card from "../components/ui/Card";
import UpgradeNudge from "../components/ui/UpgradeNudge";
import { formatKr } from "../utils/currency";
import { errText } from "../utils/errText";

// ─── money helpers (integer øre is the wire format) ───────────────────
// formatKr expects KRONER (display units), so divide øre by 100. We never
// do float arithmetic on amounts before sending — only for display.
function krFromMinor(minor, opts = {}) {
  if (minor == null || Number.isNaN(minor)) return "—";
  return formatKr(minor / 100, opts);
}

// A typed amount in kroner → integer øre. Accepts "1.234,56" (DK), "1234.56",
// and bare ints; returns null when it doesn't parse to a positive number.
function minorFromInput(value) {
  if (value === "" || value == null) return null;
  const s = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// A high-entropy idempotency key for a redeem POST (mirrors the webhook-events
// single-spend doctrine: the same key replays the ORIGINAL result, never a 2nd
// debit). crypto.randomUUID where available, else a timestamp+random fallback.
function newIdempotencyKey() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `gk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Map the gavekort router's structured error codes → friendly, localized
// owner-facing strings. The router ALWAYS sends detail={"error": "<code>"}
// (or {"error": "cap_exceeded", ...} from billing) — an OBJECT, never a bare
// string. Passing that object straight to setError() and rendering it as a
// React child throws "Objects are not valid as a React child" (the same P0
// errText.js was built to kill). So: pull the known code → a clear message,
// and for any unmapped shape fall through to errText() which always returns a
// safe STRING. `t` is threaded in because this lives at module scope.
function gkErrText(e, t) {
  const code = e?.response?.data?.detail?.error;
  const MAP = {
    // 503 — GAVEKORT_SIGNING_KEY unset in prod (fail-closed). Honest, calm.
    gavekort_unconfigured: t(
      "gkErrUnconfigured",
      "Gavekort er midlertidigt utilgængeligt. Prøv igen om lidt.",
    ),
    code_generation_failed: t("gkErrCodeGen", "Kunne ikke generere koden. Prøv igen."),
    not_found: t("gkErrNotFound", "Gavekortet blev ikke fundet."),
    amount_must_be_positive: t("gkAmountRequired", "Indtast et beløb større end 0."),
    expired: t("gkErrExpired", "Gavekortet er udløbet."),
    voided: t("gkErrVoided", "Gavekortet er annulleret."),
    redeemed: t("gkErrRedeemed", "Gavekortet er allerede fuldt indløst."),
    locked: t(
      "gkErrLocked",
      "Gavekortet er optaget af en anden indløsning lige nu. Prøv igen.",
    ),
    insufficient: t("gkErrInsufficient", "Beløbet overstiger den resterende saldo."),
    cap_exceeded: t(
      "gkErrCap",
      "Du har nået grænsen for aktive gavekort på dit abonnement. Opgradér for at udstede flere.",
    ),
    feature_locked: t("gkErrFeature", "Gavekort er ikke en del af dit abonnement."),
  };
  if (code && MAP[code]) return MAP[code];
  // No HTTP response at all → request never reached the server (offline, DNS,
  // or a blocked CORS preflight). Axios surfaces this as the bare "Network
  // Error" string, which is opaque to an owner mid-redemption. Give a calm,
  // actionable message instead of leaking the library's default.
  if (!e?.response && (e?.request || e?.code === "ERR_NETWORK")) {
    return t(
      "gkErrNetwork",
      "Kunne ikke få forbindelse. Tjek din internetforbindelse og prøv igen.",
    );
  }
  return errText(e, t("gkErrGeneric", "Noget gik galt. Prøv igen."));
}

// dd/mm/yyyy HH:MM for a ledger row / issued-at, da-DK style.
function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("da-DK", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// dd/mm/yyyy for an expiry date (no time).
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("da-DK", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// ─── status → the ONE place color is allowed ──────────────────────────
// active=emerald (live value), partial=amber (some saldo spent), and the dead
// states (redeemed/expired/voided) are quiet gray or red. A gavekort with a
// balance below its face value but still active reads "delvist indløst" (amber).
//
// STATUS_COLOR_MAP is the single source of truth for the status-dot colour —
// the ONE place colour is allowed on a card (status-colors-only doctrine).
const STATUS_COLOR_MAP = {
  active: "bg-emerald-500",
  partial: "bg-amber-500",
  redeemed: "bg-gray-400",
  expired: "bg-red-500",
  voided: "bg-red-500",
  unknown: "bg-gray-400",
};

// Shared error-text treatment — every inline error string renders through this
// so the red is defined in exactly one place (status-colors-only: red = error).
function ErrorText({ children, className = "" }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className={"text-sm text-red-600 dark:text-red-400" + (className ? " " + className : "")}
    >
      {children}
    </p>
  );
}

function statusMeta(card, t) {
  const s = card?.status;
  const partial =
    s === "active" &&
    card.balance_minor != null &&
    card.face_value_minor != null &&
    card.balance_minor < card.face_value_minor;
  if (s === "active" && partial) {
    return { dot: STATUS_COLOR_MAP.partial, label: t("gkStatusPartial", "Delvist indløst"), tone: "amber" };
  }
  if (s === "active") {
    return { dot: STATUS_COLOR_MAP.active, label: t("gkStatusActive", "Aktivt"), tone: "emerald" };
  }
  if (s === "redeemed") {
    return { dot: STATUS_COLOR_MAP.redeemed, label: t("gkStatusRedeemed", "Indløst"), tone: "gray" };
  }
  if (s === "expired") {
    return { dot: STATUS_COLOR_MAP.expired, label: t("gkStatusExpired", "Udløbet"), tone: "red" };
  }
  if (s === "voided") {
    return { dot: STATUS_COLOR_MAP.voided, label: t("gkStatusVoided", "Annulleret"), tone: "red" };
  }
  return { dot: STATUS_COLOR_MAP.unknown, label: s || "—", tone: "gray" };
}

// voucher_class → short label. NEVER auto-decided; surfaced + owner-set.
// mpv = multi-purpose voucher, spv = single-purpose voucher (MOMS at issue).
function voucherClassLabel(vc, t) {
  if (vc === "spv") return t("gkClassSpvShort", "SPV");
  return t("gkClassMpvShort", "MPV");
}

// Small colored status pill (the only colored chrome on a card).
function StatusPill({ card, t }) {
  const m = statusMeta(card, t);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
      <span className={"h-2 w-2 rounded-full " + m.dot} aria-hidden />
      {m.label}
    </span>
  );
}

// ─── page shell ───────────────────────────────────────────────────────
const GK_TABS = ["udsted", "oversigt"];

export default function GavekortPage() {
  const { t } = useLanguage();
  const { hasFeature, isReady } = useEntitlements();
  const [tab, setTab] = useState("udsted");

  // Tier-flicker doctrine: render NOTHING while entitlements resolve, then
  // either the locked nudge or the page.
  if (!isReady) return null;
  if (!hasFeature("gavekort")) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
        <PageTitle t={t} />
        <UpgradeNudge
          intent="card"
          tier="starter"
          icon="🎁"
          feature="gavekort"
          benefit={t(
            "gkUpsell",
            "Udsted gavekort med QR og hold styr på indløsning og udestående — uden tredjepartsgebyr.",
          )}
          ctaLabel={t("gkUpsellCta", "Se abonnementer")}
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageTitle t={t} />
      <TabPills
        tabs={[
          { id: "udsted", label: t("gkTabIssue", "Udsted gavekort") },
          { id: "oversigt", label: t("gkTabLedger", "Oversigt") },
        ]}
        activeId={tab}
        onChange={(next) => setTab(GK_TABS.includes(next) ? next : "udsted")}
        ariaLabel={t("gkTabsAria", "Gavekort-sektioner")}
        size="lg"
      />
      {tab === "udsted" && <IssueSection t={t} onIssued={() => setTab("oversigt")} />}
      {tab === "oversigt" && <LedgerSection t={t} />}
    </div>
  );
}

function PageTitle({ t }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
        <Gift className="w-6 h-6 text-gray-700 dark:text-gray-200" aria-hidden />
        {t("gkOwnerTitle", "Gavekort")}
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        {t(
          "gkOwnerSubtitle",
          "Udsted gavekort, og hold styr på indløsning, saldo og udestående.",
        )}
      </p>
    </div>
  );
}

// ─── 1. Udsted gavekort ────────────────────────────────────────────────
const AMOUNT_PRESETS = [100, 200, 300, 500, 1000]; // kroner

// The three tenders a gavekort can be SOLD for at the counter. DK is
// card-first, so "Kort" is the sticky default and the picker is a
// confirmation glance, not a decision. Cash is selectable but never sticks
// (the cash-honesty invariant lives in useStickyMethod).
const GK_TENDERS = ["card", "mobilepay", "cash"];

function IssueSection({ t, onIssued }) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [voucherClass, setVoucherClass] = useState("mpv"); // never auto-decided
  const [expiresAt, setExpiresAt] = useState("");
  const [showMore, setShowMore] = useState(false); // gifting/advanced disclosure
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // Sticky tender — pre-lit from last use (card on a fresh account).
  const { method, setMethod, commitMethod } = useStickyMethod("sale");
  // Guard a stale sale-scope value (e.g. "online"/"dankort") — the lane only
  // offers these three; fall back to card.
  const tender = GK_TENDERS.includes(method) ? method : "card";

  const tenderOptions = [
    { id: "card", label: t("gkTenderCard", "Kort"), Icon: CreditCard },
    { id: "mobilepay", label: t("gkTenderMobilepay", "MobilePay"), Icon: Smartphone },
    { id: "cash", label: t("gkTenderCash", "Kontant"), Icon: Banknote },
  ];

  const amountMinor = minorFromInput(amount);
  const canSubmit = !busy && amountMinor != null;

  const submit = async () => {
    setError("");
    const minor = minorFromInput(amount);
    if (minor == null) {
      setError(t("gkAmountRequired", "Indtast et beløb større end 0."));
      return;
    }
    setBusy(true);
    try {
      const body = {
        amount_minor: minor,
        voucher_class: voucherClass,
        payment_method: tender,
      };
      if (recipient.trim()) body.recipient_name = recipient.trim();
      if (note.trim()) body.note = note.trim();
      if (expiresAt) body.expires_at = new Date(expiresAt + "T23:59:59").toISOString();
      const res = await api.post("/gavekort/issue", body);
      commitMethod(tender); // remember card/mobilepay; cash no-ops (invariant)
      setResult(res.data);
    } catch (e) {
      setError(gkErrText(e, t));
    } finally {
      setBusy(false);
    }
  };

  // After selling, the result card takes over the view — one clear moment.
  if (result) {
    return (
      <IssuedResult
        t={t}
        result={result}
        onIssueAnother={() => {
          setResult(null);
          setAmount("");
          setRecipient("");
          setNote("");
          setExpiresAt("");
          setVoucherClass("mpv");
          setShowMore(false);
          // Tender stays lit (sticky) — back-to-back sales need zero re-setup.
        }}
        onGoToLedger={onIssued}
      />
    );
  }

  return (
    <Card>
      <Card.Header
        title={t("gkSellTitle", "Sælg gavekort")}
        subtitle={t("gkSellHint", "Vælg et beløb, og hvordan kunden betalte.")}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
        className="space-y-5"
      >
        {/* Amount — the headline field. Presets + custom input. */}
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("gkAmountLabel", "Beløb")}
          </label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {AMOUNT_PRESETS.map((p) => (
              <Chip
                key={p}
                selected={String(amount).trim() === String(p)}
                onClick={() => setAmount(String(p))}
              >
                {p.toLocaleString("da-DK")} kr.
              </Chip>
            ))}
          </div>
          <div className="mt-2 sm:max-w-xs">
            <Input
              type="number"
              inputMode="decimal"
              size="lg"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t("gkAmountPh", "Eget beløb")}
              suffix="kr."
              aria-label={t("gkAmountLabel", "Beløb")}
            />
          </div>
          {/* MOMS status — read-only, off the rush path. The MPV/SPV control
              lives under "Tilføj modtager"; MPV is the café/salon default. */}
          <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Receipt className="w-3.5 h-3.5" aria-hidden />
            {voucherClass === "spv"
              ? t("gkMomsAtIssue", "MOMS ved udstedelse (SPV)")
              : t("gkMomsAtRedemption", "MOMS ved indløsning (MPV)")}
          </p>
        </div>

        {/* Betalt med — the one new step, pre-lit from last use (sticky). */}
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("gkTenderLabel", "Betalt med")}
          </label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {tenderOptions.map(({ id, label, Icon }) => (
              <Chip key={id} selected={tender === id} onClick={() => setMethod(id)}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="w-4 h-4" aria-hidden />
                  {label}
                </span>
              </Chip>
            ))}
          </div>
        </div>

        {error && <ErrorText>{error}</ErrorText>}

        {/* ONE primary action — carries the live amount so the owner confirms
            the number without looking back up at the form. */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={busy}
          disabled={!canSubmit}
          iconLeft={!busy ? <Plus className="w-4 h-4" aria-hidden /> : null}
          className="w-full sm:w-auto justify-center"
        >
          {amountMinor != null
            ? `${t("gkSellCta", "Sælg gavekort")} · ${krFromMinor(amountMinor)}`
            : t("gkSellCta", "Sælg gavekort")}
        </Button>

        {/* Gifting / advanced — ONE ghost disclosure below the button. The 90%
            buy-for-self path never sees recipient / type / expiry / note. */}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowMore((s) => !s)}
            aria-expanded={showMore}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
          >
            {showMore ? (
              <ChevronDown className="w-4 h-4" aria-hidden />
            ) : (
              <Plus className="w-4 h-4" aria-hidden />
            )}
            {t("gkAddRecipient", "Til en anden? Tilføj modtager")}
          </button>

          {showMore && (
            <div className="mt-4 space-y-5 border-t border-gray-100 dark:border-gray-800 pt-5">
              {/* Recipient (optional) */}
              <div className="sm:max-w-md">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("gkRecipientLabel", "Modtager (valgfri)")}
                </label>
                <div className="mt-1.5">
                  <Input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    maxLength={120}
                    placeholder={t("gkRecipientPh", "Anna Hansen")}
                    aria-label={t("gkRecipientLabel", "Modtager (valgfri)")}
                  />
                </div>
              </div>

              {/* voucher_class — owner-set, surfaced, never auto-decided. */}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("gkClassLabel", "Type")}
                </label>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  <Chip selected={voucherClass === "mpv"} onClick={() => setVoucherClass("mpv")}>
                    {t("gkClassMpv", "Flere formål (MPV)")}
                  </Chip>
                  <Chip selected={voucherClass === "spv"} onClick={() => setVoucherClass("spv")}>
                    {t("gkClassSpv", "Ét formål (SPV)")}
                  </Chip>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 max-w-md">
                  {voucherClass === "spv"
                    ? t(
                        "gkClassSpvHelp",
                        "Ét formål: MOMS afregnes ved udstedelse. Spørg din revisor, hvis du er i tvivl.",
                      )
                    : t(
                        "gkClassMpvHelp",
                        "Flere formål: MOMS afregnes ved indløsning. Standard for de fleste gavekort.",
                      )}
                </p>
              </div>

              {/* Expiry (optional) */}
              <div className="sm:max-w-xs">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("gkExpiryLabel", "Udløber (valgfri)")}
                </label>
                <div className="mt-1.5">
                  <Input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    aria-label={t("gkExpiryLabel", "Udløber (valgfri)")}
                  />
                </div>
              </div>

              {/* Optional internal note */}
              <div className="sm:max-w-md">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("gkNoteLabel", "Intern note (valgfri)")}
                </label>
                <div className="mt-1.5">
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={240}
                    placeholder={t("gkNotePh", "F.eks. fødselsdagsgave")}
                    aria-label={t("gkNoteLabel", "Intern note (valgfri)")}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </form>
    </Card>
  );
}

// SuccessMoment — the single reusable success treatment (the one ceremonial
// beat). A calm emerald check inside the system radius. Status-colors-only:
// emerald is allowed here because this IS a success state.
function SuccessMoment() {
  return (
    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
      <Check className="h-6 w-6" aria-hidden />
    </div>
  );
}

// The success moment: QR + GK code + Print / Send. Calm, centered, one card.
const TENDER_LABELS = {
  card: ["gkTenderCard", "Kort"],
  mobilepay: ["gkTenderMobilepay", "MobilePay"],
  cash: ["gkTenderCash", "Kontant"],
  mixed: ["gkTenderMixed", "Blandet"],
};

function IssuedResult({ t, result, onIssueAnother, onGoToLedger }) {
  const qrToken = result?.qr_token || "";
  const shortCode = result?.short_code || "";
  const [showQR, setShowQR] = useState(false); // fullscreen QR for hand-over
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();
  const venue = user?.business_name?.trim() || ""; // for the printable card

  // The recipient's public card. The QR encodes THIS url (not the raw token),
  // so a customer scanning it with their phone camera lands on the live card —
  // and the same link is what "Kopiér link" shares.
  const publicUrl = qrToken
    ? `${window.location.origin}/g/${encodeURIComponent(qrToken)}`
    : "";

  const copyLink = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — no-op (fullscreen QR is the fallback) */
    }
  };

  const methodKey = TENDER_LABELS[result?.payment_method];
  const methodLabel = methodKey ? t(methodKey[0], methodKey[1]) : null;
  const expiryLabel = result?.expires_at
    ? new Date(result.expires_at).toLocaleDateString("da-DK", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  const print = () => {
    try {
      window.print();
    } catch {
      /* no-op — print unavailable */
    }
  };

  return (
    <div className="space-y-4">
      <Card variant="emphasis" className="text-center">
        <SuccessMoment />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {t("gkSoldEyebrow", "Gavekort solgt")}
        </p>
        <p className="text-[34px] font-bold tabular-nums leading-tight text-gray-900 dark:text-gray-100 mt-1">
          {krFromMinor(result?.face_value_minor)}
        </p>

        {/* QR from the signed qr_token (BB1.G.<jwt>). White card so the QR
            scans cleanly in any theme. */}
        {qrToken && (
          <div className="mt-5 inline-flex flex-col items-center">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white p-4">
              <QRCodeSVG value={publicUrl || qrToken} size={168} level="M" includeMargin={false} />
            </div>
          </div>
        )}

        {/* The GK code — the human-readable handle. Monospace + tracking so
            it reads like a code, not prose. */}
        {shortCode && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {t("gkCodeLabel", "Gavekortkode")}
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tracking-[0.15em] text-gray-900 dark:text-gray-100">
              {shortCode}
            </p>
          </div>
        )}

        {/* Honesty line — muted gray, NOT emerald. States where the money is,
            without overclaiming. "registreret" (recorded), never "bogført",
            until the close/MOMS posting bridge exists. */}
        {methodLabel && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
            <Wallet className="w-3.5 h-3.5" aria-hidden />
            {t("gkPaidRegistered", "Betalt med {method} · registreret", { method: methodLabel })}
          </p>
        )}

        {result?.recipient_name && (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {t("gkIssuedTo", "Til {name}", { name: result.recipient_name })}
          </p>
        )}

        {/* Footer strip — udløb + saldo, the two facts the recipient cares
            about, quiet at the foot of the card. */}
        <div className="mt-5 flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-3 text-[11px] text-gray-400 dark:text-gray-500">
          <span>
            {expiryLabel
              ? t("gkValidUntil", "Gælder til {date}", { date: expiryLabel })
              : t("gkNoExpiry", "Uden udløb")}
          </span>
          <span>
            {t("gkBalanceLabel", "Saldo {amount}", { amount: krFromMinor(result?.balance_minor) })}
          </span>
        </div>

        {/* Actions — Del gavekort (the literal hand-over: a fullscreen QR the
            customer photographs) + Print. Quiet secondary buttons. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            iconLeft={<Share2 className="w-4 h-4" aria-hidden />}
            onClick={() => setShowQR(true)}
          >
            {t("gkShareCard", "Del gavekort")}
          </Button>
          {publicUrl && (
            <Button
              variant="secondary"
              iconLeft={
                copied ? (
                  <Check className="w-4 h-4 text-emerald-600" aria-hidden />
                ) : (
                  <Link2 className="w-4 h-4" aria-hidden />
                )
              }
              onClick={copyLink}
            >
              {copied ? t("gkLinkCopied", "Kopieret") : t("gkCopyLink", "Kopiér link")}
            </Button>
          )}
          <Button
            variant="secondary"
            iconLeft={<Printer className="w-4 h-4" aria-hidden />}
            onClick={print}
          >
            {t("gkPrint", "Print")}
          </Button>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="primary"
          iconLeft={<Plus className="w-4 h-4" aria-hidden />}
          onClick={onIssueAnother}
        >
          {t("gkSellAnother", "Sælg endnu et")}
        </Button>
        <Button variant="ghost" onClick={onGoToLedger}>
          {t("gkGoToLedger", "Se oversigt")}
        </Button>
      </div>

      {/* Fullscreen QR — the hand-over. Big enough to photograph across a
          counter. PII-free (only the signed token + code + value). */}
      {showQR && qrToken && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white dark:bg-gray-950 px-6"
          style={{
            paddingTop: "max(1.5rem, env(safe-area-inset-top))",
            paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
          }}
          role="dialog"
          aria-modal="true"
          aria-label={t("gkShareCard", "Del gavekort")}
        >
          <button
            type="button"
            onClick={() => setShowQR(false)}
            aria-label={t("gkClose", "Luk")}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            style={{ top: "max(1rem, env(safe-area-inset-top))" }}
          >
            <X className="h-6 w-6" aria-hidden />
          </button>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("gkScanToReceive", "Scan for at få gavekortet")}
          </p>
          <div className="mt-5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white p-5">
            <QRCodeSVG value={publicUrl || qrToken} size={264} level="M" includeMargin={false} />
          </div>
          {shortCode && (
            <p className="mt-5 font-mono text-lg font-semibold tracking-[0.15em] text-gray-900 dark:text-gray-100">
              {shortCode}
            </p>
          )}
          <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {krFromMinor(result?.face_value_minor)}
          </p>
        </div>
      )}

      {/* Printable card — display:none on screen; laid out only for the
          printer (see .gk-print-card in index.css). The Print button scopes
          window.print() to THIS one clean gavekort. Light, print-safe styles. */}
      <div className="gk-print-card hidden">
        <div
          style={{
            width: "320px",
            border: "1px solid #111111",
            borderRadius: "16px",
            padding: "28px",
            textAlign: "center",
            color: "#111111",
            background: "#ffffff",
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          {venue && (
            <p style={{ fontSize: "16px", fontWeight: 600, margin: 0 }}>{venue}</p>
          )}
          <p
            style={{
              fontSize: "11px",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#666666",
              margin: "4px 0 0",
            }}
          >
            {t("gpkEyebrow", "Gavekort")}
          </p>
          <p style={{ fontSize: "40px", fontWeight: 700, margin: "10px 0 16px" }}>
            {krFromMinor(result?.face_value_minor)}
          </p>
          {(publicUrl || qrToken) && (
            <div
              style={{
                display: "inline-block",
                border: "1px solid #dddddd",
                borderRadius: "12px",
                padding: "12px",
              }}
            >
              <QRCodeSVG value={publicUrl || qrToken} size={150} level="M" includeMargin={false} />
            </div>
          )}
          {shortCode && (
            <p
              style={{
                fontFamily: "monospace",
                letterSpacing: "0.15em",
                fontSize: "15px",
                margin: "14px 0 0",
              }}
            >
              {shortCode}
            </p>
          )}
          {expiryLabel && (
            <p style={{ fontSize: "12px", color: "#666666", margin: "10px 0 0" }}>
              {t("gpkValidUntil", "Gælder til {date}", { date: expiryLabel })}
            </p>
          )}
          {venue && (
            <p style={{ fontSize: "12px", color: "#444444", margin: "6px 0 0" }}>
              {t("gpkRedeemAt", "Indløses hos {business}", { business: venue })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 2. Oversigt (tracking ledger) ─────────────────────────────────────
const STATUS_FILTERS = ["all", "active", "redeemed", "expired", "voided"];

function LedgerSection({ t }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const debounceRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = {};
      if (status && status !== "all") params.status = status;
      if (q.trim()) params.q = q.trim();
      const res = await api.get("/gavekort", { params });
      setData(res.data);
    } catch (e) {
      setError(gkErrText(e, t));
    } finally {
      setLoading(false);
    }
  }, [status, q, t]);

  // Debounce search; status changes fire immediately.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(load, q ? 300 : 0);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [load, q]);

  const summary = data?.summary || {};
  const cards = data?.cards || [];
  const hasFilters = status !== "all" || q.trim() !== "";

  return (
    <div className="space-y-6">
      {/* Three summary tiles — money is the headline, gray-900. The only
          color is the udestående tile (amber = money still owed to guests). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label={t("gkSummaryIssued", "Udstedt")}
          value={krFromMinor(summary.issued_minor ?? 0, { decimals: 0 })}
          helper={t("gkSummaryActiveCount", "{n} aktive", { n: summary.active_count ?? 0 })}
        />
        <StatCard
          label={t("gkSummaryRedeemed", "Indløst")}
          value={krFromMinor(summary.redeemed_minor ?? 0, { decimals: 0 })}
        />
        <StatCard
          label={t("gkSummaryOutstanding", "Udestående")}
          value={krFromMinor(summary.outstanding_minor ?? 0, { decimals: 0 })}
          accent={(summary.outstanding_minor ?? 0) > 0 ? "warn" : "neutral"}
          helper={t("gkSummaryOutstandingHelp", "Skyldigt til gæster")}
        />
      </div>

      {/* Filter + search row */}
      <FilterBar>
        <FilterBar.Select
          label={t("gkFilterStatus", "Status")}
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS.map((s) => ({
            value: s,
            label:
              s === "all"
                ? t("gkFilterAll", "Alle")
                : s === "active"
                  ? t("gkStatusActive", "Aktivt")
                  : s === "redeemed"
                    ? t("gkStatusRedeemed", "Indløst")
                    : s === "expired"
                      ? t("gkStatusExpired", "Udløbet")
                      : t("gkStatusVoided", "Annulleret"),
          }))}
        />
        <FilterBar.Search
          value={q}
          onChange={setQ}
          placeholder={t("gkSearchPh", "Søg kode eller modtager…")}
        />
        {hasFilters && (
          <FilterBar.Reset
            label={t("gkReset", "Nulstil")}
            onClick={() => {
              setStatus("all");
              setQ("");
            }}
          />
        )}
      </FilterBar>

      {/* Card list */}
      {error ? (
        <Card>
          <div className="py-8 text-center">
            <ErrorText className="text-center">{error}</ErrorText>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              iconLeft={<RefreshCw className="w-4 h-4" aria-hidden />}
              onClick={load}
            >
              {t("gkRetry", "Prøv igen")}
            </Button>
          </div>
        </Card>
      ) : loading && !data ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[72px] rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 animate-pulse"
            />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <Card variant="subtle">
          <div className="py-12 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-400">
              <Gift className="h-6 w-6" aria-hidden />
            </div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              {hasFilters
                ? t("gkEmptyFiltered", "Ingen gavekort matcher")
                : t("gkEmptyTitle", "Ingen gavekort endnu")}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">
              {hasFilters
                ? t("gkEmptyFilteredBody", "Prøv en anden status eller søgning.")
                : t("gkEmptyBody", "Udsted dit første gavekort fra fanen Udsted.")}
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-2 pr-[env(safe-area-inset-right)]">
          {cards.map((card) => (
            <GavekortRow key={card.id} card={card} t={t} onOpen={() => setSelectedId(card.id)} />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {selectedId && (
        <DetailDrawer
          id={selectedId}
          t={t}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            load();
          }}
        />
      )}
    </div>
  );
}

// A single ledger card — saldo is the headline (gray-900), status the only
// color. Tapping opens the detail drawer.
function GavekortRow({ card, t, onOpen }) {
  return (
    <Card onClick={onOpen} className="w-full text-left !px-4 !py-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 tracking-wide truncate">
              {card.code_last4 ? "···· " + card.code_last4 : t("gkNoCode", "Gavekort")}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 shrink-0">
              {voucherClassLabel(card.voucher_class, t)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 truncate">
            {card.recipient_name ? (
              <span className="truncate">{card.recipient_name}</span>
            ) : (
              <span className="text-gray-400 dark:text-gray-500">
                {t("gkNoRecipient", "Ingen modtager")}
              </span>
            )}
            <span aria-hidden>·</span>
            <span className="tabular-nums whitespace-nowrap">{fmtDate(card.issued_at)}</span>
          </div>
        </div>

        <div className="text-right shrink-0">
          {/* Saldo is the headline number. */}
          <div className="text-base font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {krFromMinor(card.balance_minor)}
          </div>
          <div className="mt-0.5">
            <StatusPill card={card} t={t} />
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 shrink-0" aria-hidden />
      </div>
    </Card>
  );
}

// ─── 3. Detail drawer — the transaktionsspor + Indløs + Annullér ────────
function DetailDrawer({ id, t, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("view"); // view | redeem | void
  const [redeemAmount, setRedeemAmount] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // A stable idempotency key per redeem attempt — generated when the redeem
  // form opens, reused on retry so a network blip never double-debits.
  const idemKeyRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get(`/gavekort/${id}`);
      setData(res.data);
    } catch (e) {
      setError(gkErrText(e, t));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const card = data?.card;
  const transactions = data?.transactions || [];
  const isActive = card?.status === "active";
  const balanceMinor = card?.balance_minor ?? 0;

  const openRedeem = () => {
    idemKeyRef.current = newIdempotencyKey();
    setRedeemAmount("");
    setActionError("");
    setMode("redeem");
  };

  const doRedeem = async () => {
    setActionError("");
    const minor = minorFromInput(redeemAmount);
    if (minor == null) {
      setActionError(t("gkRedeemAmountRequired", "Indtast et beløb større end 0."));
      return;
    }
    if (minor > balanceMinor) {
      setActionError(
        t("gkRedeemTooMuch", "Beløbet overstiger saldoen ({saldo}).", {
          saldo: krFromMinor(balanceMinor),
        }),
      );
      return;
    }
    setActionBusy(true);
    try {
      await api.post(
        `/gavekort/${id}/redeem`,
        { amount_minor: minor, idempotency_key: idemKeyRef.current },
        { headers: { "Idempotency-Key": idemKeyRef.current } },
      );
      setMode("view");
      await load();
      onChanged && onChanged();
    } catch (e) {
      const st = e?.response?.status;
      if (st === 409) {
        setActionError(
          t("gkRedeemInsufficient", "Ikke nok saldo. Indløsning afvist."),
        );
      } else if (st === 410) {
        setActionError(
          t("gkRedeemGone", "Gavekortet kan ikke indløses (indløst, udløbet eller annulleret)."),
        );
        await load();
      } else {
        setActionError(gkErrText(e, t));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const doVoid = async () => {
    setActionError("");
    setActionBusy(true);
    try {
      await api.post(`/gavekort/${id}/void`);
      setMode("view");
      await load();
      onChanged && onChanged();
    } catch (e) {
      setActionError(gkErrText(e, t));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 motion-safe:animate-backdropFade"
        onClick={onClose}
      />
      <div
        className="relative ml-auto w-full max-w-md sm:max-w-lg h-full bg-white dark:bg-gray-900 shadow-2xl border-l border-gray-200 dark:border-gray-800 flex flex-col motion-safe:animate-slideIn"
        style={{ paddingRight: "env(safe-area-inset-right)" }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-3 p-5 border-b border-gray-200 dark:border-gray-800">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {t("gkDetailEyebrow", "Gavekort")}
            </p>
            <p className="font-mono text-base font-semibold tracking-wide text-gray-900 dark:text-gray-100 truncate">
              {card?.code_last4 ? "···· " + card.code_last4 : t("gkNoCode", "Gavekort")}
            </p>
            {card && (
              <div className="mt-1.5">
                <StatusPill card={card} t={t} />
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={onClose}
            aria-label={t("gkClose", "Luk")}
            className="shrink-0 h-9 w-9 !px-0 !gap-0 rounded-xl text-gray-400"
          >
            <X className="w-5 h-5" aria-hidden />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {loading && !data ? (
            <div className="space-y-3" aria-busy="true">
              <div className="h-16 rounded-xl bg-gray-50 dark:bg-gray-900/40 animate-pulse" />
              <div className="h-24 rounded-xl bg-gray-50 dark:bg-gray-900/40 animate-pulse" />
            </div>
          ) : error ? (
            <ErrorText>{error}</ErrorText>
          ) : card ? (
            <>
              {/* Saldo headline */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-4 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {t("gkSaldoLabel", "Saldo")}
                </p>
                <p className="text-[32px] font-bold tabular-nums leading-tight text-gray-900 dark:text-gray-100 mt-0.5">
                  {krFromMinor(card.balance_minor)}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("gkFaceValueOf", "af {face} udstedt", {
                    face: krFromMinor(card.face_value_minor),
                  })}
                </p>
              </div>

              {/* Meta rows */}
              <div className="space-y-1.5">
                <MetaRow
                  label={t("gkRecipientLabel", "Modtager (valgfri)")}
                  value={card.recipient_name || t("gkNoRecipient", "Ingen modtager")}
                />
                <MetaRow
                  label={t("gkClassLabel", "Type")}
                  value={
                    card.voucher_class === "spv"
                      ? t("gkClassSpv", "Ét formål (SPV)")
                      : t("gkClassMpv", "Flere formål (MPV)")
                  }
                />
                <MetaRow label={t("gkIssuedAt", "Udstedt")} value={fmtDateTime(card.issued_at)} />
                {card.expires_at && (
                  <MetaRow label={t("gkExpiresAt", "Udløber")} value={fmtDate(card.expires_at)} />
                )}
              </div>

              {/* Transaktionsspor — the indented trail. */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
                  {t("gkTrailTitle", "Transaktionsspor")}
                </p>
                <TransactionTrail transactions={transactions} t={t} />
              </div>

              {/* Action error (shown above the action area) */}
              {actionError && mode === "view" && <ErrorText>{actionError}</ErrorText>}
            </>
          ) : null}
        </div>

        {/* Pinned action bar — one primary (Indløs) + quiet destructive
            (Annullér). Only for an active card. */}
        {card && isActive && (
          <div
            className="shrink-0 border-t border-gray-200 dark:border-gray-800 p-4 bg-white/90 dark:bg-gray-900/90 backdrop-blur"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          >
            {mode === "redeem" ? (
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {t("gkRedeemLabel", "Indløs beløb")}
                  </label>
                  {/* Quiet text link — fills the field, not a competing button.
                      ONE primary action (Indløs) stays the headline. */}
                  <button
                    type="button"
                    onClick={() => setRedeemAmount(String(balanceMinor / 100))}
                    className="text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 underline decoration-gray-300 dark:decoration-gray-600 underline-offset-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 rounded-sm"
                  >
                    {t("gkRedeemAll", "Hele saldoen")}
                  </button>
                </div>
                <Input
                  type="number"
                  inputMode="decimal"
                  size="lg"
                  autoFocus
                  value={redeemAmount}
                  onChange={(e) => setRedeemAmount(e.target.value)}
                  placeholder={t("gkRedeemPh", "Beløb")}
                  suffix="kr."
                  aria-label={t("gkRedeemLabel", "Indløs beløb")}
                />
                {actionError && <ErrorText>{actionError}</ErrorText>}
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="lg"
                    busy={actionBusy}
                    onClick={doRedeem}
                    iconLeft={!actionBusy ? <Check className="w-4 h-4" aria-hidden /> : null}
                    className="flex-1 justify-center"
                  >
                    {t("gkRedeemConfirm", "Indløs")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    disabled={actionBusy}
                    onClick={() => {
                      setMode("view");
                      setActionError("");
                    }}
                  >
                    {t("gkCancel", "Annullér")}
                  </Button>
                </div>
              </div>
            ) : mode === "void" ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-700 dark:text-gray-200">
                  {t(
                    "gkVoidConfirmBody",
                    "Annullér dette gavekort? Saldoen nulstilles, og handlingen registreres i sporet.",
                  )}
                </p>
                {actionError && <ErrorText>{actionError}</ErrorText>}
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    size="lg"
                    busy={actionBusy}
                    onClick={doVoid}
                    iconLeft={!actionBusy ? <Ban className="w-4 h-4" aria-hidden /> : null}
                    className="flex-1 justify-center"
                  >
                    {t("gkVoidConfirm", "Annullér gavekort")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    disabled={actionBusy}
                    onClick={() => {
                      setMode("view");
                      setActionError("");
                    }}
                  >
                    {t("gkKeep", "Behold")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={openRedeem}
                  iconLeft={<CircleDollarSign className="w-4 h-4" aria-hidden />}
                  className="w-full justify-center"
                >
                  {t("gkRedeemAction", "Indløs")}
                </Button>
                <div className="flex justify-center">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setActionError("");
                      setMode("void");
                    }}
                    iconLeft={<Ban className="w-3.5 h-3.5" aria-hidden />}
                  >
                    {t("gkVoidAction", "Annullér gavekort")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 text-right">{value}</span>
    </div>
  );
}

// The indented trail: udstedt → indløst rows showing staff + regning +
// dagsafslutning → saldo after. Append-only, oldest→newest.
function TransactionTrail({ transactions, t }) {
  if (!transactions || transactions.length === 0) {
    return (
      <p className="text-sm text-gray-400 dark:text-gray-500">
        {t("gkTrailEmpty", "Ingen bevægelser endnu.")}
      </p>
    );
  }

  const kindMeta = (kind) => {
    if (kind === "issue") return { icon: Gift, label: t("gkKindIssue", "Udstedt"), tone: "gray" };
    if (kind === "redeem") return { icon: Receipt, label: t("gkKindRedeem", "Indløst"), tone: "emerald" };
    if (kind === "void") return { icon: Ban, label: t("gkKindVoid", "Annulleret"), tone: "red" };
    return { icon: Wallet, label: kind || "—", tone: "gray" };
  };

  return (
    <ol className="relative space-y-0">
      {transactions.map((tx, i) => {
        const m = kindMeta(tx.kind);
        const Ico = m.icon;
        const last = i === transactions.length - 1;
        // Amount sign: issue/positive credits show plain; redeem/void are debits.
        const isDebit = tx.kind === "redeem" || tx.kind === "void";
        const amountText =
          tx.amount_minor != null
            ? (isDebit ? "−" : "") + krFromMinor(Math.abs(tx.amount_minor))
            : "—";
        // Trail icons stay neutral — the kind LABEL (Udstedt/Indløst/Annulleret)
        // carries the meaning. Icons must not add colour (status-colors-only).
        const iconTone = "text-gray-400 dark:text-gray-500";
        return (
          <li key={tx.id ?? i} className="flex gap-3">
            {/* Rail: dot + connecting line (the "indented trail"). */}
            <div className="flex flex-col items-center">
              <span
                className={
                  "mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-white dark:bg-gray-900 " +
                  "border-gray-200 dark:border-gray-700 " +
                  iconTone
                }
              >
                <Ico className="h-3.5 w-3.5" aria-hidden />
              </span>
              {!last && <span className="w-px flex-1 bg-gray-200 dark:bg-gray-700" />}
            </div>

            {/* Row content */}
            <div className={"min-w-0 flex-1 " + (last ? "pb-0" : "pb-4")}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {m.label}
                </span>
                <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">
                  {amountText}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {fmtDateTime(tx.created_at)}
              </div>

              {/* The LINK — staff + regning + dagsafslutning. Quiet meta chips
                  so the trail reads as a clean audit line, not a wall. */}
              {(tx.staff_name || tx.sale_ref || tx.daily_close_ref) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                  {tx.staff_name && (
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="h-3 w-3 shrink-0" aria-hidden />
                      {tx.staff_name}
                    </span>
                  )}
                  {tx.sale_ref && (
                    <span className="inline-flex items-center gap-1">
                      <Receipt className="h-3 w-3 shrink-0" aria-hidden />
                      {t("gkSaleRef", "Regning {ref}", { ref: tx.sale_ref })}
                    </span>
                  )}
                  {tx.daily_close_ref && (
                    <span className="inline-flex items-center gap-1">
                      <Moon className="h-3 w-3 shrink-0" aria-hidden />
                      {t("gkCloseRef", "Dagsafslutning {ref}", { ref: tx.daily_close_ref })}
                    </span>
                  )}
                </div>
              )}

              {/* Saldo after this row — the running balance. */}
              {tx.balance_after_minor != null && (
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t("gkBalanceAfter", "Saldo: {saldo}", {
                    saldo: krFromMinor(tx.balance_after_minor),
                  })}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
