/**
 * Intelligence's project change feed, as OpenBot subscribes to it: an announcement, over the realtime
 * gateway, that something this project keeps in Intelligence changed. The contract is Intelligence's
 * `docs/contracts/project-change-feed.md`.
 *
 * One subscription follows one resource family (`memory_changes`, `learning_changes`). An announcement
 * says what changed and its version, never the content: Intelligence stays the source of truth, and the
 * subscriber reads it again. Delivery is at most once, so a subscriber reads everything again every time
 * `onJoined` fires (the first join and every one after a reconnect) and on a timer of its own.
 *
 * The join token is single-use and short-lived, so Phoenix's own reconnect, which presents the same
 * token again, can never succeed. Any close or error tears the socket down and starts over with a
 * freshly minted token instead, with backoff. Intelligence keeps a join code alive for an hour; a
 * keepalive reads it well inside that, which renews it, and subscribes again when Intelligence answers
 * with another code or cannot say (null), since announcements for a new code never reach the old topic.
 *
 * This file knows nothing about any one family: the caller gives the family and reads the payload.
 */
import { Socket } from "phoenix";
import { clientSocketUrl } from "../agents/bot-registry/events";

export type ProjectChangeResource = "memory_changes" | "learning_changes";

/** One announcement as Intelligence sent it: the scope and family, plus the family's own fields. */
export type ProjectChange = {
  organizationId: string;
  projectId: string;
  resource: ProjectChangeResource;
} & Record<string, unknown>;

export type ProjectChangesSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class ProjectChangesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ProjectChangesError";
  }
}

export type ProjectChangesClient = ReturnType<
  typeof createProjectChangesClient
>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** Intelligence's two change-feed routes, under this deployment's project key. */
export function createProjectChangesClient(settings: ProjectChangesSettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: "GET" | "POST",
    path: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (method === "POST") headers["content-type"] = "application/json";
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(method === "POST" ? { body: "{}" } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing; both routes are safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new ProjectChangesError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof ProjectChangesError) throw lastError;
    throw new ProjectChangesError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(response: Response, action: string): Promise<never> {
    throw new ProjectChangesError(
      `Intelligence refused to ${action} (${response.status}).`,
      response.status,
      await errorCode(response),
    );
  }

  return {
    /** Credentials for the realtime topic that announces every change in one family. */
    async subscribe(
      resource: ProjectChangeResource,
    ): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request(
        "POST",
        `/api/project-changes/${resource}/subscribe`,
      );
      if (response.status !== 200)
        return refusal(response, `subscribe to ${resource}`);
      return (await response.json()) as { joinToken: string; joinCode: string };
    },

    /**
     * The family's current join code, which this renews for another hour. Null when Intelligence could
     * not say (its Redis did not answer).
     */
    async joinCode(resource: ProjectChangeResource): Promise<string | null> {
      const response = await request("GET", `/api/project-changes/${resource}`);
      if (response.status !== 200)
        return refusal(response, `read the ${resource} join code`);
      const { joinCode } = (await response.json()) as { joinCode?: unknown };
      return typeof joinCode === "string" && joinCode !== "" ? joinCode : null;
    },
  };
}

export type ProjectChangeSubscription = {
  /** The join code currently subscribed to, or null while not joined. */
  joinCode(): string | null;
  /** Drop the current subscription and make a new one. */
  renew(): void;
  stop(): void;
};

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** Well inside the hour Intelligence keeps a join code alive for; every read renews it. */
const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1_000;

export function subscribeToProjectChanges(options: {
  resource: ProjectChangeResource;
  client: Pick<ProjectChangesClient, "subscribe" | "joinCode">;
  /** The gateway address the runtime is configured with. */
  gatewayWsUrl: string;
  onChange: (change: ProjectChange) => void;
  /** Called every time a subscription is joined, the first and every one after a reconnect. */
  onJoined: (joinCode: string) => void;
  /** How often the join code is read and renewed. At most 30 minutes; 15 by default. */
  keepaliveIntervalMs?: number;
}): ProjectChangeSubscription {
  const { resource } = options;
  const endpoint = clientSocketUrl(options.gatewayWsUrl);
  let socket: Socket | undefined;
  let joined: string | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Bumped on every teardown, so a callback from a socket already replaced does nothing. */
  let generation = 0;

  const log = (type: string, fields: Record<string, unknown>) =>
    console.warn(JSON.stringify({ type, resource, ...fields }));

  const teardown = () => {
    generation += 1;
    joined = null;
    const current = socket;
    socket = undefined;
    current?.disconnect();
  };

  const retry = (reason: string) => {
    if (stopped) return;
    teardown();
    const delay =
      BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    attempt += 1;
    log("project-changes-subscription-retry", { reason, retryInMs: delay });
    clearTimeout(timer);
    timer = setTimeout(() => {
      void connect();
    }, delay);
    timer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    const mine = ++generation;
    let credentials: { joinToken: string; joinCode: string };
    try {
      credentials = await options.client.subscribe(resource);
    } catch (error) {
      if (mine === generation)
        retry(
          `subscribe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      return;
    }
    if (stopped || mine !== generation) return;
    const next = new Socket(endpoint, {
      params: { join_token: credentials.joinToken },
      transport: WebSocket,
      // Phoenix would reconnect with the token it already spent; this file reconnects instead.
      reconnectAfterMs: () => 24 * 60 * 60 * 1_000,
    });
    socket = next;
    next.onError(() => {
      if (mine === generation) retry("socket error");
    });
    next.onClose(() => {
      if (mine === generation) retry("socket closed");
    });
    next.connect();
    const channel = next.channel(
      `project_meta:${resource}:${credentials.joinCode}`,
    );
    channel.on("changed", (payload: unknown) => {
      const change = parseChange(payload, resource);
      if (change) options.onChange(change);
    });
    channel.onError(() => {
      if (mine === generation) retry("channel error");
    });
    channel
      .join()
      .receive("ok", () => {
        if (mine !== generation) return;
        attempt = 0;
        joined = credentials.joinCode;
        options.onJoined(credentials.joinCode);
      })
      .receive("error", (response: unknown) => {
        if (mine === generation)
          retry(`join refused: ${JSON.stringify(response)}`);
      })
      .receive("timeout", () => {
        if (mine === generation) retry("join timed out");
      });
  };

  const renew = () => {
    if (stopped) return;
    teardown();
    attempt = 0;
    void connect();
  };

  let checking = false;
  const keepalive = setInterval(
    () => {
      const subscribed = joined;
      if (stopped || checking || subscribed === null) return;
      checking = true;
      options.client
        .joinCode(resource)
        .then((current) => {
          // Still the subscription this read was for: a reconnect in between already has a fresh code.
          if (stopped || joined !== subscribed) return;
          if (current !== subscribed) {
            log("project-changes-join-code-changed", {
              note:
                current === null
                  ? "Intelligence could not say which code is current; subscribing again."
                  : "Intelligence rotated the code; subscribing again.",
            });
            renew();
          }
        })
        .catch((error: unknown) =>
          log("project-changes-keepalive-failed", {
            note: "Still subscribed; the next keepalive tries again.",
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          checking = false;
        });
    },
    Math.min(
      options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS,
      30 * 60 * 1_000,
    ),
  );
  keepalive.unref?.();

  void connect();

  return {
    joinCode: () => joined,
    renew,
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(keepalive);
      teardown();
    },
  };
}

/** The announcement, when it is one for this family; anything else is dropped. */
function parseChange(
  payload: unknown,
  resource: ProjectChangeResource,
): ProjectChange | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const fields = payload as Record<string, unknown>;
  if (
    typeof fields.organizationId !== "string" ||
    typeof fields.projectId !== "string" ||
    fields.resource !== resource
  )
    return null;
  return fields as ProjectChange;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}
