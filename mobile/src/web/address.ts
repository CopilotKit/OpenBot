/**
 * The address of the web app that OpenBot Mobile shows in its web view (./shell.tsx), read from
 * EXPO_PUBLIC_WEB_URL. For OpenBot Cloud that is the address people open in a browser, which is not the
 * API's address (EXPO_PUBLIC_SERVER_URL, ../auth.ts).
 *
 * Empty or unset, there is no web view, and the app draws its own screens.
 *
 * Imports nothing that needs a phone, so it can be tested.
 */

/** The web app's origin, or null when none is named. Throws on a value that is not a usable address. */
export function readWebAddress(
  value: string | undefined,
  dev: boolean,
): string | null {
  const named = value?.trim();
  if (!named) return null;
  let url: URL;
  try {
    url = new URL(named);
  } catch {
    throw new Error("EXPO_PUBLIC_WEB_URL is not an address.");
  }
  if (url.protocol !== "https:" && !(dev && url.protocol === "http:"))
    throw new Error("EXPO_PUBLIC_WEB_URL must be an https address.");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new Error(
      "EXPO_PUBLIC_WEB_URL is the web app's address alone, with no path, query or sign-in in it.",
    );
  return url.origin;
}
