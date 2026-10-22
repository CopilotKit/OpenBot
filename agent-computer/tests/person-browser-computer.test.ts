import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserState,
  LauncherConnection,
} from "../../shared/openbot-browser";

/**
 * A person's browser through the computer itself: the real process, its token, its dispatcher and
 * its live screen, with bundled Chromium headless and the fixture Recorder.
 *
 * `person-browser.test.ts` drives the browser routes over every kind of person's browser. This is
 * what only the running computer decides: who may call them, what a person's browser id may reach,
 * and that a person's input reaches their browser through the live screen without anybody taking
 * control first.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/person-browser-computer.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "person-browser-computer-token";
const PERSON = "person-fedcba9876543210fedcba9876543210";
const FIXTURE = join(import.meta.dir, "fixtures", "recorder");

type Computer = { base: string; child: ReturnType<typeof Bun.spawn> };
const computers: Computer[] = [];
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error("The port probe did not listen.");
  return port;
}

async function startComputer(
  name: string,
  env: Record<string, string>,
): Promise<Computer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // No API server pushes this computer a network policy, so it browses before one arrives.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, name, "profiles"),
      WORKSPACE_DIR: join(root, name, "workspace"),
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const computer = { base, child };
  computers.push(computer);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return computer;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}

let computer: Computer;

function call(
  path: string,
  options: { body?: unknown; botId?: string; token?: string } = {},
) {
  return fetch(`${computer.base}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": options.token ?? TOKEN,
      ...(options.botId === undefined
        ? { "x-openbot-bot-id": PERSON }
        : options.botId
          ? { "x-openbot-bot-id": options.botId }
          : {}),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

const connection = (): LauncherConnection => ({
  openbotUrl: `http://127.0.0.1:${site?.port}`,
  token: "obr_fixture-token",
  connectionId: "connection-1",
  user: { id: "user-1", name: "Pat Example", email: "pat@example.com" },
});

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "openbot-person-computer-"));
  // The OpenBot the fixture Recorder reports to, and a page whose title is what the person types.
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/calls") {
        await request.text();
        return new Response("");
      }
      return new Response(
        "<!doctype html><title>empty</title><input autofocus><script>document.querySelector('input').addEventListener('input',e=>document.title=e.target.value)</script>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  computer = await startComputer("with-recorder", {
    OPENBOT_RECORDER_DIR: FIXTURE,
  });
}, 30_000);

afterAll(async () => {
  if (!asked) return;
  if (computer)
    await call("/browser/close", { body: {} }).catch(() => undefined);
  for (const running of computers) {
    running.child.kill();
    await running.child.exited;
  }
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!asked)("a person's browser on the computer", () => {
  test("is behind the computer token like every other route", async () => {
    expect((await call("/browser/state", { token: "wrong" })).status).toBe(401);
  });

  test("takes only a person's browser id", async () => {
    // With no id at all the computer falls back to its own default, which is a Bot's.
    for (const botId of ["", "shared", "sales-bot"]) {
      const response = await call("/browser/open", {
        body: { connection: connection() },
        botId,
      });
      expect(response.status).toBe(400);
    }
  });

  test("reaches nothing a Bot acts or reads through", async () => {
    for (const [path, body] of [
      ["/navigate", { url: "https://example.com" }],
      ["/click", { ref: "e1" }],
      ["/exec", { command: "env" }],
      ["/snapshot", {}],
      ["/control/request", { reason: "help" }],
      ["/files/read", { path: "notes.md" }],
    ] as const) {
      const response = await call(path, { body });
      expect(response.status).toBe(403);
    }
    expect((await call("/read")).status).toBe(403);
    expect((await call("/screenshot")).status).toBe(403);
  });

  test("opens connected, and starts with the person holding the wheel", async () => {
    const opening = await call("/browser/open", {
      body: { connection: connection() },
    });
    expect(opening.status).toBe(200);
    const state = (await opening.json()) as BrowserState;
    expect(state).toMatchObject({
      open: true,
      browser: "chromium",
      window: "screen",
      recorder: { connected: true, narration: "external" },
    });
    const control = (await (await call("/control")).json()) as {
      holder: string;
      requested: boolean;
    };
    expect(control).toMatchObject({ holder: "human", requested: false });
  }, 60_000);

  test("takes the person's input through the live screen without a takeover", async () => {
    const page = `http://127.0.0.1:${site?.port}/form`;
    expect(
      (
        await call("/browser/tabs", {
          body: { action: "new", url: page },
        })
      ).status,
    ).toBe(200);

    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${PERSON}&token=${TOKEN}`,
    );
    const errors: string[] = [];
    const casting = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "frame") resolve();
        if (message.type === "error") errors.push(message.error ?? "");
      });
      socket.addEventListener("error", () =>
        reject(new Error("The live screen failed.")),
      );
    });
    try {
      await casting;
      socket.send(JSON.stringify({ type: "text", text: "typed live" }));
      const deadline = Date.now() + 10_000;
      let title = "";
      while (Date.now() < deadline) {
        const state = (await (
          await call("/browser/state")
        ).json()) as BrowserState;
        title = state.tabs.find((tab) => tab.active)?.title ?? "";
        if (title === "typed live") break;
        await Bun.sleep(100);
      }
      expect(title).toBe("typed live");
      expect(errors).toEqual([]);
    } finally {
      socket.close();
    }

    // And by the person's input route, the same way.
    const typed = await call("/human/type", { body: { text: " and posted" } });
    expect(typed.status).toBe(200);
  }, 60_000);

  test("closes, and the live screen then finds nothing to show", async () => {
    expect(await (await call("/browser/close", { body: {} })).json()).toEqual({
      open: false,
      tabs: [],
    });
    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${PERSON}&token=${TOKEN}`,
    );
    const error = await new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "error") resolve(message.error ?? "");
      });
    });
    socket.close();
    expect(error).toContain("not open");
    // Nothing reopened it behind the person's back.
    const state = (await (await call("/browser/state")).json()) as BrowserState;
    expect(state.open).toBe(false);
  }, 30_000);

  test("a computer without a built Recorder refuses to open one, and says why", async () => {
    const without = await startComputer("without-recorder", {
      OPENBOT_RECORDER_DIR: "",
    });
    const response = await fetch(`${without.base}/browser/open`, {
      method: "POST",
      headers: {
        "x-openbot-computer-token": TOKEN,
        "x-openbot-bot-id": PERSON,
      },
      body: JSON.stringify({ connection: connection() }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(
      "OPENBOT_RECORDER_DIR",
    );
    const state = await fetch(`${without.base}/browser/state`, {
      headers: {
        "x-openbot-computer-token": TOKEN,
        "x-openbot-bot-id": PERSON,
      },
    });
    expect(((await state.json()) as BrowserState).open).toBe(false);
  }, 30_000);
});
