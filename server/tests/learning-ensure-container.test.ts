import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerProbe } from "../src/learning/auto-assign";
import {
  cliEnvironment,
  cliLoginPresent,
  ensureLearningContainer,
  type KeyIntelligence,
  learningSetupInstructions,
  MANAGED_API,
} from "../src/learning/ensure-container";

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

function intelligence(status: number, body: unknown) {
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
    const api = intelligence(201, {
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
    const api = intelligence(409, {
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
    const api = intelligence(403, { error: { code: "FORBIDDEN" } });
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
    const wrongProject = intelligence(201, {
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
    const invisible = intelligence(201, {
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
    const api = intelligence(500, {});
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
});
