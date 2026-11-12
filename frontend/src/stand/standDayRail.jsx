// The month day rail, on first use — what components/reservations/DayRail.jsx
// is in the door screen's own build only (scripts/standBuild.mjs swaps it
// in; this module's own import reaches the real rail). The door screen opens
// it from the date button, rarely mid-service. Reservations v2 (12 Nov
// 2026): headroom under 200 kB for the room beside the list.
import standSheet from "./standSheet";

const OnFirstUse = standSheet(() => import("../components/reservations/DayRail.jsx"));

export default function DayRail(props) {
  return <OnFirstUse {...props} />;
}
