// The Bot's terminal, end to end through real processes: the real `agent-computer` with its live shell, the server's
// real gateway (policy, audit, the computer's token) and its real HTTP server's socket proxy, opened by a WebSocket
// client the way the browser opens it. The one stand-in is who the session belongs to, read from a header.
//
// What is pinned: only someone who may watch a Bot's screen opens its terminal; the Bot's commands go through the
// gateway as before and appear typed in that terminal, in one shell that keeps `cd`; while a person holds the wheel
// the Bot's command waits and the person's typing reaches the shell; handed back, the Bot carries on in it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reservePort } from "../../tests/support/reserved-port";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AuditEventInput } from "../src/audit";
import type { ComputerSeat } from "../src/computer/computer-key";
import {
  type ComputerGateway,
  createComputerGateway,
  HumanHasControlError,
} from "../src/computer/gateway";
import { createSharedComputerProvider } from "../src/computer/provider";
import type { DeploymentConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";

const TOKEN = `computer-${randomUUID()}`;
const BOT = "notes-bot";
const OWNER = "ada";

let dir = "";
let computer: ReturnType<typeof Bun.spawn> | undefined;
let computerBase = "";
let server: { stop(close?: boolean): Promise<void> } | undefined;
let serverPort = 0;
let gateway: ComputerGateway;
let seat: ComputerSeat;
const audit: AuditEventInput[] = [];
const actor = { id: OWNER };

/** A terminal socket, as the browser opens one, and everything it has been sent. */
type Watching = {
  socket: WebSocket;
  opened: Promise<boolean>;
  text: () => string;
  messages: Array<Record<string, unknown>>;
};

function openTerminal(user?: string, url?: string): Watching {
  const socket = new WebSocket(
    url ?? `ws://127.0.0.1:${serverPort}/api/computers/${BOT}/terminal`,
    // Bun's client takes headers on the upgrade; the server reads who is signed in from this one.
    user ? ({ headers: { "x-test-user": user } } as never) : undefined,
  );
  socket.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let seen = "";
  const messages: Array<Record<string, unknown>> = [];
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true);
    socket.onerror = () => resolve(false);
    socket.onclose = () => resolve(false);
  });
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      seen += decoder.decode(new Uint8Array(event.data), { stream: true });
      // Acknowledged as the browser's terminal does once it has drawn them.
      socket.send(
        JSON.stringify({ type: "ack", bytes: event.data.byteLength }),
      );
      return;
    }
    messages.push(JSON.parse(String(event.data)));
  };
  return {
    socket,
    opened,
    messages,
    text: () => Bun.stripANSI(seen).replace(/\r/g, ""),
  };
}

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "openbot-terminal-"));
  await Promise.all(
    ["profiles", "workspace", "recorder"].map((name) => mkdir(join(dir, name))),
  );
  const port = await reservePort();
  computerBase = `http://127.0.0.1:${port}`;
  computer = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
    cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      PORT: String(port),
      COMPUTER_TOKEN: TOKEN,
      PROFILES_DIR: join(dir, "profiles"),
      WORKSPACE_DIR: join(dir, "workspace"),
      COMPUTER_SEPARATE_WORKSPACES: "on",
      OPENBOT_RECORDER_DIR: join(dir, "recorder"),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (
    !(await fetch(`${computerBase}/health`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline || computer.exitCode !== null)
      throw new Error("The computer did not start.");
    await Bun.sleep(100);
  }

  gateway = createComputerGateway({
    provider: createSharedComputerProvider({
      baseUrl: computerBase,
      token: TOKEN,
    }),
    auditStore: { insert: async (event) => void audit.push(event) },
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: TOKEN,
  });
  seat = await gateway.seatFor(BOT, OWNER);

  serverPort = await reservePort();
  server = startHttpServer({
    port: serverPort,
    config: { computer: {} } as unknown as DeploymentConfig,
    resolveRequestActor: async (request) => {
      const user = request.headers.get("x-test-user");
      if (!user) throw new Error("Not signed in.");
      return { id: user, name: user, role: "user" };
    },
    // A private Bot: its owner watches its computer, and nobody else does.
    agentProfileStore: {
      get: async () => ({ visibility: "private", ownerUserId: OWNER }),
    } as unknown as AgentProfileStore,
    computerGateway: gateway,
    app: { fetch: () => new Response("Not found.", { status: 404 }) },
  });
}, 60_000);

afterAll(async () => {
  if (server) await Promise.race([server.stop(true), Bun.sleep(2_000)]);
  if (computer) {
    computer.kill();
    await computer.exited;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("who opens a Bot's terminal", () => {
  test("its owner does, and is sent the screen and then the live shell", async () => {
    const owner = openTerminal(OWNER);
    expect(await owner.opened).toBe(true);
    await until(() => owner.messages.some((m) => m.type === "ready"));
    expect(owner.messages[0]?.type).toBe("snapshot");
    owner.socket.close();
  }, 30_000);

  test("somebody who may not watch its screen does not, and neither does nobody", async () => {
    const stranger = openTerminal("bo");
    expect(await stranger.opened).toBe(false);
    const nobody = openTerminal();
    expect(await nobody.opened).toBe(false);
  }, 30_000);

  test("the computer itself opens it only for a caller holding its token", async () => {
    const direct = openTerminal(
      undefined,
      `${computerBase.replace("http", "ws")}/terminal?bot=${BOT}&person=${OWNER}`,
    );
    expect(await direct.opened).toBe(false);
    const wrong = openTerminal(
      undefined,
      `${computerBase.replace("http", "ws")}/terminal?bot=${BOT}&person=${OWNER}&token=not-the-token`,
    );
    expect(await wrong.opened).toBe(false);
  }, 30_000);
});

describe("the Bot's commands and a person, in one shell", () => {
  test("the Bot's command appears typed in its terminal, with its output, and cd carries over", async () => {
    const owner = openTerminal(OWNER);
    expect(await owner.opened).toBe(true);
    await until(() => owner.messages.some((m) => m.type === "ready"));

    const first = await gateway.runCommand(seat, actor, {
      command: "cd /tmp && echo typed-by-the-bot",
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("typed-by-the-bot");
    await until(() => owner.text().includes("\ntyped-by-the-bot"));
    expect(owner.text()).toContain("cd /tmp && echo typed-by-the-bot");

    const where = await gateway.runCommand(seat, actor, { command: "pwd" });
    expect(where.stdout).toContain("/tmp");
    // Governed as before: the command is a row in the trail.
    expect(
      audit.some((row) =>
        JSON.stringify(row.payload).includes("echo typed-by-the-bot"),
      ),
    ).toBe(true);
    owner.socket.close();
  }, 30_000);

  test("while a person holds the wheel the Bot waits, their typing reaches the shell, and handed back the Bot carries on in it", async () => {
    const owner = openTerminal(OWNER);
    expect(await owner.opened).toBe(true);
    await until(() => owner.messages.some((m) => m.type === "ready"));

    // Typing without the wheel is refused, and says so.
    owner.socket.send(JSON.stringify({ type: "input", data: "echo nope\r" }));
    await until(() => owner.messages.some((m) => m.type === "error"));
    expect(owner.text()).not.toContain("nope");

    const asked = await gateway.requestHelp(
      seat,
      actor,
      "I want to take control of the browser.",
      undefined,
      "manual",
    );
    const requestId = asked.request?.id ?? "";
    await gateway.takeControl(seat, actor, requestId);

    // The Bot's command waits for the wheel, as its clicks do.
    await expect(
      gateway.runCommand(seat, actor, { command: "echo too-soon" }),
    ).rejects.toBeInstanceOf(HumanHasControlError);

    owner.socket.send(
      JSON.stringify({
        type: "input",
        data: "export FROM_PERSON=hello-from-the-person\r",
      }),
    );
    owner.socket.send(
      JSON.stringify({ type: "input", data: "echo hello from the person\r" }),
    );
    await until(() => owner.text().includes("\nhello from the person"));

    await gateway.releaseControl(seat, actor, requestId);
    const after = await gateway.runCommand(seat, actor, {
      command: 'echo "$FROM_PERSON"; pwd',
    });
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain("hello-from-the-person");
    expect(after.stdout).toContain("/tmp");
    expect(owner.text()).not.toContain("too-soon");
    owner.socket.close();
  }, 40_000);
});
