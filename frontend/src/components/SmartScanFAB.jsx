/**
 * SmartScanFAB — mobile-only floating action button that opens
 * SmartScanModal.
 *
 * Layout context (matters because the page has several other floats):
 *   • QuickAdd "+" lives bottom-LEFT
 *   • BonBoxAgent lives bottom-RIGHT, ~5rem from the bottom (above the
 *     mobile bottom nav + iOS safe-area inset)
 *   • SupportChip "?" lives bottom-LEFT at the very edge
 *   • MobileBottomNav itself is fixed at the bottom (h-14 + safe-area)
 *
 * The Smart Scan FAB lands ABOVE the BonBoxAgent orb in the bottom-
 * right column so it doesn't collide with any existing affordance. We
 * pin it with `bottom: calc(9rem + env(safe-area-inset-bottom))` —
 * 9rem ≈ BonBoxAgent at 5rem + the orb's own 3.5rem height + a
 * 0.5rem gap. md:hidden hides it on desktop where the sidebar already
 * exposes every entry point (and screen real-estate isn't precious).
 *
 * Visibility rules:
 *   • mobile only (md:hidden)
 *   • the Layout wrapper already removes us on /pricing /subscription
 *     (the _HIDE_FLOATING_ON list), so we don't compete with billing
 *     decision-making
 *   • Login / Onboarding pages don't render Layout at all → we're
 *     automatically hidden there
 */
import { useState } from "react";
import { ScanLine } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import SmartScanModal from "./SmartScanModal";

export default function SmartScanFAB() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  const handleOpen = () => {
    setOpen(true);
    trackEvent("smart_scan_fab_opened", "smart_scan");
  };

  return (
    <>
      <button
        onClick={handleOpen}
        aria-label={t("smartScan.title", "Smart skan")}
        title={t("smartScan.title", "Smart skan")}
        // bottom is computed inline so we lift above the bottom nav,
        // the BonBoxAgent orb, AND the iPhone safe-area-inset-bottom
        // (home indicator). Without this calc, the FAB sits behind
        // either the BonBoxAgent or the nav on devices with a home
        // indicator.
        style={{ bottom: "calc(9rem + env(safe-area-inset-bottom, 0px))" }}
        className="md:hidden fixed right-6 z-40 w-12 h-12 rounded-full
          bg-emerald-600 hover:bg-emerald-700 active:scale-95
          text-white shadow-lg
          flex items-center justify-center
          transition-transform
          focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-emerald-500 focus-visible:ring-offset-2
          focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
      >
        <ScanLine size={22} strokeWidth={2} aria-hidden="true" />
      </button>

      <SmartScanModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
