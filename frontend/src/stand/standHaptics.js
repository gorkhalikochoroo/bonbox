// The door screen's haptics (R11, rubric B11) — what utils/haptics.js is, in
// the door screen's own build only. Haptics are a native-app feature (no-op
// on the web, see utils/haptics.js), and the door screen is always the web.
const none = () => {};

export const haptic = {
  light: none,
  medium: none,
  success: none,
  error: none,
  warning: none,
};
