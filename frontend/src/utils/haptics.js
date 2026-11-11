import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { platform } from "./platform";

/** Haptic feedback helpers — no-op on web */
export const haptic = {
  /** Light tap — button press, tab switch */
  light: () => {
    if (platform.isNative) Haptics.impact({ style: ImpactStyle.Light });
  },
  /** Medium tap — save, confirm */
  medium: () => {
    if (platform.isNative) Haptics.impact({ style: ImpactStyle.Medium });
  },
  /** Success — daily close submitted, sale saved */
  success: () => {
    if (platform.isNative) Haptics.notification({ type: NotificationType.Success });
  },
  /** Error — validation failed */
  error: () => {
    if (platform.isNative) Haptics.notification({ type: NotificationType.Error });
  },
  /** Warning — cash variance, budget limit. Android plays the two short taps
   *  of ERROR (27 + 50 ms): Capacitor 8.0.2's Android WARNING is one 210 ms
   *  full-strength buzz (every amplitude 255, so its "gaps" are not gaps).
   *  iPhone unchanged. Manoj's call G, 11 Nov 2026 (premium-feel spec). */
  warning: () => {
    if (platform.isNative) Haptics.notification({ type: platform.isAndroid ? NotificationType.Error : NotificationType.Warning });
  },
};
