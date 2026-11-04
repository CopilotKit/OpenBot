import { type Channel, Socket } from "phoenix";

/** The part of phoenix.js's Push the streamer uses. */
export type PushLike = {
  receive(
    status: "ok" | "error" | "timeout",
    callback: (response?: unknown) => void,
  ): PushLike;
};

/** The part of phoenix.js's Channel the streamer uses; every handler returns a ref that `off` removes. */
export type ChannelLike = {
  join(timeoutMs: number): PushLike;
  push(event: string, payload: object, timeoutMs: number): PushLike;
  leave(): void;
  on(event: string, callback: (payload: unknown) => void): number;
  off(event: string, ref: number): void;
  onError(callback: (payload: unknown) => void): number;
  onClose(callback: (payload: unknown) => void): number;
};

/**
 * The part of phoenix.js's Socket the streamer uses. `connect` is assignable: the streamer replaces it with a no-op when
 * it tears a connection down, exactly as `@copilotkit/core`'s `TrajectoryConnection.cleanup` does, so neither phoenix.js's
 * reconnect timer nor its heartbeat timeout can open the socket again with a spent pass.
 */
export type PhoenixLike = {
  connect: () => void;
  disconnect(): void;
  channel(topic: string): ChannelLike;
  onOpen(callback: () => void): string;
  onError(callback: (error: unknown) => void): string;
  onClose(callback: (event: { code?: number } | undefined) => void): string;
  off(refs: string[]): void;
};

/** The gateway's own timeout, and the one the socket, the join and every push use (core's `TIMEOUT_MS`). */
export const PHOENIX_TIMEOUT_MS = 10_000;

type Transport = new (endpoint: string, protocols?: string[]) => object;

function wrapChannel(channel: Channel): ChannelLike {
  return {
    join: (timeoutMs) => channel.join(timeoutMs),
    push: (event, payload, timeoutMs) =>
      channel.push(event, payload, timeoutMs),
    leave: () => {
      channel.leave();
    },
    on: (event, callback) => channel.on(event, callback),
    off: (event, ref) => channel.off(event, ref),
    // phoenix.js 1.8's Channel.onClose returns no ref (and `off` without one removes every phx_close binding, phoenix's
    // own included), so both are bound as plain events, which do return refs.
    onError: (callback) => channel.on("phx_error", callback),
    onClose: (callback) => channel.on("phx_close", callback),
  };
}

/** A phoenix.js Socket for one capture pass: `<url>/websocket?join_token=...&vsn=2.0.0`. `transport` is a test seam. */
export function createPhoenixSession(
  url: string,
  params: Record<string, string>,
  options: { transport?: Transport } = {},
): PhoenixLike {
  const socket = new Socket(url, {
    params,
    timeout: PHOENIX_TIMEOUT_MS,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  return {
    get connect() {
      return () => socket.connect();
    },
    set connect(replacement: () => void) {
      socket.connect = replacement;
    },
    disconnect: () => socket.disconnect(),
    channel: (topic) => wrapChannel(socket.channel(topic, {})),
    onOpen: (callback) => socket.onOpen(callback),
    onError: (callback) => socket.onError((error) => callback(error)),
    onClose: (callback) => socket.onClose((event) => callback(event)),
    off: (refs) => socket.off(refs),
  };
}
