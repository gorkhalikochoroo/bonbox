// GavekortBuyPage — the public "order a gavekort online" page, at /g/buy/:slug.
//
// THE RED LINE: BonBox never takes custody of money. This page does NOT charge
// a card. The customer REQUESTS a gavekort; the business confirms payment its
// own way (MobilePay, bank transfer, in person) and THEN emails the gavekort.
// The copy says exactly that — never "paid", never "instant", no card field.
//
// Design: matches GavekortPublicPage — gray-900 text on a calm surface, a dark
// venue header, EMERALD reserved for the amount only. Mobile-first + safe-area.
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Gift, Check, ChevronRight, Mail, ShieldCheck } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";

function krFromMinor(minor) {
  if (minor == null || Number.isNaN(minor)) return "—";
  return formatKr(minor / 100);
}

// Standard DK gavekort denominations (øre), shown as chips when in bounds.
const PRESET_MINOR = [10000, 20000, 30000, 50000, 100000];

export default function GavekortBuyPage() {
  const { slug } = useParams();
  const { t } = useLanguage();
  const [load, setLoad] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/public/gavekort/buy/${encodeURIComponent(slug)}`);
        if (alive) setLoad({ loading: false, data: res.data, error: null });
      } catch (e) {
        const status = e?.response?.status;
        if (alive) setLoad({ loading: false, data: null, error: status || "network" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  return (
    <div
      className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center px-5"
      style={{
        paddingTop: "max(1.75rem, env(safe-area-inset-top))",
        paddingBottom: "max(1.75rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="w-full max-w-sm">
        {load.loading ? (
          <Centered>
            <div className="h-10 w-10 mx-auto rounded-full border-2 border-gray-200 border-t-gray-900 animate-spin" />
          </Centered>
        ) : load.error ? (
          <ClosedCard t={t} />
        ) : (
          <BuyFlow t={t} slug={slug} data={load.data} />
        )}
        <p className="mt-6 text-center text-[11px] text-gray-400 dark:text-gray-600">
          {t("gbuyPoweredBy", "Gavekort via BonBox")}
        </p>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center">
      {children}
    </div>
  );
}

function ClosedCard({ t }) {
  return (
    <Centered>
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
        <Gift className="h-6 w-6" aria-hidden />
      </div>
      <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("gbuyClosedTitle", "Gavekort kan ikke bestilles her lige nu.")}
      </p>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
        {t("gbuyClosedBody", "Tjek linket, eller kontakt forretningen direkte.")}
      </p>
    </Centered>
  );
}

function BuyFlow({ t, slug, data }) {
  const business = data?.business_name || "BonBox";
  const minMinor = data?.min_amount_minor ?? 5000;
  const maxMinor = data?.max_amount_minor ?? 500000;
  const instructions = (data?.instructions || "").trim();

  const presets = useMemo(
    () => PRESET_MINOR.filter((p) => p >= minMinor && p <= maxMinor),
    [minMinor, maxMinor],
  );

  const [amountMinor, setAmountMinor] = useState(presets[0] || minMinor);
  const [customKr, setCustomKr] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null); // {business_name, buyer_email}

  // Resolve the effective amount: a custom value (kr → øre) wins when entered.
  const customMinor = (() => {
    const v = (customKr || "").replace(/\./g, "").replace(",", ".").trim();
    if (!v) return null;
    const n = Number(v);
    if (Number.isNaN(n) || n <= 0) return null;
    return Math.round(n * 100);
  })();
  const effectiveMinor = customMinor ?? amountMinor;
  const amountValid = effectiveMinor >= minMinor && effectiveMinor <= maxMinor;
  const emailValid = /\S+@\S+\.\S+/.test(buyerEmail.trim());
  const canSubmit = amountValid && emailValid && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post(`/public/gavekort/buy/${encodeURIComponent(slug)}`, {
        amount_minor: effectiveMinor,
        buyer_name: buyerName.trim() || undefined,
        buyer_email: buyerEmail.trim(),
        recipient_name: recipient.trim() || undefined,
        message: message.trim() || undefined,
      });
      setDone(res.data);
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      if (code === "amount_out_of_range") {
        setError(
          t("gbuyErrAmount", "Beløbet skal være mellem {min} og {max}.", {
            min: krFromMinor(minMinor),
            max: krFromMinor(maxMinor),
          }),
        );
      } else if (code === "invalid_email") {
        setError(t("gbuyErrEmail", "Indtast en gyldig e-mailadresse."));
      } else if (code === "orders_closed") {
        setError(t("gbuyErrClosed", "Gavekort kan ikke bestilles her lige nu."));
      } else {
        setError(t("gbuyErrGeneric", "Noget gik galt. Prøv igen."));
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="bg-gray-900 dark:bg-black text-white px-5 py-4 flex items-center justify-between">
          <span className="font-semibold truncate">{done.business_name || business}</span>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-300">
            <Gift className="h-3.5 w-3.5" aria-hidden />
            {t("gbuyEyebrow", "Gavekort")}
          </span>
        </div>
        <div className="px-5 py-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
            <Check className="h-6 w-6" aria-hidden />
          </div>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t("gbuyDoneTitle", "Tak for din bestilling!")}
          </p>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            {t(
              "gbuyDoneBody",
              "{business} bekræfter din betaling og sender dit gavekort til {email}.",
              { business: done.business_name || business, email: done.buyer_email },
            )}
          </p>
          <div className="mt-5 rounded-xl bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-left">
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              {t(
                "gbuyDoneNote",
                "BonBox håndterer ikke selve betalingen. Forretningen kontakter dig om, hvordan du betaler.",
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      {/* Venue header */}
      <div className="bg-gray-900 dark:bg-black text-white px-5 py-4 flex items-center justify-between">
        <span className="font-semibold truncate">{business}</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-300">
          <Gift className="h-3.5 w-3.5" aria-hidden />
          {t("gbuyEyebrow", "Gavekort")}
        </span>
      </div>

      <div className="px-5 py-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {t("gbuyTitle", "Bestil et gavekort")}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t("gbuySubtitle", "Til {business}", { business })}
        </p>

        {/* Amount */}
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {t("gbuyAmountLabel", "Beløb")}
        </p>
        {presets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {presets.map((p) => {
              const active = customMinor == null && amountMinor === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setAmountMinor(p);
                    setCustomKr("");
                  }}
                  className={`rounded-xl border px-3.5 py-2 text-sm font-semibold tabular-nums transition ${
                    active
                      ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                      : "border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                  }`}
                >
                  {krFromMinor(p)}
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-2 relative">
          <input
            inputMode="decimal"
            value={customKr}
            onChange={(e) => setCustomKr(e.target.value)}
            placeholder={t("gbuyCustomAmount", "Andet beløb (kr.)")}
            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-gray-900 dark:focus:border-gray-300 focus:outline-none"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
          {t("gbuyRange", "Mellem {min} og {max}", {
            min: krFromMinor(minMinor),
            max: krFromMinor(maxMinor),
          })}
        </p>

        {/* Buyer */}
        <div className="mt-5 space-y-2">
          <Field
            label={t("gbuyYourEmail", "Din e-mail")}
            required
            type="email"
            value={buyerEmail}
            onChange={setBuyerEmail}
            placeholder="dig@eksempel.dk"
            hint={t("gbuyEmailHint", "Vi sender gavekortet hertil, når betalingen er bekræftet.")}
          />
          <Field
            label={t("gbuyYourName", "Dit navn")}
            value={buyerName}
            onChange={setBuyerName}
            placeholder={t("gbuyNamePlaceholder", "Valgfrit")}
          />
          <Field
            label={t("gbuyRecipient", "Til (modtager)")}
            value={recipient}
            onChange={setRecipient}
            placeholder={t("gbuyRecipientPlaceholder", "Valgfrit")}
          />
          <Field
            label={t("gbuyMessage", "Hilsen")}
            value={message}
            onChange={setMessage}
            placeholder={t("gbuyMessagePlaceholder", "Valgfrit")}
          />
        </div>

        {/* Owner's payment instructions, if set */}
        {instructions && (
          <div className="mt-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {t("gbuyHowToPay", "Sådan betaler du")}
            </p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 whitespace-pre-line">
              {instructions}
            </p>
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 dark:bg-gray-100 px-4 py-3 text-sm font-semibold text-white dark:text-gray-900 disabled:opacity-40 transition"
        >
          {busy ? (
            <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin dark:border-gray-900/30 dark:border-t-gray-900" />
          ) : (
            <>
              {t("gbuySubmit", "Send bestilling")}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </button>

        {/* Honest "how it works" — request, confirm, email. NEVER "paid now". */}
        <div className="mt-5 space-y-2.5">
          <Step icon={Mail} text={t("gbuyStep1", "Du sender din bestilling — uden at betale her.")} />
          <Step icon={ShieldCheck} text={t("gbuyStep2", "Forretningen bekræfter din betaling.")} />
          <Step icon={Gift} text={t("gbuyStep3", "Dit gavekort sendes til din e-mail.")} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", required, hint }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-gray-900 dark:focus:border-gray-300 focus:outline-none"
      />
      {hint && <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>}
    </label>
  );
}

function Step({ icon: Icon, text }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
      <span className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{text}</span>
    </div>
  );
}
