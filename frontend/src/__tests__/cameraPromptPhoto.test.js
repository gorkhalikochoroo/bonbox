/**
 * Chat photo in the Android staff app (Android walk, 11 Nov 2026): the
 * camera plugin's own "choose or take" prompt, turned into a File for the
 * chat's usual picker and upload. The plugin is mocked at its boundary
 * (Camera.getPhoto); everything after it is the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain stub, not vi.fn: a spy that returns a rejected promise leaves a
// derived promise of its own unhandled, which the runner then blames on a test.
const cam = vi.hoisted(() => ({ calls: [], impl: () => Promise.resolve(null) }));
const getPhoto = {
  get mock() { return { calls: cam.calls }; },
  mockResolvedValue(v) { cam.impl = () => Promise.resolve(v); },
  mockRejectedWith(msg) { cam.impl = () => Promise.reject(new Error(msg)); },
  mockReset() { cam.calls.length = 0; cam.impl = () => Promise.resolve(null); },
};
vi.mock("@capacitor/camera", () => ({
  Camera: { getPhoto: (...a) => { cam.calls.push(a); return cam.impl(...a); } },
  CameraSource: { Prompt: "PROMPT", Camera: "CAMERA", Photos: "PHOTOS" },
  CameraResultType: { Base64: "base64", Uri: "uri" },
}));

const { promptPhotoFile, isCameraDenied, base64ToFile } = await import("../utils/camera");

const BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const B64 = btoa(String.fromCharCode(...BYTES));
const LABELS = { header: "Tilføj billede", photo: "Vælg et billede", picture: "Tag et billede", cancel: "Annuller" };

beforeEach(() => getPhoto.mockReset());

describe("promptPhotoFile", () => {
  it("asks for the prompt (choose OR take) as base64, ≤ 1600 px, upright, with the labels", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "jpeg" });
    await promptPhotoFile(LABELS);
    const opts = getPhoto.mock.calls[0][0];
    expect(opts).toMatchObject({
      source: "PROMPT", resultType: "base64", width: 1600, height: 1600, correctOrientation: true,
      allowEditing: false, saveToGallery: false,
      promptLabelHeader: "Tilføj billede", promptLabelPhoto: "Vælg et billede",
      promptLabelPicture: "Tag et billede", promptLabelCancel: "Annuller",
    });
  });

  it("returns a JPEG File holding exactly the photo's bytes", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "jpeg" });
    const file = await promptPhotoFile(LABELS);
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/^photo-\d+\.jpg$/);
    const buf = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
    expect([...new Uint8Array(buf)]).toEqual(BYTES);
  });

  it("a PNG stays a PNG", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "png" });
    const file = await promptPhotoFile(LABELS);
    expect(file.type).toBe("image/png");
    expect(file.name).toMatch(/\.png$/);
  });

  it("cancel (sheet, picker or camera closed) is null, not an error", async () => {
    getPhoto.mockRejectedWith("User cancelled photos app");
    await expect(promptPhotoFile(LABELS)).resolves.toBeNull();
    getPhoto.mockResolvedValue({});
    await expect(promptPhotoFile(LABELS)).resolves.toBeNull();
  });

  it("a refused camera permission throws, and isCameraDenied tells it apart", async () => {
    getPhoto.mockRejectedWith("User denied access to camera");
    let err = null;
    try { await promptPhotoFile(LABELS); } catch (e) { err = e; }
    expect(String(err?.message)).toBe("User denied access to camera");
    expect(isCameraDenied(err)).toBe(true);
    expect(isCameraDenied(new Error("Unable to process image"))).toBe(false);
    expect(isCameraDenied(undefined)).toBe(false);
  });

  it("base64ToFile decodes into a File of the given type", async () => {
    const f = base64ToFile(B64, "x.jpg", "image/jpeg");
    expect(f.size).toBe(BYTES.length);
    expect(f.type).toBe("image/jpeg");
  });
});
