/**
 * Intelligence's project change feed, subscribed to the way OpenBot does (`intelligence/project-changes.ts`),
 * against the real test Intelligence and its realtime gateway. An announcement is made where Intelligence
 * makes it, in its database (`pg_notify('project_change', ...)`, and `cpki.notify_project_change`, the
 * helper its triggers call), and the test watches it arrive. Then the cases a subscriber must survive:
 * the gateway dropping the socket, and Intelligence rotating the join code.
 *
 * WHICH INTELLIGENCE. Beyond `TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY` and
 * `TEST_INTELLIGENCE_GATEWAY_WS_URL` (support/bots.ts), this file needs two of that Intelligence's
 * stores, named explicitly because no OpenBot code ever touches them:
 * - `TEST_INTELLIGENCE_DATABASE_URL`: its Postgres, where announcements are made.
 * - `TEST_INTELLIGENCE_REDIS_URL`: its control-plane Redis, where join codes live, to rotate one.
 * Missing, every test here fails and names the variable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { RedisClient, SQL } from "bun";
import {
  createProjectChangesClient,
  type ProjectChange,
  type ProjectChangeResource,
  type ProjectChangeSubscription,
  ProjectChangesError,
  subscribeToProjectChanges,
} from "../src/intelligence/project-changes";
import { testIntelligence } from "./support/bots";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `${name} must name the test Intelligence's ${name.includes("REDIS") ? "control-plane Redis" : "Postgres database"} (on 127.0.0.1). This suite makes change announcements there and watches them arrive. See server/tests/project-changes.integration.test.ts.`,
    );
  return value;
}

const intelligence = testIntelligence();
const database = new SQL(required("TEST_INTELLIGENCE_DATABASE_URL"));
const redis = new RedisClient(required("TEST_INTELLIGENCE_REDIS_URL"));
const client = createProjectChangesClient(intelligence);
const subscriptions: ProjectChangeSubscription[] = [];
let scope: { organizationId: string; projectId: number };

beforeAll(async () => {
  // The project the key belongs to, as Intelligence resolves it.
  const shortToken = intelligence.apiKey.split("_")[1];
  const [key] = await database`
    SELECT organization_id, project_id FROM cpki.api_keys
     WHERE short_token = ${shortToken} AND deleted_at IS NULL`;
  if (!key)
    throw new Error(
      "TEST_INTELLIGENCE_API_KEY is not a key in TEST_INTELLIGENCE_DATABASE_URL.",
    );
  scope = {
    organizationId: key.organization_id as string,
    projectId: Number(key.project_id),
  };
});

afterAll(async () => {
  for (const subscription of subscriptions) subscription.stop();
  redis.close();
  await database.close();
});

async function eventually<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Not within ${timeoutMs}ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A subscription that records what it hears, through the real client, counting what it mints. */
function watch(
  resource: ProjectChangeResource,
  options: { gatewayWsUrl?: string; keepaliveIntervalMs?: number } = {},
) {
  const heard: ProjectChange[] = [];
  const joins: string[] = [];
  const tokens: string[] = [];
  const subscription = subscribeToProjectChanges({
    resource,
    client: {
      subscribe: async (family) => {
        const credentials = await client.subscribe(family);
        tokens.push(credentials.joinToken);
        return credentials;
      },
      joinCode: (family) => client.joinCode(family),
    },
    gatewayWsUrl: options.gatewayWsUrl ?? intelligence.gatewayWsUrl,
    onChange: (change) => heard.push(change),
    onJoined: (joinCode) => joins.push(joinCode),
    keepaliveIntervalMs: options.keepaliveIntervalMs,
  });
  subscriptions.push(subscription);
  return { subscription, heard, joins, tokens };
}

/** Announce with the helper Intelligence's triggers call, in its database, committed. */
async function announce(
  resource: ProjectChangeResource,
  fields: Record<string, unknown>,
  projectId = scope.projectId,
) {
  await database`SELECT cpki.notify_project_change(
    ${scope.organizationId}, ${projectId}::integer, ${resource}, ${JSON.stringify(fields)}::text::jsonb)`;
}

/** Waits for the announcement carrying `nonce`, and returns everything heard by then. */
async function heardBy(heard: ProjectChange[], nonce: string) {
  await eventually(
    () => heard,
    (all) => all.some((change) => change.nonce === nonce),
  );
  return heard.filter((change) => typeof change.nonce === "string");
}

/**
 * A TCP relay to the gateway, so a test can drop every connection the way a gateway restart or a
 * network fault does, without touching the gateway other suites are using.
 */
async function relayToGateway() {
  const upstream = new URL(intelligence.gatewayWsUrl);
  const open = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    const outbound = net.connect(
      Number(upstream.port),
      upstream.hostname.replace(/^\[|\]$/g, ""),
    );
    open.add(inbound);
    open.add(outbound);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    const close = () => {
      inbound.destroy();
      outbound.destroy();
      open.delete(inbound);
      open.delete(outbound);
    };
    inbound.on("error", close).on("close", close);
    outbound.on("error", close).on("close", close);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `${upstream.protocol}//127.0.0.1:${port}${upstream.pathname === "/" ? "" : upstream.pathname}`,
    connections: () => open.size,
    dropAll() {
      for (const socket of open) socket.destroy();
      open.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("the project change feed", () => {
  test("an announcement in the family arrives as sent; another family's and another project's do not", async () => {
    const { subscription, heard, joins } = watch("memory_changes");
    await eventually(() => joins.length === 1);
    expect(subscription.joinCode()).toBe(joins[0] ?? null);

    const nonce = randomUUID();
    await announce("learning_changes", {
      entity: "agent_assignments",
      version: 1,
      nonce: `${nonce}-learning`,
    });
    await announce(
      "memory_changes",
      { entity: "memory", id: "m-other", nonce: `${nonce}-other-project` },
      scope.projectId + 1_000_000,
    );
    // A raw notification, as any trigger could send one, is delivered the same way.
    await database`SELECT pg_notify('project_change', ${JSON.stringify({
      organizationId: scope.organizationId,
      projectId: String(scope.projectId),
      resource: "memory_changes",
      entity: "source",
      userId: "person-1",
      id: "source-1",
      version: 2,
      change: "created",
      nonce: `${nonce}-raw`,
    })})`;
    await announce("memory_changes", {
      entity: "memory",
      userId: "person-1",
      id: "memory-1",
      version: 3,
      change: "updated",
      nonce,
    });

    // Announcements arrive in commit order, so by the last one every earlier one that was coming has.
    expect(await heardBy(heard, nonce)).toEqual([
      {
        organizationId: scope.organizationId,
        projectId: String(scope.projectId),
        resource: "memory_changes",
        entity: "source",
        userId: "person-1",
        id: "source-1",
        version: 2,
        change: "created",
        nonce: `${nonce}-raw`,
      },
      {
        organizationId: scope.organizationId,
        projectId: String(scope.projectId),
        resource: "memory_changes",
        entity: "memory",
        userId: "person-1",
        id: "memory-1",
        version: 3,
        change: "updated",
        nonce,
      },
    ]);
  });

  test("when the gateway drops the socket, it subscribes again with a fresh token, rejoins, and hears again", async () => {
    const relay = await relayToGateway();
    try {
      const { subscription, heard, joins, tokens } = watch("learning_changes", {
        gatewayWsUrl: relay.url,
      });
      await eventually(() => joins.length === 1);
      expect(relay.connections()).toBeGreaterThan(0);

      relay.dropAll();
      await eventually(() => subscription.joinCode() === null);
      // Every rejoin is announced, so the subscriber reads everything again.
      await eventually(() => joins.length === 2);
      expect(tokens).toHaveLength(2);
      expect(new Set(tokens).size).toBe(2);
      expect(joins[1]).toBe(joins[0]);

      const nonce = randomUUID();
      await announce("learning_changes", {
        entity: "personal_space",
        appUserId: "person-2",
        version: 5,
        nonce,
      });
      expect(await heardBy(heard, nonce)).toEqual([
        {
          organizationId: scope.organizationId,
          projectId: String(scope.projectId),
          resource: "learning_changes",
          entity: "personal_space",
          appUserId: "person-2",
          version: 5,
          nonce,
        },
      ]);
    } finally {
      await relay.close();
    }
  });

  test("when Intelligence rotates the join code, the keepalive notices and subscribes again on the new one", async () => {
    const { subscription, heard, joins } = watch("memory_changes", {
      keepaliveIntervalMs: 200,
    });
    await eventually(() => joins.length >= 1);
    const first = joins.at(-1);

    // The code lapses (an hour without renewal, or Redis lost it): the next read mints another.
    await redis.del(
      `project_changes:memory_changes:${scope.organizationId}:${scope.projectId}:join-code`,
    );
    const second = await eventually(
      () => subscription.joinCode(),
      (code) => code !== null && code !== first,
    );
    if (second === null) throw new Error("No join code after the rotation.");
    expect(joins.at(-1)).toBe(second);

    const nonce = randomUUID();
    await announce("memory_changes", {
      entity: "memory",
      id: "memory-2",
      version: 1,
      change: "created",
      nonce,
    });
    expect((await heardBy(heard, nonce)).map((change) => change.nonce)).toEqual(
      [nonce],
    );
  });

  test("a family Intelligence does not carry is refused by name", async () => {
    const refused = await client
      .subscribe("files_changes" as ProjectChangeResource)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProjectChangesError);
    expect(refused).toMatchObject({
      status: 404,
      code: "PROJECT_CHANGE_RESOURCE_NOT_FOUND",
    });
  });
});
