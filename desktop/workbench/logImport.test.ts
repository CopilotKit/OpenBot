import { describe, expect, test } from "bun:test";
import { defaultSceneId, parseTroubleshooting, toScene } from "./logImport";

// A hand-written file in the shape `troubleshooting::bundle` writes. No real data.
function fixture(
  options: { system?: string; failed?: string; log?: string[] } = {},
): string {
  const system = options.system ?? "macos aarch64";
  const log = options.log ?? [
    "2026-01-02T10:00:00.000Z INFO  [launch] OpenBot Desktop 9.9.9 (Built 2026-01-01 from abc1234) on macos aarch64; local time is 10:00; logs in ~/Library/Logs/example",
    "2026-01-02T10:00:01.000Z INFO  [step engine] Checking the software OpenBot needs.",
    "2026-01-02T10:00:02.000Z INFO  [step engine] docker is answering. (window: This computer is ready to run OpenBot.)",
    "2026-01-02T10:00:03.000Z INFO  [quit] the person quit.",
    "2026-01-02T11:00:00.000Z INFO  [launch] OpenBot Desktop 9.9.9 (Built 2026-01-01 from abc1234) on macos aarch64; local time is 11:00; logs in ~/Library/Logs/example",
    "2026-01-02T11:00:05.000Z INFO  [window ipc] shown",
    "2026-01-02T11:00:10.000Z INFO  [step engine] Checking the software OpenBot needs.",
    "2026-01-02T11:00:10.500Z INFO  [step engine] docker is answering. (window: This computer is ready to run OpenBot.)",
    "2026-01-02T11:00:11.000Z INFO  [step services] Starting OpenBot's services.",
    "    a continuation line, indented",
    "2026-01-02T11:00:17.000Z INFO  [step services] OpenBot's services are running.",
    "2026-01-02T11:00:18.000Z ERROR [start] something went wrong",
    "2026-01-02T11:00:19.000Z INFO  [step answering] Starting OpenBot. This can take a few minutes the first time.",
  ];
  return [
    "# OpenBot troubleshooting logs",
    "",
    `Summary: OpenBot Desktop 9.9.9 (Built 2026-01-01 from abc1234) on ${system}.`,
    "",
    "Redacted on this computer before copying.",
    "",
    "## What failed",
    "",
    options.failed ?? "Nothing reported a failure.",
    "",
    "## Container engine",
    "",
    "docker 1.0.0",
    "",
    "## OpenBot Desktop log (end)",
    "",
    "~/Library/Logs/example/openbot-desktop.log",
    "",
    "```",
    ...log,
    "```",
    "",
    "## Backend CLI log (end)",
    "",
    "```",
    '{"level":"info","msg":"[step engine] not a desktop line"}',
    "```",
    "",
    "## Speech log (end)",
    "",
    "Not found on this computer.",
    "",
  ].join("\n");
}

type Row = {
  seq: number;
  step: string;
  ok: boolean;
  running: boolean;
  detail: string;
};
function rows(scene: ReturnType<typeof toScene>): (Row & { at: number })[] {
  return (scene.run ?? []).flatMap((step) =>
    "emit" in step ? [{ at: step.at, ...(step.payload as Row) }] : [],
  );
}

describe("parseTroubleshooting", () => {
  test("reads the version and the system", () => {
    const mac = parseTroubleshooting(fixture());
    expect(mac.version).toBe("9.9.9");
    expect(mac.os).toBe("mac");
    expect(parseTroubleshooting(fixture({ system: "windows x86_64" })).os).toBe(
      "windows",
    );
  });

  test("splits the Desktop log at each app start", () => {
    const parsed = parseTroubleshooting(fixture());
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].steps.map((s) => s.step)).toEqual([
      "engine",
      "engine",
    ]);
    const second = parsed.sessions[1];
    expect(second.startedAt).toBe("2026-01-02T11:00:00.000Z");
    expect(second.steps.map((s) => [s.at, s.step])).toEqual([
      [0, "engine"],
      [0.5, "engine"],
      [1, "services"],
      [7, "services"],
      [9, "answering"],
    ]);
    expect(second.steps[1]).toMatchObject({
      text: "docker is answering.",
      window: "This computer is ready to run OpenBot.",
    });
    expect(second.problems).toEqual(["[start] something went wrong"]);
  });

  test("a log with no app start is one session", () => {
    const parsed = parseTroubleshooting(
      fixture({
        log: [
          "2026-01-02T10:00:00.000Z INFO  [step env] Your settings are saved.",
          "2026-01-02T10:00:01.000Z INFO  [step services] Starting OpenBot's services.",
        ],
      }),
    );
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].steps).toHaveLength(2);
  });

  test("never throws on odd input", () => {
    for (const odd of [
      "",
      "not a troubleshooting file",
      "## OpenBot Desktop log (end)\n```\n[step x] no time\n2026-99-99T99:99:99Z INFO  [step y] bad time\n```",
      undefined as unknown as string,
    ]) {
      const parsed = parseTroubleshooting(odd);
      expect(parsed.os).toBe("mac");
      const scene = toScene(parsed, { start: "first-run" });
      expect(scene.title).toBeString();
    }
    const empty = toScene(parseTroubleshooting("garbage"), {
      start: "relaunch",
    });
    expect(empty.run).toBeUndefined();
    expect(empty.title).toContain("no setup rows");
  });
});

describe("toScene", () => {
  test("numbers the rows in order and marks each step's last row done", () => {
    const scene = toScene(parseTroubleshooting(fixture()), {
      start: "relaunch",
    });
    expect(rows(scene).map((r) => [r.seq, r.step, r.running])).toEqual([
      [1, "engine", true],
      [2, "engine", false],
      [3, "services", true],
      [4, "services", false],
      [5, "answering", false],
    ]);
    expect(rows(scene)[1].detail).toBe(
      "This computer is ready to run OpenBot.",
    );
    expect(rows(scene)[2].detail).toBe("Starting OpenBot's services.");
    expect(rows(scene).every((r) => r.ok)).toBe(true);
  });

  test("puts what failed on the last row", () => {
    const scene = toScene(
      parseTroubleshooting(fixture({ failed: "The backend could not start." })),
      { start: "relaunch" },
    );
    const last = rows(scene).at(-1);
    expect(last).toMatchObject({
      step: "answering",
      ok: false,
      running: false,
      detail: "The backend could not start.",
    });
    expect(
      rows(scene)
        .slice(0, -1)
        .every((r) => r.ok),
    ).toBe(true);
  });

  test("a relaunch starts at #start with no clicks, in the Update group", () => {
    const scene = toScene(parseTroubleshooting(fixture()), {
      start: "relaunch",
    });
    expect(scene.group).toBe("Update");
    expect(scene.start).toMatchObject({
      hash: "#start",
      search: "",
      os: "mac",
    });
    expect(scene.run?.some((s) => "click" in s)).toBe(false);
    expect(scene.title).toContain("(from a log)");
  });

  test("a first run starts on the first screen and presses Install", () => {
    const scene = toScene(
      parseTroubleshooting(fixture({ system: "windows x86_64" })),
      { start: "first-run" },
    );
    expect(scene.group).toBe("Install");
    expect(scene.start).toMatchObject({ hash: "", os: "windows" });
    expect(scene.run?.[0]).toEqual({ at: 0.5, click: "Install" });
    expect(rows(scene)[0].at).toBeGreaterThan(0.5);
  });

  test("picks a session, the last with rows by default", () => {
    const parsed = parseTroubleshooting(fixture());
    expect(rows(toScene(parsed, { start: "relaunch" }))).toHaveLength(5);
    expect(
      rows(toScene(parsed, { start: "relaunch", session: 0 })),
    ).toHaveLength(2);
    expect(
      rows(toScene(parsed, { start: "relaunch", session: 42 })),
    ).toHaveLength(5);
  });

  test("the default id has the session's date and a stable hash", () => {
    const parsed = parseTroubleshooting(fixture());
    const id = defaultSceneId(parsed, { start: "relaunch" });
    expect(id).toMatch(/^log-2026-01-02-[0-9a-f]{6}$/);
    expect(toScene(parsed, { start: "relaunch" }).id).toBe(id);
    expect(defaultSceneId(parsed, { start: "first-run" })).not.toBe(id);
    expect(toScene(parsed, { start: "relaunch", id: "mine" }).id).toBe("mine");
  });
});
