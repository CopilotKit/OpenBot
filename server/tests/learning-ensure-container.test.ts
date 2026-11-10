import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerProbe } from "../src/learning/auto-assign";
import {
  cliEnvironment,
  cliLoginPresent,
  cmdLineSafe,
  createLearningContainer,
  ensureLearningContainer,
  type KeyIntelligence,
  keyIntelligence,
  learningSetupInstructions,
  MANAGED_API,
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

const SELF_HOSTED = "https://intelligence.customer.example";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function key(answers: ContainerProbe[]): KeyIntelligence & {
  probes: number;
} {
  const view = {
    probes: 0,
    probe: async () => {
      view.probes++;
      return answers.shift() ?? "absent";
    },
    project: async () => ({ organizationSlug: "team", projectSlug: "chosen" }),
  };
  return view;
}

function intelligenceFetch(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json(body, { status });
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;
  return { requests, fetch };
}

const serviceToken = { token: "synthetic-service-token", projectId: "7" };

describe("creating the container with a service token", () => {
  test("posts the openbot container to the token's project and proves it with the key", async () => {
    const api = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 7, name: "OpenBot" },
    });
    const runtimeKey = key(["absent", "present"]);
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: runtimeKey,
        serviceToken,
        fetch: api.fetch,
        run: async () => {
          throw new Error("No CLI with a service token");
        },
      }),
    ).toBe("created");
    expect(api.requests).toHaveLength(1);
    const request = api.requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe(
      `${SELF_HOSTED}/api/learning/projects/7/containers`,
    );
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-copilotkit-ei-service-token"]).toBe(serviceToken.token);
    expect(JSON.parse(String(request.init.body))).toEqual({
      id: "openbot",
      name: "OpenBot",
    });
    expect(runtimeKey.probes).toBe(2);
  });

  test("one that already exists is present, not an error", async () => {
    const api = intelligenceFetch(409, {
      error: { code: "LEARNING_CONTAINER_ALREADY_EXISTS" },
    });
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent", "present"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).toBe("present");
  });

  test("a refused token says where service tokens work, and nothing is assigned", async () => {
    const api = intelligenceFetch(403, { error: { code: "FORBIDDEN" } });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: MANAGED_API,
        nonInteractive: true,
        key: key(["absent"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).rejects.toThrow("only on a CopilotKit local evaluation install");
  });

  test("a container in another project is reported, not assigned", async () => {
    const wrongProject = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 8 },
    });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent"]),
        serviceToken,
        fetch: wrongProject.fetch,
      }),
    ).rejects.toThrow("other than the openbot container");
    const invisible = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 7 },
    });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent", "absent"]),
        serviceToken,
        fetch: invisible.fetch,
      }),
    ).rejects.toThrow("another project");
  });

  test("a container already there never reaches Intelligence's write route", async () => {
    const api = intelligenceFetch(500, {});
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["present"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).toBe("present");
    expect(api.requests).toHaveLength(0);
  });
});

describe("with no credential that can create it", () => {
  test("self-hosted without a person or a token is skipped, and the CLI is not run", async () => {
    let runs = 0;
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent"]),
        run: async () => {
          runs++;
          return { exitCode: 0, stdout: "{}" };
        },
      }),
    ).toBe("skipped");
    expect(runs).toBe(0);
  });

  test("the instructions name the exact steps for each kind of Intelligence", () => {
    const managed = learningSetupInstructions(MANAGED_API);
    expect(managed).toContain("npx --yes copilotkit@latest login");
    expect(managed).toContain("bun scripts/setup-learning.ts");
    expect(managed).toContain("config.learning.setup.cliLoginSecret");
    expect(managed).toContain('ID "openbot"');
    const selfHosted = learningSetupInstructions(SELF_HOSTED);
    expect(selfHosted).toContain("bun scripts/setup-learning.ts");
    expect(selfHosted).toContain(
      "INTELLIGENCE_SERVICE_TOKEN and INTELLIGENCE_PROJECT_ID",
    );
  });
});

describe("the CopilotKit CLI", () => {
  test("a login is found where the CLI keeps it, and only there", async () => {
    const home = await mkdtemp(join(tmpdir(), "openbot-cli-home-"));
    directories.push(home);
    expect(cliLoginPresent({}, "darwin", home)).toBe(false);
    await mkdir(join(home, "Library/Preferences/copilotkit-auth-nodejs"), {
      recursive: true,
    });
    await writeFile(
      join(home, "Library/Preferences/copilotkit-auth-nodejs/config.json"),
      "{}",
    );
    expect(cliLoginPresent({}, "darwin", home)).toBe(true);
    expect(cliLoginPresent({}, "linux", home)).toBe(false);
    const configured = join(home, "mounted");
    expect(
      cliLoginPresent({ COPILOTKIT_CONFIG_DIR: configured }, "darwin", home),
    ).toBe(false);
    await mkdir(join(configured, "auth"), { recursive: true });
    await writeFile(join(configured, "auth/config.json"), "{}");
    expect(
      cliLoginPresent({ COPILOTKIT_CONFIG_DIR: configured }, "linux", home),
    ).toBe(true);
  });

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
  const credentials = (intelligence: FakeIntelligence) => ({
    directory: tmpdir(),
    apiUrl: intelligence.url,
    nonInteractive: true,
    key: keyIntelligence(intelligence.url, RUNTIME_KEY, "ws://127.0.0.1:9"),
  });
  const person = { id: "user-4f2a9c", name: "Ada" };

  test("makes a person's space in the key's own project, naming no project", async () => {
    const intelligence = serve("current");
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
        // Never reached: the key could do it.
        serviceToken,
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
        ...credentials(serve("current", ["user-4f2a9c"])),
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
          directory: tmpdir(),
          apiUrl: url,
          nonInteractive: true,
          key: keyIntelligence(url, RUNTIME_KEY, "ws://127.0.0.1:9"),
          container: person,
        }),
      ).toBe("present");
    } finally {
      conflict.stop(true);
    }
  });

  test("on Intelligence 0.15.1, which has no such route, the other credentials are tried", async () => {
    const intelligence = serve("0.15.1");
    // Nothing else here: skipped, as before, rather than an error.
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
      }),
    ).toBe("skipped");
    // A service token is the next one tried.
    const token = intelligenceFetch(201, {
      container: { id: "user-4f2a9c", projectId: 7, name: "Ada" },
    });
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
        serviceToken,
        fetch: token.fetch,
      }),
    ).toBe("created");
    expect(token.requests.map((r) => r.url)).toEqual([
      `${intelligence.url}/api/learning/projects/7/containers`,
    ]);
  });

  test("ensuring the openbot default proves it with the key afterwards", async () => {
    const intelligence = serve("current");
    expect(await ensureLearningContainer(credentials(intelligence))).toBe(
      "created",
    );
    expect(intelligence.containers.has("openbot")).toBe(true);
  });

  test("Learning switched off in Intelligence is said, not reported as unreachable", async () => {
    await expect(
      ensureLearningContainer(credentials(serve("learning-off"))),
    ).rejects.toThrow("Learning is switched off in the backend");
  });
});
