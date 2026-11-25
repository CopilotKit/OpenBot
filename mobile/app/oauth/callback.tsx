import { router } from "expo-router";
import { useEffect } from "react";
import { backToHome } from "../../src/link-company";

/**
 * openbotmobile://oauth/callback: where OpenBot's sign-in page sends the browser with its code (../../src/oauth.ts).
 * The browser's sign-in session reads the code itself, and Home shows the result. This screen is only for an address
 * that opens the app outside that session (Android brought back from its icon mid-sign-in, or a cold start), so it
 * leaves for Home and keeps no second Home behind.
 */
export default function OAuthCallback() {
  useEffect(() => {
    backToHome(router);
  }, []);
  return null;
}
