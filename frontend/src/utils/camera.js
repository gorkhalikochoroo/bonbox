import { platform } from "./platform";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

/**
 * Capture a photo — native camera on iOS/Android, file input on web.
 * @param {"camera"|"gallery"} source
 * @returns {Promise<string|null>} base64 image string, or null if cancelled
 */
export const capturePhoto = async (source = "camera") => {
  if (platform.isNative) {
    try {
      const image = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
        width: 1200,
        correctOrientation: true,
      });
      return image.base64String;
    } catch (error) {
      if (error.message?.includes("cancelled") || error.message?.includes("User")) return null;
      throw error;
    }
  }

  // Web fallback — file input (already works in BonBox)
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (source === "camera") input.capture = "environment";
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(file);
    };
    input.click();
  });
};

/**
 * Capture multiple photos (e.g. multi-page Z-reports).
 * @param {number} maxPhotos
 * @returns {Promise<string[]>} array of base64 strings
 */
export const captureMultiplePhotos = async (maxPhotos = 3) => {
  const photos = [];
  for (let i = 0; i < maxPhotos; i++) {
    const photo = await capturePhoto("camera");
    if (!photo) break;
    photos.push(photo);
    if (i < maxPhotos - 1) {
      const addMore = window.confirm(`Photo ${i + 1} captured. Add another page?`);
      if (!addMore) break;
    }
  }
  return photos;
};

/**
 * Chat photos in the Android staff app: "Take a photo" OR "Choose photos".
 *
 * The chat's <input type="file"> cannot take a photo in the Android WebView:
 * Capacitor's file chooser (BridgeWebChromeClient) opens the camera only for
 * an input with `capture` that accepts "image/*", and then ONLY the camera —
 * the chat's input has no `capture` and accepts png/jpeg. So the app asks
 * which one (the chat's own small sheet) and then calls the camera plugin:
 *
 *   • takePhotoFile — the camera (asks for the CAMERA permission the app
 *     already declares);
 *   • choosePhotoFiles(room) — Android's photo picker, several at once, never
 *     more than the chat still has room for (no permission needed). The
 *     plugin's own "choose or take" prompt picks only ONE photo, which took
 *     the chat's pick-up-to-3 away (Android 14 walk, 11 Nov 2026).
 *
 * Both give Files for the SAME picker and upload as a chosen file. The long
 * edge ≤ 1600 px matches what the server keeps (chat_image MAX_OUTPUT_DIM);
 * the plugin writes JPEG, which the server accepts.
 *
 * Cancelling is not an error: null / []. Any other failure throws;
 * isCameraDenied(err) tells a refused camera permission.
 */
const CHAT_PHOTO = { quality: 85, width: 1600, height: 1600, correctOrientation: true };
const cancelled = (error) => /cancel/i.test(String(error?.message || ""));

async function oneBase64Photo(source) {
  let photo;
  try {
    photo = await Camera.getPhoto({
      ...CHAT_PHOTO,
      source,
      resultType: CameraResultType.Base64,
      allowEditing: false,
      saveToGallery: false,
    });
  } catch (error) {
    // "User cancelled photos app": the picker or the camera closed without one.
    if (cancelled(error)) return null;
    throw error;
  }
  if (!photo?.base64String) return null;
  const type = photo.format === "png" ? "image/png" : "image/jpeg";
  return base64ToFile(photo.base64String, `photo-${Date.now()}.${type === "image/png" ? "png" : "jpg"}`, type);
}

/** One photo from the camera, as a File; null when the staffer cancels. */
export const takePhotoFile = () => oneBase64Photo(CameraSource.Camera);

/**
 * Up to `room` photos from the phone's photo picker, as Files ([] when the
 * staffer cancels). One slot left → the single-photo picker; more → the
 * multi-photo picker with that limit (Android 13+ enforces it in the picker;
 * older phones may return more, and only `room` are kept).
 */
export async function choosePhotoFiles(room = 1) {
  const n = Math.max(1, Math.floor(Number(room) || 1));
  if (n === 1) {
    const one = await oneBase64Photo(CameraSource.Photos);
    return one ? [one] : [];
  }
  let picked;
  try {
    picked = await Camera.pickImages({ ...CHAT_PHOTO, limit: n });
  } catch (error) {
    if (cancelled(error)) return [];
    throw error;
  }
  const photos = (picked?.photos || []).slice(0, n);
  const stamp = Date.now();
  return Promise.all(photos.map(async (p, i) => {
    // The plugin wrote each one as a JPEG in the app's cache; webPath serves
    // it from the app's own origin.
    const res = await fetch(p.webPath);
    if (!res.ok) throw new Error(`photo ${i + 1}: ${res.status}`);
    const blob = await res.blob();
    const type = p.format === "png" ? "image/png" : "image/jpeg";
    return new File([blob], `photo-${stamp}-${i + 1}.${type === "image/png" ? "png" : "jpg"}`, { type });
  }));
}

/** The camera plugin refused because the CAMERA permission was denied. */
export const isCameraDenied = (error) => /denied/i.test(String(error?.message || ""));

/** A base64 string (no data: prefix) as a File. */
export function base64ToFile(b64, name, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}
