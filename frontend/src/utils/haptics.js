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
  /** Warning — cash variance, budget limit */
  warning: () => {
    if (platform.isNative) Haptics.notification({ type: NotificationType.Warning });
  },
};
