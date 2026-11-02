/**
 * Where a person's computer lives, asked of the supervisor.
 *
 * Each person gets a container of their own, and every Bot they use runs on it; an isolated Bot gets
 * one of its own. So the address of a computer is no longer one fixed URL, it is whatever port the
 * supervisor published for that person or Bot, and it changes when the computer is reset. So the
 * server stops holding an address and starts asking for one.
 *
 * The server still never touches Docker. It asks for a computer by whose it is; the supervisor
 * decides what that means. Everything the API server can express is in this file, and it is four
 * verbs.
 *
 * Without a supervisor configured, nothing here is used and the fixed `AGENT_COMPUTER_URL` still
 * answers for every Bot. That is the single-container mode: fine for one person on a laptop, and
 * honest about being one shared computer.
 */

import { ComputerStillStartingError } from "./client";
import {
  type ComputerKey,
  type ComputerSeat,
  computerKeyText,
} from "./computer-key";
import type {
  ComputerLocation,
  ComputerProvider,
  ComputerTarget,
} from "./provider";
import type { ComputerStatus } from "./schema";

type SupervisorComputerLocation = {
  /** Whose computer: `person` or `bot`, and their id. */
  kind?: string;
  id?: string;
  container?: string;
  status: string;
  port?: number;
  /** Where to reach it, decided by the supervisor rather than assembled here. */
  url?: string;
  startedAt?: string;
  /** The image's healthcheck verdict, from a supervisor new enough to report it. */
  health?: string;
  /** What giving private Bots' old profiles to this person did, when it was asked for. */
  carriedOver?: Record<string, string>;
};

/** The supervisor's path for a computer: `/computers/person/<id>` or `/computers/bot/<id>`. */
function pathOf(key: ComputerKey): string {
  return key.kind === "person"
    ? `/computers/person/${encodeURIComponent(key.personId)}`
    : `/computers/bot/${encodeURIComponent(key.botId)}`;
}

/** Whose computer a listed one is, or undefined for one this server cannot name. */
function keyOf(computer: SupervisorComputerLocation): ComputerKey | undefined {
  if (!computer.id) return undefined;
  if (computer.kind === "person")
    return { kind: "person", personId: computer.id };
  if (computer.kind === "bot") return { kind: "bot", botId: computer.id };
  return undefined;
}

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
  /*
   * Numeric, never `localhost`.
   *
   * `localhost` does not resolve the same way on every operating system — Node prefers `::1`, bun
   * prefers `127.0.0.1` — so a name here reaches a different interface depending on what started
   * the process, and a computer that is listening looks like one that is not.
   */
  const hostForPort =
    options.hostForPort ?? ((port) => `http://127.0.0.1:${port}`);

  /**
   * Seats whose Bot's old profile the supervisor has answered for, so it is asked once per process.
   *
   * The supervisor remembers too, and its marker in the person's volume is the record that outlives
   * both; this only keeps the question off every `/ensure` after the first.
   */
  const carried = new Set<string>();

  /**
   * The last container start time seen for each computer, from the `/ensure` that located it.
   *
   * ONE MAP PER PROVIDER, not one per process. It was module-scope, so every provider built in a
   * process shared it: two supervisors, or a test's second stack, answered each other's question
   * about which run a Bot's computer is on, and the answer they gave was whichever one wrote last.
   *
   * Not a cache in front of the supervisor: `locate` still calls it every time, and a governed
   * action locates before it asks. This only carries that answer the few lines to whoever needs to
   * know which run of the computer they are talking to.
   *
   * Still process-local, and therefore never the only answer. A replica that has never located this
   * computer has nothing here, and an unknown run skips the generation check rather than failing it,
   * so `sessionOf` falls back to asking rather than letting an empty map quietly stop checking.
   *
   * Keyed by computer, not by Bot: every Bot on a person's computer is on the same run of it.
   */
  const sessions = new Map<string, string>();

  async function call(
    path: string,
    method = "POST",
    body?: unknown,
    /**
     * Whether running out of time means the computer is still starting.
     *
     * Only for `/ensure`, which is the one call that waits on a container coming up: there a timeout
     * is a slow start, and the caller is told so gently. Anywhere else it is a supervisor that has
     * stopped answering, which is a real fault and keeps its own message.
     */
    startingOnTimeout = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (
        startingOnTimeout &&
        error instanceof Error &&
        error.name === "TimeoutError"
      ) {
        throw new ComputerStillStartingError();
      }
      throw new SupervisorError(
        `The container supervisor at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const answer = (await response.json().catch(() => null)) as {
      error?: string;
      stopped?: boolean;
      reset?: boolean;
      computers?: SupervisorComputerLocation[];
      starting?: boolean;
    } | null;
    if (!response.ok) {
      // The supervisor's own health wait ran out on a container that is up and still booting. The
      // same slow start as a timeout here, so it gets the same gentle answer.
      if (
        startingOnTimeout &&
        response.status === 503 &&
        answer?.starting === true
      ) {
        throw new ComputerStillStartingError();
      }
      throw new SupervisorError(
        answer?.error ?? `The supervisor answered ${response.status}.`,
      );
    }
    return answer;
  }

  async function listRaw(): Promise<SupervisorComputerLocation[]> {
    const body = (await call("/computers", "GET")) as {
      computers?: SupervisorComputerLocation[];
    } | null;
    return body?.computers ?? [];
  }

  /** The listed computer that is this key's, if there is one. */
  function find(
    computers: SupervisorComputerLocation[],
    key: ComputerKey,
  ): SupervisorComputerLocation | undefined {
    const wanted = computerKeyText(key);
    return computers.find((computer) => {
      const of = keyOf(computer);
      return of !== undefined && computerKeyText(of) === wanted;
    });
  }

  async function list(): Promise<ComputerLocation[]> {
    const computers = await listRaw();
    return computers
      .flatMap((computer) => {
        const key = keyOf(computer);
        return key ? [{ key, computer }] : [];
      })
      .map(({ key, computer }) => ({
        key,
        status:
          computer.status.toLowerCase() === "running" ? "running" : "stopped",
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
    location: SupervisorComputerLocation | undefined,
  ): ComputerStatus {
    // About the computer the seat is on; reported for the seat's Bot, which is who asked.
    if (!location) return { botId, state: "absent" };

    const rawStatus = location.status.toLowerCase();
    switch (rawStatus) {
      case "running":
        // Running is the process; healthy is the browser inside it. Until the healthcheck passes,
        // `/ensure` holds every caller, so the computer is still starting.
        return location.health === "starting"
          ? { botId, state: "starting" }
          : { botId, state: "ready" };
      case "created":
      case "restarting":
        return { botId, state: "starting" };
      case "paused":
      case "removing":
      case "exited":
        return { botId, state: "absent" };
      case "dead":
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported state "${location.status}".`,
        };
      default:
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported unknown state "${location.status}".`,
        };
    }
  }

  return {
    name: "Docker supervisor",
    isolation: "per-person",

    async sessionOf(seat: ComputerSeat): Promise<string | undefined> {
      const id = computerKeyText(seat.key);
      /*
       * Read from the same `/ensure` every action already makes, and remembered rather than asked
       * for again: on the replica that located this computer, `locate` ran immediately before the
       * call that needs this, so the value is as fresh as the address it was fetched with. Asking
       * twice would double the supervisor's work on the hot path to learn something it just told us.
       */
      const known = sessions.get(id);
      if (known) return known;

      /*
       * Nothing here means another replica did the work, not that there is nothing to know.
       *
       * LISTING, NOT ENSURING, and the difference is the whole feature. `/ensure` starts a computer
       * that is not running, so answering "which run is this" with it would wake every idle computer
       * that anything asked about, and a deployment that suspends idle computers would quietly never
       * suspend one. Listing is a read: a computer that does not exist answers undefined, which is the
       * same answer as before and leaves the check exactly where it was.
       */
      try {
        const startedAt = find(await listRaw(), seat.key)?.startedAt;
        if (startedAt) sessions.set(id, startedAt);
        return startedAt;
      } catch {
        // Unknown, not mismatched. A supervisor that cannot be reached must not turn every ref into
        // a refusal; the generation check goes back to being skipped, which is where it started.
        return undefined;
      }
    },

    /**
     * The URL of the computer this seat is on, starting it if it is not already up.
     *
     * A computer that is running but has published no port is a computer nothing can reach, so that
     * is an error rather than a URL, the alternative is a caller quietly falling back to somebody
     * else's computer.
     *
     * A private Bot on its owner's computer also asks, once, for the Bot's profile from before
     * computers were per person: the supervisor copies it in before it answers, so the Bot's first
     * request already finds its logins.
     */
    async locate(seat: ComputerSeat): Promise<string> {
      const id = computerKeyText(seat.key);
      const seatId = `${id}/${seat.botId}`;
      const carryOver =
        seat.inheritsProfile &&
        seat.key.kind === "person" &&
        !carried.has(seatId);
      const state = (await call(
        `${pathOf(seat.key)}/ensure`,
        "POST",
        carryOver ? { carryOver: [seat.botId] } : undefined,
        true,
      )) as SupervisorComputerLocation;
      if (carryOver && state?.carriedOver?.[seat.botId]) carried.add(seatId);
      // Recorded on every ensure, so a replaced container is visible to whatever asks next.
      if (state?.startedAt) sessions.set(id, state.startedAt);
      // The supervisor says where it is, because only it knows whether these computers sit on a
      // shared network or answer on a published port.
      if (state?.url) return state.url;
      if (state?.port) return hostForPort(state.port);
      throw new SupervisorError(
        `The computer for ${id} started but reported no address, so it cannot be reached.`,
      );
    },

    async status(seat: ComputerSeat): Promise<ComputerStatus> {
      try {
        return statusFromLocation(seat.botId, find(await listRaw(), seat.key));
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

    /** The whole computer: on a person's, every Bot there stops with it and keeps its logins. */
    async stop(target: ComputerTarget): Promise<{ wasRunning: boolean }> {
      const result = (await call(`${pathOf(target.key)}/stop`)) as {
        stopped?: boolean;
      } | null;
      return { wasRunning: result?.stopped === true };
    },

    /** The whole computer: on a person's, every Bot there is signed out. */
    async reset(target: ComputerTarget): Promise<{ cleared: boolean }> {
      const result = (await call(`${pathOf(target.key)}/reset`)) as {
        reset?: boolean;
      } | null;
      return { cleared: result?.reset === true };
    },

    list,
  };
}
