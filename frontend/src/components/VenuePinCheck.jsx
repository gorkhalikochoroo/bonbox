/**
 * VenuePinCheck — the owner's one-time check of the map pin the staff app
 * shows on the next-shift card (Vagtplan R2).
 *
 * The pin comes, in order, from a map link the owner pasted, the clock-in
 * geofence anchor, or the address looked up once (DAWA, then OpenStreetMap's
 * Nominatim) when this card first loads — never from a staff request. A
 * looked-up pin is a GUESS until the owner says "Ja, det passer"; staff see
 * the map only after that. A wrong pin is fixed by pasting a map link, which
 * counts as confirmed (the owner chose it). An address change drops the pin
 * server-side, so this card asks again.
 *
 * Lives beside the clock-in geofence settings on the Vagtplan page, and like
 * them collapses to one line once settled: a one-time setting on a page built
 * for planning the week.
 *
 * A delegated seat (manager, viewer, accountant) sees the card read-only: the
 * server neither looks the address up nor draws for one (`can_edit: false`),
 * and the buttons it could not use are not offered.
 */
import { useCallback, useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import api from "../services/api";
import useAsyncData from "../hooks/useAsyncData";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";
import { MAP_H, mapRequestWidth, mapQuery } from "../utils/venueMapImage";

function useOwnerMapImage(mapV) {
  // The URL carries the pin's version (`v`, from the server), so a moved pin
  // is a new URL: neither the browser's HTTP cache nor this hook can show the
  // old place's map for it. Keyed by the same version here.
  const [img, setImg] = useState({ key: null, url: null });
  // The box's width, measured as it mounts (before paint): the request is for
  // the width shown, so the credit corner is not cropped. No request until
  // the box is there (a settled one-line card asks for nothing).
  const [w, setW] = useState(null);
  const boxRef = useCallback((el) => {
    if (!el) return;
    const px = el.clientWidth || 0;
    setW(mapRequestWidth(px > 0 ? Math.min(px, 360) : 360));
  }, []);
  useEffect(() => {
    if (!mapV || !w) return undefined;
    let gone = false;
    let url = null;
    api.get(`/staff/venue-map?${mapQuery(w, 2, mapV)}`, { responseType: "blob" })
      .then((r) => {
        const blob = r?.data;
        if (gone || r?.status === 204 || !blob || !blob.size || !String(blob.type || "").startsWith("image/")) return;
        url = URL.createObjectURL(blob);
        setImg({ key: mapV, url });
      })
      .catch(() => { /* no image: the address line and the question still work */ });
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL?.(url);
    };
  }, [mapV, w]);
  return [img.key === mapV ? img.url : null, () => setImg({ key: null, url: null }), boxRef];
}

export default function VenuePinCheck({ className = "" }) {
  const { t } = useLanguage();
  const q = useAsyncData(() => api.get("/staff/venue-location"), []);
  const [state, setState] = useState(null);   // the latest server answer after a save
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const data = state || q.data;
  const pin = data?.pin || null;
  // Older servers sent no map_v: fall back to the pin itself as the key.
  const mapV = pin ? (data?.map_v || `${pin.lat},${pin.lng}`) : null;
  const [img, clearImg, boxRef] = useOwnerMapImage(mapV);
  // Read-only for a delegated seat (the server says so); the owner edits.
  const canEdit = data?.can_edit !== false;

  if (q.loading && !data) return null;
  if (q.failed && !data) return null;   // a one-time setting: never a red banner on the rota page

  const save = async (body) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await api.put("/staff/venue-location", body);
      setState(res.data);
      setFixing(false);
      setLink("");
    } catch (err) {
      const code = err?.response?.data?.detail?.error;
      setMsg(code === "map_link_unreadable"
        ? t("venuePinLinkBad", "We couldn't read that link. Copy it again from your map app's Share button.")
        : errText(err, t("venuePinSaveFailed", "Couldn't save. Try again.")));
    } finally {
      setBusy(false);
    }
  };

  // Settled: confirmed and nothing to do — one line, like the geofence card.
  if (pin?.confirmed && !open) {
    return (
      <div data-testid="venue-pin-summary" className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] ${className}`}>
        <MapPin size={14} className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden />
        <span className="text-gray-600 dark:text-gray-300">{t("venuePinTitle", "Map on your staff's shift card")}</span>
        {data?.address_line && (
          <span className="text-gray-400 dark:text-gray-500 truncate max-w-[16rem]">· {data.address_line}</span>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 rounded"
          >
            {t("change", "Change")}
          </button>
        )}
      </div>
    );
  }

  const linkForm = (
    <form
      className="w-full flex flex-wrap items-center gap-2"
      onSubmit={(e) => { e.preventDefault(); if (link.trim()) save({ map_link: link.trim() }); }}
    >
      <input
        type="url"
        inputMode="url"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder={t("venuePinLinkPlaceholder", "Paste a Google Maps or Apple Maps link")}
        aria-label={t("venuePinLinkPlaceholder", "Paste a Google Maps or Apple Maps link")}
        className="flex-1 min-w-[220px] min-h-[40px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      />
      <button
        type="submit"
        disabled={busy || !link.trim()}
        className="inline-flex items-center justify-center min-h-[40px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        {t("venuePinUseLink", "Use this pin")}
      </button>
    </form>
  );

  return (
    <div data-testid="venue-pin-check" className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 flex flex-col gap-2.5 ${className}`}>
      <div className="flex items-start gap-2">
        <MapPin size={16} className="mt-0.5 text-gray-400 dark:text-gray-500 shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("venuePinTitle", "Map on your staff's shift card")}</div>
          <p className="text-[12px] text-gray-500 dark:text-gray-400 leading-snug">
            {t("venuePinHelp", "Staff see a small map of your place and a Directions button. BonBox draws it from OpenStreetMap — no map company sees your staff.")}
          </p>
        </div>
      </div>

      {pin && (
        // The measuring box is there before the image, so the request is for
        // the width shown; the image is right-anchored like the staff card's,
        // so its "© OpenStreetMap" corner is never cropped.
        <div ref={boxRef} className="w-full max-w-[360px]" style={{ height: img ? MAP_H : 0 }}>
          {img && (
            <img
              src={img}
              alt={t("venuePinMapAlt", "Map with the pin your staff will see")}
              onError={() => clearImg()}
              className="block w-full rounded-lg object-cover border border-gray-200 dark:border-gray-700"
              style={{ height: MAP_H, objectPosition: "right center" }}
            />
          )}
        </div>
      )}
      {data?.address_line && (
        <div className="text-[12px] text-gray-600 dark:text-gray-300">{data.address_line}</div>
      )}

      {!canEdit ? (
        <p className="text-[12px] text-gray-600 dark:text-gray-300">
          {pin?.confirmed
            ? (data?.staff_see_map
              ? t("venuePinConfirmed", "Your staff see this map.")
              : t("venuePinConfirmedNoMap", "Confirmed. The map could not be drawn right now — staff see the address and Directions until it can."))
            : t("venuePinOwnerOnly", "The owner checks the map pin here. Staff see the map once it is confirmed.")}
        </p>
      ) : !pin ? (
        <>
          <p className="text-[12px] text-gray-600 dark:text-gray-300">
            {data?.address_line
              ? t("venuePinNotFound", "We couldn't find that address on the map. Paste a map link instead.")
              : t("venuePinNoAddress", "Add your address under Profile, or paste a map link.")}
          </p>
          {linkForm}
        </>
      ) : !pin.confirmed ? (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{t("venuePinCheck", "Is the pin right?")}</div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => save({ confirm: true })}
              className="inline-flex items-center justify-center min-h-[40px] px-4 rounded-lg text-sm font-semibold text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-900"
              style={{ background: "#093A26" }}
            >
              {t("venuePinYes", "Yes, that's us")}
            </button>
            <button
              type="button"
              onClick={() => setFixing((v) => !v)}
              aria-expanded={fixing}
              className="text-[13px] font-medium text-gray-600 dark:text-gray-300 underline underline-offset-2"
            >
              {t("venuePinFix", "Wrong pin? Paste a map link")}
            </button>
          </div>
          {fixing && linkForm}
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {t("venuePinUntilConfirmed", "Your staff see the map once you confirm.")}
          </p>
        </>
      ) : (
        <>
          <div className="text-[12px] text-gray-600 dark:text-gray-300">
            {data?.staff_see_map
              ? t("venuePinConfirmed", "Your staff see this map.")
              : t("venuePinConfirmedNoMap", "Confirmed. The map could not be drawn right now — staff see the address and Directions until it can.")}
          </div>
          <button
            type="button"
            onClick={() => setFixing((v) => !v)}
            aria-expanded={fixing}
            className="self-start text-[13px] font-medium text-gray-600 dark:text-gray-300 underline underline-offset-2"
          >
            {t("venuePinFix", "Wrong pin? Paste a map link")}
          </button>
          {fixing && linkForm}
        </>
      )}

      {msg && <div role="alert" className="text-[12px] text-red-600 dark:text-red-400">{msg}</div>}
      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        {t("portalMapCredit", "Map: OpenFreeMap · OpenMapTiles · © OpenStreetMap contributors")}
      </p>
    </div>
  );
}
