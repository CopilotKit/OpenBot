import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";

/**
 * Testing an address this deployment runs itself.
 *
 * The managed Bot, and any harness picked during setup, refuse every call that does not carry the
 * deployment's own token — and nobody types that token anywhere. The run path attaches it by
 * recognising the address as one of its own. The test button did not, so it knocked with no key,
 * got a 401, and reported "The agent refused this request. If it needs a key, add it as a header."
 * about a Bot that works perfectly.
 *
 * That is the one case where a wrong answer costs the most. The address was filled in by this
 * deployment rather than typed by the person reading the verdict, so they have no way to tell a
 * real refusal from this one, and the advice it offers — add a key — is advice to break it.
 */
describe("testing an address this deployment runs", () => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "user@openbot.test",
      role: "user",
    });
    await next();
  };

  const TOKEN = "deployment-token";

  /** A stand-in for `agent-antigravity`: the deployment's token, or 401. */
  function gatedAgent() {
    return Bun.serve({
      port: 0,
      fetch: (request: Request) =>
        request.headers.get("x-openbot-agent-token") === TOKEN
          ? new Response('data: {"type":"RUN_STARTED"}\n\n', {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response("unauthorised", { status: 401 }),
    });
  }

  function appFor(endpoints: readonly string[]) {
    return createAgentRoutes(
      {} as never,
      requireUser,
      true,
      undefined,
      new Set(),
      undefined,
      true,
      endpoints[0],
      undefined,
      { token: TOKEN, endpoints },
    );
  }

  async function probe(
    app: ReturnType<typeof createAgentRoutes>,
    endpoint: string,
  ) {
    const response = await app.request("http://openbot.test/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return (await response.json()) as { ok: boolean; status?: number };
  }

  test("knocks with the token the real run would use", async () => {
    const agent = gatedAgent();
    const endpoint = `http://127.0.0.1:${agent.port}/`;
    try {
      expect(await probe(appFor([endpoint]), endpoint)).toMatchObject({
        ok: true,
      });
    } finally {
      agent.stop(true);
    }
  });

  test("a trailing slash is not a different address", async () => {
    // The run path treats these as the same address. A test that did not would answer 401 for an
    // endpoint this deployment is about to dial successfully.
    const agent = gatedAgent();
    const stored = `http://127.0.0.1:${agent.port}`;
    try {
      expect(await probe(appFor([stored]), `${stored}/`)).toMatchObject({
        ok: true,
      });
    } finally {
      agent.stop(true);
    }
  });

  test("a harness picked during setup is ours too", async () => {
    // Two addresses this deployment runs: the Bot in the box and the harness started beside it.
    // Matching only the first is the bug this list exists to prevent, and it is the one the run
    // path already had to fix.
    const agent = gatedAgent();
    const picked = `http://127.0.0.1:${agent.port}/`;
    try {
      const app = appFor(["http://127.0.0.1:1/", picked]);
      expect(await probe(app, picked)).toMatchObject({ ok: true });
    } finally {
      agent.stop(true);
    }
  });

  test("somebody else's address is never handed our token", async () => {
    // The whole value of the token is that it is this deployment's. An address it does not run
    // must be knocked on exactly as before, however the person spelled the url.
    let offered: string | null = null;
    const agent = Bun.serve({
      port: 0,
      fetch: (request: Request) => {
        offered = request.headers.get("x-openbot-agent-token");
        return new Response('data: {"type":"RUN_STARTED"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const app = appFor(["http://127.0.0.1:1/"]);
      await probe(app, `http://127.0.0.1:${agent.port}/`);
      expect(offered).toBeNull();
    } finally {
      agent.stop(true);
    }
  });

  test("a deployment with no managed Bot is unchanged", async () => {
    // Nothing to recognise and no token to offer: the probe goes out bare, as it always did.
    let offered: string | null = null;
    const agent = Bun.serve({
      port: 0,
      fetch: (request: Request) => {
        offered = request.headers.get("x-openbot-agent-token");
        return new Response('data: {"type":"RUN_STARTED"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const app = createAgentRoutes({} as never, requireUser, true);
      await probe(app, `http://127.0.0.1:${agent.port}/`);
      expect(offered).toBeNull();
    } finally {
      agent.stop(true);
    }
  });
});
