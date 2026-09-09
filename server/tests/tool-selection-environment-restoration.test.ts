import { describe, expect, test } from "bun:test";

const bunPath = "/opt/homebrew/bin/bun";
const driverPath = new URL(
  "./tool-selection-environment-restoration-driver.test.ts",
  import.meta.url,
).pathname;
const preloadPath = new URL("../scripts/test-preload.ts", import.meta.url)
  .pathname;

type ProofMode = "present" | "absent" | "teardown-error";

async function runRestorationProof(mode: ProofMode) {
  const proc = Bun.spawn({
    cmd: [
      bunPath,
      "test",
      "--no-env-file",
      "--preload",
      preloadPath,
      driverPath,
      "-t",
      mode === "teardown-error"
        ? "SRA-009 proof stops the real fixture mocks before teardown"
        : "a model that cannot answer costs",
    ],
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SRA009_MODE: mode,
      SRA009_TRACE_LIFECYCLE: "1",
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

describe("tool-selection fixture model environment restoration", () => {
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
});
