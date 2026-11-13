/**
 * Køkken-iPad — pair a kitchen iPad with a 6-character code, see the paired
 * ones, and remove one (owner only; on a curtained shared device the server
 * wants the reveal PIN). The iPad types the code at bonbox.dk/stand, the same
 * pairing page as the door screen; the server sends it on to /kitchen/<token>.
 * A paired iPad reaches only the kitchen routes: readings, undo and the
 * Kontrolmappe. Removing it makes its next request a 404 at once.
 */
import { useEffect, useState } from "react";
import { Tablet } from "lucide-react";
import Button from "../ui/Button";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { formatDateClear } from "../../utils/dateFormat";

function seenText(iso, lang) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = d.toLocaleTimeString(lang === "da" ? "da-DK" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${formatDateClear(local)} ${time}`;
}

export default function KitchenDevicesCard({ branchId = null, t, lang = "da" }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [devices, setDevices] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get("/egenkontrol/devices")
      .then((r) => {
        if (!alive) return;
        setDevices(Array.isArray(r.data?.devices) ? r.data.devices : []);
        setFailed(false);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const pair = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post("/egenkontrol/devices", {
        label: t("ekDeviceDefaultLabel"),
        ...(branchId ? { branch_id: branchId } : {}),
      });
      setCode(res?.data || null);
      setReload((n) => n + 1);
    } catch {
      toast({ message: t("ekErrSaveFailed"), severity: "critical" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (d) => {
    const label = d.label || t("ekDeviceDefaultLabel");
    const ok = await confirm({
      title: t("ekDeviceRevokeConfirmTitle", { label }),
      message: t("ekDeviceRevokeConfirmBody"),
      confirmLabel: t("ekDeviceRevoke"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (ok !== true) return;
    try {
      await api.delete(`/egenkontrol/devices/${encodeURIComponent(d.id)}`);
      if (code?.id === d.id) setCode(null);
      setReload((n) => n + 1);
    } catch {
      toast({ message: t("ekErrSaveFailed"), severity: "critical" });
    }
  };

  const live = (devices || []).filter((d) => d.active && !d.revoked_at);

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5" data-testid="ek-devices">
      <div className="flex items-start gap-3">
        <Tablet className="w-5 h-5 mt-0.5 shrink-0 text-gray-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold text-gray-900 dark:text-gray-50">{t("ekDevicesTitle")}</h3>
          <p className="mt-1 text-[14px] text-gray-600 dark:text-gray-400">{t("ekDevicesBody")}</p>
        </div>
      </div>

      {failed ? (
        <p className="mt-3 text-[14px] text-gray-700 dark:text-gray-300" role="alert">{t("ekLoadFailed")}</p>
      ) : null}

      {live.length ? (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          {live.map((d) => (
            <li key={d.id} className="px-3 py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-gray-900 dark:text-gray-100 truncate">{d.label || t("ekDeviceDefaultLabel")}</p>
                <p className="text-[13px] text-gray-600 dark:text-gray-400">
                  {d.paired
                    ? d.last_seen_at
                      ? t("ekDeviceLastSeen", { time: seenText(d.last_seen_at, lang) })
                      : null
                    : t("ekDeviceNotPaired")}
                </p>
              </div>
              <Button variant="ghost" className="h-10 text-red-700 dark:text-red-400" onClick={() => revoke(d)}>
                {t("ekDeviceRevoke")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {code?.code ? (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4" role="status" data-testid="ek-pair-code">
          <p className="font-mono text-[24px] tracking-[0.12em] font-semibold text-gray-900 dark:text-gray-50">
            {t("ekPairCode", { code: code.code })}
          </p>
          <p className="mt-1 text-[14px] text-gray-700 dark:text-gray-300">{t("ekPairSteps")}</p>
        </div>
      ) : null}

      <Button variant="primary" className="mt-3 h-10" busy={busy} disabled={busy} onClick={pair}>
        {t("ekPairIpad")}
      </Button>
    </section>
  );
}
