import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ContainerProbe } from "../src/learning/auto-assign";
import {
  cliEnvironment,
  cmdLineSafe,
  createLearningContainer,
  ensureLearningContainer,
  type KeyIntelligence,
  keyIntelligence,
  learningSetupInstructions,
  npxCommand,
  runNpx,
  stopProcessTree,
} from "../src/learning/ensure-container";
import {
  type FakeIntelligence,
  fakeIntelligence,
  intelligenceError,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

/** A key whose probe answers in turn and whose creation is counted, for the steps around it. */
function key(answers: ContainerProbe[]): KeyIntelligence & {
  probes: number;
  creates: number;
} {
  const view = {
    probes: 0,
    creates: 0,
    probe: async () => {
      view.probes++;
      return answers.shift() ?? "absent";
    },
    create: async () => {
      view.creates++;
      return "created" as const;
    },
  };
  return view;
}

describe("ensuring the openbot default", () => {
  test("a container already there is never created again", async () => {
    const runtimeKey = key(["present"]);
    expect(await ensureLearningContainer({ key: runtimeKey })).toBe("present");
    expect(runtimeKey.creates).toBe(0);
  });

  test("a missing one is created with the key", async () => {
    const runtimeKey = key(["absent"]);
    expect(await ensureLearningContainer({ key: runtimeKey })).toBe("created");
    expect(runtimeKey.creates).toBe(1);
  });

  test("a plan without Learning, or Intelligence out of reach, creates nothing", async () => {
    const notEntitled = key(["not_entitled"]);
    await expect(ensureLearningContainer({ key: notEntitled })).rejects.toThrow(
      "does not include Learning",
    );
    const unavailable = key(["unavailable"]);
    await expect(
      ensureLearningContainer({ key: unavailable }),
    ).rejects.toMatchObject({ retryable: true });
    expect(notEntitled.creates + unavailable.creates).toBe(0);
  });

  test("the instructions say to upgrade or create it by hand", () => {
    const instructions = learningSetupInstructions();
    expect(instructions).toContain("0.16.0");
    expect(instructions).toContain('ID "openbot"');
    expect(learningSetupInstructions("user-4f2a9c")).toContain(
      'ID "user-4f2a9c"',
    );
  });
});

describe("the CopilotKit CLI", () => {
  test("runs without this process's secrets", () => {
    const environment = cliEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/openbot",
      COPILOTKIT_CONFIG_DIR: "/var/run/copilotkit",
      INTELLIGENCE_API_KEY: "cpk-secret",
      INTELLIGENCE_SERVICE_TOKEN: "secret",
      DATABASE_URL: "postgres://secret",
      COPILOTKIT_LICENSE_TOKEN: "secret",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/openbot",
      COPILOTKIT_CONFIG_DIR: "/var/run/copilotkit",
      COPILOTKIT_TELEMETRY_DISABLED: "1",
    });
  });

  test("is started through a shell on Windows, where npx is a .cmd", () => {
    expect(npxCommand("win32")).toEqual({ command: "npx.cmd", shell: true });
    expect(npxCommand("darwin")).toEqual({ command: "npx", shell: false });
    expect(npxCommand("linux")).toEqual({ command: "npx", shell: false });
  });

  test("passes only arguments cmd.exe would not run or expand", () => {
    expect(
      cmdLineSafe([
        "--yes",
        "copilotkit@latest",
        "project",
        "select",
        "--project",
        "a1B2c",
        "--json",
      ]),
    ).toBe(true);
    for (const unsafe of [
      "abc&calc",
      "abc|calc",
      "%PATH%",
      "a^b",
      "a b",
      'a"b',
      "a<b",
      "a>b",
      "(a)",
      "a=b",
      "",
    ])
      expect(cmdLineSafe(["project", "select", "--project", unsafe])).toBe(
        false,
      );
  });

  // Since CVE-2024-27980, spawning a .cmd without a shell throws EINVAL before anything runs.
  test.if(process.platform === "win32")(
    "starts on this Windows machine instead of throwing EINVAL",
    async () => {
      const result = await runNpx(["--version"], tmpdir());
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );

  test.if(process.platform === "win32")(
    "refuses an argument the Windows shell would run, without starting it",
    async () => {
      const result = await runNpx(["--version", "x&echo INJECTED"], tmpdir());
      expect(result).toEqual({ exitCode: 1, stdout: "" });
    },
  );

  // Killing cmd.exe alone leaves the command under it holding the pipes, so `close` waits for it.
  test.if(process.platform === "win32")(
    "a stopped command takes the processes under its shell with it",
    async () => {
      const child = spawn("ping", ["-n", "30", "127.0.0.1"], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      const closed = new Promise((resolve) => child.on("close", resolve));
      // Stopped at once, cmd.exe goes before it has started ping, and there is no tree to leave.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const started = Date.now();
      stopProcessTree(child, true);
      await closed;
      expect(Date.now() - started).toBeLessThan(4_000);
    },
  );
});

describe("creating a container with the runtime key", () => {
  const served: FakeIntelligence[] = [];
  afterEach(() => {
    for (const intelligence of served.splice(0)) intelligence.stop();
  });
  const serve = (
    version: Parameters<typeof fakeIntelligence>[0],
    containers: string[] = [],
  ) => {
    const intelligence = fakeIntelligence(version, { containers });
    served.push(intelligence);
    return intelligence;
  };
  const runtimeKey = (intelligence: FakeIntelligence) =>
    keyIntelligence(intelligence.url, RUNTIME_KEY, "ws://127.0.0.1:9");
  const person = { id: "user-4f2a9c", name: "Ada" };

  test("makes a person's space in the key's own project, naming no project", async () => {
    const intelligence = serve("current");
    expect(
      await createLearningContainer({
        key: runtimeKey(intelligence),
        container: person,
      }),
    ).toBe("created");
    const posts = intelligence.requests.filter((r) => r.method === "POST");
    expect(posts).toEqual([
      {
        method: "POST",
        path: "/api/v1/learning/containers",
        auth: `Bearer ${RUNTIME_KEY}`,
        body: { id: "user-4f2a9c", name: "Ada" },
      },
    ]);
    expect(intelligence.containers.has("user-4f2a9c")).toBe(true);
  });

  test("one already there is present, whether Intelligence says 200 or 409", async () => {
    expect(
      await createLearningContainer({
        key: runtimeKey(serve("current", ["user-4f2a9c"])),
        container: person,
      }),
    ).toBe("present");
    // An Intelligence that reports a taken id as a conflict instead.
    const conflict = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => intelligenceError("LEARNING_CONTAINER_ALREADY_EXISTS"),
    });
    try {
      const url = `http://127.0.0.1:${conflict.port}`;
      expect(
        await createLearningContainer({
          key: keyIntelligence(url, RUNTIME_KEY, "ws://127.0.0.1:9"),
          container: person,
        }),
      ).toBe("present");
    } finally {
      conflict.stop(true);
    }
  });

  test("an Intelligence older than 0.16.0 says to upgrade or create it by hand", async () => {
    const intelligence = serve("0.15.1");
    const refusal = createLearningContainer({
      key: runtimeKey(intelligence),
      container: person,
    });
    await expect(refusal).rejects.toThrow("older than 0.16.0");
    await expect(refusal).rejects.not.toMatchObject({ retryable: true });
    await expect(refusal).rejects.toThrow('ID "user-4f2a9c"');
  });

  test("a failure that may pass in a moment is marked retryable", async () => {
    const intelligence = fakeIntelligence("current", { failCreates: 1 });
    served.push(intelligence);
    await expect(
      createLearningContainer({ key: runtimeKey(intelligence) }),
    ).rejects.toMatchObject({ retryable: true });
    expect(
      await createLearningContainer({ key: runtimeKey(intelligence) }),
    ).toBe("created");
  });

  test("ensuring the openbot default creates it in the key's project", async () => {
    const intelligence = serve("current");
    expect(
      await ensureLearningContainer({ key: runtimeKey(intelligence) }),
    ).toBe("created");
    expect(intelligence.containers.has("openbot")).toBe(true);
  });

  test("Learning switched off in Intelligence is said, not reported as unreachable", async () => {
    await expect(
      ensureLearningContainer({ key: runtimeKey(serve("learning-off")) }),
    ).rejects.toThrow("Learning is switched off in this Intelligence");
  });
});
