/**
 * Nothing that reads OpenBot's database starts before that database can serve it, rendered by real
 * Helm from the real chart and then run against a real PostgreSQL.
 *
 * What must not regress, seen on a fresh vanilla install: the server pods started five seconds after
 * the release did, fifteen seconds before the bundled PostgreSQL was Ready and half a minute before
 * the migrations Job finished. Every first install logged `Failed query: insert into "users"`,
 * `PostgresError: Failed to connect` and a Learning auto-assign error before the server's own retries
 * recovered, and nothing stopped a server from running against a schema the migrations had not
 * reached yet.
 *  - every workload of this chart that carries DATABASE_URL, on every shipped `ci/` target, is held by
 *    the `wait-for-database` init container: the chart's wait script, the workload's own image, the
 *    same database address and credentials as the container it holds, from the directory the
 *    migrations Job migrates from, with a bound;
 *  - whatever it waits for is never behind it: on a first install with the bundled database the
 *    migrations Job is an ordinary resource created beside the server, and otherwise a pre-install or
 *    pre-upgrade hook that has finished before the server exists, so `helm install --wait` cannot
 *    deadlock on it;
 *  - the script itself refuses an empty database, a half-migrated one, a refused password and a
 *    database that is not there, and lets go of a fully migrated one, including the moment a
 *    migration it is waiting on lands.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm") !== null;
const chart = join(import.meta.dir, "../charts/openbot");
const serverDirectory = join(import.meta.dir, "../server");
const script = readFileSync(join(chart, "files/wait-for-database.mjs"), "utf8");
const SANDBOX_API = [
  "--api-versions",
  "agents.x-k8s.io/v1beta1/Sandbox",
  "--api-versions",
  "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
];

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
};
type Container = {
  name: string;
  image?: string;
  command?: string[];
  workingDir?: string;
  env?: EnvVar[];
};
type PodSpec = { containers: Container[]; initContainers?: Container[] };
type Doc = {
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    activeDeadlineSeconds?: number;
    template?: { spec: PodSpec };
    jobTemplate?: {
      spec: { activeDeadlineSeconds?: number; template: { spec: PodSpec } };
    };
  };
};

function render(...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      chart,
      "--namespace",
      "openbot",
      "--set-string",
      `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
      ...SANDBOX_API,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return parseAllDocuments(new TextDecoder().decode(result.stdout))
    .map((document) => document.toJSON() as Doc | null)
    .filter((document): document is Doc => document !== null);
}

const values = (target: string) => [
  "--values",
  join(chart, `ci/${target}-values.yaml`),
];
const TARGETS = ["vanilla", "self-hosted", "eks", "eks-sandbox", "gke", "aks"];

const component = (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/component"];
/** This chart's own objects, not the bundled Intelligence's or PostgreSQL's. */
const own = (doc: Doc) =>
  doc.metadata.labels?.["helm.sh/chart"]?.startsWith("openbot-") === true;

function pod(doc: Doc): PodSpec | undefined {
  return doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec.template.spec;
}

const databaseEnv = (container: Container | undefined) =>
  (container?.env ?? []).filter(
    (entry) =>
      entry.name === "DATABASE_URL" || entry.name === "POSTGRES_PASSWORD",
  );

/** Every workload of this chart whose main container opens the database, except the one that migrates it. */
function readers(docs: Doc[]): Doc[] {
  return docs.filter(
    (doc) =>
      own(doc) &&
      ["Deployment", "StatefulSet", "Job", "CronJob"].includes(doc.kind) &&
      component(doc) !== "migrations" &&
      (pod(doc)?.containers ?? []).some((container) =>
        (container.env ?? []).some((entry) => entry.name === "DATABASE_URL"),
      ),
  );
}

function migrationsJob(docs: Doc[]): Doc | undefined {
  return docs.find(
    (doc) => own(doc) && doc.kind === "Job" && component(doc) === "migrations",
  );
}

const waitOf = (doc: Doc) =>
  pod(doc)?.initContainers?.find(
    (container) => container.name === "wait-for-database",
  );

const waitSeconds = (container: Container | undefined) =>
  Number(
    container?.env?.find(
      (entry) => entry.name === "OPENBOT_DATABASE_WAIT_SECONDS",
    )?.value,
  );

describe.skipIf(!helm)("every database reader waits for the database", () => {
  for (const target of TARGETS) {
    test(`${target}: each one is held until its own connection works and the image's migrations are applied`, () => {
      const docs = render(...values(target));
      const found = readers(docs);
      // A check that finds nothing has not passed: the server and the routines sweep read it everywhere.
      expect(found.map(component)).toEqual(
        expect.arrayContaining(["server", "routines"]),
      );
      const migrate = migrationsJob(docs)?.spec?.template?.spec.containers[0];
      expect(migrate?.workingDir).toBe("/app/server");

      for (const doc of found) {
        const main = pod(doc)?.containers[0];
        const wait = waitOf(doc);
        expect(wait, `${doc.kind} ${doc.metadata.name}`).toBeDefined();
        // The chart's wait script, run by the image's own Bun.
        expect(wait?.command).toEqual(["/usr/local/bin/bun", "-e", script]);
        // The same image, so nothing new is pulled and the migrations are the ones it was built with.
        expect(wait?.image).toBe(main?.image);
        // From where the migrations Job migrates, so `drizzle/` is the folder that Job applies.
        expect(wait?.workingDir).toBe(migrate?.workingDir);
        // This workload's own address and credentials, not some other way in.
        expect(databaseEnv(wait)).toEqual(databaseEnv(main));
        expect(databaseEnv(wait).length).toBeGreaterThan(0);

        const seconds = waitSeconds(wait);
        expect(Number.isInteger(seconds) && seconds > 0).toBe(true);
        if (doc.kind === "CronJob") {
          // Inside the run's own ceiling, so the wait says why it stopped instead of being killed.
          const deadline = doc.spec?.jobTemplate?.spec.activeDeadlineSeconds;
          expect(seconds).toBeLessThan(deadline ?? 0);
        } else {
          // As long as the migrations Job may run, so the server never gives up on one still working.
          expect(seconds).toBe(
            migrationsJob(docs)?.spec?.activeDeadlineSeconds ?? 900,
          );
        }
      }
    });
  }

  test("the computer culler, which only sandbox mode renders, waits too", () => {
    const docs = render(...values("eks-sandbox"));
    const culler = readers(docs).find((doc) => component(doc) === "culler");
    expect(culler).toBeDefined();
    expect(waitOf(culler as Doc)).toBeDefined();
  });

  test("a database URL given as a value or in a Secret of the operator's reaches the wait unchanged", () => {
    for (const args of [
      [
        "--set-string",
        "database.url=postgres://openbot:pw@db.example:5432/openbot?sslmode=require",
      ],
      ["--set-string", "database.existingSecret=my-database"],
    ]) {
      const docs = render(
        ...values("vanilla"),
        "--set",
        "postgresql.enabled=false",
        // Generated only beside the bundled database; one of the operator's needs its own.
        "--set-string",
        `secrets.computerToken=${randomBytes(32).toString("hex")}`,
        ...args,
      );
      const server = readers(docs).find((doc) => component(doc) === "server");
      expect(databaseEnv(waitOf(server as Doc))).toEqual(
        databaseEnv(pod(server as Doc)?.containers[0]),
      );
    }
  });

  /*
   * THE DEADLOCK THIS MUST NEVER BUILD. The server waits for the migrations, and `--wait` waits for
   * the server. A migrations Job that ran AFTER the server is ready (a post-install hook) would be a
   * release that waits for itself until the timeout. Pre hooks finish before the server exists; an
   * ordinary Job is created beside it.
   */
  for (const [name, args] of [
    ["first install, bundled database", values("vanilla")],
    ["first install, own database", values("eks")],
    ["upgrade, bundled database", [...values("vanilla"), "--is-upgrade"]],
    ["upgrade, own database", [...values("eks"), "--is-upgrade"]],
  ] as const) {
    test(`${name}: the migrations the server waits for are never behind it`, () => {
      const job = migrationsJob(render(...args));
      expect(job).toBeDefined();
      const hook = job?.metadata.annotations?.["helm.sh/hook"];
      if (hook === undefined) {
        expect(name).toBe("first install, bundled database");
      } else {
        const phases = hook.split(",").map((phase) => phase.trim());
        expect(phases.every((phase) => phase.startsWith("pre-"))).toBe(true);
        expect(phases).toContain(
          name.startsWith("upgrade") ? "pre-upgrade" : "pre-install",
        );
      }
    });
  }

  test("with the chart's migrations switched off the server still waits for them, and says who runs them", () => {
    const docs = render(
      ...values("vanilla"),
      "--set",
      "migrations.enabled=false",
    );
    expect(migrationsJob(docs)).toBeUndefined();
    const server = readers(docs).find((doc) => component(doc) === "server");
    const hint = waitOf(server as Doc)?.env?.find(
      (entry) => entry.name === "OPENBOT_DATABASE_WAIT_HINT",
    )?.value;
    expect(hint).toContain("migrations.enabled");
  });
});

/*
 * The script the chart renders, run as the init container runs it: `bun -e` from the server
 * directory, which holds the same `drizzle/` folder and `postgres` client the image does.
 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const created: string[] = [];

function administrative(): string {
  const url = new URL(databaseUrl as string);
  url.pathname = "/postgres";
  return url.href;
}

async function scratchDatabase(): Promise<string> {
  const name = `openbot_dbwait_${randomBytes(4).toString("hex")}`;
  const admin = new SQL(administrative());
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(databaseUrl as string);
  url.pathname = `/${name}`;
  return url.href;
}

afterAll(async () => {
  if (!databaseUrl || created.length === 0) return;
  const admin = new SQL(administrative());
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.close({ timeout: 5 });
  }
});

/** The rendered init container, as the server Deployment of a vanilla install carries it. */
function renderedWait(): Container {
  const docs = render(...values("vanilla"));
  const server = readers(docs).find((doc) => component(doc) === "server");
  const wait = server ? waitOf(server) : undefined;
  if (!wait?.command) throw new Error("the server has no wait-for-database");
  return wait;
}

function startWait(url: string, seconds: number) {
  const wait = renderedWait();
  const [, ...args] = wait.command as string[];
  // The image's Bun is /usr/local/bin/bun; here it is whichever Bun runs this test.
  return Bun.spawn([process.execPath, ...args], {
    cwd: serverDirectory,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url,
      OPENBOT_DATABASE_WAIT_SECONDS: String(seconds),
      OPENBOT_DATABASE_WAIT_HINT:
        wait.env?.find((entry) => entry.name === "OPENBOT_DATABASE_WAIT_HINT")
          ?.value ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runWait(url: string, seconds: number) {
  const child = startWait(url, seconds);
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: out + err };
}

const migrationsFolder = join(serverDirectory, "drizzle");
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
const newest = journal.entries.at(-1)?.tag as string;

/** The image's migrations, all but the newest: a database an upgrade has not migrated yet. */
function allButNewest(): string {
  const directory = mkdtempSync(join(tmpdir(), "dbwait-migrations-"));
  cpSync(migrationsFolder, directory, { recursive: true });
  writeFileSync(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }),
  );
  return directory;
}

/** Every migration, exactly as the migrations Job applies them: its own command, from its directory. */
async function migrateAll(url: string) {
  await run(["scripts/migrate.ts"], url);
}

/** A folder of them, through the same guarded migrator. */
async function migrateFolder(url: string, folder: string) {
  await run(
    [
      "-e",
      `import postgres from "postgres";
       import { applyMigrations } from "./src/db/apply-migrations";
       const client = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
       await applyMigrations(client, process.env.MIGRATIONS_FOLDER);
       await client.end({ timeout: 5 });`,
    ],
    url,
    { MIGRATIONS_FOLDER: folder },
  );
}

/** Bun, with these arguments, from the server directory, as the image runs it from /app/server. */
async function run(
  args: string[],
  url: string,
  extra: Record<string, string> = {},
) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: serverDirectory,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`bun ${args[0]} failed: ${err}`);
}

describe.skipIf(!helm || !databaseUrl)("the wait, against PostgreSQL", () => {
  test("refuses an empty database and a half-migrated one, and lets go of a migrated one", async () => {
    const url = await scratchDatabase();

    const empty = await runWait(url, 3);
    expect(empty.code).toBe(1);
    expect(empty.output).toContain("no migration has been applied");
    expect(empty.output).toContain("was not ready within 3s");

    await migrateFolder(url, allButNewest());
    const half = await runWait(url, 3);
    expect(half.code).toBe(1);
    expect(half.output).toContain(
      `${journal.entries.length - 1} of the ${journal.entries.length} migrations`,
    );
    expect(half.output).toContain(`${newest} is not`);

    await migrateAll(url);
    const ready = await runWait(url, 30);
    expect(ready.output).toContain("OpenBot's database is ready");
    expect(ready.code).toBe(0);
  }, 120_000);

  test("lets go as soon as the migrations it is waiting on land, which is a first install", async () => {
    const url = await scratchDatabase();
    const child = startWait(url, 120);
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([out, err]) => out + err);
    await Bun.sleep(3_000);
    expect(child.exitCode).toBeNull();
    await migrateAll(url);
    const code = await child.exited;
    expect(await output).toContain("Still waiting");
    expect(code).toBe(0);
  }, 150_000);

  test("refuses credentials the database refuses, and never prints the password", async () => {
    const url = new URL(await scratchDatabase());
    const password = `wrong-${randomBytes(6).toString("hex")}`;
    url.password = password;
    const { code, output } = await runWait(url.href, 3);
    expect(code).toBe(1);
    expect(output).toContain("does not accept this workload's connection");
    expect(output).not.toContain(password);
  }, 60_000);

  test("refuses a database that is not there, within its bound", async () => {
    const started = Date.now();
    const { code, output } = await runWait(
      "postgres://openbot:openbot@127.0.0.1:1/openbot",
      3,
    );
    expect(code).toBe(1);
    expect(output).toContain("does not accept this workload's connection");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});
