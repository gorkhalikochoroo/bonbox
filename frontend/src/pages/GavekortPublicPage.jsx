// GavekortPublicPage — the recipient's live gavekort, at /g/:token.
//
// No auth: the signed token in the URL IS the credential (the same QR the
// owner handed over). The page fetches the LIVE saldo on every load — so it
// self-updates as the card is spent (the #1 thing a paper gavekort gets
// wrong). PII-minimal by construction: the API only returns venue + beløb +
// saldo + status; never the recipient's name, the owner's note, or the hash.
//
// Design: gray-900 text on a calm light surface; EMERALD is the only color,
// reserved for the live saldo on an active card (status-colors-only). The QR
// is the headline — it's what gets scanned at the counter. Mobile-first +
// safe-area aware (it opens on a phone).
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Gift, Check, QrCode, Clock, Ban } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";

function krFromMinor(minor) {
  if (minor == null || Number.isNaN(minor)) return "—";
  return formatKr(minor / 100);
}

export default function GavekortPublicPage() {
  const { token } = useParams();
  const { t } = useLanguage();
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/public/gavekort/${encodeURIComponent(token)}`);
        if (alive) setState({ loading: false, data: res.data, error: null });
      } catch (e) {
        // 410 = voided/expired-gone; 404 = not found; else generic.
        const status = e?.response?.status;
        if (alive) setState({ loading: false, data: null, error: status || "network" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const { loading, data, error } = state;

  return (
    <div
      className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-5"
      style={{
        paddingTop: "max(1.5rem, env(safe-area-inset-top))",
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="w-full max-w-sm">
        {loading ? (
          <Centered>
            <div className="h-10 w-10 mx-auto rounded-full border-2 border-gray-200 border-t-gray-900 animate-spin" />
          </Centered>
        ) : error ? (
          <ErrorCard t={t} status={error} />
        ) : (
          <CardView t={t} data={data} token={token} />
        )}
        <p className="mt-6 text-center text-[11px] text-gray-400 dark:text-gray-600">
          {t("gpkPoweredBy", "Gavekort via BonBox")}
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

function ErrorCard({ t, status }) {
  const gone = status === 410;
  const Icon = gone ? Ban : QrCode;
  return (
    <Centered>
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
        <Icon className="h-6 w-6" aria-hidden />
      </div>
      <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {gone
          ? t("gpkGone", "Dette gavekort er ikke længere gyldigt.")
          : t("gpkNotFound", "Gavekortet blev ikke fundet.")}
      </p>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
        {t("gpkCheckLink", "Tjek linket, eller spørg der hvor du fik gavekortet.")}
      </p>
    </Centered>
  );
}

const STATUS_META = {
  active: { key: "gpkStatusActive", label: "Gyldigt", Icon: Check, tone: "ok" },
  expired: { key: "gpkStatusExpired", label: "Udløbet", Icon: Clock, tone: "muted" },
  redeemed: { key: "gpkStatusRedeemed", label: "Indløst", Icon: Check, tone: "muted" },
};

function CardView({ t, data, token }) {
  const status = data?.status || "active";
  const meta = STATUS_META[status] || STATUS_META.active;
  const isActive = status === "active";
  const balance = data?.balance_minor ?? 0;
  const face = data?.face_value_minor ?? 0;
  const partial = isActive && balance !== face;
  const expiryLabel = data?.expires_at
    ? new Date(data.expires_at).toLocaleDateString("da-DK", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      {/* Venue header — the one place the brand sits (this is the card the
          customer holds, where it earns its keep). */}
      <div className="bg-gray-900 dark:bg-black text-white px-5 py-4 flex items-center justify-between">
        <span className="font-semibold truncate">{data?.business_name || "BonBox"}</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-300">
          <Gift className="h-3.5 w-3.5" aria-hidden />
          {t("gpkEyebrow", "Gavekort")}
        </span>
      </div>

      <div className="px-5 py-6 text-center">
        {/* The live saldo — emerald only when there's something to spend. */}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {partial ? t("gpkBalanceLabel", "Saldo") : t("gpkValueLabel", "Værdi")}
        </p>
        <p
          className={`mt-1 text-[40px] font-bold tabular-nums leading-none ${
            isActive
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-gray-400 dark:text-gray-600"
          }`}
        >
          {krFromMinor(isActive ? balance : 0)}
        </p>
        {partial && (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {t("gpkOfFace", "af {face}", { face: krFromMinor(face) })}
          </p>
        )}

        {/* Status pill — green=gyldigt, gray=udløbet/indløst. */}
        <div className="mt-3 flex justify-center">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              meta.tone === "ok"
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            <meta.Icon className="h-3.5 w-3.5" aria-hidden />
            {t(meta.key, meta.label)}
          </span>
        </div>

        {/* QR — the headline. Scanned at the counter. White card so it reads
            in any theme. Dimmed when the card can't be redeemed. */}
        <div className="mt-6 inline-flex flex-col items-center">
          <div
            className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white p-4 ${
              isActive ? "" : "opacity-40"
            }`}
          >
            <QRCodeSVG value={token} size={188} level="M" includeMargin={false} />
          </div>
        </div>

        {data?.code_last4 && (
          <p className="mt-3 font-mono text-sm tracking-[0.2em] text-gray-400 dark:text-gray-500">
            ····{data.code_last4}
          </p>
        )}

        <p className="mt-5 text-sm text-gray-600 dark:text-gray-300">
          {t("gpkRedeemAt", "Indløses hos {business}", {
            business: data?.business_name || "BonBox",
          })}
        </p>
        {expiryLabel && isActive && (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {t("gpkValidUntil", "Gælder til {date}", { date: expiryLabel })}
          </p>
        )}
      </div>

      {/* Foot — how to use it. */}
      <div className="border-t border-gray-100 dark:border-gray-800 px-5 py-3 text-center">
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          {t("gpkShowAtCounter", "Vis koden i butikken for at betale.")}
        </p>
      </div>
    </div>
  );
}
