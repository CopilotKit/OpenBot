import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";
import {
  parseLoopbackRelays,
  startLoopbackRelays,
} from "../src/loopback-relay";

/**
 * A Recorder in the computer's container is handed OpenBot at `http://127.0.0.1:<port>` and a local Intelligence gateway
 * at `ws://localhost:<port>`: the person's own laptop's addresses, which inside the container are the container. Before
 * `COMPUTER_LOOPBACK_RELAYS`, nothing answered there, so Record in a browser on OpenBot Desktop's computer connected and
 * then reached nothing. These run the real relay and the real computer process over real sockets.
 */

/** Stands in for OpenBot (another container) or the gateway (the host): it answers HTTP and echoes a WebSocket. */
function target() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response(`openbot ${new URL(request.url).pathname}`);
    },
    websocket: {
      message(socket, message) {
        socket.send(`echo ${message}`);
      },
    },
  });
}

describe("which ports a setting relays", () => {
  test("each <port>=<host>:<port>, in order, and nothing for an unset or empty setting", () => {
    expect(
      parseLoopbackRelays(
        "3010=server:3001, 3001=server:3001,14401=host.docker.internal:14401",
      ),
    ).toEqual([
      { port: 3010, host: "server", targetPort: 3001 },
      { port: 3001, host: "server", targetPort: 3001 },
      { port: 14401, host: "host.docker.internal", targetPort: 14401 },
    ]);
    expect(parseLoopbackRelays(undefined)).toEqual([]);
    expect(parseLoopbackRelays(" , ")).toEqual([]);
  });

  test("refuses what it cannot read, naming the entry", () => {
    for (const setting of [
      "server:3001",
      "3010=server",
      "3010=http://server:3001",
      "0=server:3001",
      "3010=server:70000",
      "3010=server:3001,3010=other:3001",
    ])
      expect(() => parseLoopbackRelays(setting)).toThrow(
        "COMPUTER_LOOPBACK_RELAYS",
      );
  });
});

describe("a relay", () => {
  test("carries HTTP and a WebSocket from this machine's loopback to the target", async () => {
    const openbot = target();
    const port = await reservePort();
    const relays = await startLoopbackRelays([
      { port, host: "127.0.0.1", targetPort: Number(openbot.port) },
    ]);
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/api/recorder/info`);
      expect(await answer.text()).toBe("openbot /api/recorder/info");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
      const echoed = new Promise<string>((resolve, reject) => {
        socket.onmessage = (event) => resolve(String(event.data));
        socket.onerror = () => reject(new Error("the socket failed"));
      });
      await new Promise((resolve) => {
        socket.onopen = resolve;
      });
      socket.send("trajectory");
      expect(await echoed).toBe("echo trajectory");
      socket.close();
    } finally {
      await relays.close();
      openbot.stop(true);
    }
  });

  test("closes a connection whose target does not answer, and keeps listening", async () => {
    const nothing = await reservePort();
    const port = await reservePort();
    const relays = await startLoopbackRelays([
      { port, host: "127.0.0.1", targetPort: nothing },
    ]);
    try {
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      await relays.close();
    }
  });
});

describe("the computer started with COMPUTER_LOOPBACK_RELAYS", () => {
  const started: ReturnType<typeof Bun.spawn>[] = [];
  let root = "";
  afterAll(async () => {
    for (const child of started) {
      child.kill();
      await child.exited;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function computer(relays: string) {
    root ||= await mkdtemp(join(tmpdir(), "openbot-loopback-relay-"));
    const port = await reservePort();
    const child = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COMPUTER_TOKEN: "loopback-relay-token",
        PORT: String(port),
        COMPUTER_BROWSER_BACKEND: "managed",
        COMPUTER_BROWSER_MODE: "headless",
        EGRESS_POLICY_REQUIRED: "0",
        PROFILES_DIR: join(root, String(port), "profiles"),
        WORKSPACE_DIR: join(root, String(port), "workspace"),
        COMPUTER_LOOPBACK_RELAYS: relays,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    started.push(child);
    return { child, base: `http://127.0.0.1:${port}` };
  }

  test("relays from the moment it answers", async () => {
    const openbot = target();
    const relayed = await reservePort();
    try {
      const { child, base } = await computer(
        `${relayed}=127.0.0.1:${openbot.port}`,
      );
      const deadline = Date.now() + 15_000;
      while (
        !(await fetch(`${base}/health`)
          .then((response) => response.ok)
          .catch(() => false))
      ) {
        if (child.exitCode !== null)
          throw new Error(`The computer exited with ${child.exitCode}.`);
        if (Date.now() > deadline)
          throw new Error("The computer did not start.");
        await Bun.sleep(50);
      }
      expect(
        await (await fetch(`http://127.0.0.1:${relayed}/capture`)).text(),
      ).toBe("openbot /capture");
    } finally {
      openbot.stop(true);
    }
  }, 30_000);

  test("refuses to start on a setting it cannot read, and says which", async () => {
    const { child } = await computer("3010=server");
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr as ReadableStream).text()).toContain(
      'COMPUTER_LOOPBACK_RELAYS: "3010=server"',
    );
  }, 30_000);
});
