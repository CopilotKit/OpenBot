/** How the server names an app's key version: the app's own name, then this (`DirectoryKeyVersion`). */
const KEY_VERSION_SUFFIX = " (key)";

/**
 * The vendor an app's account is with, named as people know it: "PostHog" for the key version
 * "PostHog (key)". A sentence about the person's account at the vendor, or where a key comes from,
 * names the vendor. The app keeps its own title everywhere it is listed, so the key version and the
 * sign-in read apart.
 */
export function vendorNameOf(title: string): string {
  return title.endsWith(KEY_VERSION_SUFFIX)
    ? title.slice(0, -KEY_VERSION_SUFFIX.length)
    : title;
}
