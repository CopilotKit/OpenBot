import { describe, expect, test } from "bun:test";
import {
  RECORDER_SIGNED_OUT,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import type { AuditEventInput } from "../src/audit";
import type {
  RecorderActor,
  RecorderResolution,
  RecorderResolver,
} from "../src/recorder/guard";
import {
  createTrajectoryConnectHook,
  createTrajectoryRefusalAudit,
  isTrajectoryConnectPath,
} from "../src/recorder/trajectory-gate";

const TRAJECTORY = "0b6c1c0e-6f0a-4f6e-9a55-1d1c2f3f4a5b";
const PERSON = "person-1";
const OTHER = "person-2";
const BOT = "bot-1";

type Refusal = Parameters<
  Parameters<typeof createTrajectoryConnectHook>[0]["audit"]
>[0];

const actor: RecorderActor = {
  id: PERSON,
  name: "Ada",
  email: "ada@example.com",
  image: null,
  role: "user",
  connectionId: "connection-1",
};

function setup(
  options: {
    bearer?: RecorderResolution;
    /** Existing bindings: trajectory id to person. */
    bound?: Record<string, string>;
  } = {},
) {
  const bearer = "bearer" in options ? options.bearer : { actor };
  const bound = new Map(Object.entries(options.bound ?? {}));
  const asked: string[] = [];
  const refusals: Refusal[] = [];
  const resolveRecorder: RecorderResolver = async () => bearer ?? null;
  const hook = createTrajectoryConnectHook({
    resolveRecorder,
    bind: async ({ trajectoryId, userId }) => {
      asked.push(`bind ${trajectoryId}:${userId}`);
      const existing = bound.get(trajectoryId);
      if (existing === undefined) bound.set(trajectoryId, userId);
      return existing === undefined || existing === userId;
    },
    audit: (refusal) => refusals.push(refusal),
  });
  const run = async (
    route: Parameters<typeof hook>[0]["route"],
    headers: Record<string, string> = {},
  ) => {
    const request = new Request("http://127.0.0.1/api/copilotkit/x", {
      method: "POST",
      headers,
    });
    try {
      await hook({
        request,
        path: "/api/copilotkit/x",
        runtime: {} as never,
        route,
      });
      return null;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };
  const connect = (
    trajectoryId = TRAJECTORY,
    headers?: Record<string, string>,
  ) => run({ method: "trajectory/connect", trajectoryId }, headers);
  return { run, connect, asked, refusals, bound };
}

async function bodyOf(response: Response | null) {
  return (await response?.json()) as Record<string, unknown>;
}

describe("createTrajectoryConnectHook", () => {
  test("passes every other route without a question", async () => {
    const { run, asked, refusals } = setup();

    expect(await run({ method: "agent/run", agentId: BOT })).toBeNull();
    expect(await run({ method: "info" })).toBeNull();
    expect(asked).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("answers 400 for an id that is not a UUID before any question", async () => {
    const { connect, asked, refusals } = setup();

    const response = await connect("not-a-uuid");

    expect(response?.status).toBe(400);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      code: TRAJECTORY_GATE_REFUSALS.invalidId.code,
      message: TRAJECTORY_GATE_REFUSALS.invalidId.message,
    });
    expect(asked).toEqual([]);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["invalid-id"]);
  });

  test("answers 401 RECORDER_SIGNED_OUT with the reason for a bearer that does not resolve", async () => {
    for (const [refused, reason] of [
      ["unknown", "revoked"],
      ["malformed", "revoked"],
      ["removed", "removed"],
      ["organization", "organization"],
    ] as const) {
      const { connect, asked, refusals } = setup({
        bearer: { refused, userId: PERSON },
      });

      const response = await connect();

      expect(response?.status).toBe(401);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const body = await bodyOf(response);
      expect(body.code).toBe(RECORDER_SIGNED_OUT);
      expect(body.reason).toBe(reason);
      expect(typeof body.message).toBe("string");
      expect(asked).toEqual([]);
      expect(refusals).toEqual([
        { reason: "signed-out", trajectoryId: TRAJECTORY, userId: PERSON },
      ]);
    }
  });

  test("answers 403 FORBIDDEN for a person without a role", async () => {
    const { connect, refusals } = setup({
      bearer: { refused: "forbidden", userId: PERSON },
    });

    const response = await connect();

    expect(response?.status).toBe(403);
    expect(await bodyOf(response)).toEqual({
      code: TRAJECTORY_GATE_REFUSALS.forbidden.code,
      message: TRAJECTORY_GATE_REFUSALS.forbidden.message,
    });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["forbidden"]);
  });

  test("answers 503 when the organization could not answer, never a sign-out", async () => {
    const { connect, refusals } = setup({ bearer: { unavailable: true } });

    const response = await connect();

    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      code: TRAJECTORY_GATE_REFUSALS.authorityUnavailable.code,
      message: TRAJECTORY_GATE_REFUSALS.authorityUnavailable.message,
    });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["unavailable"]);
  });

  test("answers 401 IDENTITY_REQUIRED without a Recorder bearer, whatever else the request carries", async () => {
    const { connect, asked, refusals } = setup({ bearer: null });

    const response = await connect(TRAJECTORY, {
      cookie: "better-auth.session_token=signed-in",
    });

    expect(response?.status).toBe(401);
    expect(await bodyOf(response)).toEqual({
      code: "IDENTITY_REQUIRED",
      message: "Connect this browser to OpenBot to record.",
    });
    expect(asked).toEqual([]);
    expect(refusals).toEqual([
      { reason: "signed-out", trajectoryId: TRAJECTORY, userId: null },
    ]);
  });

  test("needs no Bot: a pass with no Bot named binds the trajectory to the person", async () => {
    const { connect, asked, refusals, bound } = setup();

    expect(await connect()).toBeNull();
    expect(asked).toEqual([`bind ${TRAJECTORY}:${PERSON}`]);
    expect(bound.get(TRAJECTORY)).toBe(PERSON);
    expect(refusals).toEqual([]);
  });

  test("ignores a Bot header an older Recorder still sends: the trajectory is the person's", async () => {
    const { connect, bound, refusals } = setup();

    expect(
      await connect(TRAJECTORY, {
        "x-openbot-recorder-bot": "someone-elses-bot",
      }),
    ).toBeNull();
    expect(bound.get(TRAJECTORY)).toBe(PERSON);
    expect(refusals).toEqual([]);
  });

  test("lets the same person through again, for a reconnect's fresh pass", async () => {
    const { connect, refusals } = setup({
      bound: { [TRAJECTORY]: PERSON },
    });

    expect(await connect()).toBeNull();
    expect(await connect()).toBeNull();
    expect(refusals).toEqual([]);
  });

  test("answers 404 for a trajectory bound to another person", async () => {
    const { connect, refusals, bound } = setup({
      bound: { [TRAJECTORY]: OTHER },
    });

    const response = await connect();

    expect(response?.status).toBe(404);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      code: "NOT_FOUND",
      message: "This trajectory belongs to another recording.",
    });
    expect(bound.get(TRAJECTORY)).toBe(OTHER);
    expect(refusals).toEqual([
      { reason: "bound-elsewhere", trajectoryId: TRAJECTORY, userId: PERSON },
    ]);
  });
});

describe("isTrajectoryConnectPath", () => {
  test("matches the runtime's unanchored shape", () => {
    expect(
      isTrajectoryConnectPath(
        `/api/copilotkit/trajectory/${TRAJECTORY}/connect`,
      ),
    ).toBe(true);
    expect(
      isTrajectoryConnectPath(
        `/api/copilotkit/x/trajectory/${TRAJECTORY}/connect`,
      ),
    ).toBe(true);
    expect(
      isTrajectoryConnectPath(
        `/api/copilotkit/trajectory/${TRAJECTORY}/connect/`,
      ),
    ).toBe(true);
    expect(isTrajectoryConnectPath("/api/copilotkit/agent/a/run")).toBe(false);
    expect(
      isTrajectoryConnectPath(`/api/copilotkit/trajectory/${TRAJECTORY}/stop`),
    ).toBe(false);
  });

  test("honours a base path the way the runtime does", () => {
    const path = `/api/copilotkit/trajectory/${TRAJECTORY}/connect`;

    expect(isTrajectoryConnectPath(path, "/api/copilotkit")).toBe(true);
    expect(isTrajectoryConnectPath(path, "/elsewhere")).toBe(false);
    expect(isTrajectoryConnectPath(path, "/api/copilot")).toBe(false);
  });
});

describe("createTrajectoryRefusalAudit", () => {
  function audit() {
    const rows: AuditEventInput[] = [];
    const clock = { now: 9_000_000 };
    const sink = createTrajectoryRefusalAudit(
      {
        insert: async (event) => {
          rows.push(event);
        },
      },
      { now: () => clock.now },
    );
    return { rows, clock, sink };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const refusal = (overrides: Partial<Refusal> = {}): Refusal => ({
    reason: "bound-elsewhere",
    trajectoryId: TRAJECTORY,
    userId: PERSON,
    ...overrides,
  });

  test("writes one row per person, trajectory and reason in a minute", async () => {
    const { rows, clock, sink } = audit();

    sink(refusal());
    clock.now += 30_000;
    sink(refusal());
    await settle();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "recorder.trajectory_refused",
      targetId: TRAJECTORY,
      actorUserId: PERSON,
      payload: { reason: "bound-elsewhere" },
    });
  });

  test("writes again after the minute, and for another reason or person", async () => {
    const { rows, clock, sink } = audit();

    sink(refusal());
    sink(refusal({ reason: "signed-out" }));
    sink(refusal({ userId: OTHER }));
    clock.now += 60_000;
    sink(refusal());
    await settle();

    expect(rows).toHaveLength(4);
  });

  test("a refusal nobody can be named for is the deployment's", async () => {
    const { rows, sink } = audit();

    sink(refusal({ userId: null }));
    await settle();

    expect(rows).toHaveLength(1);
    const row = rows[0] as { actorUserId?: string; initiator?: unknown };
    expect(row.actorUserId).toBeUndefined();
    expect(row.initiator).toEqual({ kind: "deployment" });
  });

  test("anonymous callers write one row per reason a minute however many trajectory ids they invent", async () => {
    const { rows, clock, sink } = audit();
    const invent = (reason: Refusal["reason"]) => {
      for (let i = 0; i < 50; i++) {
        sink(
          refusal({
            userId: null,
            reason,
            trajectoryId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          }),
        );
      }
    };

    invent("unavailable");
    invent("signed-out");
    await settle();
    expect(rows).toHaveLength(2);

    clock.now += 60_000;
    invent("unavailable");
    await settle();
    expect(rows).toHaveLength(3);
  });

  test("a known person still dedupes per trajectory id", async () => {
    const { rows, sink } = audit();

    sink(refusal({ trajectoryId: "a" }));
    sink(refusal({ trajectoryId: "b" }));
    sink(refusal({ trajectoryId: "a" }));
    await settle();

    expect(rows).toHaveLength(2);
  });

  test("a store that cannot be written to is not fatal", async () => {
    const sink = createTrajectoryRefusalAudit({
      insert: async () => {
        throw new Error("database down");
      },
    });

    expect(() => sink(refusal())).not.toThrow();
    await settle();
  });

  test("writes nothing without an audit store", () => {
    expect(() =>
      createTrajectoryRefusalAudit(undefined)(refusal()),
    ).not.toThrow();
  });
});
