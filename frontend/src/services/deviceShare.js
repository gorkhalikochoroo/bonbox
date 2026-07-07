// Bridges the axios layer and the React DeviceShareProvider for the shared-
// device ("Delt enhed") reveal PIN (#379).
//
// The reveal proof lives HERE in module scope (in-memory only — never
// localStorage/sessionStorage, so it evaporates on refresh/relock and can't be
// lifted off disk) so the axios request interceptor can attach it as the
// X-BonBox-Device-Pin header, and the provider can register a handler that opens
// the LockScreen when the backend answers 403 device_pin_required.
let _proof = null;
let _onLock = null;

export function getRevealProof() {
  return _proof;
}
export function setRevealProof(p) {
  _proof = p || null;
}
export function registerDeviceLockHandler(fn) {
  _onLock = typeof fn === "function" ? fn : null;
}
export function triggerDeviceLock() {
  if (typeof _onLock === "function") _onLock();
}
