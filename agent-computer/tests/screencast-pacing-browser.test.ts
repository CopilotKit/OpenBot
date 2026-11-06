import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { reservePort } from "../../tests/support/reserved-port";
import { startScreencast } from "../src/screencast";

/**
 * The live screen ends on the page as it is, against Chromium itself.
 *
 * Chrome keeps two screencast frames unacknowledged at most. A frame that changes while two are out is not sent, and
 * it is not sent later either: once the page is still there is nothing new to send. So a cast that held the ack back
 * while the viewer's connection was busy, which is how it was once paced, left the person looking at the page as it
 * was a moment before it stopped, with nothing to say so. Measured on Chromium 151 with acks held 500 ms: of five
 * colour changes 40 ms apart, the second and third arrived and the last never did. A click aimed at what the person
 * saw then lands on what the page has since become.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/screencast-pacing-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "screencast-pacing-token";
const FINAL = [0, 0, 255] as const;

let browser: Browser;
/** A tab that reads a frame back as pixels, so a test can say which page a frame shows. */
let decoder: Page;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "chromium" });
  decoder = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

/** The colour at the centre of a frame. */
function centreOf(base64: string): Promise<number[]> {
  return decoder.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2d context.");
    context.drawImage(image, 0, 0);
    return [
      ...context.getImageData(image.width / 2, image.height / 2, 1, 1).data,
    ].slice(0, 3);
  }, base64);
}

/** Whether a decoded colour is `FINAL`, give or take what JPEG does to it. */
const isFinal = (colour: number[]) =>
  colour.every((value, i) => Math.abs(value - (FINAL[i] ?? 0)) < 24);

describe.skipIf(!asked)("a page that stops changing", () => {
  test("its last change reaches a viewer whose connection takes its time over each frame", async () => {
    const context = await browser.newContext({
      viewport: { width: 400, height: 300 },
    });
    const tab = await context.newPage();
    await tab.setContent(
      `<body style="margin:0;background:rgb(255,0,0)"></body>`,
    );
    const frames: string[] = [];
    // A viewer that is still receiving each frame for 400 ms after it is handed over: a slow connection.
    const cast = await startScreencast(
      tab,
      (frame) => {
        frames.push(frame.data);
        return Bun.sleep(400);
      },
      { maxWidth: 400, maxHeight: 300 },
    );
    try {
      await Bun.sleep(500);
      for (const colour of [
        "0,255,0",
        "255,255,0",
        "0,255,255",
        "255,0,255",
        FINAL.join(","),
      ]) {
        await tab.evaluate((rgb) => {
          document.body.style.background = `rgb(${rgb})`;
        }, colour);
        await Bun.sleep(40);
      }
      // Long after every held frame would have been let go.
      await Bun.sleep(3_000);
      const last = frames.at(-1);
      expect(last).toBeDefined();
      expect(await centreOf(last ?? "")).toSatisfy(isFinal);
    } finally {
      await cast.stop();
      await context.close();
    }
  }, 30_000);
});

/** The computer itself, as its own process, with pages for it on this machine. */
let computer: { port: number; child: ReturnType<typeof Bun.spawn> } | undefined;
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;
const pages = new Map<string, string>();

/** Animates until told otherwise. */
const ANIMATING = `<style>body{margin:0}#b{width:100vw;height:100vh;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);animation:s .5s linear infinite}@keyframes s{to{filter:hue-rotate(360deg)}}</style><div id=b></div>`;
/**
 * Animates for three seconds, then stops on `FINAL`, and half a second later changes a corner.
 *
 * The corner is for Chrome's sake, not the computer's: a frame Chrome makes while its own two are still unacked is lost
 * whatever the computer does, and an ack can be a frame late on a busy machine. A computer that acks on arrival has
 * nothing unacked half a second on, so the corner arrives and the screen shows `FINAL`. One that holds acks while the
 * viewer is behind still has, so it loses that change too.
 */
const STOPS_ON_FINAL = `${ANIMATING}<i id=c style="position:fixed;left:0;top:0;width:8px;height:8px"></i><script>setTimeout(()=>{const b=document.getElementById('b');b.style.animation='none';b.style.filter='none';b.style.background='rgb(${FINAL.join(",")})'},3000);setTimeout(()=>{document.getElementById('c').style.background='white'},3500)</script>`;

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "openbot-pacing-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(pages.get(new URL(request.url).pathname) ?? "missing", {
        headers: { "content-type": "text/html" },
      }),
  });
  const port = await reservePort();
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // Pages on this machine, which the default policy refuses.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  computer = { port, child };
  const deadline = Date.now() + 15_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}, 30_000);

afterAll(async () => {
  if (!computer) return;
  computer.child.kill();
  await computer.child.exited;
  site?.stop(true);
  await rm(root, { recursive: true, force: true });
});

/** Open `html` on the Bot's screen. */
async function show(botId: string, html: string) {
  const path = `/${pages.size}`;
  pages.set(path, html);
  const navigated = await fetch(`http://127.0.0.1:${computer?.port}/navigate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": TOKEN,
    },
    body: JSON.stringify({ url: `http://127.0.0.1:${site?.port}${path}` }),
  });
  expect(navigated.status).toBe(200);
}

/** Close the Bot's browser, so the next test has the machine to itself. */
async function stop(botId: string) {
  await fetch(`http://127.0.0.1:${computer?.port}/computers/stop`, {
    method: "POST",
    headers: {
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": TOKEN,
    },
  }).catch(() => undefined);
}

/** A hop that carries `rate` bytes a second from the computer to the viewer, as a slow connection does. */
async function slowLink(
  rate: number,
): Promise<{ port: number; close(): void }> {
  const hop: Server = createServer((viewer: Socket) => {
    const upstream = connect(computer?.port ?? 0, "127.0.0.1");
    viewer.on("data", (data) => upstream.write(data));
    upstream.on("data", (chunk: Buffer) => {
      upstream.pause();
      viewer.write(chunk);
      setTimeout(() => upstream.resume(), (chunk.length / rate) * 1000);
    });
    for (const [a, b] of [
      [viewer, upstream],
      [upstream, viewer],
    ] as const) {
      a.on("close", () => b.destroy());
      a.on("error", () => b.destroy());
    }
  });
  const port = await reservePort();
  await new Promise<void>((resolve) =>
    hop.listen(port, "127.0.0.1", () => resolve()),
  );
  return { port, close: () => hop.close() };
}

/**
 * A screen watching a Bot, as the app's is. `confirmAfterMs` confirms each frame that long after it arrives once the
 * computer has asked, standing for a connection that takes that long to say so; without it, a screen from before
 * confirmations, which never sends one.
 */
function watch(port: number, botId: string, confirmAfterMs?: number) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/stream?bot=${botId}&token=${TOKEN}`,
  );
  const frames: { at: number; data: string }[] = [];
  let confirm = false;
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    if (!text.startsWith('{"type":"frame"')) {
      const message = JSON.parse(text) as {
        type?: string;
        confirmFrames?: boolean;
      };
      if (message.type === "hello")
        confirm =
          confirmAfterMs !== undefined && message.confirmFrames === true;
      return;
    }
    frames.push({
      at: performance.now(),
      data: (JSON.parse(text) as { data: string }).data,
    });
    if (confirm)
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send('{"type":"frame-received"}');
      }, confirmAfterMs);
  });
  return { socket, frames };
}

/** Until nothing has arrived for three seconds: the screen has settled on whatever it is going to show. */
async function settled(frames: { at: number }[]) {
  const settleBy = performance.now() + 45_000;
  await Bun.sleep(5_000);
  while (
    performance.now() < settleBy &&
    performance.now() - (frames.at(-1)?.at ?? 0) < 3_000
  )
    await Bun.sleep(250);
}

describe.skipIf(!asked)("the whole computer, on a slow link", () => {
  for (const [who, confirmAfterMs] of [
    ["a screen that confirms each frame", 0],
    ["a screen from before confirmations", undefined],
  ] as const)
    test(`${who} settles on the page as it is once it stops moving`, async () => {
      const botId = `pacing-final-${confirmAfterMs ?? "none"}`;
      await show(botId, STOPS_ON_FINAL);
      const link = await slowLink(400 * 1024);
      const viewer = watch(link.port, botId, confirmAfterMs);
      try {
        await settled(viewer.frames);
        expect(viewer.frames.length).toBeGreaterThan(5);
        expect(await centreOf(viewer.frames.at(-1)?.data ?? "")).toSatisfy(
          isFinal,
        );
      } finally {
        viewer.socket.close();
        link.close();
        await stop(botId);
      }
    }, 90_000);

  test("no more than two frames are on their way to a screen that confirms them", async () => {
    // Confirmations that take 300 ms to come back, from the very first frame. Two on their way at a time is about
    // seven frames a second. Counting only the frames sent after the first confirmation, every frame already on its
    // way then was confirmed against nothing and the allowance grew by that many for good: the screen got Chrome's
    // full rate, as far behind as before.
    const botId = "pacing-in-flight";
    await show(botId, ANIMATING);
    const viewer = watch(computer?.port ?? 0, botId, 300);
    try {
      await Bun.sleep(2_000);
      const from = performance.now();
      await Bun.sleep(3_000);
      const arrived = viewer.frames.filter((frame) => frame.at >= from).length;
      // About 20 at two per 300 ms; well over a hundred with the allowance grown.
      expect(arrived).toBeGreaterThan(5);
      expect(arrived).toBeLessThan(40);
    } finally {
      viewer.socket.close();
      await stop(botId);
    }
  }, 30_000);
});
