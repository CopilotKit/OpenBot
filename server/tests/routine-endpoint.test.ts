import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { RoutineRunner } from "../src/routines/runner";
import { testEnvironment } from "./support/environment";

/**
 * `/internal/routines/run` is the one door the worker gets: no session, no cookie, one bearer
 * secret, and a route that does not exist at all unless a runner was actually built. See
 * server/src/app.ts and server/src/config.ts.
 */

const SECRET = "worker-shared-secret";

function stubRunner(): { runner: RoutineRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    runner: {
      run: (id: string) => {
        calls.push(id);
        return Promise.resolve();
      },
    },
    calls,
  };
}

/**
 * `createApp` is an 18-parameter-and-growing positional function; everything after `config` is
 * optional. Building the argument list explicitly, once, keeps every call site here honest about
 * which slot `routineRunner` (the last one) actually lands in.
 */
function buildApp(
  environment: Record<string, string | undefined>,
  runner: RoutineRunner | undefined,
) {
  const args: Parameters<typeof createApp> = [
    loadConfig(environment),
    undefined, // auth
    undefined, // roleRepository
    undefined, // auditReader
    undefined, // credentialService
    undefined, // packageStatusReader
    undefined, // copilotHandler
    undefined, // computerGateway
    undefined, // computerPolicy
    undefined, // agentProfileStore
    undefined, // channelStore
    undefined, // channelEvents
    undefined, // auditStore
    undefined, // componentStore
    undefined, // pluginStore
    undefined, // sandboxedStore
    undefined, // threadIdentity
    undefined, // peopleStore
    undefined, // identityProviders
    undefined, // intentRouter
    undefined, // pageFrames
    runner,
  ];
  return createApp(...args);
}

function appWithSecret(runner?: RoutineRunner) {
  return buildApp(
    { ...testEnvironment(), WORKER_SHARED_SECRET: SECRET },
    runner,
  );
}

function appWithoutSecret(runner?: RoutineRunner) {
  return buildApp(
    { ...testEnvironment(), WORKER_SHARED_SECRET: undefined },
    runner,
  );
}

async function post(
  app: ReturnType<typeof appWithSecret>,
  init: RequestInit = {},
) {
  return app.request("http://openbot.local/internal/routines/run", {
    method: "POST",
    ...init,
  });
}

describe("POST /internal/routines/run", () => {
  test("401s with no authorization header", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
  });

  test("401s with the wrong bearer secret", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
    });

    expect(response.status).toBe(401);
  });

  test(
    "401s, byte-identically to a wrong secret, when no secret is configured " +
      "even with a correct-looking header",
    async () => {
      const { runner } = stubRunner();

      const wrongSecretResponse = await post(appWithSecret(runner), {
        body: JSON.stringify({ routineRunId: "run-1" }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        },
      });
      const noSecretResponse = await post(appWithoutSecret(runner), {
        body: JSON.stringify({ routineRunId: "run-1" }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`,
        },
      });

      expect(noSecretResponse.status).toBe(401);
      expect(noSecretResponse.status).toBe(wrongSecretResponse.status);
      await expect(noSecretResponse.json()).resolves.toEqual(
        await wrongSecretResponse.json(),
      );
    },
  );

  test("400s with the right secret and no routineRunId", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(400);
  });

  test("400s with the right secret and a non-string routineRunId", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: 12345 }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(400);
  });

  test("202s with the right secret and a routineRunId, running it exactly once", async () => {
    const { runner, calls } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: "run-42" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    // The response is 202 before the turn runs, so give the fire-and-forget call a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["run-42"]);
  });

  test("requires no session or cookie: a bearer header alone is accepted", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(202);
  });

  test("the route does not exist at all when no runner was built", async () => {
    const response = await post(appWithSecret(undefined), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(404);
  });
});
