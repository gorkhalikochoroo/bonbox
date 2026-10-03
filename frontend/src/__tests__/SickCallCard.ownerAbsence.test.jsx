/**
 * The sick-call card reads the owner's own fravær honestly: an absence the
 * owner entered is "Godkendt" and only needs cover — it is not counted as
 * "afventer", the status is a word not a raw code, the date is a date, and
 * the card re-reads when an absence is added elsewhere on the page.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "en" }),
}));
const Card = (await import("../components/SickCallNotificationCard")).default;

describe("owner-entered absence on the card", () => {
  it("is approved, needs cover, and is not counted as pending", async () => {
    get.mockResolvedValue({ data: [{ id: "a1", staff_name: "Sara K.", kind: "sick", date: "2026-11-28", status: "acknowledged" }] });
    render(<Card />);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText(/ACKNOWLEDGED|acknowledged/)).not.toBeInTheDocument();
    expect(screen.queryByText("2026-11-28")).not.toBeInTheDocument();
    expect(screen.getByText(/1 without cover/)).toBeInTheDocument();
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
  });

  it("re-reads when an absence changes elsewhere on the page", async () => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
    render(<Card />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("bonbox-data-changed"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
