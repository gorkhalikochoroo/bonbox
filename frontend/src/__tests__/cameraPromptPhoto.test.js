/**
 * Chat photos in the Android staff app (Android walks, 11 Nov 2026): take ONE
 * photo with the camera, or choose SEVERAL from the photo picker — never more
 * than the chat still has room for — each turned into a File for the chat's
 * usual picker and upload. (The plugin's own "choose or take" prompt chose
 * only one photo, which took the chat's pick-up-to-3 away.) The plugin is
 * mocked at its boundary (Camera.getPhoto / Camera.pickImages, and fetch for
 * the picked files' webPath); everything after it is the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Plain stubs, not vi.fn: a spy that returns a rejected promise leaves a
// derived promise of its own unhandled, which the runner then blames on a test.
const cam = vi.hoisted(() => ({
  calls: [], impl: () => Promise.resolve(null),
  pickCalls: [], pickImpl: () => Promise.resolve({ photos: [] }),
}));
const getPhoto = {
  get mock() { return { calls: cam.calls }; },
  mockResolvedValue(v) { cam.impl = () => Promise.resolve(v); },
  mockRejectedWith(msg) { cam.impl = () => Promise.reject(new Error(msg)); },
  mockReset() { cam.calls.length = 0; cam.impl = () => Promise.resolve(null); },
};
const pickImages = {
  get mock() { return { calls: cam.pickCalls }; },
  mockResolvedValue(v) { cam.pickImpl = () => Promise.resolve(v); },
  mockRejectedWith(msg) { cam.pickImpl = () => Promise.reject(new Error(msg)); },
  mockReset() { cam.pickCalls.length = 0; cam.pickImpl = () => Promise.resolve({ photos: [] }); },
};
vi.mock("@capacitor/camera", () => ({
  Camera: {
    getPhoto: (...a) => { cam.calls.push(a); return cam.impl(...a); },
    pickImages: (...a) => { cam.pickCalls.push(a); return cam.pickImpl(...a); },
  },
  CameraSource: { Prompt: "PROMPT", Camera: "CAMERA", Photos: "PHOTOS" },
  CameraResultType: { Base64: "base64", Uri: "uri" },
}));

const { takePhotoFile, choosePhotoFiles, isCameraDenied, base64ToFile } = await import("../utils/camera");

const BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const B64 = btoa(String.fromCharCode(...BYTES));

const readBytes = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve([...new Uint8Array(r.result)]);
  r.onerror = reject;
  r.readAsArrayBuffer(file);
});

// The picked files' webPath, served from the app's own origin.
const served = {};
const realFetch = globalThis.fetch;
beforeEach(() => {
  getPhoto.mockReset();
  pickImages.mockReset();
  for (const k of Object.keys(served)) delete served[k];
  globalThis.fetch = vi.fn((url) => Promise.resolve(served[url]
    ? { ok: true, status: 200, blob: () => Promise.resolve(new Blob([new Uint8Array(served[url])], { type: "image/jpeg" })) }
    : { ok: false, status: 404, blob: () => Promise.resolve(new Blob([])) }));
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("takePhotoFile", () => {
  it("opens the CAMERA (not the prompt) for base64, ≤ 1600 px, upright, not saved to the gallery", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "jpeg" });
    await takePhotoFile();
    expect(getPhoto.mock.calls).toHaveLength(1);
    expect(getPhoto.mock.calls[0][0]).toMatchObject({
      source: "CAMERA", resultType: "base64", width: 1600, height: 1600, correctOrientation: true,
      allowEditing: false, saveToGallery: false,
    });
    expect(pickImages.mock.calls).toHaveLength(0);
  });

  it("returns a JPEG File holding exactly the photo's bytes", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "jpeg" });
    const file = await takePhotoFile();
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/^photo-\d+\.jpg$/);
    expect(await readBytes(file)).toEqual(BYTES);
  });

  it("a PNG stays a PNG", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "png" });
    const file = await takePhotoFile();
    expect(file.type).toBe("image/png");
    expect(file.name).toMatch(/\.png$/);
  });

  it("cancel (the camera closed without a photo) is null, not an error", async () => {
    getPhoto.mockRejectedWith("User cancelled photos app");
    await expect(takePhotoFile()).resolves.toBeNull();
    getPhoto.mockResolvedValue({});
    await expect(takePhotoFile()).resolves.toBeNull();
  });

  it("a refused camera permission throws, and isCameraDenied tells it apart", async () => {
    getPhoto.mockRejectedWith("User denied access to camera");
    let err = null;
    try { await takePhotoFile(); } catch (e) { err = e; }
    expect(String(err?.message)).toBe("User denied access to camera");
    expect(isCameraDenied(err)).toBe(true);
    expect(isCameraDenied(new Error("Unable to process image"))).toBe(false);
    expect(isCameraDenied(undefined)).toBe(false);
  });
});

describe("choosePhotoFiles", () => {
  it("room for 3: the multi-photo picker, limited to 3, ≤ 1600 px — each picked photo becomes a JPEG File", async () => {
    served["http://localhost/_capacitor_file_/a.jpg"] = [1, 2, 3];
    served["http://localhost/_capacitor_file_/b.jpg"] = [4, 5];
    pickImages.mockResolvedValue({ photos: [
      { webPath: "http://localhost/_capacitor_file_/a.jpg", format: "jpeg" },
      { webPath: "http://localhost/_capacitor_file_/b.jpg", format: "jpeg" },
    ] });
    const files = await choosePhotoFiles(3);
    expect(pickImages.mock.calls).toHaveLength(1);
    expect(pickImages.mock.calls[0][0]).toMatchObject({ limit: 3, width: 1600, height: 1600, correctOrientation: true });
    expect(getPhoto.mock.calls).toHaveLength(0);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f instanceof File && f.type === "image/jpeg")).toBe(true);
    expect(files[0].name).toMatch(/^photo-\d+-1\.jpg$/);
    expect(files[1].name).toMatch(/^photo-\d+-2\.jpg$/);
    expect(await readBytes(files[0])).toEqual([1, 2, 3]);
    expect(await readBytes(files[1])).toEqual([4, 5]);
  });

  it("room for 2: the limit is 2, and a picker that returns more (older Android) is cut to 2", async () => {
    for (const n of ["a", "b", "c"]) served[`http://localhost/_capacitor_file_/${n}.jpg`] = [9];
    pickImages.mockResolvedValue({ photos: ["a", "b", "c"].map((n) => ({ webPath: `http://localhost/_capacitor_file_/${n}.jpg`, format: "jpeg" })) });
    const files = await choosePhotoFiles(2);
    expect(pickImages.mock.calls[0][0].limit).toBe(2);
    expect(files).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("room for 1: the single-photo picker (a limit of 1 would mean 'no limit' to Android's picker)", async () => {
    getPhoto.mockResolvedValue({ base64String: B64, format: "jpeg" });
    const files = await choosePhotoFiles(1);
    expect(pickImages.mock.calls).toHaveLength(0);
    expect(getPhoto.mock.calls[0][0]).toMatchObject({ source: "PHOTOS", resultType: "base64", width: 1600, height: 1600 });
    expect(files).toHaveLength(1);
    expect(await readBytes(files[0])).toEqual(BYTES);
  });

  it("cancelling either picker is an empty list, not an error", async () => {
    pickImages.mockRejectedWith("User cancelled photos app");
    await expect(choosePhotoFiles(3)).resolves.toEqual([]);
    getPhoto.mockRejectedWith("User cancelled photos app");
    await expect(choosePhotoFiles(1)).resolves.toEqual([]);
  });

  it("a picked file that cannot be read throws (said as 'couldn't add the photo'), nothing half-added", async () => {
    pickImages.mockResolvedValue({ photos: [{ webPath: "http://localhost/_capacitor_file_/gone.jpg", format: "jpeg" }] });
    await expect(choosePhotoFiles(3)).rejects.toThrow(/404/);
  });
});

describe("base64ToFile", () => {
  it("decodes into a File of the given type", async () => {
    const f = base64ToFile(B64, "x.jpg", "image/jpeg");
    expect(f.size).toBe(BYTES.length);
    expect(f.type).toBe("image/jpeg");
  });
});
