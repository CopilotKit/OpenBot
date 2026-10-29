import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  RECORDER_SIGNED_OUT,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import {
  classifyGrantError,
  fetchGrant,
  GrantError,
  type GrantVerdict,
  PASS_HINTS,
} from "../src/offscreen/grant";

const BUSY = "Intelligence is busy or unreachable. Retrying; nothing is lost.";
const MARKETPLACE =
  "Intelligence needs its marketplace licence before it can capture. Retrying; nothing is lost.";

function body(status: number, code: string, message = "m") {
  return { status, body: { code, message } };
}

function hold(verdict: GrantVerdict) {
  expect(verdict.kind).toBe("hold");
  return verdict as Extract<GrantVerdict, { kind: "hold" }>;
}
function park(verdict: GrantVerdict) {
  expect(verdict.kind).toBe("park");
  return verdict as Extract<GrantVerdict, { kind: "park" }>;
}
function retry(verdict: GrantVerdict) {
  expect(verdict.kind).toBe("retry");
  return verdict as Extract<GrantVerdict, { kind: "retry" }>;
}

describe("classifyGrantError, one assertion per pass row of the table", () => {
  test("row 1: the gate's invalid trajectory id is parked", () => {
    const r = TRAJECTORY_GATE_REFUSALS.invalidId;
    const v = park(classifyGrantError(r.status, r));
    expect(v.hint).toBe(
      "Learning capture is off: the Recorder sent Intelligence a request it could not read.",
    );
  });

  test("row 2: RECORDER_SIGNED_OUT is signed-out with its reason", () => {
    for (const reason of ["revoked", "removed", "organization"] as const) {
      expect(
        classifyGrantError(401, { code: RECORDER_SIGNED_OUT, reason }),
      ).toEqual({ kind: "signed-out", reason });
    }
  });

  test("row 3: the gate's forbidden is parked", () => {
    const r = TRAJECTORY_GATE_REFUSALS.forbidden;
    const v = park(classifyGrantError(r.status, r));
    expect(v.hint).toBe(
      "Learning capture is off: your OpenBot account has no role that may record.",
    );
  });

  test("row 4: OpenBot's not found is parked: the recording belongs to another person", () => {
    const b = body(
      404,
      "NOT_FOUND",
      "This trajectory belongs to another recording.",
    );
    const v = park(classifyGrantError(b.status, b.body));
    expect(v.hint).toBe(
      "Learning capture is off: OpenBot says this recording belongs to another person.",
    );
  });

  test("row 4a: the authority being unavailable is retried, honouring Retry-After", () => {
    const r = TRAJECTORY_GATE_REFUSALS.authorityUnavailable;
    const v = retry(classifyGrantError(r.status, r));
    expect(v.reason).toBe(
      "OpenBot could not reach your organization's sign-in. Retrying; nothing is lost.",
    );
    expect(v.retryAfterMs).toBeUndefined();
    expect(
      retry(classifyGrantError(r.status, r, { retryAfter: "7" })).retryAfterMs,
    ).toBe(7000);
  });

  test("row 5: the runtime's invalid trajectory id is parked", () => {
    const v = park(
      classifyGrantError(400, {
        code: "INVALID_REQUEST",
        message: "A valid trajectoryId is required",
      }),
    );
    expect(v.hint).toBe(PASS_HINTS.INVALID_REQUEST);
  });

  test("row 6: IDENTITY_REQUIRED 401 is held, never signed-out", () => {
    const v = hold(classifyGrantError(401, { code: "IDENTITY_REQUIRED" }));
    expect(v.hint).toBe(
      "Learning capture is paused: OpenBot could not tell Intelligence who you are.",
    );
  });

  test("row 7: INTELLIGENCE_RUNTIME_REQUIRED is parked", () => {
    const v = park(
      classifyGrantError(503, { code: "INTELLIGENCE_RUNTIME_REQUIRED" }),
    );
    expect(v.hint).toBe(
      "Learning capture is off: this OpenBot is not connected to Intelligence.",
    );
  });

  test("row 8: could not connect to Intelligence is retried", () => {
    const b = body(
      502,
      "CONNECTION_FAILED",
      "Could not connect to Intelligence",
    );
    expect(retry(classifyGrantError(b.status, b.body)).reason).toBe(BUSY);
  });

  test("row 9: an invalid grant is held", () => {
    const b = body(
      502,
      "CONNECTION_FAILED",
      "Intelligence returned an invalid trajectory connection grant",
    );
    const v = hold(classifyGrantError(b.status, b.body));
    expect(v.hint).toBe(
      "Learning capture is paused: Intelligence answered the capture pass in a form the Recorder cannot use.",
    );
  });

  test("row 10: a rejected request is retried on 5xx, 408 and 429 and held on any other 4xx", () => {
    const message = "Intelligence rejected the trajectory connection request";
    expect(
      retry(classifyGrantError(503, { code: "CONNECTION_FAILED", message }))
        .reason,
    ).toBe(BUSY);
    expect(
      retry(classifyGrantError(429, { code: "CONNECTION_FAILED", message }))
        .reason,
    ).toBe(BUSY);
    expect(
      retry(classifyGrantError(408, { code: "CONNECTION_FAILED", message }))
        .reason,
    ).toBe(BUSY);
    const v = hold(
      classifyGrantError(409, { code: "CONNECTION_FAILED", message }),
    );
    expect(v.hint).toBe(
      "Learning capture is paused: Intelligence refused the capture pass (409).",
    );
  });

  test("row 10: a message that is not text classifies like an unrecognised message and never throws", () => {
    for (const message of [42, {}, null]) {
      const body = { code: "CONNECTION_FAILED", message } as unknown as {
        code: string;
      };
      expect(retry(classifyGrantError(503, body)).reason).toBe(BUSY);
      const v = hold(classifyGrantError(409, body));
      expect(v.hint).toBe(
        "Learning capture is paused: Intelligence refused the capture pass (409).",
      );
    }
  });

  test("row 11: TRAJECTORIES_UNAVAILABLE is parked", () => {
    const v = park(
      classifyGrantError(404, { code: "TRAJECTORIES_UNAVAILABLE" }),
    );
    expect(v.hint).toBe(
      "Learning capture is off: Product Trajectories are turned off in Intelligence (FF_LEARNING_TRAJECTORIES).",
    );
  });

  test("row 12: TRAJECTORIES_NOT_ENABLED 403 is held, never parked", () => {
    const v = hold(
      classifyGrantError(403, { code: "TRAJECTORIES_NOT_ENABLED" }),
    );
    expect(v.hint).toBe(
      "Learning capture is paused: Intelligence says this organization's licence does not include Product Trajectories, that its billing is blocked, or that it could not check right now.",
    );
  });

  test("row 13: VALIDATION_ERROR is parked", () => {
    const v = park(classifyGrantError(400, { code: "VALIDATION_ERROR" }));
    expect(v.hint).toBe(
      "Learning capture is off: Intelligence refused the recording's request.",
    );
  });

  test("row 14: TRAJECTORY_APP_USER_CONFLICT is parked", () => {
    const v = park(
      classifyGrantError(409, { code: "TRAJECTORY_APP_USER_CONFLICT" }),
    );
    expect(v.hint).toBe(
      "Learning capture is off: Intelligence already holds this recording for someone else.",
    );
  });

  test("row 15: LEARNING_CONTAINER_NOT_FOUND is held", () => {
    const v = hold(
      classifyGrantError(404, { code: "LEARNING_CONTAINER_NOT_FOUND" }),
    );
    expect(v.hint).toBe(
      "Learning capture is paused: Intelligence could not find your Learning space.",
    );
  });

  test("row 16: INTERNAL_SERVER_ERROR is retried", () => {
    expect(
      retry(classifyGrantError(500, { code: "INTERNAL_SERVER_ERROR" })).reason,
    ).toBe(BUSY);
  });

  test("row 17: MARKETPLACE_LICENSE_REQUIRED is retried with its own sentence", () => {
    expect(
      retry(classifyGrantError(503, { code: "MARKETPLACE_LICENSE_REQUIRED" }))
        .reason,
    ).toBe(MARKETPLACE);
  });

  test("row 18: 429 and 408 retry whatever the body says, and Retry-After becomes milliseconds", () => {
    const v = retry(
      classifyGrantError(
        429,
        { code: "RATE_LIMIT_EXCEEDED" },
        { retryAfter: "3" },
      ),
    );
    expect(v.reason).toBe(BUSY);
    expect(v.retryAfterMs).toBe(3000);
    expect(retry(classifyGrantError(408, null)).reason).toBe(BUSY);
    expect(retry(classifyGrantError(429, { code: "FORBIDDEN" })).reason).toBe(
      BUSY,
    );
    expect(
      retry(classifyGrantError(429, null, { retryAfter: "soon" })).retryAfterMs,
    ).toBeUndefined();
  });

  test("row 19: a 404 with no code, or a 405, is parked with the row 1 sentence", () => {
    expect(park(classifyGrantError(404, null)).hint).toBe(
      PASS_HINTS.INVALID_REQUEST,
    );
    expect(park(classifyGrantError(405, null)).hint).toBe(
      PASS_HINTS.INVALID_REQUEST,
    );
  });

  test("row 20: a 500 with no code is retried", () => {
    expect(retry(classifyGrantError(500, null)).reason).toBe(BUSY);
  });

  test("row 21: a network failure, an OpenBot 5xx and a body that is not JSON retry", () => {
    expect(retry(classifyGrantError(null, null)).reason).toBe(BUSY);
    expect(retry(classifyGrantError(502, null)).reason).toBe(BUSY);
  });

  test("row 22: any other 401 is held", () => {
    expect(hold(classifyGrantError(401, null)).hint).toBe(
      "Learning capture is paused: OpenBot refused the capture pass.",
    );
  });

  test("row 2: a 401 RECORDER_SIGNED_OUT with no reason, or an unrecognised one, is a revoked sign-out", () => {
    expect(classifyGrantError(401, { code: RECORDER_SIGNED_OUT })).toEqual({
      kind: "signed-out",
      reason: "revoked",
    });
    expect(
      classifyGrantError(401, {
        code: RECORDER_SIGNED_OUT,
        reason: "no-such-reason",
      } as never),
    ).toEqual({ kind: "signed-out", reason: "revoked" });
  });

  test("row 23: the gateway-policy sentence is fixed for the streamer's check", () => {
    expect(PASS_HINTS.GATEWAY_NOT_ALLOWED).toBe(
      "Learning capture is off: the capture pass pointed at an Intelligence address your organization does not allow.",
    );
  });

  test("row 23a: unknown answers are held, except 5xx which retry", () => {
    expect(hold(classifyGrantError(403, null)).hint).toBe(
      "Learning capture is paused: the capture pass got an answer the Recorder does not know (403).",
    );
    expect(hold(classifyGrantError(413, null)).hint).toContain("(413)");
    expect(retry(classifyGrantError(504, null)).reason).toBe(BUSY);
    expect(
      hold(classifyGrantError(200, { code: "OK" } as never)).hint,
    ).toContain("(200)");
    expect(hold(classifyGrantError(418, { code: "TEAPOT" })).hint).toContain(
      "(418)",
    );
  });

  test("the server's own message never reaches a hint or a reason", () => {
    const text = "SECRET server text";
    const verdicts = [
      classifyGrantError(400, { code: "INVALID_REQUEST", message: text }),
      classifyGrantError(403, {
        code: "TRAJECTORIES_NOT_ENABLED",
        message: text,
      }),
      classifyGrantError(503, {
        code: "MARKETPLACE_LICENSE_REQUIRED",
        message: text,
      }),
      classifyGrantError(418, { message: text }),
    ];
    expect(JSON.stringify(verdicts)).not.toContain(text);
  });
});

describe("fetchGrant", () => {
  let server: ReturnType<typeof Bun.serve>;
  let openbotUrl = "";
  let seen: {
    auth: string | null;
    bot: string | null;
    body: string;
    path: string;
  } | null = null;
  let respond: () => Response = () => new Response(null, { status: 500 });

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen = {
          auth: request.headers.get("authorization"),
          bot: request.headers.get("x-openbot-recorder-bot"),
          body: await request.text(),
          path: new URL(request.url).pathname,
        };
        return respond();
      },
    });
    openbotUrl = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const target = () => ({ openbotUrl, token: "tok" });
  const id = "0b8b3c34-7c0e-4f7b-8f0a-9d7e4a2f1c11";

  async function failure(): Promise<GrantVerdict> {
    try {
      await fetchGrant(target(), id);
    } catch (error) {
      if (error instanceof GrantError) return error.verdict;
      throw error;
    }
    throw new Error("fetchGrant did not fail");
  }

  test("posts {} with the bearer and no Bot, and returns the grant", async () => {
    const grant = {
      joinToken: "j",
      realtime: { clientUrl: "wss://i.example/client", topic: "trajectory:1" },
    };
    respond = () => Response.json(grant);
    expect(await fetchGrant(target(), id)).toEqual(grant);
    expect(seen).toEqual({
      auth: "Bearer tok",
      bot: null,
      body: "{}",
      path: `/api/copilotkit/trajectory/${id}/connect`,
    });
  });

  test("a refusal throws a GrantError carrying the row's verdict", async () => {
    respond = () =>
      Response.json(
        { code: "TRAJECTORIES_NOT_ENABLED", message: "x" },
        { status: 403 },
      );
    expect((await failure()).kind).toBe("hold");
    respond = () =>
      Response.json(
        { code: RECORDER_SIGNED_OUT, reason: "revoked", error: "gone" },
        { status: 401 },
      );
    expect(await failure()).toEqual({ kind: "signed-out", reason: "revoked" });
    respond = () =>
      Response.json(
        { code: "X" },
        { status: 429, headers: { "Retry-After": "2" } },
      );
    expect(await failure()).toMatchObject({
      kind: "retry",
      retryAfterMs: 2000,
    });
  });

  test("a 200 that is not a grant is held (row 23a)", async () => {
    respond = () => Response.json({ ok: true });
    expect((await failure()).kind).toBe("hold");
  });

  test("a 200 whose body is not JSON retries (row 21)", async () => {
    respond = () => new Response("<html>", { status: 200 });
    expect(await failure()).toEqual({ kind: "retry", reason: BUSY });
  });

  test("a body that is not JSON on a 5xx retries (row 21)", async () => {
    respond = () => new Response("<html>", { status: 502 });
    expect((await failure()).kind).toBe("retry");
  });

  test("an unreachable OpenBot retries (row 21)", async () => {
    const dead = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    try {
      await fetchGrant({ openbotUrl: url, token: "t" }, id);
      throw new Error("did not fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GrantError);
      expect((error as GrantError).verdict.kind).toBe("retry");
    }
  });
});
