import { expect, onTestFinished, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./update-local";

test("startup closes updater pipes while its background services remain live", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-start-detached-"));
  const bin = join(root, "bin");
  const pids: number[] = [];
  let invocation: Promise<string> | undefined;
  const executable = async (name: string, contents: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/usr/bin/env bash\n${contents}\n`);
    await chmod(path, 0o755);
  };
  onTestFinished(async () => {
    for (const role of ["server", "worker", "app"]) {
      const file = Bun.file(join(root, `${role}.pid`));
      if (await file.exists()) {
        const pid = Number(await file.text());
        if (!pids.includes(pid)) pids.push(pid);
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          throw error;
      }
    }
    await invocation;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(
    ["bin", "scripts", "server", "app"].map((path) => mkdir(join(root, path))),
  );
  for (const name of ["start.sh", "require-bash.sh", "processes.sh"])
    await writeFile(
      join(root, "scripts", name),
      await readFile(`scripts/${name}`),
    );
  await writeFile(
    join(root, ".env"),
    [
      "OPENBOT_ONE_COMPUTER_EACH=false",
      "OPENBOT_LEARNING_AUTO_ASSIGN=false",
      "COMPOSIO_API_KEY=synthetic-configured-key",
      "OPENBOT_BROKER_PROVIDER=composio",
      "MANAGED_AGENT_TOKEN=synthetic-managed-token",
      "AGENT_TOOL_TOKEN=synthetic-tool-token",
    ].join("\n"),
  );
  await executable("docker", "echo agent_profiles; echo agent_preferences");
  await executable("sleep", "exit 0");
  await executable("pkill", "exit 0");
  await executable(
    "lsof",
    'if [[ "$*" == *"-d cwd"* ]]; then printf "n%s\\n" "$TEST_ROOT"; fi',
  );
  await executable(
    "pgrep",
    'if [ -f "$TEST_ROOT/worker.pid" ]; then cat "$TEST_ROOT/worker.pid"; else exit 1; fi',
  );
  await executable(
    "curl",
    `case "$*" in
  *"/api/copilotkit/info"*)
    [ -f "$TEST_ROOT/server.pid" ] || exit 7
    printf '{"licenseStatus":"valid","mode":"test","agents":{"test":{}}}' ;;
  *"http://localhost:3010/"*)
    [ -f "$TEST_ROOT/app.pid" ] || exit 7
    printf '<title>OpenBot</title>' ;;
esac`,
  );
  await executable(
    "bun",
    `if [ "$1" = run ] && [ "$2" = - ]; then exec "$REAL_BUN" "$@"; fi
case "$*" in
  *"src/production-entry.ts"*) role=server ;;
  *"worker/src/index.ts"*) role=worker ;;
  *"run dev"*) role=app ;;
  *) exit 0 ;;
esac
exec "$REAL_BUN" "$TEST_ROOT/service.ts" "$role"`,
  );
  await writeFile(
    join(root, "service.ts"),
    'import {join} from "node:path"; await Bun.write(join(process.env.TEST_ROOT!, process.argv[2]+".pid"), String(process.pid)); await Bun.sleep(30_000);',
  );
  invocation = runCommand(["bash", "scripts/start.sh"], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TEST_ROOT: root,
      REAL_BUN: process.execPath,
    },
  });
  const deadline = Date.now() + 10_000;
  while (
    !(
      await Promise.all(
        ["server", "worker", "app"].map((role) =>
          Bun.file(join(root, `${role}.pid`)).exists(),
        ),
      )
    ).every(Boolean)
  ) {
    if (Date.now() > deadline)
      throw new Error("Background service did not launch");
    await Bun.sleep(20);
  }
  const completed = await Promise.race([
    invocation.then((stdout) => ({ stdout })),
    Bun.sleep(1000).then(() => undefined),
  ]);
  for (const role of ["server", "worker", "app"]) {
    const pid = Number(await readFile(join(root, `${role}.pid`), "utf8"));
    pids.push(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }
  expect(completed?.stdout).toContain("Ready. http://localhost:3010");
}, 15_000);
