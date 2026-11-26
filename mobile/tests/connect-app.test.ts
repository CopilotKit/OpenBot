/**
 * Connecting an app from the phone (src/connect-app.ts): the steps one press of Connect takes, how the address an
 * app's sign-in page sends the browser back to is read, the key form's values, and which apps Connections lists. The
 * steps that need a phone (the API and the system browser) are given to it here.
 */
import { expect, test } from "bun:test";
import type {
  Connection,
  ConnectionField,
  ConnectionStart,
} from "../src/api/generated/model";
import {
  type BrowserResult,
  type ConnectSteps,
  connectAccount,
  disconnectWarning,
  formValues,
  fromParams,
  type ListedApp,
  NOT_CONFIRMED,
  NOT_HERE,
  needsReconnecting,
  onConnectionReturned,
  phoneConnects,
  RETURN_ADDRESS,
  readReturn,
  reportConnectionReturned,
  returnSentence,
  startingValues,
  yourApps,
} from "../src/connect-app";

/** Steps that answer as given, and record what was asked of them. */
function steps(answers: {
  start: ConnectionStart;
  browser?: BrowserResult;
  connected?: boolean;
}) {
  const asked: string[] = [];
  const bodies: unknown[] = [];
  const given: ConnectSteps = {
    start: async (appId, body) => {
      asked.push(`start ${appId}`);
      bodies.push(body);
      return answers.start;
    },
    open: async (url, returnTo) => {
      asked.push(`open ${url} -> ${returnTo}`);
      return answers.browser ?? { type: "cancel" };
    },
    confirm: async (appId) => {
      asked.push(`confirm ${appId}`);
      return { connected: answers.connected ?? false };
    },
  };
  return { given, asked, bodies };
}

const CONSENT: ConnectionStart = {
  next: "consent",
  authorizationUrl: "https://accounts.example.com/consent?ticket=1",
};

test("connecting always asks to come back to the phone, with a second account or a key only when given", async () => {
  const run = steps({
    start: { next: "connected", verified: null, checkedAction: null },
  });
  await connectAccount("gmail", {}, run.given);
  await connectAccount("gmail", { anotherAccount: true }, run.given);
  await connectAccount("linear", { values: { api_key: "lin_1" } }, run.given);
  expect(run.bodies).toEqual([
    { returnTo: "mobile" },
    { returnTo: "mobile", anotherAccount: true },
    { returnTo: "mobile", values: { api_key: "lin_1" } },
  ]);
});

test("an account already connected is done, with nothing opened or confirmed", async () => {
  const run = steps({
    start: { next: "connected", verified: true, checkedAction: "list" },
  });
  expect(await connectAccount("gmail", {}, run.given)).toEqual({
    kind: "connected",
  });
  expect(run.asked).toEqual(["start gmail"]);
});

test("an app that takes a key hands back its boxes and its guide", async () => {
  const field: ConnectionField = {
    name: "api_key",
    label: "API key",
    help: "From Settings, then API.",
    required: true,
    secret: true,
    default: null,
  };
  const guide = {
    steps: "Open Settings, then API.",
    url: "https://linear.app/settings/api",
  };
  const run = steps({ start: { next: "form", fields: [field], guide } });
  expect(await connectAccount("linear", {}, run.given)).toEqual({
    kind: "form",
    fields: [field],
    guide,
  });
  expect(run.asked).toEqual(["start linear"]);
});

test("a sign-in page is opened in the browser's session, and the app is asked when it comes back", async () => {
  const run = steps({
    start: CONSENT,
    browser: { type: "success", url: `${RETURN_ADDRESS}?appId=gmail` },
    connected: true,
  });
  expect(await connectAccount("gmail", {}, run.given)).toEqual({
    kind: "connected",
  });
  expect(run.asked).toEqual([
    `start gmail`,
    `open ${CONSENT.next === "consent" ? CONSENT.authorizationUrl : ""} -> openbotmobile://connections/returned`,
    "confirm gmail",
  ]);
});

test("coming back proves nothing: an app that doesn't confirm is said, and nothing is claimed", async () => {
  const run = steps({
    start: CONSENT,
    browser: { type: "success", url: `${RETURN_ADDRESS}?appId=gmail` },
    connected: false,
  });
  expect(await connectAccount("gmail", {}, run.given)).toEqual({
    kind: "failed",
    message: NOT_CONFIRMED,
  });
});

test("a return that says it failed is said in the app's words, and nothing is confirmed", async () => {
  const run = steps({
    start: CONSENT,
    browser: {
      type: "success",
      url: `${RETURN_ADDRESS}?error=failed&appId=gmail`,
    },
    connected: true,
  });
  expect(await connectAccount("gmail", {}, run.given)).toEqual({
    kind: "failed",
    message: "Couldn't connect that account. Nothing was saved. Try again.",
  });
  expect(run.asked).not.toContain("confirm gmail");
});

test("a browser closed by the person is no failure, but the app is still asked: Android's way back ends it dismissed", async () => {
  const closed = steps({
    start: CONSENT,
    browser: { type: "cancel" },
    connected: false,
  });
  expect(await connectAccount("gmail", {}, closed.given)).toEqual({
    kind: "cancelled",
  });
  expect(closed.asked).toContain("confirm gmail");
  const dismissed = steps({
    start: CONSENT,
    browser: { type: "dismiss" },
    connected: true,
  });
  expect(await connectAccount("gmail", {}, dismissed.given)).toEqual({
    kind: "connected",
  });
});

test("an answer this build doesn't know isn't followed", async () => {
  const run = steps({
    start: { next: "device_code", code: "ABCD" } as unknown as ConnectionStart,
  });
  expect(await connectAccount("gmail", {}, run.given)).toEqual({
    kind: "failed",
    message: NOT_HERE,
  });
  expect(run.asked).toEqual(["start gmail"]);
});

test("the return address is read for its app and its code, and any other address is refused", () => {
  expect(readReturn(`${RETURN_ADDRESS}?appId=gmail`)).toEqual({
    appId: "gmail",
  });
  expect(readReturn(`${RETURN_ADDRESS}/?appId=gmail&error=failed`)).toEqual({
    appId: "gmail",
    error: "failed",
  });
  expect(readReturn(`${RETURN_ADDRESS}?error=failed`)).toEqual({
    error: "failed",
  });
  expect(readReturn(RETURN_ADDRESS)).toEqual({});
  expect(readReturn("openbotmobile://oauth/callback?code=1")).toBeNull();
  expect(
    readReturn("https://evil.example/connections/returned?appId=gmail"),
  ).toBeNull();
  expect(readReturn("not an address")).toBeNull();
});

test("a route's parameters are read the same way, blanks and arrays left out", () => {
  expect(fromParams({ appId: " gmail ", error: "" })).toEqual({
    appId: "gmail",
  });
  expect(fromParams({ appId: ["a", "b"] })).toEqual({});
});

test("a code from the address is never shown: failed, the one the server sends, and any other read the same", () => {
  expect(returnSentence("failed")).toBe(
    "Couldn't connect that account. Nothing was saved. Try again.",
  );
  expect(returnSentence("<script>")).toBe(
    "Couldn't connect that account. Nothing was saved. Try again.",
  );
});

test("the phone connects only where the deployment says so", () => {
  expect(phoneConnects({ mobileConnections: true })).toBe(true);
  expect(phoneConnects({ mobileConnections: false })).toBe(false);
  expect(phoneConnects({})).toBe(false);
  expect(phoneConnects({ mobileConnections: "yes" })).toBe(false);
  expect(phoneConnects(undefined)).toBe(false);
});

test("a key form sends what was typed, trimmed, and names the required boxes left empty", () => {
  const fields: ConnectionField[] = [
    {
      name: "api_key",
      label: "API key",
      help: "",
      required: true,
      secret: true,
      default: null,
    },
    {
      name: "region",
      label: "Region",
      help: "",
      required: false,
      secret: false,
      default: "us",
    },
    {
      name: "team",
      label: "Team",
      help: "",
      required: true,
      secret: false,
      default: null,
    },
  ];
  expect(startingValues(fields)).toEqual({
    api_key: "",
    region: "us",
    team: "",
  });
  expect(
    formValues(fields, { api_key: " lin_1\n", region: "", team: "core" }),
  ).toEqual({
    values: { api_key: "lin_1", team: "core" },
  });
  expect(formValues(fields, { api_key: "  ", region: "eu" })).toEqual({
    missing: ["API key", "Team"],
  });
});

const connection = (over: Partial<Connection> = {}): Connection => ({
  appId: "gmail",
  connectedAt: "2026-11-20T10:00:00.000Z",
  revoked: false,
  scope: null,
  check: null,
  canAddAccount: false,
  ...over,
});

test("a connection needs reconnecting when its access was withdrawn, or a key's check made a call and failed", () => {
  expect(needsReconnecting(connection())).toBe(false);
  expect(needsReconnecting(connection({ revoked: true }))).toBe(true);
  const check = {
    verified: false,
    verifiedAt: null,
    checkedAction: "list_issues",
    checkable: true,
  };
  expect(needsReconnecting(connection({ check }))).toBe(true);
  // A key never tried, because the app offers nothing safe to call, is not a failed one.
  expect(
    needsReconnecting(connection({ check: { ...check, checkedAction: null } })),
  ).toBe(false);
});

const app = (over: Partial<ListedApp>): ListedApp => ({
  id: "gmail",
  title: "Gmail",
  source: "directory",
  connectsWith: "sign-in",
  accountMode: "personal",
  sharedOnly: false,
  signIn: false,
  ...over,
});

const APPS: ListedApp[] = [
  app({
    id: "google-drive",
    title: "Google Drive",
    source: "catalogue",
    connectsWith: null,
    accountMode: null,
  }),
  app({
    id: "brave",
    title: "Brave Search",
    source: "catalogue",
    connectsWith: null,
    accountMode: null,
  }),
  app({ id: "gmail", title: "Gmail" }),
  app({ id: "linear", title: "Linear", connectsWith: "key" }),
  app({ id: "hackernews", title: "Hacker News", connectsWith: "nothing" }),
  app({ id: "slack", title: "Slack", accountMode: "shared" }),
  app({ id: "own-client", title: "Own client", sharedOnly: true }),
  app({
    id: "wiki",
    title: "Wiki",
    source: "address",
    connectsWith: null,
    accountMode: null,
    signIn: true,
  }),
  app({
    id: "weather",
    title: "Weather",
    source: "address",
    connectsWith: null,
    accountMode: null,
  }),
];
const CATALOGUE = [
  // Each person signs in: listed once added.
  { id: "catalogue:google-drive", source: "catalogue", auth: "user-oauth" },
  // Not added: not listed.
  { id: "catalogue:notion", source: "catalogue", auth: "user-oauth" },
  // A key an admin gives for everybody: nothing for the person to connect.
  { id: "catalogue:brave", source: "catalogue", auth: "deployment-bearer" },
];

test("Connections lists the apps added here by the web app's rules, what is in use first", () => {
  const listed = yourApps({
    apps: APPS,
    catalogue: CATALOGUE,
    setup: { directoryAvailable: true, directoryProvider: "composio" },
    connections: [
      connection({ appId: "gmail" }),
      connection({ appId: "linear", revoked: true }),
    ],
  });
  expect(listed).toEqual([
    { id: "gmail", title: "Gmail", connect: "sign-in", standing: "connected" },
    { id: "linear", title: "Linear", connect: "key", standing: "reconnect" },
    { id: "slack", title: "Slack", connect: null, standing: "shared" },
    { id: "weather", title: "Weather", connect: null, standing: "on" },
    {
      id: "google-drive",
      title: "Google Drive",
      connect: "sign-in",
      standing: "not_connected",
    },
    {
      id: "wiki",
      title: "Wiki",
      connect: "sign-in",
      standing: "not_connected",
    },
  ]);
});

test("a Composio directory that isn't set up here lists none of its apps; another directory's stay", () => {
  const ids = (setup: {
    directoryAvailable: boolean;
    directoryProvider: "composio" | "arcade" | null;
  }) =>
    yourApps({ apps: APPS, catalogue: CATALOGUE, setup, connections: [] }).map(
      (row) => row.id,
    );
  expect(
    ids({ directoryAvailable: false, directoryProvider: "composio" }),
  ).toEqual(["weather", "google-drive", "wiki"]);
  expect(
    ids({ directoryAvailable: false, directoryProvider: "arcade" }),
  ).toContain("gmail");
});

test("disconnecting warns of the other apps on the same sign-in, and of those that couldn't be checked", () => {
  expect(disconnectWarning({ alsoEnds: [], uncheckedCount: 0 })).toBeNull();
  expect(disconnectWarning(undefined)).toBeNull();
  expect(
    disconnectWarning({ alsoEnds: ["Google Drive"], uncheckedCount: 0 }),
  ).toBe(
    "Disconnecting also ends your access to Google Drive, which shares this connection.",
  );
  expect(
    disconnectWarning({
      alsoEnds: ["Calendar", "Drive", "Sheets"],
      uncheckedCount: 1,
    }),
  ).toBe(
    "Disconnecting also ends your access to Calendar, Drive and Sheets, which share this connection. 1 other app couldn't be checked and may be affected too.",
  );
  expect(disconnectWarning({ alsoEnds: [], uncheckedCount: 2 })).toBe(
    "2 apps on this connection couldn't be checked, so disconnecting may end them too.",
  );
});

test("a return outside the browser's session is heard only by the screen it is for", () => {
  const heard: string[] = [];
  const stop = onConnectionReturned((returned) => {
    if (returned.appId && returned.appId !== "gmail") return false;
    heard.push(returned.error ?? "ok");
    return true;
  });
  expect(reportConnectionReturned({ appId: "gmail" })).toBe(true);
  expect(reportConnectionReturned({ appId: "notion" })).toBe(false);
  expect(reportConnectionReturned({ error: "failed" })).toBe(true);
  stop();
  expect(reportConnectionReturned({ appId: "gmail" })).toBe(false);
  expect(heard).toEqual(["ok", "failed"]);
});
