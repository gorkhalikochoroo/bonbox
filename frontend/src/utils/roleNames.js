/**
 * Role codes → the owner's words ("kitchen" → "Køkken"). staff_members.role
 * and role_on_shift are free text, so a code with no entry prints as typed.
 * Shared by the Vagtplan and the sick-call card — the card printed the raw
 * English code ("Ali R. · kitchen") inside a Danish page.
 */
export const ROLE_NAME_KEYS = {
  chef: ["stfRoleChef", "Chef"],
  cook: ["stfRoleChef", "Chef"],
  server: ["stfRoleServer", "Server"],
  waiter: ["stfRoleServer", "Server"],
  dishwasher: ["stfRoleDishwasher", "Dishwasher"],
  manager: ["teamRoleManager", "Manager"],
  kitchen: ["roleKitchen", "Kitchen"],
  floor: ["roleFloor", "Floor"],
  // A staffer whose role is the SECTION word ("bar", lowercase, as the roster
  // stores it) read as the raw key "bar" beside "Køkken" and "Gulv".
  bar: ["roleBar", "Bar"],
  bartender: ["stfRoleBartender", "Bartender"],
  barista: ["stfRoleBarista", "Barista"],
  runner: ["stfRoleRunner", "Runner"],
  "full-time": ["contractFull", "Full-time"],
  full_time: ["contractFull", "Full-time"],
  "part-time": ["contractPart", "Part-time"],
  part_time: ["contractPart", "Part-time"],
  student: ["contractStudent", "Student"],
};
export function roleName(role, t) {
  const hit = ROLE_NAME_KEYS[String(role || "").trim().toLowerCase()];
  return hit ? t(hit[0], hit[1]) : role;
}
