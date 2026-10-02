import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const asked = process.env.OPENBOT_DEMONSTRATION_LIVE === "1";
const token = "demonstration-fixture-token";
const botId = "demonstration-fixture";
const recordingId = "11111111-1111-1111-1111-111111111111";
let root = "";
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
// The computer opens only http(s) pages, so the fixture page is served rather than a data: URL.
let site: ReturnType<typeof Bun.serve> | undefined;
async function api(path: string, input?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      "x-openbot-computer-token": token,
      "x-openbot-bot-id": botId,
      "content-type": "application/json",
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok)
    throw new Error(`Computer fixture ${path} answered ${response.status}.`);
  return response.json();
}
beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "demonstration-fixture-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: token,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // No API server pushes this computer a network policy, so it browses before one arrives.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child.exitCode}.`);
    let ready = false;
    try {
      ready = (await fetch(`${base}/health`)).ok;
    } catch {
      /* Readiness may precede binding; bounded by deadline below. */
    }
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error("Computer fixture did not start.");
    await Bun.sleep(25);
  }
}, 15000);
afterAll(async () => {
  if (!asked) return;
  if (child?.exitCode === null) {
    try {
      await api("/computers/stop", {});
    } finally {
      child.kill();
      await child.exited;
    }
  }
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 15000);
describe.skipIf(!asked)("real human live-screen demonstration", () => {
  test("successful browser input emits accessible steps without the secret value", async () => {
    const html =
      '<label>Password<input type="password" autofocus></label><output>empty</output><script>document.querySelector("input").addEventListener("input",e=>document.querySelector("output").textContent="characters:"+e.target.value.length)</script>';
    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(html, { headers: { "content-type": "text/html" } }),
    });
    await api("/navigate", { url: `http://127.0.0.1:${site.port}/` });
    const requested = await api("/control/request", {
      reason: "Record a browser demonstration",
    });
    await api("/control/take", { requestId: requested.request.id });
    const socket = new WebSocket(
      `${base.replace("http:", "ws:")}/stream?bot=${botId}&token=${token}&recording=${recordingId}`,
    );
    const messages: string[] = [];
    let frame: (() => void) | undefined;
    let recorded:
      | ((value: {
          target: { sensitive: boolean; name: string };
          kind: string;
        }) => void)
      | undefined;
    const live = new Promise<void>((resolve, reject) => {
      frame = resolve;
      socket.addEventListener(
        "error",
        () => reject(new Error("The recording socket failed.")),
        { once: true },
      );
    });
    const action = new Promise<{
      target: { sensitive: boolean; name: string };
      kind: string;
    }>((resolve) => {
      recorded = resolve;
    });
    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      const message = JSON.parse(raw);
      if (message.type === "frame") frame?.();
      if (message.type === "demonstration.action") {
        messages.push(raw);
        recorded?.(message.action);
      }
    });
    try {
      await live;
      socket.send(JSON.stringify({ type: "text", text: "FixtureSecret42" }));
      const step = await action;
      expect(step.kind).toBe("type");
      expect(step.target.sensitive).toBe(true);
      expect(step.target.name).toBe("[sensitive field]");
      expect(messages.join("\n")).not.toContain("FixtureSecret42");
      const result = await api("/read");
      expect(result.text).toContain("characters:15");
    } finally {
      socket.close();
    }
  }, 20000);
});
