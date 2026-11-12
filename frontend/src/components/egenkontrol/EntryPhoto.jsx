/**
 * A reading's photo in the Kontrolmappe (R1b): a 56 px thumbnail that opens
 * full screen. The bytes come through the tenant-checked proxy only (owner:
 * GET /egenkontrol/photos/{id}; kitchen: the token wrapper) as a blob shown
 * from an object URL — never a public or signed URL (the chatPhotoKit
 * pattern). The caller passes load(id) → Blob, so the same component works
 * for the owner session and the kitchen token.
 *
 * The caller may pass its own `label` — the Kontrolmappe says "Foto vedlagt
 * (tilføjet {dato} kl. {tid})" for a photo added later, as the PDF does.
 *
 * A photo the owner removed shows "Foto fjernet af ejeren {dato}" (from the
 * row, or from a 410 if it was removed meanwhile). The overlay closes on a
 * tap, Escape and Android BACK (data-back-close).
 */
import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Trash2 } from "lucide-react";

/** The removal date as the venue's calendar date ("12.11.2026" style via Intl). */
function removedDate(photo, lang) {
  if (photo?.removed_local_date) return photo.removed_local_date;
  const at = Date.parse(photo?.removed_at || "");
  if (!Number.isFinite(at)) return "";
  try {
    return new Intl.DateTimeFormat(lang === "da" ? "da-DK" : "en-GB", {
      day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Copenhagen",
    }).format(new Date(at));
  } catch {
    return "";
  }
}

export default function EntryPhoto({ photo, load, t, lang = "da", canRemove = false, onRemove = null, label = null }) {
  const [src, setSrc] = useState(null);
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const holder = useRef(null);
  const removed = !!photo?.removed_at || gone;
  const id = photo?.id;

  useEffect(() => {
    if (!id || removed || typeof load !== "function") return undefined;
    let cancelled = false;
    let objUrl = null;
    const fetchIt = () => {
      Promise.resolve()
        .then(() => load(id))
        .then((blob) => {
          if (cancelled || !blob) return;
          if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
            objUrl = URL.createObjectURL(blob);
            setSrc(objUrl);
          } else {
            setSrc("");
          }
        })
        .catch((err) => {
          if (cancelled) return;
          if (err?.response?.status === 410) setGone(true);
          else setFailed(true);
        });
    };
    // Lazy: only once the thumbnail is near the screen (when the browser can tell).
    let io = null;
    if (typeof IntersectionObserver === "function" && holder.current) {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          fetchIt();
        }
      }, { rootMargin: "200px" });
      io.observe(holder.current);
    } else {
      fetchIt();
    }
    return () => {
      cancelled = true;
      if (io) io.disconnect();
      if (objUrl) {
        try { URL.revokeObjectURL(objUrl); } catch { /* noop */ }
      }
    };
  }, [id, removed, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!photo) return null;
  if (removed) {
    return (
      <p className="text-[14px] text-gray-600 dark:text-gray-400" data-testid="ek-photo-removed">
        {t("ekPhotoRemoved", { date: removedDate(photo, lang) })}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" ref={holder} data-testid="ek-entry-photo">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-14 h-14 shrink-0 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        aria-label={t("ekPhotoAttached")}
        data-failed={failed ? "true" : undefined}
      >
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-5 h-5 text-gray-400" aria-hidden="true" />
        )}
      </button>
      <span className="text-[14px] text-gray-700 dark:text-gray-300" data-testid="ek-photo-label">{label || t("ekPhotoAttached")}</span>
      {canRemove && onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(photo)}
          className="h-10 px-3 inline-flex items-center gap-1.5 rounded-lg text-[14px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
          data-testid="ek-photo-remove"
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" />
          {t("ekPhotoRemove")}
        </button>
      ) : null}
      {open ? (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t("ekPhotoAttached")}
          data-back-close=""
          data-testid="ek-photo-overlay"
        >
          {src ? <img src={src} alt="" className="max-w-full max-h-full rounded-lg" /> : null}
        </div>
      ) : null}
    </div>
  );
}
