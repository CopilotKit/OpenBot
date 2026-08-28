import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The live screen, driven against the real process with a real browser.
 *
 * `viewer.test.ts` covers who owns the screen and what that lets them do, and it cannot cover
 * whether the handlers ask. That gap is the whole of this bug: every failure here reads as correct
 * in a unit test of the decision, because the decision was never the part that was wrong. So this
 * one imports `index.ts`, opens real sockets against the port it listens on, and lets it launch
 * Chromium.
 *
 * ASKED FOR BY NAME, like `tests/smoke/journey.test.ts`, and for a related reason. `index.ts` imports
 * Playwright at module scope, `playwright` is declared only in this directory's own `package.json`,
 * and CI installs the root workspaces plus the two Bots and never this one. An ungated file would
 * therefore throw on import there, and `bun run test:ci` asserts a floor on the number of tests
 * executed, so that failure reddens the build rather than skipping quietly. Reading the flag before
 * the dynamic import below is what keeps the default suite honest on a machine where Playwright was
 * never installed:
 *
 *   bun run test:live-screen
 *
 * Everything here is timing against a browser that has to start, so the waits are generous. They are
 * not the thing under test; what is under test is whether anything relaunches a browser nobody asked
 * to start, and whether input reaches a page it does not belong to.
 */

const asked = process.env.OPENBOT_LIVE_SCREEN === "1";

const TOKEN = "test-computer-token";
const PORT = 41641;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;

/** Comfortably past the 1Hz follow loop, so a tick that would relaunch has had its chance. */
const PAST_ONE_FOLLOW_TICK_MS = 1_600;
/** A cold Chromium launch here takes under two seconds; this leaves room on a slower machine. */
const LAUNCH_MS = 8_000;

/** A page that writes every key it receives into the body, so input that lands is readable back. */
const TYPING_PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<body>start</body><script>addEventListener('keydown',e=>{document.body.textContent+=e.key})</script>",
  );

let root = "";
let closing: Array<() => void> = [];

function api(path: string, botId: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
}

type Frames = {
  socket: WebSocket;
  /** Every error the server sent this socket, in order. */
  errors: string[];
  /**
   * Resolves when the connection is up, which is when the server's `open` handler starts running.
   *
   * The cold-launch window opens here, not when the socket is constructed. A socket closed before it
   * has connected never reaches the handler at all, so nothing is ever stranded and the failure this
   * file exists to catch cannot happen. Waiting for this is what puts the close inside the launch.
   */
  connected: Promise<void>;
  /** Resolves once a frame of the page has arrived, which means this socket is the one casting. */
  casting: Promise<void>;
  close: () => void;
};

function watch(botId: string): Frames {
  const socket = new WebSocket(`${WS}/stream?bot=${botId}&token=${TOKEN}`);
  const errors: string[] = [];
  let sawFrame = () => {};
  const casting = new Promise<void>((resolve) => {
    sawFrame = resolve;
  });
  let opened = () => {};
  const connected = new Promise<void>((resolve) => {
    opened = resolve;
  });
  socket.addEventListener("open", () => opened());
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      type?: string;
      error?: string;
    };
    if (message.type === "frame") sawFrame();
    if (message.type === "error") errors.push(message.error ?? "");
  });
  const close = () => {
    try {
      socket.close();
    } catch {
      // Already gone.
    }
  };
  closing.push(close);
  return { socket, errors, connected, casting, close };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for something to become true, rather than sleeping a guessed amount and hoping. */
async function until(
  what: () => boolean,
  budgetMs: number,
  why: string,
  refresh?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await refresh?.();
    if (what()) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${why}`);
}

async function stopped(botId: string): Promise<boolean> {
  const response = await api("/computers/stop", botId, { method: "POST" });
  const body = (await response.json()) as { wasRunning?: boolean };
  return body.wasRunning === true;
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-live-screen-"));
  process.env.COMPUTER_TOKEN = TOKEN;
  process.env.PORT = String(PORT);
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  // After the environment is set, because the module reads it while it loads, and behind the flag,
  // because this is the import that needs Playwright present.
  await import("../src/index");
});

afterAll(async () => {
  if (!asked) return;
  for (const close of closing) close();
  closing = [];
  // Every browser this file started, so the rest of the suite does not inherit a stray Chromium.
  for (const botId of ["cold-close", "supersede", "late-close", "wheel"]) {
    await api("/computers/stop", botId, { method: "POST" }).catch(
      () => undefined,
    );
  }
  await rm(root, { recursive: true, force: true });
  // Generous, because it is stopping real browsers: the default hook budget is shorter than a
  // Chromium shutdown and the file would fail on its own cleanup rather than on anything it tested.
}, 60_000);

describe.skipIf(!asked)(
  "a socket that closes while the browser is starting",
  () => {
    test("leaves nothing behind that starts the browser again", async () => {
      // Failure 1, and the observable is deliberately not "is there a viewer": it is whether anything
      // relaunches Chromium after somebody stopped it. The orphaned follow interval called
      // `currentPage` every second, which is a launch path, so a stopped computer came back up.
      const botId = "cold-close";
      const viewer = watch(botId);
      // Connected first, so the server's `open` is running and awaiting a page, then closed straight
      // away. That is the window: closing before the connection is up never reaches the handler.
      await viewer.connected;
      viewer.close();

      await wait(LAUNCH_MS);
      await stopped(botId);
      await wait(PAST_ONE_FOLLOW_TICK_MS);

      expect(await stopped(botId)).toBe(false);
    }, 30_000);
  },
);

describe.skipIf(!asked)("a socket that another connection replaced", () => {
  test("cannot type into the screen that replaced it, and is told so", async () => {
    // Failure 3. The input handler dispatched through whatever the session held, so the replaced
    // window's keys went into the page the current viewer was watching, and the sender heard nothing
    // because the old check returned before reaching anything that could report.
    const botId = "supersede";
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({ url: TYPING_PAGE }),
    });

    const first = watch(botId);
    await first.casting;
    const second = watch(botId);
    await second.casting;

    await api("/control/take", botId, { method: "POST" });
    first.socket.send(JSON.stringify({ type: "key", key: "z" }));

    // The exact refusal, not merely some error. Dispatching through a cast the sender does not own
    // also fails, and fails loudly, so "an error arrived" passes just as well when the ownership
    // check is gone. Only the wording separates being refused from blundering into a null.
    await until(
      () => first.errors.some((e) => /no longer live/i.test(e)),
      5_000,
      "the replaced socket to be told its screen is no longer live",
    );

    const read = await api("/read", botId);
    const { text } = (await read.json()) as { text: string };
    expect(text).not.toContain("z");
  }, 30_000);
});

describe.skipIf(!asked)("a superseded socket closing later", () => {
  test("does not take the screen down with it", async () => {
    // What #191 fixed, at the level where it can actually go wrong again. Replacement does not close
    // the socket it superseded, so that socket closes on its own schedule, which on an ordinary
    // make-before-break reconnect is after the replacement is already casting. A close that stopped
    // whatever the slot held rather than naming its own socket would leave the person who just
    // reconnected watching a still image with input going nowhere, and nothing would say so.
    const botId = "late-close";
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({ url: TYPING_PAGE }),
    });

    const first = watch(botId);
    await first.casting;
    const second = watch(botId);
    await second.casting;

    // The replaced socket goes away now, after its replacement is live.
    first.close();
    await wait(PAST_ONE_FOLLOW_TICK_MS);

    // The survivor still owns the screen, and the proof is that its typing arrives: a cast that was
    // stopped underneath it, or an ownership it quietly lost, would refuse this instead.
    await api("/control/take", botId, { method: "POST" });
    second.socket.send(JSON.stringify({ type: "key", key: "k" }));

    let landed = "";
    await until(
      () => landed.includes("k"),
      5_000,
      "the surviving viewer's key to reach the page",
      async () => {
        const read = await api("/read", botId);
        landed = ((await read.json()) as { text: string }).text;
      },
    );

    expect(second.errors).toEqual([]);
  }, 30_000);
});

describe.skipIf(!asked)(
  "the wheel, with the ownership check in front of it",
  () => {
    test("still refuses the casting socket while the Bot holds it", async () => {
      // The control half of the reordering. The superseded case above runs with a person already
      // holding the wheel, so the control check is passive there and a rewiring that dropped it would
      // still pass. Here the socket genuinely owns the screen and nobody has taken control, which is
      // the only arrangement where that check is the one doing the refusing.
      const botId = "wheel";
      await api("/navigate", botId, {
        method: "POST",
        body: JSON.stringify({ url: TYPING_PAGE }),
      });
      await api("/control/release", botId, { method: "POST" });

      const viewer = watch(botId);
      await viewer.casting;

      viewer.socket.send(JSON.stringify({ type: "key", key: "q" }));

      await until(
        () => viewer.errors.length > 0,
        5_000,
        "the owner to be told to take control first",
      );
      expect(viewer.errors.some((e) => /control/i.test(e))).toBe(true);

      const read = await api("/read", botId);
      const { text } = (await read.json()) as { text: string };
      expect(text).not.toContain("q");
    }, 30_000);
  },
);
