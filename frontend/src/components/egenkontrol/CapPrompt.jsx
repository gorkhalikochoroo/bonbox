/* eslint-disable react-refresh/only-export-components -- the cap's two small
   helpers live with the line and the prompt that use them. */
/**
 * The Free plan's limit on active TEMPERATURE checks (Decision 1: 6 — the
 * five-item start list and one spare). Founder, 13 Nov 2026: cleaning and
 * thermometer ticks never count and never give a 402, on any plan — the
 * server's `cap.active` counts temperature checks only, and so does the
 * fallback (ekLogic countsTowardCap). Owner surfaces only (never the kitchen
 * iPad: KitchenPage does not import this file, nor components/Entitlement).
 *
 * CapLine: "Jeres plan: op til 6 temperaturkontroller · 5 i brug. Rengøring
 * og termometertjek tæller ikke med." when the plan has a real limit (< 100);
 * after a downgrade with more than the limit: "I har 8 temperaturkontroller.
 * De virker alle stadig. …" — every existing check keeps recording, and
 * nothing suggests the records are incomplete.
 *
 * CapPrompt: what a 402 cap_exceeded opens. On the web the upgrade sheet
 * (components/Entitlement UpgradePrompt, forCap) naming the plan the 402
 * says lifts the limit (detail.upgrade_to — Starter, never an oversold Pro).
 * It is portaled to <body> ABOVE the Sheet layer (Sheet is z-[60]): the
 * check editor is itself a Sheet, and a prompt rendered in place sat under
 * its backdrop, unseen. In the iOS / Android app nothing with a purchase
 * link (Apple 3.1.1) — the caller shows the inline ekCapReached text, which
 * it also shows on the web.
 */
import { createPortal } from "react-dom";
import { UpgradePrompt } from "../Entitlement";
import { isNativeApp } from "../../utils/platform";

export const CAP_KEY = "egenkontrol_active_checks";
/** Above ui/Sheet's z-[60], so the prompt opens over the check editor. */
export const CAP_PROMPT_Z = "z-[70]";

/** The plan a 402 cap_exceeded names (detail.upgrade_to), or null. */
export function capUpgradeTo(err) {
  const d = err?.response?.data?.detail;
  const to = d && typeof d === "object" ? d.upgrade_to : null;
  return typeof to === "string" && to ? to : null;
}

/** {limit, active} for the line, from the server's `cap` or the entitlements. */
export function capInfo(serverCap, entCap, activeFallback = null) {
  const limit = Number.isFinite(Number(serverCap?.limit)) ? Number(serverCap.limit) : Number(entCap);
  const active = Number.isFinite(Number(serverCap?.active)) ? Number(serverCap.active) : activeFallback;
  if (!Number.isFinite(limit) || limit < 0) return null;
  return { limit, active: Number.isFinite(Number(active)) ? Number(active) : null };
}

export function CapLine({ cap, t, testId = "ek-cap-line" }) {
  if (!cap || cap.limit >= 100 || cap.active == null) return null;
  if (cap.active > cap.limit) {
    return (
      <p className="text-[13.5px] text-gray-700 dark:text-gray-300" data-testid={testId}>
        {t("ekCapOver", { active: cap.active, limit: cap.limit })}
      </p>
    );
  }
  return (
    <p className="text-[13.5px] text-gray-600 dark:text-gray-400 font-display tabular-nums" data-testid={testId}>
      {t("ekCapLine", { limit: cap.limit, active: cap.active })}
    </p>
  );
}

export default function CapPrompt({ open, onClose, upgradeTo = null }) {
  if (!open || isNativeApp() || typeof document === "undefined") return null;
  return createPortal(
    <div className={`relative ${CAP_PROMPT_Z}`} data-testid="ek-cap-prompt">
      <UpgradePrompt feature={CAP_KEY} forCap open onClose={onClose} targetPlan={upgradeTo || "starter"} />
    </div>,
    document.body,
  );
}
