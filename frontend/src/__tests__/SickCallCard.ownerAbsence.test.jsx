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
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "da" }),
}));
const Card = (await import("../components/SickCallNotificationCard")).default;

describe("owner-entered absence on the card", () => {
  it("is approved, needs cover, and is not counted as pending", async () => {
    get.mockResolvedValue({ data: [{ id: "a1", staff_name: "Sara K.", kind: "sick", date: "2026-11-28", status: "acknowledged", shift_start: "17:00", shift_end: "22:30" }] });
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


describe("cover is only offered where there is a shift", () => {
  it("a day without a shift needs no cover; a day with one shows the shift in Danish time", async () => {
    get.mockReset();
    get.mockResolvedValue({ data: [
      { id: "b2", staff_name: "Sara K.", kind: "sick", date: "2026-11-27", status: "acknowledged", shift_start: "17:00", shift_end: "22:30" },
      { id: "b1", staff_name: "Sara K.", kind: "sick", date: "2026-11-26", status: "acknowledged" },
    ] });
    render(<Card />);
    expect(await screen.findByText("No shift that day — no cover needed.")).toBeInTheDocument();
    expect(screen.getByText(/17\.00–22\.30/)).toBeInTheDocument();
    expect(screen.getAllByText(/sickCallFindCover|Find cover/)).toHaveLength(1);
    expect(screen.getByText(/1 without cover/)).toBeInTheDocument();
  });
});
