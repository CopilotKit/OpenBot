import { requireNativeModule } from "expo-modules-core";

/** The shell's own native module (ios/ShellNativeModule.swift, android/.../ShellNativeModule.kt). */
type ShellNativeModule = {
  launchArguments(): Record<string, string>;
  httpsCallbackSupported(host: string): boolean;
  hasSessionCookie(url: string): Promise<boolean>;
  setCookie(
    url: string,
    name: string,
    value: string,
    secure: boolean,
  ): Promise<boolean>;
  clearSiteData(url: string): Promise<number>;
  clearAllData(): Promise<null>;
  setSignInPending(pending: boolean): boolean;
  flushCookies(): boolean;
  dismissKeyboard(): void;
};

export default requireNativeModule<ShellNativeModule>("ShellNative");
