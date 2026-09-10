import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

// Root tests can load names.ts before this file. A fresh process is necessary for the supervisor's
// import-time namespace, and prevents these Dockerode tests from sharing a deployment's resources.
const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
async function available() {
  if (!existsSync(socket)) return false;
  try {
    const { default: Docker } = await import("dockerode");
    await new Docker({ socketPath: socket }).ping();
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!(await available()))(
  "supervisor Docker lifecycle in an isolated namespace (five cases)",
  async () => {
    const namespace = `supervisor-test-${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        `${import.meta.dir}/fixtures/docker-lifecycle.ts`,
      ],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET: socket,
          COMPUTER_NAMESPACE: namespace,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) console.error(stdout, stderr);
    expect(status).toBe(0);
    const prefix = "SUPERVISOR_FIXTURE ";
    const summaryLine = stdout
      .split("\n")
      .find((line) => line.startsWith(prefix));
    if (!summaryLine)
      throw new Error(`Missing fixture result: ${stdout} ${stderr}`);
    const summary = JSON.parse(summaryLine.slice(prefix.length));
    expect(summary.completedCases).toBe(5);
    expect(summary.cleanup).toBe("complete");
    // Do not echo nested Bun summaries: scripts/test-ci.ts counts the outer suite's summary.
    console.log(summaryLine);
    console.log(
      `Supervisor Docker cases: ${JSON.stringify(stderr.split("\n").filter((line) => line.startsWith("(pass)") || line.includes("expect() calls")))}`,
    );
  },
  630_000,
);
