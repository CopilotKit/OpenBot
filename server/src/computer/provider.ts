import type { ComputerConfig } from "../config";
import {
  createDockerSupervisorProvider,
  type SupervisorOptions,
} from "./supervisor";

import type { ComputerStatus } from "./schema";

/** The address and lifecycle details for one Bot's computer. */
export type ComputerLocation = {
  botId: string;
  status: "running" | "stopped";
  url?: string;
  startedAt?: string;
  egress?: string | null;
};

/** A description of how a provider separates one Bot's computer from another. */
export type IsolationDescription = {
  isolation: "off" | "one computer per Bot" | "one shared computer";
  note: string;
  warning?: string;
};

/** An error from a computer provider. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Describe the isolation that this provider (or lack of provider) gives to Bots. */
export function describeComputerIsolation(
  provider?: ComputerProvider,
): IsolationDescription {
  if (!provider) {
    return {
      isolation: "off",
      note: "The computer feature is off. No computer provider is configured.",
    };
  }

  if (provider.isolation === "per-bot") {
    return {
      isolation: "one computer per Bot",
      note: "Each Bot gets its own isolated computer with its own /workspace and browser profile.",
    };
  }

  return {
    isolation: "one shared computer",
    note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL to give each Bot its own.",
    warning:
      "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL for a computer each.",
  };
}

/**
 * A backend that gives Bots access to a computer.
 *
 * Implementations can use a computer for each Bot or one computer for all Bots.
 * Callers use this interface and do not need to know which backend is active.
 */
export interface ComputerProvider {
  /** The provider name for logs and status output. */
  readonly name: string;
  /** How the provider separates computers between Bots. */
  readonly isolation: "per-bot" | "shared";
  /** Return the base address of the computer for this Bot. */
  locate(botId: string): Promise<string>;
  /** Return the lifecycle state of the computer for this Bot. */
  status(botId: string): Promise<ComputerStatus>;
  /** Stop the computer for this Bot if it exists. */
  stop(botId: string): Promise<{ wasRunning: boolean }>;
  /** Remove the computer state for this Bot if it exists. */
  reset(botId: string): Promise<{ cleared: boolean }>;
  /** List the computers that this provider owns. */
  list(): Promise<ComputerLocation[]>;
  /** Prepare provider resources before the first computer request. */
  warm?(): Promise<void>;
}

export type SharedComputerProviderOptions = {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
type SharedComputerEntry = {
  botId: string;
  running?: boolean;
  status?: string;
  url?: string;
  startedAt?: string | null;
  egress?: string | null;
};
/**
 * Give every Bot the same computer.
 *
 * This adapter keeps shared deployments behind the same provider seam as the
 * Docker supervisor, and is the seam a remote backend plugs into.
 */
export function createSharedComputerProvider(
  options: SharedComputerProviderOptions,
): ComputerProvider {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 45_000;

  function headers(botId?: string): Record<string, string> {
    return {
      ...(botId ? { "x-openbot-bot-id": botId } : {}),
      ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
    };
  }

  async function call(
    path: string,
    method: "GET" | "POST",
    botId?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(botId),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(
        `The shared computer at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new ProviderError(
        body?.error ?? `The shared computer answered ${response.status}.`,
      );
    }
    return body;
  }

  return {
    name: "shared",
    isolation: "shared",

    async locate(_botId: string): Promise<string> {
      return options.baseUrl;
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        await call("/health", "GET", botId);
        return { botId, state: "ready" };
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown failure.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const body = (await call("/computers/stop", "POST", botId)) as {
        wasRunning?: boolean;
        stopped?: boolean;
      } | null;
      return {
        wasRunning: body?.wasRunning ?? body?.stopped ?? false,
      };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const body = (await call("/computers/reset", "POST", botId)) as {
        cleared?: boolean;
        reset?: boolean;
      } | null;
      return {
        cleared: body?.cleared ?? body?.reset ?? false,
      };
    },

    async list(): Promise<ComputerLocation[]> {
      const body = (await call("/computers", "GET")) as {
        computers?: SharedComputerEntry[];
      };
      return (body?.computers ?? []).map((computer) => ({
        botId: computer.botId,
        status:
          computer.status === "running" || computer.running === true
            ? "running"
            : "stopped",
        url: computer.url ?? base,
        ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
        ...(computer.egress !== undefined ? { egress: computer.egress } : {}),
      }));
    },
  };
}

/** Build the one computer provider selected by deployment configuration. */
export function createComputerProvider(
  config: ComputerConfig,
): ComputerProvider {
  switch (config.provider) {
    case "docker": {
      const options: SupervisorOptions = {
        baseUrl: config.baseUrl,
        ...(config.supervisorToken ? { token: config.supervisorToken } : {}),
      };
      return createDockerSupervisorProvider(options);
    }
    case "shared":
      return createSharedComputerProvider({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
      });
  }
}
