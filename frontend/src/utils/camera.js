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
