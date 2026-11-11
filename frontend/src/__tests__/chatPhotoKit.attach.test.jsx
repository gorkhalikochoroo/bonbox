/**
 * The chat's photo button (Android walk, 11 Nov 2026). Without `onPick` it
 * is the file input it always was (the owner drawer, iOS, browsers). With
 * `onPick` (the Android staff app) it is a plain button that stages the File
 * onPick returns — through the same picker, the same 3-photo cap.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AttachButton, PendingPhotos, usePhotoPicker } from "../components/staff/chatPhotoKit";
import { LanguageProvider } from "../hooks/useLanguage";

beforeAll(() => {
  if (!URL.createObjectURL) URL.createObjectURL = () => "blob:x";
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
});

function Harness({ onPick, max }) {
  const picker = usePhotoPicker(max);
  return (
    <>
      <PendingPhotos picker={picker} />
      <AttachButton picker={picker} onPick={onPick} />
      <span data-testid="count">{picker.files.length}</span>
    </>
  );
}
const mount = (props) => {
  localStorage.setItem("lang", "da");
  return render(<LanguageProvider><Harness {...props} /></LanguageProvider>);
};
const jpeg = () => new File([new Uint8Array([1, 2, 3])], "p.jpg", { type: "image/jpeg" });

describe("AttachButton", () => {
  it("without onPick: the label wrapping a multi-file input, as before", () => {
    mount({});
    const btn = screen.getByTestId("chat-photo-attach");
    expect(btn.tagName).toBe("LABEL");
    const input = btn.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg");
  });

  it("with onPick: a button; the File it returns is staged as a thumbnail", async () => {
    const onPick = vi.fn(() => Promise.resolve(jpeg()));
    mount({ onPick });
    const btn = screen.getByTestId("chat-photo-attach");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.querySelector("input")).toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Tilføj billede");
    await act(async () => { fireEvent.click(btn); });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("onPick returning null (cancelled) stages nothing", async () => {
    mount({ onPick: vi.fn(() => Promise.resolve(null)) });
    await act(async () => { fireEvent.click(screen.getByTestId("chat-photo-attach")); });
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("at the cap the button is disabled and onPick is not asked", async () => {
    const onPick = vi.fn(() => Promise.resolve(jpeg()));
    mount({ onPick, max: 1 });
    const btn = screen.getByTestId("chat-photo-attach");
    await act(async () => { fireEvent.click(btn); });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(btn.disabled).toBe(true);
    await act(async () => { fireEvent.click(btn); });
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
