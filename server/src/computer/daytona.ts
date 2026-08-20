import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  Image,
} from "@daytona/sdk";
import { type ComputerLocation, SupervisorError } from "./supervisor";

/**
 * Remote computers on Daytona for OpenBot.
 *
 * When configured with DAYTONA_API_KEY, each Bot gets its own cloud sandbox managed
 * by Daytona rather than a local Docker container. The supervisor client is responsible
 * for building and reusing an image snapshot, provisioning sandboxes on demand,
 * checking health over Daytona's preview URLs, and mapping Bot IDs to active sandboxes.
 */

export type SandboxHandle = {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  start(timeout?: number): Promise<void>;
  stop(): Promise<void>;
  delete(): Promise<void>;
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
const RECIPE_VERSION = "1";

// The Playwright image tag and dependency must stay aligned with
// agent-computer/package.json and agent-computer/Dockerfile. Bump both or neither.
function buildRecipe(dir: string): unknown {
  return Image.base("mcr.microsoft.com/playwright:v1.62.1-noble")
    .runCommands(
      "apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*",
      "curl -fsSL https://bun.sh/install | bash",
    )
    .env({ PATH: "/root/.bun/bin:${PATH}" })
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
    .entrypoint(["bun", "src/index.ts"]);
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
  let fileList: string[] = [];
  try {
    fileList = getAllFiles(srcDir);
  } catch {
    fileList = [];
  }

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
): SupervisorError {
  if (err instanceof SupervisorError) {
    return err;
  }
  return new SupervisorError(
    `Daytona could not ${action} the computer for ${botId}: ${toErrorMessage(err)}`,
  );
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function createDaytonaSupervisorClient(
  options: DaytonaSupervisorOptions,
) {
  const sdk: DaytonaSdk =
    options.sdk ??
    new Daytona({
      apiKey: options.apiKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.target ? { target: options.target } : {}),
    });

  const doFetch = options.fetchImpl ?? fetch;
  const known = new Map<string, { sandboxId: string; url: string }>();
  const locating = new Map<string, Promise<string>>();

  let snapshotPromise: Promise<string> | undefined;

  function ensureSnapshot(): Promise<string> {
    if (options.snapshot) {
      return Promise.resolve(options.snapshot);
    }

    if (!snapshotPromise) {
      snapshotPromise = (async () => {
        const agentComputerDir =
          options.agentComputerDir ?? DEFAULT_AGENT_COMPUTER_DIR;
        const snapshotName = computeSnapshotName(agentComputerDir);
        const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const maxWaitMs = 15 * 60 * 1000;

        async function pollUntilActive(name: string): Promise<string> {
          const startTime = Date.now();
          while (Date.now() - startTime < maxWaitMs) {
            let snap: { state: string };
            try {
              snap = await sdk.snapshot.get(name);
            } catch (err) {
              throw new SupervisorError(
                `Failed to inspect Daytona snapshot ${name} while waiting for active state: ${toErrorMessage(err)}`,
              );
            }
            if (snap.state === "active") {
              return name;
            }
            if (snap.state === "error" || snap.state === "build_failed") {
              throw new SupervisorError(
                `Daytona snapshot ${name} failed with state "${snap.state}". Delete it in the Daytona dashboard or set DAYTONA_SNAPSHOT to override.`,
              );
            }
            await sleep(pollInterval);
          }
          throw new SupervisorError(
            `Timed out waiting for Daytona snapshot ${name} to become active.`,
          );
        }

        try {
          const existing = await sdk.snapshot.get(snapshotName);
          if (existing.state === "active") {
            return snapshotName;
          }
          if (existing.state === "error" || existing.state === "build_failed") {
            throw new SupervisorError(
              `Daytona snapshot ${snapshotName} failed with state "${existing.state}". Delete it in the Daytona dashboard or set DAYTONA_SNAPSHOT to override.`,
            );
          }
          return await pollUntilActive(snapshotName);
        } catch (err) {
          if (isNotFoundError(err)) {
            const recipe = buildRecipe(agentComputerDir);
            try {
              await sdk.snapshot.create(
                { name: snapshotName, image: recipe },
                {
                  onLogs: (line: string) => console.info(`[daytona] ${line}`),
                  timeout: 900,
                },
              );
              return snapshotName;
            } catch (createErr) {
              if (isConflictError(createErr)) {
                return await pollUntilActive(snapshotName);
              }
              if (createErr instanceof SupervisorError) {
                throw createErr;
              }
              throw new SupervisorError(
                `Failed to create Daytona snapshot ${snapshotName}: ${toErrorMessage(createErr)}`,
              );
            }
          }
          if (err instanceof SupervisorError) {
            throw err;
          }
          throw new SupervisorError(
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
  ): Promise<SandboxHandle | undefined> {
    const knownEntry = known.get(botId);
    if (knownEntry) {
      try {
        return await sdk.get(knownEntry.sandboxId);
      } catch (err) {
        if (isNotFoundError(err)) {
          known.delete(botId);
        } else {
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
        const state = sb.state?.toLowerCase();
        if (state !== "destroyed" && state !== "destroying") {
          return sb;
        }
      }
    } catch (err) {
      throw wrapBotError(botId, action, err);
    }

    return undefined;
  }

  return {
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

        if (!sandboxHandle) {
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
            sandboxHandle = await sdk.create(
              {
                snapshot,
                envVars,
                labels,
                public: true,
                autoStopInterval: 15,
              },
              { timeout: 300 },
            );
          } catch (err) {
            throw wrapBotError(botId, "create", err);
          }
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
          } else if (state !== "started") {
            const pollInterval =
              options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
            const maxWaitMs = 300 * 1000;
            const startTime = Date.now();
            while (sandboxHandle.state?.toLowerCase() !== "started") {
              if (Date.now() - startTime >= maxWaitMs) {
                throw new SupervisorError(
                  `Timed out waiting for computer sandbox for ${botId} to start.`,
                );
              }
              await sleep(pollInterval);
              try {
                sandboxHandle = await sdk.get(sandboxHandle.id);
              } catch (err) {
                throw wrapBotError(botId, "locate", err);
              }
              const cur = sandboxHandle.state?.toLowerCase();
              if (cur === "error" || cur === "build_failed") {
                throw new SupervisorError(
                  `Daytona sandbox for ${botId} failed with state "${cur}".`,
                );
              }
            }
          }
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
        const healthUrl = `${previewUrl.replace(/\/$/, "")}/health`;

        let healthy = false;
        while (Date.now() - healthStart < healthTimeout) {
          try {
            const res = await doFetch(healthUrl, {
              headers: {
                "X-Daytona-Skip-Preview-Warning": "true",
              },
            });
            if (res.ok) {
              healthy = true;
              break;
            }
          } catch {
            // Health endpoint not reachable yet; retry
          }
          await sleep(healthPollInterval);
        }

        if (!healthy) {
          throw new SupervisorError(
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

    async stop(botId: string): Promise<void> {
      const sandboxHandle = await resolveSandbox(botId, "stop");
      if (!sandboxHandle) {
        return;
      }
      const state = sandboxHandle.state?.toLowerCase();
      if (state === "destroyed" || state === "destroying") {
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
        await sandboxHandle.delete();
      } catch (err) {
        throw wrapBotError(botId, "reset", err);
      }
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
          if (!botId) {
            continue;
          }
          result.push({
            botId,
            container: sb.id,
            status: sb.state ?? "unknown",
            startedAt: sb.createdAt,
          });
        }
      } catch (err) {
        throw new SupervisorError(
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
