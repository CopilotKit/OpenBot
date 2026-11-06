import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How the live screen keeps up with a person, against the real process and a real Chromium.
 *
 * Asked for by name, like `live-screen.test.ts` and for the same reason (it imports Playwright). In
 * a process of its own, because it starts the computer on a port of its own and a module loads once:
 *
 *   bun run test:live-screen-pacing
 *
 * Two measurements, each with a bound loose enough for a slow machine and far tighter than what it
 * guards against:
 *
 * - A click after two seconds of mouse moves at 144 a second, over a page that spends 4 ms on each
 *   move. Applied one by one, the moves held the click back by more than half a second; folded, it
 *   lands in tens of milliseconds.
 * - A page animating for six seconds, cast through a link that carries 400 KB a second. With nothing
 *   holding Chrome back, frames went on arriving for over twenty seconds after the page stopped
 *   moving: the person watched the past. Paced by the frames the viewer confirms, a second or two.
 */

const asked = process.env.OPENBOT_LIVE_SCREEN === "1";
const TOKEN = "test-computer-token";

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

let port = 0;
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;
const pages = new Map<string, string>();

/** A page served over http on this machine: the computer opens only http(s). */
function page(html: string): string {
  const path = `/${pages.size}`;
  pages.set(path, html);
  return `http://127.0.0.1:${site?.port}${path}`;
}

function api(path: string, botId: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": TOKEN,
    },
  });
}

async function takeControl(botId: string) {
  const requested = await api("/control/request", botId, {
    method: "POST",
    body: JSON.stringify({ reason: "Manual control for the pacing test" }),
  });
  const state = (await requested.json()) as { request: { id: string } };
  const taken = await api("/control/take", botId, {
    method: "POST",
    body: JSON.stringify({ requestId: state.request.id }),
  });
  expect(taken.status).toBe(200);
}

/** A viewer that confirms each frame on arrival once the computer asks, as the app's screen does. */
function watch(url: string) {
  const socket = new WebSocket(url);
  const frames: number[] = [];
  let confirm = false;
  let first = () => {};
  const casting = new Promise<void>((resolve) => {
    first = resolve;
  });
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    if (text.startsWith('{"type":"frame"')) {
      if (confirm) socket.send('{"type":"frame-received"}');
      frames.push(performance.now());
      first();
      return;
    }
    const message = JSON.parse(text) as {
      type?: string;
      confirmFrames?: boolean;
    };
    if (message.type === "hello") confirm = message.confirmFrames === true;
  });
  return { socket, frames, casting };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-pacing-"));
  port = await freePort();
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) =>
      new Response(pages.get(new URL(request.url).pathname) ?? "missing", {
        headers: { "content-type": "text/html" },
      }),
  });
  process.env.COMPUTER_TOKEN = TOKEN;
  process.env.PORT = String(port);
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  // Pages on this machine, which the default policy refuses.
  process.env.EGRESS_POLICY_REQUIRED = "0";
  await mkdir(join(root, "profiles"), { recursive: true });
  await import("../src/index");
});

afterAll(async () => {
  if (!asked) return;
  for (const botId of ["pacing-click", "pacing-lag"])
    await api("/computers/stop", botId, { method: "POST" }).catch(
      () => undefined,
    );
  site?.stop(true);
  await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!asked)("the live screen under a moving hand", () => {
  test("a click after a burst of moves lands without waiting for them", async () => {
    const botId = "pacing-click";
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({
        url: page(
          `<body style="margin:0;height:100vh">clicks=<b id=c>0</b></body><script>
          let c=0;
          addEventListener('mousemove',()=>{const t=performance.now();while(performance.now()-t<4){}});
          addEventListener('mousedown',()=>{c++;document.getElementById('c').textContent=c});
          </script>`,
        ),
      }),
    });
    const viewer = watch(
      `ws://127.0.0.1:${port}/stream?bot=${botId}&token=${TOKEN}`,
    );
    await viewer.casting;
    await takeControl(botId);

    for (let i = 0; i < 288; i += 1) {
      viewer.socket.send(
        JSON.stringify({
          type: "mouse",
          event: "moved",
          x: 100 + (i % 500),
          y: 200,
          clickCount: 0,
          modifiers: 0,
        }),
      );
      await wait(1000 / 144);
    }
    const sent = performance.now();
    viewer.socket.send(
      JSON.stringify({
        type: "mouse",
        event: "pressed",
        x: 300,
        y: 200,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      }),
    );
    viewer.socket.send(
      JSON.stringify({
        type: "mouse",
        event: "released",
        x: 300,
        y: 200,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      }),
    );
    let landedAfter = Number.POSITIVE_INFINITY;
    while (performance.now() - sent < 10_000) {
      const read = await api("/read", botId);
      const { text } = (await read.json()) as { text: string };
      if (/clicks=\s*1/.test(text)) {
        landedAfter = performance.now() - sent;
        break;
      }
      await wait(10);
    }
    viewer.socket.close();
    // Measured at 630 ms with every move applied, and under 50 ms folded.
    expect(landedAfter).toBeLessThan(300);
  }, 30_000);

  test("on a slow link the screen shows the page as it is, not seconds behind", async () => {
    const botId = "pacing-lag";
    const ANIMATES_MS = 6_000;
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({
        url: page(
          `<style>body{margin:0}#b{width:100vw;height:100vh;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);animation:s .5s linear infinite}@keyframes s{to{filter:hue-rotate(360deg)}}</style><div id=b></div>`,
        ),
      }),
    });
    // A hop that reads from the computer no faster than 400 KB a second, so backpressure reaches it
    // the way a slow connection's does.
    const RATE = 400 * 1024;
    const hop = createServer((client: Socket) => {
      const upstream = connect(port, "127.0.0.1");
      client.on("data", (data) => upstream.write(data));
      upstream.on("data", (chunk: Buffer) => {
        upstream.pause();
        client.write(chunk);
        setTimeout(() => upstream.resume(), (chunk.length / RATE) * 1000);
      });
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        a.on("close", () => b.destroy());
        a.on("error", () => b.destroy());
      }
    });
    const hopPort = await freePort();
    await new Promise<void>((resolve) =>
      hop.listen(hopPort, "127.0.0.1", () => resolve()),
    );
    const viewer = watch(
      `ws://127.0.0.1:${hopPort}/stream?bot=${botId}&token=${TOKEN}`,
    );
    await viewer.casting;
    await wait(ANIMATES_MS);
    // Stopped from the computer's side, so the moment it stopped is known here exactly.
    await api("/navigate", botId, {
      method: "POST",
      body: JSON.stringify({ url: page("<body>still</body>") }),
    });
    const stoppedAt = performance.now();
    await wait(15_000);
    viewer.socket.close();
    hop.close();

    const lastFrameAfter = (viewer.frames.at(-1) ?? stoppedAt) - stoppedAt;
    // Measured at 23 s with frames acked on arrival, and under 2 s paced by confirmations.
    expect(lastFrameAfter).toBeLessThan(4_000);
    // And it kept casting while the page moved: pacing is not the same as stopping.
    expect(viewer.frames.length).toBeGreaterThan(20);
  }, 60_000);
});
