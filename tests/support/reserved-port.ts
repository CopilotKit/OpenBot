import { connect, createServer, type Socket } from "node:net";

/**
 * A port on 127.0.0.1 that nothing listens on, that the kernel will not hand to anybody else for a
 * while, and that the server a test starts next can still bind by number.
 *
 * WHY NOT "LISTEN ON 0, READ THE PORT, CLOSE". That is how every test here used to choose a port
 * for a computer, a Bot or the app before starting it, and closing the probe puts the port straight
 * back in the pool. On Linux `bind(0)` picks at random from that pool, and the computer itself binds
 * two listeners on port 0 (its egress filter) a moment before it binds `PORT`, so now and then one
 * of them was given the very port the test had just chosen and the computer died with "Failed to
 * start server. Is port 38953 in use?". Run in parallel, it was worse than a failure: a test whose
 * computer lost the port went on talking to another test's computer that had won it.
 *
 * HOW. One connection is made to the port and the server's side of it closes first, so that side
 * waits out TIME_WAIT on this port: a minute on Linux, half that on macOS. Until it is over, neither
 * `bind(0)` nor an outgoing connection is given the port on either platform, and a server binding it
 * by number with SO_REUSEADDR, which Bun.serve and node:net set on every listener, binds it at once.
 * So the port stays held from the moment it is chosen until the server it was chosen for takes it,
 * without that server having to accept a port of 0, which the computer, the app and the Bots
 * deliberately refuse.
 *
 * Chosen by the kernel rather than fixed in the test, because a fixed number fails whenever anything
 * else on the machine holds it (41641, for one, is Tailscale's default). And a test that needs a
 * port nothing answers on can use one of these too: nothing listens on it, and nothing is given it.
 */
export async function reservePort(): Promise<number> {
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) =>
    server.once("connection", resolve),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The port reservation did not get a TCP port.");
  }
  const client = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const ours = await accepted;
  const closed = Promise.all(
    [client, ours].map(
      (socket) =>
        new Promise<void>((resolve) => socket.once("close", () => resolve())),
    ),
  );
  // The server's side ends first, so it is the side left in TIME_WAIT, on the reserved port.
  ours.end();
  await closed;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
