import { readWebAddress } from "./address";

/**
 * The web app this build shows in its web view, or null for a build that draws its own screens.
 * EXPO_PUBLIC_WEB_URL names it: eas.json for a build on EAS, `.env` on your machine.
 */
export const WEB_ADDRESS = readWebAddress(
  process.env.EXPO_PUBLIC_WEB_URL,
  __DEV__,
);
