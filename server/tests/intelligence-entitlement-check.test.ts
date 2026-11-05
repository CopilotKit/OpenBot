import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";
import { createIntelligenceClient } from "../src/intelligence-client";
import {
  entitlementWarning,
  reportIntelligenceEntitlement,
} from "../src/intelligence-entitlement-check";
import type { RuntimeEntitlementResponse } from "../src/self-host-banner";

/** A clock that moves only when the code under test sleeps, so a ten-minute wait takes no time. */
function fakeClock() {
  let at = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}

function ready(active = true): RuntimeEntitlementResponse {
  return {
    status: "ready",
    entitlement: {
      active,
      source: "selfHostedDeploymentLicense",
      features: {},
      limits: {},
      planCode: "enterprise",
    },
  };
}

function notReady(
  status: "degraded" | "misconfigured" | "unavailable",
  code: string,
  message = "not ready",
): RuntimeEntitlementResponse {
  return { status, error: { code, message, retryable: false } };
}

describe("what Intelligence's entitlement answer means for this deployment", () => {
  test("ready and active says nothing", () => {
    expect(entitlementWarning(ready())).toBeNull();
  });

  test("ready but inactive is reported", () => {
    expect(entitlementWarning(ready(false))).toMatchObject({
      status: "inactive",
    });
  });

  test("an unlicensed self-hosted Intelligence names where the licence goes", () => {
    // The state a self-hosted deployment reaches when OpenBot has the licence and Intelligence does
    // not: memory is refused with nothing in OpenBot's log saying why.
    const warning = entitlementWarning(
      notReady(
        "misconfigured",
        "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
        "Self-hosted license configuration is missing or invalid.",
      ),
    );
    expect(warning).toMatchObject({
      type: "intelligence-entitlement-not-ready",
      status: "misconfigured",
      code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
      message: "Self-hosted license configuration is missing or invalid.",
    });
    expect(warning?.fix).toContain("Intelligence's own deployment");
    expect(warning?.fix).toContain("appApi.licenseSecret");
    expect(warning?.fix).toContain("memory");
  });

  test("an expired licence says to renew it", () => {
    expect(
      entitlementWarning(
        notReady("misconfigured", "RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED"),
      )?.fix,
    ).toContain("expired");
  });

  test("an unknown code still says what it costs", () => {
    expect(
      entitlementWarning(notReady("unavailable", "SOMETHING_NEW"))?.fix,
    ).toContain("memory");
  });

  /*
   * The code is Intelligence's string, not ours, so a code borrowed from `Object.prototype` is as
   * unknown as any other and deserves the same sentence. Looked up in a plain object, `toString` is
   * answered with a function, which is truthy and so wins the `||` fallback — leaving `fix` a
   * function where a sentence belongs, and a warning that says nothing wherever it is shown.
   */
  test("a code borrowed from Object.prototype is unknown like any other", () => {
    for (const code of ["toString", "constructor", "valueOf"]) {
      const fix = entitlementWarning(notReady("unavailable", code))?.fix;
      expect(typeof fix).toBe("string");
      expect(fix).toContain("memory");
    }
  });
});

describe("reporting it at boot", () => {
  test("logs one line when the answer is not ready", async () => {
    const lines: string[] = [];
    await reportIntelligenceEntitlement({
      entitlements: async () =>
        notReady(
          "misconfigured",
          "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
        ),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "intelligence-entitlement-not-ready",
      code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    });
  });

  test("logs nothing when ready", async () => {
    const lines: string[] = [];
    await reportIntelligenceEntitlement({
      entitlements: async () => ready(),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(0);
  });

  test("an unreachable Intelligence is waited for, then reported, and does not throw", async () => {
    const lines: string[] = [];
    const notes: string[] = [];
    const clock = fakeClock();
    await reportIntelligenceEntitlement({
      entitlements: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (line) => lines.push(line),
      note: (line) => notes.push(line),
      ...clock,
    });
    expect(notes).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "intelligence-entitlement-unreadable",
      reason: "connect ECONNREFUSED",
      waitedMinutes: 10,
    });
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBe(10 * 60_000);
  });
});

const RUNTIME_KEY =
  "cpk-openbot_abcdefgh12345678_abcdefghijklmnopqrstuvwxyz012345";

/** Intelligence's REST error body: `createErrorResponseBody` (apps/app-api/src/errors/http-error-response.ts). */
function errorBody(
  code: string,
  message: string,
  category: string,
  retryable: boolean,
) {
  return {
    error: { code, message, category, retryable },
    requestId: "request-test",
    traceId: "trace-test",
  };
}

/**
 * `resolveSelfHostedEntitlements` (apps/app-api/src/routes/entitlements-routes.ts) for a valid
 * enterprise licence: boolean claims become features, numeric ones limits.
 */
const READY = {
  status: "ready",
  entitlement: {
    active: true,
    source: "selfHostedDeploymentLicense",
    features: { memory: true, learning: true },
    limits: { "threads.retention_hours": 720 },
    planCode: "enterprise",
    entitlementSource: "enterprise_override",
  },
};
/** The same route with no licence on Intelligence's deployment: `diagnosticResponse`. */
const UNLICENSED = {
  status: "misconfigured",
  error: {
    code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    message: "Self-hosted license configuration is missing or invalid.",
    retryable: false,
    requestId: "request-test",
    traceId: "trace-test",
  },
};

/**
 * Intelligence's `GET /api/entitlements/runtime` over real HTTP, as a first install of OpenBot's Helm
 * bundle meets it. While the migrations Job runs, every request fails reading a table that is not
 * there yet and Express answers 500 `INTERNAL_SERVER_ERROR`; between the migrations and the bootstrap
 * Job, which stores the runtime key, the key is not found and the route answers 401
 * `AUTH_UNAUTHENTICATED` (apps/app-api/src/errors/registry.ts); after both, the route's own answer.
 */
function startingIntelligence(
  options: { migrating?: number; keyless?: number; answer?: unknown } = {},
) {
  const statuses: number[] = [];
  const migrating = options.migrating ?? 0;
  const keyless = options.keyless ?? 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const answered = statuses.length;
      const respond = (status: number, body: unknown) => {
        statuses.push(status);
        return Response.json(body, { status });
      };
      if (new URL(request.url).pathname !== "/api/entitlements/runtime")
        return respond(
          404,
          errorBody("ROUTE_NOT_FOUND", "Route not found.", "not_found", false),
        );
      if (answered < migrating)
        return respond(
          500,
          errorBody(
            "INTERNAL_SERVER_ERROR",
            "Unexpected server error.",
            "internal",
            true,
          ),
        );
      if (
        answered < migrating + keyless ||
        request.headers.get("authorization") !== `Bearer ${RUNTIME_KEY}`
      )
        return respond(
          401,
          errorBody(
            "AUTH_UNAUTHENTICATED",
            "Authentication is required.",
            "auth",
            false,
          ),
        );
      return respond(200, options.answer ?? READY);
    },
  });
  const settings = {
    apiUrl: `http://127.0.0.1:${server.port}`,
    gatewayWsUrl: "ws://127.0.0.1:9",
    apiKey: RUNTIME_KEY,
  };
  return { settings, statuses, stop: () => server.stop(true) };
}

/*
 * Kink 17 of the Helm bundle build. OpenBot's server is up before Intelligence's migrations run,
 * by design, and the boot check used to ask once: every first install logged
 * `intelligence-entitlement-unreadable` (status 500) about a licence that was fine, under the runtime
 * client's own multi-line dump of the failed read, and never looked again. These run the boot check
 * as the server wires it: the real runtime client and a real HTTP server.
 */
describe("the boot check on a first install, while Intelligence is still starting", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    mock.restore();
    clearDesktopConnectionFailure("intelligence");
  });

  async function boot(
    intelligence: ReturnType<typeof startingIntelligence>,
    windowMs?: number,
  ) {
    stops.push(intelligence.stop);
    // The runtime client prints a failed read with console.error; none may reach the log.
    const printed = spyOn(console, "error").mockImplementation(() => {});
    const lines: string[] = [];
    const notes: string[] = [];
    const clock = fakeClock();
    const client = createIntelligenceClient(intelligence.settings);
    await reportIntelligenceEntitlement({
      entitlements: () => client.getRuntimeEntitlements(),
      log: (line) => lines.push(line),
      note: (line) => notes.push(line),
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...clock,
    });
    return {
      lines: lines.map((line) => JSON.parse(line)),
      notes: notes.map((line) => JSON.parse(line)),
      printed: printed.mock.calls,
      slept: clock.slept,
    };
  }

  test("the migrations are waited out quietly, and a good licence then says nothing", async () => {
    const intelligence = startingIntelligence({ migrating: 3 });
    const found = await boot(intelligence);
    expect(found.lines).toEqual([]);
    expect(found.notes).toEqual([
      expect.objectContaining({
        type: "intelligence-entitlement-waiting",
        reason: "Runtime entitlement request failed with status 500",
      }),
    ]);
    expect(found.printed).toEqual([]);
    // Three refusals, then whether it answers and the runtime client's own read of the answer.
    expect(intelligence.statuses).toEqual([500, 500, 500, 200, 200]);
  });

  test("what Intelligence answers once it is up is reported as it is", async () => {
    const found = await boot(
      startingIntelligence({ migrating: 2, answer: UNLICENSED }),
    );
    expect(found.lines).toEqual([
      expect.objectContaining({
        type: "intelligence-entitlement-not-ready",
        status: "misconfigured",
        code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
      }),
    ]);
    expect(found.printed).toEqual([]);
  });

  test("the key refused between the migrations and the bootstrap is waited out too", async () => {
    const intelligence = startingIntelligence({ migrating: 2, keyless: 2 });
    const found = await boot(intelligence);
    expect(found.lines).toEqual([]);
    expect(found.notes).toHaveLength(1);
    expect(intelligence.statuses).toEqual([500, 500, 401, 401, 200, 200]);
  });

  test("a key refused by an Intelligence that is up is reported at once", async () => {
    const intelligence = startingIntelligence();
    intelligence.settings.apiKey =
      "cpk-openbot_zzzzzzzz12345678_abcdefghijklmnopqrstuvwxyz012345";
    const found = await boot(intelligence);
    expect(found.lines).toEqual([
      {
        type: "intelligence-entitlement-unreadable",
        reason:
          "Intelligence refused this deployment's INTELLIGENCE_API_KEY (HTTP 401).",
        status: 401,
      },
    ]);
    expect(found.notes).toEqual([]);
    expect(found.slept).toEqual([]);
    expect(found.printed).toEqual([]);
    expect(intelligence.statuses).toEqual([401]);
  });

  test("an Intelligence still not answering when the window closes is reported once", async () => {
    const intelligence = startingIntelligence();
    intelligence.stop();
    const found = await boot(intelligence, 60_000);
    expect(found.notes).toHaveLength(1);
    expect(found.lines).toEqual([
      expect.objectContaining({
        type: "intelligence-entitlement-unreadable",
        reason: expect.stringContaining("Intelligence did not answer"),
        waitedMinutes: 1,
      }),
    ]);
    expect(found.slept.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
    expect(found.printed).toEqual([]);
  });
});
