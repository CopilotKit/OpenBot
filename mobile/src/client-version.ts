/**
 * Whether OpenBot Mobile and the OpenBot it talks to can work together, and the header it names itself in.
 *
 * OpenBot Mobile is bundled on its own (Metro serves only mobile/), so it carries its own copy of the few rules in
 * shared/client-version.ts. tests/client-version.test.ts holds this copy to every case in
 * shared/fixtures/client-version/cases.json, the same cases the web app, the Recorder and OpenBot Desktop run. It
 * imports nothing, so it can be tested without a phone.
 */

/** The request header an app names itself in: `OpenBot-Client: mobile/<release>`. */
export const CLIENT_HEADER = "OpenBot-Client";

/** The problem code an OpenBot answers an app below its minimum with. */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

/** The API versions this app speaks. */
export const API_VERSIONS: readonly string[] = ["v2"];

/** What a person reads when the app is older than the OpenBot it talks to serves. */
export const APP_UPDATE_SENTENCE = "Update OpenBot";
/** What a person reads in its place when the minimum the app is below was raised for a security problem. */
export const SECURITY_UPDATE_SENTENCE =
  "This version of OpenBot has a security problem. Update to keep using it.";

/** The apps that name themselves, as the server's minimums list them. */
type ClientKind = "web" | "desktop" | "mobile" | "recorder";

const VERSION =
  /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/;

/** Whether `value` is a release number: `1.2.0`, `1.2.0-rc.1`, with or without a leading v. */
export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** `<kind>/<version>`, as an app sends it. */
export function clientToken(kind: ClientKind, version: string) {
  return `${kind}/${version}`;
}

/**
 * Release order, by semantic versioning's rules (semver.org, section 11): numbers first, and a pre-release
 * (`1.2.0-rc.1`) before its release. Undefined when either is not a release number.
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

/** The major of an API version, `v2` as 2. */
function major(version: string): number | undefined {
  const match = /^v(\d{1,4})$/.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * - `ok`: they can. Features the server lacks are hidden by the fields that offer them, never by a version.
 * - `app`: the app is too old. "Update OpenBot". `security` when the minimum it is below was raised for a security
 *   problem in older releases (the server names the app in `securityMinimumClients` above its version too).
 * - `server`: the server serves only API versions older than any the app speaks. OpenBot Mobile adds nothing for it:
 *   whoever runs that OpenBot keeps it and their apps matched, and the screens say what failed, as they always have.
 */
export type Compatibility =
  | { fit: "ok" }
  | { fit: "app"; minimum?: string; security?: true }
  | { fit: "server" };

/**
 * Whether an app and the OpenBot it talks to can work together, from that OpenBot's `deployment`. A `deployment` that
 * publishes no `api` is from a release before this check, and every such release serves v2.
 */
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

/**
 * What the update screen says under "Update OpenBot": OpenBot's own sentence for refusing this app (as
 * shared/client-version.ts `clientUpdateDetail` words it for OpenBot Mobile), with the release it needs when known, or
 * the security sentence when the minimum was raised for a security problem.
 */
export function phoneUpdateDetail(
  minimum?: string,
  security?: boolean,
): string {
  if (security) return SECURITY_UPDATE_SENTENCE;
  return isVersion(minimum)
    ? `This OpenBot needs OpenBot Mobile ${minimum.replace(/^v/, "")} or later. Update OpenBot, then try again.`
    : "This OpenBot needs a newer version of OpenBot Mobile. Update OpenBot, then try again.";
}

/** What the root layout shows: the app, or "Update OpenBot" (`security` when it is for a security problem). */
export type VersionVerdict =
  | { kind: "ok" }
  | { kind: "app"; detail: string; security?: true };

/**
 * Anything that learns OpenBot refused this app as too old (a request's CLIENT_UPDATE_REQUIRED) says so here, and the
 * root layout, which listens, shows the update screen in place of whatever was open.
 */
type UpdateRequired = (detail: string, security: boolean) => void;
const listeners = new Set<UpdateRequired>();
export function reportUpdateRequired(detail: string, security = false): void {
  for (const listener of listeners) listener(detail, security);
}
export function onUpdateRequired(listener: UpdateRequired): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
