// OpenBot's runtime key in the Intelligence the Helm chart installs, made without anybody signing in.
//
// The chart's key Job runs `intelligence-key.ts` on every install and upgrade. What must not regress:
// a first install waits out an Intelligence API that is not up yet and then stores a working key; an
// upgrade keeps the key it has rather than minting a project per release; a key Intelligence stopped
// accepting is replaced.
//
// Real HTTP on both sides. Intelligence is a server answering the two service-token routes and the
// runtime entitlement read with the shapes app-api 0.15.1 gives (apps/app-api/src/routes/
// hosted-projects-routes.ts, api-keys-routes.ts, runtime-auth.ts); Kubernetes is a server answering
// the core Secret API as the API server does (404 on a missing Secret, 409 on creating one that exists,
// `data` base64).
import { afterEach, describe, expect, test } from "bun:test";
import { reservePort } from "../../tests/support/reserved-port";
import {
  kubernetesKeyStore,
  provisionIntelligenceKey,
} from "../src/intelligence-key";

const SERVICE_TOKEN = "st-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const ORG = "org_openbot";

type Intelligence = {
  url: string;
  projects: string[];
  validKeys: Set<string>;
  stop(): void;
};

const running: { stop(): void }[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.stop();
});

/** Intelligence's API, refusing connections until `upAfterMs` has passed, as a starting app-api does. */
async function intelligence(upAfterMs = 0): Promise<Intelligence> {
  const port = await reservePort();
  const projects: string[] = [];
  const validKeys = new Set<string>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  const start = () => {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/entitlements/runtime") {
          const key = request.headers
            .get("authorization")
            ?.replace(/^Bearer /, "");
          return key && validKeys.has(key)
            ? Response.json({ status: "valid" })
            : Response.json(
                { error: { code: "API_KEY_NOT_FOUND" } },
                { status: 401 },
              );
        }
        if (
          request.headers.get("x-copilotkit-ei-service-token") !== SERVICE_TOKEN
        ) {
          return Response.json(
            { error: { code: "AUTH_UNAUTHENTICATED" } },
            { status: 401 },
          );
        }
        if (
          request.method === "POST" &&
          url.pathname === `/api/organizations/${ORG}/projects`
        ) {
          const { name } = (await request.json()) as { name: string };
          projects.push(name);
          return Response.json(
            {
              id: projects.length,
              slug: "openbot",
              name,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        }
        const keyRoute = url.pathname.match(
          /^\/api\/projects\/(\d+)\/api-keys$/,
        );
        if (request.method === "POST" && keyRoute) {
          const short = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
          const token = `cpk-${keyRoute[1]}_${short}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
          validKeys.add(token);
          return Response.json(
            { key: { id: validKeys.size, short_token: short, token } },
            { status: 201 },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });
  };
  const timer = setTimeout(start, upAfterMs);
  if (upAfterMs === 0) {
    clearTimeout(timer);
    start();
  }
  const handle = {
    url: `http://127.0.0.1:${port}`,
    projects,
    validKeys,
    stop() {
      clearTimeout(timer);
      server?.stop(true);
    },
  };
  running.push(handle);
  return handle;
}

/** The core Secret API for one namespace, holding what has been written to it. */
async function kubernetes(token: string) {
  const port = await reservePort();
  const secrets = new Map<
    string,
    { data: Record<string, string>; labels: Record<string, string> }
  >();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ kind: "Status", code: 401 }, { status: 401 });
      }
      const url = new URL(request.url);
      const match = url.pathname.match(
        /^\/api\/v1\/namespaces\/openbot\/secrets(?:\/([^/]+))?$/,
      );
      if (!match) return new Response("Not found", { status: 404 });
      const name = match[1];
      const encode = (data: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(data).map(([k, v]) => [
            k,
            Buffer.from(v).toString("base64"),
          ]),
        );
      if (request.method === "GET" && name) {
        const secret = secrets.get(name);
        if (!secret)
          return Response.json({ kind: "Status", code: 404 }, { status: 404 });
        return Response.json({
          kind: "Secret",
          metadata: { name, labels: secret.labels },
          data: secret.data,
        });
      }
      const body = (await request.json()) as {
        metadata: { name: string; labels?: Record<string, string> };
        stringData: Record<string, string>;
      };
      if (request.method === "POST" && !name) {
        if (secrets.has(body.metadata.name)) {
          return Response.json({ kind: "Status", code: 409 }, { status: 409 });
        }
        secrets.set(body.metadata.name, {
          data: encode(body.stringData),
          labels: body.metadata.labels ?? {},
        });
        return Response.json({ kind: "Secret" }, { status: 201 });
      }
      if (request.method === "PUT" && name) {
        secrets.set(name, {
          data: encode(body.stringData),
          labels: body.metadata.labels ?? {},
        });
        return Response.json({ kind: "Secret" });
      }
      return new Response("Method not allowed", { status: 405 });
    },
  });
  running.push({ stop: () => server.stop(true) });
  const decoded = (name: string) => {
    const secret = secrets.get(name);
    if (!secret) return undefined;
    return Object.fromEntries(
      Object.entries(secret.data).map(([k, v]) => [
        k,
        Buffer.from(v, "base64").toString("utf8"),
      ]),
    );
  };
  return {
    url: `http://127.0.0.1:${port}`,
    decoded,
    labels: (name: string) => secrets.get(name)?.labels,
  };
}

async function setup(upAfterMs = 0) {
  const api = await intelligence(upAfterMs);
  const cluster = await kubernetes("sa-token");
  const store = kubernetesKeyStore({
    apiServer: cluster.url,
    namespace: "openbot",
    name: "openbot-intelligence-key",
    token: "sa-token",
    labels: { "app.kubernetes.io/component": "intelligence-key" },
  });
  const run = () =>
    provisionIntelligenceKey({
      apiUrl: api.url,
      organizationId: ORG,
      serviceToken: SERVICE_TOKEN,
      projectName: "OpenBot",
      store,
      deadlineMs: 10_000,
      retryMs: 100,
      log: () => {},
    });
  return { api, cluster, run };
}

describe("OpenBot's key in the bundled Intelligence", () => {
  test("a first install waits for Intelligence to come up, then stores a key it accepts", async () => {
    const { api, cluster, run } = await setup(700);

    expect(await run()).toBe("created");

    const secret = cluster.decoded("openbot-intelligence-key");
    expect(secret?.["intelligence-project-id"]).toBe("1");
    expect(api.validKeys.has(secret?.["intelligence-api-key"] ?? "")).toBe(
      true,
    );
    expect(api.projects).toEqual(["OpenBot"]);
    expect(cluster.labels("openbot-intelligence-key")).toEqual({
      "app.kubernetes.io/component": "intelligence-key",
    });
  });

  test("an upgrade keeps the key it has, rather than making a project every release", async () => {
    const { api, cluster, run } = await setup();
    await run();
    const first = cluster.decoded("openbot-intelligence-key")?.[
      "intelligence-api-key"
    ];

    expect(await run()).toBe("kept");
    expect(await run()).toBe("kept");

    expect(api.projects).toHaveLength(1);
    expect(
      cluster.decoded("openbot-intelligence-key")?.["intelligence-api-key"],
    ).toBe(first);
  });

  test("a key Intelligence no longer accepts is replaced with a working one", async () => {
    const { api, cluster, run } = await setup();
    await run();
    const stale =
      cluster.decoded("openbot-intelligence-key")?.["intelligence-api-key"] ??
      "";
    // Intelligence's database was replaced: the stored key now means nothing to it.
    api.validKeys.delete(stale);

    expect(await run()).toBe("replaced");

    const fresh =
      cluster.decoded("openbot-intelligence-key")?.["intelligence-api-key"] ??
      "";
    expect(fresh).not.toBe(stale);
    expect(api.validKeys.has(fresh)).toBe(true);
    expect(
      cluster.decoded("openbot-intelligence-key")?.["intelligence-project-id"],
    ).toBe("2");
  });

  test("gives up, saying why, when Intelligence never comes up", async () => {
    const cluster = await kubernetes("sa-token");
    const port = await reservePort();
    await expect(
      provisionIntelligenceKey({
        apiUrl: `http://127.0.0.1:${port}`,
        organizationId: ORG,
        serviceToken: SERVICE_TOKEN,
        projectName: "OpenBot",
        store: kubernetesKeyStore({
          apiServer: cluster.url,
          namespace: "openbot",
          name: "openbot-intelligence-key",
          token: "sa-token",
        }),
        deadlineMs: 600,
        retryMs: 100,
        log: () => {},
      }),
    ).rejects.toThrow(/did not create OpenBot's project in time/);
    expect(cluster.decoded("openbot-intelligence-key")).toBeUndefined();
  });
});
