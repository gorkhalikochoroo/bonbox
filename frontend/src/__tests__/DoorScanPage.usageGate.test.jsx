/**
 * DoorScanPage under the USAGE GATE.
 *
 * Spec item 8 removed the ticket tile and the event picker for an owner whose
 * Events pillar is usage-hidden — but the ticket-mode PAGE HEADER kept saying
 * "Vælg arrangement" / "Tjek gæster ind ved døren med en QR-scanning" over a
 * screen with no event to choose. That landing is ONE tap away on the only
 * in-app path to /scan: every entry is ?mode=gavekort (QuickAdd,
 * GavekortPage — /scan is in neither NAV_MANIFEST nor ⌘K), and both the
 * "Tilbage" action and "Stop scanner" (fired after every gavekort scan) drop
 * back into ticket mode.
 *
 * So these tests pin the FRAMING to the gate, in both directions, plus the
 * loading rule the rest of the gate already obeys: never move a tile or a
 * title out from under a finger on a maybe.
 *
 * t() returns the key, so every assertion reads against the string key — the
 * header keys (scanTitle / scanTitleSubtitle vs gkScanEyebrow /
 * scanGavekortTileSub) and the tile key (scanTicketTileTitle) are distinct,
 * which is what lets "header lies" be told apart from "tile is gone".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 7, business_type: "cafe" } }),
}));

// jsQR is only touched inside the live camera loop; the landing never scans.
vi.mock("jsqr", () => ({ default: () => null }));

const activationState = vi.hoisted(() => ({ knownDormant: new Set() }));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({ usageKnownDormant: activationState.knownDormant }),
}));

import api from "../services/api";
import DoorScanPage from "../pages/DoorScanPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <DoorScanPage />
    </MemoryRouter>,
  );
}

describe("DoorScanPage — usage gate framing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activationState.knownDormant = new Set();
    // No events + no camera: the page settles on the ticket-mode landing,
    // which is the screen the gate reshapes.
    api.get.mockResolvedValue({ data: [] });
  });

  it("KNOWN-dormant: the header does not name an action the page no longer offers", async () => {
    activationState.knownDormant = new Set(["events"]);
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("scanTitle")).toBeNull();
    });
    // The instruction half of the framing has to go too, not just the title.
    expect(screen.queryByText("scanTitleSubtitle")).toBeNull();
    // ...and what replaces it is the job this owner actually has here.
    expect(screen.getAllByText("gkScanEyebrow").length).toBeGreaterThan(0);
  });

  it("KNOWN-dormant: the ticket tile is gone (the reason the header had to move)", async () => {
    activationState.knownDormant = new Set(["events"]);
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("scanTicketTileTitle")).toBeNull();
    });
    // Positive control — gavekort redeem needs no event and must survive.
    expect(screen.getAllByText("scanGavekortTileSub").length).toBeGreaterThan(0);
  });

  it("not dormant: the ticket framing and tile are untouched", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("scanTitle")).toBeTruthy();
    });
    expect(screen.getByText("scanTitleSubtitle")).toBeTruthy();
    expect(screen.getByText("scanTicketTileTitle")).toBeTruthy();
  });

  it("merely loading (empty set) keeps the ticket framing — nothing moves on a maybe", async () => {
    // usageKnownDormant is empty while /activation has not answered for this
    // user. Re-framing the page then would swap the title under a finger and
    // swap it back a moment later.
    activationState.knownDormant = new Set();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("scanTitle")).toBeTruthy();
    });
    expect(screen.getByText("scanTicketTileTitle")).toBeTruthy();
  });

  it("a gated pillar other than events does not reshape this page", async () => {
    activationState.knownDormant = new Set(["inventory"]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("scanTitle")).toBeTruthy();
    });
    expect(screen.getByText("scanTicketTileTitle")).toBeTruthy();
  });
});
