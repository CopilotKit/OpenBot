import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const identityModule = new URL("../src/identity.ts", import.meta.url).pathname;

// A fresh process preserves the production once-only lookup and keeps the client trap local to
// this test. The filesystem is real; the trap must never forward to a workload identity service.
async function lookup(
  socket: string | undefined,
  reply: "identity" | "error" = "identity",
) {
  const script = `
    import { mock } from "bun:test";
    let clients = 0;
    let address = null;
    mock.module("spiffe", () => ({ createClient(value) {
      clients++; address = value;
      return { fetchX509SVID() { return { responses: {
        onMessage(callback) { if (${JSON.stringify(reply)} === "identity") queueMicrotask(() => callback({svids:[{spiffeId:"spiffe://test.invalid/bot/probe"}]})); },
        onError(callback) { if (${JSON.stringify(reply)} === "error") queueMicrotask(() => callback(new Error("synthetic unavailable"))); }
      } }; } };
    } }));
    const {identity} = await import(${JSON.stringify(identityModule)});
    const first = await identity();
    const second = await identity();
    console.log(JSON.stringify({first,second,clients,address}));
  `;
  const env = { ...process.env };
  delete env.SPIFFE_ENDPOINT_SOCKET;
  if (socket !== undefined) env.SPIFFE_ENDPOINT_SOCKET = socket;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  return { result: JSON.parse(stdout), stderr };
}

describe("optional workload identity endpoint", () => {
  test("an unconfigured deployment never constructs a workload client", async () => {
    const { result, stderr } = await lookup(undefined);
    expect(result).toEqual({
      first: null,
      second: null,
      clients: 0,
      address: null,
    });
    expect(stderr).toBe("");
  });

  test("an absent socket is reported once without constructing the gRPC client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "identity-"));
    try {
      const { result, stderr } = await lookup(join(directory, "absent.sock"));
      expect(result).toEqual({
        first: null,
        second: null,
        clients: 0,
        address: null,
      });
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(stderr).toContain("missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a regular file cannot be used as a Unix workload socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "identity-"));
    try {
      const socket = join(directory, "regular-file");
      await writeFile(socket, "public synthetic fixture");
      const { result, stderr } = await lookup(socket);
      expect(result.clients).toBe(0);
      expect(result.first).toBeNull();
      expect(stderr).toContain("not a Unix socket");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a configured Unix socket still reaches the client and caches issued metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "identity-"));
    const socket = join(directory, "api.sock");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      const { result, stderr } = await lookup(socket);
      expect(result.clients).toBe(1);
      expect(result.address).toBe(`unix://${socket}`);
      expect(result.first).toEqual({
        spiffeId: "spiffe://test.invalid/bot/probe",
        issued: 1,
      });
      expect(result.second).toEqual(result.first);
      expect(stderr).toBe("");
      const failed = await lookup(socket, "error");
      expect(failed.result.first).toBeNull();
      expect(failed.result.clients).toBe(1);
      expect(failed.stderr).toContain("was issued no identity");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
