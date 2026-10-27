// "No table fits" (R11), on first use — what components/reservations/
// NoTableFitsSheet.jsx is in the door screen's own build only
// (scripts/standBuild.mjs swaps it in; this module's own import reaches the
// real sheet). Fix round 27 Oct, MERGE §5 item 4: headroom under 200 kB.
import standSheet from "./standSheet";

const OnFirstUse = standSheet(() => import("../components/reservations/NoTableFitsSheet.jsx"));

export default function NoTableFitsSheet(props) {
  return <OnFirstUse {...props} />;
}
