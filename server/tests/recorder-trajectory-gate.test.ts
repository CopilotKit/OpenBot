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
  type TrajectoryOwner,
} from "../src/recorder/trajectory-gate";

const TRAJECTORY = "0b6c1c0e-6f0a-4f6e-9a55-1d1c2f3f4a5b";
const PERSON = "person-1";
const OTHER = "person-2";

type Owner = Awaited<ReturnType<TrajectoryOwner>>;
type Refusal = Parameters<
  Parameters<typeof createTrajectoryConnectHook>[0]["audit"]
>[0];

const openOwner = (overrides: Partial<NonNullable<Owner>> = {}): Owner => ({
  demonstrationId: "demo-1",
  botId: "bot-1",
  status: "recording",
  source: "extension",
  closedAt: null,
  ...overrides,
});

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
    session?: string | null;
    owners?: Record<string, Owner>;
  } = {},
) {
  const bearer = "bearer" in options ? options.bearer : null;
  const owners = options.owners ?? { [`${PERSON}:${TRAJECTORY}`]: openOwner() };
  const ownerCalls: string[] = [];
  const refusals: Refusal[] = [];
  const resolveRecorder: RecorderResolver = async () => bearer ?? null;
  const hook = createTrajectoryConnectHook({
    resolveRecorder,
    sessionActorId: async () =>
      "session" in options ? (options.session ?? null) : null,
    trajectoryOwner: async (userId, trajectoryId) => {
      ownerCalls.push(`${userId}:${trajectoryId}`);
      return owners[`${userId}:${trajectoryId}`] ?? null;
    },
    audit: (refusal) => refusals.push(refusal),
  });
  const run = async (route: Parameters<typeof hook>[0]["route"]) => {
    const request = new Request("http://127.0.0.1/api/copilotkit/x", {
      method: "POST",
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
  const connect = (trajectoryId = TRAJECTORY) =>
    run({ method: "trajectory/connect", trajectoryId });
  return { run, connect, ownerCalls, refusals };
}

async function bodyOf(response: Response | null) {
  return (await response?.json()) as Record<string, unknown>;
}

describe("createTrajectoryConnectHook", () => {
  test("passes every other route without a query", async () => {
    const { run, ownerCalls, refusals } = setup();

    expect(await run({ method: "agent/run", agentId: "bot-1" })).toBeNull();
    expect(await run({ method: "info" })).toBeNull();
    expect(ownerCalls).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("answers 400 for an id that is not a UUID before any query", async () => {
    const { connect, ownerCalls, refusals } = setup({ session: PERSON });

    const response = await connect("not-a-uuid");

    expect(response?.status).toBe(400);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      code: TRAJECTORY_GATE_REFUSALS.invalidId.code,
      message: TRAJECTORY_GATE_REFUSALS.invalidId.message,
    });
    expect(ownerCalls).toEqual([]);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["invalid-id"]);
  });

  test("answers 401 RECORDER_SIGNED_OUT with the reason for a bearer that does not resolve", async () => {
    for (const [refused, reason] of [
      ["unknown", "revoked"],
      ["malformed", "revoked"],
      ["removed", "removed"],
      ["organization", "organization"],
    ] as const) {
      const { connect, ownerCalls, refusals } = setup({
        bearer: { refused, userId: PERSON },
      });

      const response = await connect();

      expect(response?.status).toBe(401);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const body = await bodyOf(response);
      expect(body.code).toBe(RECORDER_SIGNED_OUT);
      expect(body.reason).toBe(reason);
      expect(typeof body.message).toBe("string");
      expect(ownerCalls).toEqual([]);
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

  test("answers 401 IDENTITY_REQUIRED when there is neither a bearer nor a session", async () => {
    const { connect, ownerCalls, refusals } = setup({ session: null });

    const response = await connect();

    expect(response?.status).toBe(401);
    expect((await bodyOf(response)).code).toBe("IDENTITY_REQUIRED");
    expect(ownerCalls).toEqual([]);
    expect(refusals).toEqual([
      { reason: "signed-out", trajectoryId: TRAJECTORY, userId: null },
    ]);
  });

  test("allows the owner's open extension recording by bearer and by cookie", async () => {
    const byBearer = setup({ bearer: { actor } });
    const byCookie = setup({ session: PERSON });

    expect(await byBearer.connect()).toBeNull();
    expect(await byCookie.connect()).toBeNull();
    expect(byBearer.refusals).toEqual([]);
    expect(byCookie.refusals).toEqual([]);
  });

  test("allows a stopped recording whose trajectory is still open", async () => {
    const { connect } = setup({
      session: PERSON,
      owners: { [`${PERSON}:${TRAJECTORY}`]: openOwner({ status: "stopped" }) },
    });

    expect(await connect()).toBeNull();
  });

  test("answers 404 for a trajectory nobody registered", async () => {
    const { connect, refusals } = setup({ session: PERSON, owners: {} });

    const response = await connect();

    expect(response?.status).toBe(404);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      code: TRAJECTORY_GATE_REFUSALS.notOpen.code,
      message: TRAJECTORY_GATE_REFUSALS.notOpen.message,
    });
    expect(refusals).toEqual([
      { reason: "not-open", trajectoryId: TRAJECTORY, userId: PERSON },
    ]);
  });

  test("answers 404 for a closed trajectory", async () => {
    const { connect } = setup({
      session: PERSON,
      owners: {
        [`${PERSON}:${TRAJECTORY}`]: openOwner({ closedAt: new Date() }),
      },
    });

    expect((await connect())?.status).toBe(404);
  });

  test("answers 404 for a recording that did not come from the extension", async () => {
    const { connect } = setup({
      session: PERSON,
      owners: {
        [`${PERSON}:${TRAJECTORY}`]: openOwner({ source: "computer" }),
      },
    });

    expect((await connect())?.status).toBe(404);
  });

  test("answers 404 for another person's trajectory", async () => {
    const { connect, ownerCalls } = setup({
      bearer: { actor },
      owners: { [`${OTHER}:${TRAJECTORY}`]: openOwner() },
    });

    expect((await connect())?.status).toBe(404);
    expect(ownerCalls).toEqual([`${PERSON}:${TRAJECTORY}`]);
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
    reason: "not-open",
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
      payload: { reason: "not-open" },
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

    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.initiator).toEqual({ kind: "deployment" });
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
