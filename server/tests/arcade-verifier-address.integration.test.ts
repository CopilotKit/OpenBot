// server/tests/arcade-verifier-address.integration.test.ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import postgres from "postgres";
import { createAuditStore } from "../src/audit";
import {
  createDevRequireUser,
  initializeDevActorUser,
} from "../src/auth/dev-actor";
import type { AppVariables } from "../src/auth/guards";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import { brokeredConnections, mcpServers, mcpTools } from "../src/db/schema";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { createComposioClient } from "../src/plugins/composio-adapter";
import { selectProviderWiring } from "../src/plugins/provider-wiring";
import { createPluginRoutes } from "../src/plugins/routes";
import { ensureSingleUserIdentity } from "../src/plugins/single-user-identity";
import { createPluginStore } from "../src/plugins/store";
import fixture from "./fixtures/arcade-catalogue.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { seedPeople } from "./support/people";

/**
 * AN ARCADE CONNECT ONLY CAME BACK TO A DEPLOYMENT AT THE ONE ADDRESS ARCADE'S PROJECT NAMED.
 *
 * WHAT WAS WRONG. After the person finishes the app's consent, Arcade sends their browser to the
 * project's custom user verifier. That address was set by hand in Arcade's dashboard, and this
 * deployment never looked at it: the code said Arcade had no API to read it. So every deployment on
 * a key whose project named `http://localhost:3001/api/plugins/arcade/verify` sent its people there
 * after consent, and anywhere but `localhost:3001` that is a 404 with the consent spent.
 *
 * WHAT ARCADE DOCUMENTS. Its OpenAPI (`https://api.arcade.dev/v1/swagger`) serves
 * `GET` and `PUT /v1/admin/settings/session_verification`, "the current session verification
 * settings for the caller", with `verifier_url` and `unsafe_skip_verification` in both the request
 * and the answer. Arcade's own templates set the verifier this way with a project key and read it
 * back. A live, read-only `GET` with this project's key answered the `localhost:3001` address.
 *
 * WHAT IS ASSERTED. A single-user install owns its Arcade project: its Connect points the
 * project's verifier at it before minting, so the browser comes back to its verify route and the
 * connection is recorded; two such installs on one key each get their own people back; a verifier
 * already pointing here is only read; and a setting Arcade would not take refuses the Connect before
 * anybody is sent to a consent screen, naming the address to set. A deployment that signs people in
 * treats the project as shared: it never writes the verifier, refuses with the exact address an
 * admin sets when the project names somewhere else, and connects normally when it names this one.
 *
 * REAL DATABASE, REAL WIRING, REAL ROUTES, REAL STORE, REAL ADAPTER AND THE REAL SDK. The client is
 * built through `selectProviderWiring`, as `index.ts` builds it from configuration. Arcade is faked
 * at its HTTP boundary through `ARCADE_BASE_URL`, answering the settings routes in the swagger's
 * shapes and sending a consent's browser to whatever `verifier_url` the project holds at that moment.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];

const TOOLKIT = "Gmail";
const ROW = `arcade-${TOOLKIT}`;
const READ = `${TOOLKIT}.ListEmails`;
const APP_URL = "https://app.example";
const VERIFY_PATH = "/api/plugins/arcade/verify";
/** What the shared project's verifier named when this was found: one developer's own machine. */
const LOCALHOST_VERIFIER = `http://localhost:3001${VERIFY_PATH}`;
const PROVIDER_TYPE = "google";
const PROVIDER = "arcade-google";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const SETTINGS = "/v1/admin/settings/session_verification";

async function freshDatabase(): Promise<string> {
  const name = `openbot_arcade_verifier_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  return url.href;
}

/* ------------------------------------------------------------------ Arcade, at its own wire */

const recorded = fixture.tools as unknown as Record<
  string,
  { metadata: unknown }
>;
const envelope = fixture.page_envelope as Record<string, unknown>;

/** Gmail's read action as the live listing publishes it. */
const LISTED = {
  fully_qualified_name: `${READ}@3.1.0`,
  qualified_name: READ,
  name: "ListEmails",
  description: "ListEmails in the person's mailbox.",
  toolkit: {
    name: TOOLKIT,
    description: "Arcade tools designed for LLMs to interact with Gmail",
    version: "3.1.0",
  },
  input: { parameters: [] },
  requirements: {
    met: true,
    authorization: {
      id: PROVIDER,
      provider_id: PROVIDER_TYPE,
      provider_type: "oauth2",
      oauth2: { scopes: SCOPES },
      status: "active",
    },
  },
  metadata: recorded.read?.metadata,
};

/** `schemas.SessionVerificationSettingsResponse`, as the swagger declares it. */
type VerifierSettings = {
  unsafe_skip_verification: boolean;
  unsafe_skip_verification_choice_allowed: boolean;
  verifier_url: string | null;
};

type Flow = { userId: string; handle: string; status: "pending" | "completed" };

/** One Arcade project, as the one key every deployment here shares sees it. */
function arcadeProject(initialVerifier: string | null) {
  const settings: VerifierSettings = {
    unsafe_skip_verification: false,
    unsafe_skip_verification_choice_allowed: false,
    verifier_url: initialVerifier,
  };
  /** A PUT that answers 200 and changes nothing, the case Arcade's own setup script reads back for. */
  let ignoresPut = false;
  /** A PUT Arcade refuses, with this status. */
  let refusesPut: number | null = null;
  const flows = new Map<string, Flow>();
  const byHandle = new Map<string, string>();
  const connections: { user_id: string; connection_id: string }[] = [];
  /** Every request, in order, as `METHOD /path`. */
  const requests: string[] = [];
  const puts: unknown[] = [];
  const unexpected: string[] = [];
  let next = 0;

  const refuse = (status: number, name: string, message: string) =>
    Response.json({ name, message }, { status });

  const page = (items: unknown[], url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? items.length) || 100;
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const slice = items.slice(offset, offset + limit);
    return {
      ...envelope,
      limit,
      offset,
      page_count: slice.length,
      total_count: items.length,
      items: slice,
    };
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    requests.push(route);
    const body =
      request.method === "POST" || request.method === "PUT"
        ? ((await request.json()) as Record<string, unknown>)
        : {};

    if (route === `GET ${SETTINGS}`) return Response.json(settings);
    if (route === `PUT ${SETTINGS}`) {
      puts.push(body);
      if (refusesPut !== null) {
        return refuse(refusesPut, "forbidden", "Not allowed for this key.");
      }
      const wanted = body.verifier_url;
      if (
        wanted !== undefined &&
        (typeof wanted !== "string" || wanted.length > 2048)
      ) {
        return refuse(400, "bad_request", "verifier_url must be a URL.");
      }
      if (!ignoresPut) {
        if (typeof wanted === "string") settings.verifier_url = wanted;
        if (typeof body.unsafe_skip_verification === "boolean") {
          settings.unsafe_skip_verification = body.unsafe_skip_verification;
        }
      }
      return Response.json(settings);
    }
    if (route === "GET /v1/tools") {
      const items = url.searchParams.get("toolkit") === TOOLKIT ? [LISTED] : [];
      return Response.json(page(items, url));
    }
    if (route === "POST /v1/auth/authorize") {
      next += 1;
      const id = `ar_${next}`;
      const handle = `fl_${next}`;
      const userId = String(body.user_id);
      flows.set(id, { userId, handle, status: "pending" });
      byHandle.set(handle, id);
      return Response.json({
        id,
        status: "pending",
        url: `https://cloud.arcade.test/oauth/consent?flow=${handle}&secret=bearer`,
        provider_id: PROVIDER_TYPE,
        scopes: SCOPES,
        user_id: userId,
      });
    }
    if (route === "POST /v1/auth/confirm_user") {
      const id = byHandle.get(String(body.flow_id));
      const flow = id ? flows.get(id) : undefined;
      if (!id || !flow) return refuse(404, "not_found", "No such flow.");
      if (flow.userId !== body.user_id) {
        return refuse(
          400,
          "user_mismatch",
          "An error occurred during verification.",
        );
      }
      flow.status = "completed";
      next += 1;
      connections.push({ user_id: flow.userId, connection_id: `ac_${next}` });
      return Response.json({
        auth_id: id,
        next_uri: "https://cloud.arcade.test/done",
      });
    }
    if (route === "GET /v1/auth/status") {
      const id = url.searchParams.get("id") ?? "";
      const flow = flows.get(id);
      if (!flow) return refuse(404, "not_found", "No such authorization.");
      return Response.json({
        id,
        status: flow.status,
        user_id: flow.userId,
        scopes: SCOPES,
        provider_id: PROVIDER_TYPE,
        context: {
          token: "ya29.stand-in",
          user_info: { email: "me@example.test" },
        },
      });
    }
    unexpected.push(route);
    return refuse(404, "not_found", `${route} is not served here.`);
  }

  return {
    handle,
    settings,
    requests,
    puts,
    unexpected,
    connections,
    ignorePuts() {
      ignoresPut = true;
    },
    refusePuts(status: number) {
      refusesPut = status;
    },
    /**
     * The person finishing the app's consent. Arcade then sends their browser to the project's
     * verifier AS IT IS SET AT THIS MOMENT, with the flow's handle: the address answered here.
     */
    consent(authorizationUrl: string): string {
      const handle = new URL(authorizationUrl).searchParams.get("flow") ?? "";
      if (!byHandle.has(handle))
        throw new Error(`${authorizationUrl} names no flow.`);
      const back = new URL(
        settings.verifier_url ?? "https://cloud.arcade.test/verify",
      );
      back.searchParams.set("flow_id", handle);
      return back.href;
    },
  };
}

let project = arcadeProject(LOCALHOST_VERIFIER);
let engine: ReturnType<typeof Bun.serve> | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

beforeAll(() => {
  engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => project.handle(request),
  });
  // Read by `new Arcade({ apiKey })`, so it is set before any client is built.
  process.env.ARCADE_BASE_URL = `http://127.0.0.1:${engine.port}`;
});

beforeEach(() => {
  project = arcadeProject(LOCALHOST_VERIFIER);
});

afterEach(async () => {
  useArcadeClient(null);
  for (const database of opened.splice(0)) await database.$client.close();
});

afterAll(async () => {
  engine?.stop(true);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

/* ------------------------------------------------------------------ a deployment, booted */

/** A guard that signs one named person in, as a deployment that signs people in does. */
const signedInAs =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };

/**
 * A deployment starting at `publicUrl` on the shared key: its Arcade client built by the same wiring
 * `index.ts` runs, from the same two settings, and Gmail turned on as a Personal app. Single-user,
 * with its name at Arcade settled, unless a signed-in person is named.
 */
async function deploymentAt(
  publicUrl: string,
  { signedIn }: { signedIn?: string } = {},
) {
  const singleUser = signedIn === undefined;
  const database = createDatabase(await freshDatabase(), TEST_POOL);
  opened.push(database);
  await initializeDevActorUser(database, singleUser);
  if (signedIn) await seedPeople(database, [signedIn]);
  const wiring = selectProviderWiring(
    {
      arcadeApiKey: `arcade-test-key-${suite}`,
      brokerProvider: "arcade",
      publicUrl,
      singleUser,
    },
    { composio: createComposioClient, arcade: createArcadeClient },
  );
  const broker = wiring.broker;
  if (!broker) throw new Error("Arcade was not wired.");
  useArcadeClient(wiring.install.arcade);
  const identity =
    (await ensureSingleUserIdentity(database, {
      singleUser,
      provider: "arcade",
    })) ?? signedIn;
  const store = createPluginStore({
    brokerProvider: "arcade",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: "single-user",
  });
  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn ? signedInAs(signedIn) : createDevRequireUser(),
      async () => true,
      {
        publicUrl,
        appUrl: APP_URL,
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider: "arcade" },
    ),
  );
  await database.insert(mcpServers).values({
    id: ROW,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://${TOOLKIT}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values({
    serverId: ROW,
    name: "ListEmails",
    vendorName: READ,
    description: "List emails.",
    effect: "read",
  });
  return { database, app, identity, verifier: `${publicUrl}${VERIFY_PATH}` };
}

type Deployment = Awaited<ReturnType<typeof deploymentAt>>;

const pressConnect = (deployment: Deployment) =>
  deployment.app.request(`/api/plugins/servers/${ROW}/connect`, {
    method: "POST",
  });

/**
 * Connect pressed and the consent finished. Answers where Arcade sent the browser, and, when that is
 * this deployment's own verify route, where the verify route sent it on to.
 */
async function connectAndReturn(deployment: Deployment) {
  const response = await pressConnect(deployment);
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as {
    authorizationUrl: string;
  };
  const sentTo = project.consent(authorizationUrl);
  const back = new URL(sentTo);
  if (`${back.origin}${back.pathname}` !== deployment.verifier) {
    return { sentTo, landed: null };
  }
  const verified = await deployment.app.request(
    `${back.pathname}${back.search}`,
  );
  expect(verified.status).toBe(303);
  return { sentTo, landed: verified.headers.get("location") };
}

const rowsIn = (database: Database) =>
  database
    .select({
      app: brokeredConnections.app,
      vendorUserId: brokeredConnections.vendorUserId,
    })
    .from(brokeredConnections);

describe("a single-user install owns its Arcade project and points the verifier at itself", () => {
  test("a deployment that is not at localhost:3001 gets the browser back after consent, and the connection is recorded", async () => {
    const here = await deploymentAt("http://127.0.0.1:48711");

    const { sentTo, landed } = await connectAndReturn(here);

    // Back to this deployment's own verify route, not to the address the project held before.
    expect(sentTo).toStartWith(`${here.verifier}?flow_id=`);
    expect(landed).toBe(`${APP_URL}/connections/${ROW}`);
    expect(await rowsIn(here.database)).toEqual([
      { app: TOOLKIT, vendorUserId: here.identity ?? "" },
    ]);

    // The project now names this deployment, set before the consent was minted, never after.
    expect(project.settings).toEqual({
      unsafe_skip_verification: false,
      unsafe_skip_verification_choice_allowed: false,
      verifier_url: here.verifier,
    });
    expect(project.puts).toEqual([
      { verifier_url: here.verifier, unsafe_skip_verification: false },
    ]);
    const pointed = project.requests.indexOf(`PUT ${SETTINGS}`);
    const minted = project.requests.indexOf("POST /v1/auth/authorize");
    expect(pointed).toBeGreaterThanOrEqual(0);
    expect(pointed).toBeLessThan(minted);
    expect(project.unexpected).toEqual([]);
  });

  test("two deployments on one key at different addresses each get their own people back", async () => {
    const a = await deploymentAt("http://127.0.0.1:48712");
    const b = await deploymentAt("http://127.0.0.1:48713");

    expect(await connectAndReturn(a)).toMatchObject({
      landed: `${APP_URL}/connections/${ROW}`,
    });
    expect(await connectAndReturn(b)).toMatchObject({
      landed: `${APP_URL}/connections/${ROW}`,
    });
    expect(project.settings.verifier_url).toBe(b.verifier);
    expect(await rowsIn(a.database)).toEqual([
      { app: TOOLKIT, vendorUserId: a.identity ?? "" },
    ]);
    expect(await rowsIn(b.database)).toEqual([
      { app: TOOLKIT, vendorUserId: b.identity ?? "" },
    ]);
    expect(project.unexpected).toEqual([]);
  });

  test("a verifier already pointing here is read and left alone", async () => {
    const here = await deploymentAt("http://127.0.0.1:48714");
    project.settings.verifier_url = here.verifier;

    expect(await connectAndReturn(here)).toMatchObject({
      landed: `${APP_URL}/connections/${ROW}`,
    });
    expect(project.puts).toEqual([]);
    expect(project.requests).toContain(`GET ${SETTINGS}`);
  });

  test("a setting Arcade does not take refuses the Connect before anybody is sent to a consent screen", async () => {
    const here = await deploymentAt("http://127.0.0.1:48715");
    project.ignorePuts();

    const response = await pressConnect(here);
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("Couldn't start connecting Gmail");
    // The address to set by hand, since OpenBot could not set it.
    expect(error).toContain(here.verifier);
    expect(error).not.toContain("expires within fifteen minutes");
    expect(project.requests).not.toContain("POST /v1/auth/authorize");
    expect(project.settings.verifier_url).toBe(LOCALHOST_VERIFIER);
  });

  test("a setting Arcade refuses to change refuses the Connect, and Connect can be pressed again at once", async () => {
    const here = await deploymentAt("http://127.0.0.1:48716");
    project.refusePuts(403);

    expect((await pressConnect(here)).status).toBe(503);
    expect(project.requests).not.toContain("POST /v1/auth/authorize");

    // Nothing was minted, so nothing holds this person: a second press is not "already connecting".
    const again = await pressConnect(here);
    expect(again.status).toBe(503);
  });
});

describe("a deployment that signs people in treats its Arcade project as shared", () => {
  test("it never changes the verifier, and refuses before any consent with the exact address an admin sets", async () => {
    const here = await deploymentAt("http://127.0.0.1:48717", {
      signedIn: `person-${suite}-a`,
    });

    const response = await pressConnect(here);
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toBe(
      `Couldn't start connecting Gmail. Arcade would send you back somewhere else after you sign in. Ask an admin to set the custom verifier in Arcade's dashboard to ${here.verifier}`,
    );

    // Read, never written, and nobody was sent to a consent screen.
    expect(project.requests).toContain(`GET ${SETTINGS}`);
    expect(project.puts).toEqual([]);
    expect(project.requests).not.toContain("POST /v1/auth/authorize");
    expect(project.settings.verifier_url).toBe(LOCALHOST_VERIFIER);

    // Nothing was minted, so nothing holds this person: a second press is refused the same way.
    expect((await pressConnect(here)).status).toBe(503);
    expect(project.puts).toEqual([]);
  });

  test("it connects normally when the shared project already names it", async () => {
    const here = await deploymentAt("http://127.0.0.1:48718", {
      signedIn: `person-${suite}-b`,
    });
    project.settings.verifier_url = here.verifier;

    const { sentTo, landed } = await connectAndReturn(here);
    expect(sentTo).toStartWith(`${here.verifier}?flow_id=`);
    expect(landed).toBe(`${APP_URL}/connections/${ROW}`);
    expect(await rowsIn(here.database)).toEqual([
      { app: TOOLKIT, vendorUserId: `person-${suite}-b` },
    ]);
    expect(project.puts).toEqual([]);
    expect(project.unexpected).toEqual([]);
  });
});
