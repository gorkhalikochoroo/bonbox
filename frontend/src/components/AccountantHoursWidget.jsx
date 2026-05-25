/**
 * AccountantHoursWidget — "we save your accountant hours = save you kr"
 *
 * Why this exists
 * ===============
 * Manoj's positioning: "we save you revisor hours = we save you money."
 * The widget makes that claim concrete with a number every owner can
 * verify by tapping in to see the breakdown:
 *
 *   "Du har sparet revisoren 8.4 timer denne måned · ca. 7.140 kr"
 *
 * Tier behaviour
 * ==============
 * Free   — Locked. We show an upsell card: "Sparer revisoren timer fra
 *          Starter" — never "0 hours saved" (Manoj's mandate: showing
 *          zero feels broken AND like a put-down).
 * Starter+, Pro, Trial — Live numbers from /api/accountant-savings/
 *          current-month. Tap to open the per-source breakdown.
 *
 * Honesty doctrine (L10)
 * ======================
 * Every number rendered here came from the backend service, which only
 * credits time for actions that actually happened (real receipts scanned,
 * real closes locked, real MOMS exports downloaded, real invoices sent).
 * If the accountant disputes the number, the breakdown drawer shows
 * exactly what was counted — same data the accountant can re-derive
 * from the underlying records.
 *
 * Defense
 * =======
 *   L1 — Backend gate: Free users get a zero payload from the API even
 *        if this client-side guard is bypassed (e.g. extension that
 *        flips hasFeature).
 *   L2 — Numeric coercion (Number(...)) with safe fallback to 0.
 *   L3 — Silent fail on network/5xx — show the upsell as a soft
 *        empty-state rather than a broken card.
 *   L4 — Currency-aware money formatting (DKK headlines kr; other
 *        currencies show their own code, NEVER auto-convert).
 *
 * Design rules
 * ============
 *   • Gray-* palette everywhere (matches sidebar / Card primitive).
 *   • Emerald-600 ONLY on the kr number — this is the "money moment".
 *   • Lucide icons (Clock + TrendingDown) via the shared Icon registry.
 *   • rounded-xl (matches the rest of the dashboard's tile rhythm).
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { Card, Icon, UpgradeNudge } from "./ui";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";


// ─── Money formatting ────────────────────────────────────────────────
//
// DKK is the headline currency (Manoj's market). Non-DKK users see
// their own currency code rather than a fake DKK conversion — the
// backend already returns money_saved_dkk in the user's currency, the
// "_dkk" suffix on the field name is historical (early DKK-only build).
function fmtMoney(n, currency = "DKK") {
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  // da-DK locale uses "." as the thousands separator. Round DOWN at
  // display time so we never round 1232.5 to 1233 — the backend already
  // truncates but defense in depth keeps the marketing-promise honest.
  const floored = Math.floor(num);
  const formatted = floored.toLocaleString("da-DK", { maximumFractionDigits: 0 });
  // DKK shows "kr" (the user's vocabulary); other currencies show the
  // ISO code so an EUR user doesn't see "kr" beside a euro amount.
  if (currency === "DKK") return `${formatted} kr`;
  return `${formatted} ${currency}`;
}


function fmtHours(n) {
  const num = Number(n);
  if (Number.isNaN(num) || num <= 0) return "0";
  // 1 decimal place is enough — "8.4 timer" reads natural in DA + EN.
  // Round DOWN, matching the backend's honesty constraint.
  return (Math.floor(num * 10) / 10).toFixed(1).replace(".", ",");
}


// Localised label for each source row in the breakdown drawer. The
// backend uses stable English keys (receipt_ocr, daily_close_autopilot,
// moms_export, faktura_pdf); the widget translates each key to DA/EN.
function sourceLabel(t, key) {
  switch (key) {
    case "receipt_ocr":
      return t(
        "acctSavingsSourceReceipt",
        "Kvitteringer scannet automatisk",
      ) || "Kvitteringer scannet automatisk";
    case "daily_close_autopilot":
      return t(
        "acctSavingsSourceClose",
        "Kasserapporter lukket",
      ) || "Kasserapporter lukket";
    case "moms_export":
      return t(
        "acctSavingsSourceMoms",
        "MOMS-eksporter",
      ) || "MOMS-eksporter";
    case "faktura_pdf":
      return t(
        "acctSavingsSourceFaktura",
        "Fakturaer udstedt",
      ) || "Fakturaer udstedt";
    default:
      return key;
  }
}


// ═════════════════════════════════════════════════════════════════════
// Breakdown drawer — opens on tile click. Shows the per-source counts
// the headline number is built from, so the accountant can verify.
// ═════════════════════════════════════════════════════════════════════
function BreakdownDrawer({ data, onClose, t }) {
  const breakdown = Array.isArray(data?.breakdown) ? data.breakdown : [];
  const currency = data?.currency || "DKK";
  const hourly = Number(data?.accountant_hourly_rate) || 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-gray-900/50 backdrop-blur-sm"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="acct-savings-breakdown-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-t-2xl sm:rounded-xl shadow-sm max-w-md w-full p-5 sm:p-6"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3
            id="acct-savings-breakdown-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {t(
              "acctSavingsBreakdownTitle",
              "Sådan er timerne regnet ud",
            ) || "Sådan er timerne regnet ud"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1 -m-1"
            aria-label={t("close", "Close") || "Close"}
          >
            <Icon name="X" size={18} />
          </button>
        </div>

        {breakdown.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t(
              "acctSavingsBreakdownEmpty",
              "Endnu ingen aktivitet i denne måned. Scan en kvittering, lås en kasserapport eller udsted en faktura for at se timerne stige.",
            ) ||
              "Endnu ingen aktivitet i denne måned. Scan en kvittering, lås en kasserapport eller udsted en faktura for at se timerne stige."}
          </p>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-800">
            {breakdown.map((row) => {
              const items = Number(row?.items) || 0;
              const hours = Number(row?.hours) || 0;
              const equivKr = hours * hourly;
              return (
                <li
                  key={row.source}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {sourceLabel(t, row.source)}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {items}{" "}
                      {t("acctSavingsItemsLabel", "stk") || "stk"}{" "}
                      ·{" "}
                      {fmtHours(hours)}{" "}
                      {t("acctSavingsHoursShort", "t") || "t"}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {fmtMoney(equivKr, currency)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {breakdown.length > 0 && (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-4 leading-snug">
            {t(
              "acctSavingsBreakdownHonesty",
              "Tallene tæller kun handlinger, der faktisk er sket: kvitteringer med foto, låste kasserapporter, downloadede MOMS-eksporter og sendte fakturaer. Vi runder altid ned.",
            ) ||
              "Tallene tæller kun handlinger, der faktisk er sket: kvitteringer med foto, låste kasserapporter, downloadede MOMS-eksporter og sendte fakturaer. Vi runder altid ned."}
          </p>
        )}
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════
// Main widget
// ═════════════════════════════════════════════════════════════════════
// Per-month dismissal — owner clicks X, widget hides for the rest of
// THIS calendar month, then reappears automatically when a new month
// starts AND fresh savings have accrued. Reappearing monthly is the
// point: the widget IS the proof that BonBox earns the subscription
// fee, so a permanent dismissal would silently kill that signal.
function _currentMonthKey() {
  const d = new Date();
  return `acctSavingsDismissed_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function _isDismissedThisMonth() {
  try {
    return window.localStorage.getItem(_currentMonthKey()) === "1";
  } catch {
    return false; // private mode / storage disabled → never hide
  }
}
function _dismissThisMonth() {
  try {
    window.localStorage.setItem(_currentMonthKey(), "1");
  } catch {
    // noop — storage unavailable, dismissal is best-effort
  }
}

export default function AccountantHoursWidget() {
  const { t } = useLanguage();
  const { hasFeature } = useEntitlements();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => _isDismissedThisMonth());

  // L1 — frontend pre-flight gate. The backend service also enforces
  // this (Free returns zero payload regardless), so a user who bypasses
  // useEntitlements still can't see real numbers.
  const featureAvailable = hasFeature("accountant_hours_widget");

  useEffect(() => {
    let alive = true;
    if (!featureAvailable) {
      // Free tier — don't even hit the API. The locked state below
      // renders without it.
      setLoading(false);
      return () => { alive = false; };
    }
    api
      .get("/accountant-savings/current-month", { _noRetry: true })
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => {
        // L3 — silent fail on network / 5xx. Show the empty-state copy
        // rather than a broken card.
        if (alive) setData(null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [featureAvailable]);

  // ── Locked state (Free tier) ────────────────────────────────────────
  // We DON'T self-hide here — that would mean Free users never see the
  // value prop. Show an upsell so the widget is its own marketing
  // surface.
  if (!featureAvailable) {
    return (
      <UpgradeNudge
        intent="card"
        tier="starter"
        benefit={
          t(
            "acctSavingsLockedBenefit",
            "Sparer revisoren timer fra Starter",
          ) || "Sparer revisoren timer fra Starter"
        }
        icon={<Icon name="Clock" size={28} />}
        ctaLabel={t("seePlans", "See plans") || "See plans"}
      />
    );
  }

  // ── Loading state — low-noise skeleton so the dashboard doesn't shift ─
  if (loading) {
    return (
      <Card variant="subtle" className="animate-pulse">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-3" />
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-2/3" />
      </Card>
    );
  }

  // ── Per-month dismissal — owner clicked X earlier this month ──────
  // Render nothing for the rest of the calendar month; the localStorage
  // key resets when a new month starts (see _currentMonthKey).
  if (dismissed) {
    return null;
  }

  // ── Live numbers ────────────────────────────────────────────────────
  const hours = Number(data?.hours_saved) || 0;
  const money = Number(data?.money_saved_dkk) || 0;
  const currency = data?.currency || "DKK";
  const breakdown = Array.isArray(data?.breakdown) ? data.breakdown : [];
  const totalItems = breakdown.reduce(
    (acc, row) => acc + (Number(row?.items) || 0),
    0,
  );

  // Dismiss handler — used by the X button on the live-numbers tile.
  // stopPropagation is critical because the whole tile is itself a
  // <button> that opens the drawer; without it, dismissing would also
  // pop the drawer for a split-second.
  function handleDismiss(e) {
    e.stopPropagation();
    e.preventDefault();
    _dismissThisMonth();
    setDismissed(true);
  }

  // Empty-state copy (Starter+ with no activity this month yet). Render
  // the same tile shell but with a hint to take an action. Better than
  // showing "0 timer" with no context.
  if (hours <= 0 || breakdown.length === 0) {
    return (
      <Card
        variant="subtle"
        className="rounded-xl"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
            <Icon name="Clock" size={18} className="text-gray-500 dark:text-gray-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
              {t("acctSavingsLabel", "Sparet revisor-tid") || "Sparet revisor-tid"}
            </div>
            <p className="text-sm text-gray-900 dark:text-gray-100 font-medium">
              {t(
                "acctSavingsEmptyHeadline",
                "Vi tæller dine timer fra første handling",
              ) || "Vi tæller dine timer fra første handling"}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-snug">
              {t(
                "acctSavingsEmptyHint",
                "Scan en kvittering, lås en kasserapport eller send en faktura — så vises tallene her.",
              ) ||
                "Scan en kvittering, lås en kasserapport eller send en faktura — så vises tallene her."}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  // Live-numbers tile. Click → drawer. X (top-right) → dismiss for the month.
  return (
    <>
      <div className="relative">
        {/* Dismiss X — positioned absolute so it overlays the tile's click
            target. Tap target = 32×32 (a11y / touch). stopPropagation is
            inside handleDismiss so the underlying drawer-open button
            doesn't also fire. */}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={
            t("acctSavingsDismissAria", "Skjul indtil næste måned") ||
            "Skjul indtil næste måned"
          }
          title={
            t("acctSavingsDismissTitle", "Skjul indtil næste måned") ||
            "Skjul indtil næste måned"
          }
          className={
            "absolute top-2 right-2 z-10 w-8 h-8 rounded-lg " +
            "flex items-center justify-center text-gray-400 dark:text-gray-500 " +
            "hover:text-gray-700 dark:hover:text-gray-200 " +
            "hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          }
        >
          <Icon name="X" size={16} aria-hidden="true" />
        </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          t("acctSavingsTileAria", "Se hvordan timerne er regnet ud") ||
          "Se hvordan timerne er regnet ud"
        }
        className={
          "w-full text-left rounded-xl ring-1 ring-gray-200 dark:ring-gray-800 " +
          "bg-white dark:bg-gray-900 p-5 hover:shadow-sm transition-shadow " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 " +
          "focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
        }
      >
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
            <Icon name="TrendingDown" size={20} className="text-gray-700 dark:text-gray-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <Icon name="Clock" size={14} className="text-gray-500 dark:text-gray-400" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("acctSavingsLabel", "Sparet revisor-tid") || "Sparet revisor-tid"}
              </span>
            </div>
            <p className="text-[15px] sm:text-base text-gray-900 dark:text-gray-100 leading-snug">
              {/* Headline string with `{hours}` substituted in place and
                  `{money}` ALWAYS stripped — we render the money
                  separately below in emerald so the colour is reliable
                  across locales whose word order differs. */}
              {t(
                "acctSavingsHeadline",
                "Du har sparet revisoren {hours} timer denne måned · ca. {money}",
              )
                .replace("{hours}", fmtHours(hours))
                .replace(/·\s*~?\s*{money}\s*$/, "")
                .replace("{money}", "")
                .trim()}
              {" · "}
              <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums whitespace-nowrap">
                {t("acctSavingsApprox", "ca.") || "ca."}{" "}
                {fmtMoney(money, currency)}
              </span>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-snug">
              {t(
                "acctSavingsSubtitle",
                "Baseret på {n} kvitteringer, lukninger, MOMS-eksporter og fakturaer",
              ).replace("{n}", String(totalItems))}
            </p>
          </div>
          <Icon
            name="ChevronDown"
            size={18}
            className="-rotate-90 text-gray-400 shrink-0 mt-1"
            aria-hidden="true"
          />
        </div>
      </button>
      </div>

      {open && (
        <BreakdownDrawer
          data={data}
          onClose={() => setOpen(false)}
          t={t}
        />
      )}
    </>
  );
}
