/**
 * Two small owner cards for the Egenkontrol page (R1b).
 *
 * SmileyLinkCard (Opsætning) — the venue's OWN link to its page on
 * findsmiley.dk (Decision 7). The owner pastes it; BonBox shows it as a plain
 * text link in the Kontrolmappe (owner and kitchen iPad) — never the smiley
 * image, never an authority's logo, and nothing here says whether a booking
 * page or a website counts as marketing. The client checks the prefix only to
 * say so early; the server's allow-list is the rule (https://www.findsmiley.dk/
 * or https://findsmiley.dk/, kept in the one www form, ≤ 255, no spaces). An
 * empty field removes the link.
 *
 * RetailOptInCard (/egenkontrol for a grocery, veggie shop or kiosk that has
 * not switched it on) — one tap: "Slå egenkontrol til". It is offered, never
 * pushed: a shop with fridges or freezers of food can use it; a shop without
 * does not need it. Never a module slot (vertical modules are tier-capped).
 */
import { useState } from "react";
import Button from "../ui/Button";
import api from "../../services/api";
import { EK_ERROR_KEYS, FINDSMILEY_MAX, checkFindsmiley, errorCode } from "./ekLogic";

const FIELD =
  "w-full h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";
const CARD = "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4";

export function SmileyLinkCard({ value = null, onSaved, t }) {
  const [text, setText] = useState(value || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const checked = checkFindsmiley(text);
  const unchanged = (checked ?? text.trim()) === (value || "");

  const save = async () => {
    if (busy) return;
    setSaved(false);
    if (checked === null) {
      setError(t("ekErrSmileyUrl"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.put("/egenkontrol/settings", { findsmiley_url: checked || null });
      setText(res?.data?.findsmiley_url || "");
      setSaved(true);
      onSaved?.(res?.data || null);
    } catch (err) {
      setError(t(EK_ERROR_KEYS[errorCode(err)] || "ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={CARD} data-testid="ek-smiley-card">
      <label htmlFor="ek-smiley-url" className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t("ekSmileyLabel")}</label>
      <p className="mt-1 text-[13.5px] text-gray-600 dark:text-gray-400" data-testid="ek-smiley-help">{t("ekSmileyHelp")}</p>
      <div className="mt-2 flex flex-col sm:flex-row gap-2">
        <input
          id="ek-smiley-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className={FIELD}
          value={text}
          maxLength={FINDSMILEY_MAX + 20}
          placeholder="https://www.findsmiley.dk/…"
          onChange={(e) => {
            setText(e.target.value);
            setError("");
            setSaved(false);
          }}
          aria-invalid={checked === null}
        />
        <Button variant="secondary" className="h-10 shrink-0" busy={busy} disabled={busy || unchanged} onClick={save} data-testid="ek-smiley-save">
          {t("ekSave")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13.5px] text-red-700 dark:text-red-400" data-testid="ek-smiley-error">{error}</p>
      ) : checked === null && text.trim() ? (
        <p className="mt-2 text-[13.5px] text-red-700 dark:text-red-400" data-testid="ek-smiley-error">{t("ekErrSmileyUrl")}</p>
      ) : saved ? (
        <p role="status" className="mt-2 text-[13.5px] text-gray-700 dark:text-gray-300">{t("ekSmileySaved")}</p>
      ) : null}
    </section>
  );
}

export function RetailOptInCard({ onDone, t }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const optIn = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.put("/egenkontrol/settings", { opted_in: true });
      onDone?.(res?.data || null);
    } catch (err) {
      setError(t(EK_ERROR_KEYS[errorCode(err)] || "ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={CARD + " sm:p-6"} data-testid="ek-optin-card">
      <h2 className="text-[20px] font-semibold text-gray-900 dark:text-gray-50">{t("ekOptInTitle")}</h2>
      <p className="mt-1 text-[15px] text-gray-600 dark:text-gray-400">{t("ekOptInBody")}</p>
      {error ? <p role="alert" className="mt-3 text-[13.5px] text-red-700 dark:text-red-400">{error}</p> : null}
      <Button variant="main" className="mt-4 h-10" busy={busy} disabled={busy} onClick={optIn} data-testid="ek-optin">
        {t("ekOptInButton")}
      </Button>
    </section>
  );
}
