import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";
import type { ComputerControlState } from "../../shared/computer-control";

/**
 * The fresh look a handback asks for, on the real computer: its process, its dispatcher, its control
 * file on disk and bundled Chromium headless.
 *
 * After a person hands the browser back, the Bot must look at the page before it acts on it. That
 * demand belongs to the page the person left. It once outlived it: opening another page was refused
 * too, and every restart set it again, so the first page a later conversation opened came back as
 * "Take a fresh browser snapshot after handback before acting."
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/handback-fresh-look.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "handback-fresh-look-token";
const BOT = "handback-bot";

let root = "";
let base = "";
let origin = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;

async function call(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function control(): Promise<ComputerControlState> {
  const { status, json } = await call("/control");
  expect(status).toBe(200);
  return json as unknown as ComputerControlState;
}

/** A person takes the browser the Bot asked them to, and hands it back. */
async function handBack(toolCallId: string) {
  const requested = await call("/control/request", {
    reason: "Sign in for me.",
    toolCallId,
  });
  expect(requested.status).toBe(200);
  const requestId = (requested.json as unknown as ComputerControlState).request!
    .id;
  expect(
    (await call("/control/take", { requestId, by: "person" })).status,
  ).toBe(200);
  expect((await call("/control/release", { requestId })).status).toBe(200);
  expect((await control()).resumeSnapshotRequired).toBe(true);
}

async function start() {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
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
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}

/** Quit, as closing OpenBot does: the process is told to end, and its browser goes with it. */
async function stop() {
  child?.kill();
  if (child) await child.exited;
  child = undefined;
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "handback-fresh-look-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const name = new URL(request.url).pathname.slice(1) || "home";
      return new Response(`<title>${name}</title><h1>${name}</h1>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  origin = `http://127.0.0.1:${site.port}`;
  await start();
}, 60_000);

afterAll(async () => {
  if (!asked) return;
  await stop();
  await site?.stop(true);
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!asked)("the fresh look a handback asks for", () => {
  test("is for the page the person left: opening another page needs none, and ends it", async () => {
    expect((await call("/navigate", { url: `${origin}/sign-in` })).status).toBe(
      200,
    );
    await handBack("call-1");

    // Acting on the page the person left still waits for a look.
    const pressed = await call("/key", { key: "Tab" });
    expect(pressed.status).toBe(409);
    expect(pressed.json).toMatchObject({ snapshotRequired: true });

    // A later conversation starts by opening a page. Nothing of the person's is left to look at.
    const opened = await call("/navigate", { url: `${origin}/inbox` });
    expect(opened.status).toBe(200);
    expect(opened.json.title).toBe("inbox");
    expect((await control()).resumeSnapshotRequired).toBe(false);
    expect((await call("/key", { key: "Tab" })).status).toBe(200);
  }, 60_000);

  test("does not outlive a restart: the browser the person used is gone", async () => {
    await handBack("call-2");

    await stop();
    await start();

    expect((await control()).resumeSnapshotRequired).toBe(false);
    expect((await call("/key", { key: "Tab" })).status).toBe(200);
  }, 60_000);
});
