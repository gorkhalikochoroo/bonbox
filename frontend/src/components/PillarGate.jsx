/**
 * PillarGate — the RELEVANCE-axis interstitial (architecture_pillar_visibility.md).
 *
 * Wraps an OWNER pillar page. When the page's pillar is toggled OFF
 * (users.hidden_pillars), we render a calm "this is turned off for your
 * business — turn it back on?" card INSTEAD of the page. When the pillar is
 * ON (the default + grandfather state), children render untouched.
 *
 * WHY AN INTERSTITIAL, NOT A 404 / REDIRECT (locked spec decision):
 *   A deactivated pillar deep link (bookmark, push notification, ⌘K enable-
 *   action, a stale tab) must land on a one-tap re-enable, NOT a dead end.
 *   404 reads as "this broke"; a redirect silently swallows intent. The
 *   interstitial says "you turned this off — here's the switch", preserving
 *   the link and the owner's mental model. (BonBox has the capability; the
 *   owner chose to hide it.)
 *
 * HARD BOUNDARIES (App.jsx wires this ONLY around owner pillar routes):
 *   • NEVER wraps public surfaces (/r, /e, /s, /scan), spine routes, the
 *     accountant client picker, or auth routes — App.jsx enumerates which
 *     routes get a gate, and the unhideable spine has no `pillar` at all.
 *   • Accountant-view + logged-out yield an empty hiddenPillars Set upstream
 *     (usePillars no-ops them), so this gate is inert for a revisor by
 *     construction — belt-and-braces, the gate also never fires when
 *     hiddenPillars is empty.
 *   • Tier-locked is a DIFFERENT state: a pillar that is ON but tier-locked
 *     still renders the page (which shows its own UpgradeNudge). This gate
 *     only intercepts the hidden state.
 *
 * Loading: while usePillars is still resolving (hiddenPillars settles to the
 * real Set), `isReady` is false and we render children — never flash the
 * interstitial before we know the pillar is actually off (mirrors the
 * tier-flicker doctrine in useEntitlements).
 */
import { useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { usePillars } from "../hooks/usePillars";
import { useUndoToast } from "../hooks/useUndoToast";
import { Button, Card, Icon } from "./ui";

/**
 * Per-pillar interstitial metadata. Icon name (Lucide via <Icon>) +
 * the i18n keys for the title/body. Keys resolved against useLanguage.jsx
 * (real en + da entries — see the pillarGate* block there).
 */
const PILLAR_META = {
  reservations: { icon: "CalendarCheck", titleKey: "pillarGateReservationsTitle", bodyKey: "pillarGateReservationsBody" },
  gavekort:     { icon: "Gift",          titleKey: "pillarGateGavekortTitle",     bodyKey: "pillarGateGavekortBody" },
  events:       { icon: "CalendarDays",  titleKey: "pillarGateEventsTitle",       bodyKey: "pillarGateEventsBody" },
  inventory:    { icon: "Package",       titleKey: "pillarGateInventoryTitle",    bodyKey: "pillarGateInventoryBody" },
  staff:        { icon: "UsersRound",    titleKey: "pillarGateStaffTitle",        bodyKey: "pillarGateStaffBody" },
  insights:     { icon: "Sparkles",      titleKey: "pillarGateInsightsTitle",     bodyKey: "pillarGateInsightsBody" },
};

export default function PillarGate({ pillar, children }) {
  const { t } = useLanguage();
  const { hiddenPillars, isReady, setPillarHidden } = usePillars();
  const { show: showUndo, ToastUI } = useUndoToast();
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState("");

  // No pillar declared (defensive) or pillar state not settled yet → render
  // the page. Never flash the interstitial during the cold-load window.
  if (!pillar || !isReady) return children;

  // Pillar is ON (the default + grandfather state) → render the page.
  if (!hiddenPillars.has(pillar)) return children;

  const meta = PILLAR_META[pillar] || PILLAR_META.insights;

  const enable = async () => {
    setError("");
    setEnabling(true);
    try {
      // Optimistic re-enable. The Set update flips hiddenPillars.has(pillar)
      // to false, so children render on the next pass automatically.
      await setPillarHidden(pillar, false);
      // Offer a quick undo — re-hide if the owner tapped by mistake.
      showUndo({
        message: t("pillarGateEnabledToast"),
        onUndo: async () => { await setPillarHidden(pillar, true); },
      });
    } catch (e) {
      setError(
        e?.response?.data?.detail ||
        t("pillarGateEnableFailed"),
      );
      setEnabling(false);
    }
    // On success we don't clear `enabling` — the component unmounts as the
    // page takes over, so leaving the button busy avoids a flash of the
    // idle state during the swap.
  };

  return (
    <div className="p-4 sm:p-6 page-enter">
      <div className="max-w-md mx-auto mt-8 sm:mt-16">
        <Card variant="emphasis" className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
            <Icon name={meta.icon} className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t(meta.titleKey)}
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t(meta.bodyKey)}
          </p>
          {error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-center">
            <Button
              variant="primary"
              size="lg"
              busy={enabling}
              onClick={enable}
              iconLeft={!enabling ? <Icon name={meta.icon} className="h-4 w-4" /> : null}
            >
              {t("pillarGateEnableCta")}
            </Button>
          </div>
          <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
            {t("pillarGateManageHint")}
          </p>
        </Card>
      </div>
      {ToastUI}
    </div>
  );
}
