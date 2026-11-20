import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  connectThroughDesktop,
  currentConnection,
  handleConnectionMessage,
  handleExternalConnect,
  installConnection,
} from "../src/background/connection";
import { organizationNameOf } from "../src/background/recording";
import type { RecorderPolicy } from "../src/shared/policy";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

/**
 * A person can be in several organizations, and a Recorder connected in one of them records into that one: the grant
 * OpenBot answers a connect with names the organization (`RecorderConnectionGrant.organizationId`), the Recorder keeps
 * it with the connection, and every later request of that connection goes to that organization's addresses. A grant
 * that names none, as from an OpenBot older than organizations, keeps the connection in `default`, as before.
 *
 * The OpenBot here is a real server on this computer that answers the Recorder's addresses as api/openapi.yaml gives
 * them, under whichever organization the address names, and records every request.
 */

const user = { id: "u1", name: "Ada", email: "ada@example.test" };
/** The organization a code ending `_two` was made in. */
const TWO = "org_two";

const hits: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let loopback = "";

async function openbot(request: Request): Promise<Response> {
  const url = new URL(request.url);
  hits.push(`${request.method} ${url.pathname}`);
  // A code is exchanged at `default`: the code names the organization it was made for.
  if (
    request.method === "POST" &&
    url.pathname === "/api/v2/organizations/default/recorder-connections"
  ) {
    const { code } = (await request.json()) as { code: string };
    return Response.json({
      token: "obr_fixture",
      connection: { id: "c1" },
      user,
      ...(code.endsWith("_two")
        ? { organizationId: TWO, organizationName: "Harbor Research" }
        : {}),
    });
  }
  const addressed =
    /^\/api\/v2\/organizations\/([^/]+)\/(recorder\/me|recorder-connections\/current)$/.exec(
      url.pathname,
    );
  if (addressed?.[2] === "recorder/me")
    return Response.json({ user, connectionId: "c1" });
  if (addressed && request.method === "DELETE")
    return new Response(null, { status: 204 });
  return new Response("nope", { status: 404 });
}

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: openbot });
  loopback = server.url.origin;
});
afterAll(() => server.stop(true));

let fake: ChromeFake;
const policy: RecorderPolicy = {
  openbotUrl: null,
  openbotUrlInvalid: false,
  allowedIntelligenceUrls: null,
};
const deps = {
  openTab: async () => 41,
  readPolicy: async () => policy,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake = installChromeFake({ manifestVersion: "0.2.0" });
  hits.length = 0;
});
afterEach(() => {
  fake.uninstall();
});

/** The requests after the connect: the keep-alive's identity check, then the person's Disconnect. */
async function keepAliveThenDisconnect(): Promise<string[]> {
  hits.length = 0;
  installConnection(deps);
  await settle();
  fake.alarms.fire("recorder-session-keepalive");
  await settle();
  await handleConnectionMessage({ type: "page.disconnect" });
  return hits.filter((hit) => !hit.endsWith("/recorder-connections"));
}

test("a connection made in another organization keeps it, and every request after the connect goes there", async () => {
  const answer = await connectThroughDesktop({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_two" }),
    ...deps,
  });
  expect(answer).toEqual({ connected: true });
  expect(hits).toEqual([
    "POST /api/v2/organizations/default/recorder-connections",
  ]);
  expect(await currentConnection()).toMatchObject({
    token: "obr_fixture",
    organizationId: TWO,
  });

  const after = await keepAliveThenDisconnect();
  expect(after.length).toBeGreaterThanOrEqual(2);
  for (const hit of after) expect(hit).toContain(`/organizations/${TWO}/`);
  expect(after).toContain(`GET /api/v2/organizations/${TWO}/recorder/me`);
  expect(after).toContain(
    `DELETE /api/v2/organizations/${TWO}/recorder-connections/current`,
  );
  expect(await currentConnection()).toBeNull();
});

test("a grant that names no organization keeps the connection in default, as before organizations", async () => {
  // An approved web connect, from an OpenBot that answers no organization.
  const origin = loopback;
  await handleExternalConnect(
    { type: "openbot.connect", code: "obc_plain" },
    { origin },
    deps,
  );
  await handleConnectionMessage(
    { type: "page.connect.decide", approve: true, label: "Chrome", origin },
    deps,
  );
  const stored = await currentConnection();
  expect(stored?.token).toBe("obr_fixture");
  expect(stored?.organizationId).toBeUndefined();

  const after = await keepAliveThenDisconnect();
  for (const hit of after) expect(hit).toContain("/organizations/default/");
  expect(after).toContain("GET /api/v2/organizations/default/recorder/me");
  expect(after).toContain(
    "DELETE /api/v2/organizations/default/recorder-connections/current",
  );
});

test("an approved connect says which organization this browser now records into, and keeps its name", async () => {
  const origin = loopback;
  await handleExternalConnect(
    { type: "openbot.connect", code: "obc_web_two" },
    { origin },
    deps,
  );
  const answer = await handleConnectionMessage(
    { type: "page.connect.decide", approve: true, label: "Chrome", origin },
    deps,
  );
  expect(answer).toEqual({ ok: true, organizationName: "Harbor Research" });
  expect(await currentConnection()).toMatchObject({
    organizationId: TWO,
    organizationName: "Harbor Research",
  });

  // A grant that names none: nothing to say, as before.
  await handleConnectionMessage({ type: "page.disconnect" });
  await handleExternalConnect(
    { type: "openbot.connect", code: "obc_plain_again" },
    { origin },
    deps,
  );
  expect(
    await handleConnectionMessage(
      { type: "page.connect.decide", approve: true, label: "Chrome", origin },
      deps,
    ),
  ).toEqual({ ok: true });
});

test("the popup names the organization from OpenBot's latest answer, else the grant's, else nothing", async () => {
  const connection = {
    openbotUrl: "https://openbot.example.test",
    token: "obr_fixture",
    connectionId: "c1",
    user,
    via: "web" as const,
    connectedAt: 0,
    organizationId: TWO,
    organizationName: "Harbor Research",
  };
  const me = (organization?: { id: string; name: string }) => ({
    user,
    connectionId: "c1",
    ...(organization ? { organization } : {}),
  });
  // Renamed since the connect: OpenBot's answer wins.
  expect(
    organizationNameOf(me({ id: TWO, name: "Harbor Labs" }), connection),
  ).toEqual({ organizationName: "Harbor Labs" });
  // OpenBot couldn't be asked just now: the grant's.
  expect(organizationNameOf(null, connection)).toEqual({
    organizationName: "Harbor Research",
  });
  // Neither names one (an OpenBot that keeps every connection in default): nothing.
  const { organizationName: _gone, ...unnamed } = connection;
  expect(organizationNameOf(me(), unnamed)).toEqual({});
});
