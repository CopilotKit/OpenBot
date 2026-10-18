import { describe, expect, test } from "bun:test";
import {
  connectCodeRequestSchema,
  exchangeRequestSchema,
  RECORDER_BOT_HEADER,
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
      bots: recorderPaths.bots,
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

  test("the extension and the gate name the Bot in one lowercase header", () => {
    expect(RECORDER_BOT_HEADER).toBe("x-openbot-recorder-bot");
    expect(
      new Headers({ [RECORDER_BOT_HEADER]: "b" }).get("X-OpenBot-Recorder-Bot"),
    ).toBe("b");
  });

  test("the gate refusals carry the documented statuses", () => {
    expect(
      Object.values(TRAJECTORY_GATE_REFUSALS).map((r) => r.status),
    ).toEqual([400, 403, 503]);
  });
});
