/**
 * SmartPricingModal — opens when the owner clicks "Compare price" on
 * an inventory row. Fetches /api/smart-pricing/item?name=<item name>
 * and renders a single SmartPricingCard plus a privacy footnote.
 *
 * The modal is the per-item entry point; the batch view lives on
 * PricingPage. Both backends share the same privacy gate.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import Modal from "./Modal";
import SmartPricingCard from "./SmartPricingCard";
import { useLanguage } from "../hooks/useLanguage";

export default function SmartPricingModal({ open, onClose, itemName, currencyCode }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !itemName) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get(`/smart-pricing/item?name=${encodeURIComponent(itemName)}`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, itemName]);

  if (!open) return null;

  const privacyNote = (t("smartPricingPrivacyNote") ||
    "All comparisons aggregate at least {n} businesses. We never show individual prices.")
    .replace("{n}", data?.min_samples || 5);

  return (
    <Modal open={open} onClose={onClose} title={t("smartPricingModalTitle") || "Market comparison"}>
      <div className="space-y-3">
        {loading && (
          <div className="text-center py-6">
            <div className="text-3xl animate-pulse">📊</div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{t("loading") || "Loading…"}</p>
          </div>
        )}
        {error && !loading && (
          <div className="text-center py-6 text-sm text-red-500">
            {t("smartPricingTempUnavailable") || "Couldn't load market comparison."}
          </div>
        )}
        {data && !loading && !error && (
          <>
            <SmartPricingCard comparison={data} currencyCode={currencyCode} />
            <p className="text-xs text-gray-500 dark:text-gray-400 italic">{privacyNote}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
