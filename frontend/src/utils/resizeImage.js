/**
 * resizeImage — client-side image resize for iOS / Android camera uploads.
 *
 * Why this exists:
 *   • iPhone 15 Pro takes 48 MP photos. Stored as HEIC they're 5–8 MB;
 *     converted to JPEG by the browser they balloon to 15–25 MB.
 *   • Our backend caps image uploads at 12 MB (kasserapport, smart-
 *     inventory, daily-close /scan-report). A raw camera shot from a
 *     modern iPhone routinely exceeds that.
 *   • Even when under cap, sending a 12 MB photo over a 4G connection
 *     in a busy restaurant kitchen is slow + drains battery + costs the
 *     owner data. Sonnet vision doesn't need 48 MP — 2000 px on the
 *     long edge is comfortably enough to read receipt text accurately.
 *
 * Strategy:
 *   1. Skip resize for files already under softCap (default 1.5 MB) —
 *      too small to matter.
 *   2. Use canvas to scale the image to maxDimension (default 2000 px
 *      on the long edge) and re-encode as JPEG quality 0.85.
 *   3. If the resized result is somehow larger than the original
 *      (rare, e.g. a heavily-compressed source), keep the original.
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
  // HEIC handling: HEICs aren't decodable in <canvas> on most browsers
  // (Safari is the exception). Skip them — backend supports HEIC up to
  // 12 MB. iPhone HEICs are usually under that anyway (5–8 MB typical).
  if (file.type === "image/heic" || file.type === "image/heif") return file;
  if (file.size <= softCap) return file;

  try {
    const img = await loadImage(file);
    const { width, height } = img;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxDimension) {
      // Original is already small enough dimensionally; no need to resize.
      return file;
    }
    const scale = maxDimension / longEdge;
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

    // Preserve filename but switch extension to .jpg since we re-encoded.
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
