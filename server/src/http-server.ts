import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { serve } from "bun";
import { computerAccessCheck } from "./agents/computer-access";
import type { AgentProfileStore } from "./agents/profile-store";
import type { OpenBotRole } from "./auth/roles";
import { botBrowserRequestSeconds } from "./browser/bot-browser";
import { browserRequestSeconds } from "./browser/routes";
import { websocket as channelSocket } from "./channels/socket";
import type { ComputerGateway } from "./computer/gateway";
import { computerSocketPath } from "./computer/stream-path";
import type { DeploymentConfig } from "./config";
import {
  closeGatewaySocket,
  type GatewaySocketData,
  gatewayClientSocketUrl,
  gatewaySocketMessage,
  isIntelligenceClientSocketPath,
  openGatewaySocket,
} from "./intelligence-gateway-proxy";
import {
  CROSS_SITE_REFUSAL,
  crossSiteRequest,
  type FrontDoorBindings,
  isWebSocketUpgrade,
  type NetworkCaller,
  singleUserRefusal,
  trustedOrigin,
} from "./request-trust";

/**
 * The server's front door: one Bun server that hands ordinary requests to the Hono app, proxies the
 * computer's live stream, and carries channel activity over websockets.
 *
 * Moved out of index.ts verbatim, with what it reads passed in.
 */

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  inward?: WebSocket;
  /** Input that arrived before the socket to the computer had opened, sent once it does. */
  early?: string[];
  /** The computer counts the frames the screen confirms (it said so in its hello). */
  confirms?: boolean;
  /** The person's screen has confirmed a frame, so it confirms every frame it receives. */
  viewerConfirms?: boolean;
  /** Frames let go before the screen had confirmed one, not yet said to the computer. See `frameLetGo`. */
  unsaidConfirms?: number;
  /** The newest frame not sent yet, because the browser was still receiving the ones before it. */
  heldFrame?: string;
  /** Looks again for room for `heldFrame`; see `sendHeldFrame`. */
  heldRetry?: ReturnType<typeof setTimeout>;
};

/**
 * How much a proxied socket may hold for a person who is not reading it, before it is closed.
 *
 * The terminal's own flow control (agent-computer/src/live-shell.ts) keeps what is in flight far
 * below this. A socket past it is a browser that has stopped reading, and closing it costs that
 * viewer a reconnect, which redraws its terminal from the computer's copy of the screen.
 */
const MAX_PROXY_BUFFER = 8 * 1024 * 1024;

/** Whether a proxied socket is a Bot's terminal rather than its live screen, from where it goes. */
function isTerminalUpstream(upstream: string): boolean {
  try {
    return new URL(upstream).pathname.endsWith("/terminal");
  } catch {
    return false;
  }
}

/**
 * Carry a terminal's frames outward as they came: its output binary, its control messages text. The
 * terminal's own flow control keeps what is in flight small; a person's side holding more than
 * `MAX_PROXY_BUFFER` has stopped reading, and is closed so its terminal reconnects and is redrawn.
 */
function carryTerminal(
  ws: {
    send(data: string | Uint8Array): number;
    getBufferedAmount(): number;
    close(): void;
  },
  inward: WebSocket,
): void {
  inward.binaryType = "arraybuffer";
  inward.onmessage = (event) => {
    try {
      const data = event.data;
      const sent = ws.send(
        typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
      );
      if (sent === 0 || ws.getBufferedAmount() > MAX_PROXY_BUFFER)
        throw new Error("The person's side has stopped reading.");
    } catch {
      inward.close();
      ws.close();
    }
  };
}

/**
 * Bun takes exactly one WebSocket handler for the server, and three features need one: the app
 * proxies the computer stream and the Intelligence gateway's client socket, and it pushes channel
 * activity through Hono's adapter. So this one dispatches on what the upgrade attached, a stream
 * carries `upstream`, a gateway socket `gatewayUpstream`, and a Hono socket neither, rather than any
 * feature quietly taking the slot and breaking the others on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | GatewaySocketData | ChannelSocket["data"];

/** How every screencast frame from the computer starts: `JSON.stringify({ type: "frame", ... })`. */
const FRAME_PREFIX = '{"type":"frame"';

/** What a person's screen sends as a frame reaches it; the proxy says it for a frame it let go. */
const FRAME_RECEIVED = '{"type":"frame-received"}';

/** How many inputs are held while the socket to the computer opens. A person, not a script, fills it. */
const EARLY_INPUT_LIMIT = 256;

/** How much may sit unsent to a person's browser before a new frame is held back: about one frame. */
const STREAM_BUFFER_LIMIT = 128 * 1024;

/** How often a held frame looks again for room, besides when Bun says the socket drained. */
const HELD_FRAME_RETRY_MS = 50;

type HeldFrameSocket = {
  data: StreamData;
  getBufferedAmount(): number;
  send(message: string): unknown;
};

/**
 * Send the frame held for this browser, once the frames ahead of it have gone.
 *
 * Held, not dropped. The frame that arrives while the browser is still receiving is often the last one
 * the page makes, and Chrome sends nothing more for a page that has gone still: dropped, the screen
 * stayed on the page as it was a moment before it stopped, for as long as it stayed still.
 *
 * Bun's `drain` is the quick way to hear there is room, and not the only one: a frame sent from inside
 * `drain` that did not fit was, about one time in twenty, followed by no further `drain` at all, and
 * the held frame waited for ever. So while one is held, the socket is also looked at again shortly.
 */
function sendHeldFrame(ws: HeldFrameSocket) {
  const held = ws.data.heldFrame;
  if (held === undefined) return;
  if (ws.getBufferedAmount() > STREAM_BUFFER_LIMIT) {
    ws.data.heldRetry ??= setTimeout(() => {
      ws.data.heldRetry = undefined;
      sendHeldFrame(ws);
    }, HELD_FRAME_RETRY_MS);
    return;
  }
  clearTimeout(ws.data.heldRetry);
  ws.data.heldRetry = undefined;
  ws.data.heldFrame = undefined;
  try {
    ws.send(held);
  } catch {
    ws.data.inward?.close();
  }
}

/**
 * A frame let go because a newer one replaced it while it was held, said as received to a computer
 * that counts the frames on their way, so it does not wait on one that is never coming.
 *
 * Only once the person's screen has itself confirmed a frame. The computer starts counting at the
 * first confirmation it hears, and a screen loaded before confirmations existed never sends one: told
 * of a let-go frame on its behalf, the computer counted frames that screen would never confirm and
 * fell to one frame every two seconds. Those let go before then are kept count of and said right
 * after the screen's first confirmation, so the computer's count still comes out exact.
 */
function frameLetGo(stream: StreamData) {
  if (!stream.confirms) return;
  if (!stream.viewerConfirms) {
    stream.unsaidConfirms = (stream.unsaidConfirms ?? 0) + 1;
    return;
  }
  if (stream.inward?.readyState === WebSocket.OPEN)
    stream.inward.send(FRAME_RECEIVED);
}

export function startHttpServer(deps: {
  port: number;
  config: DeploymentConfig;
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; name: string; role: OpenBotRole }>;
  agentProfileStore: AgentProfileStore;
  computerGateway: ComputerGateway | undefined;
  app: {
    fetch: (
      request: Request,
      env: FrontDoorBindings,
    ) => Response | Promise<Response>;
  };
}): { stop(closeActiveConnections?: boolean): Promise<void> } {
  const {
    port,
    config,
    resolveRequestActor,
    agentProfileStore,
    computerGateway,
    app,
  } = deps;

  /**
   * The live screen, proxied.
   *
   * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
   * shared token, not with a person's session, and it must never be reachable from a browser. So the
   * socket terminates here, behind the same session guard as every other route, and this process opens
   * a second socket inward carrying the token.
   *
   * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
   * body, so it is handled in `fetch` ahead of the app.
   */
  const toStreamUrl = (
    baseUrl: string,
    seat: { botId: string; personId?: string },
    token: string | undefined,
    socket: "stream" | "terminal" = "stream",
  ) =>
    // The Bot travels in the query, because a websocket upgrade carries no custom header for the
    // computer to read and every call it serves is per Bot. So does the person, on the one computer
    // many people share, where the seat is the pair. The secret travels the same way and for the
    // same reason, this socket is the one a person can type into, so it is the last thing that should
    // be reachable without it. The secret of that computer, which on a computer of one person's own
    // is its own token and never the deployment's (computer/computer-token.ts).
    `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/${socket}?bot=${encodeURIComponent(seat.botId)}${seat.personId ? `&person=${encodeURIComponent(seat.personId)}` : ""}&token=${encodeURIComponent(token ?? "")}`;

  const trusted = trustedOrigin(config);

  const isProxiedStream = (data: SocketData): data is StreamData =>
    typeof (data as StreamData).upstream === "string";

  const isGatewaySocket = (data: SocketData): data is GatewaySocketData =>
    typeof (data as GatewaySocketData).gatewayUpstream === "string";

  const intelligence = config.runtime?.intelligence;

  // Hono owns the socket's data once it has upgraded it; this hands its own back to it.
  const asChannelSocket = (ws: { data: SocketData }) =>
    ws as unknown as ChannelSocket;

  // Answered so a test can stop the server it started; the deployment keeps it for its whole life.
  return serve<SocketData>({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      /*
       * The connection this came on, read here because only the server that accepted it can say. Handed
       * to the app as a binding and never on the request: see `callerOf`.
       */
      const caller: NetworkCaller = {
        address: server.requestIP(request)?.address ?? null,
      };
      /*
       * Every socket, before anything answers it: the live screen below, the channel events Hono
       * upgrades, and whatever upgrades next. A browser lets any page open a socket to any address,
       * with the person's cookies, and leaves it to the server to look at `Origin`.
       */
      if (
        isWebSocketUpgrade(request.headers) &&
        crossSiteRequest(request, trusted)
      ) {
        return Response.json({ error: CROSS_SITE_REFUSAL }, { status: 403 });
      }
      if (url.pathname === "/api/audio/transcriptions") {
        server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
      }
      if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
      if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
      // The person's browser's routes wait on its computer for longer than Bun's 10 s: a cold open, a slow page. Kept
      // open for each route's own budget, so its answer, or its sentence, reaches the person (browser/routes.ts). A
      // Bot's browser's routes the same, for a start, a Stop waiting on the last of a recording, a slow page
      // (browser/bot-browser.ts).
      const browserSeconds =
        browserRequestSeconds(url.pathname) ??
        botBrowserRequestSeconds(url.pathname);
      if (browserSeconds !== undefined) server.timeout(request, browserSeconds);
      /*
       * The Intelligence gateway's client socket, when this server carries it
       * (intelligence-gateway-proxy.ts). Behind the same doors as the live screen: a single-user
       * deployment admits only who it admits, and a socket needs a session, applied here by hand
       * because middleware does not run on an upgrade. The gateway then checks the join token itself.
       */
      if (
        intelligence?.gatewayProxy &&
        isIntelligenceClientSocketPath(url.pathname) &&
        isWebSocketUpgrade(request.headers)
      ) {
        const notHere = config.singleUser
          ? singleUserRefusal(request, caller, config.singleUserAccess)
          : null;
        if (notHere) return new Response(notHere, { status: 403 });
        const actor = await resolveRequestActor(request).catch(() => null);
        if (!actor) return new Response("Sign in first.", { status: 401 });
        const data: GatewaySocketData = {
          gatewayUpstream: gatewayClientSocketUrl(
            intelligence.gatewayWsUrl,
            url,
          ),
          pending: [],
        };
        if (server.upgrade(request, { data })) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      /*
       * The live screen and the terminal (the Bot's live shell). The same doors for both: whoever may
       * watch a Bot's screen may watch its terminal, and typing into either is the computer's own
       * question, asked of the wheel.
       */
      const named = computerSocketPath(url.pathname);
      const streamBotId = named?.botId ?? null;
      if (
        named &&
        streamBotId !== null &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (!config.computer) {
          return new Response("No computer is configured.", { status: 503 });
        }
        // On a single-user OpenBot the guard below admits everybody, so first: is this somebody it may admit.
        const notHere = config.singleUser
          ? singleUserRefusal(request, caller, config.singleUserAccess)
          : null;
        if (notHere) return new Response(notHere, { status: 403 });
        // The session guard, applied by hand because middleware does not run on an upgrade. An
        // unauthenticated socket here would be the whole point of the proxy defeated.
        const actor = await resolveRequestActor(request).catch(() => null);
        if (!actor) {
          return new Response("Sign in first.", { status: 401 });
        }
        // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
        // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
        // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser. A person's
        // own OpenBot browser is that person's alone, an administrator's neither: the same check says so.
        if (
          !(await computerAccessCheck(agentProfileStore)(
            { id: actor.id, role: actor.role },
            streamBotId,
          ))
        ) {
          return new Response("There is no such Bot.", { status: 404 });
        }
        /*
         * Through the gateway, not the provider.
         *
         * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
         * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
         * host was handed the deployment's computer token, which is the case that check was written
         * for. Every acting path already went through the gateway; this one did not.
         */
        let upstream: string;
        try {
          // The watcher's own seat on that Bot: their computer, or the Bot's own if it is isolated.
          const seat = computerGateway
            ? await computerGateway.seatFor(streamBotId, actor.id)
            : undefined;
          const streamBase =
            computerGateway && seat
              ? await computerGateway.locate(seat)
              : undefined;
          if (!streamBase || !computerGateway || !seat) {
            return new Response("No computer address is configured.", {
              status: 503,
            });
          }
          upstream = toStreamUrl(
            streamBase,
            computerGateway.addressOf(seat),
            computerGateway.tokenFor(seat),
            named.socket,
          );
        } catch (error) {
          // Said out loud rather than falling back to another Bot's computer, which is the failure this
          // whole path exists to prevent.
          return new Response(
            error instanceof Error
              ? error.message
              : "That Bot's computer could not be reached.",
            { status: 502 },
          );
        }
        if (server.upgrade(request, { data: { upstream } })) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return app.fetch(request, { server, caller });
    },
    websocket: {
      open(ws) {
        if (isGatewaySocket(ws.data)) {
          openGatewaySocket(ws as typeof ws & { data: GatewaySocketData });
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.open(asChannelSocket(ws));
          return;
        }
        const stream = ws.data;
        const inward = new WebSocket(stream.upstream);
        stream.inward = inward;
        // Frames outward, input inward. A frame the browser is too slow for is not queued, because a
        // stale frame is worse than a late one. Bun queues whatever `send` cannot write yet, so that is
        // decided here: while the frames before it are still going out, a new one is held, a newer one
        // replaces it, and the newest goes when there is room (`drain` below). Anything that is not a
        // frame, such as an error the person has to read, always goes at once.
        inward.onmessage = (event) => {
          const message = String(event.data);
          // Only a computer that said it counts confirmations is sent one for a frame let go.
          if (message.startsWith('{"type":"hello"'))
            stream.confirms = message.includes('"confirmFrames":true');
          if (message.startsWith(FRAME_PREFIX)) {
            if (stream.heldFrame !== undefined) frameLetGo(stream);
            stream.heldFrame = message;
            sendHeldFrame(ws as typeof ws & { data: StreamData });
            return;
          }
          try {
            ws.send(message);
          } catch {
            inward.close();
          }
        };
        inward.onopen = () => {
          for (const message of stream.early ?? []) inward.send(message);
          stream.early = undefined;
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
        // The terminal's output is binary, and is carried as it came rather than as the screen's text.
        if (isTerminalUpstream(stream.upstream)) carryTerminal(ws, inward);
      },
      message(ws, raw) {
        if (isGatewaySocket(ws.data)) {
          gatewaySocketMessage(
            ws as typeof ws & { data: GatewaySocketData },
            raw,
          );
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.message(asChannelSocket(ws), raw);
          return;
        }
        const stream = ws.data;
        const inward = stream.inward;
        const message = String(raw);
        // A click made the moment the screen appeared used to be lost here, before the socket to the
        // computer had finished opening. Held until it has, in order, and only that long.
        if (inward?.readyState === WebSocket.CONNECTING) {
          stream.early ??= [];
          if (stream.early.length < EARLY_INPUT_LIMIT)
            stream.early.push(message);
          return;
        }
        if (inward?.readyState !== WebSocket.OPEN) return;
        inward.send(message);
        // The screen's first confirmation: the frames let go before it can be said now. See `frameLetGo`.
        if (message === FRAME_RECEIVED && !stream.viewerConfirms) {
          stream.viewerConfirms = true;
          for (let i = 0; i < (stream.unsaidConfirms ?? 0); i += 1)
            inward.send(FRAME_RECEIVED);
          stream.unsaidConfirms = undefined;
        }
      },
      /** Room to the browser again: the frame held while it was busy goes now. */
      drain(ws) {
        if (isProxiedStream(ws.data))
          sendHeldFrame(ws as typeof ws & { data: StreamData });
      },
      close(ws, code, reason) {
        if (isGatewaySocket(ws.data)) {
          closeGatewaySocket(
            ws as typeof ws & { data: GatewaySocketData },
            code,
            reason,
          );
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.close(asChannelSocket(ws), code, reason);
          return;
        }
        clearTimeout(ws.data.heldRetry);
        ws.data.heldFrame = undefined;
        ws.data.inward?.close();
      },
    },
  });
}
