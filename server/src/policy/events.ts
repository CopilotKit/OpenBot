/**
 * Intelligence's announcement that one of this project's policy records changed, over its realtime
 * gateway (`project_meta:policy:<code>`, event `policy_changed`).
 *
 * An announcement says which record and which version, never what changed: Intelligence stays the
 * source of truth and the cache reads the record again. Delivery is at most once, so the cache also
 * reads everything again every time this joins, which is after every reconnect, and on a timer.
 *
 * The join token is single-use and short-lived, so Phoenix's own reconnect, which presents the same
 * token again, can never succeed. Any close or error here tears the socket down and starts over with a
 * freshly minted token instead. Same shape as the Bot registry's (`agents/bot-registry/events.ts`).
 */
import { Socket } from "phoenix";
import { clientSocketUrl } from "../agents/bot-registry/events";
import type { OrgPolicyClient } from "./client";
import { POLICY_RESOURCES, type PolicyChange } from "./types";

export type PolicyChangeSubscription = {
  /** The join code currently subscribed to, or null while not joined. */
  joinCode(): string | null;
  /** Drop the current subscription and make a new one, for a join code Intelligence has rotated. */
  renew(): void;
  stop(): void;
};

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export function subscribeToPolicyChanges(options: {
  client: Pick<OrgPolicyClient, "subscribe">;
  gatewayWsUrl: string;
  onChange: (change: PolicyChange) => void;
  /** Called every time a subscription is joined, the first and every one after a reconnect. */
  onJoined: (joinCode: string) => void;
}): PolicyChangeSubscription {
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
        type: "policy-subscription-retry",
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
      credentials = await options.client.subscribe();
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
    const channel = next.channel(`project_meta:policy:${credentials.joinCode}`);
    channel.on("policy_changed", (payload: unknown) => {
      const change = parsePolicyChange(payload);
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

export function parsePolicyChange(payload: unknown): PolicyChange | null {
  if (!payload || typeof payload !== "object") return null;
  const { resource, key, version, change } = payload as Record<string, unknown>;
  if (
    typeof resource !== "string" ||
    !(POLICY_RESOURCES as readonly string[]).includes(resource)
  )
    return null;
  if (!key || typeof key !== "object" || Array.isArray(key)) return null;
  if (!Object.values(key).every((value) => typeof value === "string"))
    return null;
  if (typeof version !== "number") return null;
  if (change !== "created" && change !== "updated" && change !== "deleted")
    return null;
  return {
    resource: resource as PolicyChange["resource"],
    key: key as Record<string, string>,
    version,
    change,
  };
}
