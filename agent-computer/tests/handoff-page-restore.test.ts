import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerControlState } from "../../shared/computer-control";
import type { StoredControl } from "../src/control-store";

/**
 * Reopening a handoff's page happens behind the answer, not in front of it.
 *
 * The page a restart lost can take a cold browser and a whole navigation timeout to load, and the
 * Bot's help call and the person's "Take control" used to wait for all of it. Here the page is held
 * open by the test until both have answered, and is then expected on the screen anyway.
 *
 * A real computer process and a real Chromium, so it is asked for by name:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/handoff-page-restore.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "handoff-page-restore-token";
const BOT = "bot-restore";
/** Short, so the old awaited restore is still bounded; well above what an answer should take. */
const NAVIGATION_TIMEOUT_MS = 4_000;
const PROMPT_MS = 2_000;

let root = "";
let base = "";
let challenge = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;
let hits = 0;
let open = false;
const held: (() => void)[] = [];

function api(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": BOT,
      "x-openbot-computer-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
}

async function timed(path: string, body: unknown) {
  const started = performance.now();
  const response = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { response, elapsed: performance.now() - started };
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for the computer fixture.");
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "handoff-page-restore-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      hits += 1;
      if (!open) await new Promise<void>((resolve) => held.push(resolve));
      return new Response(
        "<!doctype html><title>Challenge</title><h1>The challenge</h1>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  challenge = `http://127.0.0.1:${site.port}/challenge`;

  // A request that was waiting on the challenge page when the computer last went down.
  const at = new Date(Date.now() - 5_000).toISOString();
  const stored: StoredControl = {
    version: 1,
    holder: "bot",
    since: at,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    currentRequestId: "before-restart",
    requests: [
      {
        id: "before-restart",
        reason: "Complete the challenge.",
        source: "cloudflare",
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        url: challenge,
      },
    ],
    aliases: {},
  };
  await mkdir(join(root, "profiles", ".control"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(root, "profiles", ".control", `${BOT}.json`),
    JSON.stringify(stored),
    { mode: 0o600 },
  );

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
      COMPUTER_TOKEN: TOKEN,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // No API server pushes a network policy here, as in headed-browser.test.ts.
      EGRESS_POLICY_REQUIRED: "0",
      NAVIGATION_TIMEOUT_MS: String(NAVIGATION_TIMEOUT_MS),
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await until(async () => {
    if (child?.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child?.exitCode}.`);
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  });
  // The browser comes back blank after the restart. Started here so its launch is not what is timed.
  const read = await api("/read");
  expect(read.status).toBe(200);
  expect(((await read.json()) as { url: string }).url).toBe("about:blank");
}, 60_000);

afterAll(async () => {
  if (!asked) return;
  open = true;
  for (const release of held.splice(0)) release();
  await api("/computers/stop", { method: "POST" }).catch(() => undefined);
  child?.kill();
  await child?.exited;
  site?.stop(true);
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!asked)("reopening the page a restart lost", () => {
  let requestId = "";

  test("the Bot's help call answers before the page has loaded", async () => {
    const { response, elapsed } = await timed("/control/request", {
      reason: "The browser restarted; please complete the challenge.",
      toolCallId: "call-2",
    });
    expect(response.status).toBe(200);
    const state = (await response.json()) as ComputerControlState;
    expect(state.request?.url).toBe(challenge);
    requestId = state.request!.id;
    expect(elapsed).toBeLessThan(PROMPT_MS);
    // And the page is on its way: the browser has asked for it.
    await until(async () => hits > 0);
  }, 30_000);

  test("Take control answers before it too, and the person is still shown the page", async () => {
    const { response, elapsed } = await timed("/control/take", { requestId });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ComputerControlState).holder).toBe(
      "human",
    );
    expect(elapsed).toBeLessThan(PROMPT_MS);

    open = true;
    for (const release of held.splice(0)) release();
    await until(async () => {
      const read = await api("/read");
      if (read.status !== 200) return false;
      const page = (await read.json()) as { url: string; text: string };
      return page.url === challenge && page.text.includes("The challenge");
    });
  }, 30_000);
});
