/**
 * Which OpenBot app is asking, and whether it and the OpenBot it talks to can work together.
 *
 * Every app sends `OpenBot-Client: <kind>/<version>` on every request, so the server knows who is
 * asking. Every server says on its `deployment` which API versions it serves and the oldest release
 * of each app it still serves. When the two don't fit, the person reads one sentence: "Update
 * OpenBot" when the app is too old, "Ask whoever runs your OpenBot to update it" when the server is.
 *
 * The web app, the Recorder and the server read this file. OpenBot Desktop (Rust) and the phone app
 * carry the same few rules in their own code; their tests hold them to the cases in
 * `shared/fixtures/client-version/`.
 */
import { version as RELEASE_VERSION } from "../package.json";
import policy from "../release-policy.json";

/** The request header an app names itself in. */
export const CLIENT_HEADER = "OpenBot-Client";

/** The apps that name themselves. A program of someone's own sends nothing, or its own name. */
export const CLIENT_KINDS = ["web", "desktop", "mobile", "recorder"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The OpenBot release this code is: the version every app built from it reports. */
export const RELEASE = RELEASE_VERSION;

/** The API versions this release serves, and the ones its apps speak. */
export const API_VERSIONS: readonly string[] = ["v2"];

/**
 * The oldest release of each app this release's server still serves, built in. An older one is
 * refused with CLIENT_UPDATE_REQUIRED. A server serves every app released in the last 12 months
 * (API versioning design, section 6.3), so a release may set an app's built-in minimum only to a
 * release published more than 12 months before it. Until such a release exists there is none, and
 * every app is served. An admin of a server, such as OpenBot Cloud's, raises it for that server
 * with the server's OPENBOT_MINIMUM_CLIENTS. An app from before this check sends no header and is
 * never refused by it.
 */
export const MINIMUM_CLIENTS: Readonly<Partial<Record<ClientKind, string>>> =
  {};

/** The first release of each app that calls /api/v2: nothing in 1.0.3 or before does. */
export const FIRST_ONE_API_RELEASES: Readonly<Record<ClientKind, string>> = {
  web: "1.1.0",
  desktop: "1.1.0",
  mobile: "1.1.0",
  recorder: "1.1.0",
};

/** The contract numbers `release-policy.json` keeps, which `deployment` publishes. */
export const LAUNCHER_API: number = policy.compatibility.launcherApi;
export const EXTENSION_API: number = policy.compatibility.extensionApi;

/** What a person reads when the app is older than the OpenBot it talks to serves. */
export const APP_UPDATE_SENTENCE = "Update OpenBot";
/**
 * What a person reads, in place of "Update OpenBot", when the minimum the app is below was raised
 * because of a security problem in older releases.
 */
export const SECURITY_UPDATE_SENTENCE =
  "This version of OpenBot has a security problem. Update to keep using it.";
/** What a person reads when the OpenBot is older than the app can use. */
export const SERVER_UPDATE_SENTENCE =
  "Ask whoever runs your OpenBot to update it";

/** The problem code a server answers an app below its minimum with. */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

/** One app named in the header. */
export type NamedClient = { kind: ClientKind; version: string };

/** `<kind>/<version>`, as an app sends it. */
export function clientToken(kind: ClientKind, version: string = RELEASE) {
  return `${kind}/${version}`;
}

/**
 * The OpenBot apps a header names, each with the version as written. The one reading of the header:
 * a list of `<kind>/<version>` separated by spaces, like a User-Agent (OpenBot Desktop adds its own
 * to the one its window's page sent), at most eight read. A token whose kind is not an OpenBot app is
 * not read; the version is left as written, for the caller to judge.
 */
export function clientTokens(
  value: string | null | undefined,
): { kind: ClientKind; written: string }[] {
  if (!value?.trim()) return [];
  const tokens: { kind: ClientKind; written: string }[] = [];
  for (const token of value.trim().split(/\s+/).slice(0, 8)) {
    const slash = token.indexOf("/");
    if (slash < 1) continue;
    const kind = token.slice(0, slash).toLowerCase();
    if (!(CLIENT_KINDS as readonly string[]).includes(kind)) continue;
    tokens.push({ kind: kind as ClientKind, written: token.slice(slash + 1) });
  }
  return tokens;
}

/**
 * The apps a header names with a release number, which is what a minimum is held against
 * ({@link clientTokens}). One whose version is not a release is not read.
 */
export function parseClientHeader(
  value: string | null | undefined,
): NamedClient[] {
  return clientTokens(value)
    .filter(({ written }) => isVersion(written))
    .map(({ kind, written }) => ({ kind, version: written }));
}

const VERSION =
  /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/;

/** Whether `value` is a release number: `1.2.0`, `1.2.0-rc.1`, with or without a leading v. */
export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/**
 * Release order, by semantic versioning's rules (semver.org, section 11): numbers first, and a
 * pre-release (`1.2.0-rc.1`) before its release. Undefined when either is not a release number.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const [leftPre, rightPre] = [left[4], right[4]];
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const l = leftParts[i];
    const r = rightParts[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) {
      if (ln !== rn) return Math.sign(ln - rn);
    } else if (ln !== undefined) return -1;
    else if (rn !== undefined) return 1;
    else if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The app among `named` that the server's minimums refuse, with the minimum it is below, or
 * undefined when every one may go on.
 */
export function belowMinimum(
  named: readonly NamedClient[],
  minimums: Readonly<Partial<Record<ClientKind, string>>>,
): (NamedClient & { minimum: string }) | undefined {
  for (const client of named) {
    const minimum = minimums[client.kind];
    if (!minimum) continue;
    const order = compareVersions(client.version, minimum);
    if (order !== undefined && order < 0) return { ...client, minimum };
  }
  return undefined;
}

/**
 * The sentence a server refuses an app below its minimum with, as the problem's detail: what
 * happened, then what to do (`.claude/skills/openbot-copy`). When the minimum was raised because of
 * a security problem in older releases (`security`), that is what it says.
 */
export function clientUpdateDetail(
  kind: ClientKind,
  minimum: string,
  security?: boolean,
): string {
  if (security) return SECURITY_UPDATE_SENTENCE;
  const version = minimum.replace(/^v/, "");
  switch (kind) {
    case "web":
      return "This page is from an older version of OpenBot. Update OpenBot to keep going.";
    case "desktop":
      return `This OpenBot needs OpenBot Desktop ${version} or later. Update OpenBot, then try again.`;
    case "mobile":
      return `This OpenBot needs the OpenBot phone app ${version} or later. Update OpenBot, then try again.`;
    case "recorder":
      return `This OpenBot needs the OpenBot Recorder ${version} or later. Update OpenBot, then try again.`;
  }
}

/** The major of an API version, `v2` as 2. */
function major(version: string): number | undefined {
  const match = /^v(\d{1,4})$/.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether an app and the OpenBot it talks to can work together, from that OpenBot's `deployment`.
 *
 * - `ok`: they can. Features the server lacks are hidden by the fields that offer them, never by a
 *   version.
 * - `app`: the app is too old. The server serves no API version the app speaks and only newer ones,
 *   or it names a minimum for this app above the app's version. "Update OpenBot". `security` when
 *   the server also names that app in `securityMinimumClients` above the app's version: the minimum
 *   is there for a security problem, and the person reads SECURITY_UPDATE_SENTENCE instead.
 * - `server`: the server is too old. It serves only API versions older than any the app speaks.
 *   "Ask whoever runs your OpenBot to update it".
 *
 * A `deployment` that publishes no `api` is from a release before this check, and every such
 * release that answers `deployment` serves v2.
 */
export type Compatibility =
  | { fit: "ok" }
  | { fit: "app"; minimum?: string; security?: true }
  | { fit: "server" };

export function compatibility(
  deployment: {
    api?: unknown;
    minimumClients?: unknown;
    securityMinimumClients?: unknown;
  },
  client: { kind: ClientKind; version: string; speaks?: readonly string[] },
): Compatibility {
  const speaks = client.speaks ?? API_VERSIONS;
  const served = Array.isArray(deployment.api)
    ? deployment.api.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : ["v2"];
  if (!served.some((version) => speaks.includes(version))) {
    const newestServed = Math.max(
      ...served.map(major).filter((n): n is number => n !== undefined),
    );
    const newestSpoken = Math.max(
      ...speaks.map(major).filter((n): n is number => n !== undefined),
    );
    // Only newer versions than any the app speaks: the app is behind. Otherwise the server is.
    return newestServed > newestSpoken ? { fit: "app" } : { fit: "server" };
  }
  const minimum = minimumFor(deployment.minimumClients, client.kind);
  if (minimum && below(client.version, minimum)) {
    const floor = minimumFor(deployment.securityMinimumClients, client.kind);
    return floor && below(client.version, floor)
      ? { fit: "app", minimum, security: true }
      : { fit: "app", minimum };
  }
  return { fit: "ok" };
}

/** The release `minimums` names for `kind`, when it names one. */
function minimumFor(minimums: unknown, kind: ClientKind): string | undefined {
  if (!minimums || typeof minimums !== "object") return undefined;
  const minimum = (minimums as Record<string, unknown>)[kind];
  return isVersion(minimum) ? minimum : undefined;
}

/** Whether `version` is a release before `minimum`. */
function below(version: string, minimum: string): boolean {
  const order = compareVersions(version, minimum);
  return order !== undefined && order < 0;
}
