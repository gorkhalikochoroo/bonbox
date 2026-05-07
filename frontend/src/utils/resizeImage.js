/**
 * resizeImage — client-side image resize for iOS / Android camera uploads.
 *
 * Why this exists:
 *   • iPhone 15 Pro takes 48 MP photos. Stored as HEIC they're 1–5 MB;
 *     converted to JPEG by the browser they can balloon to 15–25 MB.
 *   • Our backend caps image uploads at 12 MB (kasserapport, smart-
 *     inventory, daily-close /scan-report). A raw camera shot from a
 *     modern iPhone routinely exceeds that when JPEG-encoded.
 *   • Even when under cap, sending a 12 MB photo over a 4G connection
 *     in a busy restaurant kitchen is slow + drains battery + costs the
 *     owner data. Sonnet vision doesn't need 48 MP — 2000 px on the
 *     long edge is comfortably enough to read receipt text accurately.
 *
 * iOS context — HEIC is the iPhone default since iOS 11:
 *   • Settings → Camera → Formats → 'High Efficiency' (HEIC) is default,
 *     'Most Compatible' is the JPEG opt-in. Most owners never change it.
 *   • iOS Safari: when uploading via <input type="file">, behaviour
 *     varies by iOS version — sometimes converts HEIC → JPEG silently,
 *     sometimes uploads the HEIC as-is. We can't predict, so we handle
 *     both.
 *   • Safari CAN decode HEIC into <canvas> (it's the exception among
 *     browsers). So we ATTEMPT canvas resize even for HEIC files; the
 *     try/catch falls back to the original on failure.
 *
 * Strategy:
 *   1. Skip resize for files already under softCap (default 1.5 MB) —
 *      too small to matter. This covers most iPhone HEICs which are
 *      typically 1–3 MB.
 *   2. Try canvas resize regardless of MIME type (JPEG, PNG, WebP, HEIC).
 *      Safari handles HEIC; other browsers fail and we fall back.
 *   3. If the resized result is somehow larger than the original
 *      (rare, e.g. heavily-compressed HEIC), keep the original.
 *
 * Returns the original File if anything goes wrong — fail-open is
 * better than blocking the upload.
 */
export async function resizeImageIfLarge(
  file,
  { maxDimension = 2000, softCap = 1.5 * 1024 * 1024, quality = 0.85 } = {},
) {
  if (!file || !(file instanceof Blob)) return file;
  if (!file.type || !file.type.startsWith("image/")) return file;
  if (file.size <= softCap) return file;

  try {
    const img = await loadImage(file);
    const { width, height } = img;
    if (!width || !height) return file;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxDimension) {
      // Already small enough dimensionally; only re-encode to compress.
      // This covers e.g. a 8 MB JPEG that's only 2000×1500 pixels.
    }
    const scale = Math.min(1, maxDimension / longEdge);
    const targetW = Math.round(width * scale);
    const targetH = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // Draw with smoothing so OCR text remains crisp.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) return file;

    // Defensive: if resize made it bigger somehow, keep original.
    if (blob.size >= file.size) return file;

    // Preserve filename stem but switch extension to .jpg — we
    // re-encoded as JPEG regardless of input format (HEIC → JPEG too).
    const baseName = (file.name || "photo")
      .replace(/\.[^.]+$/, "")
      .slice(0, 200);
    const resized = new File([blob], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    return resized;
  } catch (e) {
    // Anything goes wrong → fall back to original. Never block upload.
    // Common case: non-Safari browser tries to decode HEIC and the
    // <img> load fails. Backend handles HEIC up to 12 MB anyway, and
    // iPhone HEICs are typically 1–5 MB, so the original uploads fine.
    console.warn("resizeImageIfLarge failed; uploading original", e);
    return file;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}
