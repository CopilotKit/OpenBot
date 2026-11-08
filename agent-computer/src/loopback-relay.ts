/**
 * This machine's loopback addresses, carried into the computer's container.
 *
 * WHY. The Recorder reaches OpenBot only at an https address or at a loopback one (`normaliseOpenBotOrigin`), so on a
 * laptop it is handed `http://127.0.0.1:<port>`, the address the person's own window uses, and the Intelligence gateway
 * at `ws://localhost:<port>` where Intelligence runs on the laptop too. A browser in this container that is handed
 * those addresses reaches the container, where nothing answers: OpenBot is another container and Intelligence is on the
 * host. Record in any browser here (a person's own, or a Bot's) would connect and then send nothing anywhere.
 *
 * WHAT. `COMPUTER_LOOPBACK_RELAYS` names each such port and where this container reaches it, `<port>=<host>:<port>`,
 * comma-separated (OpenBot Desktop: its app's and server's ports to `server:3001`, a local gateway's to
 * `host.docker.internal`). Each is listened on at this container's loopback alone and piped, byte for byte, to its
 * target. Unset, nothing listens: a deployment whose OpenBot has a public address needs none of this.
 *
 * Every Bot here can reach the same targets by name already (the server is on the Compose network, and the host is
 * this person's own machine in the personal edition, the one place this is set), so a relay opens no new destination.
 */
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

export const LOOPBACK_RELAYS_ENV = "COMPUTER_LOOPBACK_RELAYS";

export type LoopbackRelay = { port: number; host: string; targetPort: number };

function portOf(text: string, setting: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535)
    throw new Error(
      `${LOOPBACK_RELAYS_ENV}: "${setting}" names no port. Write each as <port>=<host>:<port>, comma-separated.`,
    );
  return port;
}

/** The relays a setting names, in its order. Throws, naming the entry, for one that is not `<port>=<host>:<port>`. */
export function parseLoopbackRelays(
  value: string | undefined,
): LoopbackRelay[] {
  const relays: LoopbackRelay[] = [];
  for (const raw of (value ?? "").split(",")) {
    const setting = raw.trim();
    if (!setting) continue;
    const match = /^(\d+)=([^\s:=]+):(\d+)$/.exec(setting);
    if (!match)
      throw new Error(
        `${LOOPBACK_RELAYS_ENV}: "${setting}" is not <port>=<host>:<port>. Write each that way, comma-separated.`,
      );
    const [, port = "", host = "", targetPort = ""] = match;
    const relay = {
      port: portOf(port, setting),
      host,
      targetPort: portOf(targetPort, setting),
    };
    if (relays.some((each) => each.port === relay.port))
      throw new Error(
        `${LOOPBACK_RELAYS_ENV}: port ${relay.port} is named twice. Give each port one target.`,
      );
    relays.push(relay);
  }
  return relays;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Starts each relay on 127.0.0.1, and on [::1] where this container has IPv6 (`localhost` may resolve to either). A
 * port that cannot be listened on at 127.0.0.1 throws: the computer would otherwise start with Record quietly broken.
 * A target that does not answer closes that one connection, as the address itself would have.
 */
export async function startLoopbackRelays(
  relays: readonly LoopbackRelay[],
): Promise<{ close: () => Promise<void> }> {
  const servers: Server[] = [];
  /** Every connection being carried, so closing ends them rather than waiting on them. */
  const open = new Set<Socket>();
  for (const relay of relays) {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer((inbound) => {
        const outbound = createConnection({
          host: relay.host,
          port: relay.targetPort,
        });
        open.add(inbound).add(outbound);
        const end = () => {
          inbound.destroy();
          outbound.destroy();
          open.delete(inbound);
          open.delete(outbound);
        };
        inbound.on("error", end).on("close", end);
        outbound.on("error", end).on("close", end);
        inbound.pipe(outbound);
        outbound.pipe(inbound);
      });
      try {
        await listen(server, relay.port, host);
        servers.push(server);
      } catch (error) {
        if (host === "127.0.0.1") {
          await Promise.all(servers.map(closeServer));
          throw new Error(
            `${LOOPBACK_RELAYS_ENV}: could not listen on 127.0.0.1:${relay.port}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    console.info(
      JSON.stringify({
        type: "computer-loopback-relay",
        port: relay.port,
        to: `${relay.host}:${relay.targetPort}`,
      }),
    );
  }
  return {
    close: async () => {
      const closed = Promise.all(servers.map(closeServer));
      for (const socket of open) socket.destroy();
      await closed;
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
