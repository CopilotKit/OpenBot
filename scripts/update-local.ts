/** Explicit source-checkout upgrades. No startup path imports or invokes this module. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  parseReleaseManifest,
  planUpgrade,
  type ReleaseManifest,
  type UpgradePlan,
  type UpgradePolicy,
} from "../shared/release-manifest";

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutFile?: string;
  stdinFile?: string;
  timeoutMs?: number;
  acceptExitCodes?: number[];
}
export type CommandRunner = (
  command: readonly string[],
  options: CommandOptions,
) => Promise<string>;

/** No shell interpolation. Backup output streams to a private file instead of process memory. */
export const runCommand: CommandRunner = async (command, options) => {
  const input = options.stdinFile
    ? openSync(options.stdinFile, "r")
    : undefined;
  const output = options.stdoutFile
    ? openSync(options.stdoutFile, "w", 0o600)
    : undefined;
  try {
    // Direct descriptors preserve custom-format dump bytes and avoid a Bun 1.3 pipe/Response
    // completion hang. The parent closes its descriptors only after the child has exited.
    const child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: input ?? "ignore",
      stdout: output ?? "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 300_000,
    });
    const text =
      child.stdout instanceof ReadableStream
        ? new Response(child.stdout).text()
        : Promise.resolve("");
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      text,
      new Response(child.stderr).text(),
    ]);
    if (!(options.acceptExitCodes ?? [0]).includes(code))
      throw new Error(
        `${command[0]} ${command[1] ?? ""} failed with exit ${code}${stderr.trim() ? "; inspect that tool's local diagnostics" : ""}`,
      );
    return stdout;
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
  }
};

export interface LocalUpdateOptions {
  root: string;
  candidate: ReleaseManifest;
  policy: UpgradePolicy;
  topology: "host" | "image";
  backupDirectory: string;
  acknowledgeInterruption?: boolean;
  timeoutSeconds?: number;
  customerPaths?: string[];
  intelligenceCapabilities?: string[];
  run?: CommandRunner;
  probe?: (url: string) => Promise<ProbeResponse | undefined>;
}
interface ProbeResponse {
  status?: string;
  version?: string;
  commit?: string;
  distributionId?: string;
  repository?: string;
  channel?: string;
}
export interface LocalUpdatePlan extends UpgradePlan {
  root: string;
  topology: "host" | "image";
  currentCommit: string;
  targetCommit: string;
  composeProject: string;
  protectedPaths: string[];
}
export interface UpdateJournal {
  operation: string;
  phase:
    | "staging"
    | "stopping"
    | "backing-up"
    | "installing"
    | "migrating"
    | "starting"
    | "verifying"
    | "accepted"
    | "failed"
    | "recovery-required";
  fromVersion: string;
  toVersion: string;
  previousCommit: string;
  targetCommit: string;
  topology: "host" | "image";
  composeProject: string;
  databaseMayHaveChanged: boolean;
  backupDirectory: string;
  recovery: string;
  error?: string;
}
interface ComposeService {
  image?: string;
  environment?: Record<string, string>;
  volumes?: { type?: string; source?: string; target?: string }[];
}
interface ComposeConfiguration {
  name: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}
const ACCEPTED = ".openbot-release.json";
const JOURNAL = ".openbot-update-journal.json";
const LOCK = ".openbot-update.lock";
const IMAGE_VARIABLES: Record<string, string> = {
  server: "SERVER_IMAGE",
  supervisor: "SUPERVISOR_IMAGE",
  "agent-computer": "COMPUTER_IMAGE",
  "agent-bot": "BOT_IMAGE",
  "agent-langgraph": "LANGGRAPH_IMAGE",
};

export function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}
function environment(root: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  if (existsSync(join(root, ".env"))) {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(
      /\r?\n/,
    )) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
      );
      if (!match?.[1]) continue;
      let value = match[2] ?? "";
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "").trim();
      values[match[1]] = value;
    }
  }
  return { ...values, ...process.env };
}
export function acceptedBuildEnvironment(root: string): Record<string, string> {
  const manifest = parseReleaseManifest(
    JSON.parse(readFileSync(join(root, ACCEPTED), "utf8")),
  );
  return {
    OPENBOT_BUILD_VERSION: manifest.version,
    OPENBOT_BUILD_COMMIT: manifest.source.commit,
    OPENBOT_BUILD_DISTRIBUTION_ID: manifest.distribution.id,
    OPENBOT_BUILD_REPOSITORY: manifest.distribution.repository,
    OPENBOT_BUILD_CHANNEL: manifest.distribution.channel,
  };
}
function imagesEnvironment(
  manifest: ReleaseManifest,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    IMAGE_PULL_POLICY: "never",
    OPENBOT_BUILD_VERSION: manifest.version,
    OPENBOT_BUILD_COMMIT: manifest.source.commit,
    OPENBOT_BUILD_DISTRIBUTION_ID: manifest.distribution.id,
    OPENBOT_BUILD_REPOSITORY: manifest.distribution.repository,
    OPENBOT_BUILD_CHANNEL: manifest.distribution.channel,
  };
  for (const [name, variable] of Object.entries(IMAGE_VARIABLES)) {
    const image = manifest.artifacts.images[name];
    if (image) result[variable] = image.reference;
  }
  return result;
}
function protectedPaths(root: string, env: NodeJS.ProcessEnv, extra: string[]) {
  const tenant = env.TENANT_PACKAGE_DIR
    ? resolve(root, "server", env.TENANT_PACKAGE_DIR)
    : join(root, "examples", "fintech");
  const paths = [
    ".env",
    ".openbot",
    ".openbot-deployment",
    ACCEPTED,
    JOURNAL,
    LOCK,
    ".openbot-update-policy.json",
    "docker-compose.override.yml",
    "compose.override.yaml",
    ".logs",
    ...extra,
  ];
  const tenantRelative = relative(root, tenant);
  if (
    tenantRelative &&
    !tenantRelative.startsWith("..") &&
    !isAbsolute(tenantRelative)
  )
    paths.push(tenantRelative);
  return [
    ...new Set(
      paths.map((path) =>
        relative(root, resolve(root, path)).replaceAll("\\", "/"),
      ),
    ),
  ];
}
function covers(path: string, protectedPath: string) {
  return path === protectedPath || path.startsWith(`${protectedPath}/`);
}
function compose(command: string[], root: string, project?: string) {
  return [
    "docker",
    "compose",
    "--project-directory",
    root,
    ...(project ? ["--project-name", project] : []),
    ...command,
  ];
}
function readConfiguration(text: string): ComposeConfiguration {
  const value: ComposeConfiguration = JSON.parse(text);
  if (!value.name || !value.services?.postgres || !value.services.migrate)
    throw new Error(
      "Unsupported Compose shape: named project, postgres and migrate services are required",
    );
  return value;
}
function volumeIdentity(configuration: ComposeConfiguration) {
  return JSON.stringify(
    Object.entries(configuration.volumes ?? {})
      .map(([key, value]) => [key, value.name, value.external])
      .sort(),
  );
}
function preservedState(
  before: ComposeConfiguration,
  after: ComposeConfiguration,
) {
  if (
    before.name !== after.name ||
    volumeIdentity(before) !== volumeIdentity(after)
  )
    return false;
  for (const [name, service] of Object.entries(before.services)) {
    for (const volume of service.volumes ?? []) {
      if (
        !after.services[name]?.volumes?.some(
          (candidate) =>
            candidate.type === volume.type &&
            candidate.source === volume.source &&
            candidate.target === volume.target,
        )
      )
        return false;
    }
    for (const key of [
      "COMPUTER_NAMESPACE",
      "TENANT_PACKAGE_DIR",
      "OPENBOT_MODEL_OAUTH_FILE",
    ]) {
      const existing = service.environment?.[key];
      if (existing && existing !== after.services[name]?.environment?.[key])
        return false;
    }
  }
  return true;
}
async function fileSha256(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function candidateConfiguration(
  root: string,
  commit: string,
  project: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
) {
  if (env.COMPOSE_FILE || env.COMPOSE_ENV_FILES)
    throw new Error(
      "Custom COMPOSE_FILE/COMPOSE_ENV_FILES needs a reviewed integration; this updater preserves the standard Compose file and overrides",
    );
  const directory = mkdtempSync(join(tmpdir(), "openbot-compose-preflight-"));
  try {
    const source = await run(["git", "show", `${commit}:docker-compose.yml`], {
      cwd: root,
    });
    const file = join(directory, "docker-compose.yml");
    writeFileSync(file, source, { mode: 0o600 });
    const files = ["--file", file];
    const overrides = [
      "docker-compose.override.yml",
      "docker-compose.override.yaml",
    ].filter((path) => existsSync(join(root, path)));
    if (overrides.length > 1)
      throw new Error(
        "Ambiguous Compose override files require explicit integration",
      );
    for (const path of overrides) files.push("--file", join(root, path));
    const args = [
      "docker",
      "compose",
      "--project-directory",
      root,
      "--project-name",
      project,
      ...(existsSync(join(root, ".env"))
        ? ["--env-file", join(root, ".env")]
        : []),
      ...files,
      "config",
      "--format",
      "json",
    ];
    return readConfiguration(await run(args, { cwd: root, env }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
async function hostStopped(
  root: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
) {
  if (process.platform === "win32")
    throw new Error(
      "Host update ownership checks currently require macOS or Linux; use a reviewed source integration on Windows",
    );
  for (const port of [env.APP_PORT ?? "3010", env.SERVER_PORT ?? "3001"]) {
    if (!/^\d{1,5}$/.test(port))
      throw new Error("Invalid configured host port");
    if (
      (
        await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
          cwd: root,
          acceptExitCodes: [0, 1],
        })
      ).trim()
    )
      throw new Error(
        "Stop this installation's app and API server before applying a host update; no port owner was stopped",
      );
  }
  const workers = (
    await run(["pgrep", "-f", "bun worker/src/index.ts"], {
      cwd: root,
      acceptExitCodes: [0, 1],
    })
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const pid of workers) {
    if (!/^\d+$/.test(pid))
      throw new Error("Could not establish host worker ownership");
    const cwd = await run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], {
      cwd: root,
    });
    if (cwd.split("\n").includes(`n${root}`))
      throw new Error(
        "Stop this installation's routine worker before applying a host update; no process was stopped",
      );
    throw new Error(
      "Another installation's host worker is active; existing startup shares global worker detection, so the update was paused without stopping that worker",
    );
  }
}

export function assertLocalStartAllowed(root: string, operation?: string) {
  if (!existsSync(join(root, JOURNAL))) return;
  const journal: { phase?: string; operation?: string } = JSON.parse(
    readFileSync(join(root, JOURNAL), "utf8"),
  );
  if (journal.phase === "accepted") return;
  if (
    operation &&
    operation === journal.operation &&
    journal.phase === "starting"
  )
    return;
  throw new Error(
    "Startup is blocked until update recovery is resolved. Inspect .openbot-update-journal.json and its matching backup; starting source against an ambiguous schema is unsafe.",
  );
}

async function ownedHostProcesses(
  root: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
) {
  const pids = new Set<string>();
  for (const port of [env.APP_PORT ?? "3010", env.SERVER_PORT ?? "3001"]) {
    const listeners = await run(
      ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { cwd: root, acceptExitCodes: [0, 1] },
    );
    for (const pid of listeners.trim().split(/\s+/).filter(Boolean))
      pids.add(pid);
  }
  const workers = await run(["pgrep", "-f", "bun worker/src/index.ts"], {
    cwd: root,
    acceptExitCodes: [0, 1],
  });
  for (const pid of workers.trim().split(/\s+/).filter(Boolean)) pids.add(pid);
  const owned: string[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid))
      throw new Error(
        "Could not establish process ownership during failed update cleanup",
      );
    const cwd = await run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], {
      cwd: root,
      acceptExitCodes: [0, 1],
    });
    if (
      cwd
        .split("\n")
        .some((line) =>
          [root, join(root, "server"), join(root, "app")].some(
            (path) => line === `n${path}`,
          ),
        )
    )
      owned.push(pid);
  }
  return owned;
}
async function stopOwnedHost(
  root: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
) {
  const owned = await ownedHostProcesses(root, env, run);
  if (owned.length) await run(["kill", "-TERM", ...owned], { cwd: root });
}

async function inspect(
  options: LocalUpdateOptions,
  lockHeld: boolean,
): Promise<LocalUpdatePlan> {
  const root = realpathSync(options.root);
  const run = options.run ?? runCommand;
  const candidate = parseReleaseManifest(options.candidate);
  const current = parseReleaseManifest(
    JSON.parse(readFileSync(join(root, ACCEPTED), "utf8")),
  );
  const env = environment(root);
  const plan: LocalUpdatePlan = {
    ...planUpgrade(
      {
        manifest: current,
        sourceKind: "stock",
        launcherApi: 1,
        configSchema: current.compatibility.configSchema,
        extensionApi: current.compatibility.extensionApi,
        intelligenceCapabilities:
          options.intelligenceCapabilities ??
          current.compatibility.intelligenceCapabilities,
      },
      candidate,
      options.policy,
    ),
    root,
    topology: options.topology,
    currentCommit: current.source.commit,
    targetCommit: candidate.source.commit,
    composeProject: "",
    protectedPaths: protectedPaths(root, env, options.customerPaths ?? []),
  };
  try {
    if (!lockHeld && existsSync(join(root, LOCK)))
      throw new Error(
        "An update lock exists; inspect the interrupted operation before removing it",
      );
    if (existsSync(join(root, JOURNAL))) {
      const previous: { phase?: string } = JSON.parse(
        readFileSync(join(root, JOURNAL), "utf8"),
      );
      if (previous.phase !== "accepted" && previous.phase !== "failed")
        throw new Error(
          "An interrupted update requires recovery; inspect .openbot-update-journal.json before retrying",
        );
    }
    if (options.topology !== "host" && options.topology !== "image")
      throw new Error("Unknown topology; explicitly choose host or image");
    if (
      !Number.isInteger(options.timeoutSeconds ?? 120) ||
      (options.timeoutSeconds ?? 120) < 1 ||
      (options.timeoutSeconds ?? 120) > 3600
    )
      throw new Error("Timeout must be an integer between 1 and 3600 seconds");
    const toplevel = (
      await run(["git", "rev-parse", "--show-toplevel"], { cwd: root })
    ).trim();
    if (realpathSync(toplevel) !== root)
      throw new Error(
        "Unknown source layout: installation must be the Git checkout root",
      );
    const head = (
      await run(["git", "rev-parse", "HEAD"], { cwd: root })
    ).trim();
    if (head !== current.source.commit)
      throw new Error(
        "Checkout differs from accepted distribution baseline; run scripts/integrate-upstream.ts in an isolated candidate before applying",
      );
    if (
      (
        await run(["git", "status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
        })
      ).trim()
    )
      throw new Error(
        "Locally modified tracked source requires isolated upstream integration before applying",
      );
    await run(
      ["git", "merge-base", "--is-ancestor", head, candidate.source.commit],
      { cwd: root },
    );
    const changed = (
      await run(
        ["git", "diff", "--name-only", "-z", head, candidate.source.commit],
        { cwd: root },
      )
    )
      .split("\0")
      .filter(Boolean);
    const collisions = changed.filter((path) =>
      plan.protectedPaths.some((protectedPath) => covers(path, protectedPath)),
    );
    if (collisions.length)
      throw new Error(
        `Candidate changes customer-owned paths: ${collisions.join(", ")}; integrate these changes explicitly`,
      );
    if (!candidate.artifacts.images.server)
      throw new Error("Release has no digest-pinned server image");
    const before = readConfiguration(
      await run(compose(["config", "--format", "json"], root), {
        cwd: root,
        env,
      }),
    );
    const after = await candidateConfiguration(
      root,
      candidate.source.commit,
      before.name,
      imagesEnvironment(candidate, env),
      run,
    );
    if (!preservedState(before, after))
      throw new Error(
        "Candidate would change Compose project or volume identities",
      );
    if (
      options.topology === "image" &&
      (after.services.server?.image !==
        candidate.artifacts.images.server.reference ||
        after.services.worker?.image !==
          candidate.artifacts.images.server.reference ||
        after.services.migrate?.image !==
          candidate.artifacts.images.server.reference)
    )
      throw new Error(
        "Compose overrides do not resolve server, worker and migrate to the accepted candidate image",
      );
    if (options.topology === "image") {
      const database = before.services.server?.environment?.DATABASE_URL;
      if (
        !database ||
        before.services.migrate?.environment?.DATABASE_URL !== database ||
        before.services.worker?.environment?.DATABASE_URL !== database ||
        after.services.server?.environment?.DATABASE_URL !== database ||
        after.services.migrate?.environment?.DATABASE_URL !== database ||
        after.services.worker?.environment?.DATABASE_URL !== database
      )
        throw new Error(
          "Candidate must preserve the same database identity for server, worker and migration",
        );
    }
    plan.composeProject = before.name;
    if (options.topology === "host") await hostStopped(root, env, run);
    else if ((await ownedHostProcesses(root, env, run)).length)
      throw new Error(
        "Host processes belonging to this installation are still running; stop them before choosing image topology",
      );
  } catch (error) {
    plan.reasons.push(error instanceof Error ? error.message : String(error));
  }
  plan.allowed = plan.reasons.length === 0;
  return plan;
}
export function planLocalUpdate(options: LocalUpdateOptions) {
  return inspect(options, false);
}

async function waitForReadiness(
  options: LocalUpdateOptions,
  env: NodeJS.ProcessEnv,
) {
  const probe =
    options.probe ??
    (async (url: string): Promise<ProbeResponse | undefined> => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return;
        return await response.json();
      } catch {
        return;
      }
    });
  const deadline = Date.now() + (options.timeoutSeconds ?? 120) * 1000;
  while (Date.now() < deadline) {
    const base = `http://127.0.0.1:${env.SERVER_PORT ?? "3001"}`;
    const health = await probe(`${base}/health`);
    const release = await probe(`${base}/release`);
    const expected = options.candidate;
    if (
      health?.status === "ok" &&
      release?.version === expected.version &&
      release.commit === expected.source.commit &&
      release.distributionId === expected.distribution.id &&
      release.repository === expected.distribution.repository &&
      release.channel === expected.distribution.channel
    )
      return;
    await Bun.sleep(500);
  }
  throw new Error(
    "Candidate did not become ready within the configured deadline",
  );
}

/** Caller authenticates candidate metadata. Apply supports a clean, known Git baseline only. */
export async function applyLocalUpdate(
  options: LocalUpdateOptions,
): Promise<UpdateJournal> {
  if (!options.acknowledgeInterruption)
    throw new Error(
      "Explicitly acknowledge interruption of active work before applying an update",
    );
  const initial = await inspect(options, false);
  if (!initial.allowed) throw new Error(initial.reasons.join("; "));
  const root = initial.root;
  mkdirSync(join(root, LOCK), { mode: 0o700 });
  const run = options.run ?? runCommand;
  const env = environment(root);
  const candidateEnv = imagesEnvironment(options.candidate, env);
  const operation = randomUUID();
  candidateEnv.OPENBOT_UPDATE_OPERATION = operation;
  const backupDirectory = resolve(options.backupDirectory, operation);
  let installed = false;
  const journal: UpdateJournal = {
    operation,
    phase: "staging",
    fromVersion: initial.fromVersion,
    toVersion: initial.toVersion,
    previousCommit: initial.currentCommit,
    targetCommit: initial.targetCommit,
    topology: options.topology,
    composeProject: initial.composeProject,
    databaseMayHaveChanged: false,
    backupDirectory,
    recovery:
      "Before migration, restore the saved source commit and restart. After migration begins, keep writes stopped and inspect the database backup before recovery.",
  };
  const phase = (value: UpdateJournal["phase"]) => {
    journal.phase = value;
    atomicJson(join(root, JOURNAL), journal);
  };
  try {
    const verified = await inspect(options, true);
    if (!verified.allowed) throw new Error(verified.reasons.join("; "));
    const originalConfiguration = readConfiguration(
      await run(
        compose(["config", "--format", "json"], root, initial.composeProject),
        { cwd: root, env },
      ),
    );
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(backupDirectory).isSymbolicLink())
      throw new Error("Backup directory must not be a symbolic link");
    phase("staging");
    await run(
      [
        "git",
        "archive",
        "--format=tar",
        `--output=${join(backupDirectory, "candidate-source.tar")}`,
        initial.targetCommit,
      ],
      { cwd: root },
    );
    await run(
      [
        "git",
        "archive",
        "--format=tar",
        `--output=${join(backupDirectory, "previous-source.tar")}`,
        initial.currentCommit,
      ],
      { cwd: root },
    );
    atomicJson(
      join(backupDirectory, "previous-release.json"),
      JSON.parse(readFileSync(join(root, ACCEPTED), "utf8")),
    );
    // Preserve settings/tenant content as a private recovery artifact without moving the originals.
    const present = initial.protectedPaths.filter(
      (path) =>
        path !== LOCK &&
        path !== JOURNAL &&
        existsSync(join(root, path)) &&
        !path.startsWith(".."),
    );
    if (present.length)
      await run(
        [
          "tar",
          "-cf",
          join(backupDirectory, "customer-state.tar"),
          "--",
          ...present,
        ],
        { cwd: root },
      );
    phase("stopping");
    if (options.topology === "image")
      await run(
        compose(
          ["stop", "--timeout", "30", "worker", "server"],
          root,
          initial.composeProject,
        ),
        { cwd: root, env },
      );
    else await hostStopped(root, env, run);
    phase("backing-up");
    const dump = join(backupDirectory, "database.dump");
    writeFileSync(dump, "", { flag: "wx", mode: 0o600 });
    // Image Compose's migrate/server share its resolved URL. Host uses its existing .env URL.
    if (
      options.topology === "image" &&
      new URL(
        originalConfiguration.services.server?.environment?.DATABASE_URL ?? "",
      ).hostname === "postgres"
    ) {
      await run(
        compose(
          [
            "exec",
            "-T",
            "postgres",
            "sh",
            "-ec",
            'exec pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
          ],
          root,
          initial.composeProject,
        ),
        { cwd: root, env, stdoutFile: dump },
      );
    } else {
      const databaseUrl =
        options.topology === "host"
          ? env.DATABASE_URL
          : originalConfiguration.services.server?.environment?.DATABASE_URL;
      if (!databaseUrl || databaseUrl.includes("${"))
        throw new Error(
          "A fully resolved DATABASE_URL is required for a host backup",
        );
      await run(["pg_dump", "--format=custom"], {
        cwd: root,
        env: { ...env, PGDATABASE: databaseUrl },
        stdoutFile: dump,
      });
    }
    if (statSync(dump).size === 0)
      throw new Error("Database backup is empty; source was not changed");
    if (
      options.topology === "image" &&
      new URL(
        originalConfiguration.services.server?.environment?.DATABASE_URL ?? "",
      ).hostname === "postgres"
    ) {
      await run(
        compose(
          ["exec", "-T", "postgres", "pg_restore", "--list"],
          root,
          initial.composeProject,
        ),
        { cwd: root, env, stdinFile: dump },
      );
    } else await run(["pg_restore", "--list", dump], { cwd: root, env });
    atomicJson(join(backupDirectory, "backup.json"), {
      sha256: await fileSha256(dump),
      previousCommit: initial.currentCommit,
      candidateCommit: initial.targetCommit,
      composeProject: initial.composeProject,
    });
    phase("installing");
    await run(["git", "merge", "--ff-only", initial.targetCommit], {
      cwd: root,
    });
    installed = true;
    const activatedConfiguration = readConfiguration(
      await run(
        compose(["config", "--format", "json"], root, initial.composeProject),
        { cwd: root, env: candidateEnv },
      ),
    );
    if (!preservedState(originalConfiguration, activatedConfiguration))
      throw new Error(
        "Activated source changed Compose state identities; migration was not started",
      );
    if (options.topology === "host")
      await run(["bun", "install", "--frozen-lockfile"], {
        cwd: root,
        env: candidateEnv,
      });
    else
      await run(
        compose(
          ["pull", "server", "worker", "migrate"],
          root,
          initial.composeProject,
        ),
        { cwd: root, env: candidateEnv },
      );
    journal.databaseMayHaveChanged = true;
    phase("migrating");
    if (options.topology === "host")
      await run(["bun", "--env-file=../.env", "scripts/migrate.ts"], {
        cwd: join(root, "server"),
        env: candidateEnv,
      });
    else
      await run(
        compose(
          ["run", "--rm", "--no-deps", "--no-build", "migrate"],
          root,
          initial.composeProject,
        ),
        { cwd: root, env: candidateEnv },
      );
    phase("starting");
    if (options.topology === "host")
      await run(["bash", "scripts/start.sh"], { cwd: root, env: candidateEnv });
    else
      await run(
        compose(
          ["up", "-d", "--no-build", "--no-deps", "server", "worker"],
          root,
          initial.composeProject,
        ),
        { cwd: root, env: candidateEnv },
      );
    phase("verifying");
    await waitForReadiness(options, env);
    if (
      (await run(["git", "rev-parse", "HEAD"], { cwd: root })).trim() !==
      initial.targetCommit
    )
      throw new Error("Running source baseline changed during verification");
    if (options.topology === "image") {
      for (const service of ["server", "worker"]) {
        const ids = (
          await run(
            compose(["ps", "--quiet", service], root, initial.composeProject),
            { cwd: root, env: candidateEnv },
          )
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (ids.length !== 1)
          throw new Error(
            `Expected one running candidate ${service} container`,
          );
        const running = (
          await run(
            ["docker", "inspect", "--format", "{{.State.Running}}", ...ids],
            { cwd: root },
          )
        ).trim();
        const reference = (
          await run(
            ["docker", "inspect", "--format", "{{.Config.Image}}", ...ids],
            { cwd: root },
          )
        ).trim();
        if (
          running !== "true" ||
          reference !== options.candidate.artifacts.images.server?.reference
        )
          throw new Error(
            `Candidate ${service} is not running the accepted image digest`,
          );
      }
    }
    atomicJson(join(root, ACCEPTED), options.candidate);
    phase("accepted");
    return journal;
  } catch (error) {
    journal.error = error instanceof Error ? error.message : String(error);
    // No automatic database or source rollback: migration can partially commit. Preserve evidence.
    journal.phase =
      installed || journal.databaseMayHaveChanged
        ? "recovery-required"
        : "failed";
    if (options.topology === "image" && installed) {
      try {
        await run(
          compose(
            ["stop", "--timeout", "30", "worker", "server"],
            root,
            initial.composeProject,
          ),
          { cwd: root, env: candidateEnv },
        );
      } catch (stopError) {
        journal.error += `; candidate stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
      }
    }
    if (options.topology === "host" && installed) {
      try {
        await stopOwnedHost(root, env, run);
      } catch (stopError) {
        journal.error += `; owned host cleanup failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
      }
    }
    atomicJson(join(root, JOURNAL), journal);
    throw new Error(
      `Update failed during ${journal.phase}: ${journal.error}. Recovery evidence: ${backupDirectory}`,
    );
  } finally {
    rmSync(join(root, LOCK), { recursive: true });
  }
}
