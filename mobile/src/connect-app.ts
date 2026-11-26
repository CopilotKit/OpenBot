/**
 * Connecting the person's own account at an app from the phone, and reading where their apps stand.
 *
 * Connecting is `connectApp` with `returnTo: "mobile"`, which the server offers only where `getDeployment` says
 * `mobileConnections`. Its answer says what happens next: `connected` is done; `form` asks for the boxes an app that
 * takes a key needs, sent back to the same operation as `values`; `consent` hands an address of the app's own sign-in
 * page. The phone opens that in the system browser's sign-in session (never a web view), and the app's page sends the
 * browser back to {@link RETURN_ADDRESS}: `?appId=<id>` once it went through, `?error=failed` (with `&appId=<id>` when
 * known) when it didn't. Coming back proves nothing by itself, so the app asks with `confirmConnection` and believes only that.
 *
 * Imports nothing that needs a phone: the steps that do are given to it, so it can be tested.
 */
import type {
  App,
  AppSetup,
  Connection,
  ConnectionField,
  ConnectionKeyGuide,
  ConnectionStart,
  DisconnectPreview,
} from "./api/generated/model";

/**
 * Where an app's sign-in page sends the browser back to. The system browser's sign-in session ends there and the app is
 * back in front; outside the session (Android brought back from its icon, a cold start) the app opens at
 * app/connections/returned.tsx.
 */
export const RETURN_ADDRESS = "openbotmobile://connections/returned";

/** Whether this OpenBot lets the phone connect an app: only where its `deployment` says so, never by its version. */
export function phoneConnects(
  deployment: { mobileConnections?: unknown } | undefined,
): boolean {
  return deployment?.mobileConnections === true;
}

/** What the address the browser came back to says: which app, and the server's code when it didn't go through. */
export type Returned = { appId?: string; error?: string };

/**
 * The address the browser came back to, or null when it isn't {@link RETURN_ADDRESS}. Only the two parameters the
 * server sends are read, and neither is ever shown: an error code becomes one of the app's own sentences.
 */
export function readReturn(returned: string): Returned | null {
  let url: URL;
  try {
    url = new URL(returned);
  } catch {
    return null;
  }
  const expected = new URL(RETURN_ADDRESS);
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    url.pathname.replace(/\/$/, "") !== expected.pathname
  )
    return null;
  return fromParams({
    appId: url.searchParams.get("appId"),
    error: url.searchParams.get("error"),
  });
}

/** The same two, as a route's parameters hand them over (app/connections/returned.tsx). */
export function fromParams(params: {
  appId?: unknown;
  error?: unknown;
}): Returned {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const appId = text(params.appId);
  const error = text(params.error);
  return { ...(appId ? { appId } : {}), ...(error ? { error } : {}) };
}

/**
 * The sentence for a code the server sent back. It sends `failed`, and any code reads as that: the code comes from an
 * address anybody can write, so it is never shown.
 */
export function returnSentence(_error: string): string {
  return "Couldn't connect that account. Nothing was saved. Try again.";
}

/** What expo-web-browser's `openAuthSessionAsync` resolves to, as far as connecting reads it. */
export type BrowserResult = { type: string; url?: string };

export type ConnectSteps = {
  /** connectApp for the person, with the body given. */
  start: (
    appId: string,
    body: {
      returnTo: "mobile";
      anotherAccount?: true;
      values?: Record<string, string>;
    },
  ) => Promise<ConnectionStart>;
  /** Open an address in the system browser's sign-in session; resolves when it comes back or is closed. */
  open: (url: string, returnTo: string) => Promise<BrowserResult>;
  /** confirmConnection for the person: whether the app says the account is connected. */
  confirm: (appId: string) => Promise<{ connected: boolean }>;
};

/** How one press of Connect ended. */
export type ConnectOutcome =
  /** The account is connected, as the app says. */
  | { kind: "connected" }
  /** The app takes a key: these boxes, filled in and sent back with {@link connectAccount}'s `values`. */
  | {
      kind: "form";
      fields: ConnectionField[];
      guide: ConnectionKeyGuide | null;
    }
  /** The person closed the browser, and nothing was connected. Nothing to say. */
  | { kind: "cancelled" }
  /** Something to tell the person, in the app's own words. */
  | { kind: "failed"; message: string };

/** The sentence for a sign-in the app didn't confirm. */
export const NOT_CONFIRMED =
  "The app didn't confirm the connection. Nothing was saved. Try again.";

/** The sentence for an answer this build doesn't know how to follow. */
export const NOT_HERE =
  "This app can't be connected from OpenBot Mobile yet. Connect it in OpenBot on your computer.";

/**
 * One press of Connect (or Reconnect, or Connect another account, or sending a key form), to its end.
 *
 * After the browser, the app is asked whether the account is connected, whatever the browser said, unless the address
 * it came back to says it failed: on Android the deep link back can end the session as dismissed even when the
 * sign-in went through, and confirming is safe to repeat.
 */
export async function connectAccount(
  appId: string,
  request: { anotherAccount?: boolean; values?: Record<string, string> },
  steps: ConnectSteps,
): Promise<ConnectOutcome> {
  const started = await steps.start(appId, {
    returnTo: "mobile",
    ...(request.anotherAccount ? { anotherAccount: true as const } : {}),
    ...(request.values ? { values: request.values } : {}),
  });
  if (started.next === "connected") return { kind: "connected" };
  if (started.next === "form")
    return {
      kind: "form",
      fields: Array.isArray(started.fields) ? started.fields : [],
      guide: started.guide ?? null,
    };
  if (
    started.next !== "consent" ||
    typeof started.authorizationUrl !== "string"
  )
    return { kind: "failed", message: NOT_HERE };
  const result = await steps.open(started.authorizationUrl, RETURN_ADDRESS);
  const returned =
    result.type === "success" && result.url ? readReturn(result.url) : null;
  if (returned?.error)
    return { kind: "failed", message: returnSentence(returned.error) };
  const { connected } = await steps.confirm(appId);
  if (connected) return { kind: "connected" };
  return returned
    ? { kind: "failed", message: NOT_CONFIRMED }
    : { kind: "cancelled" };
}

/** What the person typed into a key form, as `values`, or the boxes still to fill in. */
export function formValues(
  fields: readonly ConnectionField[],
  typed: Readonly<Record<string, string>>,
): { values: Record<string, string> } | { missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = (typed[field.name] ?? "").trim();
    if (value) values[field.name] = value;
    else if (field.required) missing.push(field.label);
  }
  return missing.length ? { missing } : { values };
}

/** A key form's boxes as they start: each with what the app says it starts with. */
export function startingValues(
  fields: readonly ConnectionField[],
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.name, field.default ?? ""]),
  );
}

/** The sentence for a form sent with boxes left empty. */
export function missingSentence(missing: readonly string[]): string {
  return missing.length === 1
    ? `Fill in ${missing[0]}.`
    : `Fill in ${joinNames(missing)}.`;
}

/**
 * Whether one of the person's connections needs connecting again: access the app withdrew, or a key whose last check
 * made a call and failed. The web app's rule (`needsReconnecting`), read off the API's fields.
 */
export function needsReconnecting(
  connection: Pick<Connection, "revoked" | "check">,
): boolean {
  return (
    connection.revoked === true ||
    (Boolean(connection.check?.checkedAction) &&
      connection.check?.verified === false)
  );
}

/**
 * Where one of the person's apps stands: their own account connected, to reconnect, or not yet; the organization's
 * shared account, which they don't connect; or on with no account at all.
 */
export type AppStanding =
  | "connected"
  | "reconnect"
  | "not_connected"
  | "shared"
  | "on";

/** One of the person's apps, as Connections lists it. */
export type YourApp = {
  id: string;
  title: string;
  /** How the person connects their account: with a key, or by signing in. Null where there is nothing to connect. */
  connect: "key" | "sign-in" | null;
  standing: AppStanding;
};

/** An app as listApps answers it, as far as Connections reads it. */
export type ListedApp = Pick<
  App,
  | "id"
  | "title"
  | "source"
  | "connectsWith"
  | "accountMode"
  | "sharedOnly"
  | "signIn"
>;

/** A catalogue entry (listAppDirectory with source catalogue), as far as Connections reads it. */
export type CatalogueEntry = { id: string; source: string; auth?: string };

/** The catalogue's entry ids are `catalogue:<key>`, and the key is the id of the app it is added as. */
const catalogueKey = (entryId: string) => entryId.replace(/^catalogue:/, "");

/**
 * The rows of Connections, by the web app's rules (app/src/lib/connections/rows.ts and lib/plugins/listed.ts), from
 * the apps added here (listApps), OpenBot's catalogue (listAppDirectory), how apps are set up (getAppSetup) and the
 * person's connections (listConnections):
 *
 * - a catalogue app each person signs in to (`user-oauth`), once it is added;
 * - an app from the directory that runs on each person's own account: not one that needs no account, and not one
 *   that only holds the organization's shared account;
 * - an app from the directory on the organization's shared account, which the person reads and doesn't connect;
 * - a server added by its address: one that signs each person in is connected like any app, and one that doesn't is
 *   on with no account.
 *
 * None from a Composio directory that isn't set up here. What is in use comes first, each half in that order.
 */
export function yourApps(input: {
  apps: readonly ListedApp[];
  catalogue: readonly CatalogueEntry[];
  setup: Pick<AppSetup, "directoryAvailable" | "directoryProvider">;
  connections: readonly Pick<Connection, "appId" | "revoked" | "check">[];
}): YourApp[] {
  const held = new Map(input.connections.map((each) => [each.appId, each]));
  const standing = (id: string): AppStanding => {
    const connection = held.get(id);
    if (!connection) return "not_connected";
    return needsReconnecting(connection) ? "reconnect" : "connected";
  };
  const apps =
    input.setup.directoryAvailable ||
    input.setup.directoryProvider !== "composio"
      ? input.apps
      : input.apps.filter((app) => app.source !== "directory");
  const added = new Map(apps.map((app) => [app.id, app]));
  const rows: YourApp[] = [];
  for (const entry of input.catalogue) {
    if (entry.source !== "catalogue" || entry.auth !== "user-oauth") continue;
    const app = added.get(catalogueKey(entry.id));
    if (!app) continue;
    rows.push({
      id: app.id,
      title: app.title,
      connect: "sign-in",
      standing: standing(app.id),
    });
  }
  for (const app of apps) {
    if (app.source !== "directory") continue;
    if (app.accountMode === "shared")
      rows.push({
        id: app.id,
        title: app.title,
        connect: null,
        standing: "shared",
      });
    else if (app.connectsWith !== "nothing" && !app.sharedOnly)
      rows.push({
        id: app.id,
        title: app.title,
        connect: app.connectsWith === "key" ? "key" : "sign-in",
        standing: standing(app.id),
      });
  }
  for (const app of apps) {
    if (app.source !== "address") continue;
    rows.push(
      app.signIn
        ? {
            id: app.id,
            title: app.title,
            connect: "sign-in",
            standing: standing(app.id),
          }
        : { id: app.id, title: app.title, connect: null, standing: "on" },
    );
  }
  const inUse = (row: YourApp) => row.standing !== "not_connected";
  return [...rows.filter(inUse), ...rows.filter((row) => !inUse(row))];
}

/** What disconnecting would also end, as the web app says it, or null when nothing. */
export function disconnectWarning(
  preview: Partial<DisconnectPreview> | undefined,
): string | null {
  const siblings = Array.isArray(preview?.alsoEnds) ? preview.alsoEnds : [];
  const unanswered =
    typeof preview?.uncheckedCount === "number" && preview.uncheckedCount > 0
      ? preview.uncheckedCount
      : 0;
  const parts: string[] = [];
  if (siblings.length > 0)
    parts.push(
      `Disconnecting also ends your access to ${joinNames(siblings)}, which ${siblings.length === 1 ? "shares" : "share"} this connection.`,
    );
  if (unanswered > 0)
    parts.push(
      siblings.length > 0
        ? `${unanswered} other ${unanswered === 1 ? "app" : "apps"} couldn't be checked and may be affected too.`
        : `${unanswered} ${unanswered === 1 ? "app" : "apps"} on this connection couldn't be checked, so disconnecting may end ${unanswered === 1 ? "it" : "them"} too.`,
    );
  return parts.length > 0 ? parts.join(" ") : null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/*
 * The return address can open the app outside the browser's session too: its screen says so here, and the app's
 * screen, if it is open, asks the app again.
 */
/** A screen that hears it answers whether it was for that screen. */
type Listener = (returned: Returned) => boolean;
const listeners = new Set<Listener>();

/**
 * The browser came back from an app's sign-in page, outside the sign-in session. Answers whether a screen heard it:
 * when none did, the landing opens the app's screen itself.
 */
export function reportConnectionReturned(returned: Returned): boolean {
  let heard = false;
  for (const listener of [...listeners]) if (listener(returned)) heard = true;
  return heard;
}

/** Hear each time it happens. Returns how to stop hearing. */
export function onConnectionReturned(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
