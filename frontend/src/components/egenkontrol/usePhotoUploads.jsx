/* eslint-disable react-refresh/only-export-components -- the hook and the one
   row line that shows its state belong together. */
/**
 * Photos on their way to the server, per reading (R1b).
 *
 * The reading is always saved FIRST; the photo follows with the reading's id
 * (owner: POST /egenkontrol/entries/{id}/photo, kitchen: the token wrapper).
 * Its state stays on the check's row until it is done, never in silence:
 *   sending        "Foto sendes…"
 *   failed         "Foto ikke sendt endnu · prøv igen" + "Prøv igen"
 *   window_passed  "Fotoet kan ikke længere tilføjes (mere end 24 timer …)"
 *   rejected       too large / unreadable — the server's reason
 *   lost           a reading restored after a reload had a photo (photos are
 *                  never stored on the device): "Fotoet blev ikke gemt. Tag
 *                  det igen, når målingen er gemt." + a camera button that
 *                  adds it to the now-saved reading.
 * 409 photo_exists means the server has one already → done.
 *
 * While a photo is sending or failed, a reload would drop it: beforeunload
 * asks the browser to warn (no window.confirm).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import CheckStatusPill from "../ui/CheckStatusPill";
import { PhotoPickButton } from "./PhotoCapture";
import { errorCode } from "./ekLogic";

export function usePhotoUploads(upload, { onSaved = null } = {}) {
  const [photos, setPhotos] = useState([]);
  const uploadRef = useRef(upload);
  const savedRef = useRef(onSaved);
  const busy = useRef(new Set());
  useEffect(() => {
    uploadRef.current = upload;
  }, [upload]);
  useEffect(() => {
    savedRef.current = onSaved;
  }, [onSaved]);

  const set = useCallback((entryId, fields) => {
    setPhotos((list) => {
      const at = list.findIndex((p) => p.entryId === entryId);
      if (at < 0) return [...list, { entryId, ...fields }];
      const next = [...list];
      next[at] = { ...next[at], ...fields };
      return next;
    });
  }, []);
  const drop = useCallback((entryId) => setPhotos((list) => list.filter((p) => p.entryId !== entryId)), []);

  const send = useCallback(
    async (entryId, checkId, file) => {
      if (!entryId || !file || busy.current.has(entryId)) return { ok: false };
      busy.current.add(entryId);
      set(entryId, { checkId, file, state: "sending", code: null });
      try {
        const photo = await uploadRef.current(entryId, file);
        drop(entryId);
        savedRef.current?.(photo, { entryId, checkId });
        return { ok: true, photo };
      } catch (err) {
        const status = err?.response?.status;
        const code = errorCode(err);
        if (code === "photo_exists") {
          drop(entryId);
          savedRef.current?.(null, { entryId, checkId });
          return { ok: true };
        }
        if (code === "photo_window_passed") set(entryId, { state: "window_passed", code, file: null });
        else if (status === 413 || status === 422) set(entryId, { state: "rejected", code, file: null });
        else set(entryId, { state: "failed", code });
        return { ok: false, code };
      } finally {
        busy.current.delete(entryId);
      }
    },
    [set, drop],
  );

  const retry = useCallback(
    (entryId) => {
      const p = photos.find((x) => x.entryId === entryId);
      if (p?.file) return send(entryId, p.checkId, p.file);
      return Promise.resolve({ ok: false });
    },
    [photos, send],
  );

  /** The reading came back saved, but its photo did not survive a reload. */
  const markLost = useCallback((entryId, checkId) => set(entryId, { checkId, state: "lost", file: null, code: null }), [set]);

  const pending = photos.some((p) => p.state === "sending" || p.state === "failed");
  useEffect(() => {
    if (!pending) return undefined;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [pending]);

  return { photos, send, retry, markLost, dismiss: drop };
}

const BTN =
  "min-h-14! px-4 inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 " +
  "text-[15px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800";

/** One photo's state on its check's row. */
export function PhotoStatusLine({ photo, onRetry, onDismiss, onRetake, t }) {
  if (!photo) return null;
  const close = (
    <button type="button" className={BTN + " min-w-14 justify-center px-3"} onClick={() => onDismiss?.(photo.entryId)} aria-label={t("close")}>
      <X className="w-4 h-4" aria-hidden="true" />
    </button>
  );
  if (photo.state === "sending") {
    return (
      <div role="status" data-testid="ek-photo-sending">
        <CheckStatusPill tone="muted">{t("ekPhotoSending")}</CheckStatusPill>
      </div>
    );
  }
  if (photo.state === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="ek-photo-failed">
        <CheckStatusPill tone="bad">{t("ekPhotoNotSent")}</CheckStatusPill>
        <button type="button" className={BTN} onClick={() => onRetry?.(photo.entryId)}>
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          {t("ekRetry")}
        </button>
      </div>
    );
  }
  if (photo.state === "lost") {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="ek-photo-lost">
        <CheckStatusPill tone="warn">{t("ekPhotoLost")}</CheckStatusPill>
        <PhotoPickButton onFile={(f) => onRetake?.(photo.entryId, photo.checkId, f)} label={t("ekPhotoTake")} testId="ek-photo-lost-take" />
        {close}
      </div>
    );
  }
  const key =
    photo.state === "window_passed" ? "ekPhotoWindowPassed" : photo.code === "photo_too_large" ? "ekPhotoTooLarge" : "ekPhotoUnreadable";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ek-photo-problem">
      <CheckStatusPill tone="warn">{t(key)}</CheckStatusPill>
      {close}
    </div>
  );
}
