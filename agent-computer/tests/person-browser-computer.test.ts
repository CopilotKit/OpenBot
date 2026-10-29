import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserState,
  LauncherConnection,
} from "../../shared/openbot-browser";
import { NOT_ITS_OWN_COMPUTER, ONLY_THE_PERSONS } from "../src/person-access";

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
 *
 * One case reaches the public internet (Google, through the computer's own egress filter), so it
 * runs only when that is asked for as well:
 *
 *   OPENBOT_COMPUTER_BROWSER=1 OPENBOT_LIVE_NETWORK=1 bun test tests/person-browser-computer.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const online = asked && process.env.OPENBOT_LIVE_NETWORK === "1";
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
/** What the fixture Recorder said it was called with, oldest first. */
const calls: { method: string; input: unknown }[] = [];

function call(
  path: string,
  options: {
    body?: unknown;
    botId?: string;
    token?: string;
    /** Another computer than the person's own. */
    on?: Computer;
  } = {},
) {
  return fetch(`${(options.on ?? computer).base}${path}`, {
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
      const { pathname } = new URL(request.url);
      if (pathname === "/fixture/calls") {
        calls.push((await request.json()) as (typeof calls)[number]);
        return new Response("");
      }
      // A cookie kept for an hour, as a site keeps a sign-in: it outlives the browser closing.
      if (pathname === "/set-cookie")
        return new Response("<!doctype html><title>set</title>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "signed-in=yes; Max-Age=3600; Path=/",
          },
        });
      // The cookies the browser sent, as the page's title.
      if (pathname === "/cookies")
        return new Response(
          `<!doctype html><title>cookies:${request.headers.get("cookie") ?? ""}</title>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      return new Response(
        "<!doctype html><title>empty</title><input autofocus><script>document.querySelector('input').addEventListener('input',e=>document.title=e.target.value)</script>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  // Started for the person's browser alone, as a supervisor starts the container it makes for it.
  computer = await startComputer("with-recorder", {
    OPENBOT_RECORDER_DIR: FIXTURE,
    COMPUTER_BOT_ID: PERSON,
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

  test("takes only its own person's browser id: no Bot's, and nobody else's", async () => {
    for (const botId of [
      "shared",
      "sales-bot",
      "person-00000000000000000000000000000000",
    ]) {
      const response = await call("/browser/open", {
        body: { connection: connection() },
        botId,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: ONLY_THE_PERSONS });
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

  test("clears: a recording in it ends first, the whole profile goes and nothing else does, and it opens again signed out of everything", async () => {
    const origin = `http://127.0.0.1:${site?.port}`;
    const open = () =>
      call("/browser/open", { body: { connection: connection() } });
    const sees = async () => {
      const there = await call("/browser/navigate", {
        body: { url: `${origin}/cookies` },
      });
      expect(there.status).toBe(200);
      return ((await there.json()) as BrowserState).tabs.find(
        (tab) => tab.active,
      )?.title;
    };
    expect((await open()).status).toBe(200);
    expect(
      (
        await call("/browser/navigate", {
          body: { url: `${origin}/set-cookie` },
        })
      ).status,
    ).toBe(200);
    expect(await sees()).toBe("cookies:signed-in=yes");
    // Something of the computer's that is not the browser's.
    const workspace = join(root, "with-recorder", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.md"), "Keep me.");
    const profiles = join(root, "with-recorder", "profiles");
    expect(await readdir(profiles)).toContain(PERSON);

    expect(
      (
        await call("/browser/recording", {
          body: { action: "start", title: "Before the clear" },
        })
      ).status,
    ).toBe(200);
    calls.length = 0;
    const cleared = await call("/browser/clear", { body: {} });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ open: false, tabs: [] });
    // The recording was stopped while the Recorder could still be told.
    expect(calls.map((each) => [each.method, each.input])).toEqual([
      ["record", { action: "stop" }],
    ]);
    // The profile is gone, and left gone: only the server can hand the Recorder a connection, so it opens it again.
    expect(await readdir(profiles)).not.toContain(PERSON);
    expect(await Bun.file(join(workspace, "notes.md")).text()).toBe("Keep me.");
    expect(
      ((await (await call("/browser/state")).json()) as BrowserState).open,
    ).toBe(false);

    // Opened again, it is fresh: signed out of the site, with only closing the browser it would have stayed signed in.
    expect((await open()).status).toBe(200);
    expect(await sees()).toBe("cookies:");
    // A browser that is closed is cleared all the same.
    await call("/browser/close", { body: {} });
    expect((await call("/browser/clear", { body: {} })).status).toBe(200);
    expect(await readdir(profiles)).not.toContain(PERSON);
  }, 90_000);

  test("a computer without a built Recorder refuses to open one, and says why", async () => {
    const without = await startComputer("without-recorder", {
      OPENBOT_RECORDER_DIR: "",
      COMPUTER_BOT_ID: PERSON,
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

/**
 * A computer whose image lacks Playwright's Chromium: the person's browser cannot start, which is OpenBot's setup and
 * nothing the person did or can do. Run 4 saw a launch failure reach the person as a 502 reading "The browser could
 * not be opened:" and Playwright's own text, its install box included. No browser starts, so this runs everywhere.
 */
describe("a person's browser on a computer whose browser is not installed", () => {
  test("is a 503 the server turns into its sentence for the person, and Playwright's text stays in the computer's log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-no-chromium-"));
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
        EGRESS_POLICY_REQUIRED: "0",
        PROFILES_DIR: join(dir, "profiles"),
        WORKSPACE_DIR: join(dir, "workspace"),
        OPENBOT_RECORDER_DIR: FIXTURE,
        COMPUTER_BOT_ID: PERSON,
        // Where Playwright looks for its browsers: an empty folder, as an image built without them is.
        PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers"),
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const deadline = Date.now() + 15_000;
      while (
        !(await fetch(`${base}/health`).then(
          (response) => response.ok,
          () => false,
        ))
      ) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error("The computer did not start.");
        await Bun.sleep(50);
      }
      const response = await fetch(`${base}/browser/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-computer-token": TOKEN,
          "x-openbot-bot-id": PERSON,
        },
        body: JSON.stringify({
          connection: {
            openbotUrl: "http://127.0.0.1:7829",
            token: "obr_fixture-token",
            connectionId: "connection-1",
            user: {
              id: "user-1",
              name: "Pat Example",
              email: "pat@example.com",
            },
          },
        }),
      });
      expect(response.status).toBe(503);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain("Executable doesn't exist at");
      child.kill();
      await child.exited;
      const logged = (await new Response(child.stdout).text())
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .filter((line) => line.type === "computer-browser-open-failed");
      expect(logged).toEqual([
        {
          type: "computer-browser-open-failed",
          botId: PERSON,
          step: "launch",
          status: 503,
          error,
          ms: expect.any(Number),
        },
      ]);
    } finally {
      child.kill();
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Where a person's browser may run at all, as the running computer decides it from how it was started. A Bot on the
 * computer every Bot shares may run a shell as the same user the browser's profile belongs to, so a person's browser
 * runs only on a computer of its own: one started for it (`COMPUTER_BOT_ID`, as a supervisor or a Sandbox starts each),
 * or one started for people's browsers alone (`COMPUTER_PEOPLE_ONLY`, OpenBot Desktop's). Refused before anything is
 * launched, so no browser starts and this runs everywhere.
 */
describe("a person's browser on a computer that is not its own", () => {
  let dir = "";
  /** The computers this block starts, which it stops itself: the file's own teardown runs only with a browser. */
  let first = 0;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "openbot-person-placement-"));
    root ||= dir;
    first = computers.length;
  });
  afterAll(async () => {
    for (const running of computers.splice(first)) {
      running.child.kill();
      await running.child.exited;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 30_000);

  const open = (on: Computer, botId = PERSON) =>
    call("/browser/open", {
      body: { connection: connection() },
      botId,
      on,
    });

  test("is refused on the computer every Bot shares, before its profile, policy or live screen exist", async () => {
    const shared = await startComputer("shared", {
      OPENBOT_RECORDER_DIR: FIXTURE,
      PROFILES_DIR: join(dir, "shared", "profiles"),
    });
    const opening = await open(shared);
    expect(opening.status).toBe(503);
    expect(await opening.json()).toEqual({ error: NOT_ITS_OWN_COMPUTER });
    for (const path of ["/browser/state", "/egress-policy", "/run"])
      expect((await call(path, { on: shared })).status).toBe(503);
    expect(
      (await fetch(`${shared.base}/stream?token=${TOKEN}&bot=${PERSON}`))
        .status,
    ).toBe(503);
    expect(await readdir(join(dir, "shared", "profiles"))).toEqual([]);
    // A Bot's computer, started for that Bot, refuses it as well.
    const bots = await startComputer("a-bot", {
      OPENBOT_RECORDER_DIR: FIXTURE,
      COMPUTER_BOT_ID: "sales-bot",
    });
    expect((await open(bots)).status).toBe(503);
    // Bots are served on both as before: who holds the wheel is a Bot's to read.
    for (const on of [shared, bots])
      expect((await call("/control", { botId: "sales-bot", on })).status).toBe(
        200,
      );
  }, 30_000);

  test("on OpenBot Desktop's computer, which runs people's browsers and no Bot, a Bot is refused", async () => {
    const desktop = await startComputer("people-only", {
      OPENBOT_RECORDER_DIR: FIXTURE,
      COMPUTER_PEOPLE_ONLY: "on",
    });
    for (const botId of ["sales-bot", "shared"]) {
      const asked = await call("/exec", {
        body: { command: "cat /profiles/*/Default/Cookies" },
        botId,
        on: desktop,
      });
      expect(asked.status).toBe(403);
      expect(await asked.json()).toEqual({ error: ONLY_THE_PERSONS });
    }
    // The person's own routes go on to the browser host, which says the browser is not open yet.
    expect((await call("/browser/state", { on: desktop })).status).toBe(200);
  }, 30_000);
});

describe.skipIf(!online)(
  "the open internet through the computer's egress filter",
  () => {
    /*
     * Google answers with an HTTP/2 ACCEPT_CH frame, which makes Chromium restart the page's request,
     * and Playwright, answering the filter's proxy credentials through request interception, never
     * sent the restarted one: every browser on a computer timed out on Google while Bing loaded.
     */
    const loads = async (response: Response) => {
      expect(response.status).toBe(200);
      return (await response.json()) as BrowserState & { url?: string };
    };

    test("a person's browser loads Google", async () => {
      await loads(
        await call("/browser/open", { body: { connection: connection() } }),
      );
      for (const url of [
        "https://www.google.com/",
        "https://accounts.google.com/",
      ]) {
        const state = await loads(
          await call("/browser/navigate", { body: { url } }),
        );
        expect(state.tabs.find((tab) => tab.active)?.url).toStartWith(
          new URL(url).origin,
        );
      }
      await call("/browser/close", { body: {} });
    }, 90_000);

    test("a Bot's browser loads Google", async () => {
      // On a computer of the Bot's: the person's runs nothing else.
      const on = await startComputer("live-network-bot", {});
      const answer = await loads(
        await call("/navigate", {
          body: { url: "https://www.google.com/" },
          botId: "live-network-bot",
          on,
        }),
      );
      expect(answer.url).toStartWith("https://www.google.com");
      await call("/computers/stop", {
        body: {},
        botId: "live-network-bot",
        on,
      });
    }, 90_000);
  },
);
