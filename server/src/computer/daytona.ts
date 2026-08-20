import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  Image,
} from "@daytona/sdk";
import {
  type ComputerLocation,
  type ComputerProvider,
  type IsolationDescription,
  ProviderError,
} from "./provider";
import type { ComputerStatus } from "./schema";

/**
 * Remote computers on Daytona for OpenBot.
 *
 * When DAYTONA_API_KEY is configured, each Bot gets a Daytona cloud sandbox
 * instead of a local Docker container. The provider builds and reuses an image
 * snapshot, provisions sandboxes on demand, checks health over Daytona preview
 * URLs, and maps Bot IDs to active sandboxes.
 */

export type SandboxHandle = {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  start(timeout?: number): Promise<void>;
  stop(): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  getPreviewLink(port: number): Promise<{ url: string }>;
};

export type DaytonaSdk = {
  create(
    params: {
      snapshot: string;
      envVars: Record<string, string>;
      labels: Record<string, string>;
      public: boolean;
      autoStopInterval: number;
    },
    options?: { timeout?: number },
  ): Promise<SandboxHandle>;
  get(id: string): Promise<SandboxHandle>;
  list(query?: {
    labels?: Record<string, string>;
  }): AsyncIterable<SandboxHandle>;
  snapshot: {
    get(name: string): Promise<{ state: string }>;
    create(
      params: { name: string; image: unknown },
      options?: { onLogs?: (line: string) => void; timeout?: number },
    ): Promise<unknown>;
  };
};

export type DaytonaSupervisorOptions = {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
  computerToken: string;
  environment?: Record<string, string | undefined>;
  agentComputerDir?: string;
  sdk?: DaytonaSdk;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  snapshotTimeoutMs?: number;
};

const COMPUTER_PORT = 4100;
const OWNERSHIP_LABEL_KEY = "openbot/computer";
const OWNERSHIP_LABEL_VALUE = "true";
const BOT_ID_LABEL_KEY = "openbot/bot-id";
const DEFAULT_AGENT_COMPUTER_DIR = join(
  import.meta.dir,
  "../../../agent-computer",
);
const DEFAULT_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15 * 60 * 1000;
const RECIPE_VERSION = "2";

// The Playwright image tag and dependency must stay aligned with
// agent-computer/package.json and agent-computer/Dockerfile. Bump both or neither.
function buildRecipe(dir: string): unknown {
  return (
    Image.base("mcr.microsoft.com/playwright:v1.62.1-noble")
      .runCommands(
        "apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*",
        "curl -fsSL https://bun.sh/install | bash",
      )
      // Image.env shell-quotes variable references so ${PATH} cannot be used.
      .env({
        PATH: "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      })
      .workdir("/app")
      .addLocalFile(join(dir, "package.json"), "/app/package.json")
      .runCommands("bun install")
      .addLocalDir(join(dir, "src"), "/app/src")
      .runCommands("mkdir -p /workspace /profiles")
      .env({
        WORKSPACE_DIR: "/workspace",
        PROFILES_DIR: "/profiles",
        PORT: "4100",
      })
      .entrypoint(["bun", "src/index.ts"])
  );
}

function getAllFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function computeSnapshotName(agentComputerDir: string): string {
  const hash = createHash("sha256");
  hash.update(RECIPE_VERSION);
  hash.update("\0");

  const pkgJsonPath = join(agentComputerDir, "package.json");
  const pkgBytes = readFileSync(pkgJsonPath);
  hash.update(pkgBytes);
  hash.update("\0");

  const srcDir = join(agentComputerDir, "src");
  const fileList = getAllFiles(srcDir);
  const items = fileList.map((fullPath) => {
    const rel = relative(srcDir, fullPath).split("\\").join("/");
    return { rel, fullPath };
  });
  items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  for (const item of items) {
    const contents = readFileSync(item.fullPath);
    hash.update(item.rel);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }

  const hex = hash.digest("hex").slice(0, 12);
  return `openbot-agent-computer-${hex}`;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof DaytonaNotFoundError) return true;
  if (
    "name" in err &&
    (err as { name: string }).name === "DaytonaNotFoundError"
  ) {
    return true;
  }
  return false;
}

function isConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof DaytonaConflictError) return true;
  if (
    "name" in err &&
    (err as { name: string }).name === "DaytonaConflictError"
  ) {
    return true;
  }
  return false;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function wrapBotError(
  botId: string,
  action: string,
  err: unknown,
): ProviderError {
  if (err instanceof ProviderError) {
    return err;
  }
  return new ProviderError(
    `Daytona could not ${action} the computer for ${botId}: ${toErrorMessage(err)}`,
  );
}

function toComputerStatus(botId: string, state?: string): ComputerStatus {
  const normalized = state?.toLowerCase();
  if (normalized === "started" || normalized === "running") {
    return { botId, state: "ready" };
  }
  if (
    normalized === "created" ||
    normalized === "restarting" ||
    normalized === "creating" ||
    normalized === "starting" ||
    normalized === "restoring" ||
    normalized === "pulling_snapshot" ||
    normalized === "resuming"
  ) {
    return { botId, state: "starting" };
  }
  if (
    normalized === "stopped" ||
    normalized === "paused" ||
    normalized === "archived" ||
    normalized === "exited" ||
    normalized === "destroyed" ||
    normalized === "removing" ||
    normalized === "archiving" ||
    normalized === "pausing" ||
    normalized === "stopping"
  ) {
    return { botId, state: "absent" };
  }
  const reason = normalized
    ? `Daytona reported the computer state "${normalized}".`
    : "Daytona did not report a state for this computer.";
  return { botId, state: "unreachable", reason };
}


function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = "Operation timed out.",
): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(errorMessage));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

type PollDecision<T> = { done: true; value: T } | { done: false };

async function pollUntil<T>(
  step: () => Promise<PollDecision<T>>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    timeoutError: () => Error;
  },
): Promise<T> {
  const startTime = Date.now();
  while (Date.now() - startTime < options.timeoutMs) {
    const decision = await step();
    if (decision.done) {
      return decision.value;
    }
    const elapsed = Date.now() - startTime;
    const remaining = options.timeoutMs - elapsed;
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(options.intervalMs, remaining));
  }
  throw options.timeoutError();
}

export function createDaytonaComputerProvider(
  options: DaytonaSupervisorOptions,
): ComputerProvider {
  const sdk: DaytonaSdk =
    options.sdk ??
    new Daytona({
      apiKey: options.apiKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.target ? { target: options.target } : {}),
    });

  const doFetch = options.fetchImpl ?? fetch;
  /**
   * In-memory supervisor state:
   * - `known`: maps botId to { sandboxId, url } for fast locate cache hits. Entries are removed
   *   on reset, deletion, terminal states (destroyed/destroying/error/build_failed), or 404s.
   * - `locating`: maps botId to active locate promises to deduplicate concurrent calls. Note:
   *   this deduplication is local to this single process only (no cross-instance synchronization).
   * - `resetSandboxes`: maps botId to the deleted sandboxId to mask Daytona list eventual-consistency
   *   staleness where a deleted sandbox temporarily reappears in list() queries. Cleared on fresh creation.
   */
  const known = new Map<string, { sandboxId: string; url: string }>();
  const locating = new Map<string, Promise<string>>();
  const resetSandboxes = new Map<string, string>();

  let snapshotPromise: Promise<string> | undefined;

  function ensureSnapshot(): Promise<string> {
    if (options.snapshot) {
      return Promise.resolve(options.snapshot);
    }

    if (!snapshotPromise) {
      snapshotPromise = (async () => {
        const agentComputerDir =
          options.agentComputerDir ?? DEFAULT_AGENT_COMPUTER_DIR;
        let snapshotName: string;
        try {
          snapshotName = computeSnapshotName(agentComputerDir);
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          throw new ProviderError(
            `Failed to prepare agent-computer sources from "${agentComputerDir}": ${toErrorMessage(err)}. Set DAYTONA_SNAPSHOT to use a prebuilt snapshot.`,
          );
        }

        const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const snapshotTimeout =
          options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

        async function pollUntilActive(name: string): Promise<string> {
          return await pollUntil<string>(
            async () => {
              let snap: { state: string };
              try {
                snap = await sdk.snapshot.get(name);
              } catch (err) {
                throw new ProviderError(
                  `Failed to inspect Daytona snapshot ${name} while waiting for active state: ${toErrorMessage(err)}`,
                );
              }
              if (snap.state === "active") {
                return { done: true, value: name };
              }
              if (snap.state === "error" || snap.state === "build_failed") {
                throw new ProviderError(
                  `Daytona snapshot ${name} failed with state "${snap.state}". Delete it in the Daytona dashboard or set DAYTONA_SNAPSHOT to override.`,
                );
              }
              return { done: false };
            },
            {
              timeoutMs: snapshotTimeout,
              intervalMs: pollInterval,
              timeoutError: () =>
                new ProviderError(
                  `Timed out waiting for Daytona snapshot ${name} to become active.`,
                ),
            },
          );
        }

        try {
          const existing = await sdk.snapshot.get(snapshotName);
          if (existing.state === "active") {
            return snapshotName;
          }
          if (existing.state === "error" || existing.state === "build_failed") {
            throw new ProviderError(
              `Daytona snapshot ${snapshotName} failed with state "${existing.state}". Delete it in the Daytona dashboard or set DAYTONA_SNAPSHOT to override.`,
            );
          }
          return await pollUntilActive(snapshotName);
        } catch (err) {
          if (isNotFoundError(err)) {
            let recipe: unknown;
            try {
              recipe = buildRecipe(agentComputerDir);
            } catch (recipeErr) {
              if (recipeErr instanceof ProviderError) throw recipeErr;
              throw new ProviderError(
                `Failed to build agent-computer recipe from "${agentComputerDir}": ${toErrorMessage(recipeErr)}. Set DAYTONA_SNAPSHOT to use a prebuilt snapshot.`,
              );
            }

            try {
              await withTimeout(
                sdk.snapshot.create(
                  { name: snapshotName, image: recipe },
                  {
                    onLogs: (line: string) => console.info(`[daytona] ${line}`),
                    timeout: Math.ceil(snapshotTimeout / 1000),
                  },
                ),
                snapshotTimeout,
                `Timed out waiting for Daytona snapshot ${snapshotName} to be created.`,
              );
              return snapshotName;
            } catch (createErr) {
              if (isConflictError(createErr)) {
                return await pollUntilActive(snapshotName);
              }
              if (createErr instanceof ProviderError) {
                throw createErr;
              }
              throw new ProviderError(
                `Failed to create Daytona snapshot ${snapshotName}: ${toErrorMessage(createErr)}`,
              );
            }
          }
          if (err instanceof ProviderError) {
            throw err;
          }
          throw new ProviderError(
            `Failed to inspect Daytona snapshot ${snapshotName}: ${toErrorMessage(err)}`,
          );
        }
      })().catch((err) => {
        snapshotPromise = undefined;
        throw err;
      });
    }

    return snapshotPromise;
  }

  async function resolveSandbox(
    botId: string,
    action: string,
    includeTerminal = false,
  ): Promise<SandboxHandle | undefined> {
    const deletedSandboxId = resetSandboxes.get(botId);
    const knownEntry = known.get(botId);
    if (knownEntry) {
      if (deletedSandboxId && knownEntry.sandboxId === deletedSandboxId) {
        known.delete(botId);
      } else {
        try {
          const sb = await sdk.get(knownEntry.sandboxId);
          const state = sb.state?.toLowerCase();
          if (
            !includeTerminal &&
            (state === "destroyed" || state === "destroying")
          ) {
            known.delete(botId);
            return undefined;
          }
          return sb;
        } catch (err) {
          if (isNotFoundError(err)) {
            known.delete(botId);
            return undefined;
          }
          throw wrapBotError(botId, action, err);
        }
      }
    }

    try {
      for await (const sb of sdk.list({
        labels: {
          [BOT_ID_LABEL_KEY]: botId,
        },
      })) {
        if (deletedSandboxId && sb.id === deletedSandboxId) {
          continue;
        }
        const state = sb.state?.toLowerCase();
        if (
          includeTerminal ||
          (state !== "destroyed" && state !== "destroying")
        ) {
          return sb;
        }
      }
    } catch (err) {
      throw wrapBotError(botId, action, err);
    }

    return undefined;
  }

  return {
    name: "Daytona",
    isolation: "per-bot",

    describeIsolation(): IsolationDescription {
      return {
        isolation: "one computer per Bot",
        note: "Each Bot gets a remote Daytona sandbox with its own /workspace and its own browser profile.",
      };
    },

    async locate(botId: string): Promise<string> {
      const existing = locating.get(botId);
      if (existing) {
        return existing;
      }

      const promise = (async () => {
        const snapshot = await ensureSnapshot();

        let sandboxHandle = await resolveSandbox(botId, "locate");
        if (sandboxHandle) {
          const state = sandboxHandle.state?.toLowerCase();
          if (state === "error" || state === "build_failed") {
            try {
              await sandboxHandle.delete();
            } catch {
              // Best-effort cleanup of broken sandboxes
            }
            known.delete(botId);
            sandboxHandle = undefined;
          }
        }

        async function createFreshSandbox(): Promise<SandboxHandle> {
          const passthroughEnv: Record<string, string> = {};
          if (options.environment) {
            for (const [key, value] of Object.entries(options.environment)) {
              if (
                typeof value === "string" &&
                (key.startsWith("EGRESS_PROXY") || key === "ACTION_TIMEOUT_MS")
              ) {
                passthroughEnv[key] = value;
              }
            }
          }

          const envVars: Record<string, string> = {
            COMPUTER_BOT_ID: botId,
            COMPUTER_TOKEN: options.computerToken,
            ...passthroughEnv,
          };

          const labels: Record<string, string> = {
            [OWNERSHIP_LABEL_KEY]: OWNERSHIP_LABEL_VALUE,
            [BOT_ID_LABEL_KEY]: botId,
          };

          try {
            const handle = await sdk.create(
              {
                snapshot,
                envVars,
                labels,
                public: true,
                autoStopInterval: 15,
              },
              { timeout: 300 },
            );
            resetSandboxes.delete(botId);
            return handle;
          } catch (err) {
            throw wrapBotError(botId, "create", err);
          }
        }

        if (!sandboxHandle) {
          sandboxHandle = await createFreshSandbox();
        } else {
          const state = sandboxHandle.state?.toLowerCase();
          if (
            state === "stopped" ||
            state === "archived" ||
            state === "paused"
          ) {
            try {
              await sandboxHandle.start(300);
            } catch (err) {
              throw wrapBotError(botId, "start", err);
            }
          }
        }

        if (sandboxHandle.state?.toLowerCase() !== "started") {
          const pollInterval =
            options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
          const maxWaitMs = 300 * 1000;

          sandboxHandle = await pollUntil<SandboxHandle>(
            async () => {
              try {
                sandboxHandle = await sdk.get(sandboxHandle!.id);
              } catch (err) {
                if (isNotFoundError(err)) {
                  known.delete(botId);
                  sandboxHandle = await createFreshSandbox();
                  if (sandboxHandle.state?.toLowerCase() === "started") {
                    return { done: true, value: sandboxHandle };
                  }
                  return { done: false };
                }
                throw wrapBotError(botId, "locate", err);
              }

              const cur = sandboxHandle.state?.toLowerCase();
              if (cur === "started") {
                return { done: true, value: sandboxHandle };
              }
              if (cur === "stopped" || cur === "archived" || cur === "paused") {
                try {
                  await sandboxHandle.start(300);
                } catch (err) {
                  throw wrapBotError(botId, "start", err);
                }
                if (sandboxHandle.state?.toLowerCase() === "started") {
                  return { done: true, value: sandboxHandle };
                }
                return { done: false };
              }
              if (cur === "destroyed" || cur === "destroying") {
                known.delete(botId);
                sandboxHandle = await createFreshSandbox();
                if (sandboxHandle.state?.toLowerCase() === "started") {
                  return { done: true, value: sandboxHandle };
                }
                return { done: false };
              }
              if (cur === "error" || cur === "build_failed") {
                throw new ProviderError(
                  `Daytona sandbox for ${botId} failed with state "${cur}".`,
                );
              }
              return { done: false };
            },
            {
              timeoutMs: maxWaitMs,
              intervalMs: pollInterval,
              timeoutError: () =>
                new ProviderError(
                  `Timed out waiting for computer sandbox for ${botId} to start.`,
                ),
            },
          );
        }

        let previewUrl: string;
        try {
          const preview = await sandboxHandle.getPreviewLink(COMPUTER_PORT);
          previewUrl = preview.url;
        } catch (err) {
          throw wrapBotError(botId, "locate", err);
        }

        known.set(botId, { sandboxId: sandboxHandle.id, url: previewUrl });

        const healthPollInterval =
          options.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
        const healthTimeout =
          options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
        const healthStart = Date.now();
        const healthDeadline = healthStart + healthTimeout;
        const healthUrl = `${previewUrl.replace(/\/$/, "")}/health`;

        let healthy = false;
        while (Date.now() < healthDeadline) {
          const remainingMs = Math.max(1, healthDeadline - Date.now());
          try {
            const res = await withTimeout(
              doFetch(healthUrl, {
                headers: {
                  "X-Daytona-Skip-Preview-Warning": "true",
                },
                signal: AbortSignal.timeout(remainingMs),
              }),
              remainingMs,
            );
            if (res.ok) {
              healthy = true;
              break;
            }
          } catch {
            // Health endpoint not reachable yet or timed out; retry
          }
          const sleepMs = Math.min(
            healthPollInterval,
            Math.max(0, healthDeadline - Date.now()),
          );
          if (sleepMs > 0) {
            await sleep(sleepMs);
          }
        }

        if (!healthy) {
          throw new ProviderError(
            `The computer for ${botId} started but never answered /health at its preview URL.`,
          );
        }

        return previewUrl;
      })();

      locating.set(botId, promise);
      try {
        return await promise;
      } finally {
        locating.delete(botId);
      }
    },

    async status(botId: string): Promise<ComputerStatus> {
      const sandboxHandle = await resolveSandbox(botId, "inspect", true);
      if (!sandboxHandle) {
        return { botId, state: "absent" };
      }
      return toComputerStatus(botId, sandboxHandle.state);
    },

    async stop(botId: string): Promise<void> {
      const sandboxHandle = await resolveSandbox(botId, "stop");
      if (!sandboxHandle) {
        return;
      }
      const state = sandboxHandle.state?.toLowerCase();
      if (state !== "started" && state !== "paused") {
        return;
      }
      try {
        await sandboxHandle.stop();
      } catch (err) {
        throw wrapBotError(botId, "stop", err);
      }
    },

    async reset(botId: string): Promise<void> {
      const sandboxHandle = await resolveSandbox(botId, "reset");
      known.delete(botId);
      if (!sandboxHandle) {
        return;
      }
      try {
        await sandboxHandle.delete(60, true);
      } catch (err) {
        throw wrapBotError(botId, "reset", err);
      }
      resetSandboxes.set(botId, sandboxHandle.id);
    },

    async list(): Promise<ComputerLocation[]> {
      const result: ComputerLocation[] = [];
      try {
        for await (const sb of sdk.list({
          labels: {
            [OWNERSHIP_LABEL_KEY]: OWNERSHIP_LABEL_VALUE,
          },
        })) {
          const state = sb.state?.toLowerCase();
          if (state === "destroyed" || state === "destroying") {
            continue;
          }
          const botId = sb.labels?.[BOT_ID_LABEL_KEY];
          if (!botId || resetSandboxes.get(botId) === sb.id) {
            continue;
          }
          const preview = await sb.getPreviewLink(COMPUTER_PORT);
          result.push({
            botId,
            status:
              state === "started" || state === "running"
                ? "running"
                : "exited",
            url: preview.url,
            startedAt: sb.createdAt,
          });
        }
      } catch (err) {
        throw new ProviderError(
          `Daytona failed to list computers: ${toErrorMessage(err)}`,
        );
      }
      return result;
    },

    async warm(): Promise<void> {
      try {
        await ensureSnapshot();
      } catch (err) {
        console.error(
          `[daytona] Warm failed to build snapshot: ${toErrorMessage(err)}`,
        );
      }
    },
  };
}

export const createDaytonaSupervisorClient = createDaytonaComputerProvider;
