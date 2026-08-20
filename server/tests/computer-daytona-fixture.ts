import { createHash } from "node:crypto";
import { SandboxState } from "@daytona/sdk";
import {
  createDaytonaComputerProvider,
  type DaytonaProviderOptions,
  type DaytonaSdk,
  type SandboxHandle,
} from "../src/computer/daytona";

export class DaytonaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaNotFoundError";
  }
}

export type DeleteCall = {
  timeout?: number;
  wait?: boolean;
};

export type FakeSandbox = {
  id: string;
  state: SandboxState;
  labels: Record<string, string>;
  envVars: Record<string, string>;
  public: boolean;
  autoStopInterval: number;
  createdAt: string;
  previewUrl: string;
  startCalls: number;
  stopCalls: number;
  deleteCalls: number;
  deleteArgs: DeleteCall[];
  refreshActivityCalls: number;
  deleteHandler?: (timeout?: number, wait?: boolean) => void | Promise<void>;
  refreshActivityHandler?: () => void | Promise<void>;
};

export type CreateParams = {
  snapshot: string;
  envVars: Record<string, string>;
  labels: Record<string, string>;
  public: boolean;
  autoStopInterval: number;
  options?: { timeout?: number };
};

export function makeSandbox(options: {
  id: string;
  botId?: string;
  state?: SandboxState | string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  createdAt?: string;
  previewUrl?: string;
  deleteHandler?: (timeout?: number, wait?: boolean) => void | Promise<void>;
  refreshActivityHandler?: () => void | Promise<void>;
}): FakeSandbox {
  const botId = options.botId;
  const token = options.envVars?.COMPUTER_TOKEN ?? "tok";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const defaultLabels = botId
    ? {
        "openbot/computer": "true",
        "openbot/bot-id": botId,
        "openbot/computer-token-hash": tokenHash,
      }
    : { "openbot/computer": "true" };
  const labels = options.labels ?? defaultLabels;
  const envVars =
    options.envVars ??
    (botId ? { COMPUTER_TOKEN: token, COMPUTER_BOT_ID: botId } : {});

  return {
    id: options.id,
    state: (options.state as SandboxState) ?? SandboxState.STARTED,
    labels,
    envVars,
    public: options.public ?? true,
    autoStopInterval: options.autoStopInterval ?? 15,
    createdAt: options.createdAt ?? "2026-08-20T10:00:00Z",
    previewUrl:
      options.previewUrl ?? `https://${options.id}.preview.daytona.app`,
    startCalls: 0,
    stopCalls: 0,
    deleteCalls: 0,
    deleteArgs: [],
    refreshActivityCalls: 0,
    ...(options.deleteHandler ? { deleteHandler: options.deleteHandler } : {}),
    ...(options.refreshActivityHandler
      ? { refreshActivityHandler: options.refreshActivityHandler }
      : {}),
  };
}

export function makeSandboxHandle(sb: FakeSandbox): SandboxHandle {
  const handle: SandboxHandle = {
    id: sb.id,
    get state() {
      return sb.state;
    },
    set state(val: SandboxState | undefined) {
      sb.state = val ?? SandboxState.UNKNOWN;
    },
    labels: sb.labels,
    createdAt: sb.createdAt,
    start: async () => {
      sb.startCalls++;
      sb.state = SandboxState.STARTED;
    },
    stop: async () => {
      sb.stopCalls++;
      sb.state = SandboxState.STOPPED;
    },
    delete: async (timeout?: number, wait?: boolean) => {
      sb.deleteCalls++;
      sb.deleteArgs.push({ timeout, wait });
      if (sb.deleteHandler) {
        await sb.deleteHandler(timeout, wait);
      } else {
        sb.state = SandboxState.DESTROYED;
      }
    },
    refreshActivity: async () => {
      sb.refreshActivityCalls++;
      if (sb.refreshActivityHandler) {
        await sb.refreshActivityHandler();
      }
    },
    getPreviewLink: async (_port: number) => ({ url: sb.previewUrl }),
  };
  return handle;
}

export type FakeSdk = DaytonaSdk & {
  sandboxes: Map<string, FakeSandbox>;
  snapshots: Map<string, { state: string }>;
  creates: CreateParams[];
};

export function createFakeSdk(initialSandboxes: FakeSandbox[] = []): FakeSdk {
  let idCounter = 1;
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, { state: string }>();
  const creates: CreateParams[] = [];

  for (const sb of initialSandboxes) {
    sandboxes.set(sb.id, sb);
  }

  const sdk: FakeSdk = {
    sandboxes,
    snapshots,
    creates,
    create: async (params, options) => {
      creates.push({ ...params, options });
      const id = `sb-${idCounter++}`;
      const sb: FakeSandbox = {
        id,
        state: SandboxState.STARTED,
        labels: params.labels,
        envVars: params.envVars,
        public: params.public,
        autoStopInterval: params.autoStopInterval,
        createdAt: new Date().toISOString(),
        previewUrl: `https://${id}.preview.daytona.app`,
        startCalls: 0,
        stopCalls: 0,
        deleteCalls: 0,
        deleteArgs: [],
        refreshActivityCalls: 0,
      };
      sandboxes.set(id, sb);
      return makeSandboxHandle(sb);
    },
    get: async (id: string) => {
      const sb = sandboxes.get(id);
      if (!sb) {
        throw new DaytonaNotFoundError(`Sandbox ${id} not found`);
      }
      return makeSandboxHandle(sb);
    },
    list: (query?: { labels?: Record<string, string> }) => {
      async function* generator() {
        for (const sb of sandboxes.values()) {
          if (query?.labels) {
            const matches = Object.entries(query.labels).every(
              ([k, v]) => sb.labels[k] === v,
            );
            if (!matches) continue;
          }
          yield makeSandboxHandle(sb);
        }
      }
      return generator();
    },
    snapshot: {
      get: async (name: string) => {
        const snap = snapshots.get(name);
        if (!snap) {
          throw new DaytonaNotFoundError(`Snapshot ${name} not found`);
        }
        return snap;
      },
      create: async (params, _options) => {
        snapshots.set(params.name, { state: "active" });
        return { name: params.name };
      },
    },
  };

  return sdk;
}

export function fakeFetch(
  handler?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (handler) return handler(url, init);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;
}

export type ClientOverrides = Partial<DaytonaProviderOptions> & {
  snapshotTimeoutMs?: number;
};

export function makeClient(
  sdk: FakeSdk = createFakeSdk(),
  overrides: ClientOverrides = {},
) {
  const defaultSnapshot =
    !overrides.agentComputerDir && overrides.snapshot === undefined
      ? { snapshot: "prebuilt" }
      : {};
  return createDaytonaComputerProvider({
    apiKey: "test-api-key",
    computerToken: "tok",
    pollIntervalMs: 1,
    healthTimeoutMs: 200,
    sdk,
    fetchImpl: fakeFetch(),
    ...defaultSnapshot,
    ...overrides,
  } as DaytonaProviderOptions);
}
