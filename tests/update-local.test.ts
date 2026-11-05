import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocalUpdate,
  assertLocalStartAllowed,
  type CommandRunner,
  type LocalUpdateOptions,
  planLocalUpdate,
  runCommand,
} from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

const roots: string[] = [];
// These integration fixtures execute real Git subprocesses. Keep the watchdog finite while
// allowing the repository's one concurrent native build to occupy laptop CPU/disk.
setDefaultTimeout(20_000);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(topology: "host" | "image" = "image") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openbot-update-")));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "update@example.test");
  git("config", "user.name", "Update fixture");
  writeFileSync(join(root, "runtime.txt"), "old runtime\n");
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  postgres:\n    image: postgres:17\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "accepted");
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "runtime.txt"), "new runtime\n");
  git("commit", "--quiet", "-am", "candidate");
  const target = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "--detach", old);
  const current = parseReleaseManifest(structuredClone(currentFixture));
  current.source.commit = old;
  const candidate = parseReleaseManifest(structuredClone(targetFixture));
  candidate.source.commit = target;
  writeFileSync(join(root, ".openbot-release.json"), JSON.stringify(current));
  writeFileSync(
    join(root, ".env"),
    "ENCRYPTION_KEY=keep-this\nDATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot\nTENANT_PACKAGE_DIR=../customer\n",
  );
  mkdirSync(join(root, "customer"));
  writeFileSync(join(root, "customer", "branding.json"), '{"name":"Customer"}');
  const calls: string[] = [];
  const run: CommandRunner = async (command, options) => {
    calls.push(command.join(" "));
    if (command[0] === "git" || command[0] === "tar")
      return runCommand(command, options);
    if (options.stdoutFile)
      writeFileSync(options.stdoutFile, "PGDMP fixture backup");
    // The image topology reads /release from inside the server container.
    if (command.includes("exec") && command.includes("bun"))
      return JSON.stringify({
        version: candidate.version,
        commit: candidate.source.commit,
        distributionId: candidate.distribution.id,
        repository: candidate.distribution.repository,
        channel: candidate.distribution.channel,
      });
    if (command.includes("config"))
      return JSON.stringify({
        name: "original-project",
        services: {
          postgres: {
            environment: { POSTGRES_USER: "openbot", POSTGRES_DB: "openbot" },
          },
          server: {
            image:
              options.env?.SERVER_IMAGE ??
              current.artifacts.images.server?.reference,
            environment: {
              DATABASE_URL: "postgres://openbot:openbot@postgres:5432/openbot",
            },
          },
          worker: {
            image:
              options.env?.SERVER_IMAGE ??
              current.artifacts.images.server?.reference,
            environment: {
              DATABASE_URL: "postgres://openbot:openbot@postgres:5432/openbot",
            },
          },
          migrate: {
            image:
              options.env?.SERVER_IMAGE ??
              current.artifacts.images.server?.reference,
            environment: {
              DATABASE_URL: "postgres://openbot:openbot@postgres:5432/openbot",
            },
          },
        },
        volumes: {
          "postgres-data": { name: "original-project_postgres-data" },
        },
      });
    if (command.includes("inspect"))
      if (command.includes("{{.State.Running}}")) return "true\n";
    if (command.includes("inspect"))
      return `${candidate.artifacts.images.server?.reference}\n`;
    if (command.includes("ps")) return "fixture-container\n";
    return "";
  };
  const options: LocalUpdateOptions = {
    root,
    candidate,
    policy: {
      distributionId: "acme.openbot",
      repository: "acme/openbot",
      channel: "stable",
    },
    topology,
    backupDirectory: join(root, "backups"),
    acknowledgeInterruption: true,
    run,
    probe: async (url) =>
      url.endsWith("/release")
        ? {
            version: candidate.version,
            commit: candidate.source.commit,
            distributionId: candidate.distribution.id,
            repository: candidate.distribution.repository,
            channel: candidate.distribution.channel,
          }
        : { status: "ok" },
  };
  return { root, git, old, target, candidate, current, calls, run, options };
}

test("local plan detects committed baseline divergence without touching the checkout", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "runtime.txt"), "customer core change\n");
  f.git("commit", "--quiet", "-am", "customer customization");
  const before = f.git("rev-parse", "HEAD");
  const plan = await planLocalUpdate(f.options);
  expect(plan.allowed).toBe(false);
  expect(plan.reasons.join(" ")).toContain("baseline");
  expect(f.git("rev-parse", "HEAD")).toBe(before);
  expect(f.calls.some((c) => c.includes(" stop "))).toBe(false);
});

test("image apply preserves customer files and project identity and accepts only after readiness", async () => {
  const f = fixture();
  const env = readFileSync(join(f.root, ".env"), "utf8");
  const result = await applyLocalUpdate(f.options);
  expect(result.phase).toBe("accepted");
  expect(f.git("rev-parse", "HEAD")).toBe(f.target);
  expect(readFileSync(join(f.root, ".env"), "utf8")).toBe(env);
  expect(readFileSync(join(f.root, "customer", "branding.json"), "utf8")).toBe(
    '{"name":"Customer"}',
  );
  expect(
    JSON.parse(readFileSync(join(f.root, ".openbot-release.json"), "utf8"))
      .version,
  ).toBe("v0.3.0");
  const stop = f.calls.findIndex(
    (c) => c.includes("stop") && c.includes("worker"),
  );
  const dump = f.calls.findIndex((c) => c.includes("pg_dump"));
  const migrate = f.calls.findIndex(
    (c) => c.includes("--exit-code-from") && c.includes("migrate"),
  );
  expect(stop).toBeGreaterThan(-1);
  expect(dump).toBeGreaterThan(stop);
  expect(migrate).toBeGreaterThan(dump);
  expect(
    f.calls.some(
      (c) =>
        c.includes("--volumes") ||
        c.includes("pkill") ||
        c.includes("scripts/start.sh"),
    ),
  ).toBe(false);
});

test("migration failure keeps accepted metadata and durable recovery evidence", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) => {
    if (command.includes("--exit-code-from") && command.includes("migrate"))
      throw new Error("guarded migration refused divergent history");
    return f.run(command, options);
  };
  await expect(applyLocalUpdate({ ...f.options, run })).rejects.toThrow(
    "migration",
  );
  expect(
    JSON.parse(readFileSync(join(f.root, ".openbot-release.json"), "utf8"))
      .version,
  ).toBe("v0.2.0");
  const journal = JSON.parse(
    readFileSync(join(f.root, ".openbot-update-journal.json"), "utf8"),
  );
  expect(journal.phase).toBe("recovery-required");
  expect(journal.databaseMayHaveChanged).toBe(true);
  expect(f.calls.some((c) => c.includes("reset --hard"))).toBe(false);
  expect((await planLocalUpdate(f.options)).allowed).toBe(false);
});

test("an interrupted operation blocks another apply without starting containers", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, ".openbot-update-journal.json"),
    JSON.stringify({ phase: "migrating", databaseMayHaveChanged: true }),
  );
  await expect(applyLocalUpdate(f.options)).rejects.toThrow("interrupted");
  expect(f.git("rev-parse", "HEAD")).toBe(f.old);
  expect(f.calls.some((c) => c.includes(" stop "))).toBe(false);
});

test("host apply installs source, runs existing guarded migration and restarts the host topology", async () => {
  const f = fixture("host");
  await applyLocalUpdate(f.options);
  expect(f.calls.some((c) => c.includes("scripts/start.sh"))).toBe(true);
  expect(f.calls.some((c) => c.includes("scripts/migrate.ts"))).toBe(true);
  expect(
    f.calls.some((c) => c.includes("up") && c.includes("server worker")),
  ).toBe(false);
});

test("running host services cause an actionable refusal before mutation", async () => {
  const f = fixture("host");
  const run: CommandRunner = async (command, options) =>
    command[0] === "lsof" ? "4242\n" : f.run(command, options);
  const plan = await planLocalUpdate({ ...f.options, run });
  expect(plan.allowed).toBe(false);
  expect(plan.reasons.join(" ")).toContain("Stop");
  expect(f.git("rev-parse", "HEAD")).toBe(f.old);
});

test("target Compose volume or database changes refuse before stopping existing services", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) => {
    const result = await f.run(command, options);
    if (command.includes("--file"))
      return result.replace(
        "original-project_postgres-data",
        "different-database-volume",
      );
    return result;
  };
  const plan = await planLocalUpdate({ ...f.options, run });
  expect(plan.allowed).toBe(false);
  expect(plan.reasons.join(" ")).toContain("identities");
  expect(f.calls.some((command) => command.includes("stop"))).toBe(false);
});

test("a ready server reporting the wrong release is never accepted", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) =>
    command.includes("exec") && command.includes("bun")
      ? JSON.stringify({ version: "wrong-version" })
      : f.run(command, options);
  await expect(
    applyLocalUpdate({
      ...f.options,
      run,
      timeoutSeconds: 1,
      probe: async () => ({ status: "ok", version: "wrong-version" }),
    }),
  ).rejects.toThrow("ready");
  expect(
    JSON.parse(readFileSync(join(f.root, ".openbot-release.json"), "utf8"))
      .version,
  ).toBe("v0.2.0");
});

test("manual startup refuses an interrupted journal while the exact update operation may start", () => {
  const f = fixture();
  writeFileSync(
    join(f.root, ".openbot-update-journal.json"),
    JSON.stringify({ phase: "starting", operation: "this-operation" }),
  );
  expect(() => assertLocalStartAllowed(f.root)).toThrow("recovery");
  expect(() => assertLocalStartAllowed(f.root, "another-operation")).toThrow(
    "recovery",
  );
  expect(() => assertLocalStartAllowed(f.root, "this-operation")).not.toThrow();
});

test("binary subprocess backups stream to disk and close without hanging", () => {
  const f = fixture();
  const output = join(f.root, "binary.dump");
  const program = `import {runCommand} from ${JSON.stringify(join(import.meta.dir, "../scripts/update-local.ts"))}; await runCommand([process.execPath,"-e","process.stdout.write(Buffer.from([0,255,1,128,10]))"],{cwd:${JSON.stringify(f.root)},stdoutFile:${JSON.stringify(output)}});`;
  execFileSync(process.execPath, ["-e", program], {
    cwd: f.root,
    timeout: 2000,
  });
  expect([...readFileSync(output)]).toEqual([0, 255, 1, 128, 10]);
});

test("failed host readiness stops only candidate processes whose cwd belongs to this root", async () => {
  const f = fixture("host");
  let started = false;
  const run: CommandRunner = async (command, options) => {
    const output = await f.run(command, options);
    if (command[0] === "bash") started = true;
    if (started && command[0] === "lsof")
      return command.includes("-p") ? `n${join(f.root, "server")}\n` : "4242\n";
    return output;
  };
  await expect(
    applyLocalUpdate({
      ...f.options,
      run,
      timeoutSeconds: 1,
      probe: async () => ({ status: "ok", version: "wrong" }),
    }),
  ).rejects.toThrow("ready");
  expect(f.calls.some((command) => command === "kill -TERM 4242")).toBe(true);
  expect(f.calls.some((command) => command.includes("pkill"))).toBe(false);
});

test("an absent worker cannot be accepted just because the server is ready", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) => {
    if (command.includes("ps"))
      return command.includes("worker") && !command.includes("server")
        ? ""
        : "fixture-server\n";
    return f.run(command, options);
  };
  await expect(applyLocalUpdate({ ...f.options, run })).rejects.toThrow(
    "worker",
  );
  expect(
    JSON.parse(readFileSync(join(f.root, ".openbot-release.json"), "utf8"))
      .version,
  ).toBe("v0.2.0");
});

test.each([
  "postgres://openbot:openbot@postgres:5432/customer_db",
  "postgres://customer_user:openbot@postgres:5432/openbot",
  "postgres://openbot:openbot@postgres:5432/openbot?dbname=customer_db",
])(
  "bundled backup target mismatch refuses before stopping services: %s",
  async (databaseUrl) => {
    const f = fixture();
    const run: CommandRunner = async (command, options) => {
      const output = await f.run(command, options);
      return command.includes("config")
        ? output.replaceAll(
            "postgres://openbot:openbot@postgres:5432/openbot",
            databaseUrl,
          )
        : output;
    };
    await expect(applyLocalUpdate({ ...f.options, run })).rejects.toThrow(
      "backup",
    );
    expect(
      f.calls.some(
        (command) => command.includes(" stop ") || command.includes("pg_dump"),
      ),
    ).toBe(false);
    expect(f.git("rev-parse", "HEAD")).toBe(f.old);
  },
);

test.each([
  ["image", ["backup", "migration", "pull", "start"]],
  ["host", ["backup", "install", "migration", "start"]],
] as const)(
  "%s apply runs its long steps to completion with no kill deadline",
  async (topology, expected) => {
    const f = fixture(topology);
    // Host migration runs from server/, which a real checkout has.
    mkdirSync(join(f.root, "server"));
    const long: [string, (command: readonly string[]) => boolean][] = [
      ["pull", (c) => c.includes("pull")],
      ["backup", (c) => c.some((part) => part.includes("pg_dump"))],
      [
        "migration",
        (c) =>
          c.includes("scripts/migrate.ts") ||
          (c.includes("--exit-code-from") && c.includes("migrate")),
      ],
      ["install", (c) => c[0] === "bun" && c[1] === "install"],
      ["start", (c) => c.includes("scripts/start.sh") || c.includes("up")],
    ];
    const spawn = spyOn(Bun, "spawn");
    const deadlines: Record<string, unknown> = {};
    const run: CommandRunner = async (command, options) => {
      const step = long.find(([, matches]) => matches(command))?.[0];
      if (!step) return f.run(command, options);
      // The real runner, with the options this step gets, on a stand-in command.
      await runCommand(
        ["sh", "-c", options.stdoutFile ? "printf PGDMP" : "true"],
        options,
      );
      deadlines[step] = (
        spawn.mock.lastCall?.[1] as { timeout?: number } | undefined
      )?.timeout;
      return "";
    };
    try {
      expect((await applyLocalUpdate({ ...f.options, run })).phase).toBe(
        "accepted",
      );
    } finally {
      spawn.mockRestore();
    }
    expect(Object.keys(deadlines).sort()).toEqual([...expected]);
    for (const step of expected)
      expect([step, deadlines[step]]).toEqual([step, undefined]);
  },
);

test("host planning allows established unrelated workers and refuses its own or unknown ownership", async () => {
  const f = fixture("host");
  const planning = (cwd: string) =>
    planLocalUpdate({
      ...f.options,
      run: async (command, options) => {
        if (command[0] === "pgrep") return "4242\n";
        if (command[0] === "lsof" && command.includes("cwd")) return cwd;
        return f.run(command, options);
      },
    });
  expect((await planning("p4242\nn/another/openbot\n")).allowed).toBe(true);
  expect((await planning(`p4242\nn${f.root}\n`)).reasons.join(" ")).toContain(
    "this installation's routine worker",
  );
  expect((await planning("p4242\n")).allowed).toBe(false);
  expect(f.calls.some((command) => command.includes(" stop "))).toBe(false);
});
