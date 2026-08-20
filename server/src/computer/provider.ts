import type { ComputerConfig } from "../config";
import { createDaytonaComputerProvider } from "./daytona";
import {
  createDockerSupervisorProvider,
  type SupervisorOptions,
} from "./supervisor";

import type { ComputerStatus } from "./schema";

/** The address and lifecycle details for one Bot's computer. */
export type ComputerLocation = {
  botId: string;
  status: string;
  url?: string;
  startedAt?: string;
};

/** A description of how a provider separates one Bot's computer from another. */
export type IsolationDescription = {
  isolation: "one computer per Bot" | "one shared computer";
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
  /** Describe the isolation that this provider gives to Bots. */
  describeIsolation(): IsolationDescription;
  /** Return the base address of the computer for this Bot. */
  locate(botId: string): Promise<string>;
  /** Return the lifecycle state of the computer for this Bot. */
  status(botId: string): Promise<ComputerStatus>;
  /** Stop the computer for this Bot if it exists. */
  stop(botId: string): Promise<void>;
  /** Remove the computer state for this Bot if it exists. */
  reset(botId: string): Promise<void>;
  /** List the computers that this provider owns. */
  list(): Promise<ComputerLocation[]>;
  /** Prepare provider resources before the first computer request. */
  warm?(): Promise<void>;
}

type SharedComputerProviderOptions = {
  baseUrl: string;
  token?: string;
};

type SharedComputerEntry = {
  botId: string;
  running?: boolean;
  status?: string;
  url?: string;
  startedAt?: string | null;
};

/**
 * Give every Bot the same computer.
 *
 * This adapter keeps shared deployments behind the same provider seam as the
 * Docker supervisor and Daytona.
 */
export function createSharedComputerProvider(
  options: SharedComputerProviderOptions,
): ComputerProvider {
  const base = options.baseUrl.replace(/\/$/, "");

  function headers(botId?: string): Record<string, string> {
    return {
      ...(botId ? { "x-openbot-bot-id": botId } : {}),
      ...(options.token
        ? { "x-openbot-computer-token": options.token }
        : {}),
    };
  }

  async function call(
    path: string,
    method: "GET" | "POST",
    botId?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: headers(botId),
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
    describeIsolation(): IsolationDescription {
      return {
        isolation: "one shared computer",
        note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY to give each Bot its own.",
        warning:
          "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY for a computer each.",
      };
    },

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

    async stop(botId: string): Promise<void> {
      await call("/stop", "POST", botId);
    },

    async reset(botId: string): Promise<void> {
      await call("/reset", "POST", botId);
    },

    async list(): Promise<ComputerLocation[]> {
      const body = (await call("/computers", "GET")) as {
        computers?: SharedComputerEntry[];
      };
      return (body?.computers ?? []).map((computer) => ({
        botId: computer.botId,
        status:
          computer.status ?? (computer.running === true ? "running" : "stopped"),
        url: computer.url ?? base,
        ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
      }));
    },
  };
}

/** Build the one computer provider selected by deployment configuration. */
export function createComputerProvider(config: ComputerConfig): ComputerProvider {
  switch (config.provider) {
    case "daytona":
      return createDaytonaComputerProvider({
        apiKey: config.apiKey,
        computerToken: config.token,
        environment: process.env,
        ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
        ...(config.target ? { target: config.target } : {}),
        ...(config.snapshot ? { snapshot: config.snapshot } : {}),
      });
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
