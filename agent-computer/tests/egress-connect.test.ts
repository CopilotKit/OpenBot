import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { connectInTurn, connectOrder } from "../src/egress";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

async function listening(): Promise<number> {
  const server = createServer((socket) => socket.on("error", () => undefined));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function attempt(
  target: { host: string; port: number; addresses?: readonly string[] },
  timeoutMs: number,
): Promise<{ socket?: Socket; error?: Error }> {
  return new Promise((resolve) =>
    connectInTurn(
      target,
      (socket) => resolve({ socket }),
      (error) => resolve({ error }),
      timeoutMs,
    ),
  );
}

describe("the egress filter connects one checked address at a time", () => {
  test("IPv4 addresses are tried before IPv6, each in DNS order", () => {
    expect(
      connectOrder([
        "2606:4700::1",
        "104.18.32.47",
        "2606:4700::2",
        "172.64.155.209",
      ]),
    ).toEqual([
      "104.18.32.47",
      "172.64.155.209",
      "2606:4700::1",
      "2606:4700::2",
    ]);
  });

  test("an address that refuses is passed over for the next checked one", async () => {
    const port = await listening();
    // 127.0.0.2 has nothing listening on this port in a loopback /8, so it refuses or fails fast.
    const { socket, error } = await attempt(
      { host: "site.test", port, addresses: ["127.0.0.2", "127.0.0.1"] },
      1_000,
    );
    expect(error).toBeUndefined();
    expect(socket?.remoteAddress).toBe("127.0.0.1");
    socket?.destroy();
  });

  test("an address that never answers is given up on after the attempt timeout", async () => {
    const port = await listening();
    const started = Date.now();
    // A non-routable address: depending on the host it hangs or fails at once. Either way the next
    // checked address must be reached, and within the timeout rather than the OS connect timeout.
    const { socket, error } = await attempt(
      { host: "site.test", port, addresses: ["10.255.255.1", "127.0.0.1"] },
      300,
    );
    expect(error).toBeUndefined();
    expect(socket?.remoteAddress).toBe("127.0.0.1");
    expect(Date.now() - started).toBeLessThan(3_000);
    socket?.destroy();
  });

  test("when every address fails, the caller is told once", async () => {
    let errors = 0;
    const error = await new Promise<Error>((resolve) =>
      connectInTurn(
        { host: "site.test", port: 1, addresses: ["127.0.0.2", "127.0.0.3"] },
        () => {
          throw new Error("must not connect");
        },
        (e) => {
          errors += 1;
          resolve(e);
        },
        300,
      ),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(error).toBeInstanceOf(Error);
    expect(errors).toBe(1);
  });

  test("a literal address with no checked list connects directly", async () => {
    const port = await listening();
    const { socket, error } = await attempt({ host: "127.0.0.1", port }, 1_000);
    expect(error).toBeUndefined();
    expect(socket?.remoteAddress).toBe("127.0.0.1");
    socket?.destroy();
  });
});
