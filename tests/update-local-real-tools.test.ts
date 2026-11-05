/**
 * The local updater against the real tools whose behaviour these steps depend on: Docker Compose's
 * pull policy, Docker's refusal to tag a build with a digest, and libpq's reading of the
 * environment. tests/update-local.test.ts fakes every one of these, which is how an update that
 * pulled nothing, a host start that could not build, and a backup that could not connect all passed.
 *
 * Only what the step under test needs is real. Stopping, migrating and starting a stack stay
 * recorded, so nothing here touches another Compose project, and every container, image and
 * project this file creates has a unique name and is removed afterwards.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "./support/reserved-port";
import {
  applyLocalUpdate,
  type CommandRunner,
  type LocalUpdateOptions,
  runCommand,
} from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

setDefaultTimeout(180_000);
const id = randomUUID().slice(0, 8);
const composeFile = readFileSync(
  join(import.meta.dir, "../docker-compose.yml"),
  "utf8",
);
function available(command: string[]) {
  try {
    return Bun.spawnSync(command).exitCode === 0;
  } catch {
    return false;
  }
}
const docker = available(["docker", "info", "--format", "{{.ServerVersion}}"]);
const pgDump = available(["pg_dump", "--version"]);
function sh(command: string[], input?: string) {
  return execFileSync(command[0] ?? "", command.slice(1), {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const step of cleanup.reverse())
    try {
      step();
    } catch {}
});
function directory(prefix: string) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
/** A checkout on its accepted commit, with the candidate one commit ahead, both carrying this
 * repository's real docker-compose.yml. */
function installation(dotenv: string) {
  const root = directory("openbot-real-update-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "update@example.test");
  git("config", "user.name", "Update fixture");
  writeFileSync(join(root, "docker-compose.yml"), composeFile);
  writeFileSync(join(root, "runtime.txt"), "old runtime\n");
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
  writeFileSync(join(root, ".env"), dotenv);
  const identity = {
    version: candidate.version,
    commit: candidate.source.commit,
    distributionId: candidate.distribution.id,
    repository: candidate.distribution.repository,
    channel: candidate.distribution.channel,
  };
  return { root, git, old, target, candidate, identity };
}
function options(
  f: ReturnType<typeof installation>,
  topology: "host" | "image",
  run: CommandRunner,
): LocalUpdateOptions {
  return {
    root: f.root,
    candidate: f.candidate,
    policy: {
      distributionId: "acme.openbot",
      repository: "acme/openbot",
      channel: "stable",
    },
    topology,
    backupDirectory: join(f.root, "backups"),
    acknowledgeInterruption: true,
    run,
    probe: async (url) =>
      url.endsWith("/release") ? f.identity : { status: "ok" },
  };
}
const isGit = (command: readonly string[]) =>
  command[0] === "git" || command[0] === "tar";
const isComposeConfig = (command: readonly string[]) =>
  command[0] === "docker" &&
  command[1] === "compose" &&
  command.includes("config");

function imageRunner(
  f: ReturnType<typeof installation>,
  calls: string[],
  reference: string,
  actualMigrationOutput?: string,
) {
  const run: CommandRunner = async (command, commandOptions) => {
    calls.push(command.join(" "));
    if (
      isGit(command) ||
      isComposeConfig(command) ||
      (command[0] === "docker" &&
        command[1] === "compose" &&
        command.includes("pull")) ||
      (command[0] === "docker" &&
        command[1] === "image" &&
        command[2] === "inspect")
    )
      return runCommand(command, commandOptions);
    if (
      actualMigrationOutput &&
      command.includes("migrate") &&
      (command.includes("run") || command.includes("--exit-code-from"))
    )
      return runCommand(command, {
        ...commandOptions,
        stdoutFile: actualMigrationOutput,
      });
    // Other lifecycle boundaries stay recorded in this scoped real-tool test.
    if (commandOptions.stdoutFile)
      writeFileSync(commandOptions.stdoutFile, "PGDMP fixture backup");
    if (command.includes("exec") && command.includes("bun"))
      return JSON.stringify(f.identity);
    if (command.includes("ps")) return "fixture-container\n";
    if (command[0] === "docker" && command[1] === "inspect")
      return command.includes("{{.State.Running}}")
        ? "true\n"
        : `${reference}\n`;
    return "";
  };
  return run;
}

describe.skipIf(!docker)(
  "image topology pulls with real Docker Compose",
  () => {
    let registry = "";
    let reference = "";
    // A pinned digest that exists only in a local registry, and not yet in this engine.
    beforeAll(async () => {
      const name = `fix979-registry-${id}`;
      // Chosen here rather than by `-p 127.0.0.1::5000`, because Docker Desktop's engine cannot
      // reach a host port it picked itself for a push.
      const port = await reservePort();
      sh([
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-p",
        `127.0.0.1:${port}:5000`,
        "registry:2",
      ]);
      cleanup.push(() => sh(["docker", "rm", "-f", name]));
      registry = `127.0.0.1:${port}`;
      const context = directory("openbot-real-image-");
      writeFileSync(join(context, "payload"), randomBytes(16).toString("hex"));
      writeFileSync(
        join(context, "Dockerfile"),
        "FROM scratch\nCOPY payload /payload\n",
      );
      const tag = `${registry}/openbot-update-test/server:${id}`;
      sh(["docker", "build", "--quiet", "--tag", tag, context]);
      cleanup.push(() => sh(["docker", "image", "rm", "-f", tag]));
      for (let attempt = 0; ; attempt++) {
        try {
          sh(["docker", "push", "--quiet", tag]);
          break;
        } catch (error) {
          if (attempt > 20) throw error;
          Bun.sleepSync(500);
        }
      }
      reference = sh([
        "docker",
        "image",
        "inspect",
        "--format",
        "{{index .RepoDigests 0}}",
        tag,
      ]);
      sh(["docker", "image", "rm", tag]);
      cleanup.push(() => sh(["docker", "image", "rm", "-f", reference]));
      expect(available(["docker", "image", "inspect", reference])).toBe(false);
    });

    test("the update pulls the pinned server image before it stops anything", async () => {
      const f = installation("COMPOSE_PROFILES=openbot\n");
      f.candidate.artifacts.images.server = { reference };
      const calls: string[] = [];
      const result = await applyLocalUpdate(
        options(f, "image", imageRunner(f, calls, reference)),
      );
      expect(result.phase).toBe("accepted");
      expect(available(["docker", "image", "inspect", reference])).toBe(true);
      const pull = calls.findIndex((call) =>
        call.includes(" pull server worker migrate"),
      );
      const stop = calls.findIndex((call) => call.includes(" stop "));
      expect(pull).toBeGreaterThan(-1);
      expect(stop).toBeGreaterThan(pull);
    });

    test("a pinned digest the registry does not have refuses before stopping anything", async () => {
      const f = installation("COMPOSE_PROFILES=openbot\n");
      f.candidate.artifacts.images.server = {
        reference: `${registry}/openbot-update-test/server@sha256:${"0".repeat(64)}`,
      };
      const calls: string[] = [];
      await expect(
        applyLocalUpdate(options(f, "image", imageRunner(f, calls, reference))),
      ).rejects.toThrow("nothing was stopped");
      expect(calls.some((call) => call.includes(" stop "))).toBe(false);
      expect(f.git("rev-parse", "HEAD")).toBe(f.old);
      expect(
        JSON.parse(
          readFileSync(join(f.root, ".openbot-update-journal.json"), "utf8"),
        ).phase,
      ).toBe("failed");
    });
  },
);

describe.skipIf(!docker)(
  "host topology starts with a real Docker build",
  () => {
    test("start.sh's build gets the source's own image names, never the release's digests", async () => {
      const f = installation(
        "DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5432/openbot\n",
      );
      // start.sh runs `up --build` and `run --build migrate` on the real Compose file. Each service is
      // pointed at a one-file Dockerfile, and its default tag is made unique so no real local
      // `openbot-*:latest` image is replaced; the `${VARIABLE:-...}` each one reads stays the real one.
      const project = directory("openbot-real-build-");
      writeFileSync(join(project, "docker-compose.yml"), composeFile);
      writeFileSync(join(project, "payload"), id);
      writeFileSync(
        join(project, "fixture.Dockerfile"),
        "FROM scratch\nCOPY payload /payload\n",
      );
      writeFileSync(
        join(project, "compose.fixture.yml"),
        `services:\n  migrate:\n    build: { context: ., dockerfile: fixture.Dockerfile }\n    image: \${SERVER_IMAGE:-openbot-update-test-server:${id}}\n  agent-computer:\n    build: { context: ., dockerfile: fixture.Dockerfile }\n    image: \${COMPUTER_IMAGE:-openbot-update-test-computer:${id}}\n`,
      );
      cleanup.push(() =>
        sh([
          "docker",
          "image",
          "rm",
          "-f",
          `openbot-update-test-server:${id}`,
          `openbot-update-test-computer:${id}`,
        ]),
      );
      const run: CommandRunner = async (command, commandOptions) => {
        if (isGit(command) || isComposeConfig(command))
          return runCommand(command, commandOptions);
        if (command[0] === "bash" && command[1] === "scripts/start.sh")
          return runCommand(
            [
              "docker",
              "compose",
              "--project-directory",
              project,
              "--project-name",
              `fix979-host-${id}`,
              "--file",
              join(project, "docker-compose.yml"),
              "--file",
              join(project, "compose.fixture.yml"),
              "build",
              "migrate",
              "agent-computer",
            ],
            { ...commandOptions, cwd: project },
          );
        if (commandOptions.stdoutFile)
          writeFileSync(commandOptions.stdoutFile, "PGDMP fixture backup");
        return "";
      };
      const result = await applyLocalUpdate(options(f, "host", run));
      expect(result.phase).toBe("accepted");
      expect(
        available([
          "docker",
          "image",
          "inspect",
          `openbot-update-test-computer:${id}`,
        ]),
      ).toBe(true);
    });
  },
);

const pgMajor = pgDump
  ? (sh(["pg_dump", "--version"]).match(/(\d+)\.\d+/)?.[1] ?? "")
  : "";
describe.skipIf(!docker || !pgDump)("host backups with real pg_dump", () => {
  test("a DATABASE_URL with an encoded password and query option backs up the named database", async () => {
    // The server's major version matches the host pg_dump, which refuses a newer server.
    const name = `fix979-pg-${id}`;
    const password = "p@ss:w/rd%#?";
    sh([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_USER=update_owner",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=customer_data",
      "-p",
      "127.0.0.1::5432",
      `postgres:${pgMajor}-alpine`,
    ]);
    cleanup.push(() => sh(["docker", "rm", "-f", name]));
    const port = sh(["docker", "port", name, "5432/tcp"])
      .split("\n")[0]
      ?.split(":")
      .pop();
    for (let attempt = 0; ; attempt++) {
      if (
        available([
          "docker",
          "exec",
          name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "update_owner",
          "-d",
          "customer_data",
        ])
      )
        break;
      if (attempt > 120)
        throw new Error("throwaway Postgres never became ready");
      Bun.sleepSync(500);
    }
    sh([
      "docker",
      "exec",
      name,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "update_owner",
      "-d",
      "customer_data",
      "-c",
      "create table customer_records (id int); insert into customer_records values (1);",
    ]);
    const databaseUrl = `postgres://update_owner:${encodeURIComponent(password)}@127.0.0.1:${port}/customer_data?sslmode=disable`;
    const f = installation(`DATABASE_URL=${databaseUrl}\n`);
    const calls: { command: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const run: CommandRunner = async (command, commandOptions) => {
      calls.push({ command: [...command], env: commandOptions.env });
      if (
        isGit(command) ||
        isComposeConfig(command) ||
        command[0] === "pg_dump" ||
        command[0] === "pg_restore"
      )
        return runCommand(command, commandOptions);
      return "";
    };
    // The process environment outranks .env for the updater, and the test job sets its own.
    const inherited = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    try {
      const result = await applyLocalUpdate(options(f, "host", run));
      expect(result.phase).toBe("accepted");
      const dump = join(result.backupDirectory, "database.dump");
      expect(existsSync(dump)).toBe(true);
      expect(sh(["pg_restore", "--list", dump])).toContain("customer_records");
      for (const call of calls)
        expect(call.command.join(" ")).not.toContain(password);
      const backup = calls.find((call) => call.command[0] === "pg_dump");
      expect(backup?.env?.PGDATABASE).toBe("customer_data");
    } finally {
      if (inherited === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = inherited;
    }
  });
});

describe.skipIf(!docker)("image migration with real Docker Compose", () => {
  test.each([0, 7])(
    "executes the image without building and propagates migration exit %s",
    async (exitCode) => {
      const project = `fix979-migrate-${id}-${exitCode}`;
      const f = installation(
        `COMPOSE_PROJECT_NAME=${project}\nCOMPOSE_PROFILES=openbot\n`,
      );
      const reference = sh([
        "docker",
        "image",
        "inspect",
        "--format",
        "{{index .RepoDigests 0}}",
        "registry:2",
      ]);
      f.candidate.artifacts.images.server = { reference };
      // An executable cached image and no Dockerfile in the checkout: any accidental build fails.
      // SQL/backup/server boundaries remain recorded; the actual migration CLI must reach this process.
      writeFileSync(
        join(f.root, "docker-compose.override.yml"),
        `services:\n  migrate:\n    entrypoint: ["/bin/sh"]\n    command: ${JSON.stringify(["-ec", `printf 'compose-migration-executed\\n'; exit ${exitCode}`])}\n`,
      );
      cleanup.push(() =>
        sh([
          "docker",
          "compose",
          "--project-directory",
          f.root,
          "--project-name",
          project,
          "down",
          "--volumes",
        ]),
      );
      const output = join(f.root, "migration-output.log");
      const run = imageRunner(f, [], reference, output);
      if (exitCode === 0) {
        expect((await applyLocalUpdate(options(f, "image", run))).phase).toBe(
          "accepted",
        );
      } else {
        await expect(
          applyLocalUpdate(options(f, "image", run)),
        ).rejects.toThrow(`exit ${exitCode}`);
        expect(
          JSON.parse(
            readFileSync(join(f.root, ".openbot-update-journal.json"), "utf8"),
          ).phase,
        ).toBe("recovery-required");
        expect(
          JSON.parse(
            readFileSync(join(f.root, ".openbot-release.json"), "utf8"),
          ).source.commit,
        ).toBe(f.old);
      }
      expect(readFileSync(output, "utf8")).toContain(
        "compose-migration-executed",
      );
    },
  );
});
