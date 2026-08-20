/**
 * Where a Bot's computer lives, asked of the supervisor.
 *
 * Each Bot gets a container of its own, which means the address of a computer is no longer one
 * fixed URL, it is whatever port the supervisor published for that Bot, and it changes when the
 * computer is reset. So the server stops holding an address and starts asking for one.
 *
 * The server still never touches Docker. It asks for a Bot's computer by Bot; the supervisor decides
 * what that means. Everything the API server can express is in this file, and it is four verbs.
 *
 * Without a supervisor configured, nothing here is used and the fixed `AGENT_COMPUTER_URL` still
 * answers for every Bot. That is the single-container mode: fine for one person on a laptop, and
 * honest about being one shared computer.
 */

import type { ComputerStatus } from "./schema";
import type {
  ComputerLocation,
  ComputerProvider,
  IsolationDescription,
} from "./provider";

type SupervisorComputerLocation = {
  botId: string;
  container?: string;
  status: string;
  port?: number;
  /** Where to reach it, decided by the supervisor rather than assembled here. */
  url?: string;
  startedAt?: string;
};

export type SupervisorOptions = {
  baseUrl: string;
  token?: string;
  /** How a published port becomes a URL the server can reach. */
  hostForPort?: (port: number) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export function createDockerSupervisorProvider(
  options: SupervisorOptions,
): ComputerProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const hostForPort =
    options.hostForPort ?? ((port) => `http://localhost:${port}`);

  async function call(path: string, method = "POST"): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: options.token
          ? { authorization: `Bearer ${options.token}` }
          : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SupervisorError(
        `The container supervisor at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new SupervisorError(
        body?.error ?? `The supervisor answered ${response.status}.`,
      );
    }
    return body;
  }

  async function list(): Promise<ComputerLocation[]> {
    const body = (await call("/computers", "GET")) as {
      computers?: SupervisorComputerLocation[];
    };
    return (body?.computers ?? []).map((computer) => ({
      botId: computer.botId,
      status: computer.status,
      ...(computer.url
        ? { url: computer.url }
        : computer.port
          ? { url: hostForPort(computer.port) }
          : {}),
      ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
    }));
  }

  function statusFromLocation(
    botId: string,
    location: ComputerLocation | undefined,
  ): ComputerStatus {
    if (!location) return { botId, state: "absent" };

    const rawStatus = location.status;
    switch (rawStatus.toLowerCase()) {
      case "running":
      case "started":
        return { botId, state: "ready" };
      case "created":
      case "restarting":
      case "creating":
      case "starting":
      case "restoring":
      case "pulling_snapshot":
      case "resuming":
        return { botId, state: "starting" };
      case "stopped":
      case "paused":
      case "archived":
      case "exited":
      case "destroyed":
      case "removing":
      case "archiving":
      case "pausing":
      case "stopping":
        return { botId, state: "absent" };
      case "error":
      case "build_failed":
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported state "${rawStatus}".`,
        };
      default:
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported unknown state "${rawStatus}".`,
        };
    }
  }

  const isolation: IsolationDescription = {
    isolation: "one computer per Bot",
    note: "Each Bot gets its own container, its own /workspace and its own browser profile.",
  };

  return {
    name: "Docker supervisor",
    isolation: "per-bot",
    describeIsolation: () => isolation,

    /**
     * The URL of this Bot's computer, starting it if it is not already up.
     *
     * A computer that is running but has published no port is a computer nothing can reach, so that
     * is an error rather than a URL, the alternative is a caller quietly falling back to somebody
     * else's computer.
     */
    async locate(botId: string): Promise<string> {
      const state = (await call(
        `/computers/${encodeURIComponent(botId)}/ensure`,
      )) as SupervisorComputerLocation;
      // The supervisor says where it is, because only it knows whether these computers sit on a
      // shared network or answer on a published port.
      if (state?.url) return state.url;
      if (state?.port) return hostForPort(state.port);
      throw new SupervisorError(
        `The computer for ${botId} started but reported no address, so it cannot be reached.`,
      );
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const computers = await list();
        return statusFromLocation(
          botId,
          computers.find((computer) => computer.botId === botId),
        );
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
      await call(`/computers/${encodeURIComponent(botId)}/stop`);
    },

    async reset(botId: string): Promise<void> {
      await call(`/computers/${encodeURIComponent(botId)}/reset`);
    },

    list,
  };
}

export const createSupervisorClient = createDockerSupervisorProvider;

export type SupervisorClient = ComputerProvider;
