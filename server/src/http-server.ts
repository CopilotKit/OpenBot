import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { serve } from "bun";
import { computerAccessCheck } from "./agents/computer-access";
import type { AgentProfileStore } from "./agents/profile-store";
import type { OpenBotRole } from "./auth/roles";
import { websocket as channelSocket } from "./channels/socket";
import type { ComputerGateway } from "./computer/gateway";
import { streamPathBotId } from "./computer/stream-path";
import type { DeploymentConfig } from "./config";
import type { DemonstrationRecorder } from "./demonstrations/recording";
import type { DemonstrationStore } from "./demonstrations/store";

/**
 * The server's front door: one Bun server that hands ordinary requests to the Hono app, proxies the
 * computer's live stream, and carries channel activity over websockets.
 *
 * Moved out of index.ts verbatim, with what it reads passed in.
 */

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
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

export function startHttpServer(deps: {
  port: number;
  config: DeploymentConfig;
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; name: string; role: OpenBotRole }>;
  agentProfileStore: AgentProfileStore;
  computerGateway: ComputerGateway | undefined;
  demonstrationStore: DemonstrationStore;
  demonstrationRecorder: DemonstrationRecorder;
  app: {
    fetch: (
      request: Request,
      env: { server: unknown },
    ) => Response | Promise<Response>;
  };
}): void {
  const {
    port,
    config,
    resolveRequestActor,
    agentProfileStore,
    computerGateway,
    demonstrationStore,
    demonstrationRecorder,
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
  const toStreamUrl = (baseUrl: string, botId: string) =>
    // The Bot travels in the query, because a websocket upgrade carries no custom header for the
    // computer to read and every call it serves is per Bot. The secret travels the same way and for the
    // same reason, this socket is the one a person can type into, so it is the last thing that should
    // be reachable without it.
    `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

  const isProxiedStream = (data: SocketData): data is StreamData =>
    typeof (data as StreamData).upstream === "string";

  // Hono owns the socket's data once it has upgraded it; this hands its own back to it.
  const asChannelSocket = (ws: { data: SocketData }) =>
    ws as unknown as ChannelSocket;

  serve<SocketData>({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/audio/transcriptions") {
        server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
      }
      if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
      if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
      const streamBotId = streamPathBotId(url.pathname);
      if (
        streamBotId !== null &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (!config.computer) {
          return new Response("No computer is configured.", { status: 503 });
        }
        // The session guard, applied by hand because middleware does not run on an upgrade. An
        // unauthenticated socket here would be the whole point of the proxy defeated.
        const actor = await resolveRequestActor(request).catch(() => null);
        if (!actor) {
          return new Response("Sign in first.", { status: 401 });
        }
        // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
        // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
        // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
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
          const streamBase = computerGateway
            ? await computerGateway.locate(streamBotId)
            : undefined;
          if (!streamBase) {
            return new Response("No computer address is configured.", {
              status: 503,
            });
          }
          upstream = toStreamUrl(streamBase, streamBotId);
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
        const recording = await demonstrationStore.active(
          actor.id,
          streamBotId,
        );
        if (recording)
          upstream += `&recording=${encodeURIComponent(recording.id)}`;
        if (
          server.upgrade(request, {
            data: {
              upstream,
              ownerUserId: actor.id,
              botId: streamBotId,
              ...(recording ? { recordingId: recording.id } : {}),
            },
          })
        ) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return app.fetch(request, { server });
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
        // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
        // should be dropped, not queued, because a stale frame is worse than a missing one.
        inward.onmessage = (event) => {
          if (stream.recordingId) {
            let recorded: unknown;
            try {
              recorded = JSON.parse(String(event.data));
            } catch {
              recorded = null;
            }
            if (
              recorded &&
              typeof recorded === "object" &&
              "type" in recorded &&
              recorded.type === "demonstration.action"
            ) {
              const data = stream;
              const message = recorded as {
                recordingId?: unknown;
                action?: unknown;
              };
              if (message.recordingId !== data.recordingId) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error:
                      "The recording identity changed. Stop and restart recording.",
                  }),
                );
                return;
              }
              demonstrationRecorder
                .capture(
                  data.ownerUserId,
                  data.botId,
                  data.recordingId ?? "",
                  message.action,
                )
                .catch((error) => {
                  console.error(
                    JSON.stringify({
                      type: "demonstration-capture-error",
                      error:
                        error instanceof Error ? error.name : "UnknownError",
                      context: { recordingId: data.recordingId },
                      timestamp: new Date().toISOString(),
                    }),
                  );
                  try {
                    ws.send(
                      JSON.stringify({
                        type: "error",
                        error:
                          "A browser step could not be saved. Stop and review the demonstration before continuing.",
                      }),
                    );
                  } catch {
                    /* A closed viewer cannot receive the already logged failure. */
                  }
                });
              return;
            }
          }
          try {
            ws.send(String(event.data));
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
