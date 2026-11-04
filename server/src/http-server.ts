import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { serve } from "bun";
import { computerAccessCheck } from "./agents/computer-access";
import type { AgentProfileStore } from "./agents/profile-store";
import type { OpenBotRole } from "./auth/roles";
import { botBrowserRequestSeconds } from "./browser/bot-browser";
import { browserRequestSeconds } from "./browser/routes";
import { websocket as channelSocket } from "./channels/socket";
import type { ComputerGateway } from "./computer/gateway";
import { streamPathBotId } from "./computer/stream-path";
import type { DeploymentConfig } from "./config";
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
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

/** How every screencast frame from the computer starts: `JSON.stringify({ type: "frame", ... })`. */
const FRAME_PREFIX = '{"type":"frame"';

/** How much may sit unsent to a person's browser before a new frame is dropped: about one frame. */
const STREAM_BUFFER_LIMIT = 128 * 1024;

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
  ) =>
    // The Bot travels in the query, because a websocket upgrade carries no custom header for the
    // computer to read and every call it serves is per Bot. So does the person, on the one computer
    // many people share, where the seat is the pair. The secret travels the same way and for the
    // same reason, this socket is the one a person can type into, so it is the last thing that should
    // be reachable without it. The secret of that computer, which on a computer of one person's own
    // is its own token and never the deployment's (computer/computer-token.ts).
    `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(seat.botId)}${seat.personId ? `&person=${encodeURIComponent(seat.personId)}` : ""}&token=${encodeURIComponent(token ?? "")}`;

  const trusted = trustedOrigin(config);

  const isProxiedStream = (data: SocketData): data is StreamData =>
    typeof (data as StreamData).upstream === "string";

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
      const streamBotId = streamPathBotId(url.pathname);
      if (
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
        if (!isProxiedStream(ws.data)) {
          channelSocket.open(asChannelSocket(ws));
          return;
        }
        const stream = ws.data;
        const inward = new WebSocket(stream.upstream);
        stream.inward = inward;
        // Frames outward, input inward. A frame the browser is too slow for is dropped, not queued,
        // because a stale frame is worse than a missing one. Bun queues whatever `send` cannot write
        // yet, so the drop has to be decided here: while the frames before it are still going out, a
        // new one is let go and the next one Chrome sends, the page as it is by then, takes its place.
        // Anything that is not a frame, such as an error the person has to read, always goes.
        inward.onmessage = (event) => {
          const message = String(event.data);
          if (
            message.startsWith(FRAME_PREFIX) &&
            ws.getBufferedAmount() > STREAM_BUFFER_LIMIT
          )
            return;
          try {
            ws.send(message);
          } catch {
            inward.close();
          }
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
      },
      message(ws, raw) {
        if (!isProxiedStream(ws.data)) {
          channelSocket.message(asChannelSocket(ws), raw);
          return;
        }
        if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
      },
      close(ws, code, reason) {
        if (!isProxiedStream(ws.data)) {
          channelSocket.close(asChannelSocket(ws), code, reason);
          return;
        }
        ws.data.inward?.close();
      },
    },
  });
}
