/**
 * A conversation, live: the Bot's runs as they happen, over the threadStream channel of api/asyncapi.yaml.
 *
 * The server hands out a join token for the conversation (createConversationJoinToken), which opens one socket once,
 * for about half a minute; the socket speaks Phoenix Channels v2, every frame `[join ref, ref, topic, event, payload]`.
 * The gateway replays what the thread holds, says `replay_complete`, then sends events as they happen. Every event
 * carries an id, so a socket that drops is opened again with a new token and the last id drawn, and an id already
 * drawn is dropped.
 *
 * Live is an extra, never a need: the conversation screen still reloads on its own every few seconds. So a server that
 * has no join tokens (older than the operation) or a socket that can't be held is quietly given up on, and nothing on
 * screen says so.
 *
 * Everything it reaches the app and the phone through is handed to it ({@link LiveDeps}); ./watch-conversation.ts hands
 * it the real ones.
 */
import type { ConversationJoinToken } from "./api/generated/model";

/** One AG-UI event as the gateway sends it: a type, and whatever members that type has. */
export type LiveEvent = {
  type: string;
  metadata?: { cpki_event_id?: string };
  [member: string]: unknown;
};

export type LiveHandlers = {
  /** A run's event. `replayed` is true for what the thread held before this socket joined. */
  onEvent(event: LiveEvent, replayed: boolean): void;
  /** The replay is over: what follows is live. `runId` is the run in progress when the token was made, if any. */
  onCaughtUp(runId: string | null): void;
};

/** The socket answered nothing for this long: it is dead, and opened again. The gateway's own timeout. */
const HEARTBEAT_MS = 25_000;
/** How long to wait before opening a dropped socket again, growing to the last. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Statuses that mean this server will never give this conversation a join token: stop asking. */
const NEVER = new Set([404, 405, 501]);

/** The socket's address: the REST answer's clientUrl, on this server when it is a path, ending in /websocket. */
export function socketAddress(
  token: Pick<ConversationJoinToken, "joinToken" | "realtime">,
  server: string,
): { url: string; ours: boolean } {
  const base = token.realtime.clientUrl.replace(/\/+$/, "");
  const query = `join_token=${encodeURIComponent(token.joinToken)}&vsn=2.0.0`;
  const serverWs = server.replace(/^http/, "ws").replace(/\/+$/, "");
  if (base.startsWith("/"))
    return { url: `${serverWs}${base}/websocket?${query}`, ours: true };
  const url = `${base}/websocket?${query}`;
  return { url, ours: url.startsWith(`${serverWs}/`) };
}

type Frame = [string | null, string | null, string, string, unknown];

function parse(data: unknown): Frame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const frame: unknown = JSON.parse(data);
    return Array.isArray(frame) && frame.length === 5
      ? (frame as Frame)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The part of a socket used here. React Native's WebSocket is one. */
export type LiveSocket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
};

/** What the socket reaches the app and the phone through. */
export type LiveDeps = {
  /** The conversation's join token (createConversationJoinToken); a refusal carries the HTTP status as `status`. */
  joinToken(conversationId: string): Promise<ConversationJoinToken>;
  /** Opens a socket with headers on the upgrade, as React Native's WebSocket does: how the access token reaches it. */
  open(url: string, headers: Record<string, string>): LiveSocket;
  accessToken(): Promise<string | null>;
  /** The headers every request names the app with. */
  clientHeaders(): Record<string, string>;
  /** The API's address. */
  server: string;
  /** Whether the app is in front, and word when that changes. */
  inFront(): boolean;
  onInFront(listener: (inFront: boolean) => void): () => void;
};

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;

/**
 * Watch a conversation's runs until `stop`. Opens again after a drop, and closes while the app is in the background (a
 * phone drops it anyway), opening again when it is back. A conversation no Bot has run in yet has nothing to join: the
 * screen calls `reconnect` once a message is sent.
 */
export function watchConversation(
  conversationId: string,
  handlers: LiveHandlers,
  deps: LiveDeps,
): { stop(): void; reconnect(): void } {
  let socket: LiveSocket | undefined;
  let stopped = false;
  let given = false;
  let tries = 0;
  let lastSeen: string | null = null;
  const drawn = new Set<string>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let ref = 0;

  const close = () => {
    if (beat) clearInterval(beat);
    beat = undefined;
    if (retry) clearTimeout(retry);
    retry = undefined;
    const open = socket;
    socket = undefined;
    if (open) {
      open.onopen = open.onmessage = open.onerror = open.onclose = null;
      try {
        open.close();
      } catch {}
    }
  };

  const later = () => {
    close();
    if (stopped || given) return;
    const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
    tries += 1;
    retry = setTimeout(() => void open(), wait);
  };

  async function open() {
    if (stopped || given || socket) return;
    if (!deps.inFront()) return;
    let token: ConversationJoinToken;
    try {
      token = await deps.joinToken(conversationId);
    } catch (error) {
      const status = statusOf(error);
      // No Bot has run here yet (409): nothing to join until a message is sent, which opens it again.
      if (status === 409) return;
      if (status !== undefined && NEVER.has(status)) {
        given = true;
        return;
      }
      later();
      return;
    }
    if (stopped || socket) return;
    const { url, ours } = socketAddress(token, deps.server);
    const bearer = ours ? await deps.accessToken() : null;
    if (stopped || socket) return;
    const headers: Record<string, string> = { ...deps.clientHeaders() };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const topic = token.realtime.topic;
    const joinRef = String(++ref);
    let replaying = true;
    const opened = deps.open(url, headers);
    socket = opened;
    const send = (frame: Frame) => opened.send(JSON.stringify(frame));
    let heard = Date.now();
    opened.onopen = () => {
      send([
        joinRef,
        joinRef,
        topic,
        "phx_join",
        lastSeen ? { last_seen_event_id: lastSeen } : {},
      ]);
      beat = setInterval(() => {
        if (Date.now() - heard > HEARTBEAT_MS * 2) return later();
        send([null, String(++ref), "phoenix", "heartbeat", {}]);
      }, HEARTBEAT_MS);
    };
    opened.onmessage = (message) => {
      heard = Date.now();
      const frame = parse(message.data);
      if (!frame || frame[2] !== topic) return;
      const [, , , event, payload] = frame;
      if (event === "phx_reply") {
        const status = (payload as { status?: string } | null)?.status;
        if (status === "error") later();
        else tries = 0;
        return;
      }
      if (event === "ag_ui_event") {
        const live = payload as LiveEvent | null;
        if (!live || typeof live.type !== "string") return;
        const id = live.metadata?.cpki_event_id;
        if (id) {
          if (drawn.has(id)) return;
          drawn.add(id);
          lastSeen = id;
        }
        handlers.onEvent(live, replaying);
        return;
      }
      if (event === "replay_complete") {
        replaying = false;
        handlers.onCaughtUp(token.runId);
        return;
      }
      // Its time is up, its replay failed, or its topic failed or closed: open it again with a new token.
      if (
        event === "expired" ||
        event === "replay_failed" ||
        event === "phx_error" ||
        event === "phx_close"
      )
        later();
    };
    opened.onerror = () => later();
    opened.onclose = () => later();
  }

  const leaveFront = deps.onInFront((inFront) => {
    if (inFront) void open();
    else close();
  });
  void open();
  return {
    stop() {
      stopped = true;
      leaveFront();
      close();
    },
    reconnect() {
      if (!socket) {
        tries = 0;
        void open();
      }
    },
  };
}
