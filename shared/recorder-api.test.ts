import { describe, expect, test } from "bun:test";
import {
  RECORDER_MEDIA_CHUNK_BYTES,
  TRAJECTORY_GATE_REFUSALS,
  actionBatchSchema,
  completeMediaSchema,
  connectCodeRequestSchema,
  createMediaSchema,
  exchangeRequestSchema,
  networkBodyRef,
  parseNetworkBodyRef,
  recorderPaths,
  registerTrajectorySchema,
  startExtensionDemonstrationSchema,
} from "./recorder-api";

const INSTALL_ID = "0123456789abcdef0123456789abcdef";
const TRAJECTORY_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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
      [startExtensionDemonstrationSchema, { botId: "bot-1", title: "Refund" }],
      [
        actionBatchSchema,
        {
          fromIndex: 0,
          actions: [
            {
              kind: "navigate",
              url: "https://example.test/a",
              transition: "link",
            },
          ],
        },
      ],
      [registerTrajectorySchema, { trajectoryId: TRAJECTORY_ID }],
      [createMediaSchema, { kind: "screen", mimeType: "video/webm" }],
      [completeMediaSchema, { chunkCount: 3 }],
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

  test("createMediaSchema ties the kind to the type", () => {
    expect(
      createMediaSchema.safeParse({
        kind: "audio",
        mimeType: "audio/webm;codecs=opus",
      }).success,
    ).toBe(true);
    expect(
      createMediaSchema.safeParse({
        kind: "audio",
        mimeType: "application/x-ndjson",
      }).success,
    ).toBe(false);
    expect(
      createMediaSchema.safeParse({
        kind: "network",
        mimeType: "application/x-ndjson",
      }).success,
    ).toBe(true);
    expect(
      createMediaSchema.safeParse({ kind: "network", mimeType: "video/webm" })
        .success,
    ).toBe(false);
  });
});

describe("recorder constants and paths", () => {
  test("a media chunk is 524,288 bytes", () => {
    expect(RECORDER_MEDIA_CHUNK_BYTES).toBe(524_288);
  });

  test("trajectoryConnect encodes the space", () => {
    expect(recorderPaths.trajectoryConnect("a b")).toBe(
      "/api/copilotkit/trajectory/a%20b/connect",
    );
  });

  test("only the pass, transcription and media read paths leave /api/recorder", () => {
    const outside = new Set([
      "trajectoryConnect",
      "transcriptions",
      "mediaList",
      "mediaContent",
      "mediaLine",
    ]);
    const samples: Record<string, string> = {
      connectCodes: recorderPaths.connectCodes,
      connections: recorderPaths.connections,
      connection: recorderPaths.connection("c"),
      currentConnection: recorderPaths.currentConnection,
      me: recorderPaths.me,
      bots: recorderPaths.bots,
      demonstrations: recorderPaths.demonstrations,
      openDemonstration: recorderPaths.openDemonstration("b"),
      demonstration: recorderPaths.demonstration("d"),
      actions: recorderPaths.actions("d"),
      trajectories: recorderPaths.trajectories("d"),
      closeTrajectory: recorderPaths.closeTrajectory("d", "t"),
      stop: recorderPaths.stop("d"),
      media: recorderPaths.media("d"),
      mediaItem: recorderPaths.mediaItem("d", "m"),
      mediaChunk: recorderPaths.mediaChunk("d", "m", 1),
      mediaComplete: recorderPaths.mediaComplete("d", "m"),
      trajectoryConnect: recorderPaths.trajectoryConnect("t"),
      transcriptions: recorderPaths.transcriptions,
      mediaList: recorderPaths.mediaList("d"),
      mediaContent: recorderPaths.mediaContent("d", "m"),
      mediaLine: recorderPaths.mediaLine("d", "m", 0),
    };
    expect(Object.keys(samples).sort()).toEqual(
      Object.keys(recorderPaths).sort(),
    );
    for (const [name, path] of Object.entries(samples)) {
      if (!outside.has(name)) {
        expect(path.startsWith("/api/recorder/")).toBe(true);
      } else if (name.startsWith("media")) {
        expect(path.startsWith("/api/demonstrations/")).toBe(true);
      }
    }
  });

  test("the gate refusals carry the documented statuses", () => {
    expect(
      Object.values(TRAJECTORY_GATE_REFUSALS).map((r) => r.status),
    ).toEqual([400, 403, 404, 503]);
  });
});

describe("network body refs", () => {
  test("a ref round-trips", () => {
    const ref = networkBodyRef("https://openbot.example.test", "d1", "m1", 7);
    expect(ref).toBe(
      "https://openbot.example.test/api/demonstrations/d1/media/m1/lines/7",
    );
    expect(parseNetworkBodyRef(ref)).toEqual({
      origin: "https://openbot.example.test",
      demonstrationId: "d1",
      mediaId: "m1",
      line: 7,
    });
  });

  test("ids that need encoding round-trip", () => {
    const ref = networkBodyRef("http://127.0.0.1:7478", "d 1", "m/1", 0);
    expect(parseNetworkBodyRef(ref)).toEqual({
      origin: "http://127.0.0.1:7478",
      demonstrationId: "d 1",
      mediaId: "m/1",
      line: 0,
    });
  });

  test("a ref on another path returns null", () => {
    expect(
      parseNetworkBodyRef(
        "https://openbot.example.test/api/demonstrations/d1/media/m1/content",
      ),
    ).toBeNull();
    expect(
      parseNetworkBodyRef(
        "https://openbot.example.test/api/recorder/demonstrations/d1/media/m1/lines/7",
      ),
    ).toBeNull();
    expect(parseNetworkBodyRef("not a url")).toBeNull();
    expect(
      parseNetworkBodyRef(
        "https://openbot.example.test/api/demonstrations/d1/media/m1/lines/-1",
      ),
    ).toBeNull();
  });
});
