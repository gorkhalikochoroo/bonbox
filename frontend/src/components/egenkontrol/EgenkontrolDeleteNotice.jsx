/**
 * The delete-account screen's one line about egenkontrol: when this account
 * has readings, offer the Kontrolmappe PDF FIRST — the readings are deleted
 * with the account. Renders nothing otherwise, and nothing on an error (the
 * delete flow is never blocked by this card). R1a: the PDF is the last 30
 * days.
 */
import { useEffect, useState } from "react";
import Button from "../ui/Button";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { useToast } from "../../hooks/useToast";
import downloadFolderPdf from "./downloadFolderPdf";

export default function EgenkontrolDeleteNotice() {
  const { t } = useLanguage();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get("/egenkontrol/status", { _noRetry: true })
      .then((r) => {
        if (alive) setStatus(r?.data || null);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!status?.has_records) return null;

  const download = async () => {
    if (busy) return;
    setBusy(true);
    const out = await downloadFolderPdf({ businessDate: status.business_date });
    setBusy(false);
    if (out?.ok) toast({ message: t("ekPdfReady"), severity: "success" });
    else toast({ message: t("ekPdfFailed"), severity: "critical" });
  };

  return (
    <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-white dark:bg-gray-900 p-3" data-testid="ek-delete-notice">
      <p className="text-sm text-gray-800 dark:text-gray-200">{t("ekDeleteNotice")}</p>
      <Button variant="secondary" size="md" className="mt-2" busy={busy} disabled={busy} onClick={download}>
        {t("ekDeleteDownload")}
      </Button>
    </div>
  );
}
