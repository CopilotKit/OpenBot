import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
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
const container = (action: string, projectId = "12") => ({
  schemaVersion: 1,
  command: `learning containers ${action}`,
  status: "success",
  projectId,
  container: { id: "openbot", projectId: Number(projectId), name: "OpenBot" },
});
const missing = {
  schemaVersion: 1,
  command: "learning containers get",
  status: "error",
  error: { code: "LEARNING_CONTAINER_NOT_FOUND" },
};

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
    if (args[0] === "project") {
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
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(args[2] === "get" ? missing : container("create")),
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

test("fresh managed setup creates and verifies the selected project's container before configuring OpenBot", async () => {
  const f = await fixture();
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "configured",
  );
  expect(f.calls).toEqual([
    ["project", "select", "--project", "12", "--json"],
    ["learning", "containers", "get", "openbot", "--json"],
    [
      "learning",
      "containers",
      "create",
      "--id",
      "openbot",
      "--name",
      "OpenBot",
      "--json",
    ],
  ]);
  const content = await readFile(f.envPath, "utf8");
  expect(content).toContain("# Keep my other configuration");
  expect(parseEnv(content)).toMatchObject({
    INTELLIGENCE_API_KEY: key,
    CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openbot",
    OPENAI_API_KEY: "synthetic-model",
  });
  const saved = content;
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "preserved",
  );
  expect(await readFile(f.envPath, "utf8")).toBe(saved);
  expect(f.calls).toHaveLength(3);
});

test("reuses an existing verified container without creating or editing it", async () => {
  const f = await fixture();
  await setupLearning({
    ...f.options,
    runCli: async (args) =>
      args[0] === "project"
        ? f.runCli(args)
        : { exitCode: 0, stdout: JSON.stringify(container("get")) },
  });
  expect(
    parseEnv(await readFile(f.envPath, "utf8"))
      .CPK_INTELLIGENCE_LEARNING_CONTAINER_ID,
  ).toBe("openbot");
  expect(f.calls).toHaveLength(1);
});

test("custom configured targets are preserved before any CLI operation", async () => {
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

test("manually supplied keys are never overwritten or used to guess a project", async () => {
  const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
  const before = await readFile(f.envPath, "utf8");
  await expect(
    setupLearning({ ...f.options, runCli: f.runCli }),
  ).rejects.toThrow("already configured");
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(f.calls).toHaveLength(0);
});

test("exported runtime keys also prevent CLI project selection", async () => {
  const f = await fixture();
  await expect(
    setupLearning({
      ...f.options,
      environment: { INTELLIGENCE_API_KEY: "cpk-exported-key" },
      runCli: f.runCli,
    }),
  ).rejects.toThrow("already configured");
  expect(f.calls).toHaveLength(0);
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

test("a partial key provision cannot reuse a stale CLI key or create a container", async () => {
  const f = await fixture("CPK_INTELLIGENCE_API_KEY=cpk-old-project-key\n");
  const before = await readFile(f.envPath, "utf8");
  await expect(
    setupLearning({
      ...f.options,
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
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});

test("wrong-project or failed container results leave OpenBot unassigned", async () => {
  for (const response of [
    container("create", "99"),
    { status: "error", error: { code: "FORBIDDEN" } },
  ]) {
    const f = await fixture();
    await expect(
      setupLearning({
        ...f.options,
        runCli: async (args) =>
          args[2] === "create"
            ? { exitCode: 0, stdout: JSON.stringify(response) }
            : f.runCli(args),
      }),
    ).rejects.toThrow("could not be verified");
    const values = parseEnv(await readFile(f.envPath, "utf8"));
    expect(values.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID).toBeUndefined();
    expect(values.INTELLIGENCE_API_KEY).toBe("");
  }
});

test("read authorization errors do not trigger container creation", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  await expect(
    setupLearning({
      ...f.options,
      runCli: async (args) => {
        calls.push(args);
        return args[0] === "project"
          ? f.runCli(args)
          : {
              exitCode: 1,
              stdout: JSON.stringify({
                schemaVersion: 1,
                command: "learning containers get",
                status: "error",
                error: { code: "FORBIDDEN" },
              }),
            };
      },
    }),
  ).rejects.toThrow("could not be verified");
  expect(calls).toHaveLength(2);
});
