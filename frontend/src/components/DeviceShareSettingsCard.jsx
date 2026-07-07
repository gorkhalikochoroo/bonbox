/**
 * Shared-device ("Delt enhed") Settings card (#379, Slice 2).
 *
 * Lets the owner turn THIS device into a shared one: set a 4-digit reveal PIN
 * and flag the device shared (financials curtain for anyone holding it until the
 * PIN is entered). Turning it OFF needs the account password. Opt-in — a solo
 * owner never touches this. Sits next to the "Sign out other devices" card.
 *
 * HONEST copy only: "hide your numbers from staff on a shared device" — never
 * "secure/krypteret". See [[design_owner_shared_device_pin]].
 */
import { useState } from "react";
import { Tablet } from "lucide-react";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useLanguage } from "../hooks/useLanguage";

function PinField({ value, onChange, placeholder }) {
  return (
    <input
      type="tel"
      inputMode="numeric"
      autoComplete="off"
      maxLength={4}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))}
      className="w-28 tracking-[0.4em] text-center rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100"
    />
  );
}

export default function DeviceShareSettingsCard() {
  const { t } = useLanguage();
  const { ready, enabled, hasPin, setPin, enableShared, disableShared } = useDeviceShare();
  const [pin, setPinValue] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("idle"); // idle | enabling | disabling
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  if (!ready) return null;

  const reset = () => { setPin(""); setPinValue(""); setPassword(""); setErr(""); };

  const doEnable = async () => {
    if (pin.length !== 4) { setErr(t("deviceCfgPin4", "PIN must be 4 digits.")); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      await setPin(pin);
      await enableShared();
      setMode("idle"); reset();
      setMsg(t("deviceCfgEnabled", "Shared mode is on for this device."));
    } catch { setErr(t("deviceCfgFailed", "Couldn't update. Try again.")); }
    finally { setBusy(false); }
  };

  const doChangePin = async () => {
    if (pin.length !== 4) { setErr(t("deviceCfgPin4", "PIN must be 4 digits.")); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      await setPin(pin);
      setPinValue(""); setMode("idle");
      setMsg(t("deviceCfgPinChanged", "PIN updated."));
    } catch { setErr(t("deviceCfgFailed", "Couldn't update. Try again.")); }
    finally { setBusy(false); }
  };

  const doDisable = async () => {
    if (!password) { setErr(t("deviceCfgPwNeeded", "Enter your password.")); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      await disableShared(password);
      setMode("idle"); setPassword("");
      setMsg(t("deviceCfgDisabled", "Shared mode is off for this device."));
    } catch { setErr(t("deviceCfgPwWrong", "Wrong password.")); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5" data-component="DeviceShareSettingsCard">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
          <Tablet className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("deviceCfgTitle", "Shared device (Delt enhed)")}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t("deviceCfgBody", "On a device you pass to staff, hide your finances (Reports, MOMS, bank, cash-flow) behind a 4-digit PIN. It hides your numbers — it isn't a lock on the device itself.")}
          </p>

          {enabled ? (
            <div className="mt-3">
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900">
                {t("deviceCfgOnHere", "On for this device")}
              </span>
              <div className="mt-3 flex flex-wrap gap-2">
                {mode !== "changePin" && (
                  <button type="button" onClick={() => { setMode("changePin"); setErr(""); setMsg(""); }}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">
                    {t("deviceCfgChangePin", "Change PIN")}
                  </button>
                )}
                {mode !== "disabling" && (
                  <button type="button" onClick={() => { setMode("disabling"); setErr(""); setMsg(""); }}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">
                    {t("deviceCfgTurnOff", "Turn off")}
                  </button>
                )}
              </div>

              {mode === "changePin" && (
                <div className="mt-3 flex items-center gap-2">
                  <PinField value={pin} onChange={setPinValue} placeholder="••••" />
                  <button type="button" disabled={busy} onClick={doChangePin}
                    className="text-sm px-3 py-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 disabled:opacity-50">
                    {t("save", "Save")}
                  </button>
                </div>
              )}
              {mode === "disabling" && (
                <div className="mt-3 flex items-center gap-2">
                  <input type="password" autoComplete="current-password" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("password", "Password")}
                    className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
                  <button type="button" disabled={busy} onClick={doDisable}
                    className="text-sm px-3 py-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 disabled:opacity-50">
                    {t("deviceCfgConfirmOff", "Turn off")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3">
              {mode === "enabling" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <PinField value={pin} onChange={setPinValue} placeholder={t("deviceCfgSetPin", "Set PIN")} />
                  <button type="button" disabled={busy} onClick={doEnable}
                    className="text-sm px-3 py-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 disabled:opacity-50">
                    {t("deviceCfgTurnOn", "Turn on")}
                  </button>
                  <button type="button" onClick={() => { setMode("idle"); reset(); }}
                    className="text-sm px-2 py-2 text-gray-500 dark:text-gray-400">
                    {t("cancel", "Cancel")}
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => { setMode("enabling"); setErr(""); setMsg(""); }}
                  className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">
                  {hasPin ? t("deviceCfgTurnOnHere", "Turn on for this device") : t("deviceCfgSetUp", "Set up on this device")}
                </button>
              )}
            </div>
          )}

          {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
          {msg && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
