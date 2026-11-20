/**
 * A fake Intelligence for the Recorder's tests: the realtime gateway's trajectory channel
 * (Phoenix serializer V2 at /client/websocket) and POST /api/trajectories/join.
 *
 * It mirrors what Intelligence v0.13.14 answers a trajectory client: the same limits, refusals,
 * acknowledgements and join errors, as a client sees them on the wire.
 */
import type { ServerWebSocket } from "bun";

const MAX_EVENT_BYTES = 16_384;
const MAX_BATCH_EVENTS = 50;
const MAX_BATCH_BYTES = 65_536;
const MAX_NAME_LENGTH = 200;
const MAX_TIMESTAMP_MS = 253_402_300_800_000;
const MAX_SEQ = 9_007_199_254_740_991;
const MAX_DROPPED = 2_147_483_647;
const OUTCOME_PHASES = ["started", "succeeded", "failed"];
const RETRYABLE_REASONS = new Set([
  "trajectory_over_share",
  "trajectory_outbox_full",
  "storage_unavailable",
  "entitlement_unavailable",
]);
const NOT_ENABLED = "trajectories_not_enabled";
const TOKEN_LIFETIME_MS = 30_000;
const JOIN_PATH = "/api/trajectories/join";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FakeGateway = {
  url: string;
  httpUrl: string;
  mintToken(trajectoryId: string, appUserId?: string): string;
  events(trajectoryId: string): { seq: number; name: string; raw: unknown }[];
  batches: {
    trajectoryId: string;
    count: number;
    bytes: number;
    dropped: number;
  }[];
  droppedReported(trajectoryId: string): number;
  joins: { trajectoryId: string; ok: boolean; reason?: string }[];
  memberships: { trajectoryId: string; learningContainerIds: string[] }[];
  refuseNextSocket(): void;
  refuseNextJoin(reason: string): void;
  /** `POST /api/trajectories/join` answers this error, in Intelligence's envelope, for `forMs`. */
  refuseJoinRoute(
    reply: { status: number; code: string; message: string },
    forMs: number,
  ): void;
  replyNextPush(reply: { reason: string; retryable?: boolean }): void;
  rejectNextEvents(count: number): void;
  expire(
    trajectoryId: string,
    reason:
      | "session_expired"
      | "entitlement_unavailable"
      | "trajectories_not_enabled",
  ): void;
  dropConnections(): void;
  delayNextAck(ms: number): void;
  sendChannelError(trajectoryId: string): void;
  closeSockets(code: number): void;
  ackWithBadCounts(): void;
  replyNextJoin(reason: string): void;
  /** Frames the strict decoder refused (each closed its socket, as the gateway's crashed transport does). */
  undecodable: number;
  stop(): Promise<void>;
};

type StartOptions = {
  eventCap?: number;
  extraRoutes?: (request: Request) => Response | Promise<Response> | null;
};

type Claims = { trajectoryId: string; appUserId: string };
type SocketData = { claims: Claims; channels: Map<string, string | null> };
type Frame = [string | null, string | null, string, string, unknown];
type Stored = { seq: number; name: string; raw: unknown };
type Trajectory = { seqs: Set<number>; stored: Stored[]; dropped: number };

/**
 * Decodes as strictly as Jason 1.4.4's `decode!`: a high-surrogate escape with no low-surrogate
 * escape after it, or a low-surrogate escape with no high one before it, raises (JSON.parse accepts both).
 */
function strictDecode(text: string): unknown {
  const hex = /^[0-9a-fA-F]{4}$/;
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "\\") {
      i += 1;
      continue;
    }
    if (text[i + 1] !== "u") {
      i += 2;
      continue;
    }
    const digits = text.slice(i + 2, i + 6);
    if (!hex.test(digits)) throw new SyntaxError("invalid unicode escape");
    const unit = Number.parseInt(digits, 16);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.slice(i + 6, i + 12);
      if (!next.startsWith("\\u") || !hex.test(next.slice(2))) {
        throw new SyntaxError("lone high surrogate");
      }
      const low = Number.parseInt(next.slice(2), 16);
      if (low < 0xdc00 || low > 0xdfff)
        throw new SyntaxError("lone high surrogate");
      i += 12;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SyntaxError("lone low surrogate");
    } else {
      i += 6;
    }
  }
  return JSON.parse(text);
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (isMap(value))
    return Object.entries(value).some(
      ([key, item]) => containsNul(key) || containsNul(item),
    );
  return false;
}

/** True when Intelligence would store the event. */
function validEvent(
  event: unknown,
): event is { name: string; value: { seq: number }; timestamp: number } {
  if (
    !isMap(event) ||
    event.type !== "CUSTOM" ||
    typeof event.name !== "string"
  )
    return false;
  const value = event.value;
  if (!isMap(value)) return false;
  const { seq } = value;
  const { timestamp } = event;
  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    seq > MAX_SEQ
  )
    return false;
  if (
    typeof timestamp !== "number" ||
    !(timestamp > 0 && timestamp < MAX_TIMESTAMP_MS)
  )
    return false;
  const length = [...event.name].length;
  if (length < 1 || length > MAX_NAME_LENGTH) return false;
  if (byteLength(event) > MAX_EVENT_BYTES) return false;
  if (containsNul(event)) return false;
  if (event.name === "outcome") {
    const { workflow, phase } = value;
    if (typeof workflow !== "string" || workflow === "") return false;
    if (typeof phase !== "string" || !OUTCOME_PHASES.includes(phase))
      return false;
  }
  return true;
}

export async function startFakeGateway(
  options: StartOptions = {},
): Promise<FakeGateway> {
  const eventCap = options.eventCap ?? 20_000;
  const tokens = new Map<string, Claims & { expiresAt: number }>();
  const trajectories = new Map<string, Trajectory>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const trajectory = (id: string): Trajectory => {
    let found = trajectories.get(id);
    if (!found) {
      found = { seqs: new Set(), stored: [], dropped: 0 };
      trajectories.set(id, found);
    }
    return found;
  };

  let refuseSocket = false;
  const joinReplies: string[] = [];
  const pushReplies: { reason: string; retryable?: boolean }[] = [];
  let rejectCount = 0;
  let ackDelayMs = 0;
  let badCounts = false;
  let routeRefusal: {
    status: number;
    code: string;
    message: string;
    until: number;
  } | null = null;

  const gateway: FakeGateway = {
    url: "",
    httpUrl: "",
    batches: [],
    joins: [],
    memberships: [],
    undecodable: 0,
    mintToken(trajectoryId, appUserId = "app-user") {
      const token = crypto.randomUUID();
      tokens.set(token, {
        trajectoryId,
        appUserId,
        expiresAt: Date.now() + TOKEN_LIFETIME_MS,
      });
      return token;
    },
    events: (trajectoryId) => [
      ...(trajectories.get(trajectoryId)?.stored ?? []),
    ],
    droppedReported: (trajectoryId) =>
      trajectories.get(trajectoryId)?.dropped ?? 0,
    refuseNextSocket() {
      refuseSocket = true;
    },
    refuseNextJoin(reason) {
      joinReplies.push(reason);
    },
    replyNextJoin(reason) {
      joinReplies.push(reason);
    },
    refuseJoinRoute(reply, forMs) {
      routeRefusal = { ...reply, until: Date.now() + forMs };
    },
    replyNextPush(reply) {
      pushReplies.push(reply);
    },
    rejectNextEvents(count) {
      rejectCount = count;
    },
    expire(trajectoryId, reason) {
      const topic = `trajectory:${trajectoryId}`;
      for (const ws of sockets) {
        if (!ws.data.channels.has(topic)) continue;
        send(ws, [null, null, topic, "expired", { reason }]);
        closeChannel(ws, topic);
      }
    },
    dropConnections() {
      for (const ws of [...sockets]) ws.terminate();
    },
    delayNextAck(ms) {
      ackDelayMs = ms;
    },
    sendChannelError(trajectoryId) {
      const topic = `trajectory:${trajectoryId}`;
      for (const ws of sockets) {
        const joinRef = ws.data.channels.get(topic);
        if (joinRef === undefined) continue;
        ws.data.channels.delete(topic);
        send(ws, [joinRef, null, topic, "phx_error", {}]);
      }
    },
    closeSockets(code) {
      for (const ws of [...sockets]) ws.close(code);
    },
    ackWithBadCounts() {
      badCounts = true;
    },
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const ws of [...sockets]) ws.terminate();
      await server.stop(true);
    },
  };

  function send(ws: ServerWebSocket<SocketData>, frame: Frame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket closed while a delayed answer was pending.
    }
  }

  function reply(
    ws: ServerWebSocket<SocketData>,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    status: "ok" | "error",
    response: unknown,
  ): void {
    send(ws, [joinRef, ref, topic, "phx_reply", { status, response }]);
  }

  function closeChannel(ws: ServerWebSocket<SocketData>, topic: string): void {
    const joinRef = ws.data.channels.get(topic) ?? null;
    ws.data.channels.delete(topic);
    send(ws, [joinRef, null, topic, "phx_close", {}]);
  }

  function refuse(
    reason: string,
    retryable?: boolean,
  ): { reason: string; retryable?: true } {
    return (retryable ?? RETRYABLE_REASONS.has(reason))
      ? { reason, retryable: true }
      : { reason };
  }

  /** Checks a batch as Intelligence does, then stores it: a reply plus whether the channel stops. */
  function acceptBatch(
    trajectoryId: string,
    payload: unknown,
  ): { status: "ok" | "error"; response: unknown } {
    const refused = (reason: string) => ({
      status: "error" as const,
      response: refuse(reason),
    });
    if (!isMap(payload) || !Array.isArray(payload.events))
      return refused("invalid_batch");
    const dropped = "dropped" in payload ? payload.dropped : 0;
    if (
      typeof dropped !== "number" ||
      !Number.isInteger(dropped) ||
      dropped < 0
    )
      return refused("invalid_batch");
    const claimed = payload.trajectoryId ?? trajectoryId;
    if (
      typeof claimed !== "string" ||
      claimed.toLowerCase() !== trajectoryId.toLowerCase()
    ) {
      return refused("trajectory_mismatch");
    }
    if (payload.events.length > MAX_BATCH_EVENTS)
      return refused("batch_too_many_events");
    if (byteLength(payload) > MAX_BATCH_BYTES)
      return refused("batch_too_large");

    const events: unknown[] = payload.events;
    const forcedRejections = Math.min(rejectCount, events.length);
    rejectCount = 0;
    let rejected = 0;
    let accepted = 0;
    let highestSeq: number | null = null;
    const store = trajectory(trajectoryId);
    events.forEach((event, index) => {
      if (!validEvent(event) || index >= events.length - forcedRejections) {
        rejected += 1;
        return;
      }
      const { seq } = event.value;
      if (store.seqs.has(seq)) {
        accepted += 1; // the duplicate check runs before the cap check
      } else if (store.stored.length >= eventCap) {
        rejected += 1;
        return;
      } else {
        store.seqs.add(seq);
        store.stored.push({ seq, name: event.name, raw: event });
        accepted += 1;
      }
      highestSeq = highestSeq === null || seq > highestSeq ? seq : highestSeq;
    });
    if (dropped > 0) store.dropped += Math.min(dropped, MAX_DROPPED);
    if (badCounts) {
      badCounts = false;
      return {
        status: "ok",
        response: { highestSeq, accepted: events.length + 1, rejected },
      };
    }
    return { status: "ok", response: { highestSeq, accepted, rejected } };
  }

  function handleFrame(ws: ServerWebSocket<SocketData>, frame: unknown): void {
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [joinRef, ref, topic, event, payload] = frame as Frame;
    if (topic === "phoenix" && event === "heartbeat") {
      reply(ws, null, ref, "phoenix", "ok", {});
      return;
    }
    if (event === "phx_join") {
      handleJoin(ws, ref, topic, joinRef);
      return;
    }
    const joined = ws.data.channels.has(topic);
    if (!joined) {
      reply(ws, joinRef, ref, topic, "error", { reason: "unmatched topic" });
      return;
    }
    if (event === "phx_leave") {
      reply(ws, joinRef, ref, topic, "ok", {});
      closeChannel(ws, topic);
      return;
    }
    if (event !== "events") {
      reply(ws, joinRef, ref, topic, "error", { reason: "unsupported_event" });
      return;
    }
    handlePush(ws, joinRef, ref, topic, payload);
  }

  function handleJoin(
    ws: ServerWebSocket<SocketData>,
    ref: string | null,
    topic: string,
    joinRef: string | null,
  ): void {
    if (!topic.startsWith("trajectory:")) {
      reply(ws, joinRef, ref, topic, "error", { reason: "unmatched topic" });
      return;
    }
    const trajectoryId = topic.slice("trajectory:".length);
    const forced = joinReplies.shift();
    const reason =
      forced ??
      (trajectoryId === ws.data.claims.trajectoryId
        ? undefined
        : "unauthorized");
    gateway.joins.push({
      trajectoryId,
      ok: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    });
    if (reason !== undefined) {
      reply(ws, joinRef, ref, topic, "error", { reason });
      return;
    }
    ws.data.channels.set(topic, joinRef);
    reply(ws, joinRef, ref, topic, "ok", {});
  }

  function handlePush(
    ws: ServerWebSocket<SocketData>,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    payload: unknown,
  ): void {
    const trajectoryId = topic.slice("trajectory:".length);
    const events =
      isMap(payload) && Array.isArray(payload.events)
        ? payload.events.length
        : 0;
    const dropped =
      isMap(payload) && typeof payload.dropped === "number"
        ? payload.dropped
        : 0;
    gateway.batches.push({
      trajectoryId,
      count: events,
      bytes: byteLength(payload),
      dropped,
    });

    const forced = pushReplies.shift();
    const answer = forced
      ? {
          status: "error" as const,
          response: refuse(forced.reason, forced.retryable),
        }
      : acceptBatch(trajectoryId, payload);
    const stops =
      answer.status === "error" &&
      (answer.response as { reason: string }).reason === NOT_ENABLED;
    const deliver = () => {
      reply(ws, joinRef, ref, topic, answer.status, answer.response);
      if (stops) closeChannel(ws, topic);
    };
    if (ackDelayMs > 0) {
      const delay = ackDelayMs;
      ackDelayMs = 0;
      const timer = setTimeout(() => {
        timers.delete(timer);
        deliver();
      }, delay);
      timers.add(timer);
    } else {
      deliver();
    }
  }

  const envelope = (status: number, code: string, message: string): Response =>
    Response.json(
      { error: { code, message, category: "unknown", retryable: false } },
      { status },
    );

  async function joinRoute(request: Request): Promise<Response> {
    if (routeRefusal && Date.now() < routeRefusal.until) {
      return envelope(
        routeRefusal.status,
        routeRefusal.code,
        routeRefusal.message,
      );
    }
    const body: unknown = await request.json().catch(() => null);
    const allowed = new Set([
      "trajectoryId",
      "appUserId",
      "learningContainerIds",
    ]);
    const containers = isMap(body) ? body.learningContainerIds : undefined;
    const valid =
      isMap(body) &&
      Object.keys(body).every((key) => allowed.has(key)) &&
      typeof body.trajectoryId === "string" &&
      UUID.test(body.trajectoryId) &&
      typeof body.appUserId === "string" &&
      body.appUserId.trim().length >= 1 &&
      body.appUserId.trim().length <= 255 &&
      (containers === undefined ||
        (Array.isArray(containers) &&
          containers.length <= 100 &&
          containers.every((id) => typeof id === "string")));
    if (!valid)
      return envelope(400, "VALIDATION_ERROR", "The request is not valid.");
    const trajectoryId = body.trajectoryId as string;
    gateway.memberships.push({
      trajectoryId,
      learningContainerIds: (containers as string[] | undefined) ?? [],
    });
    const joinToken = gateway.mintToken(
      trajectoryId,
      (body.appUserId as string).trim(),
    );
    return Response.json({ joinToken, trajectoryId });
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/client/websocket") {
        if (refuseSocket) {
          refuseSocket = false;
          return new Response("forbidden", { status: 403 });
        }
        const token = url.searchParams.get("join_token") ?? "";
        const claims = tokens.get(token);
        tokens.delete(token); // one use, even when expired
        if (!claims || Date.now() > claims.expiresAt)
          return new Response("forbidden", { status: 403 });
        const upgraded = bunServer.upgrade(request, {
          data: {
            claims: {
              trajectoryId: claims.trajectoryId,
              appUserId: claims.appUserId,
            },
            channels: new Map(),
          },
        });
        return upgraded
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (request.method === "POST" && url.pathname === JOIN_PATH)
        return joinRoute(request);
      const extra = await options.extraRoutes?.(request);
      if (extra) return extra;
      return Response.json(
        { error: { code: "ROUTE_NOT_FOUND" } },
        { status: 404 },
      );
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, message) {
        let frame: unknown;
        try {
          if (typeof message !== "string")
            throw new SyntaxError("binary frame");
          frame = strictDecode(message);
        } catch {
          gateway.undecodable += 1;
          ws.terminate();
          return;
        }
        handleFrame(ws, frame);
      },
    },
  });

  gateway.httpUrl = `http://127.0.0.1:${server.port}`;
  gateway.url = `ws://127.0.0.1:${server.port}`;
  return gateway;
}
