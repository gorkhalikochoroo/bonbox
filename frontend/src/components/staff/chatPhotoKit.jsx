/* eslint-disable react-refresh/only-export-components -- shared kit: this file
   intentionally exports both components and the usePhotoPicker hook/constant. */
/**
 * Shared chat-photo helpers for the staff portal (portalApi) and the owner
 * drawer (api).
 *
 * Photos are served by a tenant-re-checked PROXY endpoint, never a public/
 * signed URL — so we fetch them through the axios client (auth header rides
 * along) as a blob and render an object URL. This also dodges the third-party-
 * cookie problem on the cross-origin api host.
 */
import { useState, useEffect } from "react";
import { X, ImagePlus } from "lucide-react";

const MAX_PHOTOS = 3;

/** Lazily blob-loads a proxy-served photo and renders it; tap to view full. */
export function ChatPhoto({ client, url, alt = "" }) {
  const [src, setSrc] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objUrl;
    client
      .get(url, { responseType: "blob" })
      .then((res) => {
        if (cancelled) return;
        objUrl = URL.createObjectURL(res.data);
        setSrc(objUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [url, client]);

  if (!src) {
    return <div className="w-28 h-28 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />;
  }
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className="w-28 h-28 object-cover rounded-lg cursor-pointer border border-black/5"
      />
      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <img src={src} alt={alt} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </>
  );
}

/** Render either local previews (optimistic) or proxy-served photos. */
export function PhotoGrid({ client, photos, localPreviews }) {
  if (localPreviews?.length) {
    return (
      <div className="flex flex-wrap gap-1.5 mb-1">
        {localPreviews.map((p, i) => (
          <img
            key={i}
            src={p}
            alt=""
            className="w-28 h-28 object-cover rounded-lg border border-black/5"
          />
        ))}
      </div>
    );
  }
  if (!photos?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-1">
      {photos.map((p) => (
        <ChatPhoto key={p.id} client={client} url={p.url} />
      ))}
    </div>
  );
}

/** Stateful image picker (max 3). Owns object-URL lifecycle for previews. */
export function usePhotoPicker(max = MAX_PHOTOS) {
  const [files, setFiles] = useState([]); // [{ file, preview }]

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((f) =>
      f.type?.startsWith("image/"),
    );
    setFiles((prev) => {
      const room = Math.max(0, max - prev.length);
      const added = incoming.slice(0, room).map((f) => ({
        file: f,
        preview: URL.createObjectURL(f),
      }));
      return [...prev, ...added];
    });
  };

  const removeAt = (i) =>
    setFiles((prev) => {
      const copy = [...prev];
      const [removed] = copy.splice(i, 1);
      if (removed) URL.revokeObjectURL(removed.preview);
      return copy;
    });

  const clear = () =>
    setFiles((prev) => {
      prev.forEach((x) => URL.revokeObjectURL(x.preview));
      return [];
    });

  return { files, addFiles, removeAt, clear, atMax: files.length >= max, max };
}

/** Thumbnail strip shown above the composer while photos are staged. */
export function PendingPhotos({ picker }) {
  if (!picker.files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {picker.files.map((f, i) => (
        <div key={i} className="relative">
          <img
            src={f.preview}
            alt=""
            className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-600"
          />
          <button
            type="button"
            onClick={() => picker.removeAt(i)}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-900 text-white flex items-center justify-center"
            aria-label="Remove"
          >
            <X className="w-3 h-3" strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The attach (image) button + its hidden file input. */
export function AttachButton({ picker, label = "Add photo" }) {
  return (
    <label
      className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center cursor-pointer transition ${
        picker.atMax
          ? "text-gray-300 cursor-not-allowed"
          : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
      title={label}
      aria-label={label}
    >
      <ImagePlus className="w-5 h-5" strokeWidth={2} aria-hidden />
      <input
        type="file"
        accept="image/png,image/jpeg"
        multiple
        disabled={picker.atMax}
        className="hidden"
        onChange={(e) => {
          picker.addFiles(e.target.files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </label>
  );
}

export { MAX_PHOTOS };
