// The calls a page makes about itself rather than for the person: analytics, telemetry, ads, error reports and real-user
// monitoring, and CopilotKit's own capture of the page. A recording never keeps one, even when it starts right after a click,
// because a Bot doing the task through the site's API never needs it. Matched by host, then by path, then by a body only
// such a call sends; each list stays narrow so a real API call is never caught.

/** Hosts (and their subdomains) that only ever receive analytics, ads, error reports or monitoring. */
const TELEMETRY_HOSTS = [
  // Analytics and tag managers
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "app-measurement.com",
  "segment.io",
  "api.segment.io",
  "cdn.segment.com",
  "api-js.mixpanel.com",
  "api.mixpanel.com",
  "api.amplitude.com",
  "api2.amplitude.com",
  "api.eu.amplitude.com",
  "sr-client-cfg.amplitude.com",
  "i.posthog.com",
  "heapanalytics.com",
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
  "rs.fullstory.com",
  "edge.fullstory.com",
  "mouseflow.com",
  "plausible.io",
  "usefathom.com",
  "mc.yandex.ru",
  "mc.yandex.com",
  "cloudflareinsights.com",
  "chartbeat.net",
  "parsely.com",
  "quantserve.com",
  "scorecardresearch.com",
  "tealiumiq.com",
  "omtrdc.net",
  "demdex.net",
  "2o7.net",
  "data.pendo.io",
  "app.pendo.io",
  "esp.aptrinsic.com",
  "logx.optimizely.com",
  "events.launchdarkly.com",
  "events.split.io",
  "featuregates.org",
  "prodregistryv2.org",
  "track.hubspot.com",
  "hscollectedforms.net",
  "browser.events.data.microsoft.com",
  "dc.services.visualstudio.com",
  "js.monitor.azure.com",
  "applicationinsights.azure.com",
  // Ads and conversion pixels
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "connect.facebook.net",
  "ads.linkedin.com",
  "snap.licdn.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "analytics.twitter.com",
  "static.ads-twitter.com",
  "ct.pinterest.com",
  "alb.reddit.com",
  "adnxs.com",
  "adsrvr.org",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "rubiconproject.com",
  "pubmatic.com",
  "casalemedia.com",
  "everesttech.net",
  "m.stripe.com",
  "m.stripe.network",
  "r.stripe.com",
  "q.stripe.com",
  // Error reports and real-user monitoring
  "sentry.io",
  "sentry-cdn.com",
  "nr-data.net",
  "js-agent.newrelic.com",
  "bugsnag.com",
  "api.rollbar.com",
  "trackjs.com",
  "raygun.io",
  "lr-ingest.io",
  "lr-ingest.com",
  "lr-in.com",
  "lr-in-prod.com",
  "go-mpulse.net",
  "akstat.io",
  "lux.speedcurve.com",
  "eum-appdynamics.com",
];

/** A host whose first label says what it is for: `metrics-fe-na1.`, `exceptions-na2.`, `px.ads.`, `browser-intake-`. */
const TELEMETRY_LABEL =
  /^(?:analytics|telemetry|metrics|tracking|tracker|beacons?|pixel|px|rum|collector|exceptions|sentry|capig)(?:-|$)|^browser-intake-/;

/** Paths that only ever take telemetry, whatever the host. */
const TELEMETRY_PATHS = [
  // Google Analytics (`/collect`, `/g/collect`, `/j/collect`) on any host it is proxied through, and Matomo
  /^(?:\/[gjr])?\/collect\/?$/,
  /\/(?:matomo|piwik)\.php$/,
  // Meta's pixel and the bare beacons of fraud and bot scripts
  /^\/(?:tr|mon|beacon|pixel|ping|track|t\.gif)\/?$/,
  // OpenTelemetry's export paths
  /\/v1\/(?:traces|metrics|logs)\/?$/,
  // CopilotKit's own capture asking its runtime for a capture pass (the REST route; the single route is known by its body)
  /\/trajectory\/[^/]+\/connect\/?$/,
  // Sentry's ingest, Elastic's RUM intake, Vercel and Cloudflare insights
  /\/api\/\d+\/(?:envelope|store|security|minidump)\/?$/,
  /\/intake\/v2\/rum\//,
  /^\/_vercel\/(?:insights|speed-insights)\//,
  /^\/cdn-cgi\/(?:rum|challenge-platform)\b/,
  // Words a real API path never carries
  /(?:^|[/._-])(?:telemetry|observability|beacons?|heartbeat|keepalive)(?:[/._-]|$)/,
  /(?:^|\/)(?:rum|pixel|pixels)(?:\/|$)/,
  /session[-_]?replay/,
  /(?:^|[/_-])(?:usage|client|action|system|event|page)[-_](?:logs?|logging)(?:[/_-]|$)/,
  /(?:^|\/)log[-_]?events?(?:\/|$)/,
  // A versioned tracking API (`/nudge/tracking/v1/...`), never a parcel's `/orders/42/tracking`
  /\/tracking\/v\d+\//,
];

/** A body that is an error report: Sentry's envelope, sent to a tunnel route on the page's own host. */
const ERROR_ENVELOPE = /^\{[^\n]*"(?:dsn|sent_at)"\s*:/;

/** The keys of CopilotKit's capture batch (`@copilotkit/learning` LearningBatch): `{ trajectoryId, learningContainerIds?,
 * events, dropped }`, and nothing else. */
const BATCH_KEYS: ReadonlySet<string> = new Set([
  "trajectoryId",
  "learningContainerIds",
  "events",
  "dropped",
]);
/** The start of a capture batch as `httpSink` writes it (`JSON.stringify` of the batch the collector builds, in that key
 * order), for a body cut short: its trajectory, its containers when it has any, then its first event or none. */
const BATCH_START =
  /^\s*\{"trajectoryId":"(?:[^"\\]|\\.)*"(?:,"learningContainerIds":\[[^\]]*\])?,"events":\[(?:\]|\{"type":"CUSTOM",)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One captured event of a batch (`LearningEvent`): an AG-UI CUSTOM event with its name, value and time. */
const isLearningEvent = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "CUSTOM" &&
  typeof value.name === "string" &&
  typeof value.timestamp === "number";

/** CopilotKit's own capture of the page (`@copilotkit/learning`'s collector, sent by its `httpSink` to whatever route the
 * app chose): the page reporting on itself, and another copy of what the recording captures, never a person's save. Known
 * by its shape, since the route is the app's. */
export function isLearningBatch(body: string): boolean {
  if (!body.includes('"trajectoryId"')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return BATCH_START.test(body);
  }
  if (!isRecord(parsed)) return false;
  const { trajectoryId, learningContainerIds, events, dropped } = parsed;
  return (
    Object.keys(parsed).every((key) => BATCH_KEYS.has(key)) &&
    typeof trajectoryId === "string" &&
    typeof dropped === "number" &&
    Array.isArray(events) &&
    events.every(isLearningEvent) &&
    (learningContainerIds === undefined ||
      (Array.isArray(learningContainerIds) &&
        learningContainerIds.every((id) => typeof id === "string")))
  );
}

const onHost = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

/** CopilotKit's own capture asking a single-route runtime for its capture pass (`@copilotkit/core`'s TrajectoryConnection):
 * the page setting up its report on itself. */
function isCapturePassRequest(body: string): boolean {
  if (!body.includes('"trajectory/connect"')) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.method === "trajectory/connect";
  } catch {
    return false;
  }
}

/** True for a call that only reports on the page (analytics, ads, errors, monitoring, CopilotKit's own capture), never one
 * doing the task. */
export function isTelemetry(url: string, body?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (TELEMETRY_HOSTS.some((suffix) => onHost(host, suffix))) return true;
  if (TELEMETRY_LABEL.test(host.split(".")[0] ?? "")) return true;
  const path = parsed.pathname.toLowerCase();
  if (TELEMETRY_PATHS.some((pattern) => pattern.test(path))) return true;
  return (
    body !== undefined &&
    (ERROR_ENVELOPE.test(body.slice(0, 2_048)) ||
      isLearningBatch(body) ||
      isCapturePassRequest(body))
  );
}

/** The request headers a page or the browser sets on a speculative fetch: a prefetch is the page's guess, not the person's. */
export function isPrefetch(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "next-router-prefetch") return true;
    if (
      (key === "purpose" || key === "sec-purpose" || key === "x-moz") &&
      /prefetch|prerender/i.test(value)
    )
      return true;
    if (key === "x-purpose" && /preview/i.test(value)) return true;
  }
  return false;
}
