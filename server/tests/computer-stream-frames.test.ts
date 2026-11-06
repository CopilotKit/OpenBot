import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { reservePort } from "../../tests/support/reserved-port";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { ComputerGateway } from "../src/computer/gateway";
import type { DeploymentConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";

/**
 * The live screen's frames through this server, to a browser that cannot keep up.
 *
 * The proxy lets a frame go rather than queue it while the browser is still receiving the ones before it, so the
 * person watches the page as it is and not a backlog. It used to drop that frame outright, and the frame that arrives
 * while the browser is busy is often the last one the page makes: Chrome sends nothing more for a page that has gone
 * still, so the screen stayed on the page as it was before, for as long as the page stayed still. Real sockets here,
 * end to end, with a browser whose reading is paused the way a slow connection pauses it.
 */

type Upstream = {
  port: number;
  /** The computer's end of the one stream the proxy opens, once it has. */
  opened: Promise<{ send(message: string): void }>;
  /** What the proxy sent the computer, oldest first. */
  heard: string[];
  stop(): void;
};

/** The computer: a socket that sends whatever the test hands it. */
function computer(): Upstream {
  let resolve: (ws: { send(message: string): void }) => void = () => {};
  const heard: string[] = [];
  const opened = new Promise<{ send(message: string): void }>((done) => {
    resolve = done;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return undefined;
      return new Response("computer", { status: 400 });
    },
    websocket: {
      open(ws) {
        resolve(ws);
      },
      message(_ws, message) {
        heard.push(String(message));
      },
    },
  });
  return {
    port: server.port ?? 0,
    opened,
    heard,
    stop: () => server.stop(true),
  };
}

/** A browser on a raw socket, so its reading can be paused as a slow connection's is. */
async function browser(port: number, path: string) {
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const messages: string[] = [];
  let upgraded: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    upgraded = resolve;
  });
  let pending: Buffer = Buffer.alloc(0);
  let isOpen = false;
  socket.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (!isOpen) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = pending.subarray(0, end).toString();
      if (!head.startsWith("HTTP/1.1 101"))
        throw new Error(`Not upgraded: ${head}`);
      pending = pending.subarray(end + 4);
      isOpen = true;
      upgraded();
    }
    // Messages from a server are unmasked, and Bun sends each as one frame.
    for (;;) {
      if (pending.length < 2) return;
      const opcode = (pending[0] ?? 0) & 0x0f;
      let length = (pending[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + length) return;
      if (opcode === 1)
        messages.push(pending.subarray(offset, offset + length).toString());
      pending = pending.subarray(offset + length);
    }
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await open;
  /** A text message to the server, masked as every message from a client must be. */
  const send = (text: string) => {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const head =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([
            0x81,
            0x80 | 126,
            payload.length >> 8,
            payload.length & 0xff,
          ]);
    const masked = Buffer.from(
      payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)),
    );
    socket.write(Buffer.concat([head, mask, masked]));
  };
  return { socket, messages, send };
}

/** A frame as the computer sends one, about a megabyte, named so the test can tell which arrived. */
const frame = (name: string, size = 1024 * 1024) =>
  JSON.stringify({
    type: "frame",
    data: "A".repeat(size),
    width: 1280,
    height: 800,
    name,
  });

const nameOf = (message: string) =>
  (JSON.parse(message) as { name?: string }).name;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function proxy(upstream: Upstream) {
  const port = await reservePort();
  const server = startHttpServer({
    port,
    config: { computer: {} } as unknown as DeploymentConfig,
    resolveRequestActor: async () => ({ id: "ada", name: "Ada", role: "user" }),
    agentProfileStore: {
      get: async () => ({ visibility: "public", ownerUserId: null }),
    } as unknown as AgentProfileStore,
    computerGateway: {
      seatFor: async (botId: string) => ({ botId }),
      locate: async () => `http://127.0.0.1:${upstream.port}`,
      addressOf: (seat: { botId: string }) => seat,
      tokenFor: () => "stream-frames-token",
    } as unknown as ComputerGateway,
    app: { fetch: () => new Response("Not found.", { status: 404 }) },
  });
  cleanup.push(() => Promise.race([server.stop(true), Bun.sleep(2_000)]));
  return port;
}

/** Until nothing new has arrived for `quietMs`. */
async function settled(messages: string[], quietMs = 1_000) {
  const deadline = Date.now() + 20_000;
  let seen = -1;
  while (seen !== messages.length && Date.now() < deadline) {
    seen = messages.length;
    await Bun.sleep(quietMs);
  }
}

describe("frames to a browser that cannot keep up", () => {
  test("the newest one still arrives once the browser catches up, and the backlog does not", async () => {
    const upstream = computer();
    cleanup.push(() => upstream.stop());
    const port = await proxy(upstream);
    const { socket, messages } = await browser(
      port,
      "/api/computers/general-assistant/stream",
    );
    cleanup.push(() => socket.destroy());
    // Not reading: the connection fills, and then the proxy's own buffer.
    socket.pause();
    const computerEnd = await upstream.opened;

    // A few at a time: forty megabytes sent in one go would pass the fake computer's own 16 MB limit, and Bun drops
    // whatever a socket is sent past that, so the proxy would never see most of them.
    const SENT = 40;
    for (let i = 0; i < SENT; i += 1) {
      computerEnd.send(frame(String(i)));
      await Bun.sleep(10);
    }
    await Bun.sleep(300);
    // The page's last change, sent while the browser is still behind.
    computerEnd.send(frame("last", 1024));
    // Anything that is not a frame is never held: the person has to read an error.
    computerEnd.send(JSON.stringify({ type: "error", error: "Said at once." }));
    await Bun.sleep(300);

    socket.resume();
    await settled(messages);

    const frames = messages.filter((message) =>
      message.startsWith('{"type":"frame"'),
    );
    // The page as it is now, not as it was.
    expect(nameOf(frames.at(-1) ?? "{}")).toBe("last");
    // And frames it had no room for were let go, not queued behind each other.
    expect(frames.length).toBeLessThan(SENT);
    expect(messages).toContain(
      JSON.stringify({ type: "error", error: "Said at once." }),
    );
  }, 30_000);

  test("a screen that has never confirmed a frame is not confirmed for, and one that does is confirmed for exactly", async () => {
    // A screen loaded before confirmations existed never sends one. Told of a let-go frame on its behalf, a computer
    // that counts started counting frames that screen would never confirm, and paced it to one every two seconds.
    const upstream = computer();
    cleanup.push(() => upstream.stop());
    const port = await proxy(upstream);
    const { socket, messages, send } = await browser(
      port,
      "/api/computers/general-assistant/stream",
    );
    cleanup.push(() => socket.destroy());
    socket.pause();
    const computerEnd = await upstream.opened;
    computerEnd.send(JSON.stringify({ type: "hello", confirmFrames: true }));

    // A few at a time: twenty megabytes sent in one go would pass the fake computer's own 16 MB limit, and Bun drops
    // whatever a socket is sent past that.
    const SENT = 20;
    for (let i = 0; i < SENT; i += 1) {
      computerEnd.send(frame(String(i)));
      await Bun.sleep(10);
    }
    await Bun.sleep(300);
    const RECEIVED = '{"type":"frame-received"}';
    expect(upstream.heard.filter((said) => said === RECEIVED)).toEqual([]);

    // Now a screen that confirms each frame as it arrives: every frame the computer sent is accounted for once, the
    // ones it received by the screen and the ones let go by the proxy, so the computer's count comes out exact.
    socket.resume();
    let confirmed = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const frames = messages.filter((message) =>
        message.startsWith('{"type":"frame"'),
      );
      for (; confirmed < frames.length; confirmed += 1) send(RECEIVED);
      if (
        confirmed > 0 &&
        upstream.heard.filter((said) => said === RECEIVED).length === SENT
      )
        break;
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    expect(confirmed).toBeLessThan(SENT);
    expect(upstream.heard.filter((said) => said === RECEIVED)).toHaveLength(
      SENT,
    );
  }, 30_000);
});
