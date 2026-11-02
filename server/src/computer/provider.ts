import type { ComputerConfig } from "../config";
import {
  type ComputerKey,
  type ComputerSeat,
  computerKeyText,
} from "./computer-key";
import {
  createSandboxComputerProvider,
  inClusterConfig,
  readSandboxTemplate,
} from "./sandbox";
import type { ComputerStatus } from "./schema";
import {
  createDockerSupervisorProvider,
  type SupervisorOptions,
} from "./supervisor";

/**
 * One computer, or one Bot's seat on a computer, as a provider lists it.
 *
 * A provider that makes computers (the supervisor, the sandbox) lists computers: one per person,
 * and one per isolated Bot. The shared computer is one computer for everybody, so it lists the seats
 * on it instead, and each of those names its Bot.
 */
export type ComputerLocation = {
  /** Whose computer: a person's, or an isolated Bot's. */
  key: ComputerKey;
  /** The Bot, where this is one Bot's seat on a computer many people share. */
  botId?: string;
  status: "running" | "stopped";
  url?: string;
  startedAt?: string;
  egress?: string | null;
  /** Whether this computer runs an older image than a new one would get. Only a sandbox can tell. */
  updateAvailable?: boolean;
};

/**
 * What a stop or a reset acts on: a whole computer, or one Bot's seat on the shared computer.
 *
 * A provider that makes computers acts on the computer the key names; the Bot, if one is given, is
 * on it and goes with it. The shared computer cannot be stopped for one person, so there the Bot
 * names the seat, and without one every seat the key owns is acted on.
 */
export type ComputerTarget = { key: ComputerKey; botId?: string };

/** What moving a computer onto the current image did. */
export type ComputerUpdate = {
  /** False when it was already current, or there is no computer. */
  updated: boolean;
  /** Whether it was running, and is therefore restarting on the new image. */
  wasRunning: boolean;
  /** The images it ran and the ones it runs now, for the trail. */
  from?: string;
  to?: string;
};

/** A description of how a provider separates one person's computer from another's. */
export type IsolationDescription = {
  isolation: "off" | "one computer per person" | "one shared computer";
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

  if (provider.isolation === "per-person") {
    return {
      isolation: "one computer per person",
      note: "Each person gets their own computer, and every Bot they use runs on it, public Bots made by other people included, with its own browser profile and folder. A command one Bot runs can reach anything else on that person's computer. An isolated Bot gets a computer of its own.",
    };
  }

  /*
   * What the shared computer does and does not keep apart, said plainly.
   *
   * Each person's seat on each Bot has its own browser profile and folder, so logins are neither
   * shared between Bots nor between people. What it cannot do is keep a command apart: every Bot's
   * shell runs in the one container, and can read any path in it.
   */
  return {
    isolation: "one shared computer",
    note: "No supervisor is configured, so every person's Bots run on one computer. Each person's Bots keep their own browser profile and folder, so logins are not shared, but a command one Bot runs can read another's files. Set COMPUTER_SUPERVISOR_URL to give each person a computer of their own.",
    warning:
      "Every person's Bots run on one computer. Set COMPUTER_SUPERVISOR_URL for a computer per person.",
  };
}

/**
 * A backend that gives Bots access to a computer.
 *
 * One computer per person (and one per isolated Bot), or one computer for everybody. Callers use this
 * interface and do not need to know which backend is active: every call that reaches a Bot's browser
 * is made for a seat (see computer-key.ts), and the provider decides which computer that is.
 */
export interface ComputerProvider {
  /** The provider name for logs and status output. */
  readonly name: string;
  /**
   * How the provider separates computers.
   *
   * `per-person`: it makes computers, one per person and one per isolated Bot. `shared`: one
   * computer for everybody, with a seat per person and Bot on it.
   */
  readonly isolation: "per-person" | "shared";
  /** Return the base address of the computer this seat is on, starting it if it is not up. */
  locate(seat: ComputerSeat): Promise<string>;
  /** Return the lifecycle state of the computer this seat is on. Never starts it. */
  status(seat: ComputerSeat): Promise<ComputerStatus>;
  /** Stop a computer, or one seat on the shared computer, keeping what it knows. */
  stop(target: ComputerTarget): Promise<{ wasRunning: boolean }>;
  /** Remove a computer's saved state, or one seat's on the shared computer. */
  reset(target: ComputerTarget): Promise<{ cleared: boolean }>;
  /** List the computers that this provider owns, or the seats on the shared computer. */
  list(): Promise<ComputerLocation[]>;
  /**
   * Move this computer onto the current image, keeping its files and sign-ins.
   *
   * Only where a computer can be out of date with the deployment and the provider can replace it
   * in place: a Sandbox carries its pod template inline, so it keeps the one it was created with.
   */
  update?(key: ComputerKey): Promise<ComputerUpdate>;
  /** Prepare provider resources before the first computer request. */
  warm?(): Promise<void>;
  /**
   * Which run of this seat's computer is current, if the provider can tell.
   *
   * A snapshot's generation only orders snapshots within one run: a replaced container counts from
   * one again, so a ref from the run before it matches a row nothing has overwritten. This is what
   * tells the two apart.
   *
   * Every provider answers it, and where the answer comes from is the whole of the difference between
   * them: a computer of its own reads it off the container, a sandbox off the moment its browser last
   * became ready, and the one shared computer has to ask the computer, because that process serves
   * every seat and outlives every reset. Optional in the type only for a provider that genuinely
   * cannot say; undefined then means unknown rather than mismatched, and the comparison is skipped
   * exactly as it was before any of this existed.
   */
  sessionOf?(seat: ComputerSeat): Promise<string | undefined>;
}

export type SharedComputerProviderOptions = {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
type SharedComputerEntry = {
  /** Present from a computer that knows seats: the person and Bot, joined. */
  seat?: string;
  botId: string;
  /** Whose seat, on a computer that knows seats. Absent is a Bot's profile from before. */
  personId?: string;
  running?: boolean;
  status?: string;
  url?: string;
  startedAt?: string | null;
  egress?: string | null;
};

/**
 * The headers that put a request in one seat on the shared computer.
 *
 * The Bot, as every caller always sent, and the person, which is what keeps one person's profile
 * and folder for a Bot apart from the next person's. An isolated Bot never reaches here (the shared
 * computer cannot give a Bot one of its own), and a seat keyed by a Bot alone is a profile from
 * before seats were per person: it is named by the Bot only, which is where that profile lives.
 */
export function sharedSeatHeaders(target: {
  botId: string;
  key: ComputerKey;
}): Record<string, string> {
  return {
    "x-openbot-bot-id": target.botId,
    ...(target.key.kind === "person"
      ? { "x-openbot-person-id": target.key.personId }
      : {}),
  };
}

/**
 * Give every person's Bots the same computer, each in a seat of its own.
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
  /** Seats whose old profile has been asked for, so the question is asked once per process. */
  const carried = new Set<string>();

  function headers(seat?: {
    botId: string;
    key: ComputerKey;
  }): Record<string, string> {
    return {
      ...(seat ? sharedSeatHeaders(seat) : {}),
      ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
    };
  }

  async function call(
    path: string,
    method: "GET" | "POST",
    seat?: { botId: string; key: ComputerKey },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(seat),
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

  /** The seats this computer holds, each with whose it is. */
  async function list(): Promise<ComputerLocation[]> {
    const body = (await call("/computers", "GET")) as {
      computers?: SharedComputerEntry[];
    };
    return (body?.computers ?? []).map((computer) => ({
      key: computer.personId
        ? { kind: "person" as const, personId: computer.personId }
        : { kind: "bot" as const, botId: computer.botId },
      botId: computer.botId,
      status:
        computer.status === "running" || computer.running === true
          ? "running"
          : "stopped",
      url: computer.url ?? base,
      ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
      ...(computer.egress !== undefined ? { egress: computer.egress } : {}),
    }));
  }

  /** The seats a target names: the one given, or every seat the key owns. */
  async function seatsOf(
    target: ComputerTarget,
  ): Promise<{ botId: string; key: ComputerKey }[]> {
    if (target.botId) return [{ botId: target.botId, key: target.key }];
    const wanted = computerKeyText(target.key);
    return (await list())
      .filter((seat) => seat.botId && computerKeyText(seat.key) === wanted)
      .map((seat) => ({ botId: seat.botId as string, key: seat.key }));
  }

  return {
    name: "shared",
    isolation: "shared",

    /**
     * The one address, after making sure a private Bot's old profile has reached its owner's seat.
     *
     * Before seats were per person, this computer kept one profile per Bot. A private Bot's had one
     * user, its owner, so it is moved to the owner's seat the first time they use the Bot here and
     * nobody signs in again. Asked once per seat per process and idempotent on the computer, so the
     * cost is one call per seat per restart. A failure is logged, not thrown: the person can still
     * use the Bot, and signing in again is the worst that happens.
     */
    async locate(seat: ComputerSeat): Promise<string> {
      if (seat.inheritsProfile && seat.key.kind === "person") {
        const id = `${computerKeyText(seat.key)}/${seat.botId}`;
        if (!carried.has(id)) {
          try {
            const body = (await call(
              "/computers/carry-over",
              "POST",
              seat,
            )) as { outcome?: string } | null;
            carried.add(id);
            if (body?.outcome === "moved") {
              console.info(
                JSON.stringify({
                  type: "computer-profile-carried-over",
                  bot: seat.botId,
                  person: seat.key.personId,
                  outcome: body.outcome,
                }),
              );
            }
          } catch (error) {
            console.warn(
              JSON.stringify({
                type: "computer-profile-carry-over-failed",
                bot: seat.botId,
                person: seat.key.personId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
      }
      return options.baseUrl;
    },

    /**
     * Which run of this seat's browser is current, asked of the computer itself.
     *
     * NOTHING ELSE HERE KNOWS. A computer of its own gets a run from the container and a sandbox gets
     * one from the moment its browser last became ready; this deployment is one process serving every
     * seat, and it outlives every reset, so the container says the same thing before and after the
     * browser it was asked about was replaced. The computer is the only party that can tell a session
     * apart from the one before it, so it is the one asked.
     *
     * NOT REMEMBERED, unlike the supervisor's, and the difference is `locate`: there it is an
     * `/ensure` that refreshes the answer before every action, while here it is a string and makes no
     * call at all. A cached run would then be the one this process first saw, for the life of the
     * process, which is exactly the stale answer this exists to stop giving.
     */
    async sessionOf(seat: ComputerSeat): Promise<string | undefined> {
      try {
        const body = (await call("/run", "GET", seat)) as {
          run?: unknown;
        } | null;
        return typeof body?.run === "string" && body.run.length > 0
          ? body.run
          : undefined;
      } catch {
        // Unknown, not mismatched. A computer that cannot be reached, or one from before this
        // endpoint existed, must not turn every ref into a refusal; the comparison goes back to
        // being skipped, which is where it started.
        return undefined;
      }
    },

    async status(seat: ComputerSeat): Promise<ComputerStatus> {
      try {
        await call("/health", "GET", seat);
        return { botId: seat.botId, state: "ready" };
      } catch (error) {
        return {
          botId: seat.botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown failure.",
        };
      }
    },

    async stop(target: ComputerTarget): Promise<{ wasRunning: boolean }> {
      let wasRunning = false;
      for (const seat of await seatsOf(target)) {
        const body = (await call("/computers/stop", "POST", seat)) as {
          wasRunning?: boolean;
          stopped?: boolean;
        } | null;
        wasRunning ||= body?.wasRunning ?? body?.stopped ?? false;
      }
      return { wasRunning };
    },

    async reset(target: ComputerTarget): Promise<{ cleared: boolean }> {
      let cleared = false;
      for (const seat of await seatsOf(target)) {
        const body = (await call("/computers/reset", "POST", seat)) as {
          cleared?: boolean;
          reset?: boolean;
        } | null;
        cleared ||= body?.cleared ?? body?.reset ?? false;
      }
      return { cleared };
    },

    list,
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
    case "sandbox":
      /*
       * Built lazily, because reading the service account is asynchronous and this factory is not.
       * Every method needs the same credentials, so the promise is created once and awaited by each
       * rather than the file being read on every call.
       */
      return createLazySandboxProvider(config);
  }
}

/**
 * The sandbox provider, built on first use.
 *
 * Its credentials come off disk, which is asynchronous, and `createComputerProvider` is not. Rather
 * than make every caller await a factory, the work happens once behind a promise and each method
 * waits on the same one. A failure to read them surfaces on the first computer request, naming what
 * is missing, instead of taking the whole deployment down at boot over a feature it may not use.
 */
function createLazySandboxProvider(
  config: Extract<ComputerConfig, { provider: "sandbox" }>,
): ComputerProvider {
  let built: Promise<ComputerProvider> | undefined;

  const provider = async (): Promise<ComputerProvider> => {
    /*
     * A FAILURE IS NOT REMEMBERED, only a success.
     *
     * `??=` holds whatever the first call produced, and a rejected promise is something. One
     * unreadable token file or one blip reading the template at the wrong moment, and every computer
     * request for the rest of the pod's life failed with that same stale error: no probe notices,
     * because the pod is serving happily, and nothing recovers short of a restart. Clearing the memo
     * on rejection makes the next request try again, which is what a transient failure deserves.
     */
    built ??= (async () => {
      const [cluster, template] = await Promise.all([
        inClusterConfig(),
        readSandboxTemplate(config.templateFile),
      ]);
      return createSandboxComputerProvider({
        namespace: config.namespace,
        idleAfterMs: config.idleAfterMs,
        template,
        apiServer: cluster.apiServer,
        token: cluster.token,
        ca: cluster.ca,
      });
    })().catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return built;
  };

  return {
    name: "sandbox",
    isolation: "per-person",
    locate: async (seat) => (await provider()).locate(seat),
    status: async (seat) => (await provider()).status(seat),
    stop: async (target) => (await provider()).stop(target),
    reset: async (target) => (await provider()).reset(target),
    list: async () => (await provider()).list(),
    // Forwarded like the rest, or the gateway sees no `update` and "Update computer" answers 503.
    update: async (key) => {
      const built = await provider();
      if (!built.update)
        throw new Error("The sandbox computer provider cannot update.");
      return built.update(key);
    },
    sessionOf: async (seat) => (await provider()).sessionOf?.(seat),
  };
}
