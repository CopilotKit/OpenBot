import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const driverPath = fileURLToPath(
  new URL(
    "./tool-selection-environment-restoration-driver.test.ts",
    import.meta.url,
  ),
);
const preloadPath = fileURLToPath(
  new URL("../scripts/test-preload.ts", import.meta.url),
);
const targetTestPath = fileURLToPath(
  new URL("./tool-selection.integration.test.ts", import.meta.url),
);
const modelModulePath = fileURLToPath(
  new URL("../src/routing/model.ts", import.meta.url),
);

type ProofMode = "present" | "absent" | "teardown-error" | "setup-error";

function childEnvironment(mode: ProofMode): Record<string, string> {
  const environment: Record<string, string> = {
    SRA009_MODE: mode,
    SRA009_TRACE_LIFECYCLE: "1",
    SRA009_TOOL_SELECTION_TEST_PATH: targetTestPath,
    SRA009_MODEL_MODULE_PATH: modelModulePath,
  };
  if (process.env.PATH) {
    environment.PATH = process.env.PATH;
  }
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }
  }
  return environment;
}

const testNameByMode: Record<ProofMode, string> = {
  present: "a model that cannot answer costs",
  absent: "a model that cannot answer costs",
  "teardown-error":
    "SRA-009 proof stops the real fixture mocks before teardown",
  "setup-error": "a model that cannot answer costs",
};

async function runRestorationProof(mode: ProofMode) {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--no-env-file",
      "--preload",
      preloadPath,
      driverPath,
      "-t",
      testNameByMode[mode],
    ],
    env: {
      ...childEnvironment(mode),
      ...(mode === "teardown-error"
        ? { SRA009_STOP_FIXTURE_BEFORE_TEARDOWN: "1" }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runDriverDiscovery() {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--no-env-file",
      "--preload",
      preloadPath,
      driverPath,
    ],
    env: childEnvironmentForDiscovery(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function childEnvironmentForDiscovery(): Record<string, string> {
  const environment: Record<string, string> = {};
  if (process.env.PATH) {
    environment.PATH = process.env.PATH;
  }
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }
  }
  return environment;
}

function restorationResultFrom(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("SRA009_ENV_RESTORE "));
  if (!line) throw new Error(`missing SRA009_ENV_RESTORE line in:\n${stdout}`);
  return JSON.parse(line.slice("SRA009_ENV_RESTORE ".length));
}

function lifecycleEventsFrom(output: string) {
  return output
    .split("\n")
    .filter((entry) => entry.startsWith("SRA009_LIFECYCLE "))
    .map((entry) => entry.slice("SRA009_LIFECYCLE ".length));
}

function setupResultFrom(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("SRA009_SETUP_RESTORE "));
  if (!line)
    throw new Error(`missing SRA009_SETUP_RESTORE line in:\n${stdout}`);
  return JSON.parse(line.slice("SRA009_SETUP_RESTORE ".length));
}

describe("tool-selection fixture model environment restoration", () => {
  test("loads the child proof driver inertly during ordinary discovery", async () => {
    const proof = await runDriverDiscovery();

    expect(proof.exitCode).toBe(0);
    expect(`${proof.stdout}\n${proof.stderr}`).toContain(
      "SRA-009 restoration driver is inert without an explicit mode",
    );
  });

  test("restores a present model environment after the actual fixture lifecycle", async () => {
    const proof = await runRestorationProof("present");

    expect(proof.exitCode).toBe(0);
    expect(restorationResultFrom(proof.stdout)).toEqual({
      mode: "present",
      restoredBase: true,
      restoredKey: true,
      modelStatus: "resolved",
      modelTextMatches: true,
      receivedProbe: true,
      receivedPathMatches: true,
      receivedAuthMatches: true,
      keyStillFixture: false,
    });
  });

  test("deletes absent model environment entries after the actual fixture lifecycle", async () => {
    const proof = await runRestorationProof("absent");

    expect(proof.exitCode).toBe(0);
    expect(restorationResultFrom(proof.stdout)).toEqual({
      mode: "absent",
      baseAbsent: true,
      keyAbsent: true,
      keyStillFixture: false,
    });
  });

  test("restores the model environment before surfacing actual fixture teardown errors", async () => {
    const proof = await runRestorationProof("teardown-error");

    expect(proof.exitCode).toBe(1);
    expect(restorationResultFrom(proof.stdout)).toEqual({
      mode: "teardown-error",
      restoredBase: true,
      restoredKey: true,
      modelStatus: "resolved",
      modelTextMatches: true,
      receivedProbe: true,
      receivedPathMatches: true,
      receivedAuthMatches: true,
      keyStillFixture: false,
    });
    expect(lifecycleEventsFrom(proof.stdout)).toEqual([
      "tool-selection-beforeAll:start",
      "tool-selection-beforeAll:snapshot",
      "tool-selection-beforeAll:llm-started",
      "tool-selection-beforeAll:env-set",
      "tool-selection-beforeAll:remote-started",
      "tool-selection-test:early-stop-start",
      "tool-selection-test:early-stop-settled",
      "tool-selection-afterAll:stop-start",
      "tool-selection-afterAll:stop-settled",
      "tool-selection-afterAll:stop-rejected",
      "tool-selection-afterAll:env-restored",
    ]);
    expect(proof.stderr).toContain("Server not started");
  });

  test("restores the model environment and stops started mocks before surfacing setup errors", async () => {
    const proof = await runRestorationProof("setup-error");

    expect(proof.exitCode).toBe(1);
    expect(restorationResultFrom(proof.stdout)).toEqual({
      mode: "setup-error",
      restoredBase: true,
      restoredKey: true,
      modelStatus: "resolved",
      modelTextMatches: true,
      receivedProbe: true,
      receivedPathMatches: true,
      receivedAuthMatches: true,
      keyStillFixture: false,
    });
    expect(setupResultFrom(proof.stdout)).toEqual({
      mode: "setup-error",
      llmStopStatus: "fulfilled",
      remoteStopStatus: "rejected",
      fixtureListenerStopped: true,
    });
    expect(lifecycleEventsFrom(proof.stdout)).toEqual([
      "tool-selection-beforeAll:start",
      "tool-selection-beforeAll:snapshot",
      "tool-selection-beforeAll:llm-started",
      "tool-selection-beforeAll:env-set",
      "tool-selection-beforeAll:setup-failure-injected",
      "tool-selection-beforeAll:setup-catch",
      "tool-selection-beforeAll:setup-stop-settled",
      "tool-selection-beforeAll:setup-env-restored",
      "tool-selection-afterAll:stop-start",
      "tool-selection-afterAll:stop-settled",
      "tool-selection-afterAll:stop-rejected",
      "tool-selection-afterAll:env-restored",
    ]);
    expect(proof.stderr).toContain(
      "SRA-009 synthetic setup failure after env mutation",
    );
  });
});
