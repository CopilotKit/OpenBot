type BrandedNavigator = Navigator & {
  userAgentData?: { brands?: { brand: string }[]; platform?: string };
};

/** The longest name OpenBot keeps for a connected browser (`exchangeRequestSchema`'s label). */
const NAME_MAX = 80;

/**
 * "<browser> on <platform>", from the user agent's client hints when the browser gives them: the name a browser is
 * connected under until the person changes it in OpenBot. The connect page offers it, and a connection OpenBot Desktop
 * makes with no page takes it as it is. Pages and the service worker alike have the client hints
 * (WorkerNavigator.userAgentData, Chrome and Edge 90 on).
 *
 * The brand comes first and is the browser's own ("Google Chrome", "Microsoft Edge"): OpenBot tells which of the
 * person's own browsers holds the Recorder by it, so Edge is named Edge even where the client hints are missing (its
 * user agent says `Edg/`, as the setup page reads it).
 */
export function defaultBrowserName(): string {
  const data = (navigator as BrandedNavigator).userAgentData;
  const hinted = data?.brands
    ?.map((entry) => entry.brand)
    .find((name) => name !== "Chromium" && !name.startsWith("Not"));
  const brand =
    hinted ??
    (!data && /\bEdg\//.test(navigator.userAgent) ? "Microsoft Edge" : null);
  const platform = data?.platform || navigator.platform || "this computer";
  return `${brand ?? "Chrome"} on ${platform}`.slice(0, NAME_MAX);
}
