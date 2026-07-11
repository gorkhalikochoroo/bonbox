// GavekortPrintModal — pick a template, preview the owner-branded gavekort,
// download the print-ready PDF.
//
// The modal renders a LIVE <GavekortCard> from the card the owner tapped plus
// the business profile the app already knows (name from AuthContext, logo +
// accent from /business/brand, address + CVR from /business). The same card
// object the ledger drawer holds carries short_code + note; when opened from a
// leaner surface that lacks them, we fetch /gavekort/{id} to fill the gaps so
// the preview never shows a placeholder where the PDF will show the real code.
//
// "Download PDF" hits the owner-authenticated, tenant-scoped endpoint
//   GET /api/gavekort/{id}/pdf?template=minimal|foil
// and saves the returned application/pdf blob as gavekort-<short_code>.pdf.
//
// Modal chrome mirrors the app's other dialogs: fixed overlay, click-outside +
// Escape to close, white card with the system radius, one primary CTA.
import { useEffect, useMemo, useState } from "react";
import { X, Download, Printer } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { formatKr } from "../utils/currency";
import { errText } from "../utils/errText";
import Button from "./ui/Button";
import GavekortCard from "./GavekortCard";

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// First letters of the business name → a 1–2 char monogram for the card's
// fallback mark (used only when there's no uploaded logo).
function computeMonogram(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "•";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// accent_color is stored as a palette NAME (e.g. "emerald") plus a name→hex
// map, but some rows hold a raw hex. Resolve to a usable #RRGGBB, or null so
// the card falls back to its own default green.
function resolveAccent(brand) {
  const raw = brand?.accent_color;
  if (!raw) return null;
  if (HEX_RE.test(raw)) return raw;
  const hex = brand?.accent_palette?.[raw];
  return hex && HEX_RE.test(hex) ? hex : null;
}

// "Vestergade 12, 8000 Aarhus" from the business profile, skipping blanks.
function composeAddress(b) {
  if (!b) return "";
  const line2 = [b.zipcode, b.city].filter(Boolean).join(" ");
  return [b.address, line2].filter(Boolean).join(", ");
}

// Danish date, e.g. "12. jul 2028" — built from the SAME month abbreviations
// the backend _fmt_date_dk uses (no trailing period), so the preview's
// "Gyldig til …" and the printed PDF read identically.
const _DK_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function formatDkDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getDate()}. ${_DK_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return "";
  }
}

const TEMPLATES = ["minimal", "foil"];

export default function GavekortPrintModal({ open, card, onClose }) {
  const { t } = useLanguage();
  const { user } = useAuth();

  const [template, setTemplate] = useState("minimal");
  const [brand, setBrand] = useState(null);
  const [business, setBusiness] = useState(null);
  const [detail, setDetail] = useState(null); // short_code + note when fetched
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  const cardId = card?.id;

  // Fetch business brand + profile once per open, and top up short_code/note
  // from the card detail when the passed-in row didn't carry them.
  useEffect(() => {
    if (!open || !cardId) return;
    let alive = true;
    setError("");
    setDetail(null);

    api.get("/business/brand").then((r) => alive && setBrand(r.data)).catch(() => {});
    api.get("/business").then((r) => alive && setBusiness(r.data)).catch(() => {});

    // Top up from the detail endpoint whenever the passed-in row is missing the
    // short_code OR the signed redeem_url — the QR needs the redeem_url, and only
    // GET /gavekort/{id} carries it (the list rows don't), so without this the
    // preview would silently drop the QR even when the card can be scanned.
    if (!card?.short_code || !card?.redeem_url) {
      api
        .get(`/gavekort/${cardId}`)
        .then((r) => alive && setDetail(r.data?.card || null))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [open, cardId, card?.short_code, card?.redeem_url]);

  // Escape closes; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Reset to the light template each fresh open (calm default).
  useEffect(() => {
    if (open) setTemplate("minimal");
  }, [open]);

  const shortCode = card?.short_code || detail?.short_code || "";
  const note = card?.note ?? detail?.note ?? "";

  const cardProps = useMemo(() => {
    const businessName = user?.business_name?.trim() || "";
    const displayCode =
      shortCode || (card?.code_last4 ? `···· ${card.code_last4}` : "");
    return {
      businessName,
      address: composeAddress(business),
      monogram: computeMonogram(businessName),
      logoUrl: brand?.logo_url || null,
      // Whole kr. when integral (gift cards nearly always are), else 2 decimals
      // — MATCHES the backend PDF formatter so the preview reads like the print.
      amountLabel: formatKr((card?.face_value_minor ?? 0) / 100, {
        decimals: (card?.face_value_minor ?? 0) % 100 === 0 ? 0 : 2,
      }),
      recipient: card?.recipient_name || detail?.recipient_name || "",
      note,
      code: displayCode,
      validUntilLabel: formatDkDate(card?.expires_at),
      cvr: business?.org_number || business?.cvr || "",
      accentColor: resolveAccent(brand),
      // The signed, scannable redeem URL — the SAME token the PDF's QR encodes.
      // Empty → the card omits the QR (matches the backend, which drops it when
      // the signing key is unset). Never fall back to the raw short_code, which
      // is NOT a resolvable URL and would render a dead QR.
      qrValue: card?.redeem_url || detail?.redeem_url || "",
    };
  }, [user, business, brand, card, detail, shortCode, note]);

  if (!open || !card) return null;

  const download = async () => {
    setDownloading(true);
    setError("");
    try {
      const res = await api.get(`/gavekort/${cardId}/pdf`, {
        params: { template },
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Prefer the server's Content-Disposition filename; fall back to code.
      const cd = res.headers?.["content-disposition"] || "";
      const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      a.download = match
        ? decodeURIComponent(match[1])
        : `gavekort-${shortCode || card.code_last4 || "kort"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errText(e, t("gkPdfFailed", "Kunne ikke generere PDF. Prøv igen.")));
    } finally {
      setDownloading(false);
    }
  };

  const templateLabel = (id) =>
    id === "foil"
      ? t("gkTplFoil", "Charcoal Foil")
      : t("gkTplMinimal", "Nordic Minimal");

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 motion-safe:animate-backdropFade"
      role="dialog"
      aria-modal="true"
      aria-label={t("gkPrintTitle", "Print gavekort")}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col max-h-[92vh] overflow-hidden motion-safe:animate-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-3 p-5 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2 min-w-0">
            <Printer className="w-5 h-5 text-gray-700 dark:text-gray-200 shrink-0" aria-hidden />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
              {t("gkPrintTitle", "Print gavekort")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("gkClose", "Luk")}
            className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* Template toggle — segmented, one accent-free control. */}
          <div
            className="inline-flex w-full rounded-xl bg-gray-100 dark:bg-gray-800 p-1"
            role="tablist"
            aria-label={t("gkPrintTitle", "Print gavekort")}
          >
            {TEMPLATES.map((id) => {
              const active = template === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTemplate(id)}
                  className={
                    "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors " +
                    (active
                      ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200")
                  }
                >
                  {templateLabel(id)}
                </button>
              );
            })}
          </div>

          {/* Live preview */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
              {t("gkPreview", "Forhåndsvisning")}
            </p>
            <div className="rounded-xl bg-gray-50 dark:bg-gray-950/40 p-4">
              <GavekortCard template={template} {...cardProps} />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        {/* Footer — one primary action. */}
        <div className="shrink-0 flex items-center justify-end gap-2 p-4 border-t border-gray-100 dark:border-gray-800">
          <Button variant="ghost" onClick={onClose}>
            {t("gkClose", "Luk")}
          </Button>
          <Button
            variant="primary"
            busy={downloading}
            onClick={download}
            iconLeft={!downloading ? <Download className="w-4 h-4" aria-hidden /> : null}
          >
            {t("gkDownloadPdf", "Download PDF")}
          </Button>
        </div>
      </div>
    </div>
  );
}
