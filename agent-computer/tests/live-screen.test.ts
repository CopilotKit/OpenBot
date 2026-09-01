import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const CONTROL_LEASE = "a".repeat(43);

/**
 * A port the operating system says is free, rather than one picked in advance.
 *
 * A fixed number here fails the whole file at import when anything else holds it, and reports as one
 * broken test rather than as a port clash. 41641 in particular is Tailscale's default, so on a host
 * running it this file could never have run at all.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const found = (probe.address() as { port: number }).port;
      probe.close(() => resolve(found));
    });
  });
}

let BASE = "";
let WS = "";

/**
 * How long "it did not come back" has to keep being true.
 *
 * A single check one tick later cannot tell a relaunch that never happened from one still in flight:
 * `evict` reads only the browsers already running, and a launch is not one of those until it
 * finishes, so both answer `wasRunning: false`. Holding the answer across several ticks and a whole
 * cold start is what makes it mean the loop is gone rather than merely slow.
 */
const STAYS_STOPPED_MS = 9_000;

/** Long enough for a close to land and the follow loop to tick once after it. */
const AFTER_ONE_FOLLOW_TICK_MS = 1_600;
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

function watch(botId: string, lease?: string): Frames {
  const query = new URLSearchParams({ bot: botId, token: TOKEN });
  if (lease) query.set("lease", lease);
  const socket = new WebSocket(`${WS}/stream?${query}`);
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

function takeControl(botId: string, lease: string) {
  return api("/control/take", botId, {
    method: "POST",
    body: JSON.stringify({
      lease,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
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

/** Keep asking, and fail the moment the browser comes back rather than only at the end. */
async function staysStopped(botId: string): Promise<void> {
  const deadline = Date.now() + STAYS_STOPPED_MS;
  while (Date.now() < deadline) {
    if (await stopped(botId)) {
      throw new Error(
        "Something started the browser again after it was stopped",
      );
    }
    await wait(250);
  }
}

async function stopped(botId: string): Promise<boolean> {
  const response = await api("/computers/stop", botId, { method: "POST" });
  const body = (await response.json()) as { wasRunning?: boolean };
  return body.wasRunning === true;
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-live-screen-"));
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  WS = `ws://127.0.0.1:${port}`;
  process.env.COMPUTER_TOKEN = TOKEN;
  process.env.PORT = String(port);
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  await mkdir(join(root, "profiles"), { recursive: true });
  // After the environment is set, because the module reads it while it loads, and behind the flag,
  // because this is the import that needs Playwright present.
  await import("../src/index");
});

afterAll(async () => {
  if (!asked) return;
  for (const close of closing) close();
  closing = [];
  // Every browser this file started, so the rest of the suite does not inherit a stray Chromium.
  for (const botId of [
    "cold-close",
    "supersede",
    "late-close",
    "wheel",
    "stop-viewer",
    "reset-viewer",
    "screenshot-stopped",
    "wont-launch",
    "still-starting",
  ]) {
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
      // The launch really did produce a browser. Without this the whole case passes vacuously on a
      // machine where the launch failed or is still going: nothing was cast, no follow loop existed,
      // and the orphaned interval this exists to catch was never created.
      expect(await stopped(botId)).toBe(true);

      await staysStopped(botId);
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

    const first = watch(botId, CONTROL_LEASE);
    await first.casting;
    const second = watch(botId, CONTROL_LEASE);
    await second.casting;

    await takeControl(botId, CONTROL_LEASE);
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

    const first = watch(botId, CONTROL_LEASE);
    await first.casting;
    const second = watch(botId, CONTROL_LEASE);
    await second.casting;

    // The replaced socket goes away now, after its replacement is live.
    first.close();
    await wait(AFTER_ONE_FOLLOW_TICK_MS);

    // The survivor still owns the screen, and the proof is that its typing arrives: a cast that was
    // stopped underneath it, or an ownership it quietly lost, would refuse this instead.
    await takeControl(botId, CONTROL_LEASE);
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

describe.skipIf(!asked)("stopping the computer out from under a viewer", () => {
  test("takes the screen down and does not come back", async () => {
    // Failure 2. Stopping released the wheel and left the viewer alone, so the follow loop's next
    // tick asked for a page, which starts a browser, and the computer somebody had just stopped was
    // running again a second later, refreshing its own idle timestamp every tick while it did.
    const botId = "stop-viewer";
    const viewer = watch(botId);
    await viewer.casting;

    expect(await stopped(botId)).toBe(true);

    await until(
      () => viewer.errors.some((e) => /stopped/i.test(e)),
      5_000,
      "the viewer to be told the computer stopped",
    );

    await staysStopped(botId);
  }, 30_000);

  test("the same holds when the computer is reset rather than stopped", async () => {
    // Reset wipes the profile as well, and had the identical hole: it released the wheel and never
    // touched the viewer. Its own response carries no `wasRunning`, so the relaunch is observed
    // through a following stop rather than through what reset itself answers.
    const botId = "reset-viewer";
    const viewer = watch(botId);
    await viewer.casting;

    await api("/computers/reset", botId, { method: "POST" });

    await until(
      () => viewer.errors.some((e) => /stopped/i.test(e)),
      5_000,
      "the viewer to be told its computer went away",
    );

    await staysStopped(botId);
  }, 30_000);
});

describe.skipIf(!asked)("looking at a stopped computer", () => {
  test("a screenshot says the browser is closed without starting it again", async () => {
    const botId = "screenshot-stopped";
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({ url: TYPING_PAGE }),
    });
    expect(await stopped(botId)).toBe(true);

    const response = await api("/screenshot", botId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The browser is closed. Open it from the Browser icon on the computer desktop.",
    });

    // More than one poll interval and a cold launch. If the read is still a hidden start path, the
    // following stop catches the browser it made rather than passing on a lucky early observation.
    await staysStopped(botId);
  }, 30_000);
});

describe.skipIf(!asked)("typing into a screen that is still opening", () => {
  test("is told the screen is starting, not that it ended", async () => {
    // The reason there are three standings rather than two. A socket mid-launch owns a claim and no
    // cast, exactly like a socket that was superseded, and answering both the same way tells somebody
    // whose screen is seconds from live that their session is over.
    const botId = "still-starting";
    const viewer = watch(botId);
    // Only connected, deliberately: the browser is still starting, so no cast exists yet.
    await viewer.connected;
    viewer.socket.send(JSON.stringify({ type: "key", key: "s" }));

    await until(
      () => viewer.errors.length > 0,
      LAUNCH_MS,
      "the socket to be answered while its screen is still starting",
    );

    expect(viewer.errors[0]).toMatch(/still starting/i);
  }, 40_000);
});

describe.skipIf(!asked)("a screen whose browser will not start", () => {
  test("says so and leaves nothing holding the session", async () => {
    // `open`'s catch. A file sits where this Bot's profile directory would go, so Chromium cannot
    // launch and `currentPage` throws while the claim is already held. The socket is told and closed,
    // which is the observable part; the claim being released with it is what keeps the session
    // sweepable, and `viewer.test.ts` pins that half because a leaked claim changes nothing a caller
    // outside this process can see until the map has grown.
    const botId = "wont-launch";
    await writeFile(join(root, "profiles", botId), "not a directory");

    const viewer = watch(botId);
    await viewer.connected;

    await until(
      () => viewer.errors.length > 0,
      15_000,
      "the socket to be told its screen could not be started",
    );

    // What it says is Playwright's to word, so this pins only that the socket was told why its
    // screen never arrived rather than handed one of the lifecycle refusals, which would mean the
    // failure had been reported as somebody else taking the screen.
    expect(viewer.errors[0]).not.toMatch(
      /no longer live|still starting|computer stopped/i,
    );

    // Closed by the handler rather than left open against a browser that does not exist.
    await until(
      () => viewer.socket.readyState === WebSocket.CLOSED,
      5_000,
      "the socket to be closed after the failure",
    );
  }, 40_000);
});
