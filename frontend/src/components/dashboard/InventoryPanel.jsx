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
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

export default function InventoryPanel({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const critical = (ctx?.inventoryItems || []).filter((i) => {
    const qty = parseFloat(i.quantity) || 0;
    const min = parseFloat(i.min_threshold) || 0;
    return min > 0 && qty <= min;
  });

  if (critical.length === 0) return null;

  const top = critical.slice(0, 5);

  return (
    <div
      onClick={() => navigate("/inventory")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
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
