import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ContainerProbe } from "../server/src/learning/auto-assign";
import type { ContainerCreation } from "../server/src/learning/ensure-container";
import { setupLearning } from "./setup-learning";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const key = "cpk-synthetic-setup-key";

async function fixture(extra = "") {
  const directory = await mkdtemp(join(tmpdir(), "openbot-learning-setup-"));
  directories.push(directory);
  await mkdir(join(directory, ".copilotkit"));
  await writeFile(
    join(directory, ".copilotkit/project.json"),
    JSON.stringify({ projectId: "12", projectSlug: "chosen" }),
  );
  const envPath = join(directory, ".env");
  await writeFile(
    envPath,
    `INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai\nINTELLIGENCE_API_KEY=\n# Keep my other configuration\nOPENAI_API_KEY=synthetic-model\n${extra}`,
  );
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    await writeFile(
      envPath,
      `${await readFile(envPath, "utf8")}\nCPK_INTELLIGENCE_API_KEY=${key}\n`,
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "completed",
        project: { id: "12" },
        api_key_provisioned: true,
        environment_file_written: true,
      }),
    };
  };
  return {
    directory,
    envPath,
    calls,
    runCli,
    options: { directory, environment: {} },
  };
}

/** The runtime key's view of its own project: whether openbot is there, and what creating it did. */
function keyView(
  answers: ContainerProbe[],
  create: () => Promise<ContainerCreation> = async () => "created",
) {
  const probes: string[] = [];
  const creates: string[] = [];
  const keys: string[] = [];
  const keyIntelligence = (_apiUrl: string, apiKey: string) => {
    keys.push(apiKey);
    return {
      probe: async (containerId: string) => {
        probes.push(containerId);
        return answers.shift() ?? "absent";
      },
      create: async (container: { id: string }) => {
        creates.push(container.id);
        return create();
      },
    };
  };
  return { probes, creates, keys, keyIntelligence };
}

test("fresh managed setup provisions a key, creates openbot with it, then configures OpenBot", async () => {
  const f = await fixture();
  const view = keyView(["absent"]);
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: view.keyIntelligence,
    }),
  ).toBe("configured");
  expect(f.calls).toEqual([["project", "select", "--project", "12", "--json"]]);
  // The key the CLI just wrote is the one that creates the container.
  expect(view.keys).toEqual([key]);
  expect(view.creates).toEqual(["openbot"]);
  const content = await readFile(f.envPath, "utf8");
  expect(content).toContain("# Keep my other configuration");
  expect(parseEnv(content)).toMatchObject({
    CPK_INTELLIGENCE_API_KEY: key,
    INTELLIGENCE_API_KEY: "",
    CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openbot",
    OPENAI_API_KEY: "synthetic-model",
  });
  const saved = content;
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "preserved",
  );
  expect(await readFile(f.envPath, "utf8")).toBe(saved);
  expect(f.calls).toHaveLength(1);
});

test.if(process.platform === "win32")(
  "a project id the Windows shell would run is named, and the CLI is not called",
  async () => {
    const f = await fixture();
    await writeFile(
      join(f.directory, ".copilotkit/project.json"),
      JSON.stringify({ projectId: "12&calc", projectSlug: "chosen" }),
    );
    await expect(
      setupLearning({ ...f.options, runCli: f.runCli }),
    ).rejects.toThrow("cannot be passed safely");
    expect(f.calls).toEqual([]);
  },
);

test("fresh managed setup reuses an openbot the new key's project already has", async () => {
  const f = await fixture();
  const view = keyView(["present"]);
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: view.keyIntelligence,
    }),
  ).toBe("configured");
  expect(view.creates).toEqual([]);
  expect(
    parseEnv(await readFile(f.envPath, "utf8"))
      .CPK_INTELLIGENCE_LEARNING_CONTAINER_ID,
  ).toBe("openbot");
});

test("a container the new key cannot create leaves OpenBot unassigned", async () => {
  const f = await fixture();
  await expect(
    setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: keyView(["absent"], async () => {
        throw new Error("This Intelligence is older than 0.16.0.");
      }).keyIntelligence,
    }),
  ).rejects.toThrow("older than 0.16.0");
  expect(
    parseEnv(await readFile(f.envPath, "utf8"))
      .CPK_INTELLIGENCE_LEARNING_CONTAINER_ID,
  ).toBeUndefined();
});

test("custom configured targets are preserved before anything else", async () => {
  const f = await fixture(
    "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=custom-work\n",
  );
  const before = await readFile(f.envPath, "utf8");
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "preserved",
  );
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(f.calls).toHaveLength(0);
});

test("an existing key whose project has openbot is left to the server to assign", async () => {
  const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
  const before = await readFile(f.envPath, "utf8");
  const view = keyView(["present"]);
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: view.keyIntelligence,
    }),
  ).toBe("present");
  expect(view.keys).toEqual(["cpk-manual-key"]);
  expect(view.probes).toEqual(["openbot"]);
  expect(view.creates).toEqual([]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(f.calls).toHaveLength(0);
});

test("an existing key without openbot creates it in its own project, with no CLI and no new key", async () => {
  for (const apiUrl of [
    "https://api.intelligence.copilotkit.ai",
    "https://customer.example",
  ]) {
    const f = await fixture(
      `INTELLIGENCE_API_URL=${apiUrl}\nINTELLIGENCE_API_KEY=cpk-manual-key\n`,
    );
    const before = await readFile(f.envPath, "utf8");
    const view = keyView(["absent"]);
    let signIns = 0;
    expect(
      await setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: view.keyIntelligence,
        setupSelfHosted: async () => {
          signIns++;
          throw new Error("No browser is needed with a key");
        },
      }),
    ).toBe("created");
    expect(view.creates).toEqual(["openbot"]);
    expect(f.calls).toHaveLength(0);
    expect(signIns).toBe(0);
    expect(await readFile(f.envPath, "utf8")).toBe(before);
  }
});

test("exported runtime keys are used the same way and never trigger project selection", async () => {
  const f = await fixture();
  const view = keyView(["absent"]);
  expect(
    await setupLearning({
      ...f.options,
      environment: { INTELLIGENCE_API_KEY: "cpk-exported-key" },
      runCli: f.runCli,
      keyIntelligence: view.keyIntelligence,
    }),
  ).toBe("created");
  expect(view.keys).toEqual(["cpk-exported-key"]);
  expect(f.calls).toHaveLength(0);
});

test("plan and connection failures create nothing", async () => {
  for (const [answer, message] of [
    ["not_entitled", "does not include Learning"],
    ["unavailable", "could not be asked"],
    ["learning_off", "switched off"],
  ] as const) {
    const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
    const view = keyView([answer]);
    await expect(
      setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: view.keyIntelligence,
      }),
    ).rejects.toThrow(message);
    expect(view.creates).toEqual([]);
    expect(f.calls).toHaveLength(0);
  }
});

test("fresh self-hosted endpoints use browser setup and save its verified connection", async () => {
  const f = await fixture("INTELLIGENCE_API_URL=https://customer.example\n");
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      setupSelfHosted: async (apiUrl) => ({
        apiUrl,
        apiKey: key,
        learningContainerId: "openbot",
      }),
    }),
  ).toBe("configured");
  expect(parseEnv(await readFile(f.envPath, "utf8"))).toMatchObject({
    INTELLIGENCE_API_URL: "https://customer.example",
    INTELLIGENCE_API_KEY: key,
    CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openbot",
  });
  expect(f.calls).toHaveLength(0);
});

test("self-hosted setup failure or concurrent env edits do not save credentials", async () => {
  const f = await fixture("INTELLIGENCE_API_URL=https://customer.example\n");
  const original = await readFile(f.envPath, "utf8");
  await expect(
    setupLearning({
      ...f.options,
      setupSelfHosted: async () => {
        throw new Error("Sign-in cancelled");
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(await readFile(f.envPath, "utf8")).toBe(original);
  await expect(
    setupLearning({
      ...f.options,
      setupSelfHosted: async (apiUrl) => {
        await writeFile(f.envPath, `${original}\n# Operator edit\n`);
        return { apiUrl, apiKey: key, learningContainerId: "openbot" };
      },
    }),
  ).rejects.toThrow("configuration changed");
  expect(parseEnv(await readFile(f.envPath, "utf8")).INTELLIGENCE_API_KEY).toBe(
    "",
  );
});

test.each(["", "INTELLIGENCE_API_KEY=cpk-old-project-key\n"])(
  "a CLI key is used without reprovisioning or rewriting configuration: %s",
  async (legacy) => {
    const f = await fixture(`${legacy}CPK_INTELLIGENCE_API_KEY=cpk-cli-key\n`);
    const before = await readFile(f.envPath, "utf8");
    const view = keyView(["present"]);
    expect(
      await setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: view.keyIntelligence,
      }),
    ).toBe("present");
    expect(view.keys).toEqual(["cpk-cli-key"]);
    expect(f.calls).toHaveLength(0);
    expect(await readFile(f.envPath, "utf8")).toBe(before);
  },
);

test("a partial key provision does not create a container", async () => {
  const f = await fixture();
  const before = await readFile(f.envPath, "utf8");
  const view = keyView(["absent"]);
  await expect(
    setupLearning({
      ...f.options,
      keyIntelligence: view.keyIntelligence,
      runCli: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          type: "partial",
          project: { id: "12" },
          api_key_provisioned: false,
        }),
      }),
    }),
  ).rejects.toThrow("did not finish provisioning");
  expect(view.creates).toEqual([]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});
