/**
 * Live per-table state for the Reservations floor — which tables are seated,
 * which are about to be, and which a host can give to a walk-in right now.
 *
 * Lifted out of ReservationsPage so it can be tested; the page imports both
 * functions from here, so there is still exactly one definition of each.
 */

/**
 * How soon a table's next booking has to start before the table counts as
 * HELD for it rather than free, in minutes.
 *
 * THE DEFECT THIS FIXES. There used to be no horizon at all: any table with a
 * confirmed booking anywhere later today was "upcoming" — so at 11:40 on a
 * Friday a table booked for 20:00 was painted amber, and because the floor's
 * headline only counts "free" tables, a room with three parties seated and five
 * tables empty read "All tables occupied · next frees 12.30". A host who trusts
 * that line turns walk-ins away from empty tables, and it happens exactly when
 * the evening is well booked — the busiest days are where it lies hardest.
 *
 * The walk-in picker in ReservationsPage already knew: its comment calls this
 * "exactly the over-broad signal we avoid" and recomputes "occupied now" on its
 * own. The floor banner, one screen away, kept reading the over-broad signal.
 *
 * 90 minutes is one ordinary table turn: a party seated now can finish before a
 * booking that far out arrives. Inside that window the table is held (amber,
 * with its ETA); outside it the table is free, and it turns amber on its own as
 * the booking approaches, because the floor recomputes every minute.
 */
export const HOLD_WINDOW_MIN = 90;

/** HH:MM (Danish 24h) from an ISO datetime. */
export function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("da-DK", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function deriveFloorState(reservations, resources, nowMs) {
  const holding = reservations.filter((r) =>
    ["requested", "confirmed", "seated"].includes(r.status),
  );
  return resources
    .filter((r) => r.kind !== "provider")
    .map((res) => {
      const id = String(res.id);
      if (res.is_active === false) {
        return { res, status: "inactive", booking: null, combined: false };
      }
      const mine = holding.filter((r) => {
        if (String(r.resource_id) === id) return true;
        return (r.combined_resource_ids || []).map(String).includes(id);
      });
      if (mine.length === 0) {
        return { res, status: "free", booking: null, combined: false };
      }
      const seated = mine.find((r) => r.status === "seated");
      const current =
        seated ||
        mine.slice().sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))[0];

      // Free until its next party is close. A booking whose start has already
      // passed (a late or no-show party) is negative here and stays "upcoming"
      // — the host still needs to see that one.
      if (!seated && current.starts_at) {
        const startsInMin =
          (new Date(current.starts_at).getTime() - nowMs) / 60000;
        if (startsInMin > HOLD_WINDOW_MIN) {
          return { res, status: "free", booking: null, combined: false };
        }
      }

      const combined =
        Array.isArray(current.combined_resource_ids) &&
        current.combined_resource_ids.length > 1;
      let eta = null;
      if (!seated && current.starts_at) {
        const ms = new Date(current.starts_at).getTime() - nowMs;
        if (ms > 0 && ms < 1000 * 60 * 120) eta = Math.round(ms / 60000);
      }
      return {
        res,
        status: seated ? "seated" : "upcoming",
        combined,
        booking: {
          id: current.id,
          name: current.guest_name,
          time: fmtTime(current.starts_at),
          eta,
          // When an OCCUPIED table frees — the number a host seating walk-ins
          // actually decides on. Only for seated tables (an upcoming table
          // isn't holding a seat yet); the floor tile + the "next free" readout
          // both read these. freesInMin goes negative once it runs over (the
          // visual status flips to "overdue" and shows "+Nm over" instead).
          freesAt: seated && current.ends_at ? fmtTime(current.ends_at) : null,
          freesInMin:
            seated && current.ends_at
              ? Math.round((new Date(current.ends_at).getTime() - nowMs) / 60000)
              : null,
          reservation: current,
        },
      };
    });
}
