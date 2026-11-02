import { describe, expect, test } from "bun:test";
import {
  connectCodeRequestSchema,
  exchangeRequestSchema,
  joinedLearningContainer,
  recorderPaths,
  TRAJECTORY_GATE_REFUSALS,
} from "./recorder-api";

const INSTALL_ID = "0123456789abcdef0123456789abcdef";

describe("recorder request schemas", () => {
  test("each schema accepts its documented example and rejects an extra field", () => {
    const cases: [
      { safeParse: (v: unknown) => { success: boolean } },
      Record<string, unknown>,
    ][] = [
      [connectCodeRequestSchema, { via: "web" }],
      [
        exchangeRequestSchema,
        { code: "obc_abc", label: "Work laptop", installId: INSTALL_ID },
      ],
    ];
    for (const [schema, example] of cases) {
      expect(schema.safeParse(example).success).toBe(true);
      expect(schema.safeParse({ ...example, extra: 1 }).success).toBe(false);
    }
  });

  test("exchangeRequestSchema refuses an installId that is not 32 lowercase hex digits", () => {
    const base = { code: "obc_abc", label: "Work laptop" };
    for (const installId of [
      "0123456789ABCDEF0123456789ABCDEF",
      "0123456789abcdef",
      `${INSTALL_ID}0`,
      "g123456789abcdef0123456789abcdef",
    ]) {
      expect(
        exchangeRequestSchema.safeParse({ ...base, installId }).success,
      ).toBe(false);
    }
  });
});

describe("recorder constants and paths", () => {
  test("trajectoryConnect encodes the space", () => {
    expect(recorderPaths.trajectoryConnect("a b")).toBe(
      "/api/copilotkit/trajectory/a%20b/connect",
    );
  });

  test("only the capture pass leaves /api/recorder: OpenBot serves the Recorder nothing else", () => {
    const samples: Record<string, string> = {
      connectCodes: recorderPaths.connectCodes,
      connections: recorderPaths.connections,
      connection: recorderPaths.connection("c"),
      currentConnection: recorderPaths.currentConnection,
      me: recorderPaths.me,
      learning: recorderPaths.learning,
      activity: recorderPaths.activity,
      trajectoryConnect: recorderPaths.trajectoryConnect("t"),
    };
    expect(Object.keys(samples).sort()).toEqual(
      Object.keys(recorderPaths).sort(),
    );
    for (const [name, path] of Object.entries(samples)) {
      expect(path.startsWith("/api/recorder/")).toBe(
        name !== "trajectoryConnect",
      );
    }
  });

  test("the gate refusals carry the documented statuses", () => {
    expect(
      Object.values(TRAJECTORY_GATE_REFUSALS).map((r) => r.status),
    ).toEqual([400, 403, 503]);
  });
});

describe("joinedLearningContainer", () => {
  test("a pass joins the person's container unless there is none or it does not exist and could not be made", () => {
    const cases: [
      Parameters<typeof joinedLearningContainer>[0],
      string | null,
    ][] = [
      [{ state: "assigned", containerId: "c1" }, "c1"],
      // OpenBot could not check (Learning delivery off, or Intelligence not answering): the pass still names it.
      [{ state: "learning-off", containerId: "c1" }, "c1"],
      [{ state: "unverified", containerId: "c1" }, "c1"],
      [{ state: "unverified", containerId: null }, null],
      [{ state: "unassigned", containerId: null }, null],
      [{ state: "missing", containerId: "c1" }, null],
      [{ state: "unjoined", containerId: "c1" }, null],
    ];
    for (const [learning, joined] of cases)
      expect(joinedLearningContainer(learning)).toBe(joined);
  });
});
