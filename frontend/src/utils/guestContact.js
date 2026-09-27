// Guest contact rules for the public booking page — the SAME shape checks the
// server applies (backend/app/routers/public_reservations.py _EMAIL_RE /
// _PHONE_RE / _clean_phone), so a typo is caught while the guest can still
// see the field, not answered with a generic "something went wrong".

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()\-./]{6,40}$/;

export function emailOk(value) {
  const v = String(value || "").trim();
  return !!v && EMAIL_RE.test(v);
}

export function phoneOk(value) {
  const v = String(value || "").split(/\s+/).filter(Boolean).join(" ");
  if (!v) return false;
  const digits = (v.match(/\d/g) || []).length;
  return digits >= 6 && digits <= 15 && PHONE_RE.test(v);
}

/**
 * The contact state the form acts on. The guest picks ONE way to reach them
 * (Email | Phone) and sees one field; the other may still hold something typed
 * before they switched.
 *
 * - `ok`: the shown field is valid — or it is empty and the hidden one is valid.
 * - `activeInvalid`: the shown field has text that the server would refuse.
 * - `payload`: only VALID values are sent. Sending both unconditionally let a
 *   half-typed email left behind on the hidden tab 422 the whole booking,
 *   forever, from a field the guest could no longer see.
 */
export function contactState(mode, email, phone) {
  const eOk = emailOk(email);
  const pOk = phoneOk(phone);
  const active = mode === "phone" ? phone : email;
  const activeOk = mode === "phone" ? pOk : eOk;
  const hiddenOk = mode === "phone" ? eOk : pOk;
  const activeEmpty = !String(active || "").trim();
  return {
    ok: activeOk || (activeEmpty && hiddenOk),
    activeInvalid: !activeEmpty && !activeOk,
    payload: {
      guest_email: eOk ? String(email).trim() : null,
      guest_phone: pOk ? String(phone).split(/\s+/).filter(Boolean).join(" ") : null,
    },
  };
}
