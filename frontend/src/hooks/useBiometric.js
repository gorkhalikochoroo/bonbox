import { platform } from "../utils/platform";

/**
 * Face ID / Touch ID biometric authentication.
 * Uses dynamic import to avoid crash if @aparajita/capacitor-biometric-auth
 * is not installed yet (it's a v2 install step).
 * Returns no-op functions on web.
 */
export function useBiometric() {
  const isBiometricAvailable = async () => {
    if (!platform.isNative) return false;
    try {
      const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
      const result = await BiometricAuth.checkBiometry();
      return result.isAvailable;
    } catch {
      return false;
    }
  };

  const authenticate = async () => {
    if (!platform.isNative) return true; // skip on web
    try {
      const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
      await BiometricAuth.authenticate({
        reason: "Unlock BonBox to access your business data",
        cancelTitle: "Use Password",
        allowDeviceCredential: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  return { isBiometricAvailable, authenticate };
}
