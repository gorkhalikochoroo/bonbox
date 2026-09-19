/**
 * InventoryPanel — Zone 3, critical items only.
 *
 * Gated on `activations.hasInventory && inventoryCriticalCount > 0`
 * per the card-set config. The full inventory grid lives in /inventory;
 * this surface is the safety-net alert that surfaces on the dashboard
 * when the owner needs to reorder.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • Item names + qty/min in neutral gray. No tinted backgrounds —
 *     the renderIf already gates this card on "there ARE critical
 *     items," so the existence of the card IS the signal.
 *   • Clickable card → /inventory.
 *
 * The card navigates to /inventory, so the count it prints has to be a count
 * of rows that page will show. It used to do its own `qty <= min` arithmetic
 * over everything /dashboard/batch returned, which is how it announced 23
 * items over an empty Stock page. The predicate now lives in one place —
 * utils/inventoryReorder.js, fed by the backend's `needs_reorder` — and that
 * file explains why an absent field renders nothing instead of guessing.
 *
 * It reads `ctx.inventoryReorder`, the payload's COMPLETE flagged set, not the
 * 50-row display sample in `ctx.inventoryItems`. Counting the sample is how
 * the same defect came back inverted: an account whose low rows were older
 * than its newest 50 got silence here and "Low stock (6)" on the Stock page.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";
import { reorderNeededItems } from "../../utils/inventoryReorder";

export default function InventoryPanel({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const critical = reorderNeededItems(ctx?.inventoryReorder);

  if (critical.length === 0) return null;

  const top = critical.slice(0, 5);

  return (
    <div
      onClick={() => navigate("/inventory")}
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))] transition"
      data-zone="3"
      data-component="InventoryPanel"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("inventory", "Inventory")}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("reorderNeeded", "Reorder needed")} ({critical.length})
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {top.map((it, i) => {
          const qty = parseFloat(it.quantity) || 0;
          const min = parseFloat(it.min_threshold) || 0;
          return (
            <li
              key={(it.id || it.name) + i}
              className="flex items-center justify-between text-sm"
            >
              <span className="text-gray-900 dark:text-gray-100 font-medium truncate flex-1">
                {it.name}
              </span>
              <span className="text-gray-500 dark:text-gray-400 tabular-nums shrink-0">
                {qty} / {min} {it.unit || ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
