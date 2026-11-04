/**
 * One of Intelligence's project change topics, over its realtime gateway: `project_meta:<topic>:<code>`.
 *
 * The same rules as the Bot registry's subscription (agents/bot-registry/events.ts), for any topic:
 * an announcement says what changed and its version, never the new state; delivery is at most once,
 * so the caller reads again every time this joins (after every reconnect) and on a timer. The join
 * token is single-use and short-lived, so Phoenix's own reconnect, which presents the spent token
 * again, can never succeed: any close or error tears the socket down and starts over with a new one.
 */
import { Socket } from "phoenix";
import { clientSocketUrl } from "../agents/bot-registry/events";

export type ProjectChangeSubscription = {
  /** The join code currently subscribed to, or null while not joined. */
  joinCode(): string | null;
  /** Drop the current subscription and make a new one, for a join code Intelligence has rotated. */
  renew(): void;
  stop(): void;
};

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export function subscribeToProjectChanges<Change>(options: {
  /** `conversations` or `delivery`: the topic is `project_meta:<topic>:<joinCode>`. */
  topic: string;
  /** The event name the gateway pushes on that topic. */
  event: string;
  subscribe: () => Promise<{ joinToken: string; joinCode: string }>;
  gatewayWsUrl: string;
  parse: (payload: unknown) => Change | null;
  onChange: (change: Change) => void;
  /** Called every time a subscription is joined, the first and every one after a reconnect. */
  onJoined: (joinCode: string) => void;
  /** For the log lines. */
  name: string;
}): ProjectChangeSubscription {
  const endpoint = clientSocketUrl(options.gatewayWsUrl);
  let socket: Socket | undefined;
  let joined: string | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Bumped on every teardown, so a callback from a socket already replaced does nothing. */
  let generation = 0;

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
    console.warn(
      JSON.stringify({
        type: `${options.name}-subscription-retry`,
        reason,
        retryInMs: delay,
      }),
    );
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
      credentials = await options.subscribe();
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
      `project_meta:${options.topic}:${credentials.joinCode}`,
    );
    channel.on(options.event, (payload: unknown) => {
      const change = options.parse(payload);
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

  void connect();

  return {
    joinCode: () => joined,
    renew() {
      if (stopped) return;
      teardown();
      attempt = 0;
      void connect();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      teardown();
    },
  };
}
