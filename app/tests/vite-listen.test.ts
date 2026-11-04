import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/** This machine's private address on its network: a connection to it arrives as another machine's would. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry !== undefined &&
      !entry.internal &&
      entry.family === "IPv4" &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )?.address;

/*
 * The dev server, started in a process of its own, as `bun run dev` starts it: the real Vite on every
 * interface, as `serving` asks, with the app's own guard (`thisMachineOnly`) in front of it. Its own
 * process because this suite's preload installs a DOM, which is no place for a server.
 *
 * It asks itself for a page and for `/api/me` from each address over a raw socket, as any client
 * would, and prints the status line each got.
 */
const PROBE = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { thisMachineOnly } from "./vite.config.ts";

const environment = JSON.parse(process.env.PROBE_ENVIRONMENT ?? "{}");
// A page of its own to serve, so the server has nothing of the app's to scan before it answers.
const root = mkdtempSync(join(tmpdir(), "openbot-vite-listen-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>probe</title>");
const server = await createServer({
  configFile: false,
  root,
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  plugins: [thisMachineOnly(environment)],
  server: { host: "::", port: 0, hmr: false },
});
await server.listen();
const { port } = server.httpServer.address();

function ask(host, path) {
  const authority = host.includes(":") ? "[" + host + "]:" + port : host + ":" + port;
  return new Promise((resolve) => {
    let text = "";
    const socket = connect({ host, port }, () =>
      socket.write("GET " + path + " HTTP/1.1\\r\\nhost: " + authority + "\\r\\nconnection: close\\r\\n\\r\\n"),
    );
    socket.setTimeout(10000, () => { socket.destroy(); resolve(text); });
    // The head and as many bytes as it says is the whole answer: Vite keeps the socket open after it.
    socket.on("data", (chunk) => {
      text += chunk;
      const end = text.indexOf("\\r\\n\\r\\n");
      const length = /content-length:\\s*(\\d+)/i.exec(text.slice(0, end));
      if (end >= 0 && length && Buffer.byteLength(text.slice(end + 4)) >= Number(length[1])) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("end", () => resolve(text));
    socket.on("error", (error) => resolve("error " + error.message));
  });
}

const answers = {};
for (const host of ["127.0.0.1", "::1", process.env.LAN_ADDRESS])
  for (const path of ["/", "/api/me"]) {
    const text = await ask(host, path);
    answers[host + " " + path] = {
      status: Number(/^HTTP\\/1\\.1 (\\d{3})/.exec(text)?.[1] ?? 0),
      thisMachineOnly: text.includes("This OpenBot only answers on the computer it runs on."),
    };
  }
console.log("ANSWERS " + JSON.stringify(answers));
await server.close();
process.exit(0);
`;

async function probe(environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "-e", PROBE],
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      LAN_ADDRESS: lanAddress as string,
      PROBE_ENVIRONMENT: JSON.stringify(environment),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 50_000);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout.split("\n").find((text) => text.startsWith("ANSWERS "));
    if (!line) throw new Error(`the dev server probe said nothing: ${stderr}`);
    return JSON.parse(line.slice("ANSWERS ".length)) as Record<
      string,
      { status: number; thisMachineOnly: boolean }
    >;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

describe.skipIf(lanAddress === undefined)("the app's dev server", () => {
  test("answers this machine and refuses another one, since it passes /api to the server from here", async () => {
    const answers = await probe({ TRUSTED_ORIGINS: "http://localhost:3010" });
    for (const host of ["127.0.0.1", "::1"]) {
      expect(answers[`${host} /`]).toEqual({
        status: 200,
        thisMachineOnly: false,
      });
    }
    for (const path of ["/", "/api/me"]) {
      expect(answers[`${lanAddress} ${path}`]).toEqual({
        status: 403,
        thisMachineOnly: true,
      });
    }
  }, 60_000);
});
