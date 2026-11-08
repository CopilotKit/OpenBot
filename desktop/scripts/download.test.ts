/**
 * download.sh, the way the desktop scripts download from GitHub, run against a server on
 * 127.0.0.1 that stalls the way GitHub's archive for a commit did on 2026-11-08: it took the
 * request and sent nothing, and local-build.sh's plain `curl` waited until it was killed by hand.
 * A stalled attempt is given up after the stall window and tried again.
 *
 * Needs bash and curl, so it runs wherever the desktop scripts' tests do.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "download.sh");

/** What one connection gets: the whole body, half of it and then silence, or nothing at all. */
type Reply = "whole" | "stall part way" | "stall before answering";

const servers: Server[] = [];
const held: Socket[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const socket of held.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A server answering its connections with `replies` in order, repeating the last, counting them. */
async function scripted(replies: Reply[]) {
  let connections = 0;
  const server = createServer((socket) => {
    const reply = replies[Math.min(connections, replies.length - 1)];
    connections += 1;
    socket.once("data", () => {
      if (reply === "stall before answering") {
        held.push(socket);
        return;
      }
      const head =
        "HTTP/1.1 200 OK\r\ncontent-length: 8\r\nconnection: close\r\n\r\n";
      if (reply === "stall part way") {
        socket.write(`${head}data`);
        held.push(socket);
        return;
      }
      socket.end(`${head}datadata`);
    });
  });
  servers.push(server);
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/archive.tar.gz`,
    connections: () => connections,
  };
}

/**
 * `download -o <file> <url>` from download.sh, with a one-second stall window. Asynchronously: the
 * server answers on this process's event loop, which a synchronous spawn would hold shut.
 */
async function download(url: string, retries: string) {
  const dir = mkdtempSync(join(tmpdir(), "download-"));
  temps.push(dir);
  const file = join(dir, "archive.tar.gz");
  const started = performance.now();
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      'set -euo pipefail; source "$1"; download -o "$2" "$3"',
      "download",
      helper,
      file,
      url,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DOWNLOAD_STALL_SECONDS: "1",
        DOWNLOAD_RETRIES: retries,
      },
    },
  );
  const [stderr, status] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    status,
    stderr,
    seconds: (performance.now() - started) / 1000,
    body: () => readFileSync(file, "utf8"),
  };
}

test("a download that stalls is given up after the stall window and tried until it arrives", async () => {
  const server = await scripted([
    "stall before answering",
    "stall part way",
    "whole",
  ]);
  const result = await download(server.url, "5");
  expect(result.stderr).toContain("Operation too slow");
  expect(result.status).toBe(0);
  expect(result.body()).toBe("datadata");
  expect(server.connections()).toBe(3);
  // Two stalls of a second each and curl's waits of 1 s and 2 s, not a hang.
  expect(result.seconds).toBeLessThan(15);
}, 30_000);

test("a download that stalls every time is given up after its retries", async () => {
  const server = await scripted(["stall part way"]);
  const result = await download(server.url, "1");
  // curl's "Operation timed out" exit.
  expect(result.status).toBe(28);
  expect(server.connections()).toBe(2);
  expect(result.seconds).toBeLessThan(15);
}, 30_000);
