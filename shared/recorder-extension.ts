import config from "./recorder-extension.json";

export const RECORDER_NATIVE_HOST: string = config.nativeHost;

/** The Recorder's one id, in every build, in Chrome and Edge. */
export const RECORDER_EXTENSION_ID: string = config.extensionId;

/**
 * The Recorder's ids in the browsers' own stores, once it is published there: the Chrome Web Store keeps the fixed id
 * when the first upload carries its key, and Edge Add-ons always assigns its own. Empty until published; nothing that
 * reads them acts on an empty one.
 */
export const RECORDER_STORE_IDS: { chrome?: string; edge?: string } = {
  ...(config.storeIds?.chrome ? { chrome: config.storeIds.chrome } : {}),
  ...(config.storeIds?.edge ? { edge: config.storeIds.edge } : {}),
};

/** The Recorder's page in each store, where a person adds it to their own browser. */
export function recorderStorePage(
  store: "chrome" | "edge",
  id: string,
): string {
  return store === "chrome"
    ? `https://chromewebstore.google.com/detail/${id}`
    : `https://microsoftedge.microsoft.com/addons/detail/${id}`;
}

/** The fixed id first, then the store ids, then each extra id (forks and self-signed builds), deduplicated. */
export function recorderExtensionIds(options?: {
  extra?: readonly string[];
}): string[] {
  return [
    ...new Set([
      RECORDER_EXTENSION_ID,
      ...Object.values(RECORDER_STORE_IDS),
      ...(options?.extra ?? []),
    ]),
  ];
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/?$/;

/**
 * `chrome-extension://<id>` with or without the trailing slash, for an id in `ids`. Edge's native messaging page shows
 * its `allowed_origins` in the `chrome-extension://<id>/` form:
 * https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging
 */
export function extensionIdFromOrigin(
  origin: string | null | undefined,
  ids: readonly string[],
): string | null {
  const match = origin ? EXTENSION_ORIGIN.exec(origin) : null;
  return match && ids.includes(match[1]) ? match[1] : null;
}
