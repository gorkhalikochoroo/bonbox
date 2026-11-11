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
 * Chat photo in the Android staff app: "Choose a photo" OR "Take a photo".
 *
 * The chat's <input type="file"> cannot take a photo in the Android WebView:
 * Capacitor's file chooser (BridgeWebChromeClient) opens the camera only for
 * an input with `capture` that accepts "image/*", and then ONLY the camera —
 * the chat's input has no `capture` and accepts png/jpeg, so it got the photo
 * picker and no camera at all. The camera plugin's own
 * prompt offers both (choosing needs no permission; taking asks for the
 * CAMERA permission the app already declares). The result becomes a File for
 * the SAME picker and upload as a chosen file; the long edge ≤ 1600 px matches
 * what the server keeps (chat_image MAX_OUTPUT_DIM), and the plugin writes
 * JPEG, which the server accepts.
 *
 * @param {{header?: string, photo?: string, picture?: string, cancel?: string}} labels
 * @returns {Promise<File|null>} null when the staffer cancels. Throws on any
 *   other failure; isCameraDenied(err) tells a refused camera permission.
 */
export async function promptPhotoFile(labels = {}) {
  let photo;
  try {
    photo = await Camera.getPhoto({
      source: CameraSource.Prompt,
      resultType: CameraResultType.Base64,
      quality: 85,
      width: 1600,
      height: 1600,
      correctOrientation: true,
      allowEditing: false,
      saveToGallery: false,
      promptLabelHeader: labels.header,
      promptLabelPhoto: labels.photo,
      promptLabelPicture: labels.picture,
      promptLabelCancel: labels.cancel,
    });
  } catch (error) {
    // "User cancelled photos app": the sheet, the picker or the camera was
    // closed without a photo. Not an error to show.
    if (/cancel/i.test(String(error?.message || ""))) return null;
    throw error;
  }
  if (!photo?.base64String) return null;
  const type = photo.format === "png" ? "image/png" : "image/jpeg";
  return base64ToFile(photo.base64String, `photo-${Date.now()}.${type === "image/png" ? "png" : "jpg"}`, type);
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
