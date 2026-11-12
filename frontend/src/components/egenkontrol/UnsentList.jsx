/**
 * Every reading this device still holds — check, value, the device's typed
 * time, who. The kitchen's revoked screen shows it as the last place these
 * readings lived ("skriv dem på papir"); the load-failed screens (kitchen and
 * owner, after an offline reload) show it under their own heading, so nobody
 * writes on paper what is still waiting to be sent.
 */
import { valueText } from "./ekLogic";

export default function UnsentList({ items, t, lang, heading = null }) {
  if (!items?.length) return null;
  const typed = (iso) => {
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) return "";
    const d = new Date(at);
    let date = "";
    try {
      date = new Intl.DateTimeFormat(lang === "da" ? "da-DK" : "en-GB", { day: "numeric", month: "short" }).format(d);
    } catch {
      date = "";
    }
    return `${date} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`.trim();
  };
  return (
    <div className="mt-2" data-testid="ek-kitchen-unsent-list">
      <p className="text-[15px] text-gray-800 dark:text-gray-200">{heading || t("ekKitchenUnsentList")}</p>
      <ul className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((it) => {
          const who = it.draft?.who ? it.draft.who.label || it.draft.who.name || "" : "";
          const value = it.body?.done === true ? t("ekTickDone") : valueText({ value_c: it.body?.value_c }, t, lang);
          return (
            <li key={it.clientId} className="px-3 py-2 text-[15px] text-gray-900 dark:text-gray-100">
              <span className="font-semibold">{it.checkName || ""}</span>
              {" · "}
              <span className="font-display tabular-nums">{value}</span>
              {" · "}
              <span className="font-display tabular-nums">{typed(it.typedAt || it.body?.client_typed_at)}</span>
              {who ? <span> · {who}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
