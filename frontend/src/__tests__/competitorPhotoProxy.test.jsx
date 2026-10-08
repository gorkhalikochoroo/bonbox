/**
 * The scan picker's Google photos load through BonBox's owner-scoped proxy as
 * a blob — never a Google URL with the platform key in it (security review,
 * 8 Oct: /photos used to hand every account `…&key=<Places key>`).
 */
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }));

import { CompetitorPhotoThumb } from "../pages/CompetitorPage";

beforeEach(() => {
  get.mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => "blob:thumb-1");
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe("CompetitorPhotoThumb", () => {
  it("fetches the proxy as a blob and shows it", async () => {
    get.mockResolvedValue({ data: new Blob(["x"], { type: "image/jpeg" }) });
    const { container, unmount } = render(<CompetitorPhotoThumb competitorId="c1" photoRef="Aap_ref-1" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/competitors/c1/photo/Aap_ref-1", { responseType: "blob" });
    const src = container.querySelector("img").getAttribute("src");
    expect(src).toBe("blob:thumb-1");
    expect(src).not.toMatch(/key=|googleapis/);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumb-1");
  });

  it("a photo that cannot load leaves a plain tile, no broken image", async () => {
    get.mockRejectedValue(new Error("502"));
    const { container } = render(<CompetitorPhotoThumb competitorId="c1" photoRef="Aap_ref-2" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
  });
});
