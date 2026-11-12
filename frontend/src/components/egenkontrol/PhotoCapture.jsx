/**
 * "Tag foto" — the optional photo on a deviation and on goods receiving
 * (R1b). Lives inside RecordPanel, ALWAYS below the keypad (after the
 * deviation questions) and above "Hvem målte?", so nothing above the keys
 * moves when it appears.
 *
 * The camera: <input type="file" accept="image/jpeg,image/png"
 * capture="environment"> — the iPad / phone opens the back camera and hands
 * over a JPEG (the same capture pattern as the Z-report and receipt photos).
 * A large shot is scaled to 1600 px on the device first (utils/resizeImage);
 * the server re-encodes it again and strips EXIF / GPS.
 *
 * Photograph the thermometer or the food — not people (the hint is on every
 * photo control). The photo is sent AFTER the reading is saved, with the
 * reading's id; here it is only held on the device. "Fjern foto" just drops
 * the local copy (no confirm: nothing has been sent).
 */
import { useEffect, useMemo, useRef } from "react";
import { Camera, RotateCcw, X } from "lucide-react";
import { resizeImageIfLarge } from "../../utils/resizeImage";
import { PHOTO_MAX_DIMENSION } from "./ekLogic";

const BTN =
  "min-h-14! px-4 inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 " +
  "bg-white dark:bg-gray-900 text-[15px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

/** A local object URL for a File, revoked when it changes (jsdom has none). */
function useObjectUrl(file) {
  const url = useMemo(() => {
    if (!file || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    try {
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }, [file]);
  useEffect(
    () => () => {
      if (url) {
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
      }
    },
    [url],
  );
  return url;
}

/**
 * The camera button on its own: a hidden file input behind a 56 px button.
 * onFile gets the (resized) File. Used by the panel and by a row whose photo
 * was lost in a reload ("Tag det igen").
 */
export function PhotoPickButton({ onFile, label, icon = "camera", id, className = "", testId }) {
  const inputRef = useRef(null);
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    let out = f;
    try {
      out = (await resizeImageIfLarge(f, { maxDimension: PHOTO_MAX_DIMENSION })) || f;
    } catch {
      out = f;
    }
    onFile?.(out);
  };
  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={pick}
        data-testid={testId ? `${testId}-input` : undefined}
      />
      <button type="button" className={BTN + " " + className} onClick={() => inputRef.current?.click()} data-testid={testId}>
        {icon === "retake" ? <RotateCcw className="w-4 h-4" aria-hidden="true" /> : <Camera className="w-5 h-5" aria-hidden="true" />}
        {label}
      </button>
    </>
  );
}

export default function PhotoCapture({ file = null, onChange, t, idPrefix = "ek" }) {
  const url = useObjectUrl(file);
  return (
    <section className="min-w-0" data-ek-step="photo" data-testid="ek-photo-step">
      <p className="text-[15px] font-semibold mb-1 text-gray-900 dark:text-gray-100">{t("ekPhotoOptional")}</p>
      <p className="text-[14px] text-gray-600 dark:text-gray-400 mb-2" data-testid="ek-photo-hint">{t("ekPhotoHint")}</p>
      {file ? (
        <div className="flex flex-wrap items-center gap-3">
          {url ? (
            <img src={url} alt={t("ekPhotoAttached")} className="w-14 h-14 rounded-lg object-cover border border-gray-200 dark:border-gray-700" />
          ) : (
            <span className="text-[15px] text-gray-800 dark:text-gray-200">{t("ekPhotoAttached")}</span>
          )}
          <PhotoPickButton onFile={onChange} label={t("ekPhotoRetake")} icon="retake" id={`${idPrefix}-photo-retake`} testId="ek-photo-retake" />
          <button type="button" className={BTN} onClick={() => onChange?.(null)} data-testid="ek-photo-remove-local">
            <X className="w-4 h-4" aria-hidden="true" />
            {t("ekPhotoRemoveLocal")}
          </button>
        </div>
      ) : (
        <PhotoPickButton onFile={onChange} label={t("ekPhotoTake")} id={`${idPrefix}-photo`} testId="ek-photo-take" />
      )}
    </section>
  );
}
