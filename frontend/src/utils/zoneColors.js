// Zones are data, so they carry a colour too — a HOLLOW ring, so it never
// reads as a status (statuses are filled: amber request, sky confirmed,
// green seated, orange late, red overdue, grey history), in hues kept clear
// of those. Assigned by the zone's place in the sorted list, so ≤5 zones
// never collide; only when a venue has two or more zones (one zone tells the
// host nothing). Shared by the list, the timeline and the floor, so a zone
// is the same colour on all three.
const ZONE_RINGS = [
  "border-violet-500",
  "border-stone-500",
  "border-fuchsia-400",
  "border-slate-400",
  // Pink last: next to the red of "over time" it was the closest call.
  "border-pink-500",
];

export function zoneTones(rows, getId = (r) => r.id, getZone = (r) => r.zone) {
  const list = Array.isArray(rows) ? rows : [];
  const zones = [...new Set(list.map(getZone).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (zones.length < 2) return { byId: {}, zones: [] };
  const byZone = Object.fromEntries(zones.map((z, i) => [z, ZONE_RINGS[i % ZONE_RINGS.length]]));
  const byId = {};
  for (const r of list) {
    const z = getZone(r);
    if (z) byId[String(getId(r))] = { cls: byZone[z], zone: z };
  }
  return { byId, zones: zones.map((z) => ({ zone: z, cls: byZone[z] })) };
}
